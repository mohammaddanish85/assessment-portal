import { ROLE_DEFAULTS, prepareDatabase } from './schema.js';
import { evaluateAnswer } from './evaluator.js';

const TYPES = ['Assignment', 'Sessional', 'Tutorial', 'MCQ Test'];
const SESSION_HOURS = 12;
const GRACE_SECONDS = 60; // allowance for the final autosave / auto-submit after the deadline

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

const now = () => new Date().toISOString();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/.{2}/g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: hex(bits), salt: hex(salt) };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await prepareDatabase(env.DB);
  schemaReady = true;
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    fail(400, 'Invalid JSON body');
  }
}

const str = (v, name, max = 20000) => {
  if (typeof v !== 'string' || !v.trim()) fail(400, `${name} is required`);
  if (v.length > max) fail(400, `${name} is too long`);
  return v.trim();
};

const STAFF_ROLES = Object.keys(ROLE_DEFAULTS);

// Rights of a staff member. An institute admin can always manage the institute, so they cannot lock themselves out.
function cleanPerms(role, p) {
  const d = ROLE_DEFAULTS[role];
  if (!p || typeof p !== 'object') return { ...d };
  return {
    manage: role === 'admin' ? true : !!p.manage,
    create: !!p.create,
    approve: !!p.approve,
    reports: ['own', 'department', 'institute'].includes(p.reports) ? p.reports : d.reports,
  };
}

async function currentUser(request, env) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  const u = await env.DB.prepare(
    `SELECT u.id, u.role, u.name, u.username, u.roll_no, u.section_id, u.institute_id, u.department_id, u.perms, u.must_change,
            i.name AS institute_name, i.code AS institute_code, i.status AS institute_status
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN institutes i ON i.id = u.institute_id
     WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(m[1], now())
    .first();
  if (!u) return null;
  if (u.role !== 'owner' && u.institute_status !== 'active') return null; // suspended institute: nobody gets in
  let stored = null;
  try { stored = JSON.parse(u.perms || 'null'); } catch { /* fall back to the role's defaults */ }
  u.perms = STAFF_ROLES.includes(u.role) ? cleanPerms(u.role, stored) : {};
  return u;
}

async function createUser(env, u) {
  if (u.password.length < 6) fail(400, `Password for ${u.username} must be at least 6 characters`);
  const username = u.username.toLowerCase();
  // SQLite treats NULLs as distinct in UNIQUE, so the owner (no institute) is checked by hand.
  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND institute_id IS ?').bind(username, u.institute_id ?? null).first();
  if (taken) fail(409, `Username "${u.username}" already exists`);
  const { hash, salt } = await hashPassword(u.password);
  const r = await env.DB.prepare(
    `INSERT INTO users (institute_id, role, name, username, roll_no, pw_hash, pw_salt, created_at, section_id, department_id, perms, must_change)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(u.institute_id ?? null, u.role, u.name, username, u.roll_no ?? null, hash, salt, now(), u.section_id ?? null,
      u.department_id ?? null, u.perms ? JSON.stringify(u.perms) : null, u.must_change ? 1 : 0)
    .run();
  return r.meta.last_row_id;
}

// ---------- evaluation ----------

// MCQ: checked against the answer key. No LLM involved, so the result is exact.
function gradeMcq(r) {
  const attempted = r.text !== '';
  const correct = /^\d+$/.test(r.text) && Number(r.text) === r.correct_index;
  const awarded = correct ? r.max_marks : 0;
  return {
    auto: true,
    criteria: [{
      criterion: 'Correct option',
      max: r.max_marks,
      awarded,
      justification: !attempted ? 'Not attempted.' : correct ? 'Correct option selected.' : 'Wrong option selected.',
    }],
    total: awarded,
    missing_points: [],
    improvements: [],
    confidence: 'high',
  };
}

async function evaluateAttempt(env, attemptId) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.text, q.text AS qtext, q.max_marks, q.model_answer, q.rubric_json, q.kind, q.correct_index
     FROM answers a JOIN questions q ON q.id = a.question_id
     WHERE a.attempt_id = ? AND a.eval_status != 'done'`,
  )
    .bind(attemptId)
    .all();

  await Promise.all(
    results.map(async (r) => {
      try {
        const out = r.kind === 'mcq'
          ? gradeMcq(r)
          : await evaluateAnswer(env, {
              question: r.qtext,
              maxMarks: r.max_marks,
              rubric: JSON.parse(r.rubric_json),
              modelAnswer: r.model_answer,
              answer: r.text,
            });
        await env.DB.prepare(
          `UPDATE answers SET eval_status='done', eval_error=NULL, llm_marks=?, llm_json=?, llm_confidence=? WHERE id=?`,
        )
          .bind(out.total, JSON.stringify(out), out.confidence, r.id)
          .run();
      } catch (e) {
        await env.DB.prepare(`UPDATE answers SET eval_status='failed', eval_error=? WHERE id=?`)
          .bind(String(e.message || e).slice(0, 300), r.id)
          .run();
      }
    }),
  );

  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM answers WHERE attempt_id = ? AND eval_status != 'done'`,
  )
    .bind(attemptId)
    .first();
  if (left.n > 0) return;

  const info = await env.DB.prepare(
    `SELECT s.release_mode,
            (SELECT COUNT(*) FROM answers WHERE attempt_id = t.id AND llm_confidence = 'low') AS low
     FROM attempts t JOIN assessments s ON s.id = t.assessment_id WHERE t.id = ?`,
  )
    .bind(attemptId)
    .first();

  // Instant release only when the faculty chose it AND the model was not unsure about any answer.
  if (info.release_mode === 'instant' && info.low === 0) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE answers SET final_marks = llm_marks WHERE attempt_id = ?`).bind(attemptId),
      env.DB.prepare(`UPDATE attempts SET status='published' WHERE id = ? AND status='submitted'`).bind(attemptId),
    ]);
  } else {
    await env.DB.prepare(`UPDATE attempts SET status='evaluated' WHERE id = ? AND status='submitted'`)
      .bind(attemptId)
      .run();
  }
}

// A student whose browser closed, crashed or went offline never sends "submit". Once their time is over,
// the attempt is closed here with whatever was last autosaved, and evaluated like any other submission.
async function closeOverdueAttempts(env, assessmentId = null) {
  const cutoff = new Date(Date.now() - GRACE_SECONDS * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at < ?${assessmentId ? ' AND assessment_id = ?' : ''}`,
  )
    .bind(...(assessmentId ? [cutoff, assessmentId] : [cutoff]))
    .all();
  for (const t of results) {
    const done = await env.DB.prepare(
      `UPDATE attempts SET status = 'submitted', submitted_at = deadline_at WHERE id = ? AND status = 'in_progress'`,
    )
      .bind(t.id)
      .run();
    if (done.meta.changes) await evaluateAttempt(env, t.id).catch((e) => console.error('evaluation failed', e));
  }
  return results.length;
}

