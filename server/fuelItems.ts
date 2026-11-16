// Fuel station inventory: diesel, petrol, oils, tools … The admin (manager or
// owner) sets each item's price in US dollars or Somaliland Shillings and keeps
// its stock; the sales team sells at that price. Stock is a simple quantity with
// a log of every change (deliveries, sales, cancelled sales, counts).

import { HttpError, Tx, all, assertDayOpen, bad, bizScope, bool, cents, entryDate, first, idemKey, newId, nowIso, qty, requireBiz, round3, str, today, type Ctx } from './lib';

const B = 'fuel';
const CURRENCIES = ['USD', 'SLSH'];

/** Price in the item's own money: cents for USD, whole shillings for SLSH. */
function priceOf(v: unknown, currency: string) {
  if (currency === 'USD') return cents(v, 'Price', { min: 1 });
  const n = Math.round(Number(String(v ?? '').replace(/,/g, '')));
  if (!Number.isFinite(n) || n < 1 || n > 1e9) throw bad('Enter the price in Shillings (for example 15,000)');
  return n;
}

export async function listItems(ctx: Ctx) {
  bizScope(ctx, B);
  const manage = ctx.user.owner || ctx.user.roles[B] === 'manager';
  return all(ctx.db, `SELECT i.*, (SELECT COALESCE(SUM(-l.qty), 0) FROM fuel_stock_log l WHERE l.item_id = i.id AND l.type IN ('sale', 'sale_void') AND l.entry_date >= ?) AS sold_30d
    FROM fuel_items i WHERE i.business_id = ? ${manage ? '' : 'AND i.active = 1'} ORDER BY i.active DESC, i.category, i.name`, today(-30), B);
}

function fields(b: any, existing?: any) {
  const name = str(b.name ?? existing?.name, 'Name', { required: true, max: 80 })!;
  const currency = String(b.currency ?? existing?.currency ?? 'USD');
  if (!CURRENCIES.includes(currency)) throw bad('Choose US dollars or Somaliland Shillings');
  return {
    name, currency,
    category: str(b.category ?? existing?.category, 'Category', { max: 40 }) ?? '',
    unit: str(b.unit ?? existing?.unit, 'Unit', { max: 20 }) ?? 'pcs',
    price: b.price === undefined && existing && currency === existing.currency ? existing.price : priceOf(b.price, currency),
    track: b.trackStock === undefined ? (existing?.track_stock ?? 1) : bool(b.trackStock) ? 1 : 0,
    reorder: b.reorderLevel === undefined ? (existing?.reorder_level ?? 0) : qty(b.reorderLevel, 'Low-stock level', { min: 0 }),
    active: b.active === undefined ? (existing?.active ?? 1) : bool(b.active) ? 1 : 0,
  };
}

export async function createItem(ctx: Ctx) {
  requireBiz(ctx, B, 'catalog');
  const f = fields(ctx.body);
  if (await first(ctx.db, 'SELECT id FROM fuel_items WHERE business_id = ? AND name = ?', B, f.name)) throw new HttpError(409, 'There is already an item with this name');
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO fuel_items (id, business_id, name, category, unit, price, currency, track_stock, reorder_level, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, B, f.name, f.category, f.unit, f.price, f.currency, f.track, f.reorder, f.active, ctx.user.id, nowIso());
  const opening = ctx.body.openingQty === undefined || ctx.body.openingQty === '' ? 0 : qty(ctx.body.openingQty, 'Quantity in stock now', { min: 0 });
  if (opening > 0 && f.track) {
    tx.run(`UPDATE fuel_items SET stock_qty = ? WHERE id = ?`, opening, id);
    tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`, newId(), id, today(), 'received', opening, 'In stock when the item was added', ctx.user.id, nowIso());
  }
  tx.audit('create', 'fuel_item', id, B, { name: f.name, price: f.price, currency: f.currency, opening });
  try {
    return await tx.commit(idemKey(ctx), { id });
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'There is already an item with this name');
    throw e;
  }
}

export async function updateItem(ctx: Ctx) {
  requireBiz(ctx, B, 'catalog');
  const it = await first<any>(ctx.db, 'SELECT * FROM fuel_items WHERE id = ?', ctx.params.id);
  if (!it) throw new HttpError(404, 'Not found');
  const f = fields(ctx.body, it);
  if (f.name.toLowerCase() !== it.name.toLowerCase() && await first(ctx.db, 'SELECT id FROM fuel_items WHERE business_id = ? AND name = ?', B, f.name)) throw new HttpError(409, 'There is already an item with this name');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE fuel_items SET name = ?, category = ?, unit = ?, price = ?, currency = ?, track_stock = ?, reorder_level = ?, active = ? WHERE id = ?`,
    f.name, f.category, f.unit, f.price, f.currency, f.track, f.reorder, f.active, it.id);
  // Price changes are kept in the audit log (old and new); past sales keep the price they were sold at.
  tx.audit('update', 'fuel_item', it.id, B, { name: f.name, price: { from: `${it.price} ${it.currency}`, to: `${f.price} ${f.currency}` }, active: f.active });
  return tx.commit(idemKey(ctx), { id: it.id });
}

