'use strict';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let user = null;
let provider = '';
let cleanup = null; // set by the attempt screen (timer, listeners)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const num = (n) => (n === null || n === undefined ? '–' : String(+(+n).toFixed(2)));
const title = (a) => `${esc(a.type)} ${esc(a.number)} · ${esc(a.subject_name)} (${esc(a.subject_code)})`;

function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3500);
}

async function api(method, path, data) {
  const res = await fetch('/api' + path, {
    method,
    headers: data ? { 'content-type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

// Wraps a handler: shows errors as a toast and disables the button while it runs.
const act = (fn) => async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.currentTarget;
  if (btn.tagName === 'BUTTON') btn.disabled = true;
  try {
    await fn(e);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn.tagName === 'BUTTON') btn.disabled = false;
  }
};

function drawNav() {
  if (!user) return (nav.innerHTML = '');
  const links = user.role === 'faculty'
    ? '<a href="#/">Assessments</a><a href="#/new">New assessment</a><a href="#/students">Students</a>'
    : '<a href="#/">My assessments</a>';
  nav.innerHTML = `${links}<span class="muted small">${esc(user.name)}</span><button class="ghost small" id="logout">Log out</button>`;
  document.getElementById('logout').onclick = act(async () => {
    await api('POST', '/logout');
    user = null;
    location.hash = '#/';
    route();
  });
}

// ---------- auth ----------

function viewSetup() {
  app.innerHTML = `<div class="card narrow"><h1>First-time setup</h1>
    <p class="muted">Create the faculty account. This screen appears only once.</p>
    <form id="f"><label>Full name<input name="name" required></label>
    <label>Username<input name="username" required autocomplete="username"></label>
    <label>Password (min 6 characters)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    <button>Create faculty account</button></form></div>`;
  document.getElementById('f').onsubmit = act(async (e) => {
    await api('POST', '/setup', Object.fromEntries(new FormData(e.target)));
    toast('Account created. Please log in.');
    route();
  });
}

function viewLogin() {
  app.innerHTML = `<div class="card narrow"><h1>Log in</h1>
    <form id="f"><label>Username<input name="username" required autocomplete="username"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button>Log in</button></form></div>`;
  document.getElementById('f').onsubmit = act(async (e) => {
    user = await api('POST', '/login', Object.fromEntries(new FormData(e.target)));
    route();
  });
}

// ---------- faculty ----------

async function viewFacultyHome() {
  const list = await api('GET', '/assessments');
  const rows = list.map((a) => `<tr>
      <td><a href="#/a/${a.id}">${title(a)}</a><div class="muted small">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(a.total_marks)} marks</div></td>
      <td>${a.status === 'published' ? '<span class="pill ok">Published</span>' : '<span class="pill warn">Draft</span>'}</td>
      <td>${a.release_mode === 'instant' ? 'Instant' : 'After approval'}</td>
      <td>${a.submitted}</td><td>${a.published}</td></tr>`).join('');
  app.innerHTML = `<div class="between"><h1>Assessments</h1><a class="btn" href="#/new">New assessment</a></div>
    ${provider === 'mock' ? '<div class="note warn"><b>Mock scorer is active.</b> Marks shown are dummy keyword counts, not real evaluation.</div>' : ''}
    <div class="card">${list.length ? `<table><thead><tr><th>Assessment</th><th>Status</th><th>Result release</th><th>Submitted</th><th>Results out</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">No assessments yet. Add students first, then create an assessment.</p>'}</div>`;
}

async function viewStudents() {
  const list = await api('GET', '/students');
  app.innerHTML = `<h1>Students</h1>
    <div class="card"><h2>Add students</h2>
      <p class="muted small">One student per line: <b>roll no, name, username, password</b></p>
      <form id="f"><textarea name="lines" rows="5" placeholder="101, Student Name, student101, secret12" required></textarea>
      <p><button>Add students</button></p></form></div>
    <div class="card"><h2>Student list (${list.length})</h2>
      ${list.length ? `<table><thead><tr><th>Roll no</th><th>Name</th><th>Username</th></tr></thead><tbody>${list.map((s) => `<tr><td>${esc(s.roll_no)}</td><td>${esc(s.name)}</td><td>${esc(s.username)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No students yet.</p>'}</div>`;
  document.getElementById('f').onsubmit = act(async (e) => {
    const students = e.target.lines.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
      const p = l.split(',').map((x) => x.trim());
      if (p.length !== 4 || p.some((x) => !x)) throw new Error(`Line ${i + 1}: need roll no, name, username, password`);
      return { roll_no: p[0], name: p[1], username: p[2], password: p[3] };
    });
    const r = await api('POST', '/students', { students });
    toast(`${r.added} student(s) added`);
    viewStudents();
  });
}

function viewNew() {
  const local = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const start = new Date();
  const end = new Date(Date.now() + 2 * 3600e3);
  app.innerHTML = `<h1>New assessment</h1>
    <form id="f">
    <div class="card"><h2>Details</h2>
      <div class="row"><label>Subject name<input name="subject_name" required></label><label>Subject code<input name="subject_code" required></label></div>
      <div class="row"><label>Type<select name="type"><option>Assignment</option><option>Sessional</option><option>Tutorial</option></select></label>
        <label>Number<input name="number" type="number" min="1" value="1" required></label>
        <label>Duration (minutes)<input name="duration_min" type="number" min="1" max="600" value="60" required></label></div>
      <div class="row"><label>Window opens<input name="start_at" type="datetime-local" value="${local(start)}" required></label>
        <label>Window closes<input name="end_at" type="datetime-local" value="${local(end)}" required></label>
        <label>Result release<select name="release_mode"><option value="after_approval">After faculty approval</option><option value="instant">Instant (after evaluation)</option></select></label></div>
      <p class="muted small" id="relnote"></p></div>
    <div id="qs"></div>
    <p><button type="button" class="ghost" id="addq">+ Add question</button></p>
    <p><button>Save as draft</button></p></form>`;
  const f = document.getElementById('f');
  const qs = document.getElementById('qs');

  const syncRelease = () => {
    const sess = f.type.value === 'Sessional';
    if (sess) f.release_mode.value = 'after_approval';
    f.release_mode.disabled = sess;
    document.getElementById('relnote').textContent = sess
      ? 'Sessional results are always released only after faculty approval.'
      : 'Instant: the student sees the result right after evaluation, unless the model is unsure about an answer.';
  };
  f.type.onchange = syncRelease;
  syncRelease();

  const rubricRow = () => {
    const d = document.createElement('div');
    d.className = 'rubric-row';
    d.innerHTML = '<input placeholder="Criterion, e.g. Correct definition" data-r="criterion" required><input type="number" step="0.5" min="0.5" placeholder="Marks" data-r="marks" required><button type="button" class="ghost small">✕</button>';
    d.querySelector('button').onclick = () => d.parentNode.children.length > 1 && d.remove();
    return d;
  };
  const addQuestion = () => {
    const box = document.createElement('div');
    box.className = 'card q';
    box.innerHTML = `<div class="between"><h2 class="qn"></h2><button type="button" class="ghost small rm">Remove</button></div>
      <label>Question<textarea data-q="text" required></textarea></label>
      <div class="row"><label>Max marks<input type="number" step="0.5" min="0.5" data-q="max_marks" required></label><label>CO (optional)<input data-q="co" placeholder="CO1"></label></div>
      <label>Model answer / key points (never shown to students)<textarea data-q="model_answer" required></textarea></label>
      <h3>Rubric <span class="muted small">(criterion marks must add up to max marks)</span></h3>
      <div class="rub"></div><button type="button" class="ghost small addr">+ Add criterion</button>`;
    box.querySelector('.rub').append(rubricRow());
    box.querySelector('.addr').onclick = () => box.querySelector('.rub').append(rubricRow());
    box.querySelector('.rm').onclick = () => { if (qs.children.length > 1) { box.remove(); renumber(); } };
    qs.append(box);
    renumber();
  };
  const renumber = () => [...qs.children].forEach((b, i) => (b.querySelector('.qn').textContent = `Question ${i + 1}`));
  document.getElementById('addq').onclick = addQuestion;
  addQuestion();

  f.onsubmit = act(async () => {
    const questions = [...qs.children].map((b) => ({
      text: b.querySelector('[data-q=text]').value,
      max_marks: +b.querySelector('[data-q=max_marks]').value,
      co: b.querySelector('[data-q=co]').value,
      model_answer: b.querySelector('[data-q=model_answer]').value,
      rubric: [...b.querySelectorAll('.rubric-row')].map((r) => ({
        criterion: r.querySelector('[data-r=criterion]').value,
        marks: +r.querySelector('[data-r=marks]').value,
      })),
    }));
    const r = await api('POST', '/assessments', {
      subject_name: f.subject_name.value, subject_code: f.subject_code.value, type: f.type.value,
      number: +f.number.value, duration_min: +f.duration_min.value,
      start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      release_mode: f.release_mode.value, questions,
    });
    toast('Saved as draft');
    location.hash = `#/a/${r.id}`;
  });
}

const attemptPill = (t) => {
  if (t.status === 'in_progress') return '<span class="pill">Writing</span>';
  if (t.failed) return '<span class="pill bad">Evaluation failed</span>';
  if (t.status === 'submitted') return '<span class="pill warn">Evaluating</span>';
  if (t.status === 'evaluated') return '<span class="pill warn">Awaiting approval</span>';
  return '<span class="pill ok">Result published</span>';
};

async function viewAssessment(id) {
  const a = await api('GET', `/assessments/${id}`);
  const total = a.questions.reduce((s, q) => s + q.max_marks, 0);
  app.innerHTML = `<div class="between"><h1>${title(a)}</h1>
      ${a.status === 'draft' ? '<button id="pub">Publish to students</button>' : '<span class="pill ok">Published</span>'}</div>
    <div class="card"><div class="muted">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(total)} marks ·
      Result release: <b>${a.release_mode === 'instant' ? 'Instant' : 'After faculty approval'}</b></div></div>
    <div class="card"><h2>Submissions</h2>
      ${a.attempts.length ? `<table><thead><tr><th>Roll no</th><th>Student</th><th>Status</th><th>LLM marks</th><th>Final</th><th>Tab switches</th><th>Paste tries</th><th></th></tr></thead><tbody>
      ${a.attempts.map((t) => `<tr><td>${esc(t.roll_no)}</td><td>${esc(t.name)}</td><td>${attemptPill(t)}${t.low ? ' <span class="pill warn">Low confidence</span>' : ''}</td>
        <td>${num(t.llm_total)}</td><td>${t.status === 'published' ? num(t.final_total) : '–'}</td><td>${t.tab_switches}</td><td>${t.paste_attempts}</td>
        <td class="right">${t.status === 'in_progress' ? '' : `<a class="btn ghost" href="#/review/${t.id}">Review</a>`}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No student has started yet.</p>'}</div>
    <div class="card"><h2>Questions</h2>${a.questions.map((q) => `<div class="qbox"><div class="between"><h3>Q${q.seq}${q.co ? ` · ${esc(q.co)}` : ''}</h3><span class="pill">${num(q.max_marks)} marks</span></div>
      <div class="answer">${esc(q.text)}</div><div class="muted small">Rubric: ${q.rubric.map((r) => `${esc(r.criterion)} (${num(r.marks)})`).join(' · ')}</div></div>`).join('')}</div>`;
  const pub = document.getElementById('pub');
  if (pub) pub.onclick = act(async () => {
    await api('POST', `/assessments/${id}/publish`);
    toast('Published');
    viewAssessment(id);
  });
}

async function viewReview(id) {
  const t = await api('GET', `/attempts/${id}`);
  const pending = t.answers.some((a) => a.eval_status !== 'done');
  app.innerHTML = `<p><a href="#/a/${t.assessment_id}">← Back to submissions</a></p>
    <div class="between"><h1>${esc(t.student_name)} <span class="muted">(${esc(t.roll_no)})</span></h1>${attemptPill({ ...t, failed: t.answers.some((a) => a.eval_status === 'failed') })}</div>
    <p class="muted">${title(t)} · Tab switches: ${t.tab_switches} · Paste attempts: ${t.paste_attempts}</p>
    ${pending ? '<div class="note warn">Some answers are not evaluated yet. <button class="small" id="rerun">Run evaluation now</button></div>' : ''}
    ${t.status === 'published' ? '<div class="note">This result is published. Saving again updates what the student sees.</div>' : ''}
    <form id="f">${t.answers.map((a) => `<div class="card" data-id="${a.id}">
      <div class="between"><h2>Q${a.seq}${a.co ? ` · ${esc(a.co)}` : ''}</h2><span class="pill">${num(a.max_marks)} marks</span></div>
      <div class="answer">${esc(a.qtext)}</div>
      <h3>Student answer</h3><div class="answer">${a.text.trim() ? esc(a.text) : '<span class="muted">Not attempted</span>'}</div>
      ${a.eval_status === 'failed' ? `<div class="note bad">Evaluation failed: ${esc(a.eval_error)}</div>` : ''}
      ${a.llm ? `<h3>LLM draft: ${num(a.llm_marks)} / ${num(a.max_marks)} <span class="pill ${a.llm_confidence === 'low' ? 'warn' : 'ok'}">${esc(a.llm_confidence)} confidence</span></h3>
        <table><thead><tr><th>Criterion</th><th>Marks</th><th>Justification</th></tr></thead><tbody>${a.llm.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${esc(c.justification)}</td></tr>`).join('')}</tbody></table>
        ${a.llm.missing_points.length ? `<h3>Missing points</h3><ul class="tight">${a.llm.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.llm.improvements.length ? `<h3>Suggested improvements</h3><ul class="tight">${a.llm.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}` : ''}
      <details><summary class="muted small">Model answer</summary><div class="answer">${esc(a.model_answer)}</div></details>
      <div class="row"><label>Final marks (0–${num(a.max_marks)})<input type="number" step="0.5" min="0" max="${a.max_marks}" data-f="marks" value="${a.final_marks ?? a.llm_marks ?? ''}" required></label>
        <label style="flex:3 1 300px">Faculty remark (optional, shown to student)<input data-f="remark" value="${esc(a.faculty_remark || '')}"></label></div>
      </div>`).join('')}
    <p><button>${t.status === 'published' ? 'Update published result' : 'Approve and publish result'}</button></p></form>`;
  const rerun = document.getElementById('rerun');
  if (rerun) rerun.onclick = act(async () => {
    toast('Evaluating…');
    await api('POST', `/attempts/${id}/evaluate`);
    viewReview(id);
  });
  document.getElementById('f').onsubmit = act(async (e) => {
    const answers = [...e.target.querySelectorAll('[data-id]')].map((c) => ({
      id: +c.dataset.id,
      final_marks: c.querySelector('[data-f=marks]').value,
      remark: c.querySelector('[data-f=remark]').value,
    }));
    await api('POST', `/attempts/${id}/approve`, { answers });
    toast('Result published to the student');
    location.hash = `#/a/${t.assessment_id}`;
  });
}

