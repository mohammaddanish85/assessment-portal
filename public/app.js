'use strict';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let user = null;
let provider = '';
let cleanup = null; // set by the attempt screen (timer, listeners)
let coTarget = 60; // CO target % chosen by the faculty on the analysis card; reused in the printed report
let nav_seq = 0; // bumped on every navigation, so a slow page load cannot overwrite a newer screen

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const num = (n) => (n === null || n === undefined ? '–' : String(+(+n).toFixed(2)));
const title = (a) => `${esc(a.type)} ${esc(a.number)} · ${esc(a.subject_name)} (${esc(a.subject_code)})`;

// MCQ options as a list. `chosen` is the student's stored answer ('' or an index), or null when no student is involved
// (question paper). `correct` is the key, or null to hide it.
function optionList(options, chosen, correct) {
  const attempted = chosen !== null && /^\d+$/.test(chosen);
  return `<ul class="opts">${options.map((o, i) => {
    const picked = attempted && +chosen === i;
    const cls = correct === i ? 'right-opt' : picked ? 'wrong-opt' : '';
    return `<li class="${cls}">${String.fromCharCode(65 + i)}. ${esc(o)}${picked ? ' <span class="pill">Selected</span>' : ''}${correct === i ? ' <span class="pill ok">Correct</span>' : ''}</li>`;
  }).join('')}</ul>${attempted || chosen === null ? '' : '<p class="muted small">Not attempted</p>'}`;
}

// Justification cell: the examiner's reasoning plus the student's words it was based on.
const why = (c) => `${esc(c.justification)}${c.evidence && c.evidence.toLowerCase() !== 'none' ? `<div class="muted small">Based on: “${esc(c.evidence)}”</div>` : ''}`;

function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3500);
}

// In-page dialog. The browser's own confirm()/prompt() boxes are silently blocked in some browsers and
// in-app web views, which made buttons that depend on them look dead.
// Without `fields`: resolves to true (OK) or false (cancel).
// With `fields` [{name, label, value, type, min, options:[{value,label}], optional}]: resolves to an object of values, or null.
function ask(message, { ok = 'OK', fields = null } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ask';
    const field = (f) => f.type === 'checkbox' ? `<label class="choice"><input type="checkbox" name="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>` : `<label>${esc(f.label)}${f.options
      ? `<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"${f.min ? ` minlength="${f.min}"` : ''}${f.optional ? '' : ' required'} autocomplete="off">`}</label>`;
    d.innerHTML = `<form method="dialog"><p>${esc(message)}</p>${(fields || []).map(field).join('')}
      <div class="between"><button type="button" class="ghost" data-cancel>Cancel</button><button data-ok>${esc(ok)}</button></div></form>`;
    document.body.append(d);
    let result = fields ? null : false;
    d.querySelector('[data-cancel]').onclick = () => d.close();
    d.querySelector('form').onsubmit = (e) => {
      if (!fields) return (result = true);
      result = Object.fromEntries(new FormData(e.target));
      for (const f of fields) if (f.type === 'checkbox') result[f.name] = e.target[f.name].checked;
    };
    d.onclose = () => { d.remove(); resolve(result); };
    d.showModal();
  });
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
  const brand = document.querySelector('.brand');
  brand.innerHTML = `<img src="/logo.svg" alt="" width="30" height="30"><span>COGNEXA</span>${user && user.institute_name ? ` <span class="tag">${esc(user.institute_name)}</span>` : ''}`;
  if (!user) return (nav.innerHTML = '<a href="/">Home</a>');
  const p = user.perms || {};
  const links = user.role === 'owner' ? '<a href="#/">Institutes and requests</a>'
    : user.role === 'student' ? '<a href="#/">My assessments</a>'
    : `${p.manage ? '<a href="#/setup">Institute setup</a>' : ''}${p.students || p.manage ? '<a href="#/students">Students</a>' : ''}${(user.coordinates || []).length ? '<a href="#/my-section">My section</a>' : ''}${user.role === 'hod' ? '<a href="#/moderation">Moderation</a><a href="#/dqac">DQAC and setters</a>' : ''}${user.dqac || user.role === 'hod' ? '<a href="#/reviews">Reviews</a>' : ''}${p.create || p.reports !== 'own' ? '<a href="#/list">Assessments</a>' : ''}${p.create ? '<a href="#/new">New assessment</a>' : ''}`;
  const rep = user.role !== 'student' && user.role !== 'owner' && (p.reports === 'institute' || p.manage || user.role === 'hod' || (user.coordinates || []).length);
  nav.innerHTML = `${user.must_change ? '' : links}${!user.must_change && user.role !== 'student' && user.role !== 'owner' && (p.create || rep) ? '<a href="#/sheets">Evaluation sheets</a>' : ''}${!user.must_change && rep ? '<a href="#/reports">Reports</a>' : ''}${user.must_change || user.role === 'owner' ? '' : '<button class="bell" id="bell" aria-label="Notifications">🔔<b id="belln" hidden></b></button>'}${user.role === 'student' ? `<span class="muted small">${esc(user.name)}</span>` : `<a href="#/password" class="muted small">${esc(user.name)}</a>`}<button class="ghost small" id="logout">Log out</button>`;
  const bell = document.getElementById('bell');
  if (bell) {
    const load = () => api('GET', '/notifications').then((n) => { const b = document.getElementById('belln'); if (b) { b.hidden = !n.unread; b.textContent = n.unread; } return n; }).catch(() => null);
    load();
    bell.onclick = async () => {
      const old = document.querySelector('.bell-list');
      if (old) return old.remove();
      const n = await load();
      if (!n) return;
      const box = document.createElement('div');
      box.className = 'bell-list';
      box.innerHTML = n.items.length ? n.items.map((x) => `<a href="${esc(x.link || '#/')}" class="${x.read_at ? '' : 'unread'}">${esc(x.text)}<br><span class="small muted">${fmt(x.created_at)}</span></a>`).join('') : '<p class="small muted" style="padding:12px">No notifications yet.</p>';
      document.body.append(box);
      box.onclick = () => box.remove();
      if (n.unread) api('POST', '/notifications/read', {}).then(load).catch(() => {});
    };
  }
  document.getElementById('logout').onclick = act(async () => {
    await api('POST', '/logout');
    user = null;
    location.hash = '#/';
    route();
  });
}

// ---------- sign-in ----------

function viewSetup() {
  app.innerHTML = `<div class="card narrow"><h1>First-time setup</h1>
    <p class="muted">Create the platform owner account. The owner approves institutes and creates their admin logins. This screen appears only once.</p>
    <form id="f"><label>Full name<input name="name" required></label>
    <label>Username<input name="username" required autocomplete="username"></label>
    <label>Password (min 6 characters)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    <button>Create owner account</button></form></div>`;
  document.getElementById('f').onsubmit = act(async (e) => {
    await api('POST', '/setup', Object.fromEntries(new FormData(e.target)));
    toast('Account created. Please log in.');
    route();
  });
}

const LOGO = '<img src="/logo.svg" alt="" width="34" height="34">';
function viewLogin(owner = false) {
  const ROLE = {
    student: { label: 'University roll no', hint: 'Use your college roll no if the university one is not issued yet' },
    staff: { label: 'Employee ID', hint: '' },
    admin: { label: 'Username', hint: '' },
  };
  app.innerHTML = `<div class="login-wrap">
    <section class="ruled" aria-label="About COGNEXA">
      <div style="display:flex;align-items:center;gap:10px;height:36px">${LOGO}<span style="font:500 24px/1 var(--serif);letter-spacing:.08em">COGNEXA</span></div>
      <p class="big">Beyond assessment.</p>
      <p class="big" style="white-space:nowrap">Towards learning. <span class="tick" aria-hidden="true">✓ 10/10</span></p>
      <p class="q">Q1. What does COGNEXA do?</p>
      <p class="hand">Faculty set papers, students write live,</p>
      <p class="hand">every answer gets marks and feedback.</p>
      <p class="inks"><span><span class="dot" style="background:#8a8399"></span>AI recommends</span><span><span class="dot" style="background:var(--ok)"></span>Faculty decides</span><span><span class="dot" style="background:#e0a21b"></span>Student learns</span></p>
      <span class="side" aria-hidden="true">for examiner's use</span>
    </section>
    <section class="cover">
      <div class="booklet">
        <div class="between"><h1>${owner ? 'Platform owner' : 'Log in'}</h1><span class="small muted">Answer booklet</span></div>
        <form id="f">
        ${owner ? '<div style="height:14px"></div>' : `<div class="tabs" role="group" aria-label="I am a">
          <button type="button" data-role="student" aria-pressed="true">Student</button>
          <button type="button" data-role="staff" aria-pressed="false">Faculty and staff</button>
          <button type="button" data-role="admin" aria-pressed="false">Institute admin</button></div>
          <label>Institute code<input name="code" required autocapitalize="characters" autocomplete="organization" placeholder="Your AICTE ID, e.g. 1-7216281"></label>`}
        <label><span id="ulabel">${owner ? 'Username' : ROLE.student.label}</span><input name="username" required autocomplete="username"></label>
        <p class="small muted" id="uhint" style="margin:-6px 0 10px">${owner ? '' : ROLE.student.hint}</p>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="go">Log in</button></form>
        <p class="small muted" style="margin:12px 0 0" id="forgot-msg" hidden></p>
        <div class="foot-links">${owner ? '<a href="#" id="swap">Log in as an institute member</a>'
          : '<a href="#" id="forgot">Forgot your password?</a><a href="/#access">Institute not on COGNEXA? Request access</a>'}</div>
      </div>
      ${owner ? '' : '<p class="small" style="margin-top:12px;text-align:right"><a href="#" id="swap" class="muted">Platform owner</a></p>'}
      <p class="sigline" aria-hidden="true">Invigilator's signature ____</p>
    </section></div>`;
  document.getElementById('swap').onclick = (e) => { e.preventDefault(); viewLogin(!owner); };
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.getElementById('ulabel').textContent = ROLE[b.dataset.role].label;
    document.getElementById('uhint').textContent = ROLE[b.dataset.role].hint;
  }));
  const fg = document.getElementById('forgot');
  if (fg) fg.onclick = (e) => {
    e.preventDefault();
    const m = document.getElementById('forgot-msg');
    m.hidden = false;
    const f = document.getElementById('f');
    const student = document.querySelector('.tabs [data-role=student]').getAttribute('aria-pressed') === 'true';
    if (student && f.code.value.trim() && f.username.value.trim()) {
      api('POST', '/password-request', { code: f.code.value, username: f.username.value }).catch(() => {});
      m.textContent = 'Your request has gone to your class coordinator. After the reset, log in with the institute\'s first password and set your own.';
    } else {
      m.textContent = student ? 'Fill in the institute code and your roll no above, then click "Forgot your password?" again to send a reset request to your class coordinator.'
        : 'Faculty and staff passwords are reset by the institute admin.';
    }
  };
  document.getElementById('f').onsubmit = act(async (e) => {
    await api('POST', '/login', Object.fromEntries(new FormData(e.target)));
    user = await api('GET', '/me');
    location.hash = '#/';
    route();
  });
}

function viewPassword() {
  app.innerHTML = `<div class="card narrow"><h1>${user.must_change ? 'Set your own password' : 'Change password'}</h1>
    ${user.must_change ? '<div class="note warn">This is your first login (or your password was reset). Choose your own password before you continue. If you forget it later, your institute resets it.</div>' : ''}
    <form id="f"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
    <label>New password (min 8 characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <label>New password again<input name="again" type="password" minlength="8" required autocomplete="new-password"></label>
    <button>Change password</button></form></div>
    ${user.role !== 'student' && !user.must_change ? `<div class="card narrow"><h2>Your signature</h2><p class="small muted">Printed on moderation reports only where you reviewed or approved a paper from your own login. PNG or JPG, under 100 KB, on a white or transparent background.</p>
      <div id="sigprev"></div><label>Upload signature<input type="file" id="sigfile" accept="image/png,image/jpeg"></label></div>` : ''}`;
  const sigBox = document.getElementById('sigprev');
  if (sigBox) {
    const draw = (img) => (sigBox.innerHTML = img ? `<img src="${esc(img)}" alt="Your signature" style="max-height:60px;max-width:220px;border:1px solid var(--line);padding:4px;background:#fff">` : '<p class="small muted">No signature uploaded.</p>');
    api('GET', '/signature').then((r) => draw(r.image)).catch(() => {});
    document.getElementById('sigfile').onchange = imgPicker(100, async (img) => { try { await api('PUT', '/signature', { image: img }); draw(img); toast('Signature saved'); } catch (err) { toast(err.message, true); } });
  }
  document.getElementById('f').onsubmit = act(async (e) => {
    const f = e.target;
    if (f.password.value !== f.again.value) throw new Error('The two new passwords do not match');
    await api('POST', '/password', { current: f.current.value, password: f.password.value });
    user.must_change = false;
    toast('Password changed');
    location.hash = '#/';
    route();
  });
}

// ---------- platform owner ----------

