// Tables are created automatically (CREATE TABLE IF NOT EXISTS) so no CLI migration is needed.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('faculty','student')),
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    roll_no TEXT,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    faculty_id INTEGER NOT NULL,
    subject_name TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('Assignment','Sessional','Tutorial','MCQ Test')),
    number INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    release_mode TEXT NOT NULL CHECK (release_mode IN ('after_approval','instant')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    created_at TEXT NOT NULL
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
    correct_index INTEGER
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
];

// Upgrades for databases created by an earlier version (run once per Worker start, safe to repeat).
export async function migrate(db) {
  const sqlOf = async (t) => (await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(t).first())?.sql || '';

  if (!(await sqlOf('questions')).includes('correct_index')) {
    await db.batch([
      db.prepare("ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'descriptive'"),
      db.prepare('ALTER TABLE questions ADD COLUMN options_json TEXT'),
      db.prepare('ALTER TABLE questions ADD COLUMN correct_index INTEGER'),
    ]);
  }

  // The allowed assessment types live in a CHECK constraint, which SQLite can only change by rebuilding the table.
  if (!(await sqlOf('assessments')).includes('MCQ Test')) {
    const create = SCHEMA.find((x) => x.includes('CREATE TABLE IF NOT EXISTS assessments'));
    await db.batch([
      db.prepare(create.replace('IF NOT EXISTS assessments', 'assessments_new')),
      db.prepare('INSERT INTO assessments_new SELECT * FROM assessments'),
      db.prepare('DROP TABLE assessments'),
      db.prepare('ALTER TABLE assessments_new RENAME TO assessments'),
    ]);
  }
}
