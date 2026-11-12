-- Security hardening and user management.
--
-- * Sessions end after 12 hours without use (and after 7 days at most);
--   each session records when it was last used, from where and on what device.
-- * Every sign-in attempt is recorded, so attacks from one address can be
--   slowed down even when they try many usernames.
-- * Users show when they last signed in and when their password changed.

ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
UPDATE sessions SET last_seen_at = created_at;

ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

CREATE TABLE login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip          TEXT NOT NULL,
  username    TEXT NOT NULL,
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, created_at);
CREATE INDEX idx_login_attempts_created ON login_attempts(created_at);
