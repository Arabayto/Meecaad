// Store sales page (same layout as the pharmacy's): the four figures at the top and the
// sales records, newest first, one page at a time, with search and filters.

import { all, bad, bizScope, first, placeholders, today, type Ctx } from './lib';

const PAGE = 20;
/** A real calendar day written YYYY-MM-DD (2026-13-40 is not). */
const realDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const COUNT_CAP = 1000;   // the badge says "1000+" past this, so a busy store never counts its whole history

function storeOnly(ctx: Ctx) {
  const business = String(ctx.url.searchParams.get('business') ?? '');
  const scope = bizScope(ctx, business);
  if (scope.length !== 1) throw bad('Choose one business');
  return scope[0];
}

/** GET /sales/stats?business — total sales, today's sales and revenue, products available; today's SLSH rate. */
export async function stats(ctx: Ctx) {
  const business = storeOnly(ctx);
  const t = today();
  const [total, day, products, rate] = await Promise.all([
    first<{ n: number }>(ctx.db, 'SELECT COALESCE(SUM(count), 0) AS n FROM sales_daily WHERE business_id = ?', business),
    first<{ n: number; revenue: number }>(ctx.db, `SELECT COUNT(*) AS n, COALESCE(SUM(total - returned_amount), 0) AS revenue FROM sales
      WHERE business_id = ? AND entry_date = ? AND status = 'completed'`, business, t),
    first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM products WHERE business_id = ? AND active = 1 AND deleted_at IS NULL AND kind IN ('item', 'menu')
      AND (track_stock = 0 OR stock_qty > 0)`, business),
    first<{ rate: number }>(ctx.db, 'SELECT rate FROM exchange_rates WHERE rate_date <= ? ORDER BY rate_date DESC, set_at DESC LIMIT 1', t),
  ]);
  return { total: total?.n ?? 0, today: day?.n ?? 0, todayRevenue: day?.revenue ?? 0, products: products?.n ?? 0, rate: rate?.rate ?? null };
}

/** GET /sales/records?business&page&q&method&debt&from&to — sales with their items, 20 per page. */
export async function records(ctx: Ctx) {
  const business = storeOnly(ctx);
  const p = ctx.url.searchParams;
  const page = Math.max(1, Math.min(500, Number(p.get('page')) || 1));
  const where: string[] = ['s.business_id = ?'];
  const args: unknown[] = [business];
  const from = p.get('from'), to = p.get('to');
  if (from) { if (!realDate(from)) throw bad('Choose a valid date'); where.push('s.entry_date >= ?'); args.push(from); }
  if (to) { if (!realDate(to)) throw bad('Choose a valid date'); where.push('s.entry_date <= ?'); args.push(to); }
  const method = p.get('method');
  if (method) { where.push('EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method_id = ?)'); args.push(method); }
  const debt = p.get('debt');
  if (debt === 'debt') where.push("s.credit_amount > 0 AND s.status = 'completed'");
  if (debt === 'paid') where.push("s.credit_amount = 0 AND s.status = 'completed'");
  if (debt === 'cancelled') where.push("s.status = 'voided'");
  const q = (p.get('q') ?? '').trim();
  let salesFrom = 'sales s';
  const fromArgs: unknown[] = [];
  if (q) {
    // Search without reading every sale: a sale number goes straight to that sale; otherwise find the
    // matching customers and products first (small lists), then only their sales through the indexes.
    const n = Number(q.replace(/^#/, ''));
    const [custs, prods] = await Promise.all([
      all<{ id: string }>(ctx.db, `SELECT c.id FROM customers c JOIN customer_businesses l ON l.customer_id = c.id AND l.business_id = ?
        WHERE c.name LIKE ? OR c.phone LIKE ? LIMIT 200`, business, `%${q}%`, `%${q}%`),
      all<{ id: string }>(ctx.db, `SELECT id FROM products WHERE business_id = ? AND name LIKE ? LIMIT 200`, business, `%${q}%`),
    ]);
    // The matching sale ids, each part through its own index; the sales are then read by id only
    // (CROSS JOIN keeps that order, so the store's other sales are never read).
    const parts: string[] = [];
    if (Number.isInteger(n) && n > 0) { parts.push('SELECT id FROM sales WHERE business_id = ? AND number = ?'); fromArgs.push(business, n); }
    if (custs.length) { parts.push(`SELECT id FROM sales WHERE customer_id IN (${placeholders(custs)})`); fromArgs.push(...custs.map((c) => c.id)); }
    if (prods.length) { parts.push(`SELECT sale_id FROM sale_items WHERE product_id IN (${placeholders(prods)})`); fromArgs.push(...prods.map((x) => x.id)); }
    if (!parts.length) where.push('0');
    else salesFrom = `(${parts.join(' UNION ')}) m CROSS JOIN sales s ON s.id = m.id`;
  }
  const sqlWhere = where.join(' AND ');
  const [rows, counted] = await Promise.all([
    all<any>(ctx.db, `SELECT s.id, s.number, s.entry_date, s.created_at, s.customer_id, s.subtotal, s.discount, s.total, s.paid_amount, s.credit_amount, s.returned_amount, s.status, s.note,
        c.name AS customer_name, c.phone AS customer_phone, u.full_name AS created_by_name, CASE WHEN u.role = 'owner' THEN 'owner' ELSE ub.role END AS created_by_role,
        (SELECT GROUP_CONCAT(pm.name || ' ' || printf('%.2f', sp.amount / 100.0), ', ') FROM sale_payments sp JOIN payment_methods pm ON pm.id = sp.method_id WHERE sp.sale_id = s.id) AS payments_text,
        (SELECT GROUP_CONCAT(DISTINCT sp.method_id) FROM sale_payments sp WHERE sp.sale_id = s.id) AS methods
      FROM ${salesFrom} LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.created_by
      LEFT JOIN user_businesses ub ON ub.user_id = s.created_by AND ub.business_id = s.business_id
      WHERE ${sqlWhere} ORDER BY s.entry_date DESC, s.created_at DESC LIMIT ? OFFSET ?`, ...fromArgs, ...args, PAGE, (page - 1) * PAGE),
    first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${salesFrom} WHERE ${sqlWhere} LIMIT ${COUNT_CAP + 1})`, ...fromArgs, ...args),
  ]);
  const items = rows.length ? await all<any>(ctx.db, `SELECT id, sale_id, product_id, name, qty, returned_qty, unit_price, line_total FROM sale_items
      WHERE sale_id IN (${placeholders(rows)}) ORDER BY rowid`, ...rows.map((r) => r.id)) : [];
  for (const r of rows) {
    r.items = items.filter((i) => i.sale_id === r.id);
    r.methods = String(r.methods ?? '').split(',').filter(Boolean);
  }
  const total = Math.min(counted?.n ?? 0, COUNT_CAP);
  return { rows, page, pageSize: PAGE, total, more: (counted?.n ?? 0) > COUNT_CAP, pages: Math.max(1, Math.ceil(total / PAGE)) };
}
