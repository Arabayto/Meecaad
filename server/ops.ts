// Sales, returns, purchases, expenses and money movements.
// Every operation is one atomic batch: the record, its stock movements, its
// balanced journal entry and its audit row are saved together or not at all.

import {
  HttpError, Tx, all, assertDayOpen, bad, bizScope, cents, entryDate, first, idemKey, newId, nowIso, paymentMethod, placeholders,
  partyIn, qty, requireBiz, round3, str, today, type Ctx, type Line,
} from './lib';
import { assertShiftCurrent } from './shifts';

/** Weighted-average cost update, run before stock is added (or removed with negative qty). */
const REPRICE = `UPDATE products SET avg_cost = CASE
    WHEN MAX(stock_qty, 0) + ? > 0.0005 THEN MAX((MAX(stock_qty, 0) * avg_cost + ?) / (MAX(stock_qty, 0) + ?), 0)
    ELSE avg_cost END WHERE id = ?`;

async function customerBalance(db: D1Database, business: string, customer: string) {
  const r = await first<{ b: number }>(db, `SELECT COALESCE(SUM(balance), 0) AS b FROM account_balances WHERE business_id = ? AND account = 'receivable' AND method_id = '' AND customer_id = ?`, business, customer);
  return r?.b ?? 0;
}
async function supplierBalance(db: D1Database, business: string, supplier: string) {
  const r = await first<{ b: number }>(db, `SELECT COALESCE(-SUM(balance), 0) AS b FROM account_balances WHERE business_id = ? AND account = 'payable' AND method_id = '' AND customer_id = '' AND supplier_id = ?`, business, supplier);
  return r?.b ?? 0;
}

function dateRange(ctx: Ctx) {
  const from = ctx.url.searchParams.get('from') || today(-30);
  const to = ctx.url.searchParams.get('to') || today();
  return { from, to };
}

// ── Sales ───────────────────────────────────────────────────────
export async function createSale(ctx: Ctx) {
  const { tx, id } = await prepareSale(ctx, ctx.body);
  return tx.commit(idemKey(ctx), { id });
}

/**
 * Validates a sale and collects all its statements in one Tx (not yet saved),
 * so callers like "pay an open order" can add their own statements to the
 * same atomic batch.
 */
