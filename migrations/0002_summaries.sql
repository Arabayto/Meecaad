-- Summary tables so screens never re-add the whole history.
--
-- Both tables are derived from journal_lines and are updated in the same
-- atomic batch as every journal entry (server/lib.ts Tx.journal), so they can
-- never disagree with it. The end-to-end test checks they match exactly.
-- Keys use '' instead of NULL so they can be part of the primary key.

-- Current balance of every account key (each money account per business,
-- each customer and supplier per business, sales, stock, …).
CREATE TABLE account_balances (
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  account         TEXT NOT NULL,
  method_id       TEXT NOT NULL DEFAULT '',
  customer_id     TEXT NOT NULL DEFAULT '',
  supplier_id     TEXT NOT NULL DEFAULT '',
  balance         INTEGER NOT NULL DEFAULT 0,
  first_increase  TEXT,            -- first business day it went up (e.g. first credit given)
  last_increase   TEXT,            -- last business day it went up
  last_decrease   TEXT,            -- last business day it went down (e.g. last payment)
  PRIMARY KEY (business_id, account, method_id, customer_id, supplier_id)
) WITHOUT ROWID;

-- Totals per business, day, account and kind of transaction.
CREATE TABLE daily_totals (
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  account      TEXT NOT NULL,
  entry_type   TEXT NOT NULL,
  method_id    TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  debit        INTEGER NOT NULL DEFAULT 0,   -- sum of positive amounts
  credit       INTEGER NOT NULL DEFAULT 0,   -- sum of negative amounts, as a positive number
  PRIMARY KEY (business_id, entry_date, account, entry_type, method_id, category)
) WITHOUT ROWID;

-- Fill both from the existing journal.
INSERT INTO account_balances (business_id, account, method_id, customer_id, supplier_id, balance, first_increase, last_increase, last_decrease)
SELECT business_id, account, COALESCE(method_id, ''), COALESCE(customer_id, ''), COALESCE(supplier_id, ''), SUM(amount),
       MIN(CASE WHEN amount > 0 THEN entry_date END), MAX(CASE WHEN amount > 0 THEN entry_date END), MAX(CASE WHEN amount < 0 THEN entry_date END)
FROM journal_lines GROUP BY business_id, account, COALESCE(method_id, ''), COALESCE(customer_id, ''), COALESCE(supplier_id, '');

INSERT INTO daily_totals (business_id, entry_date, account, entry_type, method_id, category, debit, credit)
SELECT business_id, entry_date, account, entry_type, COALESCE(method_id, ''), COALESCE(category, ''),
       SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)
FROM journal_lines GROUP BY business_id, entry_date, account, entry_type, COALESCE(method_id, ''), COALESCE(category, '');

-- Indexes that let list screens read only what they show.
CREATE INDEX idx_stock_mv_business_created ON stock_movements(business_id, created_at);
DROP INDEX idx_stock_mv_product;
CREATE INDEX idx_stock_mv_product ON stock_movements(product_id, created_at);
CREATE INDEX idx_money_mv_date ON money_movements(entry_date);
