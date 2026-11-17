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
  brand.innerHTML = user && user.institute_name ? `COGNEXA <span class="tag">${esc(user.institute_name)}</span>` : 'COGNEXA';
  if (!user) return (nav.innerHTML = '<a href="/">Home</a>');
  const p = user.perms || {};
  const links = user.role === 'owner' ? '<a href="#/">Institutes and requests</a>'
    : user.role === 'student' ? '<a href="#/">My assessments</a>'
    : `${p.manage ? '<a href="#/setup">Institute setup</a>' : ''}<a href="#/list">Assessments</a>${p.create ? '<a href="#/new">New assessment</a>' : ''}`;
  nav.innerHTML = `${user.must_change ? '' : links}<a href="#/password" class="muted small">${esc(user.name)}</a><button class="ghost small" id="logout">Log out</button>`;
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

function viewLogin(owner = false) {
  app.innerHTML = `<div class="card narrow"><h1>${owner ? 'Platform owner log in' : 'Log in'}</h1>
    <form id="f">${owner ? '' : '<label>Institute code<input name="code" required autocapitalize="characters" autocomplete="organization" placeholder="For example 1-7216281"></label>'}
    <label>Username<input name="username" required autocomplete="username"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button>Log in</button></form>
    <p class="small" style="margin-top:14px"><a href="#" id="swap">${owner ? 'Log in as an institute member' : 'Platform owner log in'}</a></p></div>`;
  document.getElementById('swap').onclick = (e) => { e.preventDefault(); viewLogin(!owner); };
  document.getElementById('f').onsubmit = act(async (e) => {
    await api('POST', '/login', Object.fromEntries(new FormData(e.target)));
    user = await api('GET', '/me');
    location.hash = '#/';
    route();
  });
}

