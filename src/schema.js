// Database tables. Every institute's data carries its institute_id and is only ever read through it.
// Tables are created automatically (CREATE TABLE IF NOT EXISTS), so no CLI migration is needed.

export const ROLE_DEFAULTS = {
  admin: { manage: true, create: false, approve: false, reports: 'institute' },
  nodal: { manage: false, create: false, approve: false, reports: 'institute' },
  hod: { manage: false, create: true, approve: true, reports: 'department' },
  faculty: { manage: false, create: true, approve: true, reports: 'own' },
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS institutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    line TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    letterhead TEXT NOT NULL DEFAULT '',
    format_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at TEXT NOT NULL
  )`,
  // institute_id is NULL only for the platform owner.
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','nodal','hod','faculty','student')),
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    roll_no TEXT,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    section_id INTEGER,
    department_id INTEGER,
    perms TEXT,
    must_change INTEGER NOT NULL DEFAULT 0,
    UNIQUE (institute_id, username)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_failures (
    key TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (institute_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    department_id INTEGER,
    programme TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    UNIQUE (institute_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    semester INTEGER,
    UNIQUE (institute_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    department_id INTEGER,
    faculty_id INTEGER NOT NULL,
    subject_name TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    type TEXT NOT NULL,
    number INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    release_mode TEXT NOT NULL CHECK (release_mode IN ('after_approval','instant')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    created_at TEXT NOT NULL,
    shuffle INTEGER NOT NULL DEFAULT 0,
    negative REAL NOT NULL DEFAULT 0,
    option_shuffle INTEGER NOT NULL DEFAULT 0,
    paper_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS assessment_sections (
    assessment_id INTEGER NOT NULL,
    section_id INTEGER NOT NULL,
    PRIMARY KEY (assessment_id, section_id)
  )`,
  `CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    max_marks REAL NOT NULL,
    co TEXT,
    model_answer TEXT NOT NULL,
    rubric_json TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'descriptive',
    options_json TEXT,
    correct_index INTEGER,
    part TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    rbtl INTEGER,
    qgroup INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    submitted_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress'
      CHECK (status IN ('in_progress','submitted','evaluated','published')),
    tab_switches INTEGER NOT NULL DEFAULT 0,
    paste_attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (assessment_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    eval_status TEXT NOT NULL DEFAULT 'pending' CHECK (eval_status IN ('pending','done','failed')),
    eval_error TEXT,
    llm_marks REAL,
    llm_json TEXT,
    llm_confidence TEXT,
    final_marks REAL,
    faculty_remark TEXT,
    UNIQUE (attempt_id, question_id)
  )`,
  `CREATE TABLE IF NOT EXISTS access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    sender TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // Who did what: approvals, mark changes, account and password changes.
  `CREATE TABLE IF NOT EXISTS programmes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    department_id INTEGER,
    name TEXT NOT NULL,
    UNIQUE (institute_id, name)
  )`,
  // Who teaches which subject in which section (one faculty per subject and section).
  `CREATE TABLE IF NOT EXISTS allotments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    section_id INTEGER NOT NULL,
    faculty_id INTEGER NOT NULL,
    UNIQUE (subject_id, section_id)
  )`,
  // Departmental quality assurance committee, chosen by the HOD.
  `CREATE TABLE IF NOT EXISTS dqac (
    institute_id INTEGER NOT NULL,
    department_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    position TEXT NOT NULL DEFAULT 'member',
    UNIQUE (department_id, user_id)
  )`,
  // Split electives: which student takes which elective subject.
  `CREATE TABLE IF NOT EXISTS elective_choices (
    institute_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    UNIQUE (student_id, subject_id)
  )`,
  // "Forgot password" requests from students, answered by the class coordinator (or registrar / admin).
  `CREATE TABLE IF NOT EXISTS reset_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    done_by TEXT,
    done_at TEXT
  )`,
  // Question paper moderation (format A51): versions, DQAC reviews, the faculty's compliance, and who opened the paper.
  `CREATE TABLE IF NOT EXISTS paper_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    assessment_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assessment_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    assessment_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    checklist_json TEXT,
    comments_json TEXT,
    decision TEXT,
    remarks TEXT,
    due_date TEXT,
    assigned_at TEXT NOT NULL,
    submitted_at TEXT,
    UNIQUE (assessment_id, version, reviewer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS compliance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER NOT NULL,
    assessment_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS paper_views (
    assessment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    institute_id INTEGER,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  )`,
];

// A database from the single-institute version: move its data into institute no. 1 (code INST1).
async function upgradeFromSingleInstitute(db) {
  const create = (name) => SCHEMA.find((x) => x.includes(`CREATE TABLE IF NOT EXISTS ${name} (`));
  const perms = (role) => JSON.stringify(ROLE_DEFAULTS[role]).replace(/'/g, "''");
  const acols = 'id, faculty_id, subject_name, subject_code, type, number, duration_min, start_at, end_at, release_mode, status, created_at, shuffle';
  const ucols = 'id, role, name, username, roll_no, pw_hash, pw_salt, created_at, section_id';
  const sql = [
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'ALTER TABLE users RENAME TO old_users',
    'ALTER TABLE sections RENAME TO old_sections',
    'ALTER TABLE subjects RENAME TO old_subjects',
    'ALTER TABLE assessments RENAME TO old_assessments',
    create('institutes'), create('users'), create('sections'), create('subjects'), create('assessments'),
    `INSERT INTO institutes (id, code, name, line, logo, created_at) VALUES (1, 'INST1',
       COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'institute'), ''), 'First institute'),
       COALESCE((SELECT value FROM settings WHERE key = 'line'), ''),
       COALESCE((SELECT value FROM settings WHERE key = 'logo'), ''), '${new Date().toISOString()}')`,
    `INSERT INTO users (${ucols}, institute_id, perms)
       SELECT ${ucols}, 1, CASE role WHEN 'admin' THEN '${perms('admin')}' WHEN 'faculty' THEN '${perms('faculty')}' END FROM old_users`,
    'INSERT INTO sections (id, institute_id, name) SELECT id, 1, name FROM old_sections',
    'INSERT INTO subjects (id, institute_id, name, code, semester) SELECT id, 1, name, code, semester FROM old_subjects',
    `INSERT INTO assessments (${acols}, institute_id) SELECT ${acols}, 1 FROM old_assessments`,
    'DROP TABLE old_users', 'DROP TABLE old_sections', 'DROP TABLE old_subjects', 'DROP TABLE old_assessments', 'DROP TABLE settings',
  ];
  await db.batch(sql.map((x) => db.prepare(x)));
}

export async function prepareDatabase(db) {
  const has = async (t) => !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(t).first());
  if (!(await has('institutes')) && (await has('users'))) await upgradeFromSingleInstitute(db);
  await db.batch(SCHEMA.map((x) => db.prepare(x)));
  // Columns added after the first multi-institute release.
  const cols = async (t) => new Set((await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name));
  const a = await cols('assessments');
  const q = await cols('questions');
  const add = [];
  if (!a.has('negative')) add.push('ALTER TABLE assessments ADD COLUMN negative REAL NOT NULL DEFAULT 0');
  if (!a.has('option_shuffle')) add.push('ALTER TABLE assessments ADD COLUMN option_shuffle INTEGER NOT NULL DEFAULT 0');
  if (!q.has('part')) add.push("ALTER TABLE questions ADD COLUMN part TEXT NOT NULL DEFAULT ''");
  if (!q.has('label')) add.push("ALTER TABLE questions ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  if (!q.has('rbtl')) add.push('ALTER TABLE questions ADD COLUMN rbtl INTEGER');
  if (!a.has('paper_json')) add.push("ALTER TABLE assessments ADD COLUMN paper_json TEXT NOT NULL DEFAULT '{}'");
  const ic = await cols('institutes');
  if (!ic.has('letterhead')) add.push("ALTER TABLE institutes ADD COLUMN letterhead TEXT NOT NULL DEFAULT ''");
  if (!ic.has('format_json')) add.push("ALTER TABLE institutes ADD COLUMN format_json TEXT NOT NULL DEFAULT '{}'");
  if (!q.has('qgroup')) add.push('ALTER TABLE questions ADD COLUMN qgroup INTEGER');
  // Institute setup: academic structure, people and settings.
  const want = {
    institutes: { settings_json: "TEXT NOT NULL DEFAULT '{}'" },
    users: { emp_id: 'TEXT', designation: 'TEXT', post: 'TEXT', univ_roll: 'TEXT', college_roll: 'TEXT', email: 'TEXT', mobile: 'TEXT',
      programme_id: 'INTEGER', semester: 'INTEGER', status: "TEXT NOT NULL DEFAULT 'active'", signature: 'TEXT' },
    sections: { programme_id: 'INTEGER', semester: 'INTEGER', coordinator_id: 'INTEGER' },
    assessments: { subject_id: 'INTEGER', stage: "TEXT NOT NULL DEFAULT 'draft'", approved_by: 'TEXT', approved_at: 'TEXT', approved_by_id: 'INTEGER' },
    subjects: { department_id: 'INTEGER', programme_id: 'INTEGER', type: "TEXT NOT NULL DEFAULT 'Theory'", elective_group: 'TEXT', credits: 'REAL',
      cos_json: "TEXT NOT NULL DEFAULT '[]'" },
  };
  for (const [table, columns] of Object.entries(want)) {
    const have = table === 'institutes' ? ic : await cols(table);
    for (const [c, type] of Object.entries(columns)) if (!have.has(c)) add.push(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
  }
  if (add.length) await db.batch(add.map((x) => db.prepare(x)));
}
