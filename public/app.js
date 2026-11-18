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
    : `${p.manage ? '<a href="#/setup">Institute setup</a>' : ''}<a href="#/list">Assessments</a>${p.create ? '<a href="#/new">New assessment</a>' : ''}`;
  nav.innerHTML = `${user.must_change ? '' : links}${user.role === 'student' ? `<span class="muted small">${esc(user.name)}</span>` : `<a href="#/password" class="muted small">${esc(user.name)}</a>`}<button class="ghost small" id="logout">Log out</button>`;
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
    m.textContent = 'Passwords are reset by your institute. Students: ask your class coordinator. Faculty and staff: ask the institute admin.';
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
    <button>Change password</button></form></div>`;
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

const ROLE_NAMES = { admin: 'Institute admin', nodal: 'Nodal officer', hod: 'Head of department', faculty: 'Faculty' };
const ROLE_RIGHTS = {
  admin: { manage: true, create: false, approve: false, reports: 'institute' },
  nodal: { manage: false, create: false, approve: false, reports: 'institute' },
  hod: { manage: false, create: true, approve: true, reports: 'department' },
  faculty: { manage: false, create: true, approve: true, reports: 'own' },
};
const REPORT_NAMES = { own: 'Own assessments', department: 'Whole department', institute: 'Whole institute' };
const rightsText = (p) => [p.manage && 'Manage institute', p.create && 'Create assessments', p.approve && 'Approve results', `Reports: ${REPORT_NAMES[p.reports].toLowerCase()}`].filter(Boolean).join(', ');

// Reads "a, b, c" lines (typed, or from a CSV file) into objects; a header line starting with the first column name is skipped.
function parseLines(text, columns) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l, i) => !(i === 0 && l.toLowerCase().replace(/[^a-z,]/g, '').startsWith(columns[0].replace(/[^a-z]/g, ''))))
    .map((l, i) => {
      const p = l.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      if (p.length !== columns.length || p.some((x) => !x)) throw new Error(`Line ${i + 1}: need ${columns.join(', ')}`);
      return Object.fromEntries(columns.map((c, k) => [c, p[k]]));
    });
}
const csvPicker = (id, sample) => `<span class="small">or load a CSV file: <input type="file" accept=".csv,text/csv" data-csv="${id}" style="display:inline-block;width:auto">
  <a download="template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(sample)}">Download template</a></span>`;

async function viewAdmin() {
  const seq = nav_seq;
  const [d, inst] = await Promise.all([api('GET', '/admin/data'), api('GET', '/settings')]);
  if (seq !== nav_seq) return;
  const table = (head, rows, empty) => rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="muted">${empty}</p>`;
  const acts = (kind, x, withReset) => `<td class="right nowrap"><button type="button" class="ghost small" data-edit="${kind}:${x.id}">Edit</button>
    ${withReset && !x.self ? `<button type="button" class="ghost small" data-reset="${x.id}">Reset password</button>` : ''}
    ${x.self ? '' : `<button type="button" class="ghost small danger" data-del="${kind}:${x.id}">Delete</button>`}</td>`;
  const deptOptions = (sel) => `<option value="">No department</option>${d.departments.map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  const sectionOptions = `<option value="">Choose section…</option>${d.sections.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
  let logo = inst.logo;
  let lhead = inst.letterhead || '';
  const F = inst.format || {};

  app.innerHTML = `<h1>Institute setup</h1>
    <p class="muted">Institute code for logging in: <b>${esc(inst.code)}</b>. Fill these in order; each step feeds the next.</p>
    <div class="card"><h2>1. Institute profile <span class="muted small">(printed at the top of reports, question papers and answer sheets)</span></h2>
      <form id="finst"><div class="row"><label style="flex:2 1 260px">Institute name<input name="institute" value="${esc(inst.institute)}" required></label>
        <label style="flex:2 1 260px">Second line (address or affiliation)<input name="line" value="${esc(inst.line)}"></label></div>
        <div class="row" style="align-items:center"><label>Logo (PNG or JPG, under 300 KB)<input type="file" id="logofile" accept="image/png,image/jpeg"></label>
          <div id="logoprev" style="flex:0 0 auto"></div></div>
        <label>Letterhead (header image of your official letterhead: PNG or JPG, full page width, under 700 KB)<input type="file" id="lhfile" accept="image/png,image/jpeg"></label>
        <p class="muted small">Every question paper, answer key, answer sheet and report is printed under this letterhead. Without it, the logo and name above are used.</p>
        <div id="lhprev"></div>
        <h3>Question paper format <span class="muted small">(how your institute's papers are laid out)</span></h3>
        <div class="row"><label>Taxonomy column on exam papers<input name="tax_exam" value="${esc(F.tax_exam || 'RBTL')}"></label>
          <label>Shown as<select name="tax_exam_style"><option value="code"${F.tax_exam_style !== 'name' ? ' selected' : ''}>Code, e.g. RBTL-2</option><option value="name"${F.tax_exam_style === 'name' ? ' selected' : ''}>Level name, e.g. Understand</option></select></label>
          <label>Code prefix<input name="tax_code" value="${esc(F.tax_code || 'RBTL')}" placeholder="RBTL"></label></div>
        <div class="row"><label>Taxonomy column on assignments<input name="tax_asg" value="${esc(F.tax_asg || 'R. Bloom Taxonomy Level')}"></label>
          <label>Shown as<select name="tax_asg_style"><option value="name"${F.tax_asg_style !== 'code' ? ' selected' : ''}>Level name, e.g. Analyse</option><option value="code"${F.tax_asg_style === 'code' ? ' selected' : ''}>Code, e.g. RBTL-4</option></select></label></div>
        <div class="row"><label>Signature lines on exam papers (separate with |)<input name="sign_exam" value="${esc(F.sign_exam ?? 'Faculty Name and Sign. | HOD Sign.')}"></label>
          <label>Signature lines on assignments (separate with |)<input name="sign_asg" value="${esc(F.sign_asg || '')}" placeholder="Leave empty for none"></label></div>
        <label class="choice" style="max-width:360px"><input type="checkbox" name="roll"${F.roll === false ? '' : ' checked'}> Print "Roll No. ……" on exam papers</label>
        <p><button>Save institute profile</button></p></form></div>

    <div class="card"><h2>2. Departments (${d.departments.length})</h2>
      <form id="fdep" class="row"><label style="flex:3 1 260px">Department name<input name="name" placeholder="Computer Science and Engineering" required></label><p><button>Add department</button></p></form>
      ${table(['Department', ''], d.departments.map((x) => `<tr><td>${esc(x.name)}</td>${acts('departments', x)}</tr>`), 'No departments yet.')}</div>

    <div class="card"><h2>3. Courses and sections (${d.sections.length})</h2>
      <form id="fsec" class="row"><label style="flex:2 1 200px">Course / programme<input name="programme" placeholder="B.Tech CSE"></label>
        <label style="flex:2 1 200px">Section name<input name="name" placeholder="B.Tech CSE Sem 5 - A" required></label>
        <label>Department<select name="department_id">${deptOptions()}</select></label><p><button>Add section</button></p></form>
      ${table(['Section', 'Course', 'Department', 'Students', ''], d.sections.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.programme) || '–'}</td><td>${esc(x.department ?? '–')}</td><td>${x.students}</td>${acts('sections', x)}</tr>`), 'No sections yet.')}</div>

    <div class="card"><h2>4. Subjects (${d.subjects.length})</h2>
      <form id="fsub" class="row"><label style="flex:3 1 220px">Subject name<input name="name" required></label><label>Subject code<input name="code" required></label>
        <label>Semester (optional)<input name="semester" type="number" min="1" max="12"></label><p><button>Add subject</button></p></form>
      ${table(['Code', 'Subject', 'Semester', ''], d.subjects.map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td>${x.semester ?? '–'}</td>${acts('subjects', x)}</tr>`), 'No subjects yet.')}</div>

    <div class="card"><h2>5. Staff and their rights (${d.staff.length})</h2>
      <form id="fstaff"><div class="row"><label>Full name<input name="name" required></label><label>Username<input name="username" required autocomplete="off"></label>
          <label>First password (min 6)<input name="password" minlength="6" required autocomplete="off"></label></div>
        <div class="row"><label>Role<select name="role">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}"${k === 'faculty' ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Department<select name="department_id">${deptOptions()}</select></label>
          <label>Can see reports of<select name="reports">${Object.entries(REPORT_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
        <div class="checks"><label class="choice"><input type="checkbox" name="create"> Create assessments</label>
          <label class="choice"><input type="checkbox" name="approve"> Approve and moderate results</label>
          <label class="choice"><input type="checkbox" name="manage"> Manage institute setup and accounts</label></div>
        <p><button>Add staff member</button> <span class="muted small">Choosing a role fills in its usual rights; change the ticks to grant more or less.</span></p></form>
      <details><summary class="small">Add several faculty at once</summary>
        <form id="fbulk" style="margin-top:10px"><label>Department<select name="department_id">${deptOptions()}</select></label>
          <label>One per line: <b>name, username, password</b> ${csvPicker('bulk', 'name,username,password\nFaculty Name,faculty1,first-password\n')}
            <textarea name="lines" rows="4" required></textarea></label>
          <p><button>Add as faculty</button> <span class="muted small">Each gets the usual faculty rights.</span></p></form></details>
      ${table(['Name', 'Username', 'Role', 'Department', 'Rights', ''], d.staff.map((x) => `<tr><td>${esc(x.name)}${x.self ? ' <span class="pill">You</span>' : ''}</td><td>${esc(x.username)}</td>
        <td>${ROLE_NAMES[x.role]}</td><td>${esc(x.department ?? '–')}</td><td class="small">${rightsText(x.perms)}</td>${acts('staff', x, true)}</tr>`), 'No staff yet.')}</div>

    <div class="card"><h2>6. Students (${d.students.length})</h2>
      <form id="fstu"><label>Section<select name="section_id" required>${sectionOptions}</select></label>
        <label>One student per line: <b>roll no, name, username, password</b> ${csvPicker('stu', 'roll no,name,username,password\n101,Student Name,student101,first-password\n')}
          <textarea name="lines" rows="5" placeholder="101, Student Name, student101, first-password" required></textarea></label>
        <p><button>Add students</button> <span class="muted small">Every new account must choose its own password at first login.</span></p></form>
      ${table(['Section', 'Roll no', 'Name', 'Username', ''], d.students.map((x) => `<tr><td>${esc(x.section ?? '–')}</td><td>${esc(x.roll_no)}</td><td>${esc(x.name)}</td><td>${esc(x.username)}</td>${acts('students', x, true)}</tr>`), 'No students yet.')}</div>

    <div class="card"><h2>Activity log <span class="muted small">(latest 100)</span></h2>
      ${table(['When', 'Who', 'What', 'Details'], d.audit.map((x) => `<tr><td class="nowrap">${fmt(x.at)}</td><td>${esc(x.user_name)}</td><td>${esc(x.action)}</td><td class="small">${esc(x.detail)}</td></tr>`), 'Nothing recorded yet.')}</div>`;

  // institute profile
  const prev = document.getElementById('logoprev');
  const drawLogo = () => {
    prev.innerHTML = logo ? `<img src="${esc(logo)}" alt="Logo" style="max-height:60px;max-width:160px"> <button type="button" class="ghost small" id="rmlogo">Remove logo</button>` : '<span class="muted small">No logo</span>';
    const rm = document.getElementById('rmlogo');
    if (rm) rm.onclick = () => { logo = ''; drawLogo(); };
  };
  drawLogo();
  document.getElementById('logofile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return toast('Logo must be a PNG or JPG image', true);
    if (file.size > 300 * 1024) return toast('Logo is too large (keep it under 300 KB)', true);
    const reader = new FileReader();
    reader.onload = () => { logo = reader.result; drawLogo(); };
    reader.readAsDataURL(file);
  };
  const lhPrev = document.getElementById('lhprev');
  const drawLh = () => {
    lhPrev.innerHTML = lhead ? `<div class="lh-preview"><img src="${esc(lhead)}" alt="Letterhead"></div><button type="button" class="ghost small" id="rmlh">Remove letterhead</button>` : '<span class="muted small">No letterhead uploaded</span>';
    const rm = document.getElementById('rmlh');
    if (rm) rm.onclick = () => { lhead = ''; drawLh(); };
  };
  drawLh();
  document.getElementById('lhfile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return toast('Letterhead must be a PNG or JPG image', true);
    if (file.size > 700 * 1024) return toast('Letterhead image is too large (keep it under 700 KB)', true);
    const reader = new FileReader();
    reader.onload = () => { lhead = reader.result; drawLh(); };
    reader.readAsDataURL(file);
  };
  document.getElementById('finst').onsubmit = act(async (e) => {
    const g = e.target;
    await api('POST', '/admin/settings', {
      institute: g.institute.value, line: g.line.value, logo, letterhead: lhead,
      format: { tax_exam: g.tax_exam.value, tax_exam_style: g.tax_exam_style.value, tax_code: g.tax_code.value, tax_asg: g.tax_asg.value,
        tax_asg_style: g.tax_asg_style.value, sign_exam: g.sign_exam.value, sign_asg: g.sign_asg.value, roll: g.roll.checked },
    });
    user.institute_name = e.target.institute.value.trim();
    drawNav();
    toast('Institute profile saved');
  });

  // CSV files fill the box next to them
  app.querySelectorAll('[data-csv]').forEach((inp) => (inp.onchange = async () => {
    const file = inp.files[0];
    if (file) inp.closest('form').lines.value = (await file.text()).replace(/^\ufeff/, '');
  }));

  // add
  const post = (formId, path, build, done) => (document.getElementById(formId).onsubmit = act(async (e) => {
    const r = await api('POST', path, build(e.target));
    toast(done(r));
    viewAdmin();
  }));
  const fields = (f) => Object.fromEntries(new FormData(f));
  post('fdep', '/admin/departments', fields, () => 'Department added');
  post('fsec', '/admin/sections', fields, () => 'Section added');
  post('fsub', '/admin/subjects', fields, () => 'Subject added');
  post('fstu', '/admin/students', (f) => ({ section_id: +f.section_id.value, students: parseLines(f.lines.value, ['roll_no', 'name', 'username', 'password']) }), (r) => `${r.added} student(s) added`);

  const fstaff = document.getElementById('fstaff');
  const applyRole = () => {
    const r = ROLE_RIGHTS[fstaff.role.value];
    fstaff.create.checked = r.create; fstaff.approve.checked = r.approve; fstaff.manage.checked = r.manage; fstaff.reports.value = r.reports;
    fstaff.manage.disabled = fstaff.role.value === 'admin'; // an institute admin always has it
  };
  fstaff.role.onchange = applyRole;
  applyRole();
  const staffBody = (v) => ({ name: v.name, username: v.username, password: v.password, role: v.role, department_id: v.department_id || null,
    perms: { manage: !!v.manage, create: !!v.create, approve: !!v.approve, reports: v.reports } });
  post('fstaff', '/admin/staff', (f) => staffBody({ ...fields(f), manage: f.manage.checked, create: f.create.checked, approve: f.approve.checked }), () => 'Staff account created');

  document.getElementById('fbulk').onsubmit = act(async (e) => {
    const rows = parseLines(e.target.lines.value, ['name', 'username', 'password']);
    let added = 0;
    try {
      for (const r of rows) {
        await api('POST', '/admin/staff', { ...r, role: 'faculty', department_id: e.target.department_id.value || null, perms: ROLE_RIGHTS.faculty });
        added++;
      }
    } catch (err) {
      throw new Error(`${added} added, then line ${added + 1} failed: ${err.message}`);
    } finally {
      if (added) viewAdmin();
    }
    toast(`${added} faculty account(s) created`);
  });

  // edit, delete, reset password
  const lists = { departments: d.departments, sections: d.sections, subjects: d.subjects, staff: d.staff, students: d.students };
  const find = (kind, id) => lists[kind].find((x) => x.id === id);
  const urlOf = (kind) => (kind === 'staff' || kind === 'students' ? 'users' : kind);
  const deptField = (v) => ({ name: 'department_id', label: 'Department', value: v ?? '', options: [{ value: '', label: 'No department' }, ...d.departments.map((x) => ({ value: x.id, label: x.name }))] });
  const editFields = {
    departments: (x) => [{ name: 'name', label: 'Department name', value: x.name }],
    sections: (x) => [{ name: 'name', label: 'Section name', value: x.name }, { name: 'programme', label: 'Course / programme', value: x.programme, optional: true }, deptField(x.department_id)],
    subjects: (x) => [{ name: 'name', label: 'Subject name', value: x.name }, { name: 'code', label: 'Subject code', value: x.code },
      { name: 'semester', label: 'Semester (optional)', value: x.semester ?? '', type: 'number', optional: true }],
    staff: (x) => [{ name: 'name', label: 'Full name', value: x.name }, { name: 'username', label: 'Username', value: x.username },
      { name: 'role', label: 'Role', value: x.role, options: Object.entries(ROLE_NAMES).map(([k, v]) => ({ value: k, label: v })) }, deptField(x.department_id),
      { name: 'reports', label: 'Can see reports of', value: x.perms.reports, options: Object.entries(REPORT_NAMES).map(([k, v]) => ({ value: k, label: v })) },
      { name: 'create', label: 'Create assessments', type: 'checkbox', value: x.perms.create },
      { name: 'approve', label: 'Approve and moderate results', type: 'checkbox', value: x.perms.approve },
      { name: 'manage', label: 'Manage institute setup and accounts', type: 'checkbox', value: x.perms.manage }],
    students: (x) => [{ name: 'roll_no', label: 'Roll no', value: x.roll_no }, { name: 'name', label: 'Name', value: x.name }, { name: 'username', label: 'Username', value: x.username },
      { name: 'section_id', label: 'Section', value: x.section_id ?? '', options: d.sections.map((sec) => ({ value: sec.id, label: sec.name })) }],
  };
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = act(async () => {
    const [kind, id] = b.dataset.edit.split(':');
    const v = await ask('Edit details', { ok: 'Save', fields: editFields[kind](find(kind, +id)) });
    if (!v) return;
    await api('PUT', `/admin/${urlOf(kind)}/${id}`, kind === 'staff' ? staffBody(v) : v);
    toast('Saved');
    viewAdmin();
  })));
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = act(async () => {
    const [kind, id] = b.dataset.del.split(':');
    const x = find(kind, +id);
    if (!(await ask(`Delete "${x.name}"? This cannot be undone.`, { ok: 'Delete' }))) return;
    await api('DELETE', `/admin/${urlOf(kind)}/${id}`);
    toast('Deleted');
    viewAdmin();
  })));
  app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = act(async () => {
    const x = [...d.staff, ...d.students].find((u) => u.id === +b.dataset.reset);
    const v = await ask(`New password for ${x.name} (minimum 6 characters). They must choose their own at next login.`, { ok: 'Reset password', fields: [{ name: 'password', label: 'New password', min: 6 }] });
    if (!v) return;
    await api('POST', `/admin/users/${x.id}/password`, { password: v.password });
    toast('Password reset');
  })));
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

