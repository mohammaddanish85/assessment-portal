import { SCHEMA, migrate } from './schema.js';
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
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  await migrate(env.DB);
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

async function currentUser(request, env) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  return env.DB.prepare(
    `SELECT u.id, u.role, u.name, u.username, u.roll_no FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(m[1], now())
    .first();
}

async function createUser(env, { role, name, username, password, roll_no = null }) {
  if (password.length < 6) fail(400, `Password for ${username} must be at least 6 characters`);
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare(
      'INSERT INTO users (role, name, username, roll_no, pw_hash, pw_salt, created_at) VALUES (?,?,?,?,?,?,?)',
    )
      .bind(role, name, username.toLowerCase(), roll_no, hash, salt, now())
      .run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) fail(409, `Username "${username}" already exists`);
    throw e;
  }
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
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='faculty'`).first();
    return json({ needsSetup: c.n === 0, provider: env.EVAL_PROVIDER || 'workers-ai' });
  }

  // First run only: create the faculty account. Disabled once a faculty exists.
  if (route('POST', /^\/api\/setup$/)) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='faculty'`).first();
    if (c.n > 0) fail(403, 'Setup is already complete');
    const b = await body(request);
    await createUser(env, {
      role: 'faculty',
      name: str(b.name, 'Name', 100),
      username: str(b.username, 'Username', 50),
      password: str(b.password, 'Password', 100),
    });
    return json({ ok: true });
  }

  if (route('POST', /^\/api\/login$/)) {
    const b = await body(request);
    const username = str(b.username, 'Username', 50).toLowerCase();
    const password = str(b.password, 'Password', 100);
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    const ok = u && safeEqual((await hashPassword(password, u.pw_salt)).hash, u.pw_hash);
    if (!ok) fail(401, 'Wrong username or password');
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
      env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').bind(token, u.id, expires),
    ]);
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json(
      { id: u.id, role: u.role, name: u.name, username: u.username, roll_no: u.roll_no },
      200,
      { 'set-cookie': `sid=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}` },
    );
  }

  if (route('POST', /^\/api\/logout$/)) {
    const mm = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
    if (mm) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(mm[1]).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  const user = await currentUser(request, env);
  if (!user) fail(401, 'Please log in');
  if (route('GET', /^\/api\/me$/)) return json(user);

  const faculty = () => user.role === 'faculty' || fail(403, 'Faculty only');
  const student = () => user.role === 'student' || fail(403, 'Students only');

  const ownAssessment = async (id) => {
    const a = await env.DB.prepare('SELECT * FROM assessments WHERE id = ? AND faculty_id = ?').bind(id, user.id).first();
    return a || fail(404, 'Assessment not found');
  };
  const ownAttemptAsFaculty = async (id) => {
    const t = await env.DB.prepare(
      `SELECT t.*, s.release_mode, s.subject_name, s.subject_code, s.type, s.number, u.name AS student_name, u.roll_no
       FROM attempts t JOIN assessments s ON s.id = t.assessment_id JOIN users u ON u.id = t.student_id
       WHERE t.id = ? AND s.faculty_id = ?`,
    )
      .bind(id, user.id)
      .first();
    return t || fail(404, 'Attempt not found');
  };
  const ownAttemptAsStudent = async (id) => {
    const t = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND student_id = ?').bind(id, user.id).first();
    return t || fail(404, 'Attempt not found');
  };

  // ----- faculty: students -----

  if (route('GET', /^\/api\/students$/)) {
    faculty();
    const { results } = await env.DB.prepare(
      `SELECT id, name, username, roll_no FROM users WHERE role='student' ORDER BY roll_no, name`,
    ).all();
    return json(results);
  }

  if (route('POST', /^\/api\/students$/)) {
    faculty();
    const b = await body(request);
    if (!Array.isArray(b.students) || !b.students.length) fail(400, 'No students given');
    if (b.students.length > 200) fail(400, 'Add at most 200 students at a time');
    for (const s of b.students) {
      await createUser(env, {
        role: 'student',
        roll_no: str(s.roll_no, 'Roll no', 30),
        name: str(s.name, 'Name', 100),
        username: str(s.username, 'Username', 50),
        password: str(s.password, 'Password', 100),
      });
    }
    return json({ added: b.students.length });
  }

  // ----- faculty: assessments -----

  if (route('GET', /^\/api\/assessments$/)) {
    faculty();
    const { results } = await env.DB.prepare(
      `SELECT s.*,
        (SELECT COALESCE(SUM(max_marks),0) FROM questions WHERE assessment_id = s.id) AS total_marks,
        (SELECT COUNT(*) FROM attempts WHERE assessment_id = s.id AND status != 'in_progress') AS submitted,
        (SELECT COUNT(*) FROM attempts WHERE assessment_id = s.id AND status = 'published') AS published
       FROM assessments s WHERE s.faculty_id = ? ORDER BY s.id DESC`,
    )
      .bind(user.id)
      .all();
    return json(results);
  }

  if (route('POST', /^\/api\/assessments$/)) {
    faculty();
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
      `INSERT INTO assessments (faculty_id, subject_name, subject_code, type, number, duration_min, start_at, end_at, release_mode, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(user.id, str(b.subject_name, 'Subject name', 150), str(b.subject_code, 'Subject code', 30), type, number, duration,
        start.toISOString(), end.toISOString(), release, now())
      .run();
    const id = ins.meta.last_row_id;
    await env.DB.batch(
      questions.map((q, i) =>
        env.DB.prepare(
          `INSERT INTO questions (assessment_id, seq, text, max_marks, co, model_answer, rubric_json, kind, options_json, correct_index)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).bind(id, i + 1, q.text, q.max, q.co, q.model, JSON.stringify(q.rubric), q.kind,
          q.options ? JSON.stringify(q.options) : null, q.correct),
      ),
    );
    return json({ id });
  }

  if ((m = route('GET', /^\/api\/assessments\/(\d+)$/))) {
    faculty();
    const a = await ownAssessment(+m[1]);
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
    return json({
      ...a,
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

  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/publish$/))) {
    faculty();
    const a = await ownAssessment(+m[1]);
    await env.DB.prepare(`UPDATE assessments SET status='published' WHERE id = ?`).bind(a.id).run();
    return json({ ok: true });
  }

  // ----- faculty: review -----

  if ((m = route('GET', /^\/api\/attempts\/(\d+)$/))) {
    faculty();
    const t = await ownAttemptAsFaculty(+m[1]);
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.text, a.eval_status, a.eval_error, a.llm_marks, a.llm_json, a.llm_confidence, a.final_marks, a.faculty_remark,
              q.seq, q.text AS qtext, q.max_marks, q.co, q.model_answer, q.kind, q.options_json, q.correct_index
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ? ORDER BY q.seq`,
    )
      .bind(t.id)
      .all();
    return json({
      ...t,
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
    faculty();
    const t = await ownAttemptAsFaculty(+m[1]);
    if (t.status === 'in_progress') fail(409, 'The student has not submitted yet');
    await evaluateAttempt(env, t.id);
    return json({ ok: true });
  }

  if ((m = route('POST', /^\/api\/attempts\/(\d+)\/approve$/))) {
    faculty();
    const t = await ownAttemptAsFaculty(+m[1]);
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
    return json({ ok: true });
  }

  // ----- student -----

  if (route('GET', /^\/api\/my\/assessments$/)) {
    student();
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.subject_name, s.subject_code, s.type, s.number, s.duration_min, s.start_at, s.end_at,
        (SELECT COALESCE(SUM(max_marks),0) FROM questions WHERE assessment_id = s.id) AS total_marks,
        (SELECT COUNT(*) FROM questions WHERE assessment_id = s.id) AS question_count,
        t.id AS attempt_id, t.status AS attempt_status
       FROM assessments s LEFT JOIN attempts t ON t.assessment_id = s.id AND t.student_id = ?
       WHERE s.status = 'published' ORDER BY s.start_at DESC`,
    )
      .bind(user.id)
      .all();
    return json(results);
  }

  // Start (or resume) an attempt. Model answers, rubrics and MCQ answer keys are never sent to the student here.
  if ((m = route('POST', /^\/api\/assessments\/(\d+)\/start$/))) {
    student();
    const a = await env.DB.prepare(`SELECT * FROM assessments WHERE id = ? AND status='published'`).bind(+m[1]).first();
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
