-- Meecaad Integrated Business Management System — initial schema (Cloudflare D1 / SQLite)
--
-- Conventions
--   * Money is stored as INTEGER cents (USD). Never REAL.
--   * Quantities (pieces, kg, litres) are REAL, rounded to 3 decimals in code.
--   * entry_date is the business day ('YYYY-MM-DD', East Africa Time).
--   * created_at / *_at timestamps are UTC ISO-8601 strings.
--   * Financial rows are never deleted: they are voided and reversed in the
--     journal, and every change is written to audit_log.
--   * journal_lines is the single source of truth for every money figure the
--     owner sees (sales, costs, expenses, cash, debts). Each journal entry is
--     balanced: SUM(amount) = 0, with amount > 0 a debit and amount < 0 a credit.


CREATE TABLE businesses (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('restaurant', 'fuel', 'store')),
  sort   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO businesses (id, name, kind, sort) VALUES
  ('restaurant', 'Meecaad Restaurant & Cafe', 'restaurant', 1),
  ('fuel',       'Meecaad Fuel Station',      'fuel',       2),
  ('store',      'Meecaad Store',             'store',      3);

-- ── People & access ─────────────────────────────────────────────
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name      TEXT NOT NULL,
  phone          TEXT,
  role           TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'restaurant_staff', 'fuel_staff', 'store_staff')),
  password_hash  TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id)
);

CREATE TABLE user_businesses (
  user_id      TEXT NOT NULL REFERENCES users(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  PRIMARY KEY (user_id, business_id)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- SHA-256 of the cookie token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Repeated clicks / retried requests carry the same key and get the first result back.
CREATE TABLE idempotency_keys (
  key         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  response    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── Settings ────────────────────────────────────────────────────
CREATE TABLE payment_methods (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  active  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO payment_methods (id, name, sort) VALUES ('cash', 'Cash', 1), ('zaad', 'Zaad', 2), ('edahab', 'Edahab', 3);

-- ── Customers & suppliers (shared; balances are kept per business in the journal) ──
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id)
);
CREATE INDEX idx_customers_name ON customers(name);

CREATE TABLE suppliers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id)
);
CREATE INDEX idx_suppliers_name ON suppliers(name);

-- ── Products & stock ────────────────────────────────────────────
-- kind: item (store product), menu (restaurant food/drink for sale),
--       ingredient (restaurant stock, not sold directly), fuel (litres in tanks)
CREATE TABLE products (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL CHECK (kind IN ('item', 'menu', 'ingredient', 'fuel')),
  unit           TEXT NOT NULL DEFAULT 'pcs',
  sku            TEXT,
  sale_price     INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  avg_cost       REAL NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),   -- cents per unit
  track_stock    INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0, 1)),
  stock_qty      REAL NOT NULL DEFAULT 0,
  reorder_level  REAL NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  UNIQUE (business_id, name),
  -- Shop and kitchen stock can never go below zero (a sale of missing stock is
  -- rejected and the whole request rolls back). Fuel book stock may, which is
  -- itself reported as an alert.
  CHECK (stock_qty > -0.0005 OR kind = 'fuel')
);
CREATE INDEX idx_products_business ON products(business_id, active);

CREATE TABLE price_changes (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  old_price   INTEGER NOT NULL,
  new_price   INTEGER NOT NULL,
  reason      TEXT,
  changed_by  TEXT NOT NULL REFERENCES users(id),
  changed_at  TEXT NOT NULL
);
CREATE INDEX idx_price_changes_product ON price_changes(product_id, changed_at);

CREATE TABLE fuel_tanks (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  name         TEXT NOT NULL,
  capacity     REAL NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  stock_qty    REAL NOT NULL DEFAULT 0,          -- book litres
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL,
  UNIQUE (business_id, name)
);