function viewPassword() {
  app.innerHTML = `<div class="card narrow"><h1>Change password</h1>
    ${user.must_change ? '<div class="note warn">Your password was set by someone else. Choose your own before you continue.</div>' : ''}
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

  app.innerHTML = `<h1>Institute setup</h1>
    <p class="muted">Institute code for logging in: <b>${esc(inst.code)}</b>. Fill these in order; each step feeds the next.</p>
    <div class="card"><h2>1. Institute profile <span class="muted small">(printed at the top of reports, question papers and answer sheets)</span></h2>
      <form id="finst"><div class="row"><label style="flex:2 1 260px">Institute name<input name="institute" value="${esc(inst.institute)}" required></label>
        <label style="flex:2 1 260px">Second line (address or affiliation)<input name="line" value="${esc(inst.line)}"></label></div>
        <div class="row" style="align-items:center"><label>Logo (PNG or JPG, under 300 KB)<input type="file" id="logofile" accept="image/png,image/jpeg"></label>
          <div id="logoprev" style="flex:0 0 auto"></div></div>
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
  document.getElementById('finst').onsubmit = act(async (e) => {
    await api('POST', '/admin/settings', { institute: e.target.institute.value, line: e.target.line.value, logo });
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

async function viewNew() {
  const seq = nav_seq;
  const master = await api('GET', '/master');
  if (seq !== nav_seq) return;
  if (!master.subjects.length || !master.sections.length) {
    app.innerHTML = '<div class="card"><h1>New assessment</h1><p>No subjects or sections are set up yet. Ask the admin to add them under Master data.</p><a class="btn" href="#/">Back</a></div>';
    return;
  }
  const local = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const start = new Date();
  const end = new Date(Date.now() + 2 * 3600e3);
  app.innerHTML = `<h1>New assessment</h1>
    <form id="f">
    <div class="card"><h2>Details</h2>
      <label>Subject<select name="subject_id" required><option value="">Choose subject…</option>${master.subjects.map((x) => `<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}${x.semester ? ` (Sem ${x.semester})` : ''}</option>`).join('')}</select></label>
      <div class="muted small">Sections that will take this assessment</div>
      <div class="checks">${master.sections.map((x) => `<label class="choice"><input type="checkbox" name="section" value="${x.id}"> ${esc(x.name)} <span class="muted small">(${x.students} students)</span></label>`).join('')}</div>
      <div class="row"><label>Type<select name="type"><option>Assignment</option><option>Sessional</option><option>Tutorial</option><option>MCQ Test</option></select></label>
        <label>Number<input name="number" type="number" min="1" value="1" required></label>
        <label>Duration (minutes)<input name="duration_min" type="number" min="1" max="600" value="60" required></label></div>
      <div class="row"><label>Window opens<input name="start_at" type="datetime-local" value="${local(start)}" required></label>
        <label>Window closes<input name="end_at" type="datetime-local" value="${local(end)}" required></label>
        <label>Result release<select name="release_mode"><option value="after_approval">After faculty approval</option><option value="instant">Instant (after evaluation)</option></select></label></div>
      <p class="muted small" id="relnote"></p>
      <label class="choice" style="max-width:420px"><input type="checkbox" name="shuffle"> Show the questions in a different order to each student</label></div>
    <div id="qs"></div>
    <p><button type="button" class="ghost" id="addq">+ Add question</button></p>
    <p><button>Save as draft</button></p></form>`;
  const f = document.getElementById('f');
  const qs = document.getElementById('qs');

  const syncRelease = () => {
    const sess = f.type.value === 'Sessional';
    const mcqTest = f.type.value === 'MCQ Test';
    if (sess) f.release_mode.value = 'after_approval';
    if (mcqTest) f.release_mode.value = 'instant';
    f.release_mode.disabled = sess || mcqTest;
    document.getElementById('relnote').textContent = sess
      ? 'Sessional results are always released only after faculty approval.'
      : mcqTest
        ? 'MCQ Test: only MCQ questions, checked against your answer key. The student sees the result immediately on submit.'
        : 'Instant: the student sees the result right after evaluation, unless the model is unsure about an answer.';
    [...qs.children].forEach(lockKind);
  };
  const rubricRow = () => {
    const d = document.createElement('div');
    d.className = 'rubric-row';
    d.innerHTML = '<input placeholder="Criterion, e.g. Correct definition" data-r="criterion" required><input type="number" step="0.5" min="0.5" placeholder="Marks" data-r="marks" required><button type="button" class="ghost small">✕</button>';
    d.querySelector('button').onclick = () => d.parentNode.children.length > 1 && d.remove();
    return d;
  };
  let optGroup = 0;
  const optionRow = (group) => {
    const d = document.createElement('div');
    d.className = 'rubric-row';
    d.innerHTML = `<input type="radio" name="${group}" title="Mark as correct" required><input placeholder="Option text" data-o="text" required><button type="button" class="ghost small">✕</button>`;
    d.querySelector('button').onclick = () => d.parentNode.children.length > 2 && d.remove();
    return d;
  };
  // Show only the fields for the chosen question type; hidden fields are disabled so they are not validated.
  const setKind = (box) => {
    const mcq = box.querySelector('[data-q=kind]').value === 'mcq';
    box.querySelector('.desc-only').hidden = mcq;
    box.querySelector('.mcq-only').hidden = !mcq;
    box.querySelectorAll('.desc-only input, .desc-only textarea').forEach((x) => (x.disabled = mcq));
    box.querySelectorAll('.mcq-only input').forEach((x) => (x.disabled = !mcq));
  };
  const lockKind = (box) => {
    const k = box.querySelector('[data-q=kind]');
    const mcqTest = f.type.value === 'MCQ Test';
    if (mcqTest) k.value = 'mcq';
    k.disabled = mcqTest;
    setKind(box);
  };
  const addQuestion = () => {
    const box = document.createElement('div');
    box.className = 'card q';
    const group = `opt${++optGroup}`;
    box.innerHTML = `<div class="between"><h2 class="qn"></h2><button type="button" class="ghost small rm">Remove</button></div>
      <label>Question<textarea data-q="text" required></textarea></label>
      <div class="row"><label>Question type<select data-q="kind"><option value="descriptive">Descriptive (LLM-assisted marking)</option><option value="mcq">MCQ (auto-checked)</option></select></label>
        <label>Max marks<input type="number" step="0.5" min="0.5" data-q="max_marks" required></label><label>CO (optional)<input data-q="co" placeholder="CO1"></label></div>
      <div class="desc-only">
        <label>Model answer / key points (never shown to students)<textarea data-q="model_answer" required></textarea></label>
        <h3>Rubric <span class="muted small">(criterion marks must add up to max marks)</span></h3>
        <div class="rub"></div><button type="button" class="ghost small addr">+ Add criterion</button>
      </div>
      <div class="mcq-only">
        <h3>Options <span class="muted small">(select the radio button of the correct option)</span></h3>
        <div class="opt"></div><button type="button" class="ghost small addo">+ Add option</button>
      </div>`;
    box.querySelector('.rub').append(rubricRow());
    box.querySelector('.addr').onclick = () => box.querySelector('.rub').append(rubricRow());
    const opt = box.querySelector('.opt');
    for (let i = 0; i < 4; i++) opt.append(optionRow(group));
    box.querySelector('.addo').onclick = () => opt.children.length < 6 && opt.append(optionRow(group));
    box.querySelector('[data-q=kind]').onchange = () => setKind(box);
    lockKind(box);
    box.querySelector('.rm').onclick = () => { if (qs.children.length > 1) { box.remove(); renumber(); } };
    qs.append(box);
    renumber();
  };
  const renumber = () => [...qs.children].forEach((b, i) => (b.querySelector('.qn').textContent = `Question ${i + 1}`));
  document.getElementById('addq').onclick = addQuestion;
  addQuestion();
  f.type.onchange = syncRelease;
  syncRelease();

  f.onsubmit = act(async () => {
    const questions = [...qs.children].map((b) => {
      const base = {
        kind: b.querySelector('[data-q=kind]').value,
        text: b.querySelector('[data-q=text]').value,
        max_marks: +b.querySelector('[data-q=max_marks]').value,
        co: b.querySelector('[data-q=co]').value,
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
      subject_id: +f.subject_id.value, section_ids: [...f.querySelectorAll('[name=section]:checked')].map((x) => +x.value), type: f.type.value,
      number: +f.number.value, duration_min: +f.duration_min.value,
      start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      release_mode: f.release_mode.value, shuffle: f.shuffle.checked, questions,
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
  const total = a.questions.reduce((s, q) => s + q.max_marks, 0);
  const sheet = await api('GET', `/assessments/${id}/marks`);
  if (seq !== nav_seq) return;
  app.innerHTML = `<div class="between"><h1>${title(a)}</h1>
      ${a.status !== 'draft' ? '<span class="pill ok">Published</span>' : a.can.edit ? '<button id="pub">Publish to students</button>' : '<span class="pill warn">Draft</span>'}</div>
    <div class="card"><div class="muted">${fmt(a.start_at)} → ${fmt(a.end_at)} · ${a.duration_min} min · ${num(total)} marks ·
      Result release: <b>${a.release_mode === 'instant' ? 'Instant' : 'After faculty approval'}</b>${a.shuffle ? ' · Question order shuffled per student' : ''}</div>
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
    <div class="card"><h2>Questions</h2>${a.questions.map((q) => `<div class="qbox"><div class="between"><h3>Q${q.seq}${q.co ? ` · ${esc(q.co)}` : ''}</h3><span class="pill">${num(q.max_marks)} marks</span></div>
      <div class="answer">${esc(q.text)}</div>${q.kind === 'mcq' ? optionList(q.options, null, q.correct_index)
        : `<div class="muted small">Rubric: ${q.rubric.map((r) => `${esc(r.criterion)} (${num(r.marks)})`).join(' · ')}</div>`}</div>`).join('')}</div>`;
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
  const maxTotal = qs.reduce((s, q) => s + q.max_marks, 0);
  const totals = sheet.students.map((st) => qs.reduce((s, q) => s + (st.marks[q.id] ?? 0), 0));
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const cos = [...new Set(qs.map((q) => q.co).filter(Boolean))].sort();
  const qRows = () => qs.map((q) => {
    const m = avg(sheet.students.map((st) => st.marks[q.id] ?? 0));
    return `<tr><td>Q${q.seq}</td><td>${esc(q.co || '–')}</td><td>${num(q.max_marks)}</td><td>${num(m)}</td><td>${pct(m / q.max_marks)}</td></tr>`;
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
      <div class="between"><h2>Q${a.seq}${a.co ? ` · ${esc(a.co)}` : ''}</h2><span class="pill">${num(a.max_marks)} marks</span></div>
      <div class="answer">${esc(a.qtext)}</div>
      <h3>Student answer</h3>${a.kind === 'mcq' ? optionList(a.options, a.text, a.correct_index)
        : `<div class="answer">${a.text.trim() ? esc(a.text) : '<span class="muted">Not attempted</span>'}</div>`}
      ${a.eval_status === 'failed' ? `<div class="note bad">Evaluation failed: ${esc(a.eval_error)}</div>` : ''}
      ${a.llm && a.kind === 'mcq' ? `<h3>Auto-checked: ${num(a.llm_marks)} / ${num(a.max_marks)}</h3>` : a.llm ? `<h3>LLM draft: ${num(a.llm_marks)} / ${num(a.max_marks)} <span class="pill ${a.llm_confidence === 'low' ? 'warn' : 'ok'}">${esc(a.llm_confidence)} confidence</span></h3>
        <table><thead><tr><th>Criterion</th><th>Marks</th><th>Justification</th></tr></thead><tbody>${a.llm.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${num(c.awarded)} / ${num(c.max)}</td><td>${why(c)}</td></tr>`).join('')}</tbody></table>
        ${a.llm.missing_points.length ? `<h3>Missing points</h3><ul class="tight">${a.llm.missing_points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.llm.improvements.length ? `<h3>Suggested improvements</h3><ul class="tight">${a.llm.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}` : ''}
      ${a.kind === 'mcq' ? '' : `<details><summary class="muted small">Model answer</summary><div class="answer">${esc(a.model_answer)}</div></details>`}
      <div class="row"><label>Final marks (0–${num(a.max_marks)})<input type="number" step="0.5" min="0" max="${a.max_marks}" data-f="marks" value="${a.final_marks ?? a.llm_marks ?? ''}" required></label>
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
const letterhead = (inst) => (inst.institute || inst.logo
  ? `<div class="letterhead">${inst.logo ? `<img src="${esc(inst.logo)}" alt="">` : ''}<div><div class="inst-name">${esc(inst.institute)}</div>${inst.line ? `<div>${esc(inst.line)}</div>` : ''}</div></div>` : '');

// ---------- printable documents (faculty) ----------
// Each page is laid out for A4. "Print / Save as PDF" opens the browser's print dialog, where
// "Save as PDF" gives a file for the course file or accreditation records.

function answerSheet(t, head = '') {
  const final = t.status === 'published';
  const got = t.answers.reduce((s, a) => s + ((final ? a.final_marks : a.llm_marks) ?? 0), 0);
  const max = t.answers.reduce((s, a) => s + a.max_marks, 0);
  return `<section class="doc">${head}<h1>Evaluated Answer Sheet</h1>
    <table class="meta"><tbody><tr><th>Assessment</th><td>${title(t)}</td><th>Student</th><td>${esc(t.student_name)}</td></tr>
      <tr><th>Submitted</th><td>${t.submitted_at ? fmt(t.submitted_at) : '–'}</td><th>Roll no</th><td>${esc(t.roll_no)}</td></tr>
      <tr><th>${final ? 'Marks awarded' : 'Draft marks'}</th><td><b>${num(got)} / ${num(max)}</b>${final ? '' : ' (not yet approved by faculty)'}</td><th>Tab switches / paste tries</th><td>${t.tab_switches} / ${t.paste_attempts}</td></tr></tbody></table>
    ${t.answers.map((a) => {
      const marks = final ? a.final_marks : a.llm_marks;
      const moderated = final && a.llm_marks !== null && Math.abs(a.final_marks - a.llm_marks) > 1e-9;
      return `<div class="qblock"><div class="between"><h3>Q${a.seq}${a.co ? ` (${esc(a.co)})` : ''}. ${esc(a.qtext)}</h3><b class="nowrap">${num(marks)} / ${num(a.max_marks)}</b></div>
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
    const total = a.questions.reduce((s, q) => s + q.max_marks, 0);
    if (kind === 'paper' || kind === 'key') {
      const key = kind === 'key';
      html = `<section class="doc">${head}<h1>${key ? 'Question Paper with Answer Key and Rubric' : 'Question Paper'}</h1>${meta(a, total)}
        ${a.questions.map((q) => `<div class="qblock"><div class="between"><h3>Q${q.seq}. ${esc(q.text)}</h3><b class="nowrap">[${num(q.max_marks)}]${q.co ? ` ${esc(q.co)}` : ''}</b></div>
          ${q.kind === 'mcq' ? optionList(q.options, null, key ? q.correct_index : null)
            : key ? `<p class="small"><b>Model answer / key points:</b></p><div class="answer">${esc(q.model_answer)}</div>
              <table><thead><tr><th>Rubric criterion</th><th>Marks</th></tr></thead><tbody>${q.rubric.map((r) => `<tr><td>${esc(r.criterion)}</td><td>${num(r.marks)}</td></tr>`).join('')}</tbody></table>` : ''}</div>`).join('')}
        ${key ? `<p class="sign">Faculty: ${esc(user.name)} &nbsp; Signature: ____________________</p>` : ''}</section>`;
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
    <div class="paper">${html}<p class="genline">Generated from Assessment Portal on ${fmt(new Date().toISOString())}</p></div>`;
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
    <form id="f">${d.questions.map((q) => `<div class="card"><div class="between"><h2>Q${q.seq}</h2><span class="pill">${num(q.max_marks)} marks</span></div>
      <div class="answer">${esc(q.text)}</div>
      ${q.kind === 'mcq' ? `<div class="mcq" data-q="${q.id}">${q.options.map((o, i) => `<label class="choice"><input type="radio" name="q${q.id}" value="${i}"${/^\d+$/.test(q.answer) && +q.answer === i ? ' checked' : ''}> ${String.fromCharCode(65 + i)}. ${esc(o)}</label>`).join('')}
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
  const got = r.answers.reduce((s, a) => s + a.marks, 0);
  const max = r.answers.reduce((s, a) => s + a.max_marks, 0);
  app.innerHTML = `<p class="between no-print"><a href="#/">← My assessments</a><button class="ghost" onclick="window.print()">Print / Save as PDF</button></p>
    <div class="print-only">${head}</div><h1>${title(r.assessment)}</h1><p class="print-only">${esc(user.name)}${user.roll_no ? ` · Roll no ${esc(user.roll_no)}` : ''}</p>
    <div class="card"><div class="muted">Total marks</div><div class="score">${num(got)} / ${num(max)}</div></div>
    ${r.answers.map((a) => `<div class="card"><div class="between"><h2>Q${a.seq}</h2><span class="pill ${a.marks >= a.max_marks * 0.6 ? 'ok' : 'warn'}">${num(a.marks)} / ${num(a.max_marks)}</span></div>
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
    if (user.must_change || page === 'password') return viewPassword();
    if (user.role === 'owner') return await viewOwner();
    if (user.role === 'student') {
      if (page === 'attempt' && id) return await viewAttempt(+id);
      if (page === 'result' && id) return await viewResult(+id);
      return await viewStudentHome();
    }
    const p = user.perms;
    if (page === 'setup' && p.manage) return await viewAdmin();
    if (page === 'new' && p.create) return await viewNew();
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
