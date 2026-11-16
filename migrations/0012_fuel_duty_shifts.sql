-- Fuel station, as it is really run:
--   * No opening fuel or money. A shift is a salesman's working period.
--   * Every salesman opens and closes their own shift (several can be open at once).
--   * Shifts have set times (Morning / Evening / Night) read in Hargeisa time (UTC+3).
--   * A sale is money collected: Cash / Zaad / Edahab, or a customer debt.
-- New tables are used so nothing older is rebuilt or lost; the earlier
-- "opening value" shifts and their sales are copied in with the same ids.

CREATE TABLE duty_shifts (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL DEFAULT 'fuel' REFERENCES businesses(id),
  number       INTEGER NOT NULL,                            -- shift #1, #2, …
  entry_date   TEXT NOT NULL,                               -- Hargeisa day it was opened
  shift_name   TEXT NOT NULL,                               -- Morning / Evening / Night …
  user_id      TEXT NOT NULL REFERENCES users(id),          -- the salesman
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  closed_by    TEXT REFERENCES users(id),                   -- the salesman, or the manager/owner who closed it
  note         TEXT,
  CHECK (status = 'open' OR closed_at IS NOT NULL)
);
-- One open shift per salesman at a time.
CREATE UNIQUE INDEX uq_duty_open ON duty_shifts(business_id, user_id) WHERE status = 'open';
CREATE UNIQUE INDEX uq_duty_number ON duty_shifts(business_id, number);
CREATE INDEX idx_duty_shifts_date ON duty_shifts(business_id, entry_date);
CREATE INDEX idx_duty_shifts_user ON duty_shifts(business_id, user_id, entry_date);

CREATE TABLE duty_sales (
  id           TEXT PRIMARY KEY,
  shift_id     TEXT NOT NULL REFERENCES duty_shifts(id),
  business_id  TEXT NOT NULL DEFAULT 'fuel' REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),         -- cents (USD)
  method_id    TEXT REFERENCES payment_methods(id),         -- cash / zaad / edahab
  customer_id  TEXT REFERENCES customers(id),               -- or a customer debt
  slsh_amount  INTEGER,                                     -- cash taken in Shillings (as entered)
  rate         REAL,                                        -- SLSH per $1 used for it
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  void_reason  TEXT,
  voided_by    TEXT REFERENCES users(id),
  voided_at    TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  CHECK ((method_id IS NULL) <> (customer_id IS NULL)),
  CHECK (status = 'completed' OR void_reason IS NOT NULL)
);
CREATE INDEX idx_duty_sales_shift ON duty_sales(shift_id, created_at);
CREATE INDEX idx_duty_sales_date ON duty_sales(business_id, entry_date);

-- Earlier test shifts and sales (same ids, so their accounting entries still match).
INSERT INTO duty_shifts (id, business_id, number, entry_date, shift_name, user_id, status, opened_at, closed_at, closed_by, note)
SELECT id, business_id, number, entry_date,
  CASE WHEN CAST(strftime('%H', opened_at, '+3 hours') AS INTEGER) BETWEEN 6 AND 13 THEN 'Morning'
       WHEN CAST(strftime('%H', opened_at, '+3 hours') AS INTEGER) BETWEEN 14 AND 21 THEN 'Evening' ELSE 'Night' END,
  opened_by, status, opened_at, closed_at, closed_by, note
FROM fuel_sessions;

INSERT INTO duty_sales (id, shift_id, business_id, entry_date, amount, method_id, customer_id, slsh_amount, rate, note, status, void_reason, voided_by, voided_at, created_by, created_at)
SELECT id, session_id, business_id, entry_date, amount, method_id, customer_id, slsh_amount, rate, note, status, void_reason, voided_by, voided_at, created_by, created_at
FROM fuel_sales;