/** Stock coming in (a delivery) or a count correction (the real quantity counted). */
export async function changeStock(ctx: Ctx) {
  requireBiz(ctx, B, 'catalog');
  const it = await first<any>(ctx.db, 'SELECT * FROM fuel_items WHERE id = ?', ctx.params.id);
  if (!it) throw new HttpError(404, 'Not found');
  const date = entryDate(ctx.body.date);
  await assertDayOpen(ctx.db, B, date);
  const type = String(ctx.body.type);
  let delta: number, reason: string | null;
  if (type === 'received') {
    delta = qty(ctx.body.qty, 'Quantity received', { positive: true });
    reason = str(ctx.body.reason, 'Note', { max: 200 });
  } else if (type === 'count') {
    delta = round3(qty(ctx.body.counted, 'Quantity counted', { min: 0 }) - it.stock_qty);
    reason = str(ctx.body.reason, 'Reason', { max: 200 });
    if (delta === 0) throw bad('The count matches what the system has — nothing to change');
    if (!reason) throw bad('Give a reason for the difference (e.g. evaporation, leak, damaged, counted wrong)');
  } else throw bad('Choose received or count');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE fuel_items SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?', delta, it.id);
  tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`, newId(), it.id, date, type, delta, reason, ctx.user.id, nowIso());
  tx.audit(type === 'received' ? 'stock_received' : 'stock_count', 'fuel_item', it.id, B, { name: it.name, change: delta, reason });
  return tx.commit(idemKey(ctx), { id: it.id, stock: round3(it.stock_qty + delta), change: delta });
}

export async function stockLog(ctx: Ctx) {
  requireBiz(ctx, B, 'catalog');
  return all(ctx.db, `SELECT l.*, u.full_name AS created_by_name FROM fuel_stock_log l JOIN users u ON u.id = l.created_by WHERE l.item_id = ? ORDER BY l.created_at DESC LIMIT 100`, ctx.params.id);
}

/** Alerts for the owner: stock below zero (a delivery may be missing) or low. */
export async function itemAlerts(db: D1Database) {
  const rows = await all<any>(db, `SELECT name, unit, stock_qty, reorder_level FROM fuel_items WHERE business_id = 'fuel' AND active = 1 AND track_stock = 1 AND (stock_qty < 0 OR (reorder_level > 0 AND stock_qty <= reorder_level)) ORDER BY stock_qty`);
  return rows.map((r) => r.stock_qty < 0
    ? { level: 'red' as const, title: `${r.name} stock is below zero (${r.stock_qty} ${r.unit})`, detail: 'More was sold than the stock records show. A delivery may not be recorded, or a count is needed (Inventory).' }
    : { level: 'yellow' as const, title: `Low stock: ${r.name}`, detail: `${r.stock_qty} ${r.unit} left (warning at ${r.reorder_level}).` });
}