async function viewOwner() {
  const seq = nav_seq;
  const d = await api('GET', '/owner/data');
  if (seq !== nav_seq) return;
  const open = d.requests.filter((r) => r.status === 'new');
  app.innerHTML = `<h1>Institutes and requests</h1>
    <div class="card"><h2>Access requests waiting (${open.length})</h2>
      ${open.length ? `<table><thead><tr><th>Institute</th><th>Contact</th><th>Message</th><th>Received</th><th></th></tr></thead><tbody>${open.map((r) => `<tr>
        <td><b>${esc(r.institute)}</b></td><td>${esc(r.contact_name)}<div class="muted small">${esc(r.email)}<br>${esc(r.phone)}</div></td>
        <td>${esc(r.message) || '–'}</td><td class="nowrap">${fmt(r.created_at)}</td>
        <td class="right nowrap"><button type="button" class="small" data-use="${r.id}">Create institute</button> <button type="button" class="ghost small" data-close="${r.id}">Dismiss</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No requests are waiting.</p>'}</div>
    <div class="card"><h2>Create an institute</h2>
      <p class="muted small">This creates the institute and its admin login. Give the institute code, username and password to the admin yourself; they must choose a new password at first login.</p>
      <form id="fnew"><input type="hidden" name="request_id">
        <div class="row"><label style="flex:3 1 280px">Institute name<input name="name" required maxlength="150"></label>
          <label>Institute code (AICTE ID or a short code)<input name="code" required maxlength="20" pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,18}[A-Za-z0-9]" title="2 to 20 letters, digits or hyphens, no spaces" placeholder="1-7216281"></label></div>
        <div class="row"><label>Admin's full name<input name="admin_name" required></label><label>Admin username<input name="admin_username" required autocomplete="off"></label>
          <label>First password (min 6)<input name="admin_password" minlength="6" required autocomplete="off"></label></div>
        <p><button>Create institute and admin login</button></p></form></div>
    <div class="card"><h2>Institutes (${d.institutes.length})</h2>
      ${d.institutes.length ? `<table><thead><tr><th>Code</th><th>Institute</th><th>Admin username</th><th>Staff</th><th>Students</th><th>Assessments</th><th>Status</th><th></th></tr></thead><tbody>${d.institutes.map((i) => `<tr>
        <td><b>${esc(i.code)}</b></td><td>${esc(i.name)}<div class="muted small">Since ${fmt(i.created_at)}</div></td><td>${esc(i.admin_username ?? '–')}</td>
        <td>${i.staff}</td><td>${i.students}</td><td>${i.assessments}</td>
        <td>${i.status === 'active' ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Suspended</span>'}</td>
        <td class="right nowrap"><button type="button" class="ghost small" data-pw="${i.id}">Reset admin password</button>
          <button type="button" class="ghost small ${i.status === 'active' ? 'danger' : ''}" data-status="${i.id}">${i.status === 'active' ? 'Suspend' : 'Activate'}</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No institutes yet.</p>'}</div>`;

  const fnew = document.getElementById('fnew');
  fnew.onsubmit = act(async () => {
    const v = Object.fromEntries(new FormData(fnew));
    await api('POST', '/owner/institutes', { ...v, request_id: v.request_id ? +v.request_id : null });
    toast(`Institute ${v.code.toUpperCase()} created`);
    viewOwner();
  });
  app.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => {
    const r = d.requests.find((x) => x.id === +b.dataset.use);
    fnew.request_id.value = r.id;
    fnew.name.value = r.institute;
    fnew.admin_name.value = r.contact_name;
    fnew.code.focus();
    fnew.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  app.querySelectorAll('[data-close]').forEach((b) => (b.onclick = act(async () => {
    await api('POST', `/owner/requests/${b.dataset.close}/status`, { status: 'closed' });
    viewOwner();
  })));
  app.querySelectorAll('[data-status]').forEach((b) => (b.onclick = act(async () => {
    const i = d.institutes.find((x) => x.id === +b.dataset.status);
    const next = i.status === 'active' ? 'suspended' : 'active';
    if (next === 'suspended' && !(await ask(`Suspend ${i.name}? Nobody from this institute will be able to log in until you activate it again.`, { ok: 'Suspend' }))) return;
    await api('POST', `/owner/institutes/${i.id}/status`, { status: next });
    viewOwner();
  })));
  app.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = act(async () => {
    const i = d.institutes.find((x) => x.id === +b.dataset.pw);
    const v = await ask(`New password for the admin of ${i.name}:`, { ok: 'Reset password', fields: [{ name: 'password', label: 'New password (min 6)', min: 6 }] });
    if (!v) return;
    await api('POST', `/owner/institutes/${i.id}/admin-password`, { password: v.password });
    toast('Password reset. The admin must choose a new one at next login.');
  })));
}

// ---------- faculty ----------

async function viewFacultyHome() {
  const seq = nav_seq;
  const list = await api('GET', '/assessments');
  if (seq !== nav_seq) return;
  const rows = list.map((a) => `<tr>
      <td><a href="#/a/${a.id}">${title(a)}</a>${a.mine ? '' : ` <span class="pill">${esc(a.faculty_name)}</span>`}<div class="muted small">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(a.total_marks)} marks</div></td>
      <td>${a.status === 'published' ? '<span class="pill ok">Published</span>' : '<span class="pill warn">Draft</span>'}</td>
      <td>${a.release_mode === 'instant' ? 'Instant' : 'After approval'}</td>
      <td>${a.submitted}</td><td>${a.published}</td></tr>`).join('');
  app.innerHTML = `<div class="between"><h1>Assessments</h1>${user.perms.create ? '<a class="btn" href="#/new">New assessment</a>' : ''}</div>
    ${provider === 'mock' ? '<div class="note warn"><b>Mock scorer is active.</b> Marks shown are dummy keyword counts, not real evaluation.</div>' : ''}
    <div class="card">${list.length ? `<table><thead><tr><th>Assessment</th><th>Status</th><th>Result release</th><th>Submitted</th><th>Results out</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">No assessments yet.</p>'}</div>`;
}

// Best-of counting for parts with a choice ("attempt any 2 of 3"); same rule as the server.
function bestTotal(parts, rows, key) {
  rows.forEach((r) => (r.counted = true));
  for (const p of parts || []) {
    const groups = new Map();
    rows.filter((r) => (r.part || '') === p.name).forEach((r) => {
      const g = groups.get(r.qgroup) || { s: 0, rows: [] };
      g.s += Number(r[key] ?? 0); g.rows.push(r); groups.set(r.qgroup, g);
    });
    if (p.attempt >= groups.size) continue;
    [...groups.values()].sort((x, y) => y.s - x.s).slice(p.attempt).forEach((g) => g.rows.forEach((r) => (r.counted = false)));
  }
  return Math.round(rows.reduce((s, r) => s + (r.counted ? Number(r[key] ?? 0) : 0), 0) * 100) / 100;
}
const paperInfo = (a) => { try { return JSON.parse(a.paper_json || '{}'); } catch { return {}; } };
const paperMaxOf = (a) => paperInfo(a).max_marks || a.questions.reduce((s, q) => s + q.max_marks, 0);

// Question label, with the part for a Mid Term paper (e.g. "Part A · Q2").
const qno = (q) => `${q.part ? `Part ${esc(q.part)} · ` : ''}${q.label ? `Q ${esc(q.label)}` : `Q${q.seq}`}`;

// The five assessment types. Each opens its own form with only the fields that type needs.
const KINDS = {
  'mid-term': { type: 'Mid Term', blurb: 'Written paper in parts (Section A, B…), every question mapped to a CO. Strict timer. Result after your approval.', q: 'descriptive' },
  sessional: { type: 'Sessional', blurb: 'Short timed written test. LLM drafts the marks; the result is released only after your approval.', q: 'descriptive' },
  assignment: { type: 'Assignment', blurb: 'Open for days. Students can save and come back until the deadline. Release instantly or after approval.', q: 'descriptive' },
  mcq: { type: 'MCQ Test', blurb: 'Only MCQs, checked against your key. Result on submit. Optional negative marking and option shuffle.', q: 'mcq' },
  hybrid: { type: 'Hybrid', blurb: 'MCQs and written questions in one paper. MCQs auto-checked, written answers LLM-assisted. Result after approval.', q: 'both' },
};

function viewChooseType() {
  app.innerHTML = `<h1>New assessment</h1><p class="muted">Choose the type. The next page shows only what that type needs.</p>
    <div class="types">${Object.entries(KINDS).map(([k, v]) => `<a class="type-card" href="#/new/${k}"><h2>${v.type}</h2><p>${v.blurb}</p></a>`).join('')}</div>`;
}

// Opens a saved paper in the same form (only while it can still be edited).
async function viewEdit(id) {
  const seq = nav_seq;
  const a = await api('GET', `/assessments/${id}`);
  if (seq !== nav_seq) return;
  const kind = Object.keys(KINDS).find((k) => KINDS[k].type === a.type);
  if (!kind) throw new Error('This older assessment type cannot be edited');
  return viewNew(kind, a);
}

async function viewNew(kind, existing = null) {
  const K = KINDS[kind];
  if (!K) return viewChooseType();
  const seq = nav_seq;
  const master = await api('GET', '/master');
  if (seq !== nav_seq) return;
  if (!master.subjects.length) {
    app.innerHTML = `<div class="card"><h1>New assessment</h1><p>${master.allotment ? 'No subject is allotted to you yet. Ask the institute admin to add your subjects and sections under Institute setup → Subject allotment.' : 'No subjects or sections are set up yet. Ask the institute admin to add them under Institute setup.'}</p><a class="btn" href="#/">Back</a></div>`;
    return;
  }
  const subjectOf = (id) => master.subjects.find((x) => x.id === +id);
  const T = K.type;
  const isMid = T === 'Mid Term', isAsg = T === 'Assignment', hasMcq = K.q !== 'descriptive';
  const local = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const start = new Date();
  const end = new Date(Date.now() + (isAsg ? 7 * 24 : isMid ? 3 : 2) * 3600e3);
  const release = isAsg
    ? '<label>Result release<select name="release_mode"><option value="after_approval">After my approval</option><option value="instant">Instant (after evaluation)</option></select></label>'
    : '';
  const relNote = {
    'Mid Term': 'Mid Term marks are official internal marks: results are released only after your approval.',
    Sessional: 'Sessional results are released only after your approval.',
    Assignment: 'Students can save and return any time until the window closes. Instant release still holds back any answer the model is unsure about.',
    'MCQ Test': 'Checked against your answer key. The student sees the result immediately on submit.',
    Hybrid: 'MCQs are checked automatically; written answers get an LLM draft. The whole result is released after your approval.',
  }[T];
  app.innerHTML = `<div class="between"><h1>${existing ? `Edit ${T} ${existing.number}` : `New ${T}`}</h1>${existing ? `<a href="#/a/${existing.id}" class="small">Back without saving</a>` : '<a href="#/new" class="small">Change type</a>'}</div>
    <form id="f">
    <div class="card"><h2>Details</h2>
      <label>Subject${master.allotment ? ' (allotted to you)' : ''}<select name="subject_id" required><option value="">Choose subject…</option>${master.subjects.map((x) => `<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}${x.semester ? ` (Sem ${x.semester})` : ''}</option>`).join('')}</select></label>
      <div class="muted small">Sections that will take this ${T}</div>
      <div class="checks" id="secs"><span class="muted small">Choose the subject first.</span></div>
      <div class="row"><label>${T} number<input name="number" type="number" min="1" value="1" required></label>
        ${isAsg ? '' : `<label>Duration (minutes)<input name="duration_min" type="number" min="1" max="600" value="${isMid ? 90 : hasMcq ? 30 : 60}" required></label>`}
        ${release}</div>
      <div class="row"><label>${isAsg ? 'Opens' : 'Window opens'}<input name="start_at" type="datetime-local" value="${local(start)}" required></label>
        <label>${isAsg ? 'Deadline' : 'Window closes'}<input name="end_at" type="datetime-local" value="${local(end)}" required></label></div>
      <p class="muted small">${relNote}</p>
      <label class="choice" style="max-width:460px"><input type="checkbox" name="shuffle"> Show the questions in a different order to each student</label>
      ${hasMcq ? `<label class="choice" style="max-width:460px"><input type="checkbox" name="option_shuffle"> Shuffle the MCQ options for each student</label>
        <div class="muted small" style="margin-top:8px">Marking scheme for MCQs</div>
        <div class="checks"><label class="choice"><input type="radio" name="negmode" value="no" checked> Without negative marking</label>
          <label class="choice"><input type="radio" name="negmode" value="yes"> With negative marking</label></div>
        <div class="row" id="negrow" hidden><label>Marks deducted for a wrong answer<select name="negative"><option value="0.25">¼ of the question's marks</option><option value="0.33">⅓ of the question's marks</option><option value="0.5">½ of the question's marks</option><option value="1">Full marks of the question</option></select></label></div>
        <p class="muted small" id="negnote" hidden>A skipped MCQ never loses marks. The rule is printed in the paper's instructions.</p>` : ''}</div>
    <div class="card"><h2>Paper header <span class="muted small">(printed on the question paper in your institute's format)</span></h2>
      ${isAsg ? `<div class="row"><label style="flex:2 1 260px">Semester line<input name="p_title" placeholder="Odd Semester 2026-27"></label><label>Session<input name="p_session" placeholder="2026-27"></label></div>
        <div class="row"><label style="flex:2 1 260px">Program<input name="p_programme" placeholder="B. Tech (CSE-CS)"></label><label>Course units included<input name="p_units" placeholder="1, 2"></label></div>`
      : `<label>Paper title<input name="p_title"></label>
        <label>Programme and semester<input name="p_programme" placeholder="B. Tech (CSE – Cyber Security) 5th Semester"></label>
        <label>Instructions (one per line)<textarea name="p_instructions" rows="3" placeholder="Question No. 1 is compulsory.&#10;Answer any two questions from PART-B."></textarea></label>`}
      <label>Course outcomes (one per line)<textarea name="p_cos" rows="3" placeholder="CO-1: Explain the fundamentals of …&#10;CO-2: Apply … techniques for …"></textarea></label>
      ${isAsg ? '<label>Introduction / theme (optional, shown above the questions; **text** prints bold)<textarea name="p_intro" rows="3"></textarea></label>' : ''}</div>
    <div class="card"><div class="between"><h2>Paper structure</h2>
        <span class="small"><button type="button" class="ghost small" id="qtpl">Download question template</button>
        <label class="small" style="display:inline-block;margin:0">Fill from Excel <input type="file" id="qfile" accept=".xlsx,.xls,.csv" style="display:inline-block;width:auto"></label></span></div>
      <div class="row"><label style="max-width:220px">Max marks of the paper<input name="p_max" type="number" min="1" step="0.5" required></label></div>
      <table class="parts"><thead><tr><th>Part</th>${K.q === 'both' ? '<th>Type</th>' : ''}<th>Questions</th><th>Sub-parts in each</th><th>Sub-part numbering</th><th>Student attempts</th><th></th></tr></thead><tbody id="parts"></tbody></table>
      <p><button type="button" class="ghost small" id="addpart">+ Add part</button> <button type="button" id="build">Create question boxes</button></p>
      <p class="muted small">Example: PART-A with 1 question of 10 sub-parts (i to x), attempt 1; PART-B with 3 questions of 2 sub-parts ((a), (b)), attempt 2. When a part gives a choice, the student's best answers in that part are counted.</p></div>
    <div id="qs"></div>
    <p class="muted" id="marksum"></p>
    <div id="cocheck"></div>
    <p><button>${existing ? 'Save changes' : 'Save as draft'}</button></p></form>`;
  const f = document.getElementById('f');
  const qs = document.getElementById('qs');
  // ---- subject → sections, COs, header ----
  let cos = [];
  const coOpts = (sel = '') => `<option value="">${cos.length ? 'Choose CO…' : 'No COs in the scheme'}</option>${cos.map((c) => `<option value="${esc(c.co)}"${c.co === sel ? ' selected' : ''}>${esc(c.co)} · ${esc(RBT[c.rbtl] || '')}</option>`).join('')}`;
  const ORDN = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;
  // Each CO used must have at least one question at the CO's own (highest) Bloom level. Shown to the faculty and to DQAC.
  const coCheck = () => {
    const el = document.getElementById('cocheck');
    if (!el || !cos.length) { if (el) el.innerHTML = ''; return; }
    const qsx = [...qs.querySelectorAll('.card.q')].map((b) => ({ co: b.querySelector('[data-q=co]').value, rbtl: +b.querySelector('[data-q=rbtl]').value || 0 }));
    const alerts = coAlerts(cos, qsx);
    el.innerHTML = alerts.length ? `<div class="note warn"><b>CO and Bloom level check</b> (DQAC will see this)<ul class="tight">${alerts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
      : qsx.some((q) => q.co) ? '<div class="note"><b>CO and Bloom level check:</b> every CO used has a question at its own level.</div>' : '';
  };
  const fillRubric = (box, list) => {
    const rub = box.querySelector('.rub');
    rub.innerHTML = '';
    list.forEach((r) => { const row = rubricRow(); row.querySelector('[data-r=criterion]').value = r.criterion; row.querySelector('[data-r=marks]').value = r.marks; rub.append(row); });
    if (!list.length) rub.append(rubricRow());
  };
  const wireSubject = () => {
    const setSubject = (keepHeader) => {
      const sb = subjectOf(f.subject_id.value);
      const secs = document.getElementById('secs');
      cos = sb ? sb.cos : [];
      secs.innerHTML = sb ? sb.sections.map((x) => `<label class="choice"><input type="checkbox" name="section" value="${x.id}"${sb.sections.length === 1 ? ' checked' : ''}> ${esc(x.name)} <span class="muted small">(${x.students} students)</span></label>`).join('') || '<span class="muted small">No sections.</span>'
        : '<span class="muted small">Choose the subject first.</span>';
      qs.querySelectorAll('[data-q=co]').forEach((x) => { const v = x.value; x.innerHTML = coOpts(v); });
      if (sb && !keepHeader) {
        if (sb.programme && f.p_programme && !f.p_programme.value) f.p_programme.value = isAsg ? sb.programme : `${sb.programme} ${ORDN(sb.semester || 0)} Semester`;
        if (sb.cos.length && !f.p_cos.value) f.p_cos.value = sb.cos.map((c) => `${c.co}: ${c.text}`).join('\n');
        if (isAsg && f.p_session && !f.p_session.value && master.session) f.p_session.value = master.session.replace(/\s*(odd|even)\s*$/i, '');
      }
      coCheck();
    };
    f.subject_id.addEventListener('change', () => setSubject(false));
    if (existing) {
      f.subject_id.value = existing.subject_id ?? (master.subjects.find((x) => x.code === existing.subject_code)?.id || '');
      setSubject(true);
    }
  };

  const rubricRow = () => {
    const d = document.createElement('div');
    d.className = 'rubric-row';
    d.innerHTML = '<input placeholder="Criterion, e.g. Correct definition" data-r="criterion" required><input type="number" step="0.5" min="0.5" placeholder="Marks" data-r="marks" required><button type="button" class="ghost small">✕</button>';
    d.querySelector('button').onclick = () => d.parentNode.children.length > 1 && d.remove();
    return d;
  };
  let optGroup = 0;
  const ROMAN_FULL = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'];
  const optionRow = (group) => {
    const d = document.createElement('div');
    d.className = 'rubric-row';
    d.innerHTML = `<input type="radio" name="${group}" title="Mark as correct" required><input placeholder="Option text" data-o="text" required><button type="button" class="ghost small">✕</button>`;
    d.querySelector('button').onclick = () => d.parentNode.children.length > 2 && d.remove();
    return d;
  };
  // ---- paper structure → question boxes ----
  const partsBody = document.getElementById('parts');
  const partRow = (p = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input data-p="name" maxlength="10" value="${esc(p.name ?? '')}" placeholder="${isAsg || K.q === 'mcq' ? '(none)' : 'A'}" style="width:70px"></td>
      ${K.q === 'both' ? `<td><select data-p="kind"><option value="mcq"${p.kind === 'mcq' ? ' selected' : ''}>MCQ</option><option value="descriptive"${p.kind !== 'mcq' ? ' selected' : ''}>Written</option></select></td>` : ''}
      <td><input data-p="questions" type="number" min="1" max="40" value="${p.questions ?? 1}" style="width:80px"></td>
      <td><input data-p="subparts" type="number" min="1" max="15" value="${p.subparts ?? 1}" style="width:80px"></td>
      <td><select data-p="style"><option value="alpha"${p.style !== 'roman' ? ' selected' : ''}>(a), (b), (c)</option><option value="roman"${p.style === 'roman' ? ' selected' : ''}>(i), (ii), (iii)</option></select></td>
      <td><input data-p="attempt" type="number" min="1" max="40" value="${p.attempt ?? p.questions ?? 1}" style="width:80px"></td>
      <td><button type="button" class="ghost small">✕</button></td>`;
    tr.querySelector('button').onclick = () => partsBody.children.length > 1 && tr.remove();
    const qn = tr.querySelector('[data-p=questions]'), at = tr.querySelector('[data-p=attempt]');
    qn.oninput = () => { if (+at.value > +qn.value || at.dataset.auto !== 'no') at.value = qn.value; };
    at.oninput = () => (at.dataset.auto = 'no');
    partsBody.append(tr);
  };
  const readParts = () => [...partsBody.children].map((tr) => ({
    name: tr.querySelector('[data-p=name]').value.trim(),
    kind: K.q === 'both' ? tr.querySelector('[data-p=kind]').value : K.q,
    questions: +tr.querySelector('[data-p=questions]').value || 1,
    subparts: +tr.querySelector('[data-p=subparts]').value || 1,
    style: tr.querySelector('[data-p=style]').value,
    attempt: +tr.querySelector('[data-p=attempt]').value || 1,
  }));
  const DEFAULT_PARTS = {
    'Mid Term': [{ name: 'A', questions: 1, subparts: 5, style: 'roman', attempt: 1 }, { name: 'B', questions: 4, subparts: 2, attempt: 3 }],
    Sessional: [{ name: 'A', questions: 1, subparts: 5, style: 'roman', attempt: 1 }, { name: 'B', questions: 3, subparts: 2, attempt: 2 }],
    Assignment: [{ name: '', questions: 4, subparts: 1, attempt: 4 }],
    'MCQ Test': [{ name: '', questions: 10, subparts: 1, attempt: 10 }],
    Hybrid: [{ name: 'A', kind: 'mcq', questions: 10, subparts: 1, attempt: 10 }, { name: 'B', kind: 'descriptive', questions: 3, subparts: 1, attempt: 2 }],
  }[T];
  DEFAULT_PARTS.forEach(partRow);
  document.getElementById('addpart').onclick = () => partRow({ name: String.fromCharCode(65 + partsBody.children.length) });

  const subLabel = (style, i) => (style === 'roman' ? ROMAN_FULL[i] : String.fromCharCode(97 + i));
  const rbtOpts = RBT.map((n, i) => (i ? `<option value="${i}">${isAsg ? n : `${n} (${i})`}</option>` : '<option value="">Choose…</option>')).join('');
  const makeBox = (qk) => {
    const box = document.createElement('div');
    box.className = 'card q';
    box.dataset.kind = qk;
    const group = `opt${++optGroup}`;
    box.innerHTML = `<h2 class="qn"></h2>
      <label>Question<textarea data-q="text" required></textarea></label>
      <div class="row"><label>Max marks<input type="number" step="0.5" min="0.5" data-q="max_marks" required></label>
        <label>CO${isMid ? '' : ' (optional)'}<select data-q="co"${isMid ? ' required' : ''}>${coOpts()}</select></label>
        <label>Bloom's taxonomy level<select data-q="rbtl">${rbtOpts}</select></label></div>
      ${qk === 'mcq' ? `<h3>Options <span class="muted small">(select the radio button of the correct option)</span></h3>
        <div class="opt"></div><button type="button" class="ghost small addo">+ Add option</button>`
      : `<label>Model answer / key points (shown to the student with the result)<textarea data-q="model_answer" required></textarea></label>
        <div class="between"><h3>Rubric <span class="muted small">(criterion marks must add up to max marks)</span></h3><button type="button" class="ghost small ai">Suggest rubric (AI)</button></div>
        <div class="rub"></div><button type="button" class="ghost small addr">+ Add criterion</button>`}`;
    if (qk === 'mcq') {
      const opt = box.querySelector('.opt');
      for (let i = 0; i < 4; i++) opt.append(optionRow(group));
      box.querySelector('.addo').onclick = () => opt.children.length < 6 && opt.append(optionRow(group));
    } else {
      box.querySelector('.rub').append(rubricRow());
      box.querySelector('.addr').onclick = () => box.querySelector('.rub').append(rubricRow());
      // AI recommends a rubric as soon as the question and model answer are written; the faculty edits it.
      const suggestRub = async (auto) => {
        const rub = box.querySelector('.rub');
        const empty = [...rub.querySelectorAll('[data-r=criterion]')].every((x) => !x.value.trim());
        if (auto && !empty) return;
        const text = box.querySelector('[data-q=text]').value.trim();
        const maxm = +box.querySelector('[data-q=max_marks]').value;
        if (!text || !maxm) { if (!auto) toast('Write the question and its max marks first', true); return; }
        const btn = box.querySelector('.ai');
        btn.disabled = true; btn.textContent = 'Suggesting…';
        try {
          const r = await api('POST', '/ai/rubric', { question: text, model_answer: box.querySelector('[data-q=model_answer]').value, max_marks: maxm });
          fillRubric(box, r.rubric);
          if (!auto) toast('Rubric suggested. Edit it as you like.');
        } catch (e) { if (!auto) toast(e.message, true); } finally { btn.disabled = false; btn.textContent = 'Suggest rubric (AI)'; }
      };
      box.querySelector('.ai').onclick = () => suggestRub(false);
      box.querySelector('[data-q=model_answer]').addEventListener('blur', () => suggestRub(true));
    }
    box.querySelector('[data-q=max_marks]').oninput = sumMarks;
    box.querySelector('[data-q=co]').onchange = coCheck;
    box.querySelector('[data-q=rbtl]').onchange = coCheck;
    return box;
  };
  // Builds one box per question (or sub-part), numbered across the paper. Boxes already filled in are kept.
  let builtParts = [];
  const build = () => {
    const parts = readParts();
    if (parts.length > 1 && parts.some((p) => !p.name)) return toast('Give every part a name (e.g. A, B)', true);
    if (new Set(parts.map((p) => p.name)).size !== parts.length) return toast('Two parts have the same name', true);
    const old = new Map([...qs.querySelectorAll('.card.q')].map((b) => [`${b.dataset.kind}|${b.dataset.part}|${b.dataset.label}`, b]));
    qs.innerHTML = '';
    let n = 0;
    parts.forEach((p) => {
      const head = document.createElement('h2');
      head.className = 'parthead';
      head.textContent = `${p.name ? `PART-${p.name}` : 'Questions'} · ${p.attempt < p.questions ? `student attempts any ${p.attempt} of ${p.questions}` : 'all compulsory'}`;
      qs.append(head);
      for (let qi = 0; qi < p.questions; qi++) {
        n += 1;
        for (let si = 0; si < p.subparts; si++) {
          const label = isAsg ? (p.subparts > 1 ? `Q${n} (${subLabel(p.style, si)})` : `Q${n}`) : p.subparts > 1 ? `${n}. (${subLabel(p.style, si)})` : `${n}.`;
          const box = old.get(`${p.kind}|${p.name}|${label}`) || makeBox(p.kind);
          Object.assign(box.dataset, { part: p.name, label, qgroup: n });
          box.querySelector('.qn').textContent = `${p.name ? `PART-${p.name} · ` : ''}Q.N. ${label}${K.q === 'both' ? (p.kind === 'mcq' ? ' · MCQ' : ' · Written') : ''}`;
          qs.append(box);
        }
      }
    });
    builtParts = parts;
    sumMarks();
    coCheck();
  };
  const sumMarks = () => {
    const rows = [...qs.querySelectorAll('.card.q')].map((b) => ({ part: b.dataset.part, qgroup: +b.dataset.qgroup, m: +b.querySelector('[data-q=max_marks]').value || 0 }));
    const possible = bestTotal(builtParts, rows, 'm');
    const max = +f.p_max.value || 0;
    document.getElementById('marksum').innerHTML = rows.length
      ? `Marks a student can score (counting only the questions attempted): <b>${num(possible)}</b>${max ? ` · Max marks of the paper: <b>${num(max)}</b> ${Math.abs(possible - max) < 1e-9 ? '<span class="pill ok">Matches</span>' : '<span class="pill warn">Does not match yet</span>'}` : ''}`
      : '';
  };
  document.getElementById('build').onclick = () => build();
  f.p_max.oninput = sumMarks;
  build();
  wireSubject();

  // Paper header: suggested title, and the last header used for this subject is filled back in.
  const MONTH = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  const ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth'];
  const suggest = () => (isAsg ? '' : T === 'Sessional' ? `${ORD[+f.number.value] || f.number.value} Sessional Test, ${MONTH}`
    : T === 'Mid Term' ? `Mid Term Examination, ${MONTH}` : `${T} ${f.number.value}, ${MONTH}`);
  let titleTouched = false;
  f.p_title.oninput = () => (titleTouched = true);
  f.number.oninput = () => { if (!titleTouched && !isAsg) f.p_title.value = suggest(); };
  f.p_title.value = suggest();
  const PF = ['p_title', 'p_programme', 'p_session', 'p_units', 'p_instructions', 'p_cos', 'p_intro'].filter((k) => f[k]);
  f.subject_id.onchange = () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`cx-paper-${T}-${f.subject_id.value}`) || 'null'); } catch {}
    if (saved) PF.forEach((k) => { if (saved[k] && (k !== 'p_title' || isAsg)) f[k].value = saved[k]; });
  };
  if (hasMcq) f.querySelectorAll('[name=negmode]').forEach((r) => (r.onchange = () => {
    const on = f.querySelector('[name=negmode]:checked').value === 'yes';
    document.getElementById('negrow').hidden = !on;
    document.getElementById('negnote').hidden = !on;
  }));

  f.onsubmit = act(async () => {
    const paper = {
      title: f.p_title.value, programme: f.p_programme.value, session: f.p_session?.value || '', units: f.p_units?.value || '',
      instructions: f.p_instructions?.value || '', cos: f.p_cos.value, intro: f.p_intro?.value || '', max_marks: +f.p_max.value || null,
      parts: readParts(),
    };
    if (JSON.stringify(paper.parts) !== JSON.stringify(builtParts)) throw new Error('The paper structure changed. Press "Create question boxes" first.');
    try { localStorage.setItem(`cx-paper-${T}-${f.subject_id.value}`, JSON.stringify(Object.fromEntries(PF.map((k) => [k, f[k].value])))); } catch {}
    const questions = [...qs.querySelectorAll('.card.q')].map((b) => {
      const base = {
        kind: b.dataset.kind,
        qgroup: +b.dataset.qgroup,
        text: b.querySelector('[data-q=text]').value,
        max_marks: +b.querySelector('[data-q=max_marks]').value,
        co: b.querySelector('[data-q=co]').value,
        part: b.dataset.part,
        label: b.dataset.label,
        rbtl: +b.querySelector('[data-q=rbtl]').value || null,
      };
      if (base.kind === 'mcq') {
        const rows = [...b.querySelectorAll('.opt .rubric-row')];
        return {
          ...base,
          options: rows.map((r) => r.querySelector('[data-o=text]').value),
          correct_index: rows.findIndex((r) => r.querySelector('input[type=radio]').checked),
        };
      }
      return {
        ...base,
        model_answer: b.querySelector('[data-q=model_answer]').value,
        rubric: [...b.querySelectorAll('.rub .rubric-row')].map((r) => ({
          criterion: r.querySelector('[data-r=criterion]').value,
          marks: +r.querySelector('[data-r=marks]').value,
        })),
      };
    });
    const r = await api(existing ? 'PUT' : 'POST', existing ? `/assessments/${existing.id}` : '/assessments', {
      subject_id: +f.subject_id.value, section_ids: [...f.querySelectorAll('[name=section]:checked')].map((x) => +x.value), type: T,
      number: +f.number.value, duration_min: f.duration_min ? +f.duration_min.value : null,
      start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      release_mode: f.release_mode?.value, shuffle: f.shuffle.checked, option_shuffle: !!f.option_shuffle?.checked,
      negative: f.negative && f.querySelector('[name=negmode]:checked').value === 'yes' ? +f.negative.value : 0, questions, paper,
    });
    toast(existing ? 'Changes saved' : 'Saved as draft');
    location.hash = `#/a/${r.id}`;
  });

  // ---- questions from Excel: one row per question or sub-part ----
  const QCOLS = ['Part', 'Q.No', 'Sub-part', 'Type', 'Question', 'CO', 'RBTL', 'Marks', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct option', 'Model answer', 'Rubric'];
  document.getElementById('qtpl').onclick = act(async () => {
    await loadXLSX();
    const ex = K.q === 'mcq'
      ? [['', 1, '', 'MCQ', 'Which port does HTTPS use by default?', 'CO1', 'Remember', 1, '80', '443', '22', '21', 'B', '', '']]
      : [['A', 1, 'i', 'Written', 'Define the role of a cover object in a steganographic system.', 'CO1', 'Remember', 1, '', '', '', '', '', 'The cover object is the carrier medium that hides the secret message.', 'Correct definition=1'],
        ['B', 2, 'a', 'Written', 'Explain the working of a steganographic communication system with a block diagram (describe the diagram in words).', 'CO1', 'Understand', 5, '', '', '', '', '', 'Sender, cover object, embedding algorithm with key, stego object, channel, extraction at receiver.', 'Block diagram explained=2; Roles of each part=3']];
    const ws = XLSX.utils.aoa_to_sheet([QCOLS, ...ex]);
    ws['!cols'] = QCOLS.map((c) => ({ wch: c === 'Question' || c === 'Model answer' ? 50 : 12 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    XLSX.writeFile(wb, `COGNEXA_${T.replace(/\s+/g, '_')}_questions.xlsx`);
  });
  document.getElementById('qfile').onchange = act(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false })
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [slug(k), String(v).trim()])))
      .filter((r) => r.question);
    e.target.value = '';
    if (!rows.length) throw new Error('No questions found. Use the question template (a "Question" column is needed).');
    // Group: part → question number → sub-parts, in the order of the sheet.
    const parts = [];
    for (const [i, r] of rows.entries()) {
      const name = isAsg || K.q === 'mcq' ? (r.part || '') : (r.part || 'A');
      let p = parts.find((x) => x.name === name);
      if (!p) parts.push((p = { name, qs: [], kind: K.q === 'both' ? (/mcq/i.test(r.type) ? 'mcq' : 'descriptive') : K.q }));
      const qn = r.qno || String(i + 1);
      let q = p.qs.find((x) => x.qn === qn);
      if (!q) p.qs.push((q = { qn, subs: [] }));
      q.subs.push(r);
    }
    for (const p of parts) {
      const n = p.qs[0].subs.length;
      if (p.qs.some((q) => q.subs.length !== n)) throw new Error(`Part ${p.name || '(none)'}: every question needs the same number of sub-parts`);
      if (K.q === 'both' && p.qs.some((q) => q.subs.some((r) => (/mcq/i.test(r.type) ? 'mcq' : 'descriptive') !== p.kind))) throw new Error(`Part ${p.name}: mix of MCQ and written rows; keep each part one type`);
    }
    const prev = readParts();
    partsBody.innerHTML = '';
    parts.forEach((p) => {
      const old = prev.find((x) => x.name === p.name);
      const sub0 = String(p.qs[0].subs[0].subpart || '').toLowerCase();
      partRow({ name: p.name, kind: p.kind, questions: p.qs.length, subparts: p.qs[0].subs.length,
        style: /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(sub0.replace(/[().]/g, '')) && sub0.replace(/[().]/g, '') !== 'v' ? 'roman' : 'alpha',
        attempt: old && old.questions === p.qs.length ? old.attempt : p.qs.length });
    });
    qs.innerHTML = '';
    build();
    const flat = parts.flatMap((p) => p.qs.flatMap((q) => q.subs));
    const boxes = [...qs.querySelectorAll('.card.q')];
    const lv = (v) => { const t = String(v).toLowerCase(); const m2 = /(\d)\s*$/.exec(t); if (m2) return m2[1]; const i = RBT.findIndex((x) => x && x.toLowerCase() === t.replace('analyze', 'analyse')); return i > 0 ? String(i) : ''; };
    boxes.forEach((b, i) => {
      const r = flat[i];
      if (!r) return;
      b.querySelector('[data-q=text]').value = r.question;
      b.querySelector('[data-q=max_marks]').value = r.marks;
      const co = b.querySelector('[data-q=co]');
      const coV = String(r.co).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cos.some((c) => c.co === coV)) co.value = coV;
      b.querySelector('[data-q=rbtl]').value = lv(r.rbtl);
      if (b.dataset.kind === 'mcq') {
        const opts = [r.optiona, r.optionb, r.optionc, r.optiond].filter(Boolean);
        const rowsEl = [...b.querySelectorAll('.opt .rubric-row')];
        opts.forEach((o, k) => { if (rowsEl[k]) rowsEl[k].querySelector('[data-o=text]').value = o; });
        const ci = 'ABCD'.indexOf(String(r.correctoption).trim().toUpperCase()[0] || '');
        if (ci >= 0 && rowsEl[ci]) rowsEl[ci].querySelector('input[type=radio]').checked = true;
      } else {
        b.querySelector('[data-q=model_answer]').value = r.modelanswer;
        const rub = String(r.rubric || '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const k = x.lastIndexOf('='); return k > 0 ? { criterion: x.slice(0, k).trim(), marks: +x.slice(k + 1) } : null; }).filter(Boolean);
        if (rub.length) fillRubric(b, rub);
      }
    });
    sumMarks(); coCheck();
    const total = flat.reduce((s2, r) => s2 + (+r.marks || 0), 0);
    if (!+f.p_max.value) { f.p_max.value = bestTotal(builtParts, boxes.map((b) => ({ part: b.dataset.part, qgroup: +b.dataset.qgroup, m: +b.querySelector('[data-q=max_marks]').value || 0 })), 'm') || total; sumMarks(); }
    toast(`${flat.length} question(s) filled from Excel. Check them, then save.`);
  });

  // ---- editing a saved paper: put everything back into the form ----
  if (existing) {
    const P = paperInfo(existing);
    const lc = (d) => new Date(new Date(d) - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    f.number.value = existing.number;
    if (f.duration_min) f.duration_min.value = existing.duration_min;
    f.start_at.value = lc(existing.start_at); f.end_at.value = lc(existing.end_at);
    if (f.release_mode) f.release_mode.value = existing.release_mode;
    f.shuffle.checked = !!existing.shuffle;
    if (f.option_shuffle) f.option_shuffle.checked = !!existing.option_shuffle;
    if (hasMcq && existing.negative) {
      f.querySelector('[name=negmode][value=yes]').checked = true;
      document.getElementById('negrow').hidden = false; document.getElementById('negnote').hidden = false;
      f.negative.value = String(existing.negative);
    }
    ['title', 'programme', 'session', 'units', 'instructions', 'cos', 'intro'].forEach((k) => { if (f['p_' + k]) f['p_' + k].value = P[k] || ''; });
    titleTouched = true;
    f.p_max.value = P.max_marks || '';
    (existing.section_ids || []).forEach((id) => { const c = f.querySelector(`[name=section][value="${id}"]`); if (c) c.checked = true; });
    if (P.parts) { partsBody.innerHTML = ''; P.parts.forEach(partRow); qs.innerHTML = ''; build(); }
    const boxes = [...qs.querySelectorAll('.card.q')];
    existing.questions.forEach((q) => {
      const b = boxes.find((x) => x.dataset.part === (q.part || '') && x.dataset.label === q.label) || boxes[q.seq - 1];
      if (!b) return;
      b.querySelector('[data-q=text]').value = q.text;
      b.querySelector('[data-q=max_marks]').value = q.max_marks;
      b.querySelector('[data-q=co]').innerHTML = coOpts(q.co || '');
      b.querySelector('[data-q=rbtl]').value = q.rbtl || '';
      if (q.kind === 'mcq') {
        const opt = b.querySelector('.opt');
        const grp = opt.querySelector('input[type=radio]').name;
        opt.innerHTML = '';
        q.options.forEach((o, k) => { const row = optionRow(grp); row.querySelector('[data-o=text]').value = o; if (k === q.correct_index) row.querySelector('input[type=radio]').checked = true; opt.append(row); });
      } else {
        b.querySelector('[data-q=model_answer]').value = q.model_answer;
        fillRubric(b, q.rubric);
      }
    });
    sumMarks(); coCheck();
  }
}

// CO coverage rule: every CO used needs at least one question at the CO's own (highest) Bloom level.
function coAlerts(cos, list) {
  const out = [];
  for (const c of cos) {
    const mine = list.filter((q) => q.co === c.co);
    if (!mine.length) continue;
    const top = Math.max(...mine.map((q) => q.rbtl || 0));
    if (top < c.rbtl) out.push(`${c.co} is at ${RBT[c.rbtl]} level, but its highest question is ${top ? RBT[top] : 'not given a level'}.`);
  }
  const unused = cos.filter((c) => !list.some((q) => q.co === c.co)).map((c) => c.co);
  if (unused.length && list.some((q) => q.co)) out.push(`Not covered in this paper: ${unused.join(', ')} (fine if planned for another test).`);
  return out;
}

const attemptPill = (t) => {
  if (t.status === 'in_progress') return '<span class="pill">Writing</span>';
  if (t.failed) return '<span class="pill bad">Evaluation failed</span>';
  if (t.status === 'submitted') return '<span class="pill warn">Evaluating</span>';
  if (t.status === 'evaluated') return '<span class="pill warn">Awaiting approval</span>';
  return '<span class="pill ok">Result published</span>';
};

async function viewAssessment(id) {
  const seq = nav_seq;
  const a = await api('GET', `/assessments/${id}`);
  if (seq !== nav_seq) return;
  const total = paperMaxOf(a);
  const sheet = await api('GET', `/assessments/${id}/marks`);
  if (seq !== nav_seq) return;
  app.innerHTML = `<div class="between"><h1>${title(a)}</h1>
      ${a.status !== 'draft' ? '<span class="pill ok">Published</span>' : a.can.edit && (!['Mid Term', 'Sessional', 'Assignment', 'Hybrid'].includes(a.type) || a.stage === 'approved') ? '<button id="pub">Publish to students</button>' : '<span class="pill warn">Not published</span>'}</div>
    ${a.status === 'published' && a.type !== 'Assignment' ? '<div class="card" id="startcode"></div>' : ''}
    <div class="card" id="moderation"></div>
    <div class="card"><div class="muted">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(total)} marks ·
      Result release: <b>${a.release_mode === 'instant' ? 'Instant' : 'After faculty approval'}</b>${a.shuffle ? ' · Question order shuffled per student' : ''}${a.option_shuffle ? ' · MCQ options shuffled' : ''}${a.negative ? ` · Negative marking: ${({ 0.25: '¼', 0.33: '⅓', 0.5: '½', 1: 'full' })[a.negative] || a.negative} of the question's marks per wrong MCQ` : ''}</div>
      <div class="muted">Sections: ${a.sections.length ? a.sections.map(esc).join(', ') : 'All students'}</div>
      <p class="downloads"><b class="small">Download for records:</b> <a class="btn ghost" href="#/print/report/${a.id}">Assessment report</a>
        <a class="btn ghost" href="#/print/paper/${a.id}">Question paper</a> <a class="btn ghost" href="#/print/key/${a.id}">Paper with answer key and rubric</a>
        <a class="btn ghost" href="#/print/sheets/${a.id}">All evaluated answer sheets</a></p>
      ${a.attempts.length || !a.can.edit ? '' : `<p class="downloads">${['draft', 'changes'].includes(a.stage || 'draft') ? `<a class="btn ghost" href="#/edit/${a.id}">Edit paper</a> ` : ''}<button type="button" class="ghost small danger" id="delassess">Delete this assessment</button> <span class="muted small">Possible only until a student starts it.</span></p>`}</div>
    <div class="card" id="analysis"></div>
    <div class="card"><h2>Submissions</h2>
      ${a.attempts.length ? `<table><thead><tr><th>Roll no</th><th>Student</th><th>Status</th><th>Draft marks</th><th>Final</th><th>Tab switches</th><th>Paste tries</th><th></th></tr></thead><tbody>
      ${a.attempts.map((t) => `<tr><td>${esc(t.roll_no)}</td><td>${esc(t.name)}</td><td>${attemptPill(t)}${t.low ? ' <span class="pill warn">Low confidence</span>' : ''}</td>
        <td>${num(t.llm_total)}</td><td>${t.status === 'published' ? num(t.final_total) : '–'}</td><td>${t.tab_switches}</td><td>${t.paste_attempts}</td>
        <td class="right">${t.status === 'in_progress' ? '' : `<a class="btn ghost" href="#/review/${t.id}">${a.can.approve ? 'Review' : 'View'}</a>`}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No student has started yet.</p>'}</div>
    <div class="card"><div class="between"><h2>Question paper</h2><label class="choice" style="margin:0"><input type="checkbox" id="showkey"> Show answer key and rubric</label></div>
      <div class="paper-preview" id="paperprev"></div></div>`;
  const inst = await api('GET', '/settings');
  if (seq !== nav_seq) return;
  const pp = document.getElementById('paperprev');
  const drawPaper = () => (pp.innerHTML = paperDoc(a, inst, document.getElementById('showkey').checked));
  document.getElementById('showkey').onchange = drawPaper;
  drawPaper();
  drawAnalysis(document.getElementById('analysis'), a, sheet);
  const del = document.getElementById('delassess');
  if (del) del.onclick = act(async () => {
    if (!(await ask(`Delete ${a.type} ${a.number} (${a.subject_code}) with all its questions? This cannot be undone.`, { ok: 'Delete' }))) return;
    await api('DELETE', `/assessments/${id}`);
    toast('Assessment deleted');
    location.hash = '#/';
  });
  drawModeration(document.getElementById('moderation'), a, () => viewAssessment(id)).catch((e) => toast(e.message, true));
  const sc = document.getElementById('startcode');
  if (sc) {
    const show = async () => {
      if (!document.body.contains(sc)) return;
      const c = await api('GET', `/assessments/${id}/start-code`).catch(() => null);
      if (!c || !c.code) return sc.remove();
      const left = () => Math.max(0, Math.round((Date.parse(c.changes_at) - Date.now()) / 1000));
      sc.innerHTML = `<div class="between"><div><h2>Start code for the lab</h2><p class="small muted">Read it out to the students. It changes every ${c.minutes} minutes; the previous code keeps working for one more turn.</p></div>
        <div style="text-align:right"><div class="startcode">${esc(c.code)}</div><div class="small muted" id="sctime"></div></div></div>`;
      const t = setInterval(() => { const el = document.getElementById('sctime'); if (!el) return clearInterval(t); const l = left(); el.textContent = `Next code in ${Math.floor(l / 60)}:${String(l % 60).padStart(2, '0')}`; if (!l) { clearInterval(t); show(); } }, 1000);
    };
    show();
  }
  const pub = document.getElementById('pub');
  if (pub) pub.onclick = act(async () => {
    await api('POST', `/assessments/${id}/publish`);
    toast('Published');
    viewAssessment(id);
  });
}

// Figures shared by the analysis card and the printed report. Uses published results only.
function analyse(sheet) {
  const n = sheet.students.length;
  const qs = sheet.questions;
  const maxTotal = sheet.max_marks || qs.reduce((s, q) => s + q.max_marks, 0);
  const totals = sheet.students.map((st) => bestTotal(sheet.parts, qs.map((q) => ({ part: q.part, qgroup: q.qgroup, m: st.marks[q.id] ?? 0 })), 'm'));
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const cos = [...new Set(qs.map((q) => q.co).filter(Boolean))].sort();
  const qRows = () => qs.map((q) => {
    const m = avg(sheet.students.map((st) => st.marks[q.id] ?? 0));
    return `<tr><td>${esc(q.label || `Q${q.seq}`)}</td><td>${esc(q.co || '–')}</td><td>${num(q.max_marks)}</td><td>${num(m)}</td><td>${pct(m / q.max_marks)}</td></tr>`;
  }).join('');
  const coRows = (target) => cos.map((co) => {
    const mine = qs.filter((q) => q.co === co);
    const max = mine.reduce((s, q) => s + q.max_marks, 0);
    const scores = sheet.students.map((st) => mine.reduce((s, q) => s + (st.marks[q.id] ?? 0), 0) / max);
    const reached = scores.filter((x) => x * 100 >= target).length;
    return `<tr><td>${esc(co)}</td><td>${mine.map((q) => `Q${q.seq}`).join(', ')}</td><td>${pct(avg(scores))}</td><td>${reached} of ${n} (${pct(reached / n)})</td></tr>`;
  }).join('');
  return { n, qs, maxTotal, totals, avg, cos, qRows, coRows };
}

// Class analysis from published results only. The CO attainment target is the faculty's own setting, not a fixed rule.
function drawAnalysis(box, a, sheet) {
  const n = sheet.students.length;
  if (!n) {
    box.innerHTML = '<h2>Analysis</h2><p class="muted">Appears once at least one result is published.</p>';
    return;
  }
  const { qs, maxTotal, totals, avg, cos, qRows, coRows } = analyse(sheet);

  box.innerHTML = `<div class="between"><h2>Analysis <span class="muted small">(${n} published result${n > 1 ? 's' : ''})</span></h2><button class="ghost small" id="csv">Download marks (CSV)</button></div>
    <div class="row stats"><div><div class="muted small">Class average</div><div class="score">${num(avg(totals))} / ${num(maxTotal)}</div></div>
      <div><div class="muted small">Highest</div><div class="score">${num(Math.max(...totals))}</div></div>
      <div><div class="muted small">Lowest</div><div class="score">${num(Math.min(...totals))}</div></div></div>
    <h3>Question-wise</h3>
    <table><thead><tr><th>Question</th><th>CO</th><th>Max</th><th>Average</th><th>Average %</th></tr></thead><tbody>${qRows()}</tbody></table>
    ${cos.length ? `<h3 style="margin-top:14px">CO-wise <span class="muted small">· a student reaches a CO at <input id="target" type="number" min="1" max="100" value="${coTarget}" style="display:inline-block;width:70px;margin:0 4px">% or more of its marks</span></h3>
    <table><thead><tr><th>CO</th><th>Questions</th><th>Average %</th><th>Students at or above target</th></tr></thead><tbody id="cobody">${coRows(coTarget)}</tbody></table>`
      : '<p class="muted small">Add a CO to the questions to see CO-wise figures.</p>'}`;

  const target = document.getElementById('target');
  if (target) target.oninput = () => {
    const t = +target.value;
    if (t >= 1 && t <= 100) document.getElementById('cobody').innerHTML = coRows((coTarget = t));
  };
  document.getElementById('csv').onclick = () => {
    const cell = (v) => {
      let x = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; // stop spreadsheet apps treating text as a formula
      return `"${x.replace(/"/g, '""')}"`;
    };
    const lines = [
      ['Section', 'Roll no', 'Name', ...qs.map((q) => `Q${q.seq}${q.co ? ` (${q.co})` : ''} /${q.max_marks}`), `Total /${maxTotal}`],
      ...sheet.students.map((st, i) => [st.section, st.roll_no, st.name, ...qs.map((q) => st.marks[q.id] ?? 0), totals[i]]),
    ].map((r) => r.map((v) => (typeof v === 'number' ? v : cell(v))).join(','));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    link.download = `${a.subject_code}_${a.type}_${a.number}_marks.csv`.replace(/\s+/g, '_');
    link.click();
    URL.revokeObjectURL(link.href);
  };
}