async function viewNew(kind) {
  const K = KINDS[kind];
  if (!K) return viewChooseType();
  const seq = nav_seq;
  const master = await api('GET', '/master');
  if (seq !== nav_seq) return;
  if (!master.subjects.length || !master.sections.length) {
    app.innerHTML = '<div class="card"><h1>New assessment</h1><p>No subjects or sections are set up yet. Ask the institute admin to add them under Institute setup.</p><a class="btn" href="#/">Back</a></div>';
    return;
  }
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
  app.innerHTML = `<div class="between"><h1>New ${T}</h1><a href="#/new" class="small">Change type</a></div>
    <form id="f">
    <div class="card"><h2>Details</h2>
      <label>Subject<select name="subject_id" required><option value="">Choose subject…</option>${master.subjects.map((x) => `<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}${x.semester ? ` (Sem ${x.semester})` : ''}</option>`).join('')}</select></label>
      <div class="muted small">Sections that will take this ${T}</div>
      <div class="checks">${master.sections.map((x) => `<label class="choice"><input type="checkbox" name="section" value="${x.id}"> ${esc(x.name)} <span class="muted small">(${x.students} students)</span></label>`).join('')}</div>
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
    <div class="card"><h2>Paper structure</h2>
      <div class="row"><label style="max-width:220px">Max marks of the paper<input name="p_max" type="number" min="1" step="0.5" required></label></div>
      <table class="parts"><thead><tr><th>Part</th>${K.q === 'both' ? '<th>Type</th>' : ''}<th>Questions</th><th>Sub-parts in each</th><th>Sub-part numbering</th><th>Student attempts</th><th></th></tr></thead><tbody id="parts"></tbody></table>
      <p><button type="button" class="ghost small" id="addpart">+ Add part</button> <button type="button" id="build">Create question boxes</button></p>
      <p class="muted small">Example: PART-A with 1 question of 10 sub-parts (i to x), attempt 1; PART-B with 3 questions of 2 sub-parts ((a), (b)), attempt 2. When a part gives a choice, the student's best answers in that part are counted.</p></div>
    <div id="qs"></div>
    <p class="muted" id="marksum"></p>
    <p><button>Save as draft</button></p></form>`;
  const f = document.getElementById('f');
  const qs = document.getElementById('qs');

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
        <label>CO${isMid ? '' : ' (optional)'}<input data-q="co" placeholder="CO-1"${isMid ? ' required' : ''}></label>
        <label>Bloom's taxonomy level<select data-q="rbtl">${rbtOpts}</select></label></div>
      ${qk === 'mcq' ? `<h3>Options <span class="muted small">(select the radio button of the correct option)</span></h3>
        <div class="opt"></div><button type="button" class="ghost small addo">+ Add option</button>`
      : `<label>Model answer / key points (never shown to students)<textarea data-q="model_answer" required></textarea></label>
        <h3>Rubric <span class="muted small">(criterion marks must add up to max marks)</span></h3>
        <div class="rub"></div><button type="button" class="ghost small addr">+ Add criterion</button>`}`;
    if (qk === 'mcq') {
      const opt = box.querySelector('.opt');
      for (let i = 0; i < 4; i++) opt.append(optionRow(group));
      box.querySelector('.addo').onclick = () => opt.children.length < 6 && opt.append(optionRow(group));
    } else {
      box.querySelector('.rub').append(rubricRow());
      box.querySelector('.addr').onclick = () => box.querySelector('.rub').append(rubricRow());
    }
    box.querySelector('[data-q=max_marks]').oninput = sumMarks;
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
    const r = await api('POST', '/assessments', {
      subject_id: +f.subject_id.value, section_ids: [...f.querySelectorAll('[name=section]:checked')].map((x) => +x.value), type: T,
      number: +f.number.value, duration_min: f.duration_min ? +f.duration_min.value : null,
      start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      release_mode: f.release_mode?.value, shuffle: f.shuffle.checked, option_shuffle: !!f.option_shuffle?.checked,
      negative: f.negative && f.querySelector('[name=negmode]:checked').value === 'yes' ? +f.negative.value : 0, questions, paper,
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
  const seq = nav_seq;
  const a = await api('GET', `/assessments/${id}`);
  if (seq !== nav_seq) return;
  const total = paperMaxOf(a);
  const sheet = await api('GET', `/assessments/${id}/marks`);
  if (seq !== nav_seq) return;
  app.innerHTML = `<div class="between"><h1>${title(a)}</h1>
      ${a.status !== 'draft' ? '<span class="pill ok">Published</span>' : a.can.edit ? '<button id="pub">Publish to students</button>' : '<span class="pill warn">Draft</span>'}</div>
    <div class="card"><div class="muted">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(total)} marks ·
      Result release: <b>${a.release_mode === 'instant' ? 'Instant' : 'After faculty approval'}</b>${a.shuffle ? ' · Question order shuffled per student' : ''}${a.option_shuffle ? ' · MCQ options shuffled' : ''}${a.negative ? ` · Negative marking: ${({ 0.25: '¼', 0.33: '⅓', 0.5: '½', 1: 'full' })[a.negative] || a.negative} of the question's marks per wrong MCQ` : ''}</div>
      <div class="muted">Sections: ${a.sections.length ? a.sections.map(esc).join(', ') : 'All students'}</div>
      <p class="downloads"><b class="small">Download for records:</b> <a class="btn ghost" href="#/print/report/${a.id}">Assessment report</a>
        <a class="btn ghost" href="#/print/paper/${a.id}">Question paper</a> <a class="btn ghost" href="#/print/key/${a.id}">Paper with answer key and rubric</a>
        <a class="btn ghost" href="#/print/sheets/${a.id}">All evaluated answer sheets</a></p>
      ${a.attempts.length || !a.can.edit ? '' : '<p class="downloads"><button type="button" class="ghost small danger" id="delassess">Delete this assessment</button> <span class="muted small">Possible only until a student starts it.</span></p>'}</div>
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
    if (kind === 'paper' || kind === 'key') {
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

async function viewAttempt(assessmentId) {
  const seq = nav_seq;
  const d = await api('POST', `/assessments/${assessmentId}/start`);
  if (seq !== nav_seq) return;
  const skew = Date.parse(d.server_now) - Date.now(); // use the server clock for the timer
  const deadline = Date.parse(d.deadline_at);
  let tabSwitches = 0, pasteAttempts = 0, dirty = false, done = false;

  app.innerHTML = `<div class="attempt-bar between"><b>${title(d.assessment)}</b>
      <span><span class="muted small" id="saved"></span> &nbsp; Time left: <span class="timer" id="timer"></span></span></div>
    <div class="note">${d.questions.some((q) => q.kind !== 'mcq') ? 'Type your answers yourself. Pasting is disabled, and leaving' : 'Leaving'} this tab is recorded for your faculty. Answers are saved automatically.</div>
    ${(d.assessment.parts || []).map((p) => `<div class="note">${p.name ? `PART-${esc(p.name)}: ` : ''}attempt any ${p.attempt} of the ${p.questions} questions. If you answer more, your best ${p.attempt} are counted.</div>`).join('')}
    <form id="f">${d.questions.map((q) => `<div class="card"><div class="between"><h2>${qno(q)}</h2><span class="pill">${num(q.max_marks)} marks</span></div>
      <div class="answer">${esc(q.text)}</div>
      ${q.kind === 'mcq' ? `<div class="mcq" data-q="${q.id}">${(q.order || q.options.map((_, i) => i)).map((i, pos) => `<label class="choice"><input type="radio" name="q${q.id}" value="${i}"${/^\d+$/.test(q.answer) && +q.answer === i ? ' checked' : ''}> ${String.fromCharCode(65 + pos)}. ${esc(q.options[i])}</label>`).join('')}
          <button type="button" class="ghost small clear">Clear selection</button></div>`
        : `<label>Your answer<textarea rows="8" data-q="${q.id}" spellcheck="false">${esc(q.answer)}</textarea></label>`}</div>`).join('')}
    <p><button>Submit assessment</button></p></form>`;

  const f = document.getElementById('f');
  const payload = () => ({
    answers: [
      ...[...f.querySelectorAll('textarea')].map((x) => ({ question_id: +x.dataset.q, text: x.value })),
      ...[...f.querySelectorAll('.mcq')].map((x) => ({ question_id: +x.dataset.q, text: x.querySelector('input:checked')?.value ?? '' })),
    ],
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
      const r = await api('POST', `/attempts/${d.attempt_id}/submit`, payload());
      stop();
      toast('Submitted');
      location.hash = r.published ? `#/result/${d.attempt_id}` : '#/';
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
  f.querySelectorAll('.mcq .clear').forEach((b) => (b.onclick = () => {
    b.parentNode.querySelectorAll('input').forEach((x) => (x.checked = false));
    dirty = true;
  }));
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
    if (await ask('Submit now? You cannot change your answers after this.', { ok: 'Submit' })) await submit();
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
    <div class="card"><div class="muted">Total marks</div><div class="score">${num(got)} / ${num(max)}</div></div>
    ${r.answers.map((a) => `<div class="card"><div class="between"><h2>${qno(a)}${a.counted === false ? ' <span class="pill">not counted</span>' : ''}</h2><span class="pill ${a.marks >= a.max_marks * 0.6 ? 'ok' : 'warn'}">${num(a.marks)} / ${num(a.max_marks)}</span></div>
      <div class="answer">${esc(a.question)}</div>
      <h3>Your answer</h3>${a.kind === 'mcq' ? optionList(a.options, a.answer, a.correct_index)
        : `<div class="answer">${a.answer.trim() ? esc(a.answer) : '<span class="muted">Not attempted</span>'}</div>`}
      ${a.kind === 'mcq' ? (a.moderated ? '<p class="muted small">Marks for this question were moderated by your faculty.</p>' : '') : a.criteria ? `<h3>Marks breakdown</h3><table><tbody>${a.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${why(c)}</td></tr>`).join('')}</tbody></table>`
        : a.moderated ? '<p class="muted small">Marks for this question were moderated by your faculty.</p>' : ''}
      ${a.faculty_remark ? `<h3>Faculty remark</h3><p>${esc(a.faculty_remark)}</p>` : ''}
      ${a.missing_points.length ? `<h3>What was missing</h3><ul class="tight">${a.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${a.improvements.length ? `<h3>How to improve</h3><ul class="tight">${a.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`).join('')}`;
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
    if (page === 'setup' && p.manage) return await viewAdmin();
    if (page === 'new' && p.create) return id ? await viewNew(decodeURIComponent(id)) : viewChooseType();
    if (page === 'print' && id) return await viewPrint(id, +location.hash.split('/')[3]);
    if (page === 'a' && id) return await viewAssessment(+id);
    if (page === 'review' && id) return await viewReview(+id);
    if (page === 'list') return await viewFacultyHome();
    return p.manage && !p.create ? await viewAdmin() : await viewFacultyHome();
  } catch (e) {
    app.innerHTML = `<div class="card"><h1>Something went wrong</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Go back</a></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
