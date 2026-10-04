-- v0.2.1: remember each session's host token so any signed-in admin can open
-- any host screen (previously it lived only in the hosting browser).
ALTER TABLE sessions ADD COLUMN host_token TEXT NOT NULL DEFAULT '';