// ---------- student ----------

async function viewStudentHome() {
  const list = await api('GET', '/my/assessments');
  const t = Date.now();
  const action = (a) => {
    if (a.attempt_status === 'published') return `<a class="btn" href="#/result/${a.attempt_id}">View result</a>`;
    if (a.attempt_status === 'submitted' || a.attempt_status === 'evaluated') return '<span class="pill warn">Submitted · result awaited</span>';
    if (a.attempt_status === 'in_progress') return `<a class="btn" href="#/attempt/${a.id}">Continue</a>`;
    if (t < Date.parse(a.start_at)) return '<span class="pill">Not started yet</span>';
    if (t >= Date.parse(a.end_at)) return '<span class="pill bad">Missed</span>';
    return `<a class="btn" href="#/attempt/${a.id}">Start</a>`;
  };
  app.innerHTML = `<h1>My assessments</h1><div class="card">${list.length ? `<table><tbody>${list.map((a) => `<tr>
      <td><b>${title(a)}</b><div class="muted small">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${a.question_count} question(s) · ${num(a.total_marks)} marks</div></td>
      <td class="right">${action(a)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No assessments are available right now.</p>'}</div>`;
}

async function viewAttempt(assessmentId) {
  const d = await api('POST', `/assessments/${assessmentId}/start`);
  const skew = Date.parse(d.server_now) - Date.now(); // use the server clock for the timer
  const deadline = Date.parse(d.deadline_at);
  let tabSwitches = 0, pasteAttempts = 0, dirty = false, done = false;

  app.innerHTML = `<div class="attempt-bar between"><b>${title(d.assessment)}</b>
      <span><span class="muted small" id="saved"></span> &nbsp; Time left: <span class="timer" id="timer"></span></span></div>
    <div class="note">Type your answers yourself. Pasting is disabled, and leaving this tab is recorded for your faculty. Answers are saved automatically.</div>
    <form id="f">${d.questions.map((q) => `<div class="card"><div class="between"><h2>Q${q.seq}</h2><span class="pill">${num(q.max_marks)} marks</span></div>
      <div class="answer">${esc(q.text)}</div>
      <label>Your answer<textarea rows="8" data-q="${q.id}" spellcheck="false">${esc(q.answer)}</textarea></label></div>`).join('')}
    <p><button>Submit assessment</button></p></form>`;

  const f = document.getElementById('f');
  const payload = () => ({
    answers: [...f.querySelectorAll('textarea')].map((x) => ({ question_id: +x.dataset.q, text: x.value })),
    tab_switches: tabSwitches,
    paste_attempts: pasteAttempts,
  });
  const save = async () => {
    if (!dirty || done) return;
    dirty = false;
    try {
      await api('PUT', `/attempts/${d.attempt_id}/answers`, payload());
      document.getElementById('saved').textContent = `Saved ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`;
    } catch (e) {
      dirty = true;
      document.getElementById('saved').textContent = 'Not saved – retrying';
    }
  };
  const submit = async () => {
    if (done) return;
    done = true;
    try {
      await api('POST', `/attempts/${d.attempt_id}/submit`, payload());
      stop();
      toast('Submitted');
      location.hash = '#/';
    } catch (e) {
      done = false;
      throw e;
    }
  };

  const blockPaste = (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    e.preventDefault();
    pasteAttempts++;
    dirty = true;
    toast('Pasting is not allowed', true);
  };
  const onHide = () => { if (document.hidden) { tabSwitches++; dirty = true; save(); } };
  const onLeave = (e) => { if (!done) e.preventDefault(); };
  f.addEventListener('paste', blockPaste);
  f.addEventListener('drop', blockPaste);
  f.addEventListener('input', () => (dirty = true));
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('beforeunload', onLeave);

  const tick = () => {
    const left = Math.max(0, deadline - (Date.now() + skew));
    const s = Math.floor(left / 1000);
    const el = document.getElementById('timer');
    el.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('low', s < 300);
    if (left === 0 && !done) { toast('Time is over. Submitting…'); submit().catch((e) => toast(e.message, true)); }
  };
  const timers = [setInterval(tick, 1000), setInterval(save, 15000)];
  tick();
  const stop = () => {
    timers.forEach(clearInterval);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('beforeunload', onLeave);
    cleanup = null;
  };
  cleanup = () => { save(); stop(); };

  f.onsubmit = act(async () => {
    if (confirm('Submit now? You cannot change your answers after this.')) await submit();
  });
}

async function viewResult(id) {
  const r = await api('GET', `/attempts/${id}/result`);
  if (!r.published) {
    app.innerHTML = '<div class="card"><h1>Result awaited</h1><p class="muted">Your answers are submitted. The result will appear here once your faculty approves it.</p><a class="btn" href="#/">Back</a></div>';
    return;
  }
  const got = r.answers.reduce((s, a) => s + a.marks, 0);
  const max = r.answers.reduce((s, a) => s + a.max_marks, 0);
  app.innerHTML = `<p><a href="#/">← My assessments</a></p><h1>${title(r.assessment)}</h1>
    <div class="card"><div class="muted">Total marks</div><div class="score">${num(got)} / ${num(max)}</div></div>
    ${r.answers.map((a) => `<div class="card"><div class="between"><h2>Q${a.seq}</h2><span class="pill ${a.marks >= a.max_marks * 0.6 ? 'ok' : 'warn'}">${num(a.marks)} / ${num(a.max_marks)}</span></div>
      <div class="answer">${esc(a.question)}</div>
      <h3>Your answer</h3><div class="answer">${a.answer.trim() ? esc(a.answer) : '<span class="muted">Not attempted</span>'}</div>
      ${a.criteria ? `<h3>Marks breakdown</h3><table><tbody>${a.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${esc(c.justification)}</td></tr>`).join('')}</tbody></table>`
        : a.moderated ? '<p class="muted small">Marks for this question were moderated by your faculty.</p>' : ''}
      ${a.faculty_remark ? `<h3>Faculty remark</h3><p>${esc(a.faculty_remark)}</p>` : ''}
      ${a.missing_points.length ? `<h3>What was missing</h3><ul class="tight">${a.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${a.improvements.length ? `<h3>How to improve</h3><ul class="tight">${a.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`).join('')}`;
}

// ---------- router ----------

async function route() {
  if (cleanup) cleanup();
  try {
    if (!user) {
      const s = await api('GET', '/status');
      provider = s.provider;
      if (s.needsSetup) return drawNav(), viewSetup();
      try { user = await api('GET', '/me'); } catch { return drawNav(), viewLogin(); }
    }
    drawNav();
    const [, page, id] = location.hash.split('/');
    if (user.role === 'faculty') {
      if (page === 'new') return viewNew();
      if (page === 'students') return await viewStudents();
      if (page === 'a' && id) return await viewAssessment(+id);
      if (page === 'review' && id) return await viewReview(+id);
      return await viewFacultyHome();
    }
    if (page === 'attempt' && id) return await viewAttempt(+id);
    if (page === 'result' && id) return await viewResult(+id);
    return await viewStudentHome();
  } catch (e) {
    app.innerHTML = `<div class="card"><h1>Something went wrong</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Go back</a></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
