// Fuel station inventory, kept like a normal shop's: diesel, petrol, oils, tools …
// Each item has a COST PRICE (what one unit costs us, US dollars, kept as a running
// average) and a SELLING PRICE (US dollars or Somaliland Shillings) that the sales
// team sells at. Receiving stock records what it cost and how it was paid (now, or
// owed to a supplier); each sale counts its cost; counts correct the quantity.
// Every change is in the stock log and in the books (inventory account).

import { HttpError, Tx, all, assertDayOpen, bad, bizScope, bool, can, cents, entryDate, first, idemKey, newId, nowIso, partyIn, paymentMethod, qty, requireBiz, round3, str, today, type Ctx } from './lib';

const B = 'fuel';
const CURRENCIES = ['USD', 'SLSH'];

/** Selling price in the item's own money: cents for USD, whole shillings for SLSH. */
function sellingPrice(v: unknown, currency: string) {
  if (currency === 'USD') return cents(v, 'Selling price', { min: 1 });
  const n = Math.round(Number(String(v ?? '').replace(/,/g, '')));
  if (!Number.isFinite(n) || n < 1 || n > 1e9) throw bad('Enter the selling price in Shillings (for example 15,000)');
  return n;
}
/** Cost price per unit, US cents (may have fractions of a cent, e.g. $0.955 a litre). */
function costPrice(v: unknown, name = 'Cost price') {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e11) throw bad(`${name} must be a number of cents, 0 or more`);
  return Math.round(n * 1000) / 1000;
}

export async function listItems(ctx: Ctx) {
  bizScope(ctx, B);
  const manage = can(ctx.user, 'stock', B);
  return all(ctx.db, `SELECT i.*, ROUND(i.stock_qty * i.cost_price) AS stock_value,
      (SELECT COALESCE(SUM(-l.qty), 0) FROM fuel_stock_log l WHERE l.item_id = i.id AND l.type IN ('sale', 'sale_void') AND l.entry_date >= ?) AS sold_30d
    FROM fuel_items i WHERE i.business_id = ? ${manage ? '' : 'AND i.active = 1'} ORDER BY i.active DESC, i.category, i.name`, today(-30), B);
}

function fields(b: any, existing?: any) {
  const name = str(b.name ?? existing?.name, 'Name', { required: true, max: 80 })!;
  const currency = String(b.currency ?? existing?.currency ?? 'USD');
  if (!CURRENCIES.includes(currency)) throw bad('Choose US dollars or Somaliland Shillings for the selling price');
  return {
    name, currency,
    category: str(b.category ?? existing?.category, 'Category', { max: 40 }) ?? '',
    unit: str(b.unit ?? existing?.unit, 'Unit', { max: 20 }) ?? 'pcs',
    price: b.price === undefined && existing && currency === existing.currency ? existing.price : sellingPrice(b.price, currency),
    cost: b.costPrice === undefined ? (existing?.cost_price ?? 0) : costPrice(b.costPrice),
    track: b.trackStock === undefined ? (existing?.track_stock ?? 1) : bool(b.trackStock) ? 1 : 0,
    reorder: b.reorderLevel === undefined ? (existing?.reorder_level ?? 0) : qty(b.reorderLevel, 'Low-stock level', { min: 0 }),
    active: b.active === undefined ? (existing?.active ?? 1) : bool(b.active) ? 1 : 0,
  };
}

const logRow = (tx: Tx, r: { item: string; date: string; type: string; qty: number; unitCost?: number; value?: number; reason?: string | null; supplier?: string | null; method?: string | null; ref?: string | null; user: string }) =>
  tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, unit_cost, value, reason, supplier_id, method_id, ref_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId(), r.item, r.date, r.type, r.qty, r.unitCost ?? null, r.value ?? null, r.reason ?? null, r.supplier ?? null, r.method ?? null, r.ref ?? null, r.user, nowIso());

