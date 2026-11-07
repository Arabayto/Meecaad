// Products, stock adjustments, customers, suppliers, payment methods, fuel tanks and pumps.

import {
  HttpError, Tx, all, bad, bizScope, bool, can, cents, entryDate, first, idemKey, newId, nowIso, placeholders, qty, requireBiz, round3, str,
  assertDayOpen, today, BUSINESSES, type Ctx, type Perm,
} from './lib';

const KINDS: Record<string, string[]> = { restaurant: ['menu', 'ingredient'], store: ['item'], fuel: ['fuel'] };

// ── Products ────────────────────────────────────────────────────
export async function listProducts(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  // "Sold in 30 days" is only worked out when a screen asks for it (Stock page),
  // reading just the last 30 days of sales — not on every till load.
  const stats = ctx.url.searchParams.get('stats') === '1';
  return all<any>(ctx.db,
    `${stats ? `WITH sold AS (SELECT si.product_id, SUM(si.qty - si.returned_qty) AS qty FROM sales s JOIN sale_items si ON si.sale_id = s.id
                  WHERE s.business_id IN (${placeholders(scope)}) AND s.entry_date >= ? AND s.status = 'completed' GROUP BY si.product_id) ` : ''}
     SELECT p.*, ROUND(p.stock_qty * p.avg_cost) AS stock_value${stats ? ', COALESCE(sold.qty, 0) AS sold_30d' : ''},
       img.updated_at AS image_v,
       CASE WHEN p.kind = 'menu' THEN (SELECT ROUND(SUM(r.qty * i.avg_cost)) FROM recipe_items r JOIN products i ON i.id = r.ingredient_id WHERE r.menu_id = p.id) END AS recipe_cost
     FROM products p ${stats ? 'LEFT JOIN sold ON sold.product_id = p.id' : ''} LEFT JOIN product_images img ON img.product_id = p.id
     WHERE p.business_id IN (${placeholders(scope)})
     ORDER BY p.active DESC, p.kind, p.category, p.name`, ...(stats ? [...scope, today(-30)] : []), ...scope);
}

export async function createProduct(ctx: Ctx) {
  const b = ctx.body;
  const business = requireBiz(ctx, b.business, 'catalog');
  const kind = String(b.kind ?? KINDS[business][0]);
  if (!KINDS[business].includes(kind)) throw bad('This product type does not belong to this business');
  const id = newId();
  const track = kind === 'fuel' || kind === 'ingredient' || kind === 'item' ? 1 : bool(b.trackStock) ? 1 : 0;
  const openingQty = kind === 'fuel' || !track ? 0 : qty(b.openingQty ?? 0, 'Opening quantity', { min: 0 });
  const openingCost = openingQty ? Number(cents(b.openingCost, 'Opening unit cost')) : 0;
  const name = str(b.name, 'Name', { required: true, max: 120 });
  const date = entryDate(b.date);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO products (id, business_id, name, category, kind, unit, sku, sale_price, avg_cost, track_stock, reorder_level, created_at, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, business, name, str(b.category, 'Category', { max: 60 }) ?? '', kind, str(b.unit, 'Unit', { max: 20 }) ?? (kind === 'fuel' ? 'L' : 'pcs'),
    str(b.sku, 'Barcode/SKU', { max: 60 }), kind === 'ingredient' ? 0 : cents(b.salePrice, 'Selling price', { required: false }),
    openingCost, track, track ? qty(b.reorderLevel ?? 0, 'Low-stock level', { min: 0 }) : 0, nowIso(), ctx.user.id);
  if (openingQty > 0) {
    const value = Math.round(openingQty * openingCost);
    tx.stock({ business, product: id, date, type: 'opening', qty: openingQty, unitCost: openingCost, value, refType: 'product', refId: id, reason: 'Opening stock' });
    tx.journal({ business, date, type: 'opening_stock', refType: 'product', refId: id, memo: `Opening stock: ${name}`, amount: value },
      [{ account: 'inventory', amount: value }, { account: 'owner', amount: -value }]);
  }
  tx.audit('create', 'product', id, business, { name, kind, openingQty });
  return tx.commit(idemKey(ctx), { id });
}