async function viewReview(id) {
  const seq = nav_seq;
  const t = await api('GET', `/attempts/${id}`);
  if (seq !== nav_seq) return;
  const pending = t.answers.some((a) => a.eval_status !== 'done');
  app.innerHTML = `<p class="between"><a href="#/a/${t.assessment_id}">← Back to submissions</a><a class="btn ghost" href="#/print/sheet/${t.id}">Download this answer sheet</a></p>
    <div class="between"><h1>${esc(t.student_name)} <span class="muted">(${esc(t.roll_no)})</span></h1>${attemptPill({ ...t, failed: t.answers.some((a) => a.eval_status === 'failed') })}</div>
    <p class="muted">${title(t)} · Tab switches: ${t.tab_switches} · Paste attempts: ${t.paste_attempts}</p>
    ${pending ? `<div class="note warn">Some answers are not evaluated yet. ${t.can_approve ? '<button class="small" id="rerun">Run evaluation now</button>' : ''}</div>` : ''}
    ${t.status === 'published' ? '<div class="note">This result is published. Saving again updates what the student sees.</div>' : ''}
    ${t.can_approve && !pending && t.answers.some((a) => a.kind !== 'mcq') ? '<p class="no-print"><button type="button" class="ghost small" id="redo">Re-run LLM evaluation</button> <span class="muted small">Replaces the LLM draft for typed answers. Marks you have already approved stay as they are until you change them.</span></p>' : ''}
    <form id="f">${t.answers.map((a) => `<div class="card" data-id="${a.id}">
      <div class="between"><h2>${qno(a)}${a.co ? ` · ${esc(a.co)}` : ''}</h2><span class="pill">${num(a.max_marks)} marks</span></div>
      <div class="answer">${esc(a.qtext)}</div>
      <h3>Student answer</h3>${a.kind === 'mcq' ? optionList(a.options, a.text, a.correct_index)
        : `<div class="answer">${a.text.trim() ? esc(a.text) : '<span class="muted">Not attempted</span>'}</div>`}
      ${(t.rechecks || []).filter((r) => r.seq === a.seq).map((r) => `<div class="note ${r.status === 'open' ? 'warn' : ''}"><b>Re-check ${r.status === 'open' ? 'asked by the student' : r.status}</b> (${fmt(r.created_at)}): ${esc(r.reason)}
        ${r.status === 'open' && t.can_approve ? `<div class="row" style="margin-top:8px"><label style="flex:3 1 260px">Reply to the student<input data-rr="${r.id}" placeholder="Explain the marks, or what you changed"></label>
          <label style="max-width:150px">New marks (if accepted)<input type="number" step="any" data-rm="${r.id}" value="${a.final_marks ?? ''}"></label>
          <p><button type="button" class="small" data-acc="${r.id}">Accept</button> <button type="button" class="ghost small" data-rej="${r.id}">Explain and keep marks</button></p></div>`
          : r.response ? `<br>Reply: ${esc(r.response)}${r.new_marks !== null ? ` (marks ${num(r.old_marks)} → ${num(r.new_marks)})` : ''}` : ''}</div>`).join('')}
      ${a.eval_status === 'failed' ? `<div class="note bad">Evaluation failed: ${esc(a.eval_error)}</div>` : ''}
      ${a.llm && a.kind === 'mcq' ? `<h3>Auto-checked: ${num(a.llm_marks)} / ${num(a.max_marks)}</h3>` : a.llm ? `<h3>LLM draft: ${num(a.llm_marks)} / ${num(a.max_marks)} <span class="pill ${a.llm_confidence === 'low' ? 'warn' : 'ok'}">${esc(a.llm_confidence)} confidence</span></h3>
        <table><thead><tr><th>Criterion</th><th>Marks</th><th>Justification</th></tr></thead><tbody>${a.llm.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${why(c)}</td></tr>`).join('')}</tbody></table>
        ${a.llm.missing_points.length ? `<h3>Missing points</h3><ul class="tight">${a.llm.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.llm.improvements.length ? `<h3>Suggested improvements</h3><ul class="tight">${a.llm.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}` : ''}
      ${a.kind === 'mcq' ? '' : `<details><summary class="muted small">Model answer</summary><div class="answer">${esc(a.model_answer)}</div></details>`}
      <div class="row"><label>Final marks (up to ${num(a.max_marks)})<input type="number" step="${a.kind === 'mcq' ? 'any' : '0.5'}" min="${a.kind === 'mcq' ? -a.max_marks : 0}" max="${a.max_marks}" data-f="marks" value="${a.final_marks ?? a.llm_marks ?? ''}" required></label>
        <label style="flex:3 1 300px">Faculty remark (optional, shown to student)<input data-f="remark" value="${esc(a.faculty_remark || '')}"></label></div>
      </div>`).join('')}
    ${t.can_approve ? `<p><button>${t.status === 'published' ? 'Update published result' : 'Approve and publish result'}</button></p>` : '<p class="muted">You can view this answer sheet. Approving results needs the approval right.</p>'}</form>`;
  const answerRc = (rid, status) => act(async () => {
    const response = app.querySelector(`[data-rr="${rid}"]`).value;
    await api('POST', `/rechecks/${rid}`, { status, response, marks: +app.querySelector(`[data-rm="${rid}"]`).value });
    toast(status === 'accepted' ? 'Marks updated and the student told' : 'Reply sent'); viewReview(id);
  });
  app.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = answerRc(b.dataset.acc, 'accepted')));
  app.querySelectorAll('[data-rej]').forEach((b) => (b.onclick = answerRc(b.dataset.rej, 'rejected')));
  const rerun = document.getElementById('rerun');
  if (rerun) rerun.onclick = act(async () => {
    toast('Evaluating…');
    await api('POST', `/attempts/${id}/evaluate`);
    viewReview(id);
  });
  const redo = document.getElementById('redo');
  if (redo) redo.onclick = act(async () => {
    toast('Evaluating again…');
    await api('POST', `/attempts/${id}/evaluate?force=1`);
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

// Institute header for printed documents (empty until the admin fills in the institute details).
const letterhead = (inst) => (inst.letterhead ? `<div class="letterhead lh-img"><img src="${esc(inst.letterhead)}" alt=""></div>` : inst.institute || inst.logo
  ? `<div class="letterhead">${inst.logo ? `<img src="${esc(inst.logo)}" alt="">` : ''}<div><div class="inst-name">${esc(inst.institute)}</div>${inst.line ? `<div>${esc(inst.line)}</div>` : ''}</div></div>` : '');

// ---------- question paper in the institute's own format ----------
const RBT = ['', 'Remember', 'Understand', 'Apply', 'Analyse', 'Evaluate', 'Create'];
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
// Question text: **bold** is the only markup; line breaks are kept.
const rich = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const lines = (t) => (t || '').split('\n').map((x) => x.trim()).filter(Boolean);
const coLine = (l) => { const i = l.indexOf(':'); return i > 0 && i < 12 ? `<b>${esc(l.slice(0, i + 1))}</b>${esc(l.slice(i + 1))}` : esc(l); };
const dmy = (d) => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}`; };

