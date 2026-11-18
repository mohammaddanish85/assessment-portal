// COGNEXA institute setup, registrar's student list, class coordinator and DQAC pages.
// Loaded before app.js; uses its helpers (api, esc, ask, act, toast, fmt, nav_seq) only when a page is drawn.

// ---------- Excel import: template → upload → preview → import ----------

const slug = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
let xlsxReady = null;
const loadXLSX = () => (xlsxReady ||= new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = '/vendor/xlsx.full.min.js';
  s.onload = ok;
  s.onerror = () => { xlsxReady = null; no(new Error('Could not load the Excel reader. Check the connection and try again.')); };
  document.head.append(s);
}));

const IMPORTS = {
  subjects: {
    title: 'scheme', file: 'COGNEXA_scheme_template.xlsx',
    columns: ['Code', 'Subject name', 'Department', 'Programme', 'Semester', 'Type', 'Elective group', 'Credits',
      'CO1', 'CO1 level', 'CO2', 'CO2 level', 'CO3', 'CO3 level', 'CO4', 'CO4 level', 'CO5', 'CO5 level', 'CO6', 'CO6 level'],
    example: ['PCC-CYS-501', 'Steganography and Digital Watermarking', 'Computer Science and Engineering', 'B.Tech CSE (Cyber Security)', 5, 'Theory', '', 3,
      'Explain the fundamentals of steganography and secret communication frameworks.', 'Understand',
      'Apply steganography techniques in spatial, transform and statistical domains.', 'Apply'],
    note: 'One row per subject. Type is Theory, Lab or Elective (give electives a group such as PEC-5). CO level is 1–6 or Remember, Understand, Apply, Analyse, Evaluate, Create. Up to 8 COs: add CO7 / CO7 level columns if needed. Re-uploading updates subjects with the same code.',
  },
  faculty: {
    title: 'faculty list', file: 'COGNEXA_faculty_template.xlsx',
    columns: ['Employee ID', 'Name', 'Department', 'Designation', 'Role', 'Email', 'Mobile'],
    example: ['EIT1042', 'Dr. Mohammad Danish', 'Computer Science and Engineering', 'Associate Professor', 'Faculty', 'name@college.edu', '9800000000'],
    note: 'Role is Faculty (default), HOD, Dean, Director, Registrar or Nodal. The employee ID is the login username; new accounts get the institute\'s first password and set their own at first login.',
  },
  allotment: {
    title: 'subject allotment', file: 'COGNEXA_allotment_template.xlsx',
    columns: ['Subject code', 'Section', 'Employee ID'],
    example: ['PCC-CYS-501', 'CSE-CS Sem 5 A', 'EIT1042'],
    note: 'One row per subject and section. A faculty member can have many rows; each section of a subject can have a different faculty member.',
  },
  students: {
    title: 'student list', file: 'COGNEXA_students_template.xlsx',
    columns: ['University roll no', 'College roll no', 'Name', 'Programme', 'Semester', 'Section', 'Email', 'Mobile'],
    example: ['05715611925', 'CSC-25-11', 'Student Name', 'B.Tech CSE (Cyber Security)', 1, 'CSE-CS Sem 1 A', 'student@college.edu', '9800000000'],
    note: 'Roll nos already in COGNEXA are updated, new ones are added, nothing is duplicated. The university roll no is the login (the college roll no until the university one is issued). New students get the institute\'s first password.',
  },
  electives: {
    title: 'elective choices', file: 'COGNEXA_electives_template.xlsx',
    columns: ['Roll no', 'Subject code'],
    example: ['05715611925', 'PEC-CYS-505'],
    note: 'Only for electives that a section splits between students. By default the whole section takes an elective.',
  },
};
const ACTION_PILL = { new: '<span class="pill ok">New</span>', update: '<span class="pill">Update</span>', same: '<span class="pill" style="background:#f1eff4;color:var(--muted)">No change</span>', error: '<span class="pill bad">Fix</span>' };

