-- Simple restaurant: orders, menu, sales, expenses, customers and reports only.
-- No kitchen statuses, no ingredients/recipes/stock, no purchases, suppliers,
-- money page or daily closing for the restaurant.
--
-- Financial history is never deleted: any past journal entries, sales and
-- stock movements stay as they were. Only feature data with no money in it
-- is removed.

-- Kitchen statuses: orders are simply open (pending) until paid.
DROP INDEX IF EXISTS idx_open_orders_number;
ALTER TABLE open_orders DROP COLUMN kitchen_status;
ALTER TABLE open_orders DROP COLUMN ready_at;
CREATE INDEX idx_open_orders_number ON open_orders(business_id, order_date, number);

-- Recipes and the ingredients each sold dish used.
DROP TABLE IF EXISTS sale_item_components;
DROP TABLE IF EXISTS recipe_items;

-- Menu items are no longer stock-counted; ingredient items are hidden (their
-- past purchases stay in the books).
UPDATE products SET track_stock = 0, reorder_level = 0 WHERE business_id = 'restaurant' AND kind = 'menu';
UPDATE products SET active = 0 WHERE business_id = 'restaurant' AND kind = 'ingredient';