export async function prepareSale(ctx: Ctx, b: any) {
  const business = requireBiz(ctx, b.business, 'sell');
  if (business === 'fuel') throw bad('Fuel sales are recorded from pump meter readings');
  const date = entryDate(b.date);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw bad('Add at least one item');
  const products = await all<any>(ctx.db, `SELECT * FROM products WHERE business_id = ? AND active = 1 AND kind IN ('menu', 'item') AND id IN (${placeholders(items)})`,
    business, ...items.map((i: any) => String(i.product)));
  const lines = items.map((i: any) => {
    const p = products.find((x) => x.id === String(i.product));
    if (!p) throw bad('One of the items is not available for sale');
    const q = qty(i.qty, `Quantity of ${p.name}`, { positive: true });
    const unitCost = p.track_stock ? p.avg_cost : 0;
    return { id: newId(), p, qty: q, price: p.sale_price, total: Math.round(q * p.sale_price), unitCost, cost: Math.round(q * unitCost) };
  });
  const subtotal = lines.reduce((s: number, l: any) => s + l.total, 0);
  const discount = cents(b.discount ?? 0, 'Discount');
  if (discount > subtotal) throw bad('Discount is more than the sale');
  const total = subtotal - discount;
  const payments: { method: string; amount: number }[] = [];
  for (const pay of Array.isArray(b.payments) ? b.payments : []) {
    const amount = cents(pay.amount, 'Payment amount');
    if (amount > 0) payments.push({ method: await paymentMethod(ctx.db, pay.method), amount });
  }
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid > total) throw bad('Payments are more than the sale total. Enter only the amount kept (give the change back).');
  const credit = total - paid;
  const customer = await partyIn(ctx.db, 'customer', b.customer, business);
  if (credit > 0 && !customer) throw bad(`Choose the customer who owes the unpaid ${(credit / 100).toFixed(2)}`);
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  // Cost of goods = exactly what leaves stock (stock-counted items; the restaurant counts none), so inventory and the journal agree.
  const stockOut = lines.reduce((s: number, l: any) => s + l.cost, 0);

  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO sales (id, business_id, number, entry_date, customer_id, subtotal, discount, total, paid_amount, credit_amount, cost_total, note, created_by, created_at)
          VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM sales WHERE business_id = ?), ?,?,?,?,?,?,?,?,?,?,?)`,
    id, business, business, date, customer?.id, subtotal, discount, total, paid, credit, stockOut, str(b.note, 'Note', { max: 300 }), ctx.user.id, nowIso());
  for (const l of lines) {
    tx.run('INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price, unit_cost, line_total) VALUES (?,?,?,?,?,?,?,?)',
      l.id, id, l.p.id, l.p.name, l.qty, l.price, l.unitCost, l.total);
    if (l.p.track_stock) tx.stock({ business, product: l.p.id, date, type: 'sale', qty: -l.qty, unitCost: l.p.avg_cost, value: -l.cost, refType: 'sale', refId: id });
  }
  for (const p of payments) tx.run('INSERT INTO sale_payments (id, sale_id, method_id, amount) VALUES (?,?,?,?)', newId(), id, p.method, p.amount);
  const memo = `Sale${customer ? ` to ${customer.name}` : ''}: ${lines.map((l: any) => `${l.qty} × ${l.p.name}`).join(', ')}`.slice(0, 300);
  tx.journal({ business, date, type: 'sale', refType: 'sale', refId: id, memo, amount: total }, [
    { account: 'sales', amount: -total },
    ...payments.map((p): Line => ({ account: 'cash', amount: p.amount, method: p.method })),
    { account: 'receivable', amount: credit, customer: customer?.id },
    { account: 'cogs', amount: stockOut },
    { account: 'inventory', amount: -stockOut },
  ]);
  tx.audit('create', 'sale', id, business, { total, paid, credit, items: lines.length });
  return { tx, id, business, total };
}

export async function listSales(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const { from, to } = dateRange(ctx);
  const q = ctx.url.searchParams.get('q');
  const number = Number(q);
  return all(ctx.db,
    `SELECT s.*, c.name AS customer_name, u.full_name AS created_by_name,
            (SELECT GROUP_CONCAT(pm.name || ' ' || printf('%.2f', sp.amount / 100.0), ', ') FROM sale_payments sp JOIN payment_methods pm ON pm.id = sp.method_id WHERE sp.sale_id = s.id) AS payments_text
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.created_by
     WHERE s.business_id IN (${placeholders(scope)}) AND s.entry_date BETWEEN ? AND ?
       ${q ? `AND (c.name LIKE ? OR s.number = ? OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.name LIKE ?))` : ''}
     ORDER BY s.created_at DESC LIMIT 500`,
    ...scope, from, to, ...(q ? [`%${q}%`, Number.isInteger(number) ? number : -1, `%${q}%`] : []));
}

export async function getSale(ctx: Ctx) {
  const s = await first<any>(ctx.db,
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, b.name AS business_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
     FROM sales s JOIN businesses b ON b.id = s.business_id LEFT JOIN customers c ON c.id = s.customer_id
     JOIN users u ON u.id = s.created_by LEFT JOIN users v ON v.id = s.voided_by WHERE s.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Sale not found');
  bizScope(ctx, s.business_id);
  const [items, payments, returns] = await Promise.all([
    all(ctx.db, 'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid', s.id),
    all(ctx.db, 'SELECT sp.*, pm.name AS method_name FROM sale_payments sp JOIN payment_methods pm ON pm.id = sp.method_id WHERE sale_id = ?', s.id),
    all(ctx.db, `SELECT r.*, pm.name AS refund_method_name, u.full_name AS created_by_name FROM sale_returns r LEFT JOIN payment_methods pm ON pm.id = r.refund_method_id
                 JOIN users u ON u.id = r.created_by WHERE sale_id = ? ORDER BY r.created_at`, s.id),
  ]);
  return { ...s, items, payments, returns };
}

export async function voidSale(ctx: Ctx) {
  const s = await first<any>(ctx.db, 'SELECT * FROM sales WHERE id = ?', ctx.params.id);
  if (!s) throw new HttpError(404, 'Sale not found');
  const business = requireBiz(ctx, s.business_id, 'void');
  if (s.status !== 'completed') throw new HttpError(409, 'This sale is already cancelled');
  if (s.returned_amount > 0) throw new HttpError(409, 'This sale has returns. Return the remaining items instead of cancelling.');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE sales SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), s.id);
  for (const i of await all<any>(ctx.db, `SELECT si.*, p.track_stock FROM sale_items si JOIN products p ON p.id = si.product_id WHERE sale_id = ?`, s.id)) {
    if (!i.track_stock) continue;
    const value = Math.round(i.qty * i.unit_cost);
    tx.run(REPRICE, i.qty, value, i.qty, i.product_id);
    tx.stock({ business, product: i.product_id, date, type: 'sale_void', qty: i.qty, unitCost: i.unit_cost, value, refType: 'sale', refId: s.id, reason });
  }
  await tx.reverse('sale', s.id, date, 'sale_void', `Cancelled sale #${s.number}: ${reason}`);
  tx.audit('void', 'sale', s.id, business, { reason, total: s.total });
  return tx.commit(idemKey(ctx), { id: s.id });
}