CREATE TABLE fuel_pumps (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  tank_id      TEXT NOT NULL REFERENCES fuel_tanks(id),
  name         TEXT NOT NULL,
  last_meter   REAL NOT NULL DEFAULT 0 CHECK (last_meter >= 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL,
  UNIQUE (business_id, name)
);

-- Every stock change, with its cost. qty is signed (+ in, − out).
CREATE TABLE stock_movements (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  tank_id      TEXT REFERENCES fuel_tanks(id),
  entry_date   TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('opening', 'purchase', 'purchase_void', 'sale', 'sale_void', 'sale_return',
                                             'usage', 'waste', 'adjustment', 'fuel_sale', 'fuel_sale_void', 'tank_dip')),
  qty          REAL NOT NULL,
  unit_cost    REAL NOT NULL DEFAULT 0,
  value        INTEGER NOT NULL DEFAULT 0,       -- signed cents
  ref_type     TEXT,
  ref_id       TEXT,
  reason       TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_stock_mv_product ON stock_movements(product_id, entry_date);
CREATE INDEX idx_stock_mv_tank ON stock_movements(tank_id, entry_date);
CREATE INDEX idx_stock_mv_business ON stock_movements(business_id, entry_date);

-- ── Sales (restaurant & store) ──────────────────────────────────
CREATE TABLE sales (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  number         INTEGER NOT NULL,
  entry_date     TEXT NOT NULL,
  customer_id    TEXT REFERENCES customers(id),
  subtotal       INTEGER NOT NULL CHECK (subtotal >= 0),
  discount       INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total          INTEGER NOT NULL CHECK (total >= 0),
  paid_amount    INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  credit_amount  INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  cost_total     INTEGER NOT NULL DEFAULT 0,
  returned_amount INTEGER NOT NULL DEFAULT 0 CHECK (returned_amount >= 0),
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  note           TEXT,
  void_reason    TEXT,
  voided_by      TEXT REFERENCES users(id),
  voided_at      TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  UNIQUE (business_id, number),
  CHECK (paid_amount + credit_amount = total),
  CHECK (credit_amount = 0 OR customer_id IS NOT NULL)
);
CREATE INDEX idx_sales_business_date ON sales(business_id, entry_date);
CREATE INDEX idx_sales_customer ON sales(customer_id);

CREATE TABLE sale_items (
  id            TEXT PRIMARY KEY,
  sale_id       TEXT NOT NULL REFERENCES sales(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  name          TEXT NOT NULL,
  qty           REAL NOT NULL CHECK (qty > 0),
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  unit_cost     REAL NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  returned_qty  REAL NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  CHECK (returned_qty <= qty + 0.0005)
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

CREATE TABLE sale_payments (
  id         TEXT PRIMARY KEY,
  sale_id    TEXT NOT NULL REFERENCES sales(id),
  method_id  TEXT NOT NULL REFERENCES payment_methods(id),
  amount     INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);

CREATE TABLE sale_returns (
  id                TEXT PRIMARY KEY,
  sale_id           TEXT NOT NULL REFERENCES sales(id),
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  entry_date        TEXT NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  refund_method_id  TEXT REFERENCES payment_methods(id),   -- NULL = taken off the customer's debt
  restock           INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0, 1)),
  reason            TEXT NOT NULL,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE sale_return_items (
  id            TEXT PRIMARY KEY,
  return_id     TEXT NOT NULL REFERENCES sale_returns(id),
  sale_item_id  TEXT NOT NULL REFERENCES sale_items(id),
  qty           REAL NOT NULL CHECK (qty > 0),
  amount        INTEGER NOT NULL CHECK (amount >= 0)
);

-- ── Purchases (stock bought, incl. fuel deliveries) ─────────────
CREATE TABLE purchases (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  number        INTEGER NOT NULL,
  entry_date    TEXT NOT NULL,
  supplier_id   TEXT REFERENCES suppliers(id),
  invoice_ref   TEXT,
  total         INTEGER NOT NULL CHECK (total >= 0),
  paid_amount   INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  method_id     TEXT REFERENCES payment_methods(id),
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  note          TEXT,
  void_reason   TEXT,
  voided_by     TEXT REFERENCES users(id),
  voided_at     TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  UNIQUE (business_id, number),
  CHECK (paid_amount <= total),
  CHECK (paid_amount = 0 OR method_id IS NOT NULL),
  CHECK (paid_amount = total OR supplier_id IS NOT NULL)
);
CREATE INDEX idx_purchases_business_date ON purchases(business_id, entry_date);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE purchase_items (
  id           TEXT PRIMARY KEY,
  purchase_id  TEXT NOT NULL REFERENCES purchases(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  tank_id      TEXT REFERENCES fuel_tanks(id),
  qty          REAL NOT NULL CHECK (qty > 0),
  line_total   INTEGER NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ── Operating expenses ──────────────────────────────────────────
CREATE TABLE expenses (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  entry_date    TEXT NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  method_id     TEXT REFERENCES payment_methods(id),   -- NULL = not paid yet (owed to supplier)
  supplier_id   TEXT REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  void_reason   TEXT,
  voided_by     TEXT REFERENCES users(id),
  voided_at     TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  CHECK (method_id IS NOT NULL OR supplier_id IS NOT NULL)
);
CREATE INDEX idx_expenses_business_date ON expenses(business_id, entry_date);

-- ── Money movements: debt collections, supplier payments, transfers, owner money ──
CREATE TABLE money_movements (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('customer_payment', 'supplier_payment', 'transfer', 'owner_in', 'owner_out')),
  entry_date     TEXT NOT NULL,
  business_id    TEXT NOT NULL REFERENCES businesses(id),      -- the (source) business
  method_id      TEXT NOT NULL REFERENCES payment_methods(id), -- the (source) account
  to_business_id TEXT REFERENCES businesses(id),
  to_method_id   TEXT REFERENCES payment_methods(id),
  customer_id    TEXT REFERENCES customers(id),
  supplier_id    TEXT REFERENCES suppliers(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  void_reason    TEXT,
  voided_by      TEXT REFERENCES users(id),
  voided_at      TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  CHECK (type <> 'customer_payment' OR customer_id IS NOT NULL),
  CHECK (type <> 'supplier_payment' OR supplier_id IS NOT NULL),
  CHECK (type <> 'transfer' OR (to_business_id IS NOT NULL AND to_method_id IS NOT NULL
                                AND (to_business_id <> business_id OR to_method_id <> method_id)))
);
CREATE INDEX idx_money_mv_business_date ON money_movements(business_id, entry_date);

-- ── Fuel: shift meter readings and tank dips ────────────────────
CREATE TABLE fuel_shifts (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  entry_date        TEXT NOT NULL,
  shift_name        TEXT NOT NULL DEFAULT 'Day',
  total_liters      REAL NOT NULL DEFAULT 0,
  expected_amount   INTEGER NOT NULL DEFAULT 0,    -- litres × price, from the meters
  collected_amount  INTEGER NOT NULL DEFAULT 0,    -- cash + mobile received
  credit_amount     INTEGER NOT NULL DEFAULT 0,    -- given on credit to customers
  difference        INTEGER NOT NULL DEFAULT 0,    -- collected + credit − expected (negative = shortage)
  difference_reason TEXT,
  meter_gap_note    TEXT,                          -- set when an opening reading did not match the last closing
  cost_total        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  note              TEXT,
  void_reason       TEXT,
  voided_by         TEXT REFERENCES users(id),
  voided_at         TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL,
  CHECK (difference = 0 OR difference_reason IS NOT NULL)
);
CREATE INDEX idx_fuel_shifts_date ON fuel_shifts(business_id, entry_date);

CREATE TABLE fuel_shift_readings (
  id             TEXT PRIMARY KEY,
  shift_id       TEXT NOT NULL REFERENCES fuel_shifts(id),
  pump_id        TEXT NOT NULL REFERENCES fuel_pumps(id),
  tank_id        TEXT NOT NULL REFERENCES fuel_tanks(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  opening_meter  REAL NOT NULL CHECK (opening_meter >= 0),
  closing_meter  REAL NOT NULL,
  liters         REAL NOT NULL CHECK (liters >= 0),
  unit_price     INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  unit_cost      REAL NOT NULL DEFAULT 0,
  CHECK (closing_meter >= opening_meter)
);
CREATE INDEX idx_fuel_readings_shift ON fuel_shift_readings(shift_id);
CREATE INDEX idx_fuel_readings_pump ON fuel_shift_readings(pump_id);

CREATE TABLE fuel_shift_payments (
  id           TEXT PRIMARY KEY,
  shift_id     TEXT NOT NULL REFERENCES fuel_shifts(id),
  method_id    TEXT REFERENCES payment_methods(id),
  customer_id  TEXT REFERENCES customers(id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  CHECK ((method_id IS NULL) <> (customer_id IS NULL))
);
CREATE INDEX idx_fuel_payments_shift ON fuel_shift_payments(shift_id);

CREATE TABLE tank_dips (
  id            TEXT PRIMARY KEY,
  tank_id       TEXT NOT NULL REFERENCES fuel_tanks(id),
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  entry_date    TEXT NOT NULL,
  book_qty      REAL NOT NULL,
  measured_qty  REAL NOT NULL CHECK (measured_qty >= 0),
  variance      REAL NOT NULL,              -- measured − book (negative = missing fuel)
  variance_value INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  CHECK (ABS(variance) < 0.0005 OR reason IS NOT NULL)
);
CREATE INDEX idx_tank_dips_tank ON tank_dips(tank_id, entry_date);

-- ── Daily cash closing ──────────────────────────────────────────
CREATE TABLE daily_closings (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  entry_date        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'reopened')),
  total_expected    INTEGER NOT NULL,
  total_counted     INTEGER NOT NULL,
  total_difference  INTEGER NOT NULL,
  explanation       TEXT,
  closed_by         TEXT NOT NULL REFERENCES users(id),
  closed_at         TEXT NOT NULL,
  reopened_by       TEXT REFERENCES users(id),
  reopened_at       TEXT,
  reopen_reason     TEXT,
  CHECK (total_difference = 0 OR explanation IS NOT NULL)
);
CREATE UNIQUE INDEX uq_daily_closing ON daily_closings(business_id, entry_date) WHERE status = 'closed';

CREATE TABLE daily_closing_lines (
  id           TEXT PRIMARY KEY,
  closing_id   TEXT NOT NULL REFERENCES daily_closings(id),
  method_id    TEXT NOT NULL REFERENCES payment_methods(id),
  opening      INTEGER NOT NULL,
  sales_in     INTEGER NOT NULL,
  collections  INTEGER NOT NULL,
  expenses_out INTEGER NOT NULL,
  suppliers_out INTEGER NOT NULL,
  transfers    INTEGER NOT NULL,
  other        INTEGER NOT NULL,
  expected     INTEGER NOT NULL,
  counted      INTEGER NOT NULL,
  difference   INTEGER NOT NULL
);
CREATE INDEX idx_closing_lines ON daily_closing_lines(closing_id);

-- ── The financial journal ───────────────────────────────────────
CREATE TABLE journal_entries (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  type         TEXT NOT NULL,
  ref_type     TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  memo         TEXT NOT NULL,
  amount       INTEGER NOT NULL DEFAULT 0,       -- headline amount for activity lists
  reverses_id  TEXT REFERENCES journal_entries(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_journal_business_date ON journal_entries(business_id, entry_date);
CREATE INDEX idx_journal_ref ON journal_entries(ref_type, ref_id);
CREATE INDEX idx_journal_created ON journal_entries(created_at);

-- account:
--   cash        money held, per business and payment method (asset)
--   receivable  owed by a customer (asset)
--   inventory   stock at cost (asset)
--   payable     owed to a supplier (liability)
--   sales       revenue
--   cogs        cost of goods sold / used
--   expense     operating expenses (category)
--   stock_loss  waste, damage, missing stock, fuel tank variance
--   cash_diff   cash shortages (+) and overages (−)
--   transfer    money moved between businesses (nets to zero across businesses)
--   owner       owner's money put in or taken out, opening balances
CREATE TABLE journal_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     TEXT NOT NULL REFERENCES journal_entries(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  entry_type   TEXT NOT NULL,
  account      TEXT NOT NULL CHECK (account IN ('cash', 'receivable', 'inventory', 'payable', 'sales', 'cogs',
                                                'expense', 'stock_loss', 'cash_diff', 'transfer', 'owner')),
  method_id    TEXT REFERENCES payment_methods(id),
  customer_id  TEXT REFERENCES customers(id),
  supplier_id  TEXT REFERENCES suppliers(id),
  category     TEXT,
  amount       INTEGER NOT NULL,
  CHECK (account <> 'cash' OR method_id IS NOT NULL),
  CHECK (account <> 'receivable' OR customer_id IS NOT NULL),
  CHECK (account <> 'payable' OR supplier_id IS NOT NULL)
);
CREATE INDEX idx_lines_business_date ON journal_lines(business_id, entry_date, account);
CREATE INDEX idx_lines_account ON journal_lines(account, business_id, method_id);
CREATE INDEX idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_lines_customer ON journal_lines(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_lines_supplier ON journal_lines(supplier_id) WHERE supplier_id IS NOT NULL;

-- Journal rows are append-only: corrections are made with reversing entries.
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

-- ── Audit trail ─────────────────────────────────────────────────
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT REFERENCES users(id),
  business_id  TEXT REFERENCES businesses(id),
  action       TEXT NOT NULL,
  entity       TEXT NOT NULL,
  entity_id    TEXT,
  details      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
