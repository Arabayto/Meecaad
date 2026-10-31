-- Restaurant & Cafe: tables, open orders (pay later), and recipes.
-- All of it belongs to the restaurant only (CHECK business_id = 'restaurant').

CREATE TABLE restaurant_tables (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL DEFAULT 'restaurant' REFERENCES businesses(id) CHECK (business_id = 'restaurant'),
  name         TEXT NOT NULL,
  seats        INTEGER NOT NULL DEFAULT 4 CHECK (seats >= 0),
  sort         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL,
  UNIQUE (business_id, name)
);

-- An order taken at a table (or a takeaway) that is not paid yet. It has no
-- effect on money or stock until it is paid; paying turns it into a sale.
CREATE TABLE open_orders (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL DEFAULT 'restaurant' REFERENCES businesses(id) CHECK (business_id = 'restaurant'),
  table_id       TEXT REFERENCES restaurant_tables(id),
  label          TEXT,                      -- e.g. "Takeaway – Ali"
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  note           TEXT,
  cancel_reason  TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_by      TEXT REFERENCES users(id),
  closed_at      TEXT,
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_open_orders_status ON open_orders(business_id, status, created_at);
-- A table has at most one open order at a time.
CREATE UNIQUE INDEX uq_open_order_table ON open_orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE TABLE open_order_items (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES open_orders(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL CHECK (qty > 0),
  note        TEXT
);
CREATE INDEX idx_open_order_items ON open_order_items(order_id);

-- Paying an order: one sale per order (the primary key stops a double payment).
CREATE TABLE order_sales (
  order_id  TEXT PRIMARY KEY REFERENCES open_orders(id),
  sale_id   TEXT NOT NULL UNIQUE REFERENCES sales(id)
);

-- What one portion of a dish uses, e.g. Tea = 0.02 kg sugar + 0.01 kg tea leaves.
CREATE TABLE recipe_items (
  menu_id        TEXT NOT NULL REFERENCES products(id),
  ingredient_id  TEXT NOT NULL REFERENCES products(id),
  qty            REAL NOT NULL CHECK (qty > 0),
  PRIMARY KEY (menu_id, ingredient_id)
) WITHOUT ROWID;

-- The ingredients a sold dish actually took from stock (per portion, at that
-- day's cost), so a cancellation or return puts back exactly the same.
CREATE TABLE sale_item_components (
  id            TEXT PRIMARY KEY,
  sale_item_id  TEXT NOT NULL REFERENCES sale_items(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  qty           REAL NOT NULL CHECK (qty > 0),     -- per one unit of the sale item
  unit_cost     REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_item_components ON sale_item_components(sale_item_id);