async function downloadTemplate(kind) {
  await loadXLSX();
  const d = IMPORTS[kind];
  const ws = XLSX.utils.aoa_to_sheet([d.columns, d.example]);
  ws['!cols'] = d.columns.map((c) => ({ wch: Math.max(14, c.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, d.file);
}

// Renders the upload box into el. approve: wording for the final button (the registrar "approves" a student list).
function mountImport(el, kind, onDone, approve = 'Import') {
  const d = IMPORTS[kind];
  el.innerHTML = `<div class="import">
    <p class="small muted" style="margin-top:0">${esc(d.note)}</p>
    <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
      <button type="button" class="ghost small" data-tpl style="flex:none">Download Excel template</button>
      <label class="small" style="margin:0;flex:1 1 260px">Upload the filled ${esc(d.title)} (.xlsx, .xls or .csv)
        <input type="file" accept=".xlsx,.xls,.csv" data-file></label></div>
    <div data-out></div></div>`;
  el.querySelector('[data-tpl]').onclick = act(() => downloadTemplate(kind));
  const out = el.querySelector('[data-out]');
  let rows = null;
  el.querySelector('[data-file]').onchange = act(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer());
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false })
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [slug(k), String(v).trim()])))
      .filter((r) => Object.values(r).some((v) => v !== ''));
    if (!rows.length) throw new Error('The file has no data rows under the header row');
    const missing = d.columns.slice(0, 1).filter((c) => !(slug(c) in rows[0]));
    if (missing.length) throw new Error(`The first sheet needs a "${missing[0]}" column. Use the template.`);
    const p = await api('POST', `/import/${kind}`, { rows });
    draw(p, file.name);
  });
  const draw = (p, name) => {
    const s = p.summary;
    const go = s.new + s.update;
    const sorted = [...p.rows].sort((a, b) => ['error', 'new', 'update', 'same'].indexOf(a.action) - ['error', 'new', 'update', 'same'].indexOf(b.action));
    out.innerHTML = `<div class="preview">
      <div class="between"><b>${esc(name)}: preview, nothing saved yet</b>
        <span class="small">${kind === 'students' ? `Before <b>${s.before}</b> · ` : ''}New <b>${s.new}</b> · Updated <b>${s.update}</b> · No change <b>${s.same}</b> · To fix <b class="${s.error ? 'bad-text' : ''}">${s.error}</b>${kind === 'students' ? ` · After <b>${s.after}</b>` : ''}</span></div>
      <div class="scroll"><table><thead><tr><th>Row</th><th>Key</th><th></th><th>Details</th></tr></thead><tbody>
        ${sorted.map((r) => `<tr${r.action === 'error' ? ' class="bad-row"' : ''}><td>${r.n}</td><td class="nowrap">${esc(r.key)}</td><td>${ACTION_PILL[r.action]}</td><td class="small">${esc(r.error || r.detail || '')}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="between" style="margin-top:10px">${s.error ? `<span class="small bad-text">${s.error} row(s) will be skipped. Fix them in the file and upload again, or import the rest now.</span>` : '<span class="small muted">No duplicates and no errors.</span>'}
        ${go ? `<button type="button" data-go>${approve} ${go} row${go > 1 ? 's' : ''}</button>` : '<span class="small muted">Nothing new to import.</span>'}</p></div>`;
    const b = out.querySelector('[data-go]');
    if (b) b.onclick = act(async () => {
      const r = await api('POST', `/import/${kind}?commit=1`, { rows });
      toast(`${r.summary.new} added, ${r.summary.update} updated`);
      onDone && onDone();
    });
  };
}

// ---------- shared bits ----------

const tbl = (head, rows, empty) => (rows.length
  ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  : `<p class="muted">${empty}</p>`);
const RBT_SHORT = ['', 'Remember', 'Understand', 'Apply', 'Analyse', 'Evaluate', 'Create'];
const imgPicker = (max, onPick) => (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type)) return toast('Use a PNG or JPG image', true);
  if (file.size > max * 1024) return toast(`Image is too large (keep it under ${max} KB)`, true);
  const r = new FileReader();
  r.onload = () => onPick(r.result);
  r.readAsDataURL(file);
};

// ---------- institute setup (admin) ----------

const SETUP_STEPS = [
  ['profile', 'Institute profile'], ['departments', 'Departments'], ['programmes', 'Programmes'], ['scheme', 'Scheme and subjects'],
  ['faculty', 'Faculty'], ['sections', 'Sections'], ['allotment', 'Subject allotment'], ['activity', 'Activity log'],
];

async function viewInstSetup(step = 'profile') {
  const seq = nav_seq;
  const [d, inst] = await Promise.all([api('GET', '/setup/data'), api('GET', '/settings')]);
  if (seq !== nav_seq) return;
  const done = {
    profile: !!(inst.institute && d.has_first_password && inst.settings.session), departments: d.departments.length > 0, programmes: d.programmes.length > 0,
    scheme: d.subjects.length > 0, faculty: d.staff.some((x) => x.post !== 'admin'), sections: d.sections.length > 0, allotment: d.allotments.length > 0, activity: true,
  };
  const count = Object.values(done).filter(Boolean).length - 1;
  app.innerHTML = `<div class="between"><h1>Institute setup</h1><span class="small muted">Institute code <b>${esc(inst.code)}</b>${inst.settings.session ? ` · Session <b>${esc(inst.settings.session)}</b>` : ''}</span></div>
    <div class="stats">
      <div><span>Departments</span><b>${d.departments.length}</b></div><div><span>Faculty</span><b>${d.staff.filter((x) => x.post !== 'admin').length}</b></div>
      <div><span>Subjects</span><b>${d.subjects.length}</b></div><div><span>Students</span><b>${d.students}</b></div></div>
    <div class="setup">
      <nav class="stepper" aria-label="Setup steps"><p class="small muted" style="margin:0 0 6px">Checklist · ${count} of ${SETUP_STEPS.length - 1} done</p>
        ${SETUP_STEPS.map(([k, label], i) => `<a href="#/setup/${k}" class="${k === step ? 'on' : ''}${done[k] && k !== 'activity' ? ' ok' : ''}"${k === step ? ' aria-current="page"' : ''}>
          <span class="n">${done[k] && k !== 'activity' ? '✓' : k === 'activity' ? '·' : i + 1}</span>${label}</a>`).join('')}</nav>
      <section class="card" id="stepbody" style="min-width:0"></section></div>`;
  const body = document.getElementById('stepbody');
  const again = () => viewInstSetup(step);
  const deptOpts = (sel, blank = 'Choose department…') => `<option value="">${blank}</option>${d.departments.map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  const staffOpts = (sel, blank) => `<option value="">${blank}</option>${d.staff.filter((x) => x.post !== 'admin').map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}${x.emp_id ? ` (${esc(x.emp_id)})` : ''}</option>`).join('')}`;

  if (step === 'profile') {
    const F = inst.format || {};
    const S = inst.settings || {};
    let logo = inst.logo;
    let lhead = inst.letterhead || '';
    body.innerHTML = `<h2>Institute profile and rules</h2>
      <form id="finst"><div class="row"><label style="flex:2 1 260px">Institute name<input name="institute" value="${esc(inst.institute)}" required></label>
        <label style="flex:2 1 260px">Second line (address or affiliation)<input name="line" value="${esc(inst.line)}"></label></div>
        <div class="row"><label>Academic session<input name="session" value="${esc(S.session || '')}" placeholder="2026-27 Odd" required></label>
          <label>First password for new accounts<input name="default_password" autocomplete="off" placeholder="${d.has_first_password ? 'Set — type to change' : 'e.g. EIT@12345'}"${d.has_first_password ? '' : ' required'}></label>
          <label>Pass mark (%)<input name="pass_percent" type="number" min="1" max="100" value="${S.pass_percent ?? 40}"></label></div>
        <div class="row"><label>Default rank<select name="rank_scope"><option value="section"${S.rank_scope !== 'branch' ? ' selected' : ''}>Section-wise</option><option value="branch"${S.rank_scope === 'branch' ? ' selected' : ''}>Branch-wise (all sections)</option></select></label>
          <label>Test start code changes every<select name="code_minutes"><option value="5"${S.code_minutes !== 10 ? ' selected' : ''}>5 minutes</option><option value="10"${S.code_minutes === 10 ? ' selected' : ''}>10 minutes</option></select></label></div>
        <p class="small muted" style="margin-top:-4px">New students and faculty log in with the first password and must set their own at first login.</p>
        <div class="row" style="align-items:center"><label>Logo (PNG or JPG, under 300 KB)<input type="file" id="logofile" accept="image/png,image/jpeg"></label><div id="logoprev" style="flex:0 0 auto"></div></div>
        <label>Letterhead (header image, full page width, under 700 KB)<input type="file" id="lhfile" accept="image/png,image/jpeg"></label>
        <div id="lhprev"></div>
        <h3 style="margin-top:14px">Question paper format</h3>
        <div class="row"><label>Taxonomy column on exam papers<input name="tax_exam" value="${esc(F.tax_exam || 'RBTL')}"></label>
          <label>Shown as<select name="tax_exam_style"><option value="code"${F.tax_exam_style !== 'name' ? ' selected' : ''}>Code, e.g. RBTL-2</option><option value="name"${F.tax_exam_style === 'name' ? ' selected' : ''}>Level name, e.g. Understand</option></select></label>
          <label>Code prefix<input name="tax_code" value="${esc(F.tax_code || 'RBTL')}"></label></div>
        <div class="row"><label>Taxonomy column on assignments<input name="tax_asg" value="${esc(F.tax_asg || 'R. Bloom Taxonomy Level')}"></label>
          <label>Shown as<select name="tax_asg_style"><option value="name"${F.tax_asg_style !== 'code' ? ' selected' : ''}>Level name, e.g. Analyse</option><option value="code"${F.tax_asg_style === 'code' ? ' selected' : ''}>Code, e.g. RBTL-4</option></select></label></div>
        <div class="row"><label>Signature lines on exam papers (separate with |)<input name="sign_exam" value="${esc(F.sign_exam ?? 'Faculty Name and Sign. | HOD Sign.')}"></label>
          <label>Signature lines on assignments (separate with |)<input name="sign_asg" value="${esc(F.sign_asg || '')}" placeholder="Leave empty for none"></label></div>
        <label class="choice" style="max-width:360px"><input type="checkbox" name="roll"${F.roll === false ? '' : ' checked'}> Print "Roll No. ……" on exam papers</label>
        <p><button>Save profile</button></p></form>`;
    const drawLogo = () => {
      const p = document.getElementById('logoprev');
      p.innerHTML = logo ? `<img src="${esc(logo)}" alt="Logo" style="max-height:56px;max-width:150px"> <button type="button" class="ghost small" id="rmlogo">Remove</button>` : '<span class="muted small">No logo</span>';
      const rm = document.getElementById('rmlogo');
      if (rm) rm.onclick = () => { logo = ''; drawLogo(); };
    };
    const drawLh = () => {
      const p = document.getElementById('lhprev');
      p.innerHTML = lhead ? `<div class="lh-preview"><img src="${esc(lhead)}" alt="Letterhead"></div><button type="button" class="ghost small" id="rmlh">Remove letterhead</button>` : '<span class="muted small">No letterhead uploaded</span>';
      const rm = document.getElementById('rmlh');
      if (rm) rm.onclick = () => { lhead = ''; drawLh(); };
    };
    drawLogo(); drawLh();
    document.getElementById('logofile').onchange = imgPicker(300, (v) => { logo = v; drawLogo(); });
    document.getElementById('lhfile').onchange = imgPicker(700, (v) => { lhead = v; drawLh(); });
    document.getElementById('finst').onsubmit = act(async (e) => {
      const g = e.target;
      await api('POST', '/admin/settings', {
        institute: g.institute.value, line: g.line.value, logo, letterhead: lhead,
        format: { tax_exam: g.tax_exam.value, tax_exam_style: g.tax_exam_style.value, tax_code: g.tax_code.value, tax_asg: g.tax_asg.value,
          tax_asg_style: g.tax_asg_style.value, sign_exam: g.sign_exam.value, sign_asg: g.sign_asg.value, roll: g.roll.checked },
        settings: { session: g.session.value, default_password: g.default_password.value, pass_percent: +g.pass_percent.value, rank_scope: g.rank_scope.value, code_minutes: +g.code_minutes.value },
      });
      user.institute_name = g.institute.value.trim();
      drawNav();
      toast('Profile saved');
      again();
    });
  }

  if (step === 'departments') {
    body.innerHTML = `<h2>Departments (${d.departments.length})</h2>
      <form id="fdep" class="row"><label style="flex:3 1 260px">Department name<input name="name" placeholder="Computer Science and Engineering" required></label><p><button>Add department</button></p></form>
      ${tbl(['Department', ''], d.departments.map((x) => `<tr><td>${esc(x.name)}</td><td class="right nowrap"><button type="button" class="ghost small" data-ren="${x.id}">Rename</button> <button type="button" class="ghost small" data-del="${x.id}">Delete</button></td></tr>`), 'No departments yet.')}`;
    document.getElementById('fdep').onsubmit = act(async (e) => { await api('POST', '/admin/departments', { name: e.target.name.value }); toast('Department added'); again(); });
    body.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = act(async () => {
      const x = d.departments.find((y) => y.id === +b.dataset.ren);
      const v = await ask('Rename department', { ok: 'Save', fields: [{ name: 'name', label: 'Department name', value: x.name }] });
      if (v) { await api('PUT', `/admin/departments/${x.id}`, v); again(); }
    })));
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = act(async () => {
      if (!(await ask('Delete this department?', { ok: 'Delete' }))) return;
      await api('DELETE', `/admin/departments/${b.dataset.del}`); again();
    })));
  }

  if (step === 'programmes') {
    body.innerHTML = `<h2>Programmes (${d.programmes.length})</h2>
      <p class="small muted" style="margin-top:0">A programme is what a student is enrolled in, e.g. "B.Tech CSE (Cyber Security)". Programmes named in the scheme upload are added automatically.</p>
      <form id="fprog" class="row"><label style="flex:2 1 240px">Programme name<input name="name" required placeholder="B.Tech CSE (Cyber Security)"></label>
        <label>Department<select name="department_id" required>${deptOpts()}</select></label><p><button>Add programme</button></p></form>
      ${tbl(['Programme', 'Department', ''], d.programmes.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.department || '–')}</td><td class="right"><button type="button" class="ghost small" data-del="${x.id}">Delete</button></td></tr>`), 'No programmes yet.')}`;
    document.getElementById('fprog').onsubmit = act(async (e) => { await api('POST', '/setup/programmes', Object.fromEntries(new FormData(e.target))); toast('Programme added'); again(); });
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = act(async () => {
      if (!(await ask('Delete this programme?', { ok: 'Delete' }))) return;
      await api('DELETE', `/setup/programmes/${b.dataset.del}`); again();
    })));
  }

  if (step === 'scheme') {
    body.innerHTML = `<h2>Scheme and subjects (${d.subjects.length})</h2><div id="imp"></div>
      ${tbl(['Code', 'Subject', 'Programme', 'Sem', 'Type', 'Course outcomes'], d.subjects.map((x) => `<tr><td class="nowrap">${esc(x.code)}</td><td>${esc(x.name)}</td>
        <td class="small">${esc(x.programme || '–')}</td><td>${x.semester ?? '–'}</td><td class="small">${esc(x.type || 'Theory')}${x.elective_group ? ` · ${esc(x.elective_group)}` : ''}</td>
        <td class="small">${x.cos.length ? `<details><summary>${x.cos.length} COs</summary>${x.cos.map((c) => `<div><b>${esc(c.co)}</b> (${RBT_SHORT[c.rbtl]}): ${esc(c.text)}</div>`).join('')}</details>` : '<span class="bad-text">No COs</span>'}</td></tr>`), 'No subjects yet. Upload the scheme.')}`;
    mountImport(document.getElementById('imp'), 'subjects', again);
  }

  if (step === 'faculty') {
    const staff = d.staff;
    body.innerHTML = `<h2>Faculty and staff (${staff.filter((x) => x.post !== 'admin').length})</h2><div id="imp"></div>
      ${tbl(['Employee ID', 'Name', 'Department', 'Designation', 'Role', ''], staff.map((x) => `<tr><td class="nowrap">${esc(x.emp_id || x.username)}</td><td>${esc(x.name)}${x.self ? ' <span class="pill">You</span>' : ''}</td>
        <td class="small">${esc(x.department || '–')}</td><td class="small">${esc(x.designation || '–')}</td><td>${x.post === 'admin' ? 'Institute admin' : esc(d.posts[x.post] || x.post)}</td>
        <td class="right nowrap">${x.post === 'admin' ? '' : `<button type="button" class="ghost small" data-edit="${x.id}">Edit</button> <button type="button" class="ghost small" data-reset="${x.id}">Reset password</button>`}</td></tr>`), 'No faculty yet. Upload the faculty list.')}`;
    mountImport(document.getElementById('imp'), 'faculty', again);
    body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = act(async () => {
      const x = staff.find((y) => y.id === +b.dataset.edit);
      const v = await ask(`Edit ${x.name}`, { ok: 'Save', fields: [
        { name: 'name', label: 'Name', value: x.name },
        { name: 'designation', label: 'Designation', value: x.designation || '', optional: true },
        { name: 'department_id', label: 'Department', value: x.department_id ?? '', options: d.departments.map((y) => ({ value: y.id, label: y.name })) },
        { name: 'post', label: 'Role', value: x.post, options: Object.entries(d.posts).map(([k, v2]) => ({ value: k, label: v2 })) },
        { name: 'email', label: 'Email', value: x.email || '', optional: true },
        { name: 'mobile', label: 'Mobile', value: x.mobile || '', optional: true }] });
      if (!v) return;
      await api('PUT', `/setup/staff/${x.id}`, v); toast('Saved'); again();
    })));
    body.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = act(async () => {
      const x = staff.find((y) => y.id === +b.dataset.reset);
      const v = await ask(`New password for ${x.name} (minimum 6 characters). They must choose their own at next login.`, { ok: 'Reset password', fields: [{ name: 'password', label: 'New password', min: 6 }] });
      if (!v) return;
      await api('POST', `/admin/users/${x.id}/password`, { password: v.password }); toast('Password reset');
    })));
  }

  if (step === 'sections') {
    const progOpts = (sel) => `<option value="">Choose programme…</option>${d.programmes.map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`;
    body.innerHTML = `<h2>Sections (${d.sections.length})</h2>
      <form id="fsec"><div class="row"><label style="flex:2 1 200px">Section name<input name="name" required placeholder="CSE-CS Sem 5 A"></label>
        <label style="flex:2 1 220px">Programme<select name="programme_id" required>${progOpts()}</select></label>
        <label style="max-width:120px">Semester<input name="semester" type="number" min="1" max="12" required></label></div>
        <div class="row"><label>Class coordinator<select name="coordinator_id">${staffOpts(null, 'Choose later')}</select></label><p><button>Add section</button></p></div></form>
      ${tbl(['Section', 'Programme', 'Sem', 'Class coordinator', 'Students', ''], d.sections.map((x) => `<tr><td>${esc(x.name)}</td><td class="small">${esc(x.programme || '–')}</td><td>${x.semester ?? '–'}</td>
        <td>${x.coordinator ? esc(x.coordinator) : '<span class="muted">Not set</span>'}</td><td>${x.students}</td><td class="right"><button type="button" class="ghost small" data-edit="${x.id}">Edit</button></td></tr>`), 'No sections yet.')}`;
    document.getElementById('fsec').onsubmit = act(async (e) => { await api('POST', '/setup/sections', Object.fromEntries(new FormData(e.target))); toast('Section added'); again(); });
    body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = act(async () => {
      const x = d.sections.find((y) => y.id === +b.dataset.edit);
      const v = await ask(`Edit ${x.name}`, { ok: 'Save', fields: [
        { name: 'name', label: 'Section name', value: x.name },
        { name: 'programme_id', label: 'Programme', value: x.programme_id ?? '', options: d.programmes.map((y) => ({ value: y.id, label: y.name })) },
        { name: 'semester', label: 'Semester', value: x.semester ?? '', type: 'number' },
        { name: 'coordinator_id', label: 'Class coordinator', value: x.coordinator_id ?? '', options: [{ value: '', label: 'Not set' }, ...d.staff.filter((y) => y.post !== 'admin').map((y) => ({ value: y.id, label: y.name }))] }] });
      if (!v) return;
      await api('PUT', `/setup/sections/${x.id}`, v); toast('Saved'); again();
    })));
  }

  if (step === 'allotment') {
    body.innerHTML = `<h2>Subject allotment (${d.allotments.length})</h2><div id="imp"></div>
      <details style="margin:10px 0"><summary class="small">Add or change one row</summary>
        <form id="fal" class="row" style="margin-top:8px"><label>Subject<select name="subject_id" required><option value="">Choose…</option>${d.subjects.map((x) => `<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}</option>`).join('')}</select></label>
          <label>Section<select name="section_id" required><option value="">Choose…</option>${d.sections.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
          <label>Faculty<select name="faculty_id" required>${staffOpts(null, 'Choose…')}</select></label><p><button>Save</button></p></form></details>
      ${tbl(['Section', 'Subject', 'Faculty', ''], d.allotments.map((x) => `<tr><td>${esc(x.section)}</td><td>${esc(x.code)} · ${esc(x.subject)}</td><td>${esc(x.faculty)}</td>
        <td class="right"><button type="button" class="ghost small" data-del="${x.id}">Remove</button></td></tr>`), 'Nothing allotted yet.')}`;
    mountImport(document.getElementById('imp'), 'allotment', again);
    document.getElementById('fal').onsubmit = act(async (e) => { await api('POST', '/setup/allotments', Object.fromEntries(new FormData(e.target))); toast('Saved'); again(); });
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = act(async () => { await api('DELETE', `/setup/allotments/${b.dataset.del}`); again(); })));
  }

  if (step === 'activity') {
    const a = await api('GET', '/admin/data');
    if (seq !== nav_seq) return;
    body.innerHTML = `<h2>Activity log <span class="muted small">(latest 100)</span></h2>
      ${tbl(['When', 'Who', 'What', 'Details'], a.audit.map((x) => `<tr><td class="nowrap">${fmt(x.at)}</td><td>${esc(x.user_name)}</td><td>${esc(x.action)}</td><td class="small">${esc(x.detail)}</td></tr>`), 'Nothing recorded yet.')}`;
  }
}