function paperDoc(a, inst, key) {
  const P = paperInfo(a);
  const max = paperMaxOf(a);
  const F = inst.format || {};
  const asgF = a.type === 'Assignment';
  const taxHead = asgF ? F.tax_asg || 'R. Bloom Taxonomy Level' : F.tax_exam || 'RBTL';
  const taxStyle = asgF ? F.tax_asg_style || 'name' : F.tax_exam_style || 'code';
  const tax = (n) => (!n ? '' : taxStyle === 'name' ? RBT[n] : `${F.tax_code || 'RBTL'}-${n}`);
  const signs = (asgF ? F.sign_asg || '' : F.sign_exam ?? 'Faculty Name and Sign. | HOD Sign.').split('|').map((x) => x.trim()).filter(Boolean);
  const signHtml = signs.length ? `<div class="signs">${signs.map((x) => `<b>${esc(x)}</b>`).join('')}</div>` : '';
  const partOf = (name) => (P.parts || []).find((p) => p.name === name);
  const choiceLine = (name) => { const p = partOf(name); return p && p.attempt < p.questions ? `<p class="choice-note">Attempt any ${p.attempt} of the ${p.questions} questions.</p>` : ''; };
  const cos = lines(P.cos);
  const keyRows = (q, span) => !key ? '' : `<tr class="keyrow"><td></td><td colspan="${span}">${q.kind === 'mcq'
    ? `<b>Answer:</b> (${String.fromCharCode(97 + q.correct_index)}) ${esc(q.options[q.correct_index])}`
    : `<b>Model answer / key points:</b><div class="pre">${esc(q.model_answer)}</div><b>Rubric:</b> ${q.rubric.map((r) => `${esc(r.criterion)} (${num(r.marks)})`).join('; ')}`}</td></tr>`;
  const qtext = (q) => `<div class="pre">${rich(q.text)}</div>${q.kind === 'mcq' ? `<div class="opts">${q.options.map((o, i) => `<span>(${String.fromCharCode(97 + i)}) ${esc(o)}</span>`).join('')}</div>` : ''}`;
  const keyNote = key ? '<p class="keynote">Answer key and rubric (for faculty records, not for students)</p>' : '';

  if (a.type === 'Assignment') {
    return `<section class="doc pdoc asg">${letterhead(inst)}${keyNote}
      <h2 class="atitle">Assignment No – ${esc(a.number)}${P.title ? `: ${esc(P.title)}` : ''}</h2>
      <div class="agrid">
        <div><b>Program:</b> ${esc(P.programme || '')}</div><div class="r"><b>Session:</b> ${esc(P.session || '')}</div>
        <div><b>Date of Issue:</b> ${dmy(a.start_at)}</div><div class="r"><b>Date of Submission:</b> ${dmy(a.end_at)}</div>
        <div><b>Course:</b> ${esc(a.subject_name)}</div><div class="r"><b>Course Code:</b> ${esc(a.subject_code)}</div>
        <div><b>Course unit included:</b> ${esc(P.units || '')}</div><div class="r"><b>Max. Marks:</b> ${num(max)}</div></div>
      <hr class="dash">
      ${cos.length ? `<p><b><u>Course Outcomes:</u></b></p>${cos.map((l) => `<p>${coLine(l)}</p>`).join('')}` : ''}
      ${P.intro ? `<div class="pre intro">${rich(P.intro)}</div>` : ''}
      <table class="ptable"><thead><tr><th style="width:9%">S. No.</th><th>Questions</th><th style="width:11%">Course Outcome</th><th style="width:13%">${esc(taxHead)}</th><th style="width:8%">Marks</th></tr></thead>
      <tbody>${a.questions.map((q) => `<tr><td class="c">${esc(q.label || `Q${q.seq}`)}</td><td>${qtext(q)}</td><td class="c">${esc(q.co)}</td><td class="c">${tax(q.rbtl)}</td><td class="c">${num(q.max_marks)}</td></tr>${keyRows(q, 4)}`).join('')}</tbody></table>
      ${signHtml}</section>`;
  }

  const instr = lines(P.instructions);
  if (a.negative) instr.push(`Wrong MCQ answers carry negative marking (${({ 0.25: '¼', 0.33: '⅓', 0.5: '½', 1: 'full' })[a.negative] || a.negative} of the question's marks). Unattempted questions carry no penalty.`);
  // Consecutive questions with the same part form one PART table.
  const groups = [];
  a.questions.forEach((q) => { const g = groups[groups.length - 1]; if (g && g.part === (q.part || '')) g.qs.push(q); else groups.push({ part: q.part || '', qs: [q] }); });
  return `<section class="doc pdoc exam">${letterhead(inst)}${keyNote}
    ${F.roll === false ? '' : '<div class="roll">Roll No. …………………</div>'}
    <div class="ehead"><b>${esc(P.title || `${a.type} ${a.number}`)}</b>${P.programme ? `<br><b>${esc(P.programme)}</b>` : ''}<br><b>Subject: ${esc(a.subject_name)} (${esc(a.subject_code)})</b></div>
    <div class="between"><b>Time: ${a.duration_min} Minutes</b><b>[Max Marks: ${num(max)}]</b></div>
    ${instr.length ? `<p class="ins"><b>Instructions:</b></p>${instr.map((l, i) => `<p class="ins">${/^\d+[.)]/.test(l) ? esc(l) : `${i + 1}. ${esc(l)}`}</p>`).join('')}` : ''}
    ${cos.length ? `<div class="cos">${cos.map((l) => `<p>${coLine(l)}</p>`).join('')}</div>` : ''}
    ${groups.map((g) => `${g.part ? `<h2 class="partname">PART-${esc(g.part)}</h2>` : ''}${choiceLine(g.part)}
      <table class="ptable"><thead><tr><th style="width:9%">Q.N.</th><th>Question</th><th style="width:8%">CO</th><th style="width:11%">${esc(taxHead)}</th><th style="width:7%">Marks</th></tr></thead>
      <tbody>${g.qs.map((q, i) => `<tr><td class="c">${esc(q.label || `${q.seq}.`)}</td><td>${qtext(q)}</td><td class="c">${esc(q.co)}</td><td class="c">${tax(q.rbtl)}</td><td class="c">${num(q.max_marks)}</td></tr>${keyRows(q, 4)}`).join('')}</tbody></table>`).join('')}
    ${signHtml}
  </section>`;
}