export async function updateProduct(ctx: Ctx) {
  const p = await first<any>(ctx.db, 'SELECT * FROM products WHERE id = ?', ctx.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  requireBiz(ctx, p.business_id, 'catalog');
  const b = ctx.body;
  const price = b.salePrice === undefined ? p.sale_price : cents(b.salePrice, 'Selling price');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE products SET name = ?, category = ?, unit = ?, sku = ?, sale_price = ?, reorder_level = ?, active = ? WHERE id = ?`,
    str(b.name ?? p.name, 'Name', { required: true, max: 120 }), str(b.category ?? p.category, 'Category', { max: 60 }) ?? '',
    str(b.unit ?? p.unit, 'Unit', { max: 20 }) ?? p.unit, str(b.sku ?? p.sku, 'Barcode/SKU', { max: 60 }), price,
    b.reorderLevel === undefined ? p.reorder_level : qty(b.reorderLevel, 'Low-stock level', { min: 0 }),
    b.active === undefined ? p.active : bool(b.active) ? 1 : 0, p.id);
  if (price !== p.sale_price) {
    tx.run('INSERT INTO price_changes (id, product_id, old_price, new_price, reason, changed_by, changed_at) VALUES (?,?,?,?,?,?,?)',
      newId(), p.id, p.sale_price, price, str(b.priceReason, 'Reason', { max: 200 }), ctx.user.id, nowIso());
  }
  tx.audit('update', 'product', p.id, p.business_id, { before: { name: p.name, sale_price: p.sale_price, active: p.active }, after: b });
  return tx.commit(null, { id: p.id });
}

// ── Product pictures (shown on the till) ────────────────────────
const MAX_IMAGE = 400_000;   // base64 characters (~300 KB); the browser resizes before upload

export async function saveImage(ctx: Ctx) {
  const p = await first<any>(ctx.db, 'SELECT id, business_id FROM products WHERE id = ?', ctx.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  requireBiz(ctx, p.business_id, 'catalog');
  const tx = new Tx(ctx.db, ctx.user);
  if (ctx.body.data === null) {
    tx.run('DELETE FROM product_images WHERE product_id = ?', p.id);
  } else {
    const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.data ?? ''));
    if (!m) throw bad('Choose a picture (JPG, PNG or WebP)');
    if (m[2].length > MAX_IMAGE) throw bad('The picture is too large');
    tx.run(`INSERT INTO product_images (product_id, mime, data, updated_at) VALUES (?,?,?,?)
            ON CONFLICT (product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`, p.id, m[1], m[2], nowIso());
  }
  tx.audit(ctx.body.data === null ? 'remove_image' : 'image', 'product', p.id, p.business_id);
  return tx.commit(null, { id: p.id });
}

export async function getImage(ctx: Ctx) {
  const row = await first<any>(ctx.db, `SELECT i.mime, i.data, p.business_id FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.product_id = ?`, ctx.params.id);
  if (!row) throw new HttpError(404, 'No picture');
  bizScope(ctx, row.business_id);
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  // The URL carries ?v=<updated_at>, so a picture never changes under the same URL.
  return new Response(bytes, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' } });
}

export async function priceHistory(ctx: Ctx) {
  const p = await first<any>(ctx.db, 'SELECT business_id FROM products WHERE id = ?', ctx.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  bizScope(ctx, p.business_id);
  return all(ctx.db, `SELECT pc.*, u.full_name AS changed_by_name FROM price_changes pc JOIN users u ON u.id = pc.changed_by
                      WHERE product_id = ? ORDER BY changed_at DESC`, ctx.params.id);
}

/** Kitchen usage, waste/damage, or a stock count correction. */
export async function adjustStock(ctx: Ctx) {
  const b = ctx.body;
  const p = await first<any>(ctx.db, 'SELECT * FROM products WHERE id = ?', String(b.product ?? ''));
  if (!p || !p.track_stock || p.kind === 'fuel') throw bad('Choose a stocked product (fuel is corrected with tank dips)');
  const type = String(b.type);
  if (!['usage', 'waste', 'adjustment'].includes(type)) throw bad('Choose usage, waste or count');
  const business = requireBiz(ctx, p.business_id, type === 'adjustment' ? 'catalog' : 'stock');
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  const reason = str(b.reason, 'Reason', { required: type !== 'usage', max: 300 });
  const change = type === 'adjustment'
    ? round3(qty(b.countedQty, 'Counted quantity', { min: 0 }) - p.stock_qty)
    : -qty(b.qty, 'Quantity', { positive: true });
  if (change === 0) throw bad('The counted quantity is the same as the system quantity');
  const value = Math.round(change * p.avg_cost);
  const id = newId();
  const labels: Record<string, string> = { usage: 'Kitchen usage', waste: 'Waste/damage', adjustment: 'Stock count correction' };
  const tx = new Tx(ctx.db, ctx.user);
  tx.stock({ business, product: p.id, date, type, qty: change, unitCost: p.avg_cost, value, refType: 'stock', refId: id, reason });
  tx.journal({ business, date, type: `stock_${type}`, refType: 'stock', refId: id, memo: `${labels[type]}: ${Math.abs(change)} ${p.unit} ${p.name}${reason ? ` — ${reason}` : ''}`, amount: Math.abs(value) },
    [{ account: 'inventory', amount: value }, { account: type === 'usage' ? 'cogs' : 'stock_loss', amount: -value, category: labels[type] }]);
  tx.audit(type, 'stock', p.id, business, { product: p.name, change, value, reason });
  return tx.commit(idemKey(ctx), { id, change, value });
}

export async function stockMovements(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const product = ctx.url.searchParams.get('product');
  return all(ctx.db,
    `SELECT m.*, p.name AS product_name, p.unit, t.name AS tank_name, u.full_name AS created_by_name
     FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN fuel_tanks t ON t.id = m.tank_id JOIN users u ON u.id = m.created_by
     WHERE m.business_id IN (${placeholders(scope)}) ${product ? 'AND m.product_id = ?' : ''}
     ORDER BY m.created_at DESC LIMIT 300`, ...scope, ...(product ? [product] : []));
  // (indexes: business_id + created_at, product_id + created_at — reads only the 300 rows shown)
}

// ── Customers & suppliers ───────────────────────────────────────
// Each customer/supplier belongs to the business(es) it is linked to
// (customer_businesses / supplier_businesses). Lists, edits and statements
// only reach the businesses the user works in AND the record is linked to.
function party(kind: 'customer' | 'supplier') {
  const table = kind === 'customer' ? 'customers' : 'suppliers';
  const links = `${kind}_businesses`;
  const account = kind === 'customer' ? 'receivable' : 'payable';
  const col = `${kind}_id`;
  const sign = kind === 'customer' ? 1 : -1;
  // Fuel attendants add the customers they give fuel on credit to.
  const perms: Perm[] = kind === 'customer' ? ['sell', 'fuel', 'reports'] : ['purchase', 'expense', 'reports'];
  const mayManage = (ctx: Ctx, business: string) => perms.some((p) => can(ctx.user, p, business));
  const linkedTo = async (ctx: Ctx, id: string) =>
    (await all<{ business_id: string }>(ctx.db, `SELECT business_id FROM ${links} WHERE ${col} = ?`, id)).map((r) => r.business_id);

  return {
    async list(ctx: Ctx) {
      const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
      // Balances come from the running totals (account_balances), not the full history.
      // A charge raises a customer's balance but lowers a supplier's (amounts are + debit / − credit).
      const [charge, payment] = kind === 'customer' ? ['last_increase', 'last_decrease'] : ['last_decrease', 'last_increase'];
      const rows = await all<any>(ctx.db,
        `SELECT c.*, COALESCE(b.balance, 0) AS balance, b.last_charge, b.last_payment,
                (SELECT GROUP_CONCAT(x.business_id) FROM ${links} x WHERE x.${col} = c.id) AS business_list
         FROM ${table} c
         LEFT JOIN (
           SELECT ${col} AS id, ${sign} * SUM(balance) AS balance, MAX(${charge}) AS last_charge, MAX(${payment}) AS last_payment
           FROM account_balances WHERE account = '${account}' AND business_id IN (${placeholders(scope)}) GROUP BY ${col}
         ) b ON b.id = c.id
         WHERE c.id IN (SELECT ${col} FROM ${links} WHERE business_id IN (${placeholders(scope)}))
         ORDER BY c.active DESC, c.name`, ...scope, ...scope);
      for (const r of rows) r.businesses = String(r.business_list ?? '').split(',').filter(Boolean);
      return rows;
    },
    async create(ctx: Ctx) {
      const business = String(ctx.body.business ?? '');
      requireBiz(ctx, business, perms.find((p) => can(ctx.user, p, business)) ?? perms[0]);
      const id = newId();
      const tx = new Tx(ctx.db, ctx.user);
      tx.run(`INSERT INTO ${table} (id, name, phone, notes, created_at, created_by) VALUES (?,?,?,?,?,?)`,
        id, str(ctx.body.name, 'Name', { required: true, max: 120 }), str(ctx.body.phone, 'Phone', { max: 40 }), str(ctx.body.notes, 'Notes', { max: 500 }), nowIso(), ctx.user.id);
      tx.run(`INSERT INTO ${links} (${col}, business_id) VALUES (?,?)`, id, business);
      tx.audit('create', kind, id, business, { name: ctx.body.name });
      return tx.commit(idemKey(ctx), { id });
    },
    async update(ctx: Ctx) {
      const c = await first<any>(ctx.db, `SELECT * FROM ${table} WHERE id = ?`, ctx.params.id);
      if (!c) throw new HttpError(404, 'Not found');
      const linked = await linkedTo(ctx, c.id);
      // Only someone working in a business this record belongs to may change it.
      if (!linked.some((b) => ctx.user.businesses.includes(b) && mayManage(ctx, b))) throw new HttpError(404, 'Not found');
      const b = ctx.body;
      const tx = new Tx(ctx.db, ctx.user);
      tx.run(`UPDATE ${table} SET name = ?, phone = ?, notes = ?, active = ? WHERE id = ?`,
        str(b.name ?? c.name, 'Name', { required: true, max: 120 }), str(b.phone ?? c.phone, 'Phone', { max: 40 }),
        str(b.notes ?? c.notes, 'Notes', { max: 500 }), b.active === undefined ? c.active : bool(b.active) ? 1 : 0, c.id);
      // The owner can share a record with another business, or remove it from one where nothing is owed.
      if (Array.isArray(b.businesses)) {
        if (!ctx.user.owner) throw new HttpError(403, 'Only the owner can change which businesses this belongs to');
        const next = [...new Set<string>(b.businesses.map(String))].filter((x) => BUSINESSES.includes(x));
        if (!next.length) throw bad('Choose at least one business');
        for (const gone of linked.filter((x) => !next.includes(x))) {
          const owed = await first<{ v: number }>(ctx.db, `SELECT COALESCE(SUM(balance), 0) AS v FROM account_balances WHERE business_id = ? AND account = '${account}' AND ${col} = ?`, gone, c.id);
          if (owed?.v) throw bad(`Cannot remove it from ${gone}: there is still a balance there`);
          tx.run(`DELETE FROM ${links} WHERE ${col} = ? AND business_id = ?`, c.id, gone);
        }
        for (const add of next.filter((x) => !linked.includes(x))) tx.run(`INSERT INTO ${links} (${col}, business_id) VALUES (?,?)`, c.id, add);
      }
      tx.audit('update', kind, c.id, null, { before: { ...c, businesses: linked }, after: b });
      return tx.commit(null, { id: c.id });
    },
    /** Every charge and payment with a running balance, in the businesses asked for. */
    async statement(ctx: Ctx) {
      const c = await first<any>(ctx.db, `SELECT * FROM ${table} WHERE id = ?`, ctx.params.id);
      if (!c) throw new HttpError(404, 'Not found');
      const linked = await linkedTo(ctx, c.id);
      const scope = bizScope(ctx, ctx.url.searchParams.get('business')).filter((b) => linked.includes(b));
      if (!scope.length) throw new HttpError(404, 'Not found');
      const lines = await all<any>(ctx.db,
        `SELECT l.entry_date, l.business_id, ${sign} * l.amount AS amount, e.memo, e.type, e.ref_type, e.ref_id, e.created_at
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.${col} = ? AND l.account = '${account}' AND l.business_id IN (${placeholders(scope)})
         ORDER BY l.entry_date, e.created_at, l.id`, c.id, ...scope);
      let running = 0;
      for (const l of lines) l.balance = running += l.amount;
      return { [kind]: c, lines, balance: running };
    },
  };
}
export const customers = party('customer');
export const suppliers = party('supplier');

// ── Payment methods ─────────────────────────────────────────────
export const listMethods = (ctx: Ctx) => all(ctx.db, 'SELECT * FROM payment_methods ORDER BY active DESC, sort, name');

export async function createMethod(ctx: Ctx) {
  const name = str(ctx.body.name, 'Name', { required: true, max: 40 })!;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO payment_methods (id, name, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM payment_methods))', id, name);
  tx.audit('create', 'payment_method', id, null, { name });
  return tx.commit(null, { id });
}

export async function updateMethod(ctx: Ctx) {
  const m = await first<any>(ctx.db, 'SELECT * FROM payment_methods WHERE id = ?', ctx.params.id);
  if (!m) throw new HttpError(404, 'Not found');
  if (m.id === 'cash' && !bool(ctx.body.active ?? 1)) throw bad('Cash cannot be turned off');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE payment_methods SET name = ?, active = ? WHERE id = ?', str(ctx.body.name ?? m.name, 'Name', { required: true, max: 40 }),
    ctx.body.active === undefined ? m.active : bool(ctx.body.active) ? 1 : 0, m.id);
  tx.audit('update', 'payment_method', m.id, null, ctx.body);
  return tx.commit(null, { id: m.id });
}

// ── Fuel tanks & pumps ──────────────────────────────────────────
export async function fuelSetup(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const [tanks, pumps] = await Promise.all([
    all(ctx.db, `SELECT t.*, p.name AS fuel_name, p.sale_price, p.avg_cost, p.unit FROM fuel_tanks t JOIN products p ON p.id = t.product_id ORDER BY t.active DESC, t.name`),
    all(ctx.db, `SELECT pu.*, t.name AS tank_name, t.product_id, p.name AS fuel_name, p.sale_price FROM fuel_pumps pu JOIN fuel_tanks t ON t.id = pu.tank_id
                 JOIN products p ON p.id = t.product_id ORDER BY pu.active DESC, pu.name`),
  ]);
  return { tanks, pumps };
}

export async function createTank(ctx: Ctx) {
  requireBiz(ctx, 'fuel', 'catalog');
  const b = ctx.body;
  const p = await first<any>(ctx.db, `SELECT * FROM products WHERE id = ? AND kind = 'fuel'`, String(b.product ?? ''));
  if (!p) throw bad('Choose the fuel type');
  const id = newId();
  const name = str(b.name, 'Tank name', { required: true, max: 60 })!;
  const opening = qty(b.openingQty ?? 0, 'Litres in the tank now', { min: 0 });
  const date = entryDate(b.date);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO fuel_tanks (id, business_id, product_id, name, capacity, created_at) VALUES (?,?,?,?,?,?)',
    id, 'fuel', p.id, name, qty(b.capacity ?? 0, 'Capacity', { min: 0 }), nowIso());
  if (opening > 0) {
    const unitCost = Number(cents(b.openingCost, 'Cost per litre'));
    // New average cost across all tanks of this fuel.
    const avg = p.stock_qty > 0 ? (p.stock_qty * p.avg_cost + opening * unitCost) / (p.stock_qty + opening) : unitCost;
    const value = Math.round(opening * unitCost);
    tx.run('UPDATE products SET avg_cost = ? WHERE id = ?', avg, p.id);
    tx.stock({ business: 'fuel', product: p.id, tank: id, date, type: 'opening', qty: opening, unitCost, value, refType: 'tank', refId: id, reason: 'Opening stock' });
    tx.journal({ business: 'fuel', date, type: 'opening_stock', refType: 'tank', refId: id, memo: `Opening fuel stock: ${name} (${opening} L ${p.name})`, amount: value },
      [{ account: 'inventory', amount: value }, { account: 'owner', amount: -value }]);
  }
  tx.audit('create', 'fuel_tank', id, 'fuel', { name, product: p.name, opening });
  return tx.commit(idemKey(ctx), { id });
}

export async function updateTank(ctx: Ctx) {
  requireBiz(ctx, 'fuel', 'catalog');
  const t = await first<any>(ctx.db, 'SELECT * FROM fuel_tanks WHERE id = ?', ctx.params.id);
  if (!t) throw new HttpError(404, 'Tank not found');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE fuel_tanks SET name = ?, capacity = ?, active = ? WHERE id = ?', str(ctx.body.name ?? t.name, 'Tank name', { required: true, max: 60 }),
    qty(ctx.body.capacity ?? t.capacity, 'Capacity', { min: 0 }), ctx.body.active === undefined ? t.active : bool(ctx.body.active) ? 1 : 0, t.id);
  tx.audit('update', 'fuel_tank', t.id, 'fuel', ctx.body);
  return tx.commit(null, { id: t.id });
}

export async function createPump(ctx: Ctx) {
  requireBiz(ctx, 'fuel', 'catalog');
  const b = ctx.body;
  const t = await first<any>(ctx.db, 'SELECT * FROM fuel_tanks WHERE id = ? AND active = 1', String(b.tank ?? ''));
  if (!t) throw bad('Choose the tank this pump draws from');
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO fuel_pumps (id, business_id, tank_id, name, last_meter, created_at) VALUES (?,?,?,?,?,?)',
    id, 'fuel', t.id, str(b.name, 'Pump name', { required: true, max: 60 }), qty(b.meter ?? 0, 'Current meter reading', { min: 0 }), nowIso());
  tx.audit('create', 'fuel_pump', id, 'fuel', b);
  return tx.commit(idemKey(ctx), { id });
}

/** Rename / deactivate a pump, or reset its meter (e.g. meter replaced) with a reason. */
export async function updatePump(ctx: Ctx) {
  requireBiz(ctx, 'fuel', 'catalog');
  const p = await first<any>(ctx.db, 'SELECT * FROM fuel_pumps WHERE id = ?', ctx.params.id);
  if (!p) throw new HttpError(404, 'Pump not found');
  const b = ctx.body;
  const meter = b.meter === undefined ? p.last_meter : qty(b.meter, 'Meter reading', { min: 0 });
  if (meter !== p.last_meter && !str(b.reason, 'Reason')) throw bad('Give a reason for changing the meter reading');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE fuel_pumps SET name = ?, active = ?, last_meter = ? WHERE id = ?', str(b.name ?? p.name, 'Pump name', { required: true, max: 60 }),
    b.active === undefined ? p.active : bool(b.active) ? 1 : 0, meter, p.id);
  tx.audit(meter !== p.last_meter ? 'meter_reset' : 'update', 'fuel_pump', p.id, 'fuel', { oldMeter: p.last_meter, meter, reason: b.reason });
  return tx.commit(null, { id: p.id });
}
