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
    <form id="fdq">${tbl(['Member', 'Name', 'Designation', 'Position'], d.faculty.map((x) => `<tr><td><input type="checkbox" name="m" value="${x.id}"${pos.has(x.id) ? ' checked' : ''} style="width:auto" aria-label="${esc(x.name)}"></td>
      <td>${esc(x.name)}</td><td class="small">${esc(x.designation || '–')}</td>
      <td><select data-pos="${x.id}" style="margin:0"><option value="member">Member</option><option value="coordinator"${pos.get(x.id) === 'coordinator' ? ' selected' : ''}>DQAC coordinator</option></select></td></tr>`), 'No faculty in your department yet.')}
    <p><button>Save committee</button> <span class="small muted">You, as HOD, head the committee.</span></p></form></div>`;
  document.getElementById('fdq').onsubmit = act(async (e) => {
    const members = [...e.target.querySelectorAll('[name=m]:checked')].map((c) => ({ user_id: +c.value, position: e.target.querySelector(`[data-pos="${c.value}"]`).value }));
    await api('PUT', '/dqac', { members });
    toast('Committee saved');
  });
}
