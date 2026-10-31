-- Business boundaries.
--
-- 1. Roles per business: a person can be a manager in the Store and a cashier
--    in the Restaurant. users.role stays for the owner flag and for history.
-- 2. Customers and suppliers belong to the business(es) they are linked to.
--    One person who deals with two businesses stays one record; their debts
--    are already kept separately per business in the journal.
--
-- Nothing is deleted or renamed. Existing access and records are kept.

ALTER TABLE user_businesses ADD COLUMN role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('manager', 'cashier', 'staff'));
UPDATE user_businesses SET role = CASE (SELECT u.role FROM users u WHERE u.id = user_businesses.user_id)
  WHEN 'manager' THEN 'manager' WHEN 'cashier' THEN 'cashier' ELSE 'staff' END;

CREATE TABLE customer_businesses (
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  PRIMARY KEY (customer_id, business_id)
) WITHOUT ROWID;
CREATE INDEX idx_customer_businesses_business ON customer_businesses(business_id, customer_id);

CREATE TABLE supplier_businesses (
  supplier_id  TEXT NOT NULL REFERENCES suppliers(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  PRIMARY KEY (supplier_id, business_id)
) WITHOUT ROWID;
CREATE INDEX idx_supplier_businesses_business ON supplier_businesses(business_id, supplier_id);

-- Link existing customers to every business they have done business with.
INSERT OR IGNORE INTO customer_businesses (customer_id, business_id)
SELECT DISTINCT customer_id, business_id FROM journal_lines WHERE customer_id IS NOT NULL;
INSERT OR IGNORE INTO customer_businesses (customer_id, business_id)
SELECT DISTINCT customer_id, business_id FROM sales WHERE customer_id IS NOT NULL;
INSERT OR IGNORE INTO customer_businesses (customer_id, business_id)
SELECT DISTINCT customer_id, business_id FROM money_movements WHERE customer_id IS NOT NULL;
INSERT OR IGNORE INTO customer_businesses (customer_id, business_id)
SELECT DISTINCT p.customer_id, s.business_id FROM fuel_shift_payments p JOIN fuel_shifts s ON s.id = p.shift_id WHERE p.customer_id IS NOT NULL;

-- Same for suppliers.
INSERT OR IGNORE INTO supplier_businesses (supplier_id, business_id)
SELECT DISTINCT supplier_id, business_id FROM journal_lines WHERE supplier_id IS NOT NULL;
INSERT OR IGNORE INTO supplier_businesses (supplier_id, business_id)
SELECT DISTINCT supplier_id, business_id FROM purchases WHERE supplier_id IS NOT NULL;
INSERT OR IGNORE INTO supplier_businesses (supplier_id, business_id)
SELECT DISTINCT supplier_id, business_id FROM expenses WHERE supplier_id IS NOT NULL;
INSERT OR IGNORE INTO supplier_businesses (supplier_id, business_id)
SELECT DISTINCT supplier_id, business_id FROM money_movements WHERE supplier_id IS NOT NULL;

-- Customers/suppliers with no transactions yet: link them to the businesses
-- the person who created them works in (the owner's go to all businesses),
-- so nobody loses a contact they added.
INSERT OR IGNORE INTO customer_businesses (customer_id, business_id)
SELECT c.id, b.id FROM customers c CROSS JOIN businesses b
WHERE NOT EXISTS (SELECT 1 FROM customer_businesses x WHERE x.customer_id = c.id)
  AND (c.created_by IS NULL
       OR EXISTS (SELECT 1 FROM users u WHERE u.id = c.created_by AND u.role = 'owner')
       OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = c.created_by AND ub.business_id = b.id));
INSERT OR IGNORE INTO supplier_businesses (supplier_id, business_id)
SELECT s.id, b.id FROM suppliers s CROSS JOIN businesses b
WHERE NOT EXISTS (SELECT 1 FROM supplier_businesses x WHERE x.supplier_id = s.id)
  AND (s.created_by IS NULL
       OR EXISTS (SELECT 1 FROM users u WHERE u.id = s.created_by AND u.role = 'owner')
       OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = s.created_by AND ub.business_id = b.id));