export async function createItem(ctx: Ctx) {
  requireBiz(ctx, B, 'stock');
  const f = fields(ctx.body);
  if (await first(ctx.db, 'SELECT id FROM fuel_items WHERE business_id = ? AND name = ?', B, f.name)) throw new HttpError(409, 'There is already an item with this name');
  const id = newId();
  const date = today();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO fuel_items (id, business_id, name, category, unit, price, currency, cost_price, track_stock, reorder_level, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, B, f.name, f.category, f.unit, f.price, f.currency, f.cost, f.track, f.reorder, f.active, ctx.user.id, nowIso());
  const opening = ctx.body.openingQty === undefined || ctx.body.openingQty === '' ? 0 : qty(ctx.body.openingQty, 'Quantity in stock now', { min: 0 });
  if (opening > 0 && f.track) {
    const value = Math.round(opening * f.cost);
    tx.run(`UPDATE fuel_items SET stock_qty = ? WHERE id = ?`, opening, id);
    logRow(tx, { item: id, date, type: 'received', qty: opening, unitCost: f.cost, value, reason: 'In stock when the item was added', user: ctx.user.id });
    // Stock already on hand when the system started: its value goes into the books as opening stock.
    tx.journal({ business: B, date, type: 'opening_stock', refType: 'fuel_item', refId: id, memo: `Opening stock: ${opening} ${f.unit} ${f.name}`, amount: value },
      [{ account: 'inventory', amount: value }, { account: 'owner', amount: -value }]);
  }
  tx.audit('create', 'fuel_item', id, B, { name: f.name, cost: f.cost, price: f.price, currency: f.currency, opening });
  try {
    return await tx.commit(idemKey(ctx), { id });
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'There is already an item with this name');
    throw e;
  }
}

