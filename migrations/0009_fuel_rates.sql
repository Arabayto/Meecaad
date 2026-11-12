-- Fuel station: daily USD → Somaliland Shilling rate, and payments that arrive
-- after a day's sales were recorded (so a day can be "outstanding", then settled).

-- One row each time the rate is set; the rate for a day is the latest one on or before it.
-- Rows are never changed or deleted, so the history of rates stays.
CREATE TABLE exchange_rates (
  id         TEXT PRIMARY KEY,
  rate_date  TEXT NOT NULL,                                -- the day it applies from
  rate       REAL NOT NULL CHECK (rate > 0),               -- SLSH for 1 USD
  set_by     TEXT NOT NULL REFERENCES users(id),
  set_at     TEXT NOT NULL
);
CREATE INDEX idx_exchange_rates_date ON exchange_rates(rate_date, set_at);

-- NULL = received when the sales were recorded; a time = received later.
ALTER TABLE fuel_shift_payments ADD COLUMN settled_at TEXT;
