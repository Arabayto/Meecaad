-- Restaurant POS workflow: numbered orders with a kitchen status, and item pictures.
-- Only adds columns and a table; existing orders and products are kept.

-- Orders get a number per day (called out to the customer) and a kitchen
-- status: pending (sent to the kitchen) → ready (cooked) → served.
ALTER TABLE open_orders ADD COLUMN order_date TEXT;
ALTER TABLE open_orders ADD COLUMN number INTEGER;
ALTER TABLE open_orders ADD COLUMN kitchen_status TEXT NOT NULL DEFAULT 'pending' CHECK (kitchen_status IN ('pending', 'ready', 'served'));
ALTER TABLE open_orders ADD COLUMN ready_at TEXT;
UPDATE open_orders SET order_date = substr(created_at, 1, 10) WHERE order_date IS NULL;
CREATE INDEX idx_open_orders_number ON open_orders(business_id, order_date, number);

-- One small picture per product (resized in the browser to ~300 px), used on the till.
CREATE TABLE product_images (
  product_id  TEXT PRIMARY KEY REFERENCES products(id),
  mime        TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg', 'image/png')),
  data        TEXT NOT NULL,                -- base64
  updated_at  TEXT NOT NULL
);
