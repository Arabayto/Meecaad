// Restaurant & Cafe only: tables and open orders (send now, pay later).
// Every endpoint here is fixed to the restaurant business.

import { prepareSale } from './ops';
import { HttpError, Tx, all, bad, bool, first, idemKey, newId, nowIso, placeholders, qty, requireBiz, str, today, type Ctx } from './lib';

const R = 'restaurant';

// ── Tables ──────────────────────────────────────────────────────
export async function listTables(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  return all(ctx.db, `SELECT t.*, o.id AS order_id, o.created_at AS order_since FROM restaurant_tables t
                      LEFT JOIN open_orders o ON o.table_id = t.id AND o.status = 'open'
                      WHERE t.business_id = 'restaurant' ORDER BY t.active DESC, t.sort, t.name`);
}

export async function createTable(ctx: Ctx) {
  requireBiz(ctx, R, 'catalog');
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO restaurant_tables (id, name, seats, sort, created_at) VALUES (?,?,?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM restaurant_tables), ?)`,
    id, str(ctx.body.name, 'Table name', { required: true, max: 40 }), Math.max(0, Math.round(Number(ctx.body.seats ?? 4)) || 0), nowIso());
  tx.audit('create', 'table', id, R, ctx.body);
  return tx.commit(idemKey(ctx), { id });
}

export async function updateTable(ctx: Ctx) {
  requireBiz(ctx, R, 'catalog');
  const t = await first<any>(ctx.db, `SELECT * FROM restaurant_tables WHERE id = ? AND business_id = 'restaurant'`, ctx.params.id);
  if (!t) throw new HttpError(404, 'Table not found');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE restaurant_tables SET name = ?, seats = ?, active = ? WHERE id = ?', str(ctx.body.name ?? t.name, 'Table name', { required: true, max: 40 }),
    Math.max(0, Math.round(Number(ctx.body.seats ?? t.seats)) || 0), ctx.body.active === undefined ? t.active : bool(ctx.body.active) ? 1 : 0, t.id);
  tx.audit('update', 'table', t.id, R, ctx.body);
  return tx.commit(null, { id: t.id });
}

// ── Open orders ─────────────────────────────────────────────────
async function orderItems(ctx: Ctx, list: unknown) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) throw bad('Add at least one item');
  const menu = await all<any>(ctx.db, `SELECT id, name FROM products WHERE business_id = 'restaurant' AND kind = 'menu' AND active = 1 AND id IN (${placeholders(items)})`,
    ...items.map((i: any) => String(i.product)));
  return items.map((i: any) => {
    const p = menu.find((m) => m.id === String(i.product));
    if (!p) throw bad('One of the items is not on the menu');
    return { product: p.id, qty: qty(i.qty, `Quantity of ${p.name}`, { positive: true }), note: str(i.note, 'Note', { max: 120 }) };
  });
}

async function openOrder(ctx: Ctx, id: string) {
  const o = await first<any>(ctx.db, `SELECT * FROM open_orders WHERE id = ? AND business_id = 'restaurant'`, id);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status !== 'open') throw new HttpError(409, o.status === 'paid' ? 'This order is already paid' : 'This order was cancelled');
  return o;
}

async function tableFree(ctx: Ctx, tableId: unknown, exceptOrder?: string) {
  if (!tableId) return null;
  const t = await first<any>(ctx.db, `SELECT * FROM restaurant_tables WHERE id = ? AND business_id = 'restaurant' AND active = 1`, String(tableId));
  if (!t) throw bad('Table not found');
  const busy = await first<any>(ctx.db, `SELECT id FROM open_orders WHERE table_id = ? AND status = 'open' AND id <> ?`, t.id, exceptOrder ?? '');
  if (busy) throw new HttpError(409, `${t.name} already has an open order. Add to that order instead.`);
  return t;
}

export async function listOrders(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  const orders = await all<any>(ctx.db, `SELECT o.*, t.name AS table_name, u.full_name AS created_by_name FROM open_orders o
    LEFT JOIN restaurant_tables t ON t.id = o.table_id JOIN users u ON u.id = o.created_by
    WHERE o.business_id = 'restaurant' AND o.status = 'open' ORDER BY o.created_at`);
  const items = orders.length ? await all<any>(ctx.db, `SELECT i.*, p.name, p.sale_price FROM open_order_items i JOIN products p ON p.id = i.product_id
    WHERE i.order_id IN (${placeholders(orders)}) ORDER BY i.rowid`, ...orders.map((o) => o.id)) : [];
  for (const o of orders) {
    o.items = items.filter((i) => i.order_id === o.id);
    o.total = o.items.reduce((s: number, i: any) => s + Math.round(i.qty * i.sale_price), 0);
  }
  return orders;
}

export async function createOrder(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  const items = await orderItems(ctx, ctx.body.items);
  const table = await tableFree(ctx, ctx.body.table);
  const label = str(ctx.body.label, 'Name', { max: 60 });   // optional: table or name; every order has a number
  const id = newId();
  const date = today();
  const tx = new Tx(ctx.db, ctx.user);
  // Order numbers restart every day (#1, #2, …) so they are easy to call out.
  tx.run(`INSERT INTO open_orders (id, table_id, label, note, order_date, number, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?, (SELECT COALESCE(MAX(number), 0) + 1 FROM open_orders WHERE business_id = 'restaurant' AND order_date = ?), ?,?,?)`,
    id, table?.id, label, str(ctx.body.note, 'Note', { max: 300 }), date, date, ctx.user.id, nowIso(), nowIso());
  for (const i of items) tx.run('INSERT INTO open_order_items (id, order_id, product_id, qty, note) VALUES (?,?,?,?,?)', newId(), id, i.product, i.qty, i.note);
  tx.audit('create', 'order', id, R, { table: table?.name, label, items: items.length });
  try {
    await tx.commit(idemKey(ctx), { id });
    return first(ctx.db, 'SELECT id, number FROM open_orders WHERE id = ?', id);
  } catch (e: any) {
    if (String(e?.message).includes('already exists')) throw new HttpError(409, 'That table already has an open order');
    throw e;
  }
}

/** Replace the items (and table/name/note) of an open order. */
export async function updateOrder(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  const o = await openOrder(ctx, ctx.params.id);
  const items = await orderItems(ctx, ctx.body.items);
  const table = ctx.body.table === undefined ? (o.table_id ? { id: o.table_id } : null) : await tableFree(ctx, ctx.body.table, o.id);
  const label = ctx.body.label === undefined ? o.label : str(ctx.body.label, 'Name', { max: 60 });
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE open_orders SET table_id = ?, label = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    table?.id ?? null, label, ctx.body.note === undefined ? o.note : str(ctx.body.note, 'Note', { max: 300 }), nowIso(), o.id);
  tx.run('DELETE FROM open_order_items WHERE order_id = ?', o.id);
  for (const i of items) tx.run('INSERT INTO open_order_items (id, order_id, product_id, qty, note) VALUES (?,?,?,?,?)', newId(), o.id, i.product, i.qty, i.note);
  tx.audit('update', 'order', o.id, R, { items: items.map((i) => [i.product, i.qty]) });
  return tx.commit(null, { id: o.id });
}

export async function cancelOrder(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  const o = await openOrder(ctx, ctx.params.id);
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE open_orders SET status = 'cancelled', cancel_reason = ?, closed_by = ?, closed_at = ? WHERE id = ? AND status = 'open'`, reason, ctx.user.id, nowIso(), o.id);
  tx.audit('cancel', 'order', o.id, R, { reason });
  return tx.commit(idemKey(ctx), { id: o.id });
}

/** Pay an open order: it becomes a normal sale, in the same atomic save. */
export async function payOrder(ctx: Ctx) {
  requireBiz(ctx, R, 'sell');
  const o = await openOrder(ctx, ctx.params.id);
  const items = await all<any>(ctx.db, 'SELECT product_id AS product, qty FROM open_order_items WHERE order_id = ?', o.id);
  const { tx, id } = await prepareSale(ctx, {
    ...ctx.body, business: R, items,
    note: [o.label, o.note, ctx.body.note].filter(Boolean).join(' · ') || null,
  });
  tx.run('INSERT INTO order_sales (order_id, sale_id) VALUES (?,?)', o.id, id);   // primary key: one payment per order
  tx.run(`UPDATE open_orders SET status = 'paid', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'open'`, ctx.user.id, nowIso(), o.id);
  try {
    return await tx.commit(idemKey(ctx), { id, order: o.id });
  } catch (e: any) {
    if (String(e?.message).includes('already exists')) throw new HttpError(409, 'This order is already paid');
    throw e;
  }
}
