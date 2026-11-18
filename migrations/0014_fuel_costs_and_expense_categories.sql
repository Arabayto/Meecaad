-- Fuel station inventory works like a normal shop's: every item has a cost price
-- (what one unit costs us, in US dollars, kept as a running average) and a selling
-- price. Receiving stock records what it cost and how it was paid (now, or owed to a
-- supplier); each sale counts its cost, so profit = sales − cost of goods − expenses.
ALTER TABLE fuel_items ADD COLUMN cost_price REAL NOT NULL DEFAULT 0;      -- US cents per unit (average)
ALTER TABLE fuel_stock_log ADD COLUMN unit_cost REAL;                       -- US cents per unit
ALTER TABLE fuel_stock_log ADD COLUMN value INTEGER;                        -- US cents (in the books)
ALTER TABLE fuel_stock_log ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
ALTER TABLE fuel_stock_log ADD COLUMN method_id TEXT REFERENCES payment_methods(id);
ALTER TABLE duty_sales ADD COLUMN unit_cost REAL;                           -- cost per unit at the time of the sale

-- Expense categories registered in advance (a business that has a list must use it).
CREATE TABLE expense_categories (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  name         TEXT NOT NULL COLLATE NOCASE,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_expense_category ON expense_categories(business_id, name);

-- The fuel station starts with a usual list, plus any category it already used.
INSERT INTO expense_categories (id, business_id, name, created_at)
SELECT lower(hex(randomblob(16))), 'fuel', column1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (VALUES ('Salaries'), ('Rent'), ('Electricity'), ('Generator fuel'), ('Water'), ('Transport'), ('Repairs & maintenance'),
             ('Phone & internet'), ('Taxes & licences'), ('Cleaning'), ('Other'));
INSERT OR IGNORE INTO expense_categories (id, business_id, name, created_at)
SELECT lower(hex(randomblob(16))), 'fuel', category, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT DISTINCT category FROM expenses WHERE business_id = 'fuel');