// ---------- printable documents (faculty) ----------
// Each page is laid out for A4. "Print / Save as PDF" opens the browser's print dialog, where
// "Save as PDF" gives a file for the course file or accreditation records.

function answerSheet(t, head = '') {
  const final = t.status === 'published';
  const got = t.total ?? t.answers.reduce((s, a) => s + ((final ? a.final_marks : a.llm_marks) ?? 0), 0);
  const max = t.max ?? t.answers.reduce((s, a) => s + a.max_marks, 0);
  return `<section class="doc">${head}<h1>Evaluated Answer Sheet</h1>
    <table class="meta"><tbody><tr><th>Assessment</th><td>${title(t)}</td><th>Student</th><td>${esc(t.student_name)}</td></tr>
      <tr><th>Submitted</th><td>${t.submitted_at ? fmt(t.submitted_at) : '–'}</td><th>Roll no</th><td>${esc(t.roll_no)}</td></tr>
      <tr><th>${final ? 'Marks awarded' : 'Draft marks'}</th><td><b>${num(got)} / ${num(max)}</b>${final ? '' : ' (not yet approved by faculty)'}</td><th>Tab switches / paste tries</th><td>${t.tab_switches} / ${t.paste_attempts}</td></tr></tbody></table>
    ${t.answers.map((a) => {
      const marks = final ? a.final_marks : a.llm_marks;
      const moderated = final && a.llm_marks !== null && Math.abs(a.final_marks - a.llm_marks) > 1e-9;
      return `<div class="qblock"><div class="between"><h3>${qno(a)}${a.co ? ` (${esc(a.co)})` : ''}. ${esc(a.qtext)}</h3><b class="nowrap">${num(marks)} / ${num(a.max_marks)}${a.counted === false ? ' <span class="pill">not counted</span>' : ''}</b></div>
        ${a.kind === 'mcq' ? optionList(a.options, a.text, a.correct_index) : `<div class="answer">${a.text.trim() ? esc(a.text) : 'Not attempted'}</div>`}
        ${a.kind !== 'mcq' && a.llm ? `<table><thead><tr><th>Rubric criterion</th><th>${moderated ? 'Draft marks' : 'Marks'}</th><th>Justification</th></tr></thead><tbody>${a.llm.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td class="nowrap">${num(c.awarded)} / ${num(c.max)}</td><td>${why(c)}</td></tr>`).join('')}</tbody></table>
          ${moderated ? `<p class="small">Draft total ${num(a.llm_marks)} was moderated by the faculty to ${num(a.final_marks)}.</p>` : ''}
          ${a.llm.missing_points.length ? `<p class="small"><b>Missing points:</b> ${a.llm.missing_points.map(esc).join('; ')}</p>` : ''}
          ${a.llm.improvements.length ? `<p class="small"><b>Suggested improvements:</b> ${a.llm.improvements.map(esc).join('; ')}</p>` : ''}` : ''}
        ${a.faculty_remark ? `<p class="small"><b>Faculty remark:</b> ${esc(a.faculty_remark)}</p>` : ''}</div>`;
    }).join('')}
    <p class="sign">Faculty signature: ____________________</p></section>`;
}

async function viewPrint(kind, id) {
  const seq = nav_seq;
  const head = letterhead(await api('GET', '/settings'));
  let html = '';
  let back = `#/a/${id}`;
  const meta = (a, total) => `<table class="meta"><tbody>
      <tr><th>Subject</th><td>${esc(a.subject_name)} (${esc(a.subject_code)})</td><th>Assessment</th><td>${esc(a.type)} ${esc(a.number)}</td></tr>
      <tr><th>Sections</th><td>${a.sections.length ? a.sections.map(esc).join(', ') : 'All students'}</td><th>Maximum marks</th><td>${num(total)}</td></tr>
      <tr><th>Window</th><td>${fmt(a.start_at)} to ${fmt(a.end_at)}</td><th>Duration</th><td>${a.duration_min} minutes</td></tr></tbody></table>`;

  if (kind === 'sheet') {
    const t = await api('GET', `/attempts/${id}`);
    back = `#/review/${id}`;
    html = answerSheet(t, head);
  } else {
    const a = await api('GET', `/assessments/${id}`);
    const total = paperMaxOf(a);
    if (kind === 'a51') {
      html = a51Doc(a, await api('GET', `/assessments/${id}/moderation`), head);
    } else if (kind === 'paper' || kind === 'key') {
      html = paperDoc(a, await api('GET', '/settings'), kind === 'key');
    } else if (kind === 'sheets') {
      const done = a.attempts.filter((t) => t.status === 'published');
      const sheets = [];
      for (const t of done) {
        sheets.push(answerSheet(await api('GET', `/attempts/${t.id}`), head));
        if (seq !== nav_seq) return;
      }
      html = sheets.join('') || '<section class="doc">' + head + '<h1>Evaluated Answer Sheets</h1><p>No results are published yet.</p></section>';
    } else {
      const sheet = await api('GET', `/assessments/${id}/marks`);
      const x = analyse(sheet);
      const started = a.attempts.length;
      const submitted = a.attempts.filter((t) => t.status !== 'in_progress').length;
      html = `<section class="doc">${head}<h1>Assessment Report</h1>${meta(a, total)}
        <table class="meta"><tbody><tr><th>Faculty</th><td>${esc(user.name)}</td><th>Result release</th><td>${a.release_mode === 'instant' ? 'Instant' : 'After faculty approval'}</td></tr>
          <tr><th>Students started / submitted</th><td>${started} / ${submitted}</td><th>Results published</th><td>${x.n}</td></tr></tbody></table>
        ${x.n ? `<h2>1. Class performance</h2>
          <table><thead><tr><th>Class average</th><th>Highest</th><th>Lowest</th></tr></thead><tbody><tr><td>${num(x.avg(x.totals))} / ${num(x.maxTotal)}</td><td>${num(Math.max(...x.totals))}</td><td>${num(Math.min(...x.totals))}</td></tr></tbody></table>
          <h2>2. Question-wise performance</h2>
          <table><thead><tr><th>Question</th><th>CO</th><th>Max</th><th>Average</th><th>Average %</th></tr></thead><tbody>${x.qRows()}</tbody></table>
          <h2>3. CO-wise performance</h2>
          ${x.cos.length ? `<p class="small">Target set by faculty: a student reaches a CO at ${coTarget}% or more of that CO's marks.</p>
            <table><thead><tr><th>CO</th><th>Questions</th><th>Average %</th><th>Students at or above target</th></tr></thead><tbody>${x.coRows(coTarget)}</tbody></table>` : '<p class="small">No CO was mapped to the questions.</p>'}
          <h2>4. Marks sheet</h2>
          <table><thead><tr><th>S.No.</th><th>Section</th><th>Roll no</th><th>Name</th>${x.qs.map((q) => `<th>Q${q.seq} (${num(q.max_marks)})</th>`).join('')}<th>Total (${num(x.maxTotal)})</th></tr></thead>
            <tbody>${sheet.students.map((st, i) => `<tr><td>${i + 1}</td><td>${esc(st.section ?? '–')}</td><td>${esc(st.roll_no)}</td><td>${esc(st.name)}</td>${x.qs.map((q) => `<td>${num(st.marks[q.id] ?? 0)}</td>`).join('')}<td><b>${num(x.totals[i])}</b></td></tr>`).join('')}</tbody></table>`
          : '<p>No results are published yet, so there are no figures to report.</p>'}
        <p class="sign">Faculty signature: ____________________ &nbsp;&nbsp; HOD signature: ____________________</p></section>`;
    }
  }
  if (seq !== nav_seq) return;
  app.innerHTML = `<div class="between no-print printbar"><a href="${back}">← Back</a>
      <span><span class="muted small">In the print dialog choose "Save as PDF".</span> <button onclick="window.print()">Print / Save as PDF</button></span></div>
    <div class="paper">${html}<p class="genline">Generated by COGNEXA on ${fmt(new Date().toISOString())}</p></div>`;
}

