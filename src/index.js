import { ROLE_DEFAULTS, prepareDatabase } from './schema.js';
import { evaluateAnswer, suggestRubric } from './evaluator.js';

// Types a faculty member can create. 'Tutorial' exists only in older data.
const TYPES = ['Mid Term', 'Sessional', 'Assignment', 'MCQ Test', 'Hybrid'];
const WRITTEN_ONLY = ['Mid Term', 'Sessional', 'Assignment'];
// Papers that go through DQAC moderation and HOD approval before students see them (MCQ tests do not).
const NEEDS_REVIEW = ['Mid Term', 'Sessional', 'Assignment', 'Hybrid'];
// Format A51-B: the DQAC moderation checklist.
const CHECKLIST = [
  'Coverage only from taught / approved syllabus portion',
  'Question paper as per approved pattern and marks distribution',
  'CO-wise mapping available and correct',
  'Difficulty level / Bloom’s level balanced',
  'Questions clear, unambiguous, and technically correct',
  'Internal choice / compulsory questions properly structured',
  'Numerical / theory / design balance appropriate',
  'Instructions to students complete and correct',
  'Spelling / code / unit / notation errors checked',
  'Confidentiality maintained during moderation',
];
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
    students: !!p.students,
    reports: ['own', 'department', 'institute'].includes(p.reports) ? p.reports : d.reports,
  };
}

