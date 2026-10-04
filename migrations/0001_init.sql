-- You Know? quiz storage. Live game state lives entirely inside per-session
-- Durable Objects; D1 stores the editable quiz definitions plus one row per
-- created session so editing can be locked while a quiz is being played.

CREATE TABLE IF NOT EXISTS quizzes (
  id         TEXT PRIMARY KEY,
  edit_token TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  data       TEXT NOT NULL,          -- JSON: { questions: Question[] }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quizzes_edit_token ON quizzes(edit_token);

CREATE TABLE IF NOT EXISTS sessions (
  code       TEXT PRIMARY KEY,
  quiz_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_quiz ON sessions(quiz_id);