export async function returnSale(ctx: Ctx) {
  const s = await first<any>(ctx.db, 'SELECT * FROM sales WHERE id = ?', ctx.params.id);
  if (!s) throw new HttpError(404, 'Sale not found');
  const business = requireBiz(ctx, s.business_id, 'void');
  if (s.status !== 'completed') throw new HttpError(409, 'This sale is cancelled');
  const b = ctx.body;
  const reason = str(b.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const saleItems = await all<any>(ctx.db, `SELECT si.*, p.track_stock FROM sale_items si JOIN products p ON p.id = si.product_id WHERE sale_id = ?`, s.id);
  const factor = s.subtotal > 0 ? s.total / s.subtotal : 0;   // share of each line after the sale discount
  const chosen = (Array.isArray(b.items) ? b.items : []).map((r: any) => {
    const si = saleItems.find((x) => x.id === String(r.saleItem));
    if (!si) throw bad('Item is not on this sale');
    const q = qty(r.qty, `Quantity of ${si.name}`, { positive: true });
    if (q > round3(si.qty - si.returned_qty)) throw bad(`Only ${round3(si.qty - si.returned_qty)} of ${si.name} can be returned`);
    const full = round3(si.returned_qty + q) >= si.qty;
    // The last unit returned takes whatever is left of the line, so rounding never leaves cents behind.
    const already = Math.round(si.line_total * factor * (si.returned_qty / si.qty));
    const amount = full ? Math.round(si.line_total * factor) - already : Math.round(si.line_total * factor * (q / si.qty));
    // Only stock-counted items can go back on the shelf.
    return { si, qty: q, amount, cost: si.track_stock ? Math.round(q * si.unit_cost) : 0 };
  });
  if (!chosen.length) throw bad('Choose the items being returned');
  const amount = chosen.reduce((t: number, c: any) => t + c.amount, 0);
  if (amount <= 0) throw bad('Nothing to refund');
  if (amount > s.total - s.returned_amount) throw bad('Refund is more than what is left on the sale');
  const toDebt = !b.refundMethod;
  const method = toDebt ? null : await paymentMethod(ctx.db, b.refundMethod, 'Refund method');
  if (toDebt) {
    if (!s.customer_id) throw bad('Choose how the money is refunded');
    if (amount > await customerBalance(ctx.db, business, s.customer_id)) throw bad('The refund is more than the customer owes. Refund it in cash or mobile money.');
  }
  const restock = b.restock !== false;
  const cost = restock ? chosen.reduce((t: number, c: any) => t + c.cost, 0) : 0;

  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO sale_returns (id, sale_id, business_id, entry_date, amount, refund_method_id, restock, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, s.id, business, date, amount, method, restock ? 1 : 0, reason, ctx.user.id, nowIso());
  for (const c of chosen) {
    tx.run('INSERT INTO sale_return_items (id, return_id, sale_item_id, qty, amount) VALUES (?,?,?,?,?)', newId(), id, c.si.id, c.qty, c.amount);
    tx.run('UPDATE sale_items SET returned_qty = ROUND(returned_qty + ?, 3) WHERE id = ?', c.qty, c.si.id);
    if (restock && c.si.track_stock) {
      tx.run(REPRICE, c.qty, c.cost, c.qty, c.si.product_id);
      tx.stock({ business, product: c.si.product_id, date, type: 'sale_return', qty: c.qty, unitCost: c.si.unit_cost, value: c.cost, refType: 'sale_return', refId: id, reason });
    }
  }
  tx.run('UPDATE sales SET returned_amount = returned_amount + ? WHERE id = ?', amount, s.id);
  tx.journal({ business, date, type: 'sale_return', refType: 'sale_return', refId: id, memo: `Return on sale #${s.number}: ${reason}`, amount: -amount }, [
    { account: 'sales', amount },
    toDebt ? { account: 'receivable', amount: -amount, customer: s.customer_id } : { account: 'cash', amount: -amount, method },
    { account: 'inventory', amount: cost },
    { account: 'cogs', amount: -cost },
  ]);
  tx.audit('return', 'sale', s.id, business, { returnId: id, amount, reason, restock });
  return tx.commit(idemKey(ctx), { id, amount });
}

// ── Purchases ───────────────────────────────────────────────────
export async function createPurchase(ctx: Ctx) {
  const b = ctx.body;
  const business = requireBiz(ctx, b.business, 'purchase');
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw bad('Add at least one item');
  const products = await all<any>(ctx.db, `SELECT * FROM products WHERE business_id = ? AND track_stock = 1 AND id IN (${placeholders(items)})`,
    business, ...items.map((i: any) => String(i.product)));
  const tanks = business === 'fuel' ? await all<any>(ctx.db, 'SELECT * FROM fuel_tanks WHERE active = 1') : [];
  const lines = items.map((i: any) => {
    const p = products.find((x) => x.id === String(i.product));
    if (!p) throw bad('One of the items is not a stocked product of this business');
    let tank = null;
    if (p.kind === 'fuel') {
      tank = tanks.find((t) => t.id === String(i.tank) && t.product_id === p.id);
      if (!tank) throw bad(`Choose the ${p.name} tank receiving the delivery`);
    }
    return { p, tank, qty: qty(i.qty, `Quantity of ${p.name}`, { positive: true }), total: cents(i.total, `Cost of ${p.name}`) };
  });
  const total = lines.reduce((s: number, l: any) => s + l.total, 0);
  const paid = cents(b.paid ?? 0, 'Amount paid');
  if (paid > total) throw bad('Amount paid is more than the purchase total');
  const method = paid > 0 ? await paymentMethod(ctx.db, b.method) : null;
  const supplier = await partyIn(ctx.db, 'supplier', b.supplier, business);
  if (paid < total && !supplier) throw bad('Choose the supplier for the unpaid amount');

  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO purchases (id, business_id, number, entry_date, supplier_id, invoice_ref, total, paid_amount, method_id, note, created_by, created_at)
          VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM purchases WHERE business_id = ?), ?,?,?,?,?,?,?,?,?)`,
    id, business, business, date, supplier?.id, str(b.invoiceRef, 'Invoice number', { max: 60 }), total, paid, method, str(b.note, 'Note', { max: 300 }), ctx.user.id, nowIso());
  for (const l of lines) {
    tx.run('INSERT INTO purchase_items (id, purchase_id, product_id, tank_id, qty, line_total) VALUES (?,?,?,?,?,?)', newId(), id, l.p.id, l.tank?.id, l.qty, l.total);
    tx.run(REPRICE, l.qty, l.total, l.qty, l.p.id);
    tx.stock({ business, product: l.p.id, tank: l.tank?.id, date, type: 'purchase', qty: l.qty, unitCost: l.total / l.qty, value: l.total, refType: 'purchase', refId: id });
  }
  const memo = `${business === 'fuel' ? 'Fuel delivery' : 'Purchase'}${supplier ? ` from ${supplier.name}` : ''}: ${lines.map((l: any) => `${l.qty} ${l.p.unit} ${l.p.name}`).join(', ')}`.slice(0, 300);
  tx.journal({ business, date, type: 'purchase', refType: 'purchase', refId: id, memo, amount: total }, [
    { account: 'inventory', amount: total },
    { account: 'cash', amount: -paid, method },
    { account: 'payable', amount: -(total - paid), supplier: supplier?.id },
  ]);
  tx.audit('create', 'purchase', id, business, { total, paid, supplier: supplier?.name });
  return tx.commit(idemKey(ctx), { id });
}

export async function listPurchases(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'), 'purchase');
  const { from, to } = dateRange(ctx);
  return all(ctx.db,
    `SELECT pu.*, s.name AS supplier_name, pm.name AS method_name, u.full_name AS created_by_name,
            (SELECT GROUP_CONCAT(pi.qty || ' ' || p.unit || ' ' || p.name, ', ') FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = pu.id) AS items_text
     FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN payment_methods pm ON pm.id = pu.method_id JOIN users u ON u.id = pu.created_by
     WHERE pu.business_id IN (${placeholders(scope)}) AND pu.entry_date BETWEEN ? AND ? ORDER BY pu.created_at DESC LIMIT 500`, ...scope, from, to);
}

export async function voidPurchase(ctx: Ctx) {
  const pu = await first<any>(ctx.db, 'SELECT * FROM purchases WHERE id = ?', ctx.params.id);
  if (!pu) throw new HttpError(404, 'Purchase not found');
  const business = requireBiz(ctx, pu.business_id, 'void');
  if (pu.status !== 'completed') throw new HttpError(409, 'This purchase is already cancelled');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE purchases SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), pu.id);
  for (const i of await all<any>(ctx.db, 'SELECT * FROM purchase_items WHERE purchase_id = ?', pu.id)) {
    tx.run(REPRICE, -i.qty, -i.line_total, -i.qty, i.product_id);
    tx.stock({ business, product: i.product_id, tank: i.tank_id, date, type: 'purchase_void', qty: -i.qty, unitCost: i.line_total / i.qty, value: -i.line_total, refType: 'purchase', refId: pu.id, reason });
  }
  await tx.reverse('purchase', pu.id, date, 'purchase_void', `Cancelled purchase #${pu.number}: ${reason}`);
  tx.audit('void', 'purchase', pu.id, business, { reason, total: pu.total });
  return tx.commit(idemKey(ctx), { id: pu.id });
}

