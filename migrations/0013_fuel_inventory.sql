-- Fuel station inventory: diesel, petrol, oils, tools … as many items as wanted.
-- The admin sets each item's price in US dollars or Somaliland Shillings; the
-- sales team sells at that price. Stock goes down with each sale (and comes back
-- when a sale is cancelled); deliveries and counts are written to a log.

CREATE TABLE fuel_items (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL DEFAULT 'fuel' REFERENCES businesses(id),
  name           TEXT NOT NULL COLLATE NOCASE,
  category       TEXT NOT NULL DEFAULT '',                       -- Fuel, Oil, Tools …
  unit           TEXT NOT NULL DEFAULT 'pcs',                    -- L, pcs, drum, kg …
  price          INTEGER NOT NULL CHECK (price > 0),             -- per unit: cents (USD) or whole shillings (SLSH)
  currency       TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'SLSH')),
  track_stock    INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0, 1)),
  stock_qty      REAL NOT NULL DEFAULT 0,
  reorder_level  REAL NOT NULL DEFAULT 0,                        -- low-stock warning at or below this
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_fuel_item_name ON fuel_items(business_id, name);

-- Every change of stock: received, sold, sale cancelled, count correction.
CREATE TABLE fuel_stock_log (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES fuel_items(id),
  entry_date  TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('received', 'sale', 'sale_void', 'count')),
  qty         REAL NOT NULL,                                     -- + in, − out
  ref_id      TEXT,                                              -- the sale
  reason      TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_fuel_stock_log_item ON fuel_stock_log(item_id, created_at);

-- What each sale was (a snapshot: later price changes never change old sales).
ALTER TABLE duty_sales ADD COLUMN item_id TEXT REFERENCES fuel_items(id);
ALTER TABLE duty_sales ADD COLUMN item_name TEXT;
ALTER TABLE duty_sales ADD COLUMN qty REAL;
ALTER TABLE duty_sales ADD COLUMN unit_price INTEGER;
ALTER TABLE duty_sales ADD COLUMN price_currency TEXT;