// ---------- students: registrar (all), class coordinator (own sections) ----------

async function viewStudents(sectionId = 0) {
  const seq = nav_seq;
  const registrar = !!(user.perms.students || user.perms.manage);
  const editor = !!user.perms.students;
  const mine = user.coordinates || [];
  const [d, list, requests] = await Promise.all([
    registrar ? api('GET', '/setup/data') : Promise.resolve({ sections: mine }),
    sectionId || registrar ? api('GET', `/students${sectionId ? `?section=${sectionId}` : ''}`) : Promise.resolve([]),
    api('GET', '/reset-requests'),
  ]);
  if (seq !== nav_seq) return;
  const sections = registrar ? d.sections : mine;
  if (!registrar && !sectionId && mine.length) return viewStudents(mine[0].id);
  const statusPill = (s) => (s === 'active' ? '' : ` <span class="pill ${s === 'left' ? 'bad' : 'warn'}">${s === 'left' ? 'Left' : 'Detained'}</span>`);
  app.innerHTML = `<div class="between"><h1>${registrar ? 'Students' : 'My section'}</h1>
      <label style="margin:0;min-width:240px">Section<select id="secpick">${registrar ? '<option value="0">All sections</option>' : ''}${sections.map((x) => `<option value="${x.id}"${x.id === sectionId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label></div>
    ${requests.length ? `<div class="card"><h2>Password reset requests (${requests.length})</h2>
      ${tbl(['Student', 'Login', 'Section', 'Asked', ''], requests.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.username)}</td><td>${esc(r.section || '–')}</td><td class="small">${fmt(r.created_at)}</td>
        <td class="right"><button type="button" class="small" data-reset="${r.student_id}">Reset to first password</button></td></tr>`), '')}</div>` : ''}
    ${editor ? `<div class="card"><h2>Upload or update the student list</h2><div id="imp"></div>
      <details style="margin-top:8px"><summary class="small">Add one student</summary><form id="fone" style="margin-top:8px">
        <div class="row"><label>University roll no<input name="universityrollno"></label><label>College roll no<input name="collegerollno"></label><label style="flex:2 1 220px">Name<input name="name" required></label></div>
        <div class="row"><label>Section<select name="section" required><option value="">Choose…</option>${sections.map((x) => `<option>${esc(x.name)}</option>`).join('')}</select></label>
          <label>Semester (optional)<input name="semester" type="number" min="1" max="12"></label><label>Email<input name="email" type="email"></label><label>Mobile<input name="mobile"></label></div>
        <p><button>Add student</button></p></form></details>
      <details style="margin-top:6px"><summary class="small">Elective choices (only for split electives)</summary><div id="impel" style="margin-top:8px"></div></details>
      <details style="margin-top:6px"><summary class="small">Promote a section to the next semester</summary><form id="fpro" class="row" style="margin-top:8px">
        <label>From<select name="from" required><option value="">Choose…</option>${sections.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
        <label>To<select name="to" required><option value="">Choose…</option>${sections.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
        <p><button>Promote active students</button></p></form><p class="small muted">Mark detained or left students first; they stay where they are.</p></details></div>` : ''}
    <div class="card"><h2>${list.length} student${list.length === 1 ? '' : 's'}</h2>
      ${tbl(['University roll no', 'College roll no', 'Name', 'Section', 'Sem', 'Login', ''], list.map((x) => `<tr><td class="nowrap">${esc(x.univ_roll || '–')}</td><td class="nowrap">${esc(x.college_roll || '–')}</td>
        <td>${esc(x.name)}${statusPill(x.status)}</td><td class="small">${esc(x.section || '–')}</td><td>${x.semester ?? '–'}</td>
        <td class="small">${esc(x.username)}${x.must_change ? ' <span class="pill">First login pending</span>' : ''}${x.reset_open ? ' <span class="pill warn">Reset asked</span>' : ''}</td>
        <td class="right nowrap">${editor ? `<button type="button" class="ghost small" data-edit="${x.id}">Edit</button> ` : ''}<button type="button" class="ghost small" data-reset="${x.id}">Reset password</button></td></tr>`), 'No students in this view.')}</div>`;
  document.getElementById('secpick').onchange = (e) => { location.hash = `#/${registrar ? 'students' : 'my-section'}/${e.target.value}`; };
  const again = () => viewStudents(sectionId);
  if (editor) {
    mountImport(document.getElementById('imp'), 'students', again, 'Approve list and import');
    mountImport(document.getElementById('impel'), 'electives', again);
    document.getElementById('fone').onsubmit = act(async (e) => { await api('POST', '/students', Object.fromEntries(new FormData(e.target))); toast('Student added'); again(); });
    document.getElementById('fpro').onsubmit = act(async (e) => {
      const f = e.target;
      if (!(await ask(`Move every active student of "${f.from.selectedOptions[0].text}" to "${f.to.selectedOptions[0].text}"?`, { ok: 'Promote' }))) return;
      const r = await api('POST', '/students/promote', { from: +f.from.value, to: +f.to.value });
      toast(`${r.moved} student(s) promoted`); again();
    });
  }
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = act(async () => {
    const x = list.find((y) => y.id === +b.dataset.edit);
    const v = await ask(`Edit ${x.name}`, { ok: 'Save', fields: [
      { name: 'name', label: 'Name', value: x.name },
      { name: 'universityrollno', label: 'University roll no', value: x.univ_roll || '', optional: true },
      { name: 'collegerollno', label: 'College roll no', value: x.college_roll || '', optional: true },
      { name: 'section', label: 'Section (changes allowed in the first year only)', value: x.section || '', options: sections.map((y) => ({ value: y.name, label: y.name })) },
      { name: 'semester', label: 'Semester', value: x.semester ?? '', type: 'number' },
      { name: 'email', label: 'Email', value: x.email || '', optional: true },
      { name: 'mobile', label: 'Mobile', value: x.mobile || '', optional: true },
      { name: 'status', label: 'Status', value: x.status, options: [{ value: 'active', label: 'Active' }, { value: 'detained', label: 'Detained' }, { value: 'left', label: 'Left' }] }] });
    if (!v) return;
    await api('PUT', `/students/${x.id}`, v); toast('Saved'); again();
  })));
  app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = act(async () => {
    if (!(await ask('Reset this student\'s password to the institute\'s first password? They will set their own at next login.', { ok: 'Reset password' }))) return;
    await api('POST', `/students/${b.dataset.reset}/reset`, {}); toast('Password reset'); again();
  })));
}

