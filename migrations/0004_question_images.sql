-- v0.3: question images. Binary lives in R2 (Cloudflare) / on disk (self-host)
-- under the key images/<id>; this row carries the metadata and quiz ownership.

CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  quiz_id    TEXT NOT NULL,
  mime       TEXT NOT NULL,           -- image/webp | image/jpeg | image/png
  bytes      INTEGER NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_quiz ON images(quiz_id);