// ---------- student ----------

async function viewStudentHome() {
  const seq = nav_seq;
  const list = await api('GET', '/my/assessments');
  if (seq !== nav_seq) return;
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

// ---------- student: the test (computer-based-test layout, like JEE/NTA) ----------

const isPhone = () => window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;

async function viewAttempt(assessmentId) {
  const seq = nav_seq;
  const list = await api('GET', '/my/assessments');
  if (seq !== nav_seq) return;
  const meta = list.find((x) => x.id === assessmentId) || {};
  const lab = meta.type !== 'Assignment'; // lab tests: start code, full screen, computers only
  if (lab && isPhone()) {
    app.innerHTML = '<div class="card narrow"><h1>Use a lab computer</h1><p>This test can be taken only on a laptop or desktop computer in the lab, not on a phone or tablet.</p><a class="btn" href="#/">Back</a></div>';
    return;
  }
  // Gate: the student enters the code the faculty reads out; the click also starts full screen.
  app.innerHTML = `<div class="card narrow"><h1>${esc(meta.type || 'Test')} ${meta.number ?? ''} · ${esc(meta.subject_code || '')}</h1>
    <p class="muted">${esc(meta.subject_name || '')}${meta.duration_min ? ` · ${meta.duration_min} minutes` : ''}</p>
    <ul class="tight small"><li>Answers are saved every 10 seconds. If the computer stops, log in on another one and continue.</li>
      ${lab ? '<li>The test opens in full screen. Leaving full screen or switching windows is recorded for your faculty.</li>' : ''}
      <li>Type your answers yourself; pasting is blocked.</li></ul>
    <form id="gate">${lab ? '<label>Start code (your faculty will tell you)<input name="code" maxlength="4" autocomplete="off" required style="font:600 24px/1 var(--sans);letter-spacing:.3em;text-transform:uppercase;max-width:180px"></label>' : ''}
      <button>${meta.attempt_status === 'in_progress' ? 'Continue the test' : 'Start the test'}</button></form></div>`;
  document.getElementById('gate').onsubmit = act(async (e) => {
    if (lab && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen().catch(() => {});
    try {
      const d = await api('POST', `/assessments/${assessmentId}/start`, lab ? { code: e.target.code.value } : {});
      runTest(d, lab);
    } catch (err) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      throw err;
    }
  });
}

function runTest(d, lab) {
  const skew = Date.parse(d.server_now) - Date.now(); // the server's clock drives the timer
  const deadline = Date.parse(d.deadline_at);
  let tabSwitches = 0, pasteAttempts = 0, dirty = false, done = false, cur = 0;
  const Q = d.questions;
  const state = Q.map((q) => ({ visited: false, review: false }));
  const ans = (q) => (q.kind === 'mcq' ? document.querySelector(`[data-mcq="${q.id}"] input:checked`)?.value ?? '' : document.querySelector(`textarea[data-q="${q.id}"]`).value);
  app.innerHTML = `<div class="attempt-bar between"><b>${title(d.assessment)}</b>
      <span><span class="muted small" id="saved"></span> &nbsp; Time left: <span class="timer" id="timer"></span></span></div>
    ${(d.assessment.parts || []).map((p) => `<div class="note small">${p.name ? `PART-${esc(p.name)}: ` : ''}attempt any ${p.attempt} of the ${p.questions} questions. If you answer more, your best ${p.attempt} are counted.</div>`).join('')}
    <div class="cbt">
      <form id="f" class="card cbt-q" onsubmit="return false">${Q.map((q, i) => `<section data-i="${i}" hidden>
        <div class="between"><h2>${qno(q)}</h2><span class="pill">${num(q.max_marks)} mark${q.max_marks === 1 ? '' : 's'}</span></div>
        <div class="answer">${esc(q.text)}</div>
        ${q.kind === 'mcq' ? `<div class="mcq" data-mcq="${q.id}">${(q.order || q.options.map((_, k) => k)).map((k, pos) => `<label class="choice"><input type="radio" name="q${q.id}" value="${k}"${/^\d+$/.test(q.answer) && +q.answer === k ? ' checked' : ''}> ${String.fromCharCode(65 + pos)}. ${esc(q.options[k])}</label>`).join('')}</div>`
          : `<div class="between"><span class="small muted">Your answer</span><label class="small" style="margin:0"><input type="checkbox" data-code="${q.id}" style="width:auto;display:inline"> Code / SQL answer (fixed-width, Tab indents)</label></div>
            <textarea rows="14" data-q="${q.id}" spellcheck="false">${esc(q.answer)}</textarea>`}
      </section>`).join('')}
        <div class="cbt-actions"><button type="button" class="ghost" id="prev">Previous</button><button type="button" class="ghost" id="clear">Clear response</button>
          <button type="button" class="ghost" id="mark">Mark for review &amp; next</button><button type="button" id="next">Save &amp; next</button></div></form>
      <aside class="card cbt-pal"><div class="small muted">Questions</div><div class="pal" id="pal"></div>
        <div class="legend small"><span><i class="st answered"></i>Answered</span><span><i class="st notans"></i>Not answered</span><span><i class="st review"></i>Marked for review</span><span><i class="st nv"></i>Not visited</span></div>
        <button type="button" id="finish" style="width:100%;margin-top:12px">Submit test</button></aside></div>
    <div class="fs-block" id="fsblock" hidden><div class="card narrow"><h2>Return to full screen</h2><p>You left full screen. This is recorded for your faculty. Go back to continue the test.</p><button type="button" id="refs">Return to full screen</button></div></div>`;
  const f = document.getElementById('f');
  const pal = document.getElementById('pal');
  const drawPal = () => {
    pal.innerHTML = Q.map((q, i) => {
      const a = ans(q).trim();
      const cls = state[i].review ? 'review' + (a ? ' has' : '') : a ? 'answered' : state[i].visited ? 'notans' : 'nv';
      return `<button type="button" class="st ${cls}${i === cur ? ' cur' : ''}" data-go="${i}" title="${esc(qno(q))}">${i + 1}</button>`;
    }).join('');
    pal.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(+b.dataset.go)));
  };
  const show = (i) => {
    cur = Math.max(0, Math.min(Q.length - 1, i));
    state[cur].visited = true;
    f.querySelectorAll('section[data-i]').forEach((x) => (x.hidden = +x.dataset.i !== cur));
    document.getElementById('prev').disabled = cur === 0;
    document.getElementById('next').textContent = cur === Q.length - 1 ? 'Save' : 'Save & next';
    drawPal();
    const t = f.querySelector(`section[data-i="${cur}"] textarea`);
    if (t) t.focus();
  };
  document.getElementById('prev').onclick = () => show(cur - 1);
  document.getElementById('next').onclick = () => { state[cur].review = false; save(true); show(cur + 1); };
  document.getElementById('mark').onclick = () => { state[cur].review = true; save(true); show(cur + 1); };
  document.getElementById('clear').onclick = () => {
    const sec = f.querySelector(`section[data-i="${cur}"]`);
    sec.querySelectorAll('input[type=radio]').forEach((x) => (x.checked = false));
    const t = sec.querySelector('textarea'); if (t) t.value = '';
    state[cur].review = false; dirty = true; drawPal();
  };
  f.querySelectorAll('[data-code]').forEach((c) => (c.onchange = () => f.querySelector(`textarea[data-q="${c.dataset.code}"]`).classList.toggle('code', c.checked)));
  f.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.target.classList.contains('code')) {
      e.preventDefault();
      const t = e.target, p0 = t.selectionStart;
      t.value = t.value.slice(0, p0) + '    ' + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = p0 + 4; dirty = true;
    }
  });
  const payload = () => ({ answers: Q.map((q) => ({ question_id: q.id, text: ans(q) })), tab_switches: tabSwitches, paste_attempts: pasteAttempts });
  const save = async (force) => {
    if ((!dirty && !force) || done) return;
    dirty = false;
    try {
      await api('PUT', `/attempts/${d.attempt_id}/answers`, payload());
      document.getElementById('saved').textContent = `Saved ${new Date().toLocaleTimeString([], { timeStyle: 'medium' })}`;
    } catch (e) {
      dirty = true;
      document.getElementById('saved').textContent = 'Not saved – retrying';
    }
  };
  const submit = async () => {
    if (done) return;
    done = true;
    try {
      const r = await api('POST', `/attempts/${d.attempt_id}/submit`, payload());
      stop();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      toast('Submitted');
      location.hash = r.published ? `#/result/${d.attempt_id}` : '#/';
    } catch (e) {
      done = false;
      throw e;
    }
  };
  const blockPaste = (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    e.preventDefault(); pasteAttempts++; dirty = true;
    toast('Pasting is not allowed', true);
  };
  const onHide = () => { if (document.hidden && !done) { tabSwitches++; dirty = true; save(); } };
  const onLeave = (e) => { if (!done) e.preventDefault(); };
  const fsBlock = document.getElementById('fsblock');
  const onFs = () => {
    if (!lab || done) return;
    if (!document.fullscreenElement) { tabSwitches++; dirty = true; save(); fsBlock.hidden = false; } else fsBlock.hidden = true;
  };
  document.getElementById('refs').onclick = () => document.documentElement.requestFullscreen().catch(() => {});
  f.addEventListener('paste', blockPaste);
  f.addEventListener('drop', blockPaste);
  f.addEventListener('input', () => { dirty = true; drawPal(); });
  f.addEventListener('change', () => { dirty = true; drawPal(); });
  document.addEventListener('visibilitychange', onHide);
  document.addEventListener('fullscreenchange', onFs);
  window.addEventListener('beforeunload', onLeave);
  if (lab && !document.fullscreenElement) fsBlock.hidden = false;

  const tick = () => {
    const left = Math.max(0, deadline - (Date.now() + skew));
    const sec = Math.floor(left / 1000);
    const el = document.getElementById('timer');
    if (!el) return;
    el.textContent = `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    el.classList.toggle('low', sec < 300);
    if (left === 0 && !done) { toast('Time is over. Submitting…'); submit().catch((e) => toast(e.message, true)); }
  };
  const timers = [setInterval(tick, 1000), setInterval(save, 10000)];
  tick();
  show(0);
  const stop = () => {
    timers.forEach(clearInterval);
    document.removeEventListener('visibilitychange', onHide);
    document.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('beforeunload', onLeave);
    cleanup = null;
  };
  cleanup = () => { save(); stop(); };
  document.getElementById('finish').onclick = act(async () => {
    const answered = Q.filter((q) => ans(q).trim()).length;
    const marked = state.filter((x) => x.review).length;
    if (await ask(`Submit now? Answered ${answered} of ${Q.length}${marked ? `, ${marked} marked for review` : ''}. You cannot change your answers after this.`, { ok: 'Submit' })) await submit();
  });
}

async function viewResult(id) {
  const seq = nav_seq;
  const r = await api('GET', `/attempts/${id}/result`);
  const head = r.published ? letterhead(await api('GET', '/settings')) : '';
  if (seq !== nav_seq) return;
  if (!r.published) {
    app.innerHTML = '<div class="card"><h1>Result awaited</h1><p class="muted">Your answers are submitted. The result will appear here once your faculty approves it.</p><a class="btn" href="#/">Back</a></div>';
    return;
  }
  const got = r.total ?? r.answers.reduce((s, a) => s + a.marks, 0);
  const max = r.max ?? r.answers.reduce((s, a) => s + a.max_marks, 0);
  app.innerHTML = `<p class="between no-print"><a href="#/">← My assessments</a><button class="ghost" onclick="window.print()">Print / Save as PDF</button></p>
    <div class="print-only">${head}</div><h1>${title(r.assessment)}</h1><p class="print-only">${esc(user.name)}${user.roll_no ? ` · Roll no ${esc(user.roll_no)}` : ''}</p>
    <div class="result-top">
      <div class="card"><div class="muted">Total marks</div><div class="score">${num(got)} / ${num(max)}</div></div>
      <div class="card"><div class="muted">Rank${r.rank ? ` in ${r.rank.scope === 'branch' ? 'the branch' : 'your section'}` : ''}</div><div class="score">${r.rank ? `${r.rank.rank} <span class="small muted">of ${r.rank.of}</span>` : '<span class="small muted">After the whole section is approved</span>'}</div></div>
      <div class="card"><div class="muted">Preparedness</div><div class="score">${r.preparedness ?? '–'}<span class="small muted"> / 100</span></div></div></div>
    ${r.cos && r.cos.length ? `<div class="card"><h2>How you did in each course outcome</h2>${r.cos.map((c) => `<div class="co-row"><div><b>${esc(c.co)}</b> <span class="small muted">${esc(c.text)}</span></div>
      <div class="bar"><span style="width:${Math.min(100, c.pct)}%" class="${c.band === 'Strong' ? 'ok' : c.band === 'Developing' ? 'mid' : 'low'}"></span></div><div class="nowrap small"><b>${c.pct}%</b> · ${c.band}</div></div>`).join('')}
      <p class="small muted">Work first on the outcomes marked "Needs work".</p></div>` : ''}
    ${r.recheck_open ? `<p class="small muted no-print">Think a question was marked wrongly? You can ask for a re-check until ${fmt(r.recheck_until)}.</p>` : ''}
    ${r.answers.map((a) => `<div class="card"><div class="between"><h2>${qno(a)}${a.counted === false ? ' <span class="pill">not counted</span>' : ''}</h2><span class="pill ${a.marks >= a.max_marks * 0.6 ? 'ok' : 'warn'}">${num(a.marks)} / ${num(a.max_marks)}</span></div>
      <div class="answer">${esc(a.question)}</div>
      <h3>Your answer</h3>${a.kind === 'mcq' ? optionList(a.options, a.answer, a.correct_index)
        : `<div class="answer">${a.answer.trim() ? esc(a.answer) : '<span class="muted">Not attempted</span>'}</div>`}
      ${a.kind === 'mcq' ? (a.moderated ? '<p class="muted small">Marks for this question were moderated by your faculty.</p>' : '') : a.criteria ? `<h3>Marks breakdown</h3><table><tbody>${a.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${why(c)}</td></tr>`).join('')}</tbody></table>`
        : a.moderated ? '<p class="muted small">Marks for this question were moderated by your faculty.</p>' : ''}
      ${a.faculty_remark ? `<h3>Faculty remark</h3><p>${esc(a.faculty_remark)}</p>` : ''}
      ${a.missing_points.length ? `<h3>What was missing</h3><ul class="tight">${a.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${a.improvements.length ? `<h3>How to improve</h3><ul class="tight">${a.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${a.model_answer ? `<details><summary><b>Model answer</b></summary><div class="answer">${esc(a.model_answer)}</div></details>` : ''}
      ${(a.rechecks || []).map((x) => `<div class="note small${x.status === 'open' ? '' : x.status === 'accepted' ? '' : ' warn'}"><b>Re-check ${x.status === 'open' ? 'requested' : x.status}</b>: ${esc(x.reason)}${x.response ? `<br>Faculty: ${esc(x.response)}${x.new_marks !== null ? ` (marks ${num(x.old_marks)} → ${num(x.new_marks)})` : ''}` : ''}</div>`).join('')}
      ${r.recheck_open && !(a.rechecks || []).some((x) => x.status === 'open') ? `<p class="no-print"><button type="button" class="ghost small" data-rc="${a.seq}">Ask for re-check</button></p>` : ''}
    </div>`).join('')}`;
  app.querySelectorAll('[data-rc]').forEach((b) => (b.onclick = act(async () => {
    const v = await ask('Why should this answer be re-checked? Your faculty will see your answer and reply.', { ok: 'Send request', fields: [{ name: 'reason', label: 'Reason' }] });
    if (!v) return;
    await api('POST', `/attempts/${id}/recheck`, { seq: +b.dataset.rc, reason: v.reason });
    toast('Re-check requested'); viewResult(id);
  })));
}

// ---------- router ----------

async function route() {
  nav_seq++;
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
    if (user.must_change || (page === 'password' && user.role !== 'student')) return viewPassword();
    if (user.role === 'owner') return await viewOwner();
    if (user.role === 'student') {
      if (page === 'attempt' && id) return await viewAttempt(+id);
      if (page === 'result' && id) return await viewResult(+id);
      return await viewStudentHome();
    }
    const p = user.perms;
    if (page === 'setup' && p.manage) return await viewInstSetup(id || 'profile');
    if (page === 'students' && (p.students || p.manage)) return await viewStudents(+id || 0);
    if (page === 'my-section' && (user.coordinates || []).length) return await viewStudents(+id || 0);
    if (page === 'dqac' && user.role === 'hod') return await viewDqac();
    if (page === 'moderation' && user.role === 'hod') return await viewTracker();
    if (page === 'reviews') return await viewMyReviews();
    if (page === 'reports') return await viewReports();
    if (page === 'sheets') return await viewSheets();
    if (page === 'sheet' && id) return await viewSheet(id);
    if (page === 'new' && p.create) return id ? await viewNew(decodeURIComponent(id)) : viewChooseType();
    if (page === 'print' && id) return await viewPrint(id, +location.hash.split('/')[3]);
    if (page === 'a' && id) return await viewAssessment(+id);
    if (page === 'edit' && id && p.create) return await viewEdit(+id);
    if (page === 'review' && id) return await viewReview(+id);
    if (page === 'list') return await viewFacultyHome();
    if (p.manage && !p.create) return await viewInstSetup('profile');
    if (p.students && !p.create) return await viewStudents(0);
    return await viewFacultyHome();
  } catch (e) {
    app.innerHTML = `<div class="card"><h1>Something went wrong</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Go back</a></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