// ---------- HOD: DQAC committee ----------

async function viewDqac() {
  const seq = nav_seq;
  const d = await api('GET', '/dqac');
  if (seq !== nav_seq) return;
  const pos = new Map(d.members.map((x) => [x.user_id, x.position]));
  app.innerHTML = `<h1>DQAC committee</h1>
    <div class="card"><p class="small muted" style="margin-top:0">Choose the department's quality assurance committee. You can change it any time; papers are sent for moderation to these members (never to the paper's own author).</p>
    <form id="fdq">${tbl(['Member', 'Name', 'Designation', 'Position', ''], d.faculty.map((x) => `<tr><td><input type="checkbox" name="m" value="${x.id}"${pos.has(x.id) ? ' checked' : ''} style="width:auto" aria-label="${esc(x.name)}"></td>
      <td>${esc(x.name)}</td><td class="small">${esc(x.designation || '–')}</td>
      <td><select data-pos="${x.id}" style="margin:0"><option value="member">Member</option><option value="coordinator"${pos.get(x.id) === 'coordinator' ? ' selected' : ''}>DQAC coordinator</option></select></td>
      <td><label class="small" style="margin:0">Signature<input type="file" accept="image/png,image/jpeg" data-sig="${x.id}" style="margin:0"></label></td></tr>`), 'No faculty in your department yet.')}
    <p><button>Save committee</button> <span class="small muted">You, as HOD, head the committee.</span></p></form></div>`;
  app.querySelectorAll('[data-sig]').forEach((inp) => (inp.onchange = imgPicker(100, async (img) => {
    try { await api('PUT', `/signature/${inp.dataset.sig}`, { image: img }); toast('Signature saved'); } catch (err) { toast(err.message, true); }
  })));
  document.getElementById('fdq').onsubmit = act(async (e) => {
    const members = [...e.target.querySelectorAll('[name=m]:checked')].map((c) => ({ user_id: +c.value, position: e.target.querySelector(`[data-pos="${c.value}"]`).value }));
    await api('PUT', '/dqac', { members });
    toast('Committee saved');
  });
}

