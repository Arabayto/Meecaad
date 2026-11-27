-- Daily summaries for profit tracking, so a month or a year is read from one row per
-- product per day instead of every sale line. Kept up to date by triggers in the same
-- write as the sale, its returns and its cancellation (nothing in the app can forget them).
-- Amounts are cents; revenue is after the sale's discount and after returns.
CREATE TABLE item_daily (
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  revenue      REAL NOT NULL DEFAULT 0,
  cost         REAL NOT NULL DEFAULT 0,
  below_cost   REAL NOT NULL DEFAULT 0,
  lines        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, entry_date, product_id)
);
CREATE TABLE sales_daily (
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  entry_date   TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, entry_date)
);

-- Sales already made.
INSERT INTO item_daily (business_id, entry_date, product_id, name, qty, revenue, cost, below_cost, lines)
SELECT s.business_id, s.entry_date, si.product_id, MAX(si.name), SUM(si.qty - si.returned_qty),
       SUM(si.line_total * (1.0 - si.returned_qty / si.qty) * (CASE WHEN s.subtotal > 0 THEN s.total * 1.0 / s.subtotal ELSE 0 END)),
       SUM((si.qty - si.returned_qty) * si.unit_cost),
       SUM(CASE WHEN si.unit_cost > si.unit_price THEN (si.unit_cost - si.unit_price) * (si.qty - si.returned_qty) ELSE 0 END), COUNT(*)
FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed'
GROUP BY s.business_id, s.entry_date, si.product_id;
INSERT INTO sales_daily (business_id, entry_date, count)
SELECT business_id, entry_date, COUNT(*) FROM sales WHERE status = 'completed' GROUP BY business_id, entry_date;

-- A sale line is saved (the sale row is saved just before its lines).
CREATE TRIGGER item_daily_add AFTER INSERT ON sale_items BEGIN INSERT INTO item_daily (business_id, entry_date, product_id, name, qty, revenue, cost, below_cost, lines) SELECT s.business_id, s.entry_date, NEW.product_id, NEW.name, NEW.qty, NEW.line_total * (CASE WHEN s.subtotal > 0 THEN s.total * 1.0 / s.subtotal ELSE 0 END), NEW.qty * NEW.unit_cost, CASE WHEN NEW.unit_cost > NEW.unit_price THEN (NEW.unit_cost - NEW.unit_price) * NEW.qty ELSE 0 END, 1 FROM sales s WHERE s.id = NEW.sale_id AND s.status = 'completed' ON CONFLICT (business_id, entry_date, product_id) DO UPDATE SET name = excluded.name, qty = qty + excluded.qty, revenue = revenue + excluded.revenue, cost = cost + excluded.cost, below_cost = below_cost + excluded.below_cost, lines = lines + 1; END;
-- Items returned.
CREATE TRIGGER item_daily_return AFTER UPDATE OF returned_qty ON sale_items WHEN NEW.returned_qty <> OLD.returned_qty BEGIN UPDATE item_daily SET qty = qty - (NEW.returned_qty - OLD.returned_qty), revenue = revenue - NEW.line_total * (NEW.returned_qty - OLD.returned_qty) / NEW.qty * (SELECT CASE WHEN s.subtotal > 0 THEN s.total * 1.0 / s.subtotal ELSE 0 END FROM sales s WHERE s.id = NEW.sale_id), cost = cost - (NEW.returned_qty - OLD.returned_qty) * NEW.unit_cost, below_cost = below_cost - (CASE WHEN NEW.unit_cost > NEW.unit_price THEN (NEW.unit_cost - NEW.unit_price) * (NEW.returned_qty - OLD.returned_qty) ELSE 0 END) WHERE product_id = NEW.product_id AND (business_id, entry_date) = (SELECT s.business_id, s.entry_date FROM sales s WHERE s.id = NEW.sale_id AND s.status = 'completed'); END;
-- A sale is cancelled: take out what is left of it.
CREATE TRIGGER item_daily_void AFTER UPDATE OF status ON sales WHEN OLD.status = 'completed' AND NEW.status <> 'completed' BEGIN UPDATE item_daily SET qty = qty - COALESCE((SELECT SUM(si.qty - si.returned_qty) FROM sale_items si WHERE si.sale_id = NEW.id AND si.product_id = item_daily.product_id), 0), revenue = revenue - COALESCE((SELECT SUM(si.line_total * (1.0 - si.returned_qty / si.qty)) FROM sale_items si WHERE si.sale_id = NEW.id AND si.product_id = item_daily.product_id), 0) * (CASE WHEN NEW.subtotal > 0 THEN NEW.total * 1.0 / NEW.subtotal ELSE 0 END), cost = cost - COALESCE((SELECT SUM((si.qty - si.returned_qty) * si.unit_cost) FROM sale_items si WHERE si.sale_id = NEW.id AND si.product_id = item_daily.product_id), 0), below_cost = below_cost - COALESCE((SELECT SUM(CASE WHEN si.unit_cost > si.unit_price THEN (si.unit_cost - si.unit_price) * (si.qty - si.returned_qty) ELSE 0 END) FROM sale_items si WHERE si.sale_id = NEW.id AND si.product_id = item_daily.product_id), 0), lines = lines - (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = NEW.id AND si.product_id = item_daily.product_id) WHERE business_id = NEW.business_id AND entry_date = NEW.entry_date AND product_id IN (SELECT product_id FROM sale_items WHERE sale_id = NEW.id); END;
CREATE TRIGGER sales_daily_add AFTER INSERT ON sales WHEN NEW.status = 'completed' BEGIN INSERT INTO sales_daily (business_id, entry_date, count) VALUES (NEW.business_id, NEW.entry_date, 1) ON CONFLICT (business_id, entry_date) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER sales_daily_void AFTER UPDATE OF status ON sales WHEN OLD.status = 'completed' AND NEW.status <> 'completed' BEGIN UPDATE sales_daily SET count = count - 1 WHERE business_id = NEW.business_id AND entry_date = NEW.entry_date; END;
