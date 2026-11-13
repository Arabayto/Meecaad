-- Fuel station, the way it is run:
--   1. Open a shift with the fuel it works with, e.g. 2,000 L worth $2,000.
--   2. Record every sale (amount, and Cash / Zaad / Edahab or a customer debt).
--   3. Xisaab xidh: the sales by Cash / Zaad / Edahab / debts are added up;
--      when they match the opening value the shift is done; the next shift opens.
-- No pumps or fuel types are needed: price per litre = opening value / litres.
-- (The older meter-reading tables stay untouched with their history.)

CREATE TABLE fuel_sessions (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL DEFAULT 'fuel' REFERENCES businesses(id),
  number          INTEGER NOT NULL,                       -- shift #1, #2, …
  entry_date      TEXT NOT NULL,                          -- business day it was opened
  opening_liters  REAL NOT NULL CHECK (opening_liters > 0),
  opening_value   INTEGER NOT NULL CHECK (opening_value > 0),   -- cents
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by       TEXT NOT NULL REFERENCES users(id),
  opened_at       TEXT NOT NULL,
  closed_by       TEXT REFERENCES users(id),
  closed_at       TEXT,
  sold_total      INTEGER,                                -- at closing
  remaining       INTEGER,                                -- opening value − sold, at closing
  explanation     TEXT,                                   -- required when it does not match
  CHECK (status = 'open' OR closed_at IS NOT NULL),
  CHECK (status = 'open' OR remaining = 0 OR explanation IS NOT NULL)
);
-- Only one shift is open at a time.
CREATE UNIQUE INDEX uq_fuel_session_open ON fuel_sessions(business_id) WHERE status = 'open';
CREATE UNIQUE INDEX uq_fuel_session_number ON fuel_sessions(business_id, number);
CREATE INDEX idx_fuel_sessions_date ON fuel_sessions(business_id, entry_date);

CREATE TABLE fuel_sales (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES fuel_sessions(id),
  business_id  TEXT NOT NULL DEFAULT 'fuel' REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),       -- cents (USD)
  liters       REAL NOT NULL,
  method_id    TEXT REFERENCES payment_methods(id),       -- paid: cash / zaad / edahab
  customer_id  TEXT REFERENCES customers(id),             -- or a customer debt
  slsh_amount  INTEGER,                                   -- cash taken in Shillings (as entered)
  rate         REAL,                                      -- SLSH per $1 used for it
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
CREATE INDEX idx_fuel_sales_session ON fuel_sales(session_id, created_at);
CREATE INDEX idx_fuel_sales_date ON fuel_sales(business_id, entry_date);