async function currentUser(request, env) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  const u = await env.DB.prepare(
    `SELECT u.id, u.role, u.name, u.username, u.roll_no, u.section_id, u.institute_id, u.department_id, u.perms, u.must_change, u.post,
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

// ---------- paper structure ----------

const paperOf = (a) => { try { return JSON.parse(a.paper_json || '{}'); } catch { return {}; } };
const paperMax = (a, fallback) => paperOf(a).max_marks || fallback;

// A part can give a choice ("attempt any 2 of 3"): only the best-scoring questions of that part count.
// Sets r.counted on every row and returns the counted total. Rows need part, qgroup and the marks field.
function countBest(parts, rows, key) {
  rows.forEach((r) => (r.counted = true));
  for (const p of Array.isArray(parts) ? parts : []) {
    const groups = new Map();
    rows.filter((r) => (r.part || '') === p.name).forEach((r) => {
      const g = groups.get(r.qgroup) || { s: 0, rows: [] };
      g.s += Number(r[key] ?? 0);
      g.rows.push(r);
      groups.set(r.qgroup, g);
    });
    if (p.attempt >= groups.size) continue;
    [...groups.values()].sort((x, y) => y.s - x.s).slice(p.attempt).forEach((g) => g.rows.forEach((r) => (r.counted = false)));
  }
  return Math.round(rows.reduce((s, r) => s + (r.counted ? Number(r[key] ?? 0) : 0), 0) * 100) / 100;
}

// ---------- notifications (the bell) ----------
async function notify(env, institute, userIds, text, link = '') {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO notifications (institute_id, user_id, text, link, created_at) VALUES (?,?,?,?,?)')
    .bind(institute, id, String(text).slice(0, 300), link, now())));
}

// ---------- test start code: 4 characters, changes every few minutes, shown on the faculty's screen ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
async function startCode(seed, windowIndex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(windowIndex))));
  return [...mac.slice(0, 4)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const NO_START_CODE = ['Assignment']; // assignments are written over days, from anywhere

// ---------- institute settings ----------

// Internal-marks scheme (theory evaluation sheet) and lab rubric (lab evaluation sheet). Defaults follow EIT's TES and LES formats.
const DEFAULT_INTERNAL = {
  round: 'nearest',
  parts: [
    { label: 'Assignments', source: 'Assignment', number: 0, weight: 5 },
    { label: 'Sessional-1', source: 'Sessional', number: 1, weight: 5 },
    { label: 'Sessional-2', source: 'Sessional', number: 2, weight: 10 },
    { label: 'Attendance', source: 'manual', number: 0, weight: 5 },
  ],
};
const DEFAULT_LAB = {
  experiments: 10,
  final: 15,
  criteria: [
    { code: 'R1', label: 'Arrangement of experiment setup / algorithm of program', max: 6 },
    { code: 'R3', label: 'Viva-voce', max: 8 },
    { code: 'R4', label: 'Result and record writing', max: 6 },
  ],
};
const SETTING_DEFAULTS = { session: '', default_password: '', pass_percent: 40, rank_scope: 'section', code_minutes: 5, internal: DEFAULT_INTERNAL, lab: DEFAULT_LAB };
const SOURCES = ['Assignment', 'Sessional', 'Mid Term', 'MCQ Test', 'Hybrid', 'manual'];
function cleanInternal(v, cur) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.parts)) return cur;
  const parts = v.parts.slice(0, 8).map((p) => ({
    label: String(p.label || '').trim().slice(0, 40),
    source: SOURCES.includes(p.source) ? p.source : null,
    number: Number.isInteger(+p.number) && +p.number >= 0 && +p.number <= 9 ? +p.number : 0,
    weight: Number(p.weight),
  }));
  if (!parts.length || parts.some((p) => !p.label || !p.source || !(p.weight > 0 && p.weight <= 100))) fail(400, 'Every internal-marks component needs a name, a source and a weight');
  return { round: ['nearest', 'up', 'none'].includes(v.round) ? v.round : 'nearest', parts };
}
function cleanLab(v, cur) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.criteria)) return cur;
  const criteria = v.criteria.slice(0, 6).map((c) => ({ code: String(c.code || '').trim().slice(0, 6), label: String(c.label || '').trim().slice(0, 120), max: Number(c.max) }));
  if (!criteria.length || criteria.some((c) => !c.code || !(c.max > 0 && c.max <= 100))) fail(400, 'Every lab rubric criterion needs a code and its marks');
  const final = Number(v.final), experiments = Number(v.experiments);
  if (!(final > 0 && final <= 100) || !(Number.isInteger(experiments) && experiments >= 1 && experiments <= 20)) fail(400, 'Lab final marks must be 1-100 and experiments 1-20');
  return { criteria, final, experiments };
}
function instSettings(row) {
  let s = {};
  try { s = JSON.parse(row?.settings_json || '{}'); } catch { /* defaults */ }
  return { ...SETTING_DEFAULTS, ...s };
}

// Faculty-list "Role" column → account role and rights. Every post except Registrar and Nodal still teaches.
const POSTS = {
  faculty: { label: 'Faculty', role: 'faculty', perms: { create: true, approve: true, reports: 'own' } },
  hod: { label: 'HOD', role: 'hod', perms: { create: true, approve: true, reports: 'department' } },
  dean: { label: 'Dean', role: 'nodal', perms: { create: true, approve: true, reports: 'institute' } },
  director: { label: 'Director', role: 'nodal', perms: { create: true, approve: true, reports: 'institute' } },
  registrar: { label: 'Registrar', role: 'nodal', perms: { students: true, reports: 'institute' } },
  nodal: { label: 'Nodal officer', role: 'nodal', perms: { reports: 'institute' } },
};
const postOf = (v) => {
  const k = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return 'faculty';
  if (k === 'headofdepartment') return 'hod';
  if (k === 'nodalofficer') return 'nodal';
  return POSTS[k] ? k : null;
};

// Bloom's level from "3", "L3", "RBTL-3", "BTL3" or "Apply".
const RBT_NAMES = ['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create'];
function rbtlOf(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return null;
  const n = /(\d)\s*$/.exec(t);
  if (n && +n[1] >= 1 && +n[1] <= 6) return +n[1];
  const i = RBT_NAMES.indexOf(t.replace('analyze', 'analyse'));
  return i >= 0 ? i + 1 : null;
}

// ---------- evaluation ----------

// MCQ: checked against the answer key. No LLM involved, so the result is exact.
function gradeMcq(r) {
  const attempted = r.text !== '';
  const correct = /^\d+$/.test(r.text) && Number(r.text) === r.correct_index;
  // Negative marking: a wrong (not a blank) answer loses a fixed fraction of the question's marks.
  const penalty = attempted && !correct ? Math.round((r.negative || 0) * r.max_marks * 100) / 100 : 0;
  const awarded = correct ? r.max_marks : -penalty;
  return {
    auto: true,
    criteria: [{
      criterion: 'Correct option',
      max: r.max_marks,
      awarded,
      justification: !attempted ? 'Not attempted.' : correct ? 'Correct option selected.' : penalty ? `Wrong option selected (negative marking: -${penalty}).` : 'Wrong option selected.',
    }],
    total: awarded,
    missing_points: [],
    improvements: [],
    confidence: 'high',
  };
}

async function evaluateAttempt(env, attemptId) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.text, q.text AS qtext, q.max_marks, q.model_answer, q.rubric_json, q.kind, q.correct_index, s.negative
     FROM answers a JOIN questions q ON q.id = a.question_id JOIN assessments s ON s.id = q.assessment_id
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
      env.DB.prepare(`UPDATE attempts SET status='published', published_at = ? WHERE id = ? AND status='submitted'`).bind(now(), attemptId),
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

  // "Forgot password" from the login page. The answer is the same whether or not the account exists.
  if (route('POST', /^\/api\/password-request$/)) {
    const b = await body(request);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const key = 'pwreq:' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))).slice(0, 32);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?')
      .bind(key, new Date(Date.now() - 3600e3).toISOString()).first();
    if (recent.n >= 10) fail(429, 'Too many requests from this network. Try again in an hour.');
    await env.DB.prepare('INSERT INTO login_failures (key, at) VALUES (?,?)').bind(key, now()).run();
    const ins = await env.DB.prepare('SELECT id FROM institutes WHERE code = ? AND status = ?')
      .bind(String(b.code || '').trim().toUpperCase(), 'active').first();
    const st = ins && await env.DB.prepare(`SELECT id FROM users WHERE institute_id = ? AND username = ? AND role = 'student'`)
      .bind(ins.id, String(b.username || '').trim().toLowerCase()).first();
    if (st) {
      const open = await env.DB.prepare(`SELECT 1 FROM reset_requests WHERE student_id = ? AND status = 'open'`).bind(st.id).first();
      if (!open) {
        await env.DB.prepare('INSERT INTO reset_requests (institute_id, student_id, created_at) VALUES (?,?,?)').bind(ins.id, st.id, now()).run();
        const c = await env.DB.prepare('SELECT s.coordinator_id FROM users u JOIN sections s ON s.id = u.section_id WHERE u.id = ?').bind(st.id).first();
        if (c?.coordinator_id) await notify(env, ins.id, [c.coordinator_id], 'A student asked for a password reset', '#/my-section');
      }
    }
    return json({ ok: true });
  }

  const user = await currentUser(request, env);
  if (!user) fail(401, 'Please log in');
  const inst = user.institute_id;

  if (route('GET', /^\/api\/me$/)) {
    const [coord, dq] = user.role === 'student' || user.role === 'owner' ? [{ results: [] }, null] : await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM sections WHERE coordinator_id = ? AND institute_id = ? ORDER BY name').bind(user.id, inst),
      env.DB.prepare('SELECT position FROM dqac WHERE user_id = ?').bind(user.id),
    ]);
    return json({
      id: user.id, role: user.role, name: user.name, username: user.username, roll_no: user.roll_no, post: user.post,
      perms: user.perms, must_change: !!user.must_change, institute_name: user.institute_name, institute_code: user.institute_code,
      coordinates: coord.results, dqac: dq?.results?.[0]?.position || null,
    });
  }

  const audit = (action, detail = '') =>
    env.DB.prepare('INSERT INTO audit (institute_id, user_id, user_name, action, detail, at) VALUES (?,?,?,?,?,?)')
      .bind(inst ?? null, user.id, user.name, action, String(detail).slice(0, 500), now()).run();

  if (route('POST', /^\/api\/password$/)) {
    // Students set their own password once (first login or after a reset); later changes go through the institute.
    if (user.role === 'student' && !user.must_change) fail(403, 'Ask your class coordinator to reset your password');
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
    const i = await env.DB.prepare('SELECT name, line, logo, letterhead, format_json, settings_json, code FROM institutes WHERE id = ?').bind(inst).first();
    let format = {};
    try { format = JSON.parse(i.format_json || '{}'); } catch {}
    const settings = instSettings(i);
    delete settings.default_password; // never sent to the browser
    return json({ institute: i.name, line: i.line, logo: i.logo, letterhead: i.letterhead, format, settings, code: i.code });
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
  const isReviewer = async (aid) => !!(await env.DB.prepare('SELECT 1 FROM reviews WHERE assessment_id = ? AND reviewer_id = ?').bind(aid, user.id).first());
  const isHodOf = (a) => user.role === 'hod' && !!user.department_id && a.department_id === user.department_id;
  // A paper is confidential until it is published: only its author, the HOD of its department and its DQAC reviewers may open it.
  const readAssessment = async (id) => {
    staff();
    const sc = scope();
    let a = await env.DB.prepare(
      `SELECT s.*, f.name AS faculty_name FROM assessments s JOIN users f ON f.id = s.faculty_id WHERE s.id = ? AND ${sc.sql}`,
    ).bind(id, ...sc.binds).first();
    const reviewer = await isReviewer(id);
    if (!a && reviewer) {
      a = await env.DB.prepare('SELECT s.*, f.name AS faculty_name FROM assessments s JOIN users f ON f.id = s.faculty_id WHERE s.id = ? AND s.institute_id = ?').bind(id, inst).first();
    }
    if (!a) fail(404, 'Assessment not found');
    if (a.status !== 'published' && a.faculty_id !== user.id) {
      if (!isHodOf(a) && !reviewer) fail(403, 'This paper is confidential until it is published.');
      await env.DB.prepare('INSERT INTO paper_views (assessment_id, user_id, user_name, at) VALUES (?,?,?,?)').bind(a.id, user.id, user.name, now()).run();
    }
    return a;
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
    // Letterhead: the institute's own header image, printed at the top of every generated document.
    const lh = typeof b.letterhead === 'string' ? b.letterhead : '';
    if (lh && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(lh)) fail(400, 'Letterhead must be a PNG or JPG image');
    if (lh.length > 950000) fail(400, 'Letterhead image is too large (keep it under 700 KB)');
    // Question paper format of this institute (column names, signature lines…).
    const fi = b.format && typeof b.format === 'object' ? b.format : {};
    const ft = (k, n) => (typeof fi[k] === 'string' ? fi[k].trim().slice(0, n) : '');
    const format = {
      tax_exam: ft('tax_exam', 40), tax_exam_style: fi.tax_exam_style === 'name' ? 'name' : 'code', tax_code: ft('tax_code', 10),
      tax_asg: ft('tax_asg', 40), tax_asg_style: fi.tax_asg_style === 'code' ? 'code' : 'name',
      sign_exam: ft('sign_exam', 200), sign_asg: ft('sign_asg', 200), roll: fi.roll !== false,
    };
    // Institute-wide rules: the current academic session, first password, pass mark, rank scope, start-code interval.
    const cur = instSettings(await env.DB.prepare('SELECT settings_json FROM institutes WHERE id = ?').bind(inst).first());
    const si = b.settings && typeof b.settings === 'object' ? b.settings : {};
    const settings = {
      session: typeof si.session === 'string' ? si.session.trim().slice(0, 40) : cur.session,
      default_password: typeof si.default_password === 'string' && si.default_password.trim() ? si.default_password.trim().slice(0, 50) : cur.default_password,
      pass_percent: Number(si.pass_percent) >= 1 && Number(si.pass_percent) <= 100 ? Number(si.pass_percent) : cur.pass_percent,
      rank_scope: si.rank_scope ? (si.rank_scope === 'branch' ? 'branch' : 'section') : cur.rank_scope,
      code_minutes: [5, 10].includes(Number(si.code_minutes)) ? Number(si.code_minutes) : cur.code_minutes,
      internal: cleanInternal(si.internal, cur.internal),
      lab: cleanLab(si.lab, cur.lab),
    };
    if (settings.default_password && settings.default_password.length < 6) fail(400, 'The first password must be at least 6 characters');
    await env.DB.prepare('UPDATE institutes SET name = ?, line = ?, logo = ?, letterhead = ?, format_json = ?, settings_json = ? WHERE id = ?')
      .bind(str(b.institute, 'Institute name', 150), typeof b.line === 'string' ? b.line.trim().slice(0, 200) : '', logo, lh,
        JSON.stringify(format), JSON.stringify(settings), inst).run();
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

  // ----- institute setup: programmes, scheme, faculty, sections, allotment, students (Excel imports) -----

  const canStudents = () => (isStaff && (user.perms.students || user.perms.manage)) || fail(403, 'Only the registrar or the institute admin can do this');
  const settingsRow = async () => instSettings(await env.DB.prepare('SELECT settings_json FROM institutes WHERE id = ?').bind(inst).first());
  // Everyone created by an import gets the institute's first password; it is hashed once for the whole batch.
  let firstPw = null;
  const firstPassword = async () => {
    if (firstPw) return firstPw;
    const st = await settingsRow();
    if (!st.default_password) fail(400, 'Set the first password for new accounts in Institute setup → Profile first');
    firstPw = await hashPassword(st.default_password);
    return firstPw;
  };
  const low = (v) => String(v ?? '').trim().toLowerCase();
  const txt = (v, n = 200) => String(v ?? '').trim().slice(0, n);

  if (route('GET', /^\/api\/setup\/data$/)) {
    if (!(isStaff && (user.perms.manage || user.perms.students || user.role === 'hod' || user.perms.reports === 'institute'))) fail(403, 'Not allowed');
    const [departments, programmes, sections, subjects, staffRows, allot, counts] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM departments WHERE institute_id = ? ORDER BY name').bind(inst),
      env.DB.prepare(`SELECT p.id, p.name, p.department_id, d.name AS department FROM programmes p LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.institute_id = ? ORDER BY p.name`).bind(inst),
      env.DB.prepare(`SELECT s.id, s.name, s.programme, s.programme_id, s.semester, s.department_id, s.coordinator_id, d.name AS department,
          c.name AS coordinator, (SELECT COUNT(*) FROM users WHERE section_id = s.id AND role = 'student' AND status = 'active') AS students
        FROM sections s LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN users c ON c.id = s.coordinator_id
        WHERE s.institute_id = ? ORDER BY s.name`).bind(inst),
      env.DB.prepare(`SELECT s.id, s.code, s.name, s.semester, s.type, s.elective_group, s.credits, s.cos_json, s.department_id, s.programme_id,
          d.name AS department, p.name AS programme
        FROM subjects s LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN programmes p ON p.id = s.programme_id
        WHERE s.institute_id = ? ORDER BY s.semester, s.code`).bind(inst),
      env.DB.prepare(`SELECT u.id, u.name, u.username, u.emp_id, u.designation, u.post, u.role, u.email, u.mobile, u.department_id, d.name AS department
        FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.institute_id = ? AND u.role != 'student' ORDER BY d.name, u.name`).bind(inst),
      env.DB.prepare(`SELECT a.id, a.subject_id, a.section_id, a.faculty_id, sb.code, sb.name AS subject, sc.name AS section, f.name AS faculty
        FROM allotments a JOIN subjects sb ON sb.id = a.subject_id JOIN sections sc ON sc.id = a.section_id JOIN users f ON f.id = a.faculty_id
        WHERE a.institute_id = ? ORDER BY sc.name, sb.code`).bind(inst),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE institute_id = ? AND role = 'student' AND status = 'active'`).bind(inst),
    ]);
    const st = await settingsRow();
    return json({
      departments: departments.results,
      programmes: programmes.results,
      sections: sections.results,
      subjects: subjects.results.map((x) => ({ ...x, cos: JSON.parse(x.cos_json || '[]'), cos_json: undefined })),
      staff: staffRows.results.map((x) => ({ ...x, post: x.post || (x.role === 'admin' ? 'admin' : x.role === 'hod' ? 'hod' : x.role === 'nodal' ? 'nodal' : 'faculty'), self: x.id === user.id })),
      allotments: allot.results,
      students: counts.results[0].n,
      has_first_password: !!st.default_password,
      posts: Object.fromEntries(Object.entries(POSTS).map(([k, v]) => [k, v.label])),
    });
  }

  // programmes
  if (route('POST', /^\/api\/setup\/programmes$/)) {
    admin();
    const b = await body(request);
    await unique(`Programme "${b.name}"`, () => env.DB.prepare('INSERT INTO programmes (institute_id, department_id, name) VALUES (?,?,?)')
      .bind(inst, null, str(b.name, 'Programme name', 120)).run().then(async (r) => {
        const d = b.department_id ? await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND institute_id = ?').bind(+b.department_id, inst).first() : null;
        if (d) await env.DB.prepare('UPDATE programmes SET department_id = ? WHERE id = ?').bind(d.id, r.meta.last_row_id).run();
      }));
    return json({ ok: true });
  }
  if ((m = route('DELETE', /^\/api\/setup\/programmes\/(\d+)$/))) {
    admin();
    const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM sections WHERE programme_id = ?1) + (SELECT COUNT(*) FROM subjects WHERE programme_id = ?1) AS n').bind(+m[1]).first();
    if (used.n) fail(409, 'Sections or subjects still use this programme.');
    await env.DB.prepare('DELETE FROM programmes WHERE id = ? AND institute_id = ?').bind(+m[1], inst).run();
    return json({ ok: true });
  }

  // sections with programme, semester and class coordinator
  const sectionBody = async (b) => {
    const prog = b.programme_id ? await env.DB.prepare('SELECT id, name, department_id FROM programmes WHERE id = ? AND institute_id = ?').bind(+b.programme_id, inst).first() : null;
    if (!prog) fail(400, 'Choose a programme');
    const sem = Number(b.semester);
    if (!(Number.isInteger(sem) && sem >= 1 && sem <= 12)) fail(400, 'Semester must be 1-12');
    let coord = null;
    if (b.coordinator_id) {
      const c = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND institute_id = ? AND role != 'student'`).bind(+b.coordinator_id, inst).first();
      coord = c ? c.id : fail(400, 'Unknown class coordinator');
    }
    return { name: str(b.name, 'Section name', 80), prog, sem, coord };
  };
  if (route('POST', /^\/api\/setup\/sections$/)) {
    admin();
    const f = await sectionBody(await body(request));
    await unique(`Section "${f.name}"`, () => env.DB.prepare(
      'INSERT INTO sections (institute_id, department_id, programme, programme_id, semester, coordinator_id, name) VALUES (?,?,?,?,?,?,?)',
    ).bind(inst, f.prog.department_id, f.prog.name, f.prog.id, f.sem, f.coord, f.name).run());
    return json({ ok: true });
  }
  if ((m = route('PUT', /^\/api\/setup\/sections\/(\d+)$/))) {
    admin();
    const f = await sectionBody(await body(request));
    await unique(`Section "${f.name}"`, () => env.DB.prepare(
      'UPDATE sections SET department_id = ?, programme = ?, programme_id = ?, semester = ?, coordinator_id = ?, name = ? WHERE id = ? AND institute_id = ?',
    ).bind(f.prog.department_id, f.prog.name, f.prog.id, f.sem, f.coord, f.name, +m[1], inst).run());
    return json({ ok: true });
  }

  // one faculty row: role (post), department, designation
  if ((m = route('PUT', /^\/api\/setup\/staff\/(\d+)$/))) {
    admin();
    const b = await body(request);
    const t = await env.DB.prepare(`SELECT id, role FROM users WHERE id = ? AND institute_id = ? AND role != 'student'`).bind(+m[1], inst).first();
    if (!t) fail(404, 'Staff member not found');
    if (t.role === 'admin') fail(400, 'The institute admin account is changed under its own settings');
    const post = postOf(b.post) || fail(400, 'Unknown role');
    const d = b.department_id ? await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND institute_id = ?').bind(+b.department_id, inst).first() : null;
    await env.DB.prepare('UPDATE users SET name = ?, designation = ?, post = ?, role = ?, perms = ?, department_id = ?, email = ?, mobile = ? WHERE id = ?')
      .bind(str(b.name, 'Name', 100), txt(b.designation, 80), post, POSTS[post].role, JSON.stringify(cleanPerms(POSTS[post].role, POSTS[post].perms)),
        d ? d.id : null, txt(b.email, 150), txt(b.mobile, 20), t.id).run();
    await audit('staff updated', `${b.name}: ${POSTS[post].label}`);
    return json({ ok: true });
  }

  // allotment: one row per subject and section
  if (route('POST', /^\/api\/setup\/allotments$/)) {
    admin();
    const b = await body(request);
    const [sb, sc, f] = await Promise.all([
      env.DB.prepare('SELECT id FROM subjects WHERE id = ? AND institute_id = ?').bind(+b.subject_id || 0, inst).first(),
      env.DB.prepare('SELECT id FROM sections WHERE id = ? AND institute_id = ?').bind(+b.section_id || 0, inst).first(),
      env.DB.prepare(`SELECT id FROM users WHERE id = ? AND institute_id = ? AND role IN ('faculty','hod','nodal')`).bind(+b.faculty_id || 0, inst).first(),
    ]);
    if (!sb || !sc || !f) fail(400, 'Choose a subject, a section and a faculty member');
    await env.DB.prepare(`INSERT INTO allotments (institute_id, subject_id, section_id, faculty_id) VALUES (?,?,?,?)
      ON CONFLICT (subject_id, section_id) DO UPDATE SET faculty_id = excluded.faculty_id`).bind(inst, sb.id, sc.id, f.id).run();
    return json({ ok: true });
  }
  if ((m = route('DELETE', /^\/api\/setup\/allotments\/(\d+)$/))) {
    admin();
    await env.DB.prepare('DELETE FROM allotments WHERE id = ? AND institute_id = ?').bind(+m[1], inst).run();
    return json({ ok: true });
  }

  // ----- Excel imports: the browser sends the rows; ?commit=1 applies the valid ones, otherwise it is a preview -----
  if ((m = route('POST', /^\/api\/import\/(subjects|faculty|allotment|students|electives)$/))) {
    const kind = m[1];
    if (kind === 'students' || kind === 'electives') canStudents(); else admin();
    const b = await body(request);
    const rows = Array.isArray(b.rows) ? b.rows : fail(400, 'No rows');
    if (!rows.length) fail(400, 'The file has no data rows');
    if (rows.length > 400) fail(400, 'At most 400 rows per file. Split the list.');
    const commit = url.searchParams.get('commit') === '1';
    const plan = await planImport(kind, rows);
    if (commit) {
      const ok = plan.items.filter((x) => x.action === 'new' || x.action === 'update');
      for (const it of ok) await it.apply();
      await audit(`${kind} imported`, `${plan.summary.new} new, ${plan.summary.update} updated, ${plan.summary.error} rows skipped`);
    }
    return json({ committed: commit, summary: plan.summary, rows: plan.items.map(({ apply, ...r }) => r) });
  }

  async function planImport(kind, rows) {
    const items = [];
    const seen = new Set();
    const push = (n, key, action, extra = {}) => items.push({ n, key, action, ...extra });
    const err = (n, key, error) => push(n, key, 'error', { error });
    const [deps, progs, secs, subs, staffList] = (await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM departments WHERE institute_id = ?').bind(inst),
      env.DB.prepare('SELECT id, name, department_id FROM programmes WHERE institute_id = ?').bind(inst),
      env.DB.prepare('SELECT id, name, semester, programme_id FROM sections WHERE institute_id = ?').bind(inst),
      env.DB.prepare('SELECT id, code, name, semester, type, elective_group, credits, cos_json, department_id, programme_id FROM subjects WHERE institute_id = ?').bind(inst),
      env.DB.prepare(`SELECT id, emp_id, username, name, role, post, designation, department_id, email, mobile FROM users WHERE institute_id = ? AND role != 'student'`).bind(inst),
    ])).map((r) => r.results);
    const byName = (list, v) => list.find((x) => low(x.name) === low(v));
    let before = 0;

    if (kind === 'subjects') {
      before = subs.length;
      const newProgs = new Map();
      for (const [i, r] of rows.entries()) {
        const n = i + 2; // row number in the sheet (row 1 is the header)
        const code = txt(r.code, 30);
        if (!code) { err(n, '', 'Subject code is missing'); continue; }
        if (seen.has(low(code))) { err(n, code, 'This code appears twice in the file'); continue; }
        seen.add(low(code));
        const name = txt(r.subjectname, 150);
        if (!name) { err(n, code, 'Subject name is missing'); continue; }
        const dep = byName(deps, r.department);
        if (!dep) { err(n, code, `Department "${txt(r.department)}" is not in Institute setup → Departments`); continue; }
        const sem = Number(r.semester);
        if (!(Number.isInteger(sem) && sem >= 1 && sem <= 12)) { err(n, code, 'Semester must be 1 to 12'); continue; }
        const type = ['theory', 'lab', 'elective'].includes(low(r.type)) ? low(r.type)[0].toUpperCase() + low(r.type).slice(1) : (r.type ? null : 'Theory');
        if (!type) { err(n, code, 'Type must be Theory, Lab or Elective'); continue; }
        const cos = [];
        let bad = '';
        for (let k = 1; k <= 8; k++) {
          const t = txt(r['co' + k], 600);
          if (!t) continue;
          const lv = rbtlOf(r['co' + k + 'level']);
          if (!lv) { bad = `CO${k} level must be 1-6 or Remember … Create`; break; }
          cos.push({ co: 'CO' + k, text: t, rbtl: lv });
        }
        if (bad) { err(n, code, bad); continue; }
        if (!cos.length) { err(n, code, 'Give at least CO1 and its level'); continue; }
        const progName = txt(r.programme, 120);
        if (!progName) { err(n, code, 'Programme is missing'); continue; }
        const credits = r.credits === '' || r.credits === undefined ? null : Number(r.credits);
        const ex = subs.find((x) => low(x.code) === low(code));
        const vals = { name, sem, type, group: txt(r.electivegroup, 40) || null, credits: Number.isFinite(credits) ? credits : null, cos: JSON.stringify(cos), dep: dep.id };
        const progId = async () => {
          const p0 = byName(progs, progName);
          if (p0) return p0.id;
          if (!newProgs.has(low(progName))) {
            newProgs.set(low(progName), (async () => {
              const r2 = await env.DB.prepare('INSERT INTO programmes (institute_id, department_id, name) VALUES (?,?,?)').bind(inst, dep.id, progName).run();
              return r2.meta.last_row_id;
            })());
          }
          return newProgs.get(low(progName));
        };
        const same = ex && ex.name === name && ex.semester === sem && ex.type === type && (ex.elective_group || null) === vals.group
          && ex.credits === vals.credits && ex.cos_json === vals.cos && ex.department_id === dep.id && byName(progs, progName)?.id === ex.programme_id;
        push(n, code, ex ? (same ? 'same' : 'update') : 'new', {
          detail: `${name} · Sem ${sem} · ${type} · ${cos.length} COs${byName(progs, progName) ? '' : ` · new programme "${progName}"`}`,
          apply: async () => {
            const pid = await progId();
            if (ex) {
              await env.DB.prepare('UPDATE subjects SET name=?, semester=?, type=?, elective_group=?, credits=?, cos_json=?, department_id=?, programme_id=? WHERE id=?')
                .bind(vals.name, vals.sem, vals.type, vals.group, vals.credits, vals.cos, vals.dep, pid, ex.id).run();
            } else {
              await env.DB.prepare('INSERT INTO subjects (institute_id, code, name, semester, type, elective_group, credits, cos_json, department_id, programme_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .bind(inst, code, vals.name, vals.sem, vals.type, vals.group, vals.credits, vals.cos, vals.dep, pid).run();
            }
          },
        });
      }
    }

    if (kind === 'faculty') {
      before = staffList.filter((x) => x.role !== 'admin').length;
      for (const [i, r] of rows.entries()) {
        const n = i + 2;
        const emp = txt(r.employeeid, 40);
        if (!emp) { err(n, '', 'Employee ID is missing'); continue; }
        if (!/^[A-Za-z0-9._-]+$/.test(emp)) { err(n, emp, 'Employee ID may have letters, digits, dot, dash and underscore only'); continue; }
        if (seen.has(low(emp))) { err(n, emp, 'This employee ID appears twice in the file'); continue; }
        seen.add(low(emp));
        const name = txt(r.name, 100);
        if (!name) { err(n, emp, 'Name is missing'); continue; }
        const dep = byName(deps, r.department);
        if (!dep) { err(n, emp, `Department "${txt(r.department)}" is not in Institute setup → Departments`); continue; }
        const post = postOf(r.role);
        if (!post) { err(n, emp, 'Role must be Faculty, HOD, Dean, Director, Registrar or Nodal'); continue; }
        const ex = staffList.find((x) => low(x.emp_id) === low(emp) || low(x.username) === low(emp));
        if (ex && ex.role === 'admin') { err(n, emp, 'This ID belongs to the institute admin account'); continue; }
        const v = { name, dep: dep.id, desig: txt(r.designation, 80), post, email: txt(r.email, 150), mobile: txt(r.mobile, 20) };
        const same = ex && ex.name === v.name && ex.department_id === v.dep && (ex.designation || '') === v.desig && (ex.post || 'faculty') === post
          && (ex.email || '') === v.email && (ex.mobile || '') === v.mobile;
        push(n, emp, ex ? (same ? 'same' : 'update') : 'new', {
          detail: `${name} · ${dep.name} · ${v.desig || '—'} · ${POSTS[post].label}`,
          apply: async () => {
            const perms = JSON.stringify(cleanPerms(POSTS[post].role, POSTS[post].perms));
            if (ex) {
              await env.DB.prepare('UPDATE users SET name=?, department_id=?, designation=?, post=?, role=?, perms=?, email=?, mobile=?, emp_id=? WHERE id=?')
                .bind(v.name, v.dep, v.desig, post, POSTS[post].role, perms, v.email, v.mobile, emp, ex.id).run();
            } else {
              const pw = await firstPassword();
              await env.DB.prepare(`INSERT INTO users (institute_id, role, name, username, pw_hash, pw_salt, created_at, department_id, perms, must_change,
                  emp_id, designation, post, email, mobile) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`)
                .bind(inst, POSTS[post].role, v.name, low(emp), pw.hash, pw.salt, now(), v.dep, perms, emp, v.desig, post, v.email, v.mobile).run();
            }
          },
        });
      }
      if (items.some((x) => x.action === 'new')) await firstPassword();
    }

    if (kind === 'allotment') {
      const cur = (await env.DB.prepare('SELECT subject_id, section_id, faculty_id FROM allotments WHERE institute_id = ?').bind(inst).all()).results;
      before = cur.length;
      for (const [i, r] of rows.entries()) {
        const n = i + 2;
        const sb = subs.find((x) => low(x.code) === low(r.subjectcode));
        const sc = byName(secs, r.section);
        const f = staffList.find((x) => low(x.emp_id) === low(r.employeeid) || low(x.username) === low(r.employeeid));
        const key = `${txt(r.subjectcode)} / ${txt(r.section)}`;
        if (!sb) { err(n, key, `Subject code "${txt(r.subjectcode)}" is not in the scheme`); continue; }
        if (!sc) { err(n, key, `Section "${txt(r.section)}" is not in Institute setup → Sections`); continue; }
        if (!f || f.role === 'admin') { err(n, key, `Employee ID "${txt(r.employeeid)}" is not in the faculty list`); continue; }
        if (seen.has(sb.id + ':' + sc.id)) { err(n, key, 'This subject and section appear twice in the file'); continue; }
        seen.add(sb.id + ':' + sc.id);
        const ex = cur.find((x) => x.subject_id === sb.id && x.section_id === sc.id);
        push(n, key, ex ? (ex.faculty_id === f.id ? 'same' : 'update') : 'new', {
          detail: `${sb.name} → ${f.name}`,
          apply: () => env.DB.prepare(`INSERT INTO allotments (institute_id, subject_id, section_id, faculty_id) VALUES (?,?,?,?)
            ON CONFLICT (subject_id, section_id) DO UPDATE SET faculty_id = excluded.faculty_id`).bind(inst, sb.id, sc.id, f.id).run(),
        });
      }
    }

    if (kind === 'students' || kind === 'electives') {
      const studs = (await env.DB.prepare(`SELECT id, username, name, univ_roll, college_roll, roll_no, section_id, semester, email, mobile, status, programme_id
        FROM users WHERE institute_id = ? AND role = 'student'`).bind(inst).all()).results;
      const findStudent = (u, c) => studs.find((x) => (u && (low(x.univ_roll) === low(u) || low(x.username) === low(u)))
        || (c && (low(x.college_roll) === low(c) || low(x.roll_no) === low(c))));

      if (kind === 'electives') {
        before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM elective_choices WHERE institute_id = ?').bind(inst).first()).n;
        for (const [i, r] of rows.entries()) {
          const n = i + 2;
          const roll = txt(r.rollno, 40);
          const st = findStudent(roll, roll);
          const sb = subs.find((x) => low(x.code) === low(r.subjectcode));
          const key = `${roll} / ${txt(r.subjectcode)}`;
          if (!st) { err(n, key, `No student with roll no "${roll}"`); continue; }
          if (!sb) { err(n, key, `Subject code "${txt(r.subjectcode)}" is not in the scheme`); continue; }
          if (sb.type !== 'Elective') { err(n, key, `${sb.code} is not marked as an elective in the scheme`); continue; }
          if (seen.has(st.id + ':' + sb.id)) { err(n, key, 'Appears twice in the file'); continue; }
          seen.add(st.id + ':' + sb.id);
          const ex = await env.DB.prepare('SELECT 1 FROM elective_choices WHERE student_id = ? AND subject_id = ?').bind(st.id, sb.id).first();
          push(n, key, ex ? 'same' : 'new', {
            detail: `${st.name} → ${sb.name}`,
            apply: () => env.DB.prepare('INSERT OR IGNORE INTO elective_choices (institute_id, student_id, subject_id) VALUES (?,?,?)').bind(inst, st.id, sb.id).run(),
          });
        }
      } else {
        const touched = new Set();
        for (const [i, r] of rows.entries()) {
          const n = i + 2;
          const u = txt(r.universityrollno, 40);
          const c = txt(r.collegerollno, 40);
          const key = u || c;
          if (!key) { err(n, '', 'Give the university roll no or the college roll no'); continue; }
          if ((u && seen.has('u' + low(u))) || (c && seen.has('c' + low(c)))) { err(n, key, 'This roll no appears twice in the file'); continue; }
          if (u) seen.add('u' + low(u));
          if (c) seen.add('c' + low(c));
          const name = txt(r.name, 100);
          if (!name) { err(n, key, 'Name is missing'); continue; }
          const sc = byName(secs, r.section);
          if (!sc) { err(n, key, `Section "${txt(r.section)}" is not in Institute setup → Sections`); continue; }
          const sem = r.semester === '' || r.semester === undefined ? sc.semester : Number(r.semester);
          if (!(Number.isInteger(sem) && sem >= 1 && sem <= 12)) { err(n, key, 'Semester must be 1 to 12'); continue; }
          const email = txt(r.email, 150);
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err(n, key, 'Email is not valid'); continue; }
          const ex = findStudent(u, c);
          // Sections are frozen after the first year; marks always stay with the paper.
          if (ex && ex.section_id !== sc.id && (ex.semester || sem) > 2) { err(n, key, 'Section can be changed only in the first year'); continue; }
          const uname = low(u || c);
          if (!ex && studs.some((x) => low(x.username) === uname)) { err(n, key, 'This roll no is already used as a username'); continue; }
          touched.add(sc.id);
          if (ex) touched.add(ex.section_id);
          const v = { name, u: u || ex?.univ_roll || null, c: c || ex?.college_roll || null, sc: sc.id, sem, prog: sc.programme_id, email, mobile: txt(r.mobile, 20) };
          const same = ex && ex.name === v.name && (ex.univ_roll || null) === v.u && (ex.college_roll || null) === v.c && ex.section_id === v.sc
            && ex.semester === v.sem && (ex.email || '') === v.email && (ex.mobile || '') === v.mobile;
          push(n, key, ex ? (same ? 'same' : 'update') : 'new', {
            detail: `${name} · ${sc.name} · Sem ${sem}${ex && ex.section_id !== sc.id ? ' · section changes' : ''}`,
            apply: async () => {
              if (ex) {
                // When the university roll no arrives later, it becomes the username (if free).
                const nu = v.u && low(ex.username) !== low(v.u) && !studs.some((x) => x.id !== ex.id && low(x.username) === low(v.u)) ? low(v.u) : ex.username;
                await env.DB.prepare('UPDATE users SET name=?, univ_roll=?, college_roll=?, roll_no=?, section_id=?, semester=?, programme_id=?, email=?, mobile=?, username=? WHERE id=?')
                  .bind(v.name, v.u, v.c, v.c || v.u, v.sc, v.sem, v.prog, v.email, v.mobile, nu, ex.id).run();
              } else {
                const pw = await firstPassword();
                await env.DB.prepare(`INSERT INTO users (institute_id, role, name, username, roll_no, pw_hash, pw_salt, created_at, section_id, must_change,
                    univ_roll, college_roll, email, mobile, programme_id, semester, status) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,'active')`)
                  .bind(inst, 'student', v.name, uname, v.c || v.u, pw.hash, pw.salt, now(), v.sc, v.u, v.c, v.email, v.mobile, v.prog, v.sem).run();
              }
            },
          });
        }
        if (items.some((x) => x.action === 'new')) await firstPassword();
        before = studs.filter((x) => touched.has(x.section_id) && x.status === 'active').length;
      }
    }

    const count = (a) => items.filter((x) => x.action === a).length;
    const summary = { before, new: count('new'), update: count('update'), same: count('same'), error: count('error') };
    summary.after = before + summary.new;
    return { items, summary };
  }

  // ----- registrar: students -----
  if (route('GET', /^\/api\/students$/)) {
    const sec = Number(url.searchParams.get('section')) || 0;
    const mine = await env.DB.prepare('SELECT id FROM sections WHERE id = ? AND coordinator_id = ? AND institute_id = ?').bind(sec, user.id, inst).first();
    if (!mine) canStudents();
    const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.username, u.univ_roll, u.college_roll, u.semester, u.email, u.mobile, u.status, u.must_change,
        u.section_id, s.name AS section,
        (SELECT COUNT(*) FROM reset_requests r WHERE r.student_id = u.id AND r.status = 'open') AS reset_open
      FROM users u LEFT JOIN sections s ON s.id = u.section_id
      WHERE u.institute_id = ? AND u.role = 'student' ${sec ? 'AND u.section_id = ?' : ''} ORDER BY s.name, COALESCE(u.college_roll, u.univ_roll), u.name LIMIT 2000`)
      .bind(...(sec ? [inst, sec] : [inst])).all();
    return json(results);
  }
  if (route('POST', /^\/api\/students$/)) {
    canStudents();
    const b = await body(request);
    const plan = await planImport('students', [b]);
    const it = plan.items[0];
    if (it.action === 'error') fail(400, it.error);
    if (it.action !== 'new') fail(409, 'A student with this roll no already exists. Edit that student instead.');
    await it.apply();
    await audit('student added', `${b.name} (${it.key})`);
    return json({ ok: true });
  }
  if ((m = route('PUT', /^\/api\/students\/(\d+)$/))) {
    canStudents();
    const b = await body(request);
    const t = await env.DB.prepare(`SELECT id, univ_roll, college_roll FROM users WHERE id = ? AND institute_id = ? AND role = 'student'`).bind(+m[1], inst).first();
    if (!t) fail(404, 'Student not found');
    const plan = await planImport('students', [{ ...b, universityrollno: b.universityrollno ?? t.univ_roll, collegerollno: b.collegerollno ?? t.college_roll }]);
    const it = plan.items[0];
    if (it.action === 'error') fail(400, it.error);
    if (it.action === 'update') await it.apply();
    if (['active', 'detained', 'left'].includes(b.status)) await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(b.status, t.id).run();
    await audit('student updated', `${b.name || t.id}`);
    return json({ ok: true });
  }
  // Promotion: every active student of a section moves to the next section (detained and left students stay).
  if (route('POST', /^\/api\/students\/promote$/)) {
    canStudents();
    const b = await body(request);
    const [from, to] = await Promise.all([
      env.DB.prepare('SELECT id, name, semester FROM sections WHERE id = ? AND institute_id = ?').bind(+b.from || 0, inst).first(),
      env.DB.prepare('SELECT id, name, semester, programme_id FROM sections WHERE id = ? AND institute_id = ?').bind(+b.to || 0, inst).first(),
    ]);
    if (!from || !to || from.id === to.id) fail(400, 'Choose two different sections');
    const r = await env.DB.prepare(`UPDATE users SET section_id = ?, semester = ?, programme_id = COALESCE(?, programme_id)
      WHERE section_id = ? AND institute_id = ? AND role = 'student' AND status = 'active'`).bind(to.id, to.semester, to.programme_id, from.id, inst).run();
    await audit('students promoted', `${r.meta.changes} from ${from.name} to ${to.name}`);
    return json({ moved: r.meta.changes });
  }
  // Password reset to the institute's first password: registrar, admin, or the class coordinator of the student's section.
  if ((m = route('POST', /^\/api\/students\/(\d+)\/reset$/))) {
    const t = await env.DB.prepare(`SELECT u.id, u.name, s.coordinator_id FROM users u LEFT JOIN sections s ON s.id = u.section_id
      WHERE u.id = ? AND u.institute_id = ? AND u.role = 'student'`).bind(+m[1], inst).first();
    if (!t) fail(404, 'Student not found');
    if (t.coordinator_id !== user.id) canStudents();
    const pw = await firstPassword();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 1 WHERE id = ?').bind(pw.hash, pw.salt, t.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.id),
      env.DB.prepare(`UPDATE reset_requests SET status = 'done', done_by = ?, done_at = ? WHERE student_id = ? AND status = 'open'`).bind(user.name, now(), t.id),
    ]);
    await audit('student password reset', t.name);
    return json({ ok: true });
  }

  // ----- HOD: DQAC committee of the department -----
  if (route('GET', /^\/api\/dqac$/)) {
    if (user.role !== 'hod' || !user.department_id) fail(403, 'Only a head of department sets the DQAC');
    const [members, faculty] = await env.DB.batch([
      env.DB.prepare(`SELECT q.user_id, q.position, u.name, u.designation FROM dqac q JOIN users u ON u.id = q.user_id WHERE q.department_id = ? ORDER BY q.position, u.name`).bind(user.department_id),
      env.DB.prepare(`SELECT id, name, designation FROM users WHERE department_id = ? AND institute_id = ? AND role IN ('faculty','hod','nodal') ORDER BY name`).bind(user.department_id, inst),
    ]);
    return json({ members: members.results, faculty: faculty.results });
  }
  if (route('PUT', /^\/api\/dqac$/)) {
    if (user.role !== 'hod' || !user.department_id) fail(403, 'Only a head of department sets the DQAC');
    const b = await body(request);
    const list = Array.isArray(b.members) ? b.members : [];
    const ids = (await env.DB.prepare(`SELECT id FROM users WHERE department_id = ? AND institute_id = ? AND role IN ('faculty','hod','nodal')`).bind(user.department_id, inst).all()).results.map((x) => x.id);
    const clean = list.filter((x) => ids.includes(+x.user_id)).map((x) => ({ id: +x.user_id, pos: x.position === 'coordinator' ? 'coordinator' : 'member' }));
    if (clean.filter((x) => x.pos === 'coordinator').length > 1) fail(400, 'Choose one DQAC coordinator');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dqac WHERE department_id = ?').bind(user.department_id),
      ...clean.map((x) => env.DB.prepare('INSERT INTO dqac (institute_id, department_id, user_id, position) VALUES (?,?,?,?)').bind(inst, user.department_id, x.id, x.pos)),
    ]);
    await audit('DQAC updated', `${clean.length} member(s)`);
    return json({ ok: true });
  }

  // ----- class coordinator: open "forgot password" requests -----
  if (route('GET', /^\/api\/reset-requests$/)) {
    staff();
    const { results } = await env.DB.prepare(`SELECT r.id, r.created_at, u.id AS student_id, u.name, u.username, s.name AS section
      FROM reset_requests r JOIN users u ON u.id = r.student_id LEFT JOIN sections s ON s.id = u.section_id
      WHERE r.institute_id = ? AND r.status = 'open' AND (s.coordinator_id = ? OR ?) ORDER BY r.id`)
      .bind(inst, user.id, user.perms.students || user.perms.manage ? 1 : 0).all();
    return json(results);
  }

  // ----- master data for the assessment form -----

  // The subjects and sections this faculty member is allotted, with the subject's COs (scheme) and the section's programme.
  // An institute that has not set up allotment yet sees every subject and section, as before.
  if (route('GET', /^\/api\/master$/)) {
    can('create');
    const any = await env.DB.prepare('SELECT COUNT(*) AS n FROM allotments WHERE institute_id = ?').bind(inst).first();
    const st = await settingsRow();
    if (!any.n) {
      const [subjects, sections] = await env.DB.batch([
        env.DB.prepare('SELECT id, name, code, semester, cos_json FROM subjects WHERE institute_id = ? ORDER BY semester, code').bind(inst),
        env.DB.prepare(`SELECT s.id, s.name, s.programme, s.semester, (SELECT COUNT(*) FROM users WHERE section_id = s.id AND role = 'student') AS students
          FROM sections s WHERE s.institute_id = ? ORDER BY s.name`).bind(inst),
      ]);
      return json({ allotment: false, session: st.session, subjects: subjects.results.map((x) => ({ ...x, cos: JSON.parse(x.cos_json || '[]'), cos_json: undefined, sections: sections.results })) });
    }
    const { results } = await env.DB.prepare(`SELECT sb.id, sb.name, sb.code, sb.semester, sb.cos_json, p.name AS programme,
        sc.id AS section_id, sc.name AS section, sc.semester AS section_semester,
        (SELECT COUNT(*) FROM users WHERE section_id = sc.id AND role = 'student' AND status = 'active') AS students
      FROM allotments a JOIN subjects sb ON sb.id = a.subject_id JOIN sections sc ON sc.id = a.section_id LEFT JOIN programmes p ON p.id = sb.programme_id
      WHERE a.faculty_id = ? AND a.institute_id = ? ORDER BY sb.code, sc.name`).bind(user.id, inst).all();
    const subjects = new Map();
    for (const r of results) {
      if (!subjects.has(r.id)) subjects.set(r.id, { id: r.id, name: r.name, code: r.code, semester: r.semester, programme: r.programme, cos: JSON.parse(r.cos_json || '[]'), sections: [] });
      subjects.get(r.id).sections.push({ id: r.section_id, name: r.section, students: r.students });
    }
    return json({ allotment: true, session: st.session, subjects: [...subjects.values()] });
  }

  // "AI recommends": a draft rubric from the question and model answer; the faculty edits it.
  if (route('POST', /^\/api\/ai\/rubric$/)) {
    can('create');
    const b = await body(request);
    const max = Number(b.max_marks);
    if (!(max > 0 && max <= 100)) fail(400, 'Enter the max marks first');
    try {
      return json({ rubric: await suggestRubric(env, { question: str(b.question, 'Question', 5000), modelAnswer: typeof b.model_answer === 'string' ? b.model_answer.slice(0, 8000) : '', maxMarks: max }) });
    } catch (e) {
      fail(503, 'The AI could not suggest a rubric right now. Write it yourself or try again.');
    }
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
    return json(results.filter((a) => a.status === 'published' || a.faculty_id === user.id || isHodOf(a))
      .map((a) => ({ ...a, total_marks: paperMax(a, a.total_marks), paper_json: undefined, mine: a.faculty_id === user.id, needs_review: NEEDS_REVIEW.includes(a.type) })));
  }

  // Creating and editing a paper go through the same checks.
  const readPaper = async (b) => {
    const type = TYPES.includes(b.type) ? b.type : fail(400, 'Choose an assessment type');
    const number = Number.isInteger(b.number) && b.number > 0 ? b.number : fail(400, 'Invalid assessment number');
    const start = new Date(b.start_at);
    const end = new Date(b.end_at);
    if (isNaN(start) || isNaN(end) || end <= start) fail(400, 'Window end must be after window start');
    // An assignment is open for the whole window (often days) and can be resumed, so its time limit is the window itself.
    const duration = type === 'Assignment'
      ? Math.ceil((end - start) / 60e3)
      : Number.isInteger(b.duration_min) && b.duration_min >= 1 && b.duration_min <= 600 ? b.duration_min : fail(400, 'Duration must be 1-600 minutes');
    // Mid Term and Sessional marks are official internal marks: never released without faculty approval.
    // An MCQ Test is checked against the key, so its result is released on submit. Hybrid has written answers, so it waits for approval.
    const release = type === 'MCQ Test' ? 'instant'
      : type === 'Assignment' && b.release_mode === 'instant' ? 'instant' : 'after_approval';
    const mcqAllowed = !WRITTEN_ONLY.includes(type);
    const negative = mcqAllowed && [0, 0.25, 0.33, 0.5, 1].includes(Number(b.negative)) ? Number(b.negative) : 0;
    // Header details printed on the question paper (title, programme, instructions, CO statements…).
    const pin = b.paper && typeof b.paper === 'object' ? b.paper : {};
    const ptxt = (k, n) => (typeof pin[k] === 'string' ? pin[k].trim().slice(0, n) : '');
    const paper = {
      title: ptxt('title', 150), programme: ptxt('programme', 150), session: ptxt('session', 40), units: ptxt('units', 60),
      instructions: ptxt('instructions', 2000), cos: ptxt('cos', 3000), intro: ptxt('intro', 3000),
      max_marks: Number(pin.max_marks) > 0 && Number(pin.max_marks) <= 1000 ? Number(pin.max_marks) : fail(400, 'Enter the maximum marks of the paper'),
    };
    // Paper structure: parts, how many questions each has, sub-parts per question, and how many the student attempts.
    const partsIn = Array.isArray(pin.parts) ? pin.parts : [];
    if (!partsIn.length || partsIn.length > 6) fail(400, 'Set up the paper structure (1 to 6 parts)');
    const int = (v, lo, hi, what) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail(400, `${what} must be ${lo} to ${hi}`));
    paper.parts = partsIn.map((p, i) => {
      const name = typeof p.name === 'string' ? p.name.trim().slice(0, 10) : '';
      if (partsIn.length > 1 && !name) fail(400, `Part ${i + 1}: give the part a name (e.g. A)`);
      const questions = int(p.questions, 1, 40, `Part ${name || i + 1}: number of questions`);
      return {
        name,
        kind: type === 'MCQ Test' ? 'mcq' : type === 'Hybrid' && p.kind === 'mcq' ? 'mcq' : 'descriptive',
        questions,
        subparts: int(p.subparts, 1, 15, `Part ${name || i + 1}: sub-parts per question`),
        attempt: int(p.attempt, 1, questions, `Part ${name || i + 1}: questions to attempt`),
        style: p.style === 'roman' ? 'roman' : 'alpha',
      };
    });
    if (new Set(paper.parts.map((p) => p.name)).size !== paper.parts.length) fail(400, 'Two parts have the same name');
    const subject = await env.DB.prepare('SELECT id, name, code, cos_json FROM subjects WHERE id = ? AND institute_id = ?').bind(b.subject_id ?? 0, inst).first();
    if (!subject) fail(400, 'Choose a subject');
    const subjectCos = JSON.parse(subject.cos_json || '[]').map((c) => c.co);
    const sectionIds = [...new Set(Array.isArray(b.section_ids) ? b.section_ids.filter(Number.isInteger) : [])];
    if (!sectionIds.length) fail(400, 'Choose at least one section');
    const known = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sections WHERE institute_id = ? AND id IN (${sectionIds.map(() => '?').join(',')})`).bind(inst, ...sectionIds).first();
    if (known.n !== sectionIds.length) fail(400, 'Unknown section');
    // With allotment in use, a faculty member sets papers only for the subject and sections allotted to them.
    const anyAllot = await env.DB.prepare('SELECT COUNT(*) AS n FROM allotments WHERE institute_id = ?').bind(inst).first();
    if (anyAllot.n) {
      const mine = await env.DB.prepare(`SELECT COUNT(*) AS n FROM allotments WHERE faculty_id = ? AND subject_id = ? AND section_id IN (${sectionIds.map(() => '?').join(',')})`)
        .bind(user.id, subject.id, ...sectionIds).first();
      if (mine.n !== sectionIds.length) fail(403, 'You can set papers only for the subject and sections allotted to you');
    }
    if (!Array.isArray(b.questions) || !b.questions.length) fail(400, 'Add at least one question');
    if (b.questions.length > 80) fail(400, 'At most 80 questions');

    const questions = b.questions.map((q, i) => {
      const label = `Question ${i + 1}`;
      const max = Number(q.max_marks);
      if (!(max > 0 && max <= 100)) fail(400, `${label}: invalid max marks`);
      const co = typeof q.co === 'string' ? q.co.trim().slice(0, 20) : '';
      if (type === 'Mid Term' && !co) fail(400, `${label}: give the CO (required for a Mid Term paper)`);
      if (co && subjectCos.length && !subjectCos.includes(co)) fail(400, `${label}: ${co} is not a CO of ${subject.code} in the scheme`);
      const part = typeof q.part === 'string' ? q.part.trim().slice(0, 10) : '';
      const pdef = paper.parts.find((p) => p.name === part) || fail(400, `${label}: unknown part`);
      const qgroup = Number.isInteger(q.qgroup) && q.qgroup >= 1 ? q.qgroup : fail(400, `${label}: missing question number`);
      if ((q.kind === 'mcq' ? 'mcq' : 'descriptive') !== pdef.kind) fail(400, `${label}: part ${part} has only ${pdef.kind === 'mcq' ? 'MCQs' : 'written questions'}`);
      const qlabel = typeof q.label === 'string' ? q.label.trim().slice(0, 12) : '';
      const rbtl = Number.isInteger(q.rbtl) && q.rbtl >= 1 && q.rbtl <= 6 ? q.rbtl : null;
      if (q.kind === 'mcq') {
        if (!mcqAllowed) fail(400, `${label}: a ${type} has only written (descriptive) questions`);
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) fail(400, `${label}: give 2 to 6 options`);
        const options = q.options.map((o) => str(o, `${label} option`, 500));
        if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= options.length) {
          fail(400, `${label}: mark the correct option`);
        }
        return { kind: 'mcq', text: str(q.text, `${label} text`, 5000), max, co, part, qgroup, qlabel, rbtl, model: '', rubric: [], options, correct: q.correct_index };
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
        part,
        qgroup,
        qlabel,
        rbtl,
        model: str(q.model_answer, `${label} model answer`, 8000),
        rubric,
        options: null,
        correct: null,
      };
    });

    for (const p of paper.parts) {
      const n = questions.filter((q) => q.part === p.name).length;
      if (n !== p.questions * p.subparts) fail(400, `Part ${p.name}: expected ${p.questions * p.subparts} question boxes, got ${n}. Rebuild the question boxes.`);
    }
    // The highest score possible (counting only the questions a student attempts) must equal the paper's max marks.
    const possible = countBest(paper.parts, questions.map((q) => ({ part: q.part, qgroup: q.qgroup, m: q.max })), 'm');
    if (Math.abs(possible - paper.max_marks) > 1e-9) {
      fail(400, `Marks do not add up: the questions a student attempts carry ${possible} marks, but the paper's max marks is ${paper.max_marks}`);
    }
    if (type === 'Hybrid' && !(questions.some((q) => q.kind === 'mcq') && questions.some((q) => q.kind !== 'mcq'))) {
      fail(400, 'A Hybrid assessment needs at least one MCQ and one written question');
    }
    return { type, number, duration, start, end, release, subject, sectionIds, negative, paper, questions,
      shuffle: b.shuffle ? 1 : 0, optionShuffle: mcqAllowed && b.option_shuffle ? 1 : 0 };
  };
  const writePaper = (id, P) => env.DB.batch([
    env.DB.prepare('DELETE FROM assessment_sections WHERE assessment_id = ?').bind(id),
    env.DB.prepare('DELETE FROM questions WHERE assessment_id = ?').bind(id),
    ...P.sectionIds.map((sid) => env.DB.prepare('INSERT INTO assessment_sections (assessment_id, section_id) VALUES (?,?)').bind(id, sid)),
    ...P.questions.map((q, i) =>
      env.DB.prepare(
        `INSERT INTO questions (assessment_id, seq, text, max_marks, co, model_answer, rubric_json, kind, options_json, correct_index, part, label, rbtl, qgroup)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, i + 1, q.text, q.max, q.co, q.model, JSON.stringify(q.rubric), q.kind,
        q.options ? JSON.stringify(q.options) : null, q.correct, q.part, q.qlabel, q.rbtl, q.qgroup),
    ),
  ]);

  if (route('POST', /^\/api\/assessments$/)) {
    can('create');
    const P = await readPaper(await body(request));
    const ins = await env.DB.prepare(
      `INSERT INTO assessments (institute_id, department_id, faculty_id, subject_id, subject_name, subject_code, type, number, duration_min, start_at, end_at, release_mode, created_at, shuffle, negative, option_shuffle, paper_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(inst, user.department_id ?? null, user.id, P.subject.id, P.subject.name, P.subject.code, P.type, P.number, P.duration,
        P.start.toISOString(), P.end.toISOString(), P.release, now(), P.shuffle, P.negative, P.optionShuffle, JSON.stringify(P.paper))
      .run();
    const id = ins.meta.last_row_id;
    await writePaper(id, P);
    return json({ id });
  }

  // Editing: only the author, only before any student starts, and not while DQAC review is in progress.
  if ((m = route('PUT', /^\/api\/assessments\/(\d+)$/))) {
    const a = await ownAssessment(+m[1]);
    const started = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE assessment_id = ?').bind(a.id).first();
    if (started.n) fail(409, 'Students have started this assessment, so it can no longer be edited.');
    if (!['draft', 'changes'].includes(a.stage || 'draft') || (a.status === 'published' && a.stage !== 'draft')) {
      fail(409, a.stage === 'review' ? 'The paper is with the DQAC for review. It can be edited again if changes are asked for.' : 'This paper is approved and locked.');
    }
    const P = await readPaper(await body(request));
    if (P.type !== a.type) fail(400, 'The assessment type cannot be changed');
    await env.DB.prepare(`UPDATE assessments SET subject_id=?, subject_name=?, subject_code=?, number=?, duration_min=?, start_at=?, end_at=?, release_mode=?,
        shuffle=?, negative=?, option_shuffle=?, paper_json=? WHERE id = ?`)
      .bind(P.subject.id, P.subject.name, P.subject.code, P.number, P.duration, P.start.toISOString(), P.end.toISOString(), P.release,
        P.shuffle, P.negative, P.optionShuffle, JSON.stringify(P.paper), a.id).run();
    await writePaper(a.id, P);
    return json({ id: a.id });
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
      `SELECT s.id, s.name FROM assessment_sections x JOIN sections s ON s.id = x.section_id WHERE x.assessment_id = ? ORDER BY s.name`,
    ).bind(a.id).all();
    const parts = paperOf(a).parts;
    if (parts) {
      const ans = await env.DB.prepare(
        `SELECT an.attempt_id, an.llm_marks, an.final_marks, q.part, q.qgroup FROM answers an JOIN questions q ON q.id = an.question_id
         JOIN attempts t ON t.id = an.attempt_id WHERE t.assessment_id = ?`,
      ).bind(a.id).all();
      for (const t of at.results) {
        const mine = ans.results.filter((r) => r.attempt_id === t.id);
        if (t.llm_total !== null) t.llm_total = countBest(parts, mine.map((r) => ({ ...r })), 'llm_marks');
        if (t.final_total !== null) t.final_total = countBest(parts, mine.map((r) => ({ ...r })), 'final_marks');
      }
    }
    return json({
      ...a,
      can: { edit: a.faculty_id === user.id && !!user.perms.create, approve: !!user.perms.approve },
      sections: secs.results.map((r) => r.name),
      section_ids: secs.results.map((r) => r.id),
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
      env.DB.prepare('SELECT id, seq, co, max_marks, part, qgroup, label FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id),
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
    return json({ questions: qs.results, students: [...byAttempt.values()], parts: paperOf(a).parts || null, max_marks: paperOf(a).max_marks || null });
  }

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/publish$/))) {
    // (creator only: checked by ownAssessment)
    const a = await ownAssessment(+m[1]);
    if (NEEDS_REVIEW.includes(a.type) && a.stage !== 'approved') fail(409, 'This paper needs DQAC moderation and HOD approval before it can be published.');
    await env.DB.prepare(`UPDATE assessments SET status='published', code_seed = COALESCE(code_seed, ?) WHERE id = ?`).bind(hex(crypto.getRandomValues(new Uint8Array(16))), a.id).run();
    await audit('assessment published', `${a.type} ${a.number} ${a.subject_code}`);
    return json({ ok: true });
  }

  // ----- question paper moderation (A51): submit → DQAC review → compliance → re-submit → HOD approval -----

  const lastVersion = async (aid) => (await env.DB.prepare('SELECT MAX(version) AS v FROM paper_versions WHERE assessment_id = ?').bind(aid).first()).v || 0;
  const snapshot = async (a) => {
    const qs = await env.DB.prepare('SELECT seq, part, label, text, max_marks, co, rbtl, kind, options_json, correct_index, model_answer, rubric_json FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id).all();
    return JSON.stringify({ paper: paperOf(a), questions: qs.results });
  };
  const userNames = async (ids) => {
    if (!ids.length) return new Map();
    const r = await env.DB.prepare(`SELECT id, name, designation, signature FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    return new Map(r.results.map((x) => [x.id, x]));
  };

  if ((m = route('GET', /^\/api\/assessments\/(\d+)\/moderation$/))) {
    const a = await readAssessment(+m[1]);
    if (!NEEDS_REVIEW.includes(a.type)) return json({ needed: false });
    const [vers, revs, comp, views, dq, sub] = await env.DB.batch([
      env.DB.prepare('SELECT version, created_at FROM paper_versions WHERE assessment_id = ? ORDER BY version').bind(a.id),
      env.DB.prepare('SELECT * FROM reviews WHERE assessment_id = ? ORDER BY version, id').bind(a.id),
      env.DB.prepare('SELECT version, items_json, created_at FROM compliance WHERE assessment_id = ? ORDER BY version').bind(a.id),
      env.DB.prepare('SELECT user_name, at FROM paper_views WHERE assessment_id = ? ORDER BY at DESC LIMIT 50').bind(a.id),
      env.DB.prepare(`SELECT q.user_id, q.position, u.name FROM dqac q JOIN users u ON u.id = q.user_id WHERE q.department_id = ? ORDER BY q.position, u.name`).bind(a.department_id ?? 0),
      env.DB.prepare('SELECT cos_json FROM subjects WHERE id = ?').bind(a.subject_id ?? 0),
    ]);
    const v = vers.results.length ? vers.results[vers.results.length - 1].version : 0;
    const people = await userNames([...new Set([...revs.results.map((r) => r.reviewer_id), a.approved_by_id, a.faculty_id].filter(Boolean))]);
    const reviews = revs.results.map((r) => ({
      id: r.id, version: r.version, reviewer_id: r.reviewer_id, reviewer: people.get(r.reviewer_id)?.name, status: r.status, decision: r.decision,
      remarks: r.remarks, due_date: r.due_date, assigned_at: r.assigned_at, submitted_at: r.submitted_at,
      checklist: JSON.parse(r.checklist_json || '[]'), comments: JSON.parse(r.comments_json || '[]'),
    }));
    const current = reviews.filter((r) => r.version === v);
    const myPending = current.find((r) => r.reviewer_id === user.id && r.status === 'pending');
    // Remarks the faculty must answer: everything from the reviews of the latest version that asked for changes.
    const remarks = a.stage === 'changes' ? current.filter((r) => r.decision === 'resubmit').flatMap((r) => [
      ...r.checklist.map((c, i) => (c.action ? { from: r.reviewer, text: `${CHECKLIST[i]}: ${c.action}` } : null)).filter(Boolean),
      ...r.comments.filter((c) => c.text).map((c) => ({ from: r.reviewer, text: `Q ${c.label}: ${c.text}` })),
      ...(r.remarks ? [{ from: r.reviewer, text: r.remarks }] : []),
    ]) : [];
    const doneAll = current.length > 0 && current.every((r) => r.status === 'done');
    const sigOf = (id) => people.get(id)?.signature || null;
    return json({
      needed: true, stage: a.stage || 'draft', version: v, checklist: CHECKLIST,
      versions: vers.results, reviews, compliance: comp.results.map((c) => ({ ...c, items: JSON.parse(c.items_json), items_json: undefined })),
      views: isHodOf(a) || a.faculty_id === user.id ? views.results : [],
      dqac: isHodOf(a) ? dq.results.filter((x) => x.user_id !== a.faculty_id) : [],
      cos: JSON.parse(sub.results[0]?.cos_json || '[]'),
      remarks, approved_by: a.approved_by, approved_at: a.approved_at,
      signatures: Object.fromEntries([...people.keys()].map((id) => [id, sigOf(id)]).filter(([, x]) => x)),
      can: {
        submit: a.faculty_id === user.id && ['draft', 'changes'].includes(a.stage || 'draft'),
        assign: isHodOf(a) && a.stage === 'review',
        review: myPending ? myPending.id : null,
        approve: isHodOf(a) && a.stage === 'review' && doneAll && current.every((r) => r.decision === 'ok'),
      },
    });
  }

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/submit-review$/))) {
    const a = await ownAssessment(+m[1]);
    if (!NEEDS_REVIEW.includes(a.type)) fail(400, 'MCQ tests do not need moderation');
    if (!['draft', 'changes'].includes(a.stage || 'draft')) fail(409, 'This paper is already with the DQAC');
    const b = await body(request);
    const v = await lastVersion(a.id);
    const stmts = [];
    if (a.stage === 'changes') {
      // A51-C: the faculty answers each remark and declares the corrections are in the paper.
      const items = Array.isArray(b.compliance) ? b.compliance : [];
      if (!items.length || items.some((x) => typeof x.done !== 'string' || !x.done.trim())) fail(400, 'Write what you changed against every remark');
      if (b.declared !== true) fail(400, 'Tick the declaration that all corrections are in the paper');
      stmts.push(env.DB.prepare('INSERT INTO compliance (institute_id, assessment_id, version, items_json, created_at) VALUES (?,?,?,?,?)')
        .bind(inst, a.id, v + 1, JSON.stringify(items.slice(0, 60).map((x) => ({ remark: String(x.remark || '').slice(0, 600), done: x.done.trim().slice(0, 600), ref: String(x.ref || '').slice(0, 30) }))), now()));
    }
    stmts.push(env.DB.prepare('INSERT INTO paper_versions (institute_id, assessment_id, version, snapshot_json, created_at) VALUES (?,?,?,?,?)').bind(inst, a.id, v + 1, await snapshot(a), now()));
    stmts.push(env.DB.prepare(`UPDATE assessments SET stage = 'review' WHERE id = ?`).bind(a.id));
    // A re-submission goes back to the members who reviewed it, so they can verify the compliance.
    if (v) {
      const prev = await env.DB.prepare('SELECT DISTINCT reviewer_id FROM reviews WHERE assessment_id = ? AND version = ?').bind(a.id, v).all();
      for (const r of prev.results) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO reviews (institute_id, assessment_id, version, reviewer_id, assigned_at) VALUES (?,?,?,?,?)').bind(inst, a.id, v + 1, r.reviewer_id, now()));
    }
    await env.DB.batch(stmts);
    await audit(v ? 'paper re-submitted for review' : 'paper submitted for review', `${a.type} ${a.number} ${a.subject_code} v${v + 1}`);
    return json({ ok: true, version: v + 1 });
  }

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/assign$/))) {
    const a = await readAssessment(+m[1]);
    if (!isHodOf(a)) fail(403, 'Only the HOD of this department assigns reviewers');
    if (a.stage !== 'review') fail(409, 'The paper has not been submitted for review');
    const b = await body(request);
    const ids = [...new Set((Array.isArray(b.reviewer_ids) ? b.reviewer_ids : []).map(Number))];
    if (!ids.length) fail(400, 'Choose at least one DQAC member');
    if (ids.includes(a.faculty_id)) fail(400, 'The author of the paper cannot review it');
    const dq = (await env.DB.prepare('SELECT user_id FROM dqac WHERE department_id = ?').bind(a.department_id ?? 0).all()).results.map((x) => x.user_id);
    if (ids.some((id) => !dq.includes(id) && id !== user.id)) fail(400, 'Reviewers must be DQAC members of the department');
    const v = await lastVersion(a.id);
    const due = typeof b.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null;
    await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT OR IGNORE INTO reviews (institute_id, assessment_id, version, reviewer_id, assigned_at, due_date) VALUES (?,?,?,?,?,?)').bind(inst, a.id, v, id, now(), due)));
    await notify(env, inst, ids, `Paper to review: ${a.type} ${a.number} · ${a.subject_code}`, `#/a/${a.id}`);
    await audit('reviewers assigned', `${a.type} ${a.number} ${a.subject_code} v${v}: ${ids.length} member(s)`);
    return json({ ok: true });
  }

  if ((m = route('POST', /^\/api\/reviews\/(\d+)$/))) {
    const r = await env.DB.prepare('SELECT * FROM reviews WHERE id = ? AND reviewer_id = ? AND institute_id = ?').bind(+m[1], user.id, inst).first();
    if (!r) fail(404, 'Review not found');
    if (r.status !== 'pending') fail(409, 'You have already submitted this review');
    const a = await env.DB.prepare('SELECT * FROM assessments WHERE id = ?').bind(r.assessment_id).first();
    if (r.version !== await lastVersion(a.id)) fail(409, 'A newer version of the paper has been submitted');
    const b = await body(request);
    const list = Array.isArray(b.checklist) ? b.checklist : [];
    if (list.length !== CHECKLIST.length || list.some((c) => typeof c.ok !== 'boolean')) fail(400, 'Answer Yes or No for every checklist point');
    const checklist = list.map((c) => ({ ok: c.ok, obs: String(c.obs || '').trim().slice(0, 500), action: String(c.action || '').trim().slice(0, 500) }));
    const comments = (Array.isArray(b.comments) ? b.comments : []).filter((c) => c && String(c.text || '').trim())
      .slice(0, 80).map((c) => ({ label: String(c.label || '').slice(0, 20), text: String(c.text).trim().slice(0, 800) }));
    const decision = b.decision === 'resubmit' ? 'resubmit' : b.decision === 'ok' ? 'ok' : fail(400, 'Choose the decision');
    if (decision === 'resubmit' && !checklist.some((c) => c.action) && !comments.length && !String(b.remarks || '').trim()) fail(400, 'Say what has to be corrected');
    const due = typeof b.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : r.due_date;
    await env.DB.prepare(`UPDATE reviews SET status = 'done', checklist_json = ?, comments_json = ?, decision = ?, remarks = ?, due_date = ?, submitted_at = ? WHERE id = ?`)
      .bind(JSON.stringify(checklist), JSON.stringify(comments), decision, String(b.remarks || '').trim().slice(0, 2000), due, now(), r.id).run();
    // When every reviewer of this version has answered and any asked for changes, the paper goes back to its author.
    const pending = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(decision = 'resubmit') AS re FROM reviews WHERE assessment_id = ? AND version = ? AND status != 'done'`).bind(a.id, r.version).first();
    const anyResubmit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE assessment_id = ? AND version = ? AND decision = 'resubmit'`).bind(a.id, r.version).first();
    if (!pending.n && anyResubmit.n) {
      await env.DB.prepare(`UPDATE assessments SET stage = 'changes' WHERE id = ?`).bind(a.id).run();
      await notify(env, inst, [a.faculty_id], `DQAC asked for changes: ${a.type} ${a.number} · ${a.subject_code}`, `#/a/${a.id}`);
    }
    await audit('paper reviewed', `${a.type} ${a.number} ${a.subject_code} v${r.version}: ${decision === 'ok' ? 'fit' : 'resubmit'}`);
    return json({ ok: true });
  }

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/hod-approve$/))) {
    const a = await readAssessment(+m[1]);
    if (!isHodOf(a)) fail(403, 'Only the HOD of this department approves the paper');
    if (a.stage !== 'review') fail(409, 'The paper is not awaiting approval');
    const v = await lastVersion(a.id);
    const st = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(status = 'done') AS done, SUM(decision = 'resubmit') AS re FROM reviews WHERE assessment_id = ? AND version = ?`).bind(a.id, v).first();
    if (!st.n) fail(409, 'Assign DQAC reviewers first');
    if (st.done < st.n) fail(409, 'Some DQAC members have not submitted their review yet');
    if (st.re) fail(409, 'A reviewer asked for changes');
    await env.DB.prepare(`UPDATE assessments SET stage = 'approved', approved_by = ?, approved_by_id = ?, approved_at = ? WHERE id = ?`).bind(user.name, user.id, now(), a.id).run();
    await notify(env, inst, [a.faculty_id], `Paper approved by HOD: ${a.type} ${a.number} · ${a.subject_code}. You can publish it now.`, `#/a/${a.id}`);
    await audit('paper approved by HOD', `${a.type} ${a.number} ${a.subject_code} v${v}`);
    return json({ ok: true });
  }

  // A51-G: the HOD's master tracker of every paper in the department.
  if (route('GET', /^\/api\/moderation\/tracker$/)) {
    if (user.role !== 'hod' || !user.department_id) fail(403, 'Heads of department only');
    const { results } = await env.DB.prepare(`SELECT s.id, s.type, s.number, s.subject_code, s.subject_name, s.stage, s.status, s.approved_at, f.name AS faculty,
        (SELECT MIN(created_at) FROM paper_versions WHERE assessment_id = s.id) AS submitted_at,
        (SELECT MAX(version) FROM paper_versions WHERE assessment_id = s.id) AS version,
        (SELECT MAX(submitted_at) FROM reviews WHERE assessment_id = s.id AND version = 1) AS moderated_at,
        (SELECT MAX(created_at) FROM compliance WHERE assessment_id = s.id) AS compliance_at,
        (SELECT COUNT(*) FROM reviews WHERE assessment_id = s.id AND version = (SELECT MAX(version) FROM paper_versions WHERE assessment_id = s.id)) AS reviewers,
        (SELECT COUNT(*) FROM reviews WHERE assessment_id = s.id AND status = 'pending') AS pending
      FROM assessments s JOIN users f ON f.id = s.faculty_id
      WHERE s.institute_id = ? AND s.department_id = ? AND s.type IN ('Mid Term','Sessional','Assignment','Hybrid') ORDER BY s.id DESC`).bind(inst, user.department_id).all();
    return json(results);
  }

  // Reviews waiting for this DQAC member.
  if (route('GET', /^\/api\/reviews\/mine$/)) {
    staff();
    const { results } = await env.DB.prepare(`SELECT r.id, r.assessment_id, r.version, r.status, r.due_date, r.assigned_at, s.type, s.number, s.subject_code, s.subject_name, f.name AS faculty
      FROM reviews r JOIN assessments s ON s.id = r.assessment_id JOIN users f ON f.id = s.faculty_id
      WHERE r.reviewer_id = ? AND r.institute_id = ? ORDER BY r.status DESC, r.id DESC LIMIT 100`).bind(user.id, inst).all();
    return json(results);
  }

  // Signatures for moderation reports: each person their own, or the HOD for the department's members.
  if ((m = route('PUT', /^\/api\/signature(?:\/(\d+))?$/))) {
    staff();
    const b = await body(request);
    const img = typeof b.image === 'string' ? b.image : '';
    if (img && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)) fail(400, 'Signature must be a PNG or JPG image');
    if (img.length > 140000) fail(400, 'Signature image is too large (keep it under 100 KB)');
    let target = user.id;
    if (m[1]) {
      const t = await env.DB.prepare('SELECT id, department_id FROM users WHERE id = ? AND institute_id = ?').bind(+m[1], inst).first();
      if (!t || user.role !== 'hod' || t.department_id !== user.department_id) fail(403, 'The HOD can add signatures only for the department\'s members');
      target = t.id;
    }
    await env.DB.prepare('UPDATE users SET signature = ? WHERE id = ?').bind(img || null, target).run();
    return json({ ok: true });
  }
  if (route('GET', /^\/api\/signature$/)) {
    staff();
    const r = await env.DB.prepare('SELECT signature FROM users WHERE id = ?').bind(user.id).first();
    return json({ image: r?.signature || '' });
  }

  // ----- faculty: review -----

  if ((m = route('GET', /^\/api\/attempts\/(\d+)$/))) {
    // (access is checked by staffAttempt)
    const t = await staffAttempt(+m[1]);
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.text, a.eval_status, a.eval_error, a.llm_marks, a.llm_json, a.llm_confidence, a.final_marks, a.faculty_remark,
              q.seq, q.part, q.label, q.qgroup, q.text AS qtext, q.max_marks, q.co, q.model_answer, q.kind, q.options_json, q.correct_index
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? ORDER BY q.seq`,
    )
      .bind(t.id)
      .all();
    const pa = paperOf(await env.DB.prepare('SELECT paper_json FROM assessments WHERE id = ?').bind(t.assessment_id).first());
    const total = countBest(pa.parts, results, t.status === 'published' ? 'final_marks' : 'llm_marks');
    const rechecks = (await env.DB.prepare(`SELECT r.id, r.reason, r.status, r.response, r.old_marks, r.new_marks, r.created_at, q.seq
      FROM rechecks r JOIN answers a ON a.id = r.answer_id JOIN questions q ON q.id = a.question_id WHERE r.attempt_id = ? ORDER BY r.id`).bind(t.id).all()).results;
    return json({
      ...t,
      rechecks,
      total,
      max: pa.max_marks || results.reduce((s, r) => s + r.max_marks, 0),
      parts: pa.parts || null,
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
      `SELECT a.id, q.seq, q.max_marks, q.kind, s.negative FROM answers a JOIN questions q ON q.id = a.question_id
       JOIN assessments s ON s.id = q.assessment_id WHERE a.attempt_id = ?`,
    )
      .bind(t.id)
      .all();
    const given = new Map((Array.isArray(b.answers) ? b.answers : []).map((x) => [x.id, x]));
    const stmts = results.map((r) => {
      const g = given.get(r.id);
      const marks = Number(g?.final_marks);
      if (!g || g.final_marks === '' || g.final_marks === null || !Number.isFinite(marks)) fail(400, `Q${r.seq}: enter final marks`);
      const min = r.kind === 'mcq' ? -Math.round((r.negative || 0) * r.max_marks * 100) / 100 : 0;
      if (marks < min || marks > r.max_marks) fail(400, `Q${r.seq}: marks must be between ${min} and ${r.max_marks}`);
      const remark = typeof g.remark === 'string' ? g.remark.trim().slice(0, 1000) : '';
      return env.DB.prepare('UPDATE answers SET final_marks = ?, faculty_remark = ? WHERE id = ?').bind(marks, remark, r.id);
    });
    stmts.push(env.DB.prepare(`UPDATE attempts SET status='published', published_at = COALESCE(published_at, ?) WHERE id = ?`).bind(now(), t.id));
    await env.DB.batch(stmts);
    await notify(env, inst, [t.student_id], `Result declared: ${t.type} ${t.number} · ${t.subject_code}`, `#/result/${t.id}`);
    await audit('result approved', `${t.type} ${t.number} ${t.subject_code}, roll no ${t.roll_no}`);
    return json({ ok: true });
  }

  // ----- evaluation sheets: theory (TES, internal marks) and lab (LES) for one subject in one section -----

  const r2 = (x) => Math.round(x * 100) / 100;
  const sheetAccess = async (subjectId, sectionId) => {
    staff();
    const [sb, sc] = await Promise.all([
      env.DB.prepare('SELECT id, code, name, type, semester, programme_id FROM subjects WHERE id = ? AND institute_id = ?').bind(+subjectId || 0, inst).first(),
      env.DB.prepare('SELECT s.id, s.name, s.semester, s.department_id, s.coordinator_id, s.programme, p.name AS programme_name FROM sections s LEFT JOIN programmes p ON p.id = s.programme_id WHERE s.id = ? AND s.institute_id = ?').bind(+sectionId || 0, inst).first(),
    ]);
    if (!sb || !sc) fail(404, 'Choose a subject and a section');
    const al = await env.DB.prepare('SELECT a.faculty_id, u.name FROM allotments a JOIN users u ON u.id = a.faculty_id WHERE a.subject_id = ? AND a.section_id = ?').bind(sb.id, sc.id).first();
    const edit = !!al && al.faculty_id === user.id;
    const view = edit || user.perms.manage || user.perms.reports === 'institute' || sc.coordinator_id === user.id
      || (user.role === 'hod' && user.department_id && user.department_id === sc.department_id);
    if (!view) fail(403, 'Only the subject\'s faculty, the class coordinator, the HOD and institute-level staff can open this sheet');
    const students = (await env.DB.prepare(`SELECT id, name, univ_roll, college_roll, roll_no FROM users WHERE section_id = ? AND role = 'student' AND status = 'active'
      ORDER BY COALESCE(college_roll, univ_roll, roll_no), name`).bind(sc.id).all()).results;
    const entries = new Map((await env.DB.prepare('SELECT student_id, manual_json, moderation FROM internal_entries WHERE subject_id = ? AND section_id = ?').bind(sb.id, sc.id).all())
      .results.map((e) => [e.student_id, { manual: JSON.parse(e.manual_json || '{}'), moderation: e.moderation }]));
    const st = await settingsRow();
    return { sb, sc, edit, faculty: al?.name || '', students, entries, st };
  };
  const sheetHead = (x) => ({ subject: { id: x.sb.id, code: x.sb.code, name: x.sb.name, type: x.sb.type }, section: { id: x.sc.id, name: x.sc.name, semester: x.sc.semester },
    programme: x.sc.programme_name || x.sc.programme || '', session: x.st.session, faculty: x.faculty, can_edit: x.edit });

  // Subjects and sections whose sheets this user may open.
  if (route('GET', /^\/api\/sheets$/)) {
    staff();
    const all = user.perms.manage || user.perms.reports === 'institute';
    const { results } = await env.DB.prepare(`SELECT a.subject_id, a.section_id, sb.code, sb.name AS subject, sb.type, sc.name AS section, f.name AS faculty, a.faculty_id = ? AS mine
      FROM allotments a JOIN subjects sb ON sb.id = a.subject_id JOIN sections sc ON sc.id = a.section_id JOIN users f ON f.id = a.faculty_id
      WHERE a.institute_id = ? AND (? OR a.faculty_id = ? OR sc.coordinator_id = ? OR (sc.department_id = ? AND ?)) ORDER BY mine DESC, sc.name, sb.code`)
      .bind(user.id, inst, all ? 1 : 0, user.id, user.id, user.department_id ?? 0, user.role === 'hod' ? 1 : 0).all();
    return json(results);
  }

  if (route('GET', /^\/api\/sheets\/theory$/)) {
    const x = await sheetAccess(url.searchParams.get('subject'), url.searchParams.get('section'));
    const scheme = x.st.internal;
    const parts = [];
    for (const p of scheme.parts) {
      if (p.source === 'manual') { parts.push({ ...p, items: [], max: p.weight }); continue; }
      const list = (await env.DB.prepare(`SELECT s.id, s.type, s.number, s.paper_json FROM assessments s JOIN assessment_sections q ON q.assessment_id = s.id
        WHERE s.institute_id = ? AND q.section_id = ? AND (s.subject_id = ? OR (s.subject_id IS NULL AND s.subject_code = ?)) AND s.type = ? ${p.number ? 'AND s.number = ?' : ''}
          AND s.status = 'published' ORDER BY s.number`).bind(inst, x.sc.id, x.sb.id, x.sb.code, p.source, ...(p.number ? [p.number] : [])).all()).results;
      const items = [];
      for (const a of list) {
        const P = paperOf(a);
        const rows = (await env.DB.prepare(`SELECT t.student_id, an.final_marks, q.part, q.qgroup, q.co FROM attempts t JOIN answers an ON an.attempt_id = t.id
          JOIN questions q ON q.id = an.question_id WHERE t.assessment_id = ? AND t.status = 'published'`).bind(a.id).all()).results;
        const byStudent = new Map();
        rows.forEach((r) => { if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []); byStudent.get(r.student_id).push(r); });
        const cos = [...new Set(rows.map((r) => r.co).filter(Boolean))].sort();
        const marks = {};
        for (const [sid, l] of byStudent) {
          const total = countBest(P.parts, l, 'final_marks');
          const co = {};
          l.filter((r) => r.counted && r.co).forEach((r) => (co[r.co] = r2((co[r.co] || 0) + (r.final_marks || 0))));
          marks[sid] = { total, co };
        }
        items.push({ id: a.id, title: `${a.type}-${a.number}`, max: P.max_marks || 0, cos: ['Sessional', 'Mid Term', 'Hybrid'].includes(a.type) ? cos : [], marks });
      }
      parts.push({ ...p, items, max: items.reduce((m, i) => m + i.max, 0) });
    }
    const total = scheme.parts.reduce((m, p) => m + p.weight, 0);
    const rnd = (v) => (scheme.round === 'up' ? Math.ceil(v - 1e-9) : scheme.round === 'none' ? r2(v) : Math.round(v));
    const students = x.students.map((u) => {
      const e = x.entries.get(u.id) || { manual: {}, moderation: 0 };
      const cells = parts.map((p) => {
        if (p.source === 'manual') {
          const v = e.manual[p.label];
          return { raw: v ?? null, scaled: v ?? null };
        }
        const got = p.items.map((i) => i.marks[u.id] || null);
        if (got.every((g) => !g)) return { items: got, raw: null, scaled: null };
        const raw = r2(got.reduce((m, g) => m + (g ? g.total : 0), 0));
        return { items: got, raw, scaled: p.max ? r2((Math.max(0, raw) / p.max) * p.weight) : null };
      });
      const actual = rnd(cells.reduce((m, c) => m + (c.scaled || 0), 0));
      const fin = Math.min(total, Math.max(0, r2(actual + (e.moderation || 0))));
      return { id: u.id, name: u.name, univ_roll: u.univ_roll, college_roll: u.college_roll || u.roll_no, cells, actual, moderation: e.moderation || 0, final: fin };
    });
    return json({ ...sheetHead(x), round: scheme.round, total, parts: parts.map((p) => ({ label: p.label, source: p.source, number: p.number, weight: p.weight, max: p.max,
      items: p.items.map(({ marks, ...i }) => i) })), students });
  }

  // Hand-entered columns (attendance and other manual components) and moderation, by the subject's faculty.
  if (route('PUT', /^\/api\/sheets\/entries$/)) {
    const b = await body(request);
    const x = await sheetAccess(b.subject, b.section);
    if (!x.edit) fail(403, 'Only the faculty allotted to this subject and section can change the sheet');
    const manualParts = x.st.internal.parts.filter((p) => p.source === 'manual');
    const ids = new Set(x.students.map((u) => u.id));
    const rows = (Array.isArray(b.rows) ? b.rows : []).filter((r) => ids.has(+r.student_id));
    const stmts = rows.map((r) => {
      const prev = x.entries.get(+r.student_id) || { manual: {}, moderation: 0 };
      const manual = { ...prev.manual };
      if (r.manual && typeof r.manual === 'object') {
        for (const p of manualParts) {
          if (!(p.label in r.manual)) continue;
          const v = r.manual[p.label];
          if (v === '' || v === null) { delete manual[p.label]; continue; }
          if (!(Number(v) >= 0 && Number(v) <= p.weight)) fail(400, `${p.label} must be 0 to ${p.weight}`);
          manual[p.label] = Number(v);
        }
      }
      const mod = r.moderation === undefined ? prev.moderation : Number(r.moderation) || 0;
      if (Math.abs(mod) > 100) fail(400, 'Moderation is too large');
      return env.DB.prepare(`INSERT INTO internal_entries (institute_id, subject_id, section_id, student_id, manual_json, moderation, updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (subject_id, section_id, student_id) DO UPDATE SET manual_json = excluded.manual_json, moderation = excluded.moderation, updated_at = excluded.updated_at`)
        .bind(inst, x.sb.id, x.sc.id, +r.student_id, JSON.stringify(manual), mod, now());
    });
    if (stmts.length) await env.DB.batch(stmts);
    await audit('evaluation sheet updated', `${x.sb.code} ${x.sc.name}: ${stmts.length} row(s)`);
    return json({ ok: true });
  }

  // ----- lab evaluation sheet -----
  if (route('GET', /^\/api\/sheets\/lab$/)) {
    const x = await sheetAccess(url.searchParams.get('subject'), url.searchParams.get('section'));
    const lab = x.st.lab;
    const exps = (await env.DB.prepare('SELECT id, no, title, held_on FROM lab_experiments WHERE subject_id = ? AND section_id = ? ORDER BY no').bind(x.sb.id, x.sc.id).all()).results;
    const marks = exps.length ? (await env.DB.prepare(`SELECT experiment_id, student_id, marks_json FROM lab_marks WHERE experiment_id IN (${exps.map(() => '?').join(',')})`).bind(...exps.map((e) => e.id)).all()).results : [];
    const expMax = lab.criteria.reduce((m, c) => m + c.max, 0);
    const students = x.students.map((u) => {
      const mine = {};
      marks.filter((m) => m.student_id === u.id).forEach((m) => (mine[m.experiment_id] = JSON.parse(m.marks_json)));
      const totals = exps.map((e) => (mine[e.id] ? r2(lab.criteria.reduce((s2, c) => s2 + (Number(mine[e.id][c.code]) || 0), 0)) : null));
      const avg = exps.length ? r2(totals.reduce((s2, t) => s2 + (t || 0), 0) / exps.length) : null; // an experiment missed counts as 0
      const scaled = avg === null ? null : Math.round((avg / expMax) * lab.final * 100) / 100;
      const e = x.entries.get(u.id) || { moderation: 0 };
      const fin = scaled === null ? null : Math.min(lab.final, Math.max(0, Math.round(scaled + (e.moderation || 0))));
      return { id: u.id, name: u.name, univ_roll: u.univ_roll, college_roll: u.college_roll || u.roll_no, marks: mine, totals, avg, scaled, moderation: e.moderation || 0, final: fin };
    });
    return json({ ...sheetHead(x), lab, exp_max: expMax, experiments: exps, students });
  }
  if (route('POST', /^\/api\/sheets\/lab\/experiments$/)) {
    const b = await body(request);
    const x = await sheetAccess(b.subject, b.section);
    if (!x.edit) fail(403, 'Only the faculty allotted to this lab can add experiments');
    const used = (await env.DB.prepare('SELECT no FROM lab_experiments WHERE subject_id = ? AND section_id = ?').bind(x.sb.id, x.sc.id).all()).results.map((e) => e.no);
    if (used.length >= x.st.lab.experiments) fail(400, `At most ${x.st.lab.experiments} experiments`);
    const no = Math.max(0, ...used) + 1;
    const held = typeof b.held_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.held_on) ? b.held_on : null;
    await env.DB.prepare('INSERT INTO lab_experiments (institute_id, subject_id, section_id, no, title, held_on) VALUES (?,?,?,?,?,?)')
      .bind(inst, x.sb.id, x.sc.id, no, String(b.title || '').trim().slice(0, 150), held).run();
    return json({ ok: true, no });
  }
  if ((m = route('PUT', /^\/api\/sheets\/lab\/experiments\/(\d+)$/)) || (m = route('DELETE', /^\/api\/sheets\/lab\/experiments\/(\d+)$/))) {
    const e = await env.DB.prepare('SELECT * FROM lab_experiments WHERE id = ? AND institute_id = ?').bind(+m[1], inst).first();
    if (!e) fail(404, 'Experiment not found');
    const x = await sheetAccess(e.subject_id, e.section_id);
    if (!x.edit) fail(403, 'Only the faculty allotted to this lab can change experiments');
    if (request.method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM lab_marks WHERE experiment_id = ?').bind(e.id), env.DB.prepare('DELETE FROM lab_experiments WHERE id = ?').bind(e.id)]);
      return json({ ok: true });
    }
    const b = await body(request);
    const held = typeof b.held_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.held_on) ? b.held_on : null;
    await env.DB.prepare('UPDATE lab_experiments SET title = ?, held_on = ? WHERE id = ?').bind(String(b.title || '').trim().slice(0, 150), held, e.id).run();
    return json({ ok: true });
  }
  if (route('PUT', /^\/api\/sheets\/lab\/marks$/)) {
    const b = await body(request);
    const e = await env.DB.prepare('SELECT * FROM lab_experiments WHERE id = ? AND institute_id = ?').bind(+b.experiment_id || 0, inst).first();
    if (!e) fail(404, 'Experiment not found');
    const x = await sheetAccess(e.subject_id, e.section_id);
    if (!x.edit) fail(403, 'Only the faculty allotted to this lab can enter marks');
    const ids = new Set(x.students.map((u) => u.id));
    const crit = x.st.lab.criteria;
    const stmts = [];
    for (const r of Array.isArray(b.rows) ? b.rows : []) {
      if (!ids.has(+r.student_id)) continue;
      const mk = {};
      let any = false;
      for (const c of crit) {
        const v = r.marks?.[c.code];
        if (v === '' || v === null || v === undefined) continue;
        if (!(Number(v) >= 0 && Number(v) <= c.max)) fail(400, `${c.code} must be 0 to ${c.max}`);
        mk[c.code] = Number(v); any = true;
      }
      stmts.push(any
        ? env.DB.prepare(`INSERT INTO lab_marks (experiment_id, student_id, marks_json) VALUES (?,?,?) ON CONFLICT (experiment_id, student_id) DO UPDATE SET marks_json = excluded.marks_json`).bind(e.id, +r.student_id, JSON.stringify(mk))
        : env.DB.prepare('DELETE FROM lab_marks WHERE experiment_id = ? AND student_id = ?').bind(e.id, +r.student_id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  // ----- start code for the faculty's screen -----
  if ((m = route('GET', /^\/api\/assessments\/(\d+)\/start-code$/))) {
    const a = await readAssessment(+m[1]);
    if (a.status !== 'published' || NO_START_CODE.includes(a.type)) return json({ code: null });
    const st = await settingsRow();
    const ms = st.code_minutes * 60e3;
    const w = Math.floor(Date.now() / ms);
    if (!a.code_seed) {
      a.code_seed = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare('UPDATE assessments SET code_seed = ? WHERE id = ? AND code_seed IS NULL').bind(a.code_seed, a.id).run();
    }
    return json({ code: await startCode(a.code_seed, w), changes_at: new Date((w + 1) * ms).toISOString(), minutes: st.code_minutes });
  }

  // ----- notifications -----
  if (route('GET', /^\/api\/notifications$/)) {
    const { results } = await env.DB.prepare('SELECT id, text, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').bind(user.id).all();
    return json({ unread: results.filter((x) => !x.read_at).length, items: results });
  }
  if (route('POST', /^\/api\/notifications\/read$/)) {
    await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(now(), user.id).run();
    return json({ ok: true });
  }

  // ----- re-check claims: the faculty answers, and may change the marks -----
  if ((m = route('POST', /^\/api\/rechecks\/(\d+)$/))) {
    can('approve');
    const r = await env.DB.prepare(`SELECT r.*, a.attempt_id AS att, q.max_marks, q.kind, s.negative, a.final_marks, t.student_id, t.assessment_id
      FROM rechecks r JOIN answers a ON a.id = r.answer_id JOIN questions q ON q.id = a.question_id JOIN attempts t ON t.id = r.attempt_id JOIN assessments s ON s.id = t.assessment_id
      WHERE r.id = ? AND r.institute_id = ?`).bind(+m[1], inst).first();
    if (!r) fail(404, 'Request not found');
    await staffAttempt(r.attempt_id); // the faculty must be able to see this attempt
    if (r.status !== 'open') fail(409, 'This request is already answered');
    const b = await body(request);
    const status = b.status === 'accepted' ? 'accepted' : b.status === 'rejected' ? 'rejected' : fail(400, 'Accept or reject the request');
    const response = str(b.response, 'Reply to the student', 1000);
    let newMarks = null;
    if (status === 'accepted') {
      newMarks = Number(b.marks);
      const min = r.kind === 'mcq' ? -Math.round((r.negative || 0) * r.max_marks * 100) / 100 : 0;
      if (!Number.isFinite(newMarks) || newMarks < min || newMarks > r.max_marks) fail(400, `Marks must be between ${min} and ${r.max_marks}`);
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE rechecks SET status = ?, response = ?, old_marks = ?, new_marks = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
        .bind(status, response, r.final_marks, newMarks, now(), user.name, r.id),
      ...(newMarks !== null ? [env.DB.prepare('UPDATE answers SET final_marks = ? WHERE id = ?').bind(newMarks, r.answer_id)] : []),
    ]);
    await notify(env, inst, [r.student_id], `Re-check answered${newMarks !== null ? `: marks changed to ${newMarks}` : ''}`, `#/result/${r.attempt_id}`);
    await audit('re-check answered', `attempt ${r.attempt_id}: ${status}${newMarks !== null ? ` ${r.final_marks} → ${newMarks}` : ''}`);
    return json({ ok: true });
  }
  if (route('GET', /^\/api\/rechecks$/)) {
    staff();
    const sc = scope();
    const { results } = await env.DB.prepare(`SELECT r.id, r.attempt_id, r.reason, r.created_at, q.seq, q.label, u.name AS student, s.type, s.number, s.subject_code
      FROM rechecks r JOIN attempts t ON t.id = r.attempt_id JOIN assessments s ON s.id = t.assessment_id JOIN answers a ON a.id = r.answer_id
      JOIN questions q ON q.id = a.question_id JOIN users u ON u.id = t.student_id
      WHERE r.status = 'open' AND ${sc.sql} ORDER BY r.id`).bind(...sc.binds).all();
    return json(results);
  }

  // ----- reports: A53 rank sheet (section-wise by default), and the institute overview -----
  if (route('GET', /^\/api\/reports\/rank-sheet$/)) {
    staff();
    const sec = await env.DB.prepare('SELECT s.*, p.name AS programme_name FROM sections s LEFT JOIN programmes p ON p.id = s.programme_id WHERE s.id = ? AND s.institute_id = ?')
      .bind(Number(url.searchParams.get('section')) || 0, inst).first();
    if (!sec) fail(404, 'Choose a section');
    const allowed = user.perms.reports === 'institute' || user.perms.manage || sec.coordinator_id === user.id
      || (user.role === 'hod' && user.department_id && user.department_id === sec.department_id);
    if (!allowed) fail(403, 'Rank sheets are for the HOD, the class coordinator and institute-level staff');
    const type = String(url.searchParams.get('type') || 'Sessional');
    const number = Number(url.searchParams.get('number')) || 0; // 0 = all of that type together
    const branch = url.searchParams.get('scope') === 'branch';
    const st = await settingsRow();
    // Sections ranked together: just this one, or every section of the same programme and semester (branch-wise).
    const secIds = branch
      ? (await env.DB.prepare('SELECT id FROM sections WHERE institute_id = ? AND programme_id IS ? AND semester IS ?').bind(inst, sec.programme_id, sec.semester).all()).results.map((x) => x.id)
      : [sec.id];
    const ph = secIds.map(() => '?').join(',');
    const assess = (await env.DB.prepare(`SELECT DISTINCT s.id, s.subject_code, s.subject_name, s.number, s.paper_json, f.name AS faculty
      FROM assessments s JOIN assessment_sections x ON x.assessment_id = s.id JOIN users f ON f.id = s.faculty_id
      WHERE s.institute_id = ? AND s.type = ? ${number ? 'AND s.number = ?' : ''} AND x.section_id IN (${ph}) AND s.status = 'published' ORDER BY s.subject_code, s.number`)
      .bind(inst, type, ...(number ? [number] : []), ...secIds).all()).results;
    const studs = (await env.DB.prepare(`SELECT u.id, u.name, u.univ_roll, u.college_roll, u.roll_no, s.name AS section FROM users u JOIN sections s ON s.id = u.section_id
      WHERE u.section_id IN (${ph}) AND u.role = 'student' AND u.status = 'active' ORDER BY s.name, COALESCE(u.college_roll, u.univ_roll, u.roll_no), u.name`).bind(...secIds).all()).results;
    const subjects = new Map();
    for (const a of assess) {
      const key = a.subject_code;
      if (!subjects.has(key)) subjects.set(key, { code: key, name: a.subject_name, faculty: a.faculty, max: 0, ids: [] });
      const sj = subjects.get(key);
      sj.ids.push(a.id);
      sj.max += paperOf(a).max_marks || 0;
    }
    const marks = new Map(); // student → code → total
    for (const a of assess) {
      const P = paperOf(a);
      const rows = (await env.DB.prepare(`SELECT t.student_id, an.final_marks, q.part, q.qgroup FROM attempts t JOIN answers an ON an.attempt_id = t.id
        JOIN questions q ON q.id = an.question_id WHERE t.assessment_id = ? AND t.status = 'published'`).bind(a.id).all()).results;
      const by = new Map();
      rows.forEach((r) => { if (!by.has(r.student_id)) by.set(r.student_id, []); by.get(r.student_id).push(r); });
      for (const [sid, list] of by) {
        if (!marks.has(sid)) marks.set(sid, {});
        const cur = marks.get(sid);
        cur[a.subject_code] = (cur[a.subject_code] || 0) + countBest(P.parts, list, 'final_marks');
      }
    }
    const maxTotal = [...subjects.values()].reduce((x, y) => x + y.max, 0);
    const out = studs.map((u) => {
      const mk = marks.get(u.id) || {};
      const total = Math.round(Object.values(mk).reduce((x, y) => x + y, 0) * 100) / 100;
      const pass = [...subjects.values()].every((sj) => sj.max === 0 || ((mk[sj.code] ?? 0) / sj.max) * 100 >= st.pass_percent);
      return { univ_roll: u.univ_roll, college_roll: u.college_roll || u.roll_no, name: u.name, section: u.section, marks: mk, total,
        pct: maxTotal ? Math.round((total / maxTotal) * 10000) / 100 : 0, pass, absent: !marks.has(u.id) };
    });
    // Ties share a rank: 1, 1, 3.
    const sorted = out.filter((x) => !x.absent).map((x) => x.total).sort((p, q) => q - p);
    out.forEach((x) => (x.rank = x.absent ? null : 1 + sorted.filter((t) => t > x.total).length));
    return json({ section: sec.name, programme: sec.programme_name || sec.programme, semester: sec.semester, scope: branch ? 'branch' : 'section',
      type, number, pass_percent: st.pass_percent, session: st.session,
      subjects: [...subjects.values()].map(({ ids, ...x }) => x), max_total: maxTotal, students: out });
  }

  if (route('GET', /^\/api\/reports\/overview$/)) {
    if (!(user.perms.reports === 'institute' || user.perms.manage)) fail(403, 'Institute-level staff only');
    const { results } = await env.DB.prepare(`SELECT d.id, d.name,
        (SELECT COUNT(*) FROM users WHERE department_id = d.id AND role != 'student') AS faculty,
        (SELECT COUNT(*) FROM assessments WHERE department_id = d.id) AS papers,
        (SELECT COUNT(*) FROM assessments WHERE department_id = d.id AND stage IN ('review','changes')) AS in_moderation,
        (SELECT COUNT(*) FROM assessments WHERE department_id = d.id AND status = 'published') AS published,
        (SELECT COUNT(*) FROM attempts t JOIN assessments s ON s.id = t.assessment_id WHERE s.department_id = d.id AND t.status = 'evaluated') AS awaiting_approval,
        (SELECT COUNT(*) FROM attempts t JOIN assessments s ON s.id = t.assessment_id WHERE s.department_id = d.id AND t.status = 'published') AS results
      FROM departments d WHERE d.institute_id = ? ORDER BY d.name`).bind(inst).all();
    return json(results);
  }

  // Sections the user may pull a rank sheet for.
  if (route('GET', /^\/api\/reports\/sections$/)) {
    staff();
    const all = user.perms.reports === 'institute' || user.perms.manage;
    const { results } = await env.DB.prepare(`SELECT id, name FROM sections WHERE institute_id = ? AND (? OR coordinator_id = ? OR (department_id = ? AND ?)) ORDER BY name`)
      .bind(inst, all ? 1 : 0, user.id, user.department_id ?? 0, user.role === 'hod' ? 1 : 0).all();
    return json(results);
  }

  // ----- student -----

  if (route('GET', /^\/api\/my\/assessments$/)) {
    student();
    ctx.waitUntil(closeOverdueAttempts(env).catch((e) => console.error(e)));
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.subject_name, s.subject_code, s.type, s.number, s.duration_min, s.start_at, s.end_at, s.paper_json,
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
    return json(results.map((r) => ({ ...r, total_marks: paperMax(r, r.total_marks), paper_json: undefined })));
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
    // Lab tests open only with the start code the faculty reads out (checked again when resuming on another computer).
    if (!NO_START_CODE.includes(a.type)) {
      const b = await request.json().catch(() => ({}));
      const given = String(b.code || '').trim().toUpperCase();
      if (!given) fail(428, 'Enter the start code your faculty gives in the lab');
      const st = await settingsRow();
      const w = Math.floor(Date.now() / (st.code_minutes * 60e3));
      const seed = a.code_seed || '';
      if (!seed || (given !== await startCode(seed, w) && given !== await startCode(seed, w - 1))) fail(403, 'Wrong or expired start code. Ask your faculty for the current code.');
    }
    let t = await env.DB.prepare('SELECT * FROM attempts WHERE assessment_id = ? AND student_id = ?').bind(a.id, user.id).first();
    const qs = await env.DB.prepare('SELECT id, seq, text, max_marks, kind, options_json, part, label, qgroup FROM questions WHERE assessment_id = ? ORDER BY seq').bind(a.id).all();
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
    // Same order every time this student reopens the attempt; a different order for each student.
    const rank = (x, y) => {
      let h = (t.id * 2654435761 + x * 40503 + y * 97) >>> 0;
      h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
      return h >>> 0;
    };
    if (a.shuffle) {
      // Parts stay in order and sub-parts stay together; whole questions are shuffled within each part.
      const first = new Map();
      qs.results.forEach((q) => { if (!first.has(q.part)) first.set(q.part, q.seq); });
      const key = (q) => [first.get(q.part), q.qgroup ? rank(q.qgroup, 0) : rank(q.id, 0), q.seq];
      qs.results.sort((x, y) => { const p = key(x), r = key(y); return p[0] - r[0] || p[1] - r[1] || p[2] - r[2]; });
    }
    const saved = await env.DB.prepare('SELECT question_id, text FROM answers WHERE attempt_id = ?').bind(t.id).all();
    const text = new Map(saved.results.map((r) => [r.question_id, r.text]));
    return json({
      attempt_id: t.id,
      deadline_at: t.deadline_at,
      server_now: now(),
      assessment: { subject_name: a.subject_name, subject_code: a.subject_code, type: a.type, number: a.number, negative: a.negative,
        parts: (paperOf(a).parts || []).filter((p) => p.attempt < p.questions).map((p) => ({ name: p.name, attempt: p.attempt, questions: p.questions })) },
      questions: qs.results.map((q) => ({
        id: q.id, seq: q.seq, text: q.text, max_marks: q.max_marks, kind: q.kind, part: q.part, label: q.label,
        options: q.options_json ? JSON.parse(q.options_json) : null,
        // Shuffled display order of the options; answers are still stored as the original option index.
        order: q.options_json && a.option_shuffle
          ? JSON.parse(q.options_json).map((_, i) => i).sort((x, y) => rank(q.id, x + 1) - rank(q.id, y + 1))
          : null,
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
  if ((m = route('POST', /^\/api\/attempts\/(\d+)\/recheck$/))) {
    student();
    const t = await ownAttemptAsStudent(+m[1]);
    if (t.status !== 'published') fail(409, 'The result is not declared yet');
    if (Date.now() - Date.parse(t.published_at || t.submitted_at || 0) > 7 * 86400e3) fail(409, 'Re-check requests close 7 days after the result');
    const b = await body(request);
    const an = await env.DB.prepare('SELECT a.id FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? AND q.seq = ?').bind(t.id, Number(b.seq) || 0).first();
    if (!an) fail(404, 'Question not found');
    const open = await env.DB.prepare(`SELECT 1 FROM rechecks WHERE answer_id = ? AND status = 'open'`).bind(an.id).first();
    if (open) fail(409, 'You have already asked for a re-check of this question');
    await env.DB.prepare('INSERT INTO rechecks (institute_id, attempt_id, answer_id, reason, created_at) VALUES (?,?,?,?,?)')
      .bind(inst, t.id, an.id, str(b.reason, 'Reason', 600), now()).run();
    const s2 = await env.DB.prepare('SELECT faculty_id, type, number, subject_code FROM assessments WHERE id = ?').bind(t.assessment_id).first();
    await notify(env, inst, [s2.faculty_id], `Re-check request: ${user.name}, ${s2.type} ${s2.number} · ${s2.subject_code}`, `#/review/${t.id}`);
    return json({ ok: true });
  }

  if ((m = route('GET', /^\/api\/attempts\/(\d+)\/result$/))) {
    student();
    const t = await ownAttemptAsStudent(+m[1]);
    if (t.status !== 'published') return json({ published: false, status: t.status });
    const a = await env.DB.prepare('SELECT id, subject_name, subject_code, type, number, paper_json, subject_id FROM assessments WHERE id = ?').bind(t.assessment_id).first();
    const pa = paperOf(a);
    delete a.paper_json;
    const { results } = await env.DB.prepare(
      `SELECT a.id AS answer_id, q.seq, q.part, q.label, q.qgroup, q.text AS qtext, q.max_marks, q.kind, q.options_json, q.correct_index, q.co, q.model_answer,
              a.text, a.final_marks, a.llm_marks, a.llm_json, a.faculty_remark
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? ORDER BY q.seq`,
    )
      .bind(t.id)
      .all();
    const total = countBest(pa.parts, results, 'final_marks');
    const max = pa.max_marks || results.reduce((s2, r) => s2 + r.max_marks, 0);
    // Rank, once every result of the student's section (or the whole branch, by the institute's setting) is approved. Ties share a rank.
    const st = await settingsRow();
    const all = (await env.DB.prepare(`SELECT t.id, t.status, u.section_id FROM attempts t JOIN users u ON u.id = t.student_id WHERE t.assessment_id = ?`).bind(t.assessment_id).all()).results;
    const peers = st.rank_scope === 'branch' ? all : all.filter((x) => x.section_id === user.section_id);
    let rank = null;
    if (peers.length && peers.every((x) => x.status === 'published')) {
      const marks = (await env.DB.prepare(`SELECT an.attempt_id, an.final_marks, q.part, q.qgroup FROM answers an JOIN questions q ON q.id = an.question_id
        JOIN attempts t ON t.id = an.attempt_id WHERE t.assessment_id = ?`).bind(t.assessment_id).all()).results;
      const totals = peers.map((p) => countBest(pa.parts, marks.filter((r) => r.attempt_id === p.id).map((r) => ({ ...r })), 'final_marks'));
      rank = { rank: 1 + totals.filter((x) => x > total).length, of: peers.length, scope: st.rank_scope };
    }
    // CO-wise performance on the questions that count, and a preparedness score (0-100).
    const counted = results.filter((r) => r.counted);
    const cosRow = a.subject_id ? await env.DB.prepare('SELECT cos_json FROM subjects WHERE id = ?').bind(a.subject_id).first() : null;
    const coText = new Map(JSON.parse(cosRow?.cos_json || '[]').map((c) => [c.co, c.text]));
    const coMap = new Map();
    for (const r of counted.filter((x) => x.co)) {
      const c = coMap.get(r.co) || { co: r.co, got: 0, max: 0 };
      c.got += Math.max(0, r.final_marks ?? 0); c.max += r.max_marks;
      coMap.set(r.co, c);
    }
    const cos = [...coMap.values()].sort((x, y) => x.co.localeCompare(y.co)).map((c) => {
      const pct = c.max ? Math.round((c.got / c.max) * 100) : 0;
      return { co: c.co, text: coText.get(c.co) || '', pct, band: pct >= 70 ? 'Strong' : pct >= 40 ? 'Developing' : 'Needs work' };
    });
    const pctAll = max ? Math.max(0, (total / max) * 100) : 0;
    const coAvg = cos.length ? cos.reduce((x, c) => x + c.pct, 0) / cos.length : pctAll;
    const tried = counted.length ? counted.filter((r) => String(r.text || '').trim()).length / counted.length : 0;
    const preparedness = Math.round(0.6 * pctAll + 0.3 * coAvg + 0.1 * tried * 100);
    const rc = (await env.DB.prepare('SELECT answer_id, reason, status, response, old_marks, new_marks, created_at, resolved_at FROM rechecks WHERE attempt_id = ? ORDER BY id').bind(t.id).all()).results;
    const since = Date.parse(t.published_at || t.submitted_at || 0);
    const recheckOpen = Date.now() - since < 7 * 86400e3;
    return json({
      published: true,
      assessment: a,
      total,
      rank, cos, preparedness, recheck_open: recheckOpen,
      recheck_until: new Date(since + 7 * 86400e3).toISOString(),
      max: pa.max_marks || results.reduce((s, r) => s + r.max_marks, 0),
      answers: results.map((r) => {
        const llm = r.llm_json ? JSON.parse(r.llm_json) : null;
        // If the faculty changed the marks, the model's criterion-wise split no longer adds up, so it is not shown.
        const moderated = r.llm_marks === null || Math.abs(r.final_marks - r.llm_marks) > 1e-9;
        return {
          seq: r.seq,
          part: r.part,
          label: r.label,
          counted: r.counted,
          co: r.co,
          model_answer: r.kind === 'mcq' ? '' : r.model_answer,
          rechecks: rc.filter((x) => x.answer_id === r.answer_id),
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
