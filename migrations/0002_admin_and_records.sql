-- v0.2: admin password + full game records (SQLite).
-- Live game state still lives in the per-session Durable Object; the rows
-- here are the durable record written by the DO as the game unfolds.

-- Key/value store for app settings (admin password hash + session token).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN title    TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN status   TEXT NOT NULL DEFAULT 'live';
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;

-- One row per player who joined a session, with where they came from.
CREATE TABLE IF NOT EXISTS players (
  session_code TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  score        INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (session_code, player_id)
);

-- One row per (player, question) once the question is revealed.
CREATE TABLE IF NOT EXISTS answers (
  session_code TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  q_index      INTEGER NOT NULL,
  answer       TEXT NOT NULL,          -- JSON Answer
  correct      INTEGER,                -- 1 / 0 / NULL (unscored poll)
  gained       INTEGER NOT NULL DEFAULT 0,
  answered_at  INTEGER NOT NULL,
  PRIMARY KEY (session_code, player_id, q_index)
);

CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_code);
CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_code);
