-- Profit figures read only the profit accounts (sales, cost of goods, expenses, losses) for a date
-- range. Keyed by business and date alone, every other account's rows were read too.
CREATE INDEX idx_daily_totals_account ON daily_totals(business_id, account, entry_date);
