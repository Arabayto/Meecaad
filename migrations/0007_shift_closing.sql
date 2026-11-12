-- Shift closing (xisaab xidh) and month/year locks.
--
-- A shift = everything one person did with money in a business since their
-- last shift closing. At closing they count each payment method; the system
-- shows what is expected; any difference must be explained and is booked as
-- a cash difference (visible to the owner, per cashier). The money is handed
-- to a named owner/manager. Days, months and years are summaries of shifts;
-- the owner can lock a finished month or year so it can no longer change.

-- Finds one person's unclosed activity quickly.
CREATE INDEX idx_journal_user_created ON journal_entries(business_id, created_by, created_at);

-- Activity recorded before shift closing existed does not belong to anyone's first shift.
CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('shifts_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE shift_closings (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  user_id           TEXT NOT NULL REFERENCES users(id),        -- whose shift
  from_ts           TEXT NOT NULL,                             -- after this moment (previous closing)
  to_ts             TEXT NOT NULL,                             -- up to this moment (this closing)
  first_date        TEXT,                                      -- business day of the first activity
  sales_count       INTEGER NOT NULL DEFAULT 0,
  sales_total       INTEGER NOT NULL DEFAULT 0,
  credit_total      INTEGER NOT NULL DEFAULT 0,
  expenses_total    INTEGER NOT NULL DEFAULT 0,
  start_float       INTEGER NOT NULL DEFAULT 0 CHECK (start_float >= 0),   -- change money that was in the drawer
  total_expected    INTEGER NOT NULL,
  total_counted     INTEGER NOT NULL,
  total_difference  INTEGER NOT NULL,
  explanation       TEXT,
  handed_to         TEXT NOT NULL REFERENCES users(id),        -- who received the money
  unpaid_orders     INTEGER NOT NULL DEFAULT 0,                -- handed over to the next shift
  unpaid_total      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'reopened')),
  closed_by         TEXT NOT NULL REFERENCES users(id),
  closed_at         TEXT NOT NULL,
  reopened_by       TEXT REFERENCES users(id),
  reopened_at       TEXT,
  reopen_reason     TEXT,
  CHECK (total_difference = 0 OR explanation IS NOT NULL)
);
-- The same stretch of work can only be closed once.
CREATE UNIQUE INDEX uq_shift_from ON shift_closings(business_id, user_id, from_ts) WHERE status = 'closed';
CREATE INDEX idx_shift_closings_closed ON shift_closings(business_id, closed_at);
CREATE INDEX idx_shift_closings_user ON shift_closings(business_id, user_id, to_ts);

CREATE TABLE shift_closing_lines (
  id           TEXT PRIMARY KEY,
  closing_id   TEXT NOT NULL REFERENCES shift_closings(id),
  method_id    TEXT NOT NULL REFERENCES payment_methods(id),
  sales_in     INTEGER NOT NULL,
  collections  INTEGER NOT NULL,
  expenses_out INTEGER NOT NULL,
  other        INTEGER NOT NULL,
  expected     INTEGER NOT NULL,
  counted      INTEGER NOT NULL,
  difference   INTEGER NOT NULL
);
CREATE INDEX idx_shift_closing_lines ON shift_closing_lines(closing_id);

-- A finished month or year locked by the owner: nothing dated in it can be added or changed.
CREATE TABLE period_locks (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  period         TEXT NOT NULL,                               -- '2026-10' (month) or '2026' (year)
  kind           TEXT NOT NULL CHECK (kind IN ('month', 'year')),
  locked_until   TEXT NOT NULL,                               -- last day of the period
  status         TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'unlocked')),
  locked_by      TEXT NOT NULL REFERENCES users(id),
  locked_at      TEXT NOT NULL,
  unlocked_by    TEXT REFERENCES users(id),
  unlocked_at    TEXT,
  unlock_reason  TEXT,
  CHECK (status = 'locked' OR unlock_reason IS NOT NULL)
);
CREATE UNIQUE INDEX uq_period_lock ON period_locks(business_id, period) WHERE status = 'locked';
