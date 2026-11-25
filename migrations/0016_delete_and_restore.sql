-- Delete for products, customers and suppliers.
-- A record that was never used is removed for good. One that appears in sales,
-- purchases, stock or money history is marked deleted instead: it disappears
-- from lists, the till and pickers, but the history that names it stays whole.
ALTER TABLE products ADD COLUMN deleted_at TEXT;
ALTER TABLE products ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE customers ADD COLUMN deleted_at TEXT;
ALTER TABLE customers ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE suppliers ADD COLUMN deleted_at TEXT;
ALTER TABLE suppliers ADD COLUMN deleted_by TEXT REFERENCES users(id);