// ── Expenses ────────────────────────────────────────────────────
export async function createExpense(ctx: Ctx) {
  const { business, date } = await expenseHead(ctx);
  const tx = new Tx(ctx.db, ctx.user);
  const id = await addExpense(ctx, tx, business, date, ctx.body);
  return tx.commit(idemKey(ctx), { id });
}

/** Several expenses in one go (e.g. the day's bills): all saved together, or none. */
export async function createExpenses(ctx: Ctx) {
  const { business, date } = await expenseHead(ctx);
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) throw bad('Add at least one expense');
  if (items.length > 50) throw bad('Save at most 50 expenses at a time');
  const tx = new Tx(ctx.db, ctx.user);
  const ids: string[] = [];
  for (const [i, item] of items.entries()) {
    try { ids.push(await addExpense(ctx, tx, business, date, item)); }
    catch (e: any) { if (e instanceof HttpError) throw new HttpError(e.status, `Row ${i + 1}: ${e.message}`); throw e; }
  }
  return tx.commit(idemKey(ctx), { ids });
}

async function expenseHead(ctx: Ctx) {
  const business = requireBiz(ctx, ctx.body.business, 'expense');
  const date = entryDate(ctx.body.date);
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  return { business, date };
}

/** Validates one expense and adds it (record, journal entry, audit) to the batch. */
async function addExpense(ctx: Ctx, tx: Tx, business: string, date: string, b: any) {
  const amount = cents(b.amount, 'Amount', { min: 1 });
  const category = str(b.category, 'Category', { required: true, max: 60 })!;
  const method = b.method ? await paymentMethod(ctx.db, b.method) : null;
  if (!method && business === 'restaurant') throw bad('Restaurant expenses are recorded when they are paid: choose how it was paid');
  const supplier = await partyIn(ctx.db, 'supplier', b.supplier, business);
  if (!method && !supplier) throw bad('Choose how it was paid, or the supplier it is owed to');
  const description = str(b.description, 'Description', { max: 300 });
  const id = newId();
  tx.run(`INSERT INTO expenses (id, business_id, entry_date, category, description, amount, method_id, supplier_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, business, date, category, description, amount, method, supplier?.id, ctx.user.id, nowIso());
  tx.journal({ business, date, type: 'expense', refType: 'expense', refId: id, memo: `Expense: ${category}${description ? ` — ${description}` : ''}${method ? '' : ` (owed to ${supplier!.name})`}`, amount }, [
    { account: 'expense', amount, category },
    method ? { account: 'cash', amount: -amount, method } : { account: 'payable', amount: -amount, supplier: supplier!.id },
  ]);
  tx.audit('create', 'expense', id, business, { amount, category });
  return id;
}

export async function listExpenses(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'), 'expense');
  const { from, to } = dateRange(ctx);
  return all(ctx.db,
    `SELECT e.*, pm.name AS method_name, s.name AS supplier_name, u.full_name AS created_by_name
     FROM expenses e LEFT JOIN payment_methods pm ON pm.id = e.method_id LEFT JOIN suppliers s ON s.id = e.supplier_id JOIN users u ON u.id = e.created_by
     WHERE e.business_id IN (${placeholders(scope)}) AND e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 500`, ...scope, from, to);
}

export async function voidExpense(ctx: Ctx) {
  const e = await first<any>(ctx.db, 'SELECT * FROM expenses WHERE id = ?', ctx.params.id);
  if (!e) throw new HttpError(404, 'Expense not found');
  const business = requireBiz(ctx, e.business_id, 'void');
  if (e.status !== 'completed') throw new HttpError(409, 'This expense is already cancelled');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE expenses SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), e.id);
  await tx.reverse('expense', e.id, date, 'expense_void', `Cancelled expense (${e.category}): ${reason}`);
  tx.audit('void', 'expense', e.id, business, { reason, amount: e.amount });
  return tx.commit(idemKey(ctx), { id: e.id });
}

// ── Money movements ─────────────────────────────────────────────
const MOVEMENT_PERM = { customer_payment: 'sell', supplier_payment: 'purchase', transfer: 'money', owner_in: 'money', owner_out: 'money' } as const;

export async function createMovement(ctx: Ctx) {
  const b = ctx.body;
  const type = String(b.type) as keyof typeof MOVEMENT_PERM;
  if (!MOVEMENT_PERM[type]) throw bad('Unknown money movement');
  // At the fuel station, debts are collected by the fuel staff (there is no till there).
  const business = requireBiz(ctx, b.business, type === 'customer_payment' && b.business === 'fuel' ? 'fuel' : MOVEMENT_PERM[type]);
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  const amount = cents(b.amount, 'Amount', { min: 1 });
  const method = await paymentMethod(ctx.db, b.method);
  const note = str(b.note, 'Note', { max: 300 });
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  const head = { business, date, type, refType: 'money', refId: id, amount };
  let customer = null, supplier = null, toBusiness = null, toMethod = null;

  if (type === 'customer_payment') {
    customer = await partyIn(ctx.db, 'customer', b.customer, business);
    if (!customer) throw bad('Choose the customer');
    const owed = await customerBalance(ctx.db, business, customer.id);
    if (amount > owed) throw bad(`${customer.name} owes only ${(owed / 100).toFixed(2)} to this business`);
    tx.journal({ ...head, memo: `Debt payment from ${customer.name}${note ? ` — ${note}` : ''}` },
      [{ account: 'cash', amount, method }, { account: 'receivable', amount: -amount, customer: customer.id }]);
  } else if (type === 'supplier_payment') {
    supplier = await partyIn(ctx.db, 'supplier', b.supplier, business);
    if (!supplier) throw bad('Choose the supplier');
    const owed = await supplierBalance(ctx.db, business, supplier.id);
    if (amount > owed) throw bad(`This business owes ${supplier.name} only ${(owed / 100).toFixed(2)}`);
    tx.journal({ ...head, memo: `Payment to supplier ${supplier.name}${note ? ` — ${note}` : ''}` },
      [{ account: 'payable', amount, supplier: supplier.id }, { account: 'cash', amount: -amount, method }]);
  } else if (type === 'transfer') {
    toBusiness = String(b.toBusiness ?? business);
    if (!ctx.user.businesses.includes(toBusiness)) throw new HttpError(403, 'You do not have access to the receiving business');
    toMethod = await paymentMethod(ctx.db, b.toMethod, 'Receiving account');
    if (toBusiness === business && toMethod === method) throw bad('Choose a different receiving account');
    const memo = `Transfer ${method} (${business}) → ${toMethod} (${toBusiness})${note ? ` — ${note}` : ''}`;
    if (toBusiness === business) {
      tx.journal({ ...head, memo }, [{ account: 'cash', amount, method: toMethod }, { account: 'cash', amount: -amount, method }]);
    } else {
      tx.journal({ ...head, memo }, [{ account: 'transfer', amount, category: toBusiness }, { account: 'cash', amount: -amount, method }]);
      tx.journal({ ...head, business: toBusiness, memo }, [{ account: 'cash', amount, method: toMethod }, { account: 'transfer', amount: -amount, category: business }]);
    }
  } else if (type === 'owner_in') {
    tx.journal({ ...head, memo: `Owner added money${note ? ` — ${note}` : ''}` }, [{ account: 'cash', amount, method }, { account: 'owner', amount: -amount }]);
  } else {
    tx.journal({ ...head, memo: `Owner took money${note ? ` — ${note}` : ''}` }, [{ account: 'owner', amount }, { account: 'cash', amount: -amount, method }]);
  }
  if (toBusiness && toBusiness !== business) await assertDayOpen(ctx.db, toBusiness, date);
  tx.run(`INSERT INTO money_movements (id, type, entry_date, business_id, method_id, to_business_id, to_method_id, customer_id, supplier_id, amount, note, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, type, date, business, method, toBusiness, toMethod, customer?.id, supplier?.id, amount, note, ctx.user.id, nowIso());
  tx.audit('create', type, id, business, { amount, method, toBusiness, toMethod });
  return tx.commit(idemKey(ctx), { id });
}

export async function listMovements(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'), 'money');
  const { from, to } = dateRange(ctx);
  const type = ctx.url.searchParams.get('type');
  return all(ctx.db,
    `SELECT m.*, pm.name AS method_name, tm.name AS to_method_name, c.name AS customer_name, s.name AS supplier_name, u.full_name AS created_by_name
     FROM money_movements m JOIN payment_methods pm ON pm.id = m.method_id LEFT JOIN payment_methods tm ON tm.id = m.to_method_id
     LEFT JOIN customers c ON c.id = m.customer_id LEFT JOIN suppliers s ON s.id = m.supplier_id JOIN users u ON u.id = m.created_by
     WHERE m.entry_date BETWEEN ? AND ? AND (m.business_id IN (${placeholders(scope)}) OR m.to_business_id IN (${placeholders(scope)})) ${type ? 'AND m.type = ?' : ''}
     ORDER BY m.created_at DESC LIMIT 500`, from, to, ...scope, ...scope, ...(type ? [type] : []));
}

export async function voidMovement(ctx: Ctx) {
  const m = await first<any>(ctx.db, 'SELECT * FROM money_movements WHERE id = ?', ctx.params.id);
  if (!m) throw new HttpError(404, 'Not found');
  const business = requireBiz(ctx, m.business_id, 'void');
  if (m.status !== 'completed') throw new HttpError(409, 'Already cancelled');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  await assertShiftCurrent(ctx, business);
  if (m.to_business_id && m.to_business_id !== business) await assertDayOpen(ctx.db, m.to_business_id, date);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE money_movements SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), m.id);
  await tx.reverse('money', m.id, date, `${m.type}_void`, `Cancelled ${m.type.replace('_', ' ')}: ${reason}`);
  tx.audit('void', m.type, m.id, business, { reason, amount: m.amount });
  return tx.commit(idemKey(ctx), { id: m.id });
}