// ---------- handlers ----------

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const route = (m, re) => (method === m ? re.exec(path) : null);
  let m;

  await ensureSchema(env);

  if (method !== 'GET') {
    // Same-origin check: the session cookie must not be usable from another site.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) fail(403, 'Cross-site request blocked');
  }

  if (route('GET', /^\/api\/status$/)) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`).first();
    return json({ needsSetup: c.n === 0, provider: env.EVAL_PROVIDER || 'workers-ai' });
  }

  // First run only: create the platform owner. Disabled once an owner exists.
  if (route('POST', /^\/api\/setup$/)) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`).first();
    if (c.n > 0) fail(403, 'Setup is already complete');
    const b = await body(request);
    await createUser(env, {
      role: 'owner',
      name: str(b.name, 'Name', 100),
      username: str(b.username, 'Username', 50),
      password: str(b.password, 'Password', 100),
    });
    return json({ ok: true });
  }

  // Institute members log in with their institute code; the platform owner leaves the code empty.
  if (route('POST', /^\/api\/login$/)) {
    const b = await body(request);
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase().slice(0, 20) : '';
    const username = str(b.username, 'Username', 50).toLowerCase();
    const password = str(b.password, 'Password', 100);

    // Slow down password guessing: 8 wrong tries on one account lock it for 15 minutes.
    const key = `${code}|${username}`;
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?').bind(key, since).first();
    if (tries.n >= 8) fail(429, 'Too many wrong attempts. Try again in 15 minutes.');

    let u = null;
    if (code) {
      u = await env.DB.prepare(
        `SELECT u.*, i.status AS institute_status FROM users u JOIN institutes i ON i.id = u.institute_id
         WHERE i.code = ? AND u.username = ?`,
      ).bind(code, username).first();
    } else {
      u = await env.DB.prepare(`SELECT * FROM users WHERE role = 'owner' AND username = ?`).bind(username).first();
    }
    const ok = u && safeEqual((await hashPassword(password, u.pw_salt)).hash, u.pw_hash);
    if (!ok) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(since),
        env.DB.prepare('INSERT INTO login_failures (key, at) VALUES (?, ?)').bind(key, now()),
      ]);
      fail(401, code ? 'Wrong institute code, username or password' : 'Wrong username or password');
    }
    if (code && u.institute_status !== 'active') fail(403, 'This institute is suspended. Contact the platform owner.');

    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
      env.DB.prepare('DELETE FROM login_failures WHERE key = ?').bind(key),
      env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').bind(token, u.id, expires),
    ]);
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true }, 200, {
      'set-cookie': `sid=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    });
  }

  if (route('POST', /^\/api\/logout$/)) {
    const mm = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
    if (mm) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(mm[1]).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  // Public: an institute asks for access from the home page.
  if (route('POST', /^\/api\/requests$/)) {
    const b = await body(request);
    const email = str(b.email, 'Email', 150);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address');
    const phone = str(b.phone, 'Phone', 20);
    if (!/^[+\d][\d\s-]{6,}$/.test(phone)) fail(400, 'Enter a valid phone number');
    // Limit how many requests one network address can send, so the form cannot be used to flood the list.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const sender = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))).slice(0, 32);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM access_requests WHERE sender = ? AND created_at > ?')
      .bind(sender, new Date(Date.now() - 3600e3).toISOString()).first();
    if (recent.n >= 5) fail(429, 'Too many requests from this network. Try again in an hour.');
    await env.DB.prepare(
      'INSERT INTO access_requests (institute, contact_name, email, phone, message, sender, created_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(str(b.institute, 'Institute name', 150), str(b.contact_name, 'Your name', 100), email, phone,
      typeof b.message === 'string' ? b.message.trim().slice(0, 1000) : '', sender, now()).run();
    return json({ ok: true });
  }

  const user = await currentUser(request, env);
  if (!user) fail(401, 'Please log in');
  const inst = user.institute_id;

  if (route('GET', /^\/api\/me$/)) {
    return json({
      id: user.id, role: user.role, name: user.name, username: user.username, roll_no: user.roll_no,
      perms: user.perms, must_change: !!user.must_change, institute_name: user.institute_name, institute_code: user.institute_code,
    });
  }

  const audit = (action, detail = '') =>
    env.DB.prepare('INSERT INTO audit (institute_id, user_id, user_name, action, detail, at) VALUES (?,?,?,?,?,?)')
      .bind(inst ?? null, user.id, user.name, action, String(detail).slice(0, 500), now()).run();

  if (route('POST', /^\/api\/password$/)) {
    const b = await body(request);
    const me = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(user.id).first();
    if (!safeEqual((await hashPassword(str(b.current, 'Current password', 100), me.pw_salt)).hash, me.pw_hash)) {
      fail(400, 'Current password is wrong');
    }
    const next = str(b.password, 'New password', 100);
    if (next.length < 8) fail(400, 'New password must be at least 8 characters');
    if (next === b.current) fail(400, 'Choose a password different from the current one');
    const { hash, salt } = await hashPassword(next);
    await env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 0 WHERE id = ?').bind(hash, salt, user.id).run();
    return json({ ok: true });
  }

  // A password set by someone else must be replaced before anything else is allowed.
  if (user.must_change) fail(403, 'Change your password first');

  const unique = async (what, run) => {
    try {
      return await run();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) fail(409, `${what} already exists`);
      throw e;
    }
  };

  // ----- platform owner: requests and institutes (no access to any institute's internal data) -----

  if (path.startsWith('/api/owner/')) {
    if (user.role !== 'owner') fail(403, 'Platform owner only');

    if (route('GET', /^\/api\/owner\/data$/)) {
      const [requests, institutes] = await env.DB.batch([
        env.DB.prepare('SELECT id, institute, contact_name, email, phone, message, status, created_at FROM access_requests ORDER BY id DESC LIMIT 200'),
        env.DB.prepare(
          `SELECT i.id, i.code, i.name, i.status, i.created_at,
            (SELECT username FROM users WHERE institute_id = i.id AND role = 'admin' ORDER BY id LIMIT 1) AS admin_username,
            (SELECT COUNT(*) FROM users WHERE institute_id = i.id AND role != 'student') AS staff,
            (SELECT COUNT(*) FROM users WHERE institute_id = i.id AND role = 'student') AS students,
            (SELECT COUNT(*) FROM assessments WHERE institute_id = i.id) AS assessments
           FROM institutes i ORDER BY i.id DESC`,
        ),
      ]);
      return json({ requests: requests.results, institutes: institutes.results });
    }

    if (route('POST', /^\/api\/owner\/institutes$/)) {
      const b = await body(request);
      const code = str(b.code, 'Institute code', 20).toUpperCase();
      // Letters, digits and hyphens, so an AICTE permanent ID such as 1-7216281 can be used as the code.
      if (!/^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])$/.test(code)) fail(400, 'Institute code: 2 to 20 letters, digits or hyphens, no spaces');
      const name = str(b.name, 'Institute name', 150);
      const admin = { name: str(b.admin_name, 'Admin name', 100), username: str(b.admin_username, 'Admin username', 50), password: str(b.admin_password, 'Admin password', 100) };
      if (admin.password.length < 6) fail(400, 'Admin password must be at least 6 characters');
      const ins = await unique(`Institute code "${code}"`, () =>
        env.DB.prepare('INSERT INTO institutes (code, name, created_at) VALUES (?,?,?)').bind(code, name, now()).run(),
      );
      const id = ins.meta.last_row_id;
      await createUser(env, { ...admin, institute_id: id, role: 'admin', perms: ROLE_DEFAULTS.admin, must_change: true });
      if (Number.isInteger(b.request_id)) {
        await env.DB.prepare(`UPDATE access_requests SET status = 'approved' WHERE id = ?`).bind(b.request_id).run();
      }
      await audit('institute created', `${code} ${name}`);
      return json({ id });
    }

    if ((m = route('POST', /^\/api\/owner\/institutes\/(\d+)\/status$/))) {
      const status = (await body(request)).status === 'suspended' ? 'suspended' : 'active';
      await env.DB.prepare('UPDATE institutes SET status = ? WHERE id = ?').bind(status, +m[1]).run();
      if (status === 'suspended') {
        await env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE institute_id = ?)').bind(+m[1]).run();
      }
      await audit(`institute ${status}`, `id ${m[1]}`);
      return json({ ok: true });
    }

    if ((m = route('POST', /^\/api\/owner\/institutes\/(\d+)\/admin-password$/))) {
      const target = await env.DB.prepare(`SELECT id FROM users WHERE institute_id = ? AND role = 'admin' ORDER BY id LIMIT 1`).bind(+m[1]).first();
      if (!target) fail(404, 'This institute has no admin account');
      const password = str((await body(request)).password, 'Password', 100);
      if (password.length < 6) fail(400, 'Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 1 WHERE id = ?').bind(hash, salt, target.id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
      ]);
      await audit('institute admin password reset', `institute id ${m[1]}`);
      return json({ ok: true });
    }

    if ((m = route('POST', /^\/api\/owner\/requests\/(\d+)\/status$/))) {
      const asked = (await body(request)).status;
      const status = ['new', 'approved', 'closed'].includes(asked) ? asked : 'closed';
      await env.DB.prepare('UPDATE access_requests SET status = ? WHERE id = ?').bind(status, +m[1]).run();
      return json({ ok: true });
    }

    fail(404, 'Not found');
  }

  if (user.role === 'owner') fail(403, 'The platform owner does not have access to institute data');

  // ----- everything below belongs to one institute -----

  // Institute details printed on documents. Readable by every signed-in member of the institute.
  if (route('GET', /^\/api\/settings$/)) {
    const i = await env.DB.prepare('SELECT name, line, logo, code FROM institutes WHERE id = ?').bind(inst).first();
    return json({ institute: i.name, line: i.line, logo: i.logo, code: i.code });
  }

  const isStaff = STAFF_ROLES.includes(user.role);
  const can = (right) => (isStaff && user.perms[right]) || fail(403, 'You do not have the right to do this');
  const admin = () => can('manage');
  const staff = () => isStaff || fail(403, 'Staff only');
  const student = () => user.role === 'student' || fail(403, 'Students only');

  // Which assessments this staff member may see: their own, their department's, or the whole institute's.
  const scope = () => {
    if (user.perms.reports === 'institute') return { sql: 's.institute_id = ?', binds: [inst] };
    if (user.perms.reports === 'department' && user.department_id) {
      return { sql: 's.institute_id = ? AND (s.department_id = ? OR s.faculty_id = ?)', binds: [inst, user.department_id, user.id] };
    }
    return { sql: 's.institute_id = ? AND s.faculty_id = ?', binds: [inst, user.id] };
  };
  const readAssessment = async (id) => {
    staff();
    const sc = scope();
    const a = await env.DB.prepare(
      `SELECT s.*, f.name AS faculty_name FROM assessments s JOIN users f ON f.id = s.faculty_id WHERE s.id = ? AND ${sc.sql}`,
    ).bind(id, ...sc.binds).first();
    return a || fail(404, 'Assessment not found');
  };
  // Changing an assessment itself (publish, delete) is for the person who created it.
  const ownAssessment = async (id) => {
    can('create');
    const a = await env.DB.prepare('SELECT * FROM assessments WHERE id = ? AND institute_id = ? AND faculty_id = ?').bind(id, inst, user.id).first();
    return a || fail(404, 'Assessment not found');
  };
  const staffAttempt = async (id) => {
    staff();
    const sc = scope();
    const t = await env.DB.prepare(
      `SELECT t.*, s.release_mode, s.subject_name, s.subject_code, s.type, s.number, u.name AS student_name, u.roll_no
       FROM attempts t JOIN assessments s ON s.id = t.assessment_id JOIN users u ON u.id = t.student_id
       WHERE t.id = ? AND ${sc.sql}`,
    ).bind(id, ...sc.binds).first();
    return t || fail(404, 'Attempt not found');
  };
  const ownAttemptAsStudent = async (id) => {
    const t = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND student_id = ?').bind(id, user.id).first();
    return t || fail(404, 'Attempt not found');
  };

  // ----- institute setup (needs the "manage" right) -----

  if (route('GET', /^\/api\/admin\/data$/)) {
    admin();
    const [departments, sections, subjects, team, students, log] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM departments WHERE institute_id = ? ORDER BY name').bind(inst),
      env.DB.prepare(
        `SELECT s.id, s.name, s.programme, s.department_id, d.name AS department, (SELECT COUNT(*) FROM users WHERE section_id = s.id) AS students
         FROM sections s LEFT JOIN departments d ON d.id = s.department_id WHERE s.institute_id = ? ORDER BY s.name`,
      ).bind(inst),
      env.DB.prepare('SELECT id, name, code, semester FROM subjects WHERE institute_id = ? ORDER BY semester, code').bind(inst),
      env.DB.prepare(
        `SELECT u.id, u.name, u.username, u.role, u.department_id, u.perms, d.name AS department
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.institute_id = ? AND u.role != 'student' ORDER BY u.role, u.name`,
      ).bind(inst),
      env.DB.prepare(
        `SELECT u.id, u.name, u.username, u.roll_no, u.section_id, s.name AS section FROM users u LEFT JOIN sections s ON s.id = u.section_id
         WHERE u.institute_id = ? AND u.role = 'student' ORDER BY s.name, u.roll_no, u.name`,
      ).bind(inst),
      env.DB.prepare('SELECT user_name, action, detail, at FROM audit WHERE institute_id = ? ORDER BY id DESC LIMIT 100').bind(inst),
    ]);
    return json({
      departments: departments.results,
      sections: sections.results,
      subjects: subjects.results,
      staff: team.results.map((u) => {
        let p = null;
        try { p = JSON.parse(u.perms || 'null'); } catch { /* defaults */ }
        return { ...u, perms: cleanPerms(u.role, p), self: u.id === user.id };
      }),
      students: students.results,
      audit: log.results,
    });
  }

  if (route('POST', /^\/api\/admin\/settings$/)) {
    admin();
    const b = await body(request);
    const logo = typeof b.logo === 'string' ? b.logo : '';
    if (logo && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo)) fail(400, 'Logo must be a PNG or JPG image');
    if (logo.length > 450000) fail(400, 'Logo is too large (keep it under 300 KB)');
    await env.DB.prepare('UPDATE institutes SET name = ?, line = ?, logo = ? WHERE id = ?')
      .bind(str(b.institute, 'Institute name', 150), typeof b.line === 'string' ? b.line.trim().slice(0, 200) : '', logo, inst).run();
    return json({ ok: true });
  }

  const departmentId = async (v) => {
    if (v === null || v === undefined || v === '') return null;
    const d = await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND institute_id = ?').bind(Number(v) || 0, inst).first();
    return d ? d.id : fail(400, 'Unknown department');
  };
  const sectionId = async (v) => {
    const s = await env.DB.prepare('SELECT id FROM sections WHERE id = ? AND institute_id = ?').bind(Number(v) || 0, inst).first();
    return s ? s.id : fail(400, 'Choose a section');
  };

  // departments
  if (route('POST', /^\/api\/admin\/departments$/)) {
    admin();
    const name = str((await body(request)).name, 'Department name', 100);
    await unique(`Department "${name}"`, () => env.DB.prepare('INSERT INTO departments (institute_id, name) VALUES (?,?)').bind(inst, name).run());
    return json({ ok: true });
  }
  if ((m = route('PUT', /^\/api\/admin\/departments\/(\d+)$/))) {
    admin();
    const name = str((await body(request)).name, 'Department name', 100);
    await unique(`Department "${name}"`, () => env.DB.prepare('UPDATE departments SET name = ? WHERE id = ? AND institute_id = ?').bind(name, +m[1], inst).run());
    return json({ ok: true });
  }
  if ((m = route('DELETE', /^\/api\/admin\/departments\/(\d+)$/))) {
    admin();
    const used = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM sections WHERE department_id = ?1 AND institute_id = ?2) +
              (SELECT COUNT(*) FROM users WHERE department_id = ?1 AND institute_id = ?2) AS n`,
    ).bind(+m[1], inst).first();
    if (used.n) fail(409, 'This department still has sections or staff. Move them first.');
    await env.DB.prepare('DELETE FROM departments WHERE id = ? AND institute_id = ?').bind(+m[1], inst).run();
    return json({ ok: true });
  }

  // sections
  const sectionFields = async (b) => ({
    name: str(b.name, 'Section name', 80),
    programme: typeof b.programme === 'string' ? b.programme.trim().slice(0, 100) : '',
    dept: await departmentId(b.department_id),
  });
  if (route('POST', /^\/api\/admin\/sections$/)) {
    admin();
    const f = await sectionFields(await body(request));
    await unique(`Section "${f.name}"`, () =>
      env.DB.prepare('INSERT INTO sections (institute_id, department_id, programme, name) VALUES (?,?,?,?)').bind(inst, f.dept, f.programme, f.name).run(),
    );
    return json({ ok: true });
  }
  if ((m = route('PUT', /^\/api\/admin\/sections\/(\d+)$/))) {
    admin();
    const f = await sectionFields(await body(request));
    await unique(`Section "${f.name}"`, () =>
      env.DB.prepare('UPDATE sections SET name = ?, programme = ?, department_id = ? WHERE id = ? AND institute_id = ?').bind(f.name, f.programme, f.dept, +m[1], inst).run(),
    );
    return json({ ok: true });
  }
  if ((m = route('DELETE', /^\/api\/admin\/sections\/(\d+)$/))) {
    admin();
    await sectionId(+m[1]);
    const used = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE section_id = ?1) AS students,
              (SELECT COUNT(*) FROM assessment_sections WHERE section_id = ?1) AS assessments`,
    ).bind(+m[1]).first();
    if (used.students) fail(409, `This section still has ${used.students} student(s). Move or delete them first.`);
    if (used.assessments) fail(409, 'This section is used by an assessment and cannot be deleted.');
    await env.DB.prepare('DELETE FROM sections WHERE id = ? AND institute_id = ?').bind(+m[1], inst).run();
    return json({ ok: true });
  }

  // subjects
  const subjectFields = (b) => {
    const sem = b.semester === null || b.semester === '' || b.semester === undefined ? null : Number(b.semester);
    if (sem !== null && !(Number.isInteger(sem) && sem >= 1 && sem <= 12)) fail(400, 'Semester must be 1-12');
    return { name: str(b.name, 'Subject name', 150), code: str(b.code, 'Subject code', 30), sem };
  };
  if (route('POST', /^\/api\/admin\/subjects$/)) {
    admin();
    const f = subjectFields(await body(request));
    await unique(`Subject code "${f.code}"`, () =>
      env.DB.prepare('INSERT INTO subjects (institute_id, name, code, semester) VALUES (?,?,?,?)').bind(inst, f.name, f.code, f.sem).run(),
    );
    return json({ ok: true });
  }
  if ((m = route('PUT', /^\/api\/admin\/subjects\/(\d+)$/))) {
    admin();
    const f = subjectFields(await body(request));
    await unique(`Subject code "${f.code}"`, () =>
      env.DB.prepare('UPDATE subjects SET name = ?, code = ?, semester = ? WHERE id = ? AND institute_id = ?').bind(f.name, f.code, f.sem, +m[1], inst).run(),
    );
    return json({ ok: true });
  }
  // Assessments keep their own copy of the subject name and code, so removing a subject does not affect them.
  if ((m = route('DELETE', /^\/api\/admin\/subjects\/(\d+)$/))) {
    admin();
    await env.DB.prepare('DELETE FROM subjects WHERE id = ? AND institute_id = ?').bind(+m[1], inst).run();
    return json({ ok: true });
  }

  // staff: role, department and rights
  const staffFields = async (b) => {
    const role = STAFF_ROLES.includes(b.role) ? b.role : fail(400, 'Choose a role');
    return { role, department_id: await departmentId(b.department_id), perms: cleanPerms(role, b.perms) };
  };
  if (route('POST', /^\/api\/admin\/staff$/)) {
    admin();
    const b = await body(request);
    const f = await staffFields(b);
    const name = str(b.name, 'Name', 100);
    await createUser(env, { ...f, institute_id: inst, name, username: str(b.username, 'Username', 50), password: str(b.password, 'Password', 100), must_change: true });
    await audit('staff account created', `${name} (${f.role})`);
    return json({ ok: true });
  }

  // students, in bulk
  if (route('POST', /^\/api\/admin\/students$/)) {
    admin();
    const b = await body(request);
    const section = await sectionId(b.section_id);
    if (!Array.isArray(b.students) || !b.students.length) fail(400, 'No students given');
    if (b.students.length > 300) fail(400, 'Add at most 300 students at a time');
    // Check every line first, so a mistake on line 40 does not leave lines 1-39 half added.
    const rows = b.students.map((x, i) => ({
      role: 'student',
      institute_id: inst,
      section_id: section,
      must_change: true,
      roll_no: str(x.roll_no, `Line ${i + 1}: roll no`, 30),
      name: str(x.name, `Line ${i + 1}: name`, 100),
      username: str(x.username, `Line ${i + 1}: username`, 50).toLowerCase(),
      password: str(x.password, `Line ${i + 1}: password`, 100),
    }));
    const names = rows.map((r) => r.username);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) fail(400, `Username "${dup}" appears twice in the list`);
    for (const r of rows) {
      if (r.password.length < 6) fail(400, `Password for ${r.username} must be at least 6 characters`);
      const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND institute_id = ?').bind(r.username, inst).first();
      if (taken) fail(409, `Username "${r.username}" already exists`);
    }
    for (const r of rows) await createUser(env, r);
    await audit('students added', `${rows.length} student(s)`);
    return json({ added: rows.length });
  }

  const member = async (id) => {
    const t = await env.DB.prepare('SELECT id, role, name FROM users WHERE id = ? AND institute_id = ?').bind(id, inst).first();
    return t || fail(404, 'User not found');
  };

  if ((m = route('PUT', /^\/api\/admin\/users\/(\d+)$/))) {
    admin();
    const target = await member(+m[1]);
    const b = await body(request);
    const username = str(b.username, 'Username', 50).toLowerCase();
    const name = str(b.name, 'Name', 100);
    if (target.role === 'student') {
      const section = await sectionId(b.section_id);
      await unique(`Username "${username}"`, () =>
        env.DB.prepare('UPDATE users SET name = ?, username = ?, roll_no = ?, section_id = ? WHERE id = ?')
          .bind(name, username, str(b.roll_no, 'Roll no', 30), section, target.id).run(),
      );
    } else {
      const f = await staffFields(b);
      if (target.id === user.id && (f.role !== user.role || !f.perms.manage)) fail(400, 'You cannot remove your own admin rights');
      await unique(`Username "${username}"`, () =>
        env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, department_id = ?, perms = ? WHERE id = ?')
          .bind(name, username, f.role, f.department_id, JSON.stringify(f.perms), target.id).run(),
      );
      await audit('staff rights changed', `${name}: ${f.role}, ${JSON.stringify(f.perms)}`);
    }
    return json({ ok: true });
  }

  if ((m = route('DELETE', /^\/api\/admin\/users\/(\d+)$/))) {
    admin();
    const target = await member(+m[1]);
    if (target.id === user.id) fail(400, 'You cannot delete your own account');
    const used = target.role === 'student'
      ? await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE student_id = ?').bind(target.id).first()
      : await env.DB.prepare('SELECT COUNT(*) AS n FROM assessments WHERE faculty_id = ?').bind(target.id).first();
    if (used.n) fail(409, target.role === 'student'
      ? 'This student has taken an assessment, so the account is kept for the records. Reset the password to block access.'
      : 'This staff member has assessments, so the account is kept for the records. Reset the password to block access.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id),
    ]);
    await audit('account deleted', `${target.name} (${target.role})`);
    return json({ ok: true });
  }

  if ((m = route('POST', /^\/api\/admin\/users\/(\d+)\/password$/))) {
    admin();
    const target = await member(+m[1]);
    if (target.id === user.id) fail(400, 'Use "Change password" for your own account');
    const password = str((await body(request)).password, 'Password', 100);
    if (password.length < 6) fail(400, 'Password must be at least 6 characters');
    const { hash, salt } = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 1 WHERE id = ?').bind(hash, salt, target.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
    ]);
    await audit('password reset', `${target.name} (${target.role})`);
    return json({ ok: true });
  }

  // ----- master data for the assessment form -----

  if (route('GET', /^\/api\/master$/)) {
    can('create');
    const [subjects, sections] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, code, semester FROM subjects WHERE institute_id = ? ORDER BY semester, code').bind(inst),
      env.DB.prepare(
        `SELECT s.id, s.name, (SELECT COUNT(*) FROM users WHERE section_id = s.id) AS students FROM sections s WHERE s.institute_id = ? ORDER BY s.name`,
      ).bind(inst),
    ]);
    return json({ subjects: subjects.results, sections: sections.results });
  }

  // ----- faculty: assessments -----

  if (route('GET', /^\/api\/assessments$/)) {
    staff();
    const sc = scope();
    const { results } = await env.DB.prepare(
      `SELECT s.*, f.name AS faculty_name,
        (SELECT COALESCE(SUM(max_marks),0) FROM questions WHERE assessment_id = s.id) AS total_marks,
        (SELECT COUNT(*) FROM attempts WHERE assessment_id = s.id AND status != 'in_progress') AS submitted,
        (SELECT COUNT(*) FROM attempts WHERE assessment_id = s.id AND status = 'published') AS published
       FROM assessments s JOIN users f ON f.id = s.faculty_id WHERE ${sc.sql} ORDER BY s.id DESC`,
    )
      .bind(...sc.binds)
      .all();
    return json(results.map((a) => ({ ...a, mine: a.faculty_id === user.id })));
  }

  if (route('POST', /^\/api\/assessments$/)) {
    can('create');
    const b = await body(request);
    const type = TYPES.includes(b.type) ? b.type : fail(400, 'Invalid assessment type');
    const number = Number.isInteger(b.number) && b.number > 0 ? b.number : fail(400, 'Invalid assessment number');
    const duration = Number.isInteger(b.duration_min) && b.duration_min >= 1 && b.duration_min <= 600
      ? b.duration_min
      : fail(400, 'Duration must be 1-600 minutes');
    const start = new Date(b.start_at);
    const end = new Date(b.end_at);
    if (isNaN(start) || isNaN(end) || end <= start) fail(400, 'Window end must be after window start');
    // Sessional marks are official internal marks: they are never released without faculty approval.
    // An MCQ Test is checked against the key, so its result is always released on submit.
    const release = type === 'MCQ Test' ? 'instant'
      : type !== 'Sessional' && b.release_mode === 'instant' ? 'instant' : 'after_approval';
    const subject = await env.DB.prepare('SELECT name, code FROM subjects WHERE id = ? AND institute_id = ?').bind(b.subject_id ?? 0, inst).first();
    if (!subject) fail(400, 'Choose a subject');
    const sectionIds = [...new Set(Array.isArray(b.section_ids) ? b.section_ids.filter(Number.isInteger) : [])];
    if (!sectionIds.length) fail(400, 'Choose at least one section');
    const known = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sections WHERE institute_id = ? AND id IN (${sectionIds.map(() => '?').join(',')})`).bind(inst, ...sectionIds).first();
    if (known.n !== sectionIds.length) fail(400, 'Unknown section');
    if (!Array.isArray(b.questions) || !b.questions.length) fail(400, 'Add at least one question');
    if (b.questions.length > 30) fail(400, 'At most 30 questions');

    const questions = b.questions.map((q, i) => {
      const label = `Question ${i + 1}`;
      const max = Number(q.max_marks);
      if (!(max > 0 && max <= 100)) fail(400, `${label}: invalid max marks`);
      const co = typeof q.co === 'string' ? q.co.trim().slice(0, 20) : '';
      if (q.kind === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) fail(400, `${label}: give 2 to 6 options`);
        const options = q.options.map((o) => str(o, `${label} option`, 500));
        if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= options.length) {
          fail(400, `${label}: mark the correct option`);
        }
        return { kind: 'mcq', text: str(q.text, `${label} text`, 5000), max, co, model: '', rubric: [], options, correct: q.correct_index };
      }
      if (type === 'MCQ Test') fail(400, `${label}: an MCQ Test can contain only MCQ questions`);
      if (!Array.isArray(q.rubric) || !q.rubric.length) fail(400, `${label}: add at least one rubric criterion`);
      const rubric = q.rubric.map((r) => {
        const marks = Number(r.marks);
        if (!(marks > 0)) fail(400, `${label}: rubric marks must be positive`);
        return { criterion: str(r.criterion, `${label} rubric criterion`, 200), marks };
      });
      const sum = rubric.reduce((s, r) => s + r.marks, 0);
      if (Math.abs(sum - max) > 1e-9) fail(400, `${label}: rubric marks add up to ${sum}, but max marks is ${max}`);
      return {
        kind: 'descriptive',
        text: str(q.text, `${label} text`, 5000),
        max,
        co,
        model: str(q.model_answer, `${label} model answer`, 8000),
        rubric,
        options: null,
        correct: null,
      };
    });

    const ins = await env.DB.prepare(
      `INSERT INTO assessments (institute_id, department_id, faculty_id, subject_name, subject_code, type, number, duration_min, start_at, end_at, release_mode, created_at, shuffle)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(inst, user.department_id ?? null, user.id, subject.name, subject.code, type, number, duration,
        start.toISOString(), end.toISOString(), release, now(), b.shuffle ? 1 : 0)
      .run();
    const id = ins.meta.last_row_id;
    await env.DB.batch([
      ...sectionIds.map((sid) => env.DB.prepare('INSERT INTO assessment_sections (assessment_id, section_id) VALUES (?,?)').bind(id, sid)),
      ...questions.map((q, i) =>
        env.DB.prepare(
          `INSERT INTO questions (assessment_id, seq, text, max_marks, co, model_answer, rubric_json, kind, options_json, correct_index)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).bind(id, i + 1, q.text, q.max, q.co, q.model, JSON.stringify(q.rubric), q.kind,
          q.options ? JSON.stringify(q.options) : null, q.correct),
      ),
    ]);
    return json({ id });
  }

  if ((m = route('GET', /^\/api\/assessments\/(\d+)$/))) {
    // (access is checked by readAssessment)
    const a = await readAssessment(+m[1]);
    await closeOverdueAttempts(env, a.id);
    const qs = await env.DB.prepare('SELECT * FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id).all();
    const at = await env.DB.prepare(
      `SELECT t.id, t.status, t.submitted_at, t.tab_switches, t.paste_attempts, u.name, u.roll_no,
        (SELECT SUM(llm_marks) FROM answers WHERE attempt_id = t.id) AS llm_total,
        (SELECT SUM(final_marks) FROM answers WHERE attempt_id = t.id) AS final_total,
        (SELECT COUNT(*) FROM answers WHERE attempt_id = t.id AND eval_status = 'failed') AS failed,
        (SELECT COUNT(*) FROM answers WHERE attempt_id = t.id AND llm_confidence = 'low') AS low
       FROM attempts t JOIN users u ON u.id = t.student_id
       WHERE t.assessment_id = ? ORDER BY u.roll_no, u.name`,
    )
      .bind(a.id)
      .all();
    const secs = await env.DB.prepare(
      `SELECT s.name FROM assessment_sections x JOIN sections s ON s.id = x.section_id WHERE x.assessment_id = ? ORDER BY s.name`,
    ).bind(a.id).all();
    return json({
      ...a,
      can: { edit: a.faculty_id === user.id && !!user.perms.create, approve: !!user.perms.approve },
      sections: secs.results.map((r) => r.name),
      questions: qs.results.map((q) => ({
        ...q,
        rubric: JSON.parse(q.rubric_json),
        options: q.options_json ? JSON.parse(q.options_json) : null,
        rubric_json: undefined,
        options_json: undefined,
      })),
      attempts: at.results,
    });
  }

  // An assessment can be removed only while no student has started it.
  if ((m = route('DELETE', /^\/api\/assessments\/(\d+)$/))) {
    // (creator only: checked by ownAssessment)
    const a = await ownAssessment(+m[1]);
    const started = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE assessment_id = ?').bind(a.id).first();
    if (started.n) fail(409, 'Students have already started this assessment, so it cannot be deleted.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM questions WHERE assessment_id = ?').bind(a.id),
      env.DB.prepare('DELETE FROM assessment_sections WHERE assessment_id = ?').bind(a.id),
      env.DB.prepare('DELETE FROM assessments WHERE id = ?').bind(a.id),
    ]);
    return json({ ok: true });
  }

  // Published marks of every student, question by question (source for analysis and the marks export).
  if ((m = route('GET', /^\/api\/assessments\/(\d+)\/marks$/))) {
    // (access is checked by readAssessment)
    const a = await readAssessment(+m[1]);
    const [qs, rows] = await env.DB.batch([
      env.DB.prepare('SELECT id, seq, co, max_marks FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id),
      env.DB.prepare(
        `SELECT u.roll_no, u.name, sec.name AS section, t.id AS attempt_id, an.question_id, an.final_marks
         FROM attempts t JOIN users u ON u.id = t.student_id LEFT JOIN sections sec ON sec.id = u.section_id
         JOIN answers an ON an.attempt_id = t.id
         WHERE t.assessment_id = ? AND t.status = 'published' ORDER BY sec.name, u.roll_no, u.name`,
      ).bind(a.id),
    ]);
    const byAttempt = new Map();
    for (const r of rows.results) {
      if (!byAttempt.has(r.attempt_id)) byAttempt.set(r.attempt_id, { roll_no: r.roll_no, name: r.name, section: r.section, marks: {} });
      byAttempt.get(r.attempt_id).marks[r.question_id] = r.final_marks;
    }
    return json({ questions: qs.results, students: [...byAttempt.values()] });
  }

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/publish$/))) {
    // (creator only: checked by ownAssessment)
    const a = await ownAssessment(+m[1]);
    await env.DB.prepare(`UPDATE assessments SET status='published' WHERE id = ?`).bind(a.id).run();
    await audit('assessment published', `${a.type} ${a.number} ${a.subject_code}`);
    return json({ ok: true });
  }

  // ----- faculty: review -----

  if ((m = route('GET', /^\/api\/attempts\/(\d+)$/))) {
    // (access is checked by staffAttempt)
    const t = await staffAttempt(+m[1]);
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.text, a.eval_status, a.eval_error, a.llm_marks, a.llm_json, a.llm_confidence, a.final_marks, a.faculty_remark,
              q.seq, q.text AS qtext, q.max_marks, q.co, q.model_answer, q.kind, q.options_json, q.correct_index
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? ORDER BY q.seq`,
    )
      .bind(t.id)
      .all();
    return json({
      ...t,
      can_approve: !!user.perms.approve,
      answers: results.map((r) => ({
        ...r,
        llm: r.llm_json ? JSON.parse(r.llm_json) : null,
        options: r.options_json ? JSON.parse(r.options_json) : null,
        llm_json: undefined,
        options_json: undefined,
      })),
    });
  }

  if ((m = route('POST', /^\/api\/attempts\/(\d+)\/evaluate$/))) {
    can('approve');
    const t = await staffAttempt(+m[1]);
    if (t.status === 'in_progress') fail(409, 'The student has not submitted yet');
    // ?force=1 discards the existing LLM drafts of typed answers and marks them again
    // (used after changing the prompt or model). Final marks set by the faculty are not touched.
    if (url.searchParams.get('force') === '1') {
      await env.DB.prepare(
        `UPDATE answers SET eval_status = 'pending' WHERE attempt_id = ?
           AND question_id IN (SELECT id FROM questions WHERE assessment_id = ? AND kind != 'mcq')`,
      ).bind(t.id, t.assessment_id).run();
    }
    await evaluateAttempt(env, t.id);
    return json({ ok: true });
  }

  if ((m = route('POST', /^\/api\/attempts\/(\d+)\/approve$/))) {
    can('approve');
    const t = await staffAttempt(+m[1]);
    if (t.status === 'in_progress') fail(409, 'The student has not submitted yet');
    const b = await body(request);
    const { results } = await env.DB.prepare(
      `SELECT a.id, q.seq, q.max_marks FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ?`,
    )
      .bind(t.id)
      .all();
    const given = new Map((Array.isArray(b.answers) ? b.answers : []).map((x) => [x.id, x]));
    const stmts = results.map((r) => {
      const g = given.get(r.id);
      const marks = Number(g?.final_marks);
      if (!g || g.final_marks === '' || g.final_marks === null || !Number.isFinite(marks)) fail(400, `Q${r.seq}: enter final marks`);
      if (marks < 0 || marks > r.max_marks) fail(400, `Q${r.seq}: marks must be between 0 and ${r.max_marks}`);
      const remark = typeof g.remark === 'string' ? g.remark.trim().slice(0, 1000) : '';
      return env.DB.prepare('UPDATE answers SET final_marks = ?, faculty_remark = ? WHERE id = ?').bind(marks, remark, r.id);
    });
    stmts.push(env.DB.prepare(`UPDATE attempts SET status='published' WHERE id = ?`).bind(t.id));
    await env.DB.batch(stmts);
    await audit('result approved', `${t.type} ${t.number} ${t.subject_code}, roll no ${t.roll_no}`);
    return json({ ok: true });
  }

  // ----- student -----

  if (route('GET', /^\/api\/my\/assessments$/)) {
    student();
    ctx.waitUntil(closeOverdueAttempts(env).catch((e) => console.error(e)));
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.subject_name, s.subject_code, s.type, s.number, s.duration_min, s.start_at, s.end_at,
        (SELECT COALESCE(SUM(max_marks),0) FROM questions WHERE assessment_id = s.id) AS total_marks,
        (SELECT COUNT(*) FROM questions WHERE assessment_id = s.id) AS question_count,
        t.id AS attempt_id, t.status AS attempt_status
       FROM assessments s LEFT JOIN attempts t ON t.assessment_id = s.id AND t.student_id = ?
       WHERE s.status = 'published'
         AND (NOT EXISTS (SELECT 1 FROM assessment_sections x WHERE x.assessment_id = s.id)
              OR EXISTS (SELECT 1 FROM assessment_sections x WHERE x.assessment_id = s.id AND x.section_id = ?)) AND s.institute_id = ?
       ORDER BY s.start_at DESC`,
    )
      .bind(user.id, user.section_id, inst)
      .all();
    return json(results);
  }

  // Start (or resume) an attempt. Model answers, rubrics and MCQ answer keys are never sent to the student here.
  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/start$/))) {
    student();
    const a = await env.DB.prepare(
      `SELECT * FROM assessments s WHERE s.id = ? AND s.status='published'
         AND (NOT EXISTS (SELECT 1 FROM assessment_sections x WHERE x.assessment_id = s.id)
              OR EXISTS (SELECT 1 FROM assessment_sections x WHERE x.assessment_id = s.id AND x.section_id = ?)) AND s.institute_id = ?`,
    ).bind(+m[1], user.section_id, inst).first();
    if (!a) fail(404, 'Assessment not found');
    let t = await env.DB.prepare('SELECT * FROM attempts WHERE assessment_id = ? AND student_id = ?').bind(a.id, user.id).first();
    const qs = await env.DB.prepare('SELECT id, seq, text, max_marks, kind, options_json FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id).all();
    if (!t) {
      const t0 = Date.now();
      if (t0 < Date.parse(a.start_at)) fail(403, 'This assessment has not started yet');
      if (t0 >= Date.parse(a.end_at)) fail(403, 'The window for this assessment is closed');
      const deadline = new Date(Math.min(t0 + a.duration_min * 60e3, Date.parse(a.end_at))).toISOString();
      const ins = await env.DB.prepare(
        'INSERT INTO attempts (assessment_id, student_id, started_at, deadline_at) VALUES (?,?,?,?)',
      )
        .bind(a.id, user.id, new Date(t0).toISOString(), deadline)
        .run();
      const attemptId = ins.meta.last_row_id;
      await env.DB.batch(
        qs.results.map((q) => env.DB.prepare('INSERT INTO answers (attempt_id, question_id) VALUES (?,?)').bind(attemptId, q.id)),
      );
      t = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(attemptId).first();
    }
    if (t.status !== 'in_progress') fail(409, 'You have already submitted this assessment');
    if (Date.now() > Date.parse(t.deadline_at) + GRACE_SECONDS * 1000) {
      await closeOverdueAttempts(env, a.id);
      fail(409, 'Your time for this assessment is over. Your saved answers have been submitted.');
    }
    if (a.shuffle) {
      // Same order every time this student reopens the attempt; a different order for each student.
      const rank = (qid) => {
        let h = (t.id * 2654435761 + qid * 40503) >>> 0;
        h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
        return h >>> 0;
      };
      qs.results.sort((x, y) => rank(x.id) - rank(y.id));
    }
    const saved = await env.DB.prepare('SELECT question_id, text FROM answers WHERE attempt_id = ?').bind(t.id).all();
    const text = new Map(saved.results.map((r) => [r.question_id, r.text]));
    return json({
      attempt_id: t.id,
      deadline_at: t.deadline_at,
      server_now: now(),
      assessment: { subject_name: a.subject_name, subject_code: a.subject_code, type: a.type, number: a.number },
      questions: qs.results.map((q) => ({
        id: q.id, seq: q.seq, text: q.text, max_marks: q.max_marks, kind: q.kind,
        options: q.options_json ? JSON.parse(q.options_json) : null,
        answer: text.get(q.id) || '',
      })),
    });
  }

  const saveAnswers = async (t, b) => {
    if (Date.now() > Date.parse(t.deadline_at) + GRACE_SECONDS * 1000) return false;
    const stmts = (Array.isArray(b.answers) ? b.answers : [])
      .filter((x) => Number.isInteger(x.question_id) && typeof x.text === 'string')
      .map((x) =>
        env.DB.prepare('UPDATE answers SET text = ? WHERE attempt_id = ? AND question_id = ?').bind(x.text.slice(0, 20000), t.id, x.question_id),
      );
    const tabs = Number.isInteger(b.tab_switches) && b.tab_switches >= 0 ? b.tab_switches : 0;
    const pastes = Number.isInteger(b.paste_attempts) && b.paste_attempts >= 0 ? b.paste_attempts : 0;
    stmts.push(
      env.DB.prepare(
        'UPDATE attempts SET tab_switches = MAX(tab_switches, ?), paste_attempts = MAX(paste_attempts, ?) WHERE id = ?',
      ).bind(tabs, pastes, t.id),
    );
    await env.DB.batch(stmts);
    return true;
  };

  if ((m = route('PUT', /^\/api\/attempts\/(\d+)\/answers$/))) {
    student();
    const t = await ownAttemptAsStudent(+m[1]);
    if (t.status !== 'in_progress') fail(409, 'This attempt is already submitted');
    if (!(await saveAnswers(t, await body(request)))) fail(403, 'Time is over');
    return json({ ok: true, saved_at: now() });
  }

  if ((m = route('POST', /^\/api\/attempts\/(\d+)\/submit$/))) {
    student();
    const t = await ownAttemptAsStudent(+m[1]);
    if (t.status !== 'in_progress') fail(409, 'This attempt is already submitted');
    const savedLast = await saveAnswers(t, await body(request)); // late => last autosaved answers stand
    await env.DB.prepare(`UPDATE attempts SET status='submitted', submitted_at = ? WHERE id = ?`).bind(now(), t.id).run();
    const typed = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM questions WHERE assessment_id = ? AND kind != 'mcq'`,
    ).bind(t.assessment_id).first();
    if (typed.n === 0) {
      // Only MCQs: no LLM call needed, so grade before replying and the result is ready at once.
      await evaluateAttempt(env, t.id);
    } else {
      ctx.waitUntil(evaluateAttempt(env, t.id).catch((e) => console.error('evaluation failed', e)));
    }
    const after = await env.DB.prepare('SELECT status FROM attempts WHERE id = ?').bind(t.id).first();
    return json({ ok: true, late: !savedLast, published: after.status === 'published' });
  }

  // Result is visible only after it has been published (faculty approval, or instant mode).
  if ((m = route('GET', /^\/api\/attempts\/(\d+)\/result$/))) {
    student();
    const t = await ownAttemptAsStudent(+m[1]);
    if (t.status !== 'published') return json({ published: false, status: t.status });
    const a = await env.DB.prepare('SELECT subject_name, subject_code, type, number FROM assessments WHERE id = ?').bind(t.assessment_id).first();
    const { results } = await env.DB.prepare(
      `SELECT q.seq, q.text AS qtext, q.max_marks, q.kind, q.options_json, q.correct_index,
              a.text, a.final_marks, a.llm_marks, a.llm_json, a.faculty_remark
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? ORDER BY q.seq`,
    )
      .bind(t.id)
      .all();
    return json({
      published: true,
      assessment: a,
      answers: results.map((r) => {
        const llm = r.llm_json ? JSON.parse(r.llm_json) : null;
        // If the faculty changed the marks, the model's criterion-wise split no longer adds up, so it is not shown.
        const moderated = r.llm_marks === null || Math.abs(r.final_marks - r.llm_marks) > 1e-9;
        return {
          seq: r.seq,
          kind: r.kind,
          question: r.qtext,
          answer: r.text,
          options: r.options_json ? JSON.parse(r.options_json) : null,
          correct_index: r.kind === 'mcq' ? r.correct_index : null,
          max_marks: r.max_marks,
          marks: r.final_marks,
          moderated,
          criteria: moderated ? null : llm?.criteria ?? null,
          missing_points: llm?.missing_points ?? [],
          improvements: llm?.improvements ?? [],
          faculty_remark: r.faculty_remark || '',
        };
      }),
    });
  }

  fail(404, 'Not found');
}

export default {
  // Runs on the cron schedule in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    await closeOverdueAttempts(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
  },
};