// ---------- question paper moderation (A51) ----------

const STAGE = {
  draft: ['Draft', 'warn'], review: ['With DQAC', ''], changes: ['Changes asked', 'bad'], approved: ['Approved by HOD', 'ok'],
};
const stagePill = (s) => { const [t, c] = STAGE[s || 'draft'] || STAGE.draft; return `<span class="pill ${c}">${t}</span>`; };

// The moderation card on an assessment page: what the author, the HOD and a DQAC reviewer can do right now.
async function drawModeration(el, a, reload) {
  const d = await api('GET', `/assessments/${a.id}/moderation`);
  if (!d.needed) { el.remove(); return; }
  const cur = d.reviews.filter((r) => r.version === d.version);
  const alerts = typeof coAlerts === 'function' && d.cos.length ? coAlerts(d.cos, a.questions.map((q) => ({ co: q.co, rbtl: q.rbtl }))) : [];
  const revRow = (r) => `<tr><td>v${r.version}</td><td>${esc(r.reviewer || '–')}</td><td>${r.status === 'done' ? (r.decision === 'ok' ? '<span class="pill ok">Fit</span>' : '<span class="pill bad">Resubmit</span>') : '<span class="pill warn">Pending</span>'}</td>
    <td class="small">${r.submitted_at ? fmt(r.submitted_at) : r.due_date ? `Due ${esc(r.due_date)}` : '–'}</td>
    <td class="small">${r.status === 'done' ? `${r.checklist.filter((c) => !c.ok).length ? `${r.checklist.filter((c) => !c.ok).length} point(s) marked No. ` : 'All 10 points Yes. '}${esc(r.remarks || '')}` : ''}</td></tr>`;
  el.innerHTML = `<div class="between"><h2>Moderation (DQAC) ${stagePill(d.stage)}</h2><span class="small">${d.version ? `Version v${d.version}` : 'Not submitted yet'} · <a href="#/print/a51/${a.id}">A51 file</a></span></div>
    ${alerts.length ? `<div class="note warn"><b>CO and Bloom level check</b><ul class="tight">${alerts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${d.stage === 'approved' ? `<p class="small">Approved by <b>${esc(d.approved_by)}</b> on ${fmt(d.approved_at)}. The paper is locked; publish it when the test is due.</p>` : ''}
    ${d.can.submit && d.stage === 'draft' ? `<p>When the paper is ready, send it to the DQAC. It will be locked while it is reviewed.</p><p><button type="button" id="msub">Submit for DQAC review</button></p>` : ''}
    ${d.can.submit && d.stage === 'changes' ? `<div class="note bad"><b>The DQAC asked for changes.</b> Edit the paper, then answer each remark below and re-submit.</div>
      <p><a class="btn ghost" href="#/edit/${a.id}">Edit paper</a></p>
      <form id="mcomp">${d.remarks.map((r, i) => `<div class="qbox"><div class="small muted">${esc(r.from)}</div><div>${esc(r.text)}</div>
        <div class="row"><label style="flex:3 1 260px">What you changed<input name="done${i}" required></label><label style="max-width:140px">Question ref<input name="ref${i}" placeholder="2. (a)"></label></div></div>`).join('')}
        <label class="choice"><input type="checkbox" name="declared" required> I certify that all corrections suggested during moderation are in the revised paper.</label>
        <p><button>Re-submit for review</button></p></form>` : ''}
    ${d.can.assign ? `<div class="qbox"><h3>Send for review</h3>${d.dqac.length ? `<form id="massign"><div class="checks">${d.dqac.map((m) => `<label class="choice"><input type="checkbox" name="r" value="${m.user_id}"${cur.some((r) => r.reviewer_id === m.user_id) ? ' checked disabled' : ''}> ${esc(m.name)}${m.position === 'coordinator' ? ' <span class="muted small">(coordinator)</span>' : ''}</label>`).join('')}</div>
      <div class="row"><label style="max-width:220px">Review due by<input type="date" name="due"></label><p><button>Send to selected members</button></p></div></form>` : '<p class="small muted">Set the DQAC committee first (DQAC page).</p>'}</div>` : ''}
    ${d.can.approve ? `<p><button type="button" id="mapprove">Approve paper (HOD)</button> <span class="small muted">All reviewers found the paper fit.</span></p>` : ''}
    ${d.can.review ? `<form id="mrev" class="qbox"><h3>Your review (A51-B)</h3>
      <div class="scroll"><table><thead><tr><th>#</th><th>Moderation parameter</th><th>Status</th><th>Observation / deficiency</th><th>Action required</th></tr></thead><tbody>
      ${d.checklist.map((c, i) => `<tr><td>${i + 1}</td><td class="small">${esc(c)}</td><td><select name="ok${i}" required style="margin:0;min-width:80px"><option value="">–</option><option value="1">Yes</option><option value="0">No</option></select></td>
        <td><input name="obs${i}" style="margin:0"></td><td><input name="act${i}" style="margin:0"></td></tr>`).join('')}</tbody></table></div>
      <details style="margin:10px 0"><summary class="small">Question-wise comments (optional)</summary>${a.questions.map((q) => `<label class="small">${esc(qno(q))}: ${esc(q.text.slice(0, 90))}${q.text.length > 90 ? '…' : ''}<input data-c="${esc(q.label || 'Q' + q.seq)}"></label>`).join('')}</details>
      <div class="row"><label>Decision<select name="decision" required><option value="">Choose…</option><option value="ok">Fit — no resubmission</option><option value="resubmit">Resubmit with corrections</option></select></label>
        <label>Resubmission due by<input type="date" name="due"></label></div>
      <label>Remarks<textarea name="remarks" rows="2"></textarea></label><p><button>Submit review</button></p></form>` : ''}
    ${d.reviews.length ? `<h3>Reviews</h3>${tbl(['Ver.', 'Reviewer', 'Decision', 'When', 'Summary'], d.reviews.map(revRow), '')}` : ''}
    ${d.compliance.length ? `<h3>Compliance by the faculty</h3>${d.compliance.map((c) => `<div class="small"><b>v${c.version}</b> · ${fmt(c.created_at)}<ul class="tight">${c.items.map((x) => `<li>${esc(x.remark)} → <b>${esc(x.done)}</b>${x.ref ? ` (${esc(x.ref)})` : ''}</li>`).join('')}</ul></div>`).join('')}` : ''}
    ${d.views.length ? `<details><summary class="small">Who opened the paper (${d.views.length})</summary><div class="small">${d.views.map((v) => `${esc(v.user_name)} · ${fmt(v.at)}`).join('<br>')}</div></details>` : ''}`;
  const sub = el.querySelector('#msub');
  if (sub) sub.onclick = act(async () => {
    if (!(await ask('Submit this paper to the DQAC? It will be locked while it is reviewed.', { ok: 'Submit' }))) return;
    await api('POST', `/assessments/${a.id}/submit-review`, {}); toast('Submitted for review'); reload();
  });
  const comp = el.querySelector('#mcomp');
  if (comp) comp.onsubmit = act(async (e) => {
    const f = e.target;
    await api('POST', `/assessments/${a.id}/submit-review`, { declared: f.declared.checked,
      compliance: d.remarks.map((r, i) => ({ remark: `${r.from}: ${r.text}`, done: f['done' + i].value, ref: f['ref' + i].value })) });
    toast('Re-submitted for review'); reload();
  });
  const asg = el.querySelector('#massign');
  if (asg) asg.onsubmit = act(async (e) => {
    const ids = [...e.target.querySelectorAll('[name=r]:checked:not(:disabled)')].map((x) => +x.value);
    await api('POST', `/assessments/${a.id}/assign`, { reviewer_ids: ids, due_date: e.target.due.value }); toast('Sent for review'); reload();
  });
  const apr = el.querySelector('#mapprove');
  if (apr) apr.onclick = act(async () => {
    if (!(await ask('Approve this question paper? It will be locked and the faculty can publish it.', { ok: 'Approve' }))) return;
    await api('POST', `/assessments/${a.id}/hod-approve`, {}); toast('Paper approved'); reload();
  });
  const rev = el.querySelector('#mrev');
  if (rev) rev.onsubmit = act(async (e) => {
    const f = e.target;
    await api('POST', `/reviews/${d.can.review}`, {
      checklist: d.checklist.map((_, i) => ({ ok: f['ok' + i].value === '1', obs: f['obs' + i].value, action: f['act' + i].value })),
      comments: [...f.querySelectorAll('[data-c]')].map((x) => ({ label: x.dataset.c, text: x.value })),
      decision: f.decision.value, remarks: f.remarks.value, due_date: f.due.value,
    });
    toast('Review submitted'); reload();
  });
}

async function viewMyReviews() {
  const seq = nav_seq;
  const list = await api('GET', '/reviews/mine');
  if (seq !== nav_seq) return;
  app.innerHTML = `<h1>Papers for review</h1><div class="card">${tbl(['Paper', 'Faculty', 'Version', 'Due', 'Status', ''], list.map((r) => `<tr><td>${esc(r.type)} ${r.number} · ${esc(r.subject_code)}</td><td>${esc(r.faculty)}</td>
    <td>v${r.version}</td><td class="small">${esc(r.due_date || '–')}</td><td>${r.status === 'pending' ? '<span class="pill warn">To review</span>' : '<span class="pill ok">Done</span>'}</td>
    <td class="right"><a class="btn ghost" href="#/a/${r.assessment_id}">${r.status === 'pending' ? 'Review' : 'Open'}</a></td></tr>`), 'No papers have been sent to you for review.')}</div>`;
}

async function viewTracker() {
  const seq = nav_seq;
  const list = await api('GET', '/moderation/tracker');
  if (seq !== nav_seq) return;
  const tick = (v, label) => (v ? `<span class="pill ok" title="${esc(fmt(v))}">${label}</span>` : '<span class="muted">–</span>');
  app.innerHTML = `<h1>Question paper moderation tracker (A51-G)</h1>
    <div class="card">${tbl(['Paper', 'Faculty', 'Initial', 'Moderated', 'Compliance', 'Re-submitted', 'HOD', 'Status', ''], list.map((x) => `<tr>
      <td>${esc(x.type)} ${x.number} · ${esc(x.subject_code)}</td><td class="small">${esc(x.faculty)}</td>
      <td>${tick(x.submitted_at, '✓')}</td><td>${tick(x.moderated_at, '✓')}</td><td>${tick(x.compliance_at, '✓')}</td><td>${x.version > 1 ? `<span class="pill ok">v${x.version}</span>` : '<span class="muted">–</span>'}</td>
      <td>${tick(x.approved_at, '✓')}</td><td>${stagePill(x.stage)}${x.stage === 'review' && !x.reviewers ? ' <span class="pill warn">Assign reviewers</span>' : x.pending ? ` <span class="small muted">${x.pending} review(s) pending</span>` : ''}</td>
      <td class="right"><a class="btn ghost" href="#/a/${x.id}">Open</a></td></tr>`), 'No papers from the department yet.')}</div>
    <p class="small muted">Papers that need moderation: Mid Term, Sessional, Assignment and Hybrid. MCQ tests are published by the faculty directly.</p>`;
}

// Format A51 as one printable file: A submission, B moderation reports, C compliance, D re-submission, E HOD verification.
function a51Doc(a, d, head) {
  const sig = (id) => (d.signatures && d.signatures[id] ? `<img class="sig" src="${esc(d.signatures[id])}" alt="">` : '');
  const meta = `<table class="meta"><tbody><tr><th>Subject</th><td>${esc(a.subject_name)} (${esc(a.subject_code)})</td><th>Exam</th><td>${esc(a.type)} ${a.number}</td></tr>
    <tr><th>Faculty</th><td>${esc(a.faculty_name)}</td><th>Sections</th><td>${a.sections.map(esc).join(', ') || '–'}</td></tr></tbody></table>`;
  if (!d.needed) return `<section class="doc">${head}<h1>Question paper moderation</h1>${meta}<p>MCQ tests do not go through moderation.</p></section>`;
  const reviews = d.reviews.filter((r) => r.status === 'done');
  return `<section class="doc">${head}<h1>A51 – Question paper preparation, moderation and approval</h1>${meta}
    <h2>A51-A · Submission record</h2>
    ${d.versions.length ? `<table><thead><tr><th>Version</th><th>Submitted on</th><th>By</th></tr></thead><tbody>${d.versions.map((v) => `<tr><td>v${v.version}${v.version > 1 ? ' (re-submission, A51-D)' : ''}</td><td>${fmt(v.created_at)}</td><td>${esc(a.faculty_name)}</td></tr>`).join('')}</tbody></table>` : '<p>Not submitted yet.</p>'}
    <h2>A51-B · DQAC moderation reports</h2>
    ${reviews.length ? reviews.map((r) => `<div class="qblock allow"><p><b>${esc(r.reviewer)}</b> · version v${r.version} · ${fmt(r.submitted_at)}</p>
      <table><thead><tr><th>#</th><th>Moderation parameter</th><th>Status</th><th>Observation / deficiency</th><th>Action required</th></tr></thead><tbody>
      ${d.checklist.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c)}</td><td>${r.checklist[i]?.ok ? 'Yes' : 'No'}</td><td>${esc(r.checklist[i]?.obs || '')}</td><td>${esc(r.checklist[i]?.action || '')}</td></tr>`).join('')}</tbody></table>
      ${r.comments.length ? `<p class="small"><b>Question-wise comments:</b> ${r.comments.map((c) => `Q ${esc(c.label)}: ${esc(c.text)}`).join('; ')}</p>` : ''}
      <table class="meta"><tbody><tr><th>Overall status</th><td>${r.decision === 'ok' ? 'Fit' : 'Resubmit required'}</td><th>Resubmission due</th><td>${esc(r.due_date || '–')}</td></tr>
        <tr><th>Remarks</th><td colspan="3">${esc(r.remarks || '–')}</td></tr></tbody></table>
      <p class="sign">${sig(r.reviewer_id)}<br>${esc(r.reviewer)}</p></div>`).join('') : '<p>No moderation report yet.</p>'}
    <h2>A51-C · Faculty correction compliance</h2>
    ${d.compliance.length ? d.compliance.map((c) => `<p class="small">Submitted with v${c.version} on ${fmt(c.created_at)}</p><table><thead><tr><th>#</th><th>Moderation remark</th><th>Compliance done by faculty</th><th>Question ref</th></tr></thead><tbody>
      ${c.items.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.remark)}</td><td>${esc(x.done)}</td><td>${esc(x.ref || '')}</td></tr>`).join('')}</tbody></table>
      <p class="small">Faculty declaration: all corrections suggested during moderation have been incorporated in the revised question paper.</p>`).join('') : '<p>No corrections were asked for.</p>'}
    <h2>A51-E · HOD verification</h2>
    ${d.approved_at ? `<p>Verified and approved by <b>${esc(d.approved_by)}</b> on ${fmt(d.approved_at)}.</p><p class="sign">${sig(a.approved_by_id)}<br>${esc(d.approved_by)}, HOD</p>` : '<p>Awaiting HOD approval.</p>'}
  </section>`;
}

// ---------- reports: A53 rank sheet, toppers, institute overview ----------

async function viewReports() {
  const seq = nav_seq;
  const inst = user.perms.reports === 'institute' || user.perms.manage;
  const [sections, overview, settings] = await Promise.all([api('GET', '/reports/sections'), inst ? api('GET', '/reports/overview') : Promise.resolve(null), api('GET', '/settings')]);
  if (seq !== nav_seq) return;
  app.innerHTML = `<h1>Reports</h1>
    ${overview ? `<div class="card"><h2>Institute overview</h2>${tbl(['Department', 'Faculty', 'Papers', 'In moderation', 'Published', 'Results awaiting approval', 'Results declared'],
      overview.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.faculty}</td><td>${x.papers}</td><td>${x.in_moderation}</td><td>${x.published}</td><td>${x.awaiting_approval ? `<span class="pill warn">${x.awaiting_approval}</span>` : 0}</td><td>${x.results}</td></tr>`), 'No departments yet.')}</div>` : ''}
    <div class="card no-print"><h2>Rank sheet (A53)</h2>
      <form id="frs" class="row"><label>Section<select name="section" required>${sections.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
        <label>Test<select name="type"><option>Sessional</option><option>Mid Term</option><option>Assignment</option><option>MCQ Test</option><option>Hybrid</option></select></label>
        <label style="max-width:150px">Number<select name="number"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="0">All together</option></select></label>
        <label>Rank within<select name="scope"><option value="section"${settings.settings.rank_scope !== 'branch' ? ' selected' : ''}>Section</option><option value="branch"${settings.settings.rank_scope === 'branch' ? ' selected' : ''}>Branch (all sections)</option></select></label>
        <p><button>Show</button></p></form></div>
    <div id="rs"></div>`;
  const out = document.getElementById('rs');
  let last = null;
  document.getElementById('frs').onsubmit = act(async (e) => {
    const q = new URLSearchParams(Object.fromEntries(new FormData(e.target)));
    const d = await api('GET', `/reports/rank-sheet?${q}`);
    last = d;
    const testName = `${d.type}${d.number ? ` ${d.number}` : ' (all)'}`;
    const top = d.students.filter((x) => x.rank && x.rank <= 3).sort((p, r) => p.rank - r.rank);
    out.innerHTML = `<div class="card"><div class="between no-print"><span class="small muted">${d.students.length} students · ${d.subjects.length} subjects</span>
        <span><button type="button" class="ghost small" id="rsx">Download Excel</button> <button type="button" class="ghost small" onclick="window.print()">Print / Save as PDF</button></span></div>
      <div class="paper"><section class="doc">${letterhead(settings)}
      <h1 style="text-align:center">${esc(testName)} marks and rank sheet</h1>
      <p style="text-align:center">${esc(d.session || '')} · ${esc(d.programme || '')}${d.semester ? ` · Semester ${d.semester}` : ''} · ${d.scope === 'branch' ? 'All sections (branch rank)' : `Section: ${esc(d.section)}`}</p>
      ${top.length ? `<p><b>Toppers:</b> ${top.map((x) => `${x.rank}. ${esc(x.name)} (${num(x.total)})`).join(' · ')}</p>` : ''}
      <div class="scroll"><table class="rank"><thead><tr><th>Sl.</th><th>Roll no</th><th>Name</th>${d.scope === 'branch' ? '<th>Section</th>' : ''}${d.subjects.map((sj) => `<th title="${esc(sj.name)}">${esc(sj.code)}<br><span class="small muted">${esc(sj.faculty)}</span><br>/${num(sj.max)}</th>`).join('')}
        <th>Total<br>/${num(d.max_total)}</th><th>%</th><th>Pass / Fail</th><th>Rank</th></tr></thead><tbody>
        ${d.students.map((x, i) => `<tr><td>${i + 1}</td><td class="nowrap">${esc(x.univ_roll || x.college_roll || '')}</td><td>${esc(x.name)}</td>${d.scope === 'branch' ? `<td class="small">${esc(x.section)}</td>` : ''}
          ${d.subjects.map((sj) => `<td>${x.marks[sj.code] === undefined ? '<span class="muted">AB</span>' : num(x.marks[sj.code])}</td>`).join('')}
          <td><b>${x.absent ? '–' : num(x.total)}</b></td><td>${x.absent ? '–' : num(x.pct)}</td><td>${x.absent ? 'Absent' : x.pass ? 'Pass' : '<span class="bad-text">Fail</span>'}</td><td>${x.rank ?? '–'}</td></tr>`).join('')}
      </tbody></table></div><p class="small">Pass mark: ${d.pass_percent}% in every subject. Equal totals share a rank.</p>
      <div class="signs"><b>Class coordinator</b><b>HOD</b></div></section></div></div>`;
    document.getElementById('rsx').onclick = act(async () => {
      await loadXLSX();
      const rows = [['Sl.', 'Roll no', 'Name', ...(d.scope === 'branch' ? ['Section'] : []), ...d.subjects.map((sj) => `${sj.code} (${sj.max})`), `Total (${d.max_total})`, '%', 'Pass/Fail', 'Rank'],
        ...d.students.map((x, i) => [i + 1, x.univ_roll || x.college_roll || '', x.name, ...(d.scope === 'branch' ? [x.section] : []), ...d.subjects.map((sj) => x.marks[sj.code] ?? 'AB'),
          x.absent ? '' : x.total, x.absent ? '' : x.pct, x.absent ? 'Absent' : x.pass ? 'Pass' : 'Fail', x.rank ?? ''])];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rank sheet');
      XLSX.writeFile(wb, `Rank_sheet_${testName.replace(/\W+/g, '_')}_${d.section.replace(/\W+/g, '_')}.xlsx`);
    });
  });
  if (sections.length) document.getElementById('frs').requestSubmit();
}