export async function updateItem(ctx: Ctx) {
  requireBiz(ctx, B, 'stock');
  const it = await first<any>(ctx.db, 'SELECT * FROM fuel_items WHERE id = ?', ctx.params.id);
  if (!it) throw new HttpError(404, 'Not found');
  const f = fields(ctx.body, it);
  if (f.name.toLowerCase() !== it.name.toLowerCase() && await first(ctx.db, 'SELECT id FROM fuel_items WHERE business_id = ? AND name = ?', B, f.name)) throw new HttpError(409, 'There is already an item with this name');
  const date = today();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE fuel_items SET name = ?, category = ?, unit = ?, price = ?, currency = ?, cost_price = ?, track_stock = ?, reorder_level = ?, active = ? WHERE id = ?`,
    f.name, f.category, f.unit, f.price, f.currency, f.cost, f.track, f.reorder, f.active, it.id);
  // Correcting the cost price of stock already on hand changes what that stock is worth in the books.
  const revalue = Math.round(it.stock_qty * f.cost) - Math.round(it.stock_qty * it.cost_price);
  if (f.cost !== it.cost_price && revalue !== 0 && !it.cost_price) {
    // Stock that never had a cost (added before costs were kept) goes into the books as opening stock, not as a gain.
    await assertDayOpen(ctx.db, B, date);
    tx.journal({ business: B, date, type: 'opening_stock', refType: 'fuel_item', refId: it.id, amount: Math.abs(revalue),
      memo: `Opening stock: ${it.stock_qty} ${it.unit} ${it.name} at ${(f.cost / 100).toFixed(3)}` },
      [{ account: 'inventory', amount: revalue }, { account: 'owner', amount: -revalue }]);
  } else if (f.cost !== it.cost_price && revalue !== 0) {
    await assertDayOpen(ctx.db, B, date);
    tx.journal({ business: B, date, type: 'stock_adjustment', refType: 'fuel_item', refId: it.id, amount: Math.abs(revalue),
      memo: `Cost price of ${it.name} corrected: ${(it.cost_price / 100).toFixed(3)} → ${(f.cost / 100).toFixed(3)} per ${it.unit} (${it.stock_qty} ${it.unit} in stock)` },
      [{ account: 'inventory', amount: revalue }, { account: 'stock_loss', amount: -revalue, category: 'Cost price correction' }]);
  }
  // Price changes are kept in the audit log; past sales keep the prices they were sold at.
  tx.audit('update', 'fuel_item', it.id, B, { name: f.name, cost: { from: it.cost_price, to: f.cost }, price: { from: `${it.price} ${it.currency}`, to: `${f.price} ${f.currency}` }, active: f.active });
  return tx.commit(idemKey(ctx), { id: it.id });
}

/**
 * Stock coming in (received: what it cost and how it was paid — now, or owed to
 * a supplier), or a count correction (the real quantity counted, with a reason).
 */
export async function changeStock(ctx: Ctx) {
  requireBiz(ctx, B, 'stock');
  const it = await first<any>(ctx.db, 'SELECT * FROM fuel_items WHERE id = ?', ctx.params.id);
  if (!it) throw new HttpError(404, 'Not found');
  const date = entryDate(ctx.body.date);
  await assertDayOpen(ctx.db, B, date);
  const type = String(ctx.body.type);
  const tx = new Tx(ctx.db, ctx.user);
  const logId = newId();
  if (type === 'received') {
    const q = qty(ctx.body.qty, 'Quantity received', { positive: true });
    const unitCost = ctx.body.unitCost === undefined || ctx.body.unitCost === '' ? it.cost_price : costPrice(ctx.body.unitCost, 'Cost per unit');
    const total = Math.round(q * unitCost);
    const supplier = ctx.body.supplier ? await partyIn(ctx.db, 'supplier', ctx.body.supplier, B) : null;
    const method = ctx.body.method ? await paymentMethod(ctx.db, ctx.body.method) : null;
    if (total > 0 && !method && !supplier) throw bad('Say how it was paid (Cash, Zaad, Edahab) or which supplier it is owed to');
    const note = str(ctx.body.reason, 'Note', { max: 200 });
    // New average cost (as a shop does): what is in stock and what came in, together.
    const before = Math.max(it.stock_qty, 0);
    const avg = before + q > 0.0005 ? (before * it.cost_price + total) / (before + q) : unitCost;
    tx.run('UPDATE fuel_items SET stock_qty = ROUND(stock_qty + ?, 3), cost_price = ? WHERE id = ?', q, Math.round(avg * 1e6) / 1e6, it.id);
    tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, unit_cost, value, reason, supplier_id, method_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      logId, it.id, date, 'received', q, unitCost, total, note, supplier?.id ?? null, method, ctx.user.id, nowIso());
    tx.journal({ business: B, date, type: 'fuel_stock_in', refType: 'fuel_stock', refId: logId, amount: total,
      memo: `Stock received: ${q} ${it.unit} ${it.name}${supplier ? ` from ${supplier.name}` : ''}${method ? '' : supplier ? ' (owed)' : ''}${note ? ` — ${note}` : ''}` },
      [{ account: 'inventory', amount: total }, method ? { account: 'cash', amount: -total, method } : { account: 'payable', amount: -total, supplier: supplier?.id ?? null }]);
    tx.audit('stock_received', 'fuel_item', it.id, B, { name: it.name, qty: q, unitCost, total, paid: method ?? 'owed', supplier: supplier?.name });
    return tx.commit(idemKey(ctx), { id: it.id, stock: round3(it.stock_qty + q), total });
  }
  if (type === 'count') {
    const delta = round3(qty(ctx.body.counted, 'Quantity counted', { min: 0 }) - it.stock_qty);
    const reason = str(ctx.body.reason, 'Reason', { max: 200 });
    if (delta === 0) throw bad('The count matches what the system has — nothing to change');
    if (!reason) throw bad('Give a reason for the difference (e.g. evaporation, leak, damaged, counted wrong)');
    const value = Math.round(delta * it.cost_price);
    tx.run('UPDATE fuel_items SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?', delta, it.id);
    tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, unit_cost, value, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      logId, it.id, date, 'count', delta, it.cost_price, value, reason, ctx.user.id, nowIso());
    tx.journal({ business: B, date, type: 'stock_adjustment', refType: 'fuel_stock', refId: logId, amount: Math.abs(value),
      memo: `Stock count ${it.name}: ${delta > 0 ? '+' : ''}${delta} ${it.unit} — ${reason}` },
      [{ account: 'inventory', amount: value }, { account: 'stock_loss', amount: -value, category: 'Fuel station stock count' }]);
    tx.audit('stock_count', 'fuel_item', it.id, B, { name: it.name, change: delta, value, reason });
    return tx.commit(idemKey(ctx), { id: it.id, stock: round3(it.stock_qty + delta), change: delta });
  }
  throw bad('Choose received or count');
}

export async function stockLog(ctx: Ctx) {
  requireBiz(ctx, B, 'stock');
  return all(ctx.db, `SELECT l.*, u.full_name AS created_by_name, s.name AS supplier_name, pm.name AS method_name FROM fuel_stock_log l JOIN users u ON u.id = l.created_by
    LEFT JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN payment_methods pm ON pm.id = l.method_id WHERE l.item_id = ? ORDER BY l.created_at DESC LIMIT 100`, ctx.params.id);
}

/** Alerts for the owner: stock below zero (a delivery may be missing) or low. */
export async function itemAlerts(db: D1Database) {
  const rows = await all<any>(db, `SELECT name, unit, stock_qty, reorder_level FROM fuel_items WHERE business_id = 'fuel' AND active = 1 AND track_stock = 1 AND (stock_qty < 0 OR (reorder_level > 0 AND stock_qty <= reorder_level)) ORDER BY stock_qty`);
  return rows.map((r) => r.stock_qty < 0
    ? { level: 'red' as const, title: `${r.name} stock is below zero (${r.stock_qty} ${r.unit})`, detail: 'More was sold than the stock records show. A delivery may not be recorded, or a count is needed (Inventory).' }
    : { level: 'yellow' as const, title: `Low stock: ${r.name}`, detail: `${r.stock_qty} ${r.unit} left (warning at ${r.reorder_level}).` });
}

// ── Expense categories (registered in advance) ──────────────────
export async function listCategories(ctx: Ctx) {
  const business = String(ctx.url.searchParams.get('business') ?? '');
  bizScope(ctx, business);
  return all(ctx.db, `SELECT * FROM expense_categories WHERE business_id = ? ${can(ctx.user, 'catalog', business) ? '' : 'AND active = 1'} ORDER BY active DESC, name`, business);
}

export async function createCategory(ctx: Ctx) {
  const business = requireBiz(ctx, ctx.body.business, 'catalog');
  const name = str(ctx.body.name, 'Category name', { required: true, max: 60 })!;
  if (await first(ctx.db, 'SELECT id FROM expense_categories WHERE business_id = ? AND name = ?', business, name)) throw new HttpError(409, 'This category already exists');
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO expense_categories (id, business_id, name, created_by, created_at) VALUES (?,?,?,?,?)', id, business, name, ctx.user.id, nowIso());
  tx.audit('create', 'expense_category', id, business, { name });
  return tx.commit(idemKey(ctx), { id });
}

export async function updateCategory(ctx: Ctx) {
  const c = await first<any>(ctx.db, 'SELECT * FROM expense_categories WHERE id = ?', ctx.params.id);
  if (!c) throw new HttpError(404, 'Not found');
  requireBiz(ctx, c.business_id, 'catalog');
  const name = str(ctx.body.name ?? c.name, 'Category name', { required: true, max: 60 })!;
  if (name.toLowerCase() !== c.name.toLowerCase() && await first(ctx.db, 'SELECT id FROM expense_categories WHERE business_id = ? AND name = ?', c.business_id, name)) throw new HttpError(409, 'This category already exists');
  const active = ctx.body.active === undefined ? c.active : bool(ctx.body.active) ? 1 : 0;
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE expense_categories SET name = ?, active = ? WHERE id = ?', name, active, c.id);
  tx.audit('update', 'expense_category', c.id, c.business_id, { name, active });
  return tx.commit(idemKey(ctx), { id: c.id });
}
