-- Expense categories are registered in advance in every business (the fuel station
-- got its list in 0014). Each business starts with a usual list plus any category it
-- already used; managers add, rename or hide them. Expenses choose from the list.
INSERT OR IGNORE INTO expense_categories (id, business_id, name, created_at)
SELECT lower(hex(randomblob(16))), 'restaurant', column1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (VALUES ('Salaries'), ('Rent'), ('Electricity'), ('Water'), ('Gas'), ('Bread'), ('Food & ingredients'), ('Cleaning'),
             ('Repairs & maintenance'), ('Transport'), ('Phone & internet'), ('Taxes & licences'), ('Other'));
INSERT OR IGNORE INTO expense_categories (id, business_id, name, created_at)
SELECT lower(hex(randomblob(16))), 'store', column1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (VALUES ('Salaries'), ('Rent'), ('Electricity'), ('Water'), ('Transport'), ('Repairs & maintenance'), ('Cleaning'),
             ('Packaging'), ('Phone & internet'), ('Taxes & licences'), ('Other'));
INSERT OR IGNORE INTO expense_categories (id, business_id, name, created_at)
SELECT lower(hex(randomblob(16))), business_id, category, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT DISTINCT business_id, category FROM expenses WHERE business_id IN ('restaurant', 'store'));
