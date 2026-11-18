// Fuel station shifts, the way the station is run:
//   Every salesman opens their own shift (Morning / Evening / Night, by Hargeisa
//   time), records the money collected — Cash / Zaad / Edahab, or a customer
//   debt — and closes the shift when their time finishes. No opening fuel or
//   money. The owner and managers see what is happening live, per salesman and
//   per shift, with simple totals for decisions.

import { HttpError, Tx, addDays, all, assertDayOpen, bad, bizScope, can, cents, first, idemKey, newId, nowIso, partyIn, paymentMethod, qty, requireBiz, round3, str, today, type Ctx } from './lib';

const B = 'fuel';
const EAT = 3 * 3600_000;   // Hargeisa time = UTC+3

// ── Shift times ─────────────────────────────────────────────────
export interface ShiftTime { name: string; start: string; end: string }
const DEFAULT_TIMES: ShiftTime[] = [
  { name: 'Morning', start: '06:00', end: '14:00' },
  { name: 'Evening', start: '14:00', end: '22:00' },
  { name: 'Night', start: '22:00', end: '06:00' },
];
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

async function shiftTimes(db: D1Database): Promise<ShiftTime[]> {
  const row = await first<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'fuel_shift_times'`);
  try { const v = JSON.parse(row?.value ?? ''); if (Array.isArray(v) && v.length) return v; } catch { /* use the default */ }
  return DEFAULT_TIMES;
}

/** The shift whose time it is in Hargeisa right now (e.g. Morning 06:00–14:00; Night may cross midnight). */
function shiftAt(times: ShiftTime[], at = Date.now()): ShiftTime | null {
  const d = new Date(at + EAT);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return times.find((t) => { const s = mins(t.start), e = mins(t.end); return s < e ? m >= s && m < e : m >= s || m < e; }) ?? null;
}

/**
 * When a shift opened at `openedAt` should finish (ISO), or null when it has no set time:
 * the next time its end clock-time comes round, but never later than its normal length
 * after opening (so a shift opened late or outside its time still becomes overdue).
 */
function scheduledEnd(times: ShiftTime[], name: string, openedAt: string): string | null {
  const t = times.find((x) => x.name === name);
  if (!t) return null;
  const s = mins(t.start), e = mins(t.end);
  const length = (e > s ? e - s : e + 1440 - s) * 60_000;
  const opened = Date.parse(openedAt);
  const o = new Date(opened + EAT);
  let end = Date.UTC(o.getUTCFullYear(), o.getUTCMonth(), o.getUTCDate(), Math.floor(e / 60), e % 60) - EAT;
  if (end <= opened) end += 86_400_000;
  return new Date(Math.min(end, opened + length)).toISOString();
}

export async function getShiftTimes(ctx: Ctx) {
  bizScope(ctx, B);
  const times = await shiftTimes(ctx.db);
  return { times, now: shiftAt(times)?.name ?? null };
}

export async function setShiftTimes(ctx: Ctx) {
  requireBiz(ctx, B, 'catalog');
  const list = Array.isArray(ctx.body.times) ? ctx.body.times : [];
  if (!list.length || list.length > 6) throw bad('Add between 1 and 6 shifts');
  const times: ShiftTime[] = list.map((t: any) => {
    const name = String(t.name ?? '').trim();
    if (!name || name.length > 20) throw bad('Each shift needs a name (up to 20 letters)');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.start)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.end))) throw bad(`${name}: use times like 06:00`);
    if (t.start === t.end) throw bad(`${name}: the start and end time must differ`);
    return { name, start: t.start, end: t.end };
  });
  if (new Set(times.map((t) => t.name.toLowerCase())).size !== times.length) throw bad('Each shift needs its own name');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO app_settings (key, value) VALUES ('fuel_shift_times', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(times));
  tx.audit('set_shift_times', 'fuel_shift_times', null, B, { times });
  return tx.commit(idemKey(ctx), { times });
}

// ── Reading ─────────────────────────────────────────────────────
const SHIFT_SELECT = `SELECT s.*, u.full_name AS user_name, c.full_name AS closed_by_name FROM duty_shifts s
  JOIN users u ON u.id = s.user_id LEFT JOIN users c ON c.id = s.closed_by`;

type Totals = { count: number; sold: number; debts: number; by_method: Record<string, number> };
const none = (): Totals => ({ count: 0, sold: 0, debts: 0, by_method: {} });

/** Money collected per shift (sold, per method, debts) for shifts matching a filter on `s`. */
async function totals(db: D1Database, where: string, ...params: unknown[]) {
  const rows = await all<any>(db, `SELECT f.shift_id, f.method_id, COUNT(*) AS n, SUM(f.amount) AS amount FROM duty_sales f JOIN duty_shifts s ON s.id = f.shift_id
    WHERE f.status = 'completed' AND ${where} GROUP BY f.shift_id, f.method_id`, ...params);
  const map = new Map<string, Totals>();
  for (const r of rows) {
    const t = map.get(r.shift_id) ?? none();
    t.count += r.n; t.sold += r.amount;
    if (r.method_id) t.by_method[r.method_id] = r.amount; else t.debts += r.amount;
    map.set(r.shift_id, t);
  }
  return map;
}

function decorate(s: any, t: Totals | undefined, times: ShiftTime[]) {
  const ends_at = s.status === 'open' ? scheduledEnd(times, s.shift_name, s.opened_at) : null;
  return { ...s, ...(t ?? none()), ends_at, overdue: Boolean(ends_at && Date.now() > Date.parse(ends_at)),
    duration_min: Math.round(((s.closed_at ? Date.parse(s.closed_at) : Date.now()) - Date.parse(s.opened_at)) / 60000) };
}

async function salesOf(db: D1Database, shiftId: string) {
  return all(db, `SELECT f.*, i.unit AS item_unit, pm.name AS method_name, cu.name AS customer_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
    FROM duty_sales f LEFT JOIN fuel_items i ON i.id = f.item_id LEFT JOIN payment_methods pm ON pm.id = f.method_id LEFT JOIN customers cu ON cu.id = f.customer_id
    JOIN users u ON u.id = f.created_by LEFT JOIN users v ON v.id = f.voided_by WHERE f.shift_id = ? ORDER BY f.created_at DESC`, shiftId);
}

async function currentRate(db: D1Database) {
  const r = await first<{ rate: number }>(db, 'SELECT rate FROM exchange_rates WHERE rate_date <= ? ORDER BY rate_date DESC, set_at DESC LIMIT 1', today());
  return r?.rate ?? null;
}

/**
 * What the Sales screen needs: my open shift (with my sales), the shift whose
 * time it is now, and — for managers and the owner — every open shift.
 */
export async function current(ctx: Ctx) {
  bizScope(ctx, B);
  const [times, rate, mine, openRows] = await Promise.all([
    shiftTimes(ctx.db), currentRate(ctx.db),
    first<any>(ctx.db, `${SHIFT_SELECT} WHERE s.business_id = ? AND s.user_id = ? AND s.status = 'open'`, B, ctx.user.id),
    all<any>(ctx.db, `${SHIFT_SELECT} WHERE s.business_id = ? AND s.status = 'open' ORDER BY s.opened_at`, B),
  ]);
  const t = await totals(ctx.db, `s.business_id = ? AND s.status = 'open'`, B);
  const live = can(ctx.user, 'reports', B) ? openRows.map((s) => decorate(s, t.get(s.id), times)) : [];
  const last = mine ? null : await first<any>(ctx.db, `${SHIFT_SELECT} WHERE s.business_id = ? AND s.user_id = ? AND s.status = 'closed' ORDER BY s.closed_at DESC LIMIT 1`, B, ctx.user.id);
  const lastT = last ? (await totals(ctx.db, 's.id = ?', last.id)).get(last.id) : undefined;
  return {
    rate, times, suggested: shiftAt(times)?.name ?? null, owner: ctx.user.owner,
    mine: mine ? decorate(mine, t.get(mine.id), times) : null,
    sales: mine ? await salesOf(ctx.db, mine.id) : [],
    last: last ? decorate(last, lastT, times) : null,
    live,
  };
}

// ── Doing ───────────────────────────────────────────────────────
export async function openShift(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  if (ctx.user.owner) throw bad('The owner does not work shifts. Salesmen open their own shifts.');
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  if (await first(ctx.db, `SELECT id FROM duty_shifts WHERE business_id = ? AND user_id = ? AND status = 'open'`, B, ctx.user.id)) throw new HttpError(409, 'You already have an open shift. Close it first.');
  const times = await shiftTimes(ctx.db);
  const wanted = str(ctx.body.shiftName, 'Shift', { max: 20 });
  const name = wanted ?? shiftAt(times)?.name ?? 'Shift';
  if (wanted && !times.some((t) => t.name === wanted)) throw bad('Choose one of the shifts');
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO duty_shifts (id, business_id, number, entry_date, shift_name, user_id, opened_at, note)
          VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM duty_shifts WHERE business_id = ?), ?,?,?,?,?)`,
    id, B, B, date, name, ctx.user.id, nowIso(), str(ctx.body.note, 'Note', { max: 300 }));
  tx.audit('open', 'fuel_shift', id, B, { name });
  try {
    return await tx.commit(idemKey(ctx), { id, name });
  } catch (e: any) {
    if (/UNIQUE|already exists/i.test(String(e?.message))) throw new HttpError(409, 'You already have an open shift. Close it first.');
    throw e;
  }
}

/** One sale into my open shift: an item at the admin's price (by quantity or by amount), paid by Cash / Zaad / Edahab or put on a customer's debt. */
export async function createSale(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  const b = ctx.body;
  const shift = await first<any>(ctx.db, `SELECT * FROM duty_shifts WHERE business_id = ? AND user_id = ? AND status = 'open'`, B, ctx.user.id);
  if (!shift) throw new HttpError(409, 'Open your shift first');
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  const debt = Boolean(b.customer);
  const customer = debt ? await partyIn(ctx.db, 'customer', b.customer, B) : null;
  const method = debt ? null : await paymentMethod(ctx.db, b.method);
  const rate = await currentRate(ctx.db);
  let amount: number, slshAmount: number | null = null, item: any = null, itemQty = 0;
  if (b.item) {
    // The price is the admin's: the salesman only says what and how much (quantity, or an amount in the item's money).
    item = await first<any>(ctx.db, 'SELECT * FROM fuel_items WHERE id = ? AND business_id = ? AND active = 1', String(b.item), B);
    if (!item) throw bad('Choose what was sold');
    let total: number;   // in the item's own money: cents (USD) or shillings (SLSH)
    if (b.qty !== undefined && b.qty !== '' && b.qty !== null) {
      itemQty = qty(b.qty, 'Quantity', { positive: true });
      total = Math.round(itemQty * item.price);
    } else {
      total = item.currency === 'USD' ? cents(b.amount, 'Amount', { min: 1 }) : Math.round(Number(String(b.amount ?? '').replace(/,/g, '')));
      if (!Number.isFinite(total) || total < 1) throw bad('Enter the quantity or the amount');
      itemQty = round3(total / item.price);
    }
    if (total < 1) throw bad('The amount is too small');
    if (item.currency === 'USD') {
      amount = total;
      slshAmount = rate ? Math.round((total / 100) * rate) : null;
    } else {
      if (!rate) throw bad('This item is priced in Shillings. Set the exchange rate first (Settings).');
      slshAmount = total;
      amount = Math.round((total / rate) * 100);
      if (amount < 1) throw bad('The amount is too small');
    }
  } else {
    // Until the manager adds items in Inventory, a sale can still be an amount (US dollars).
    if (await first(ctx.db, `SELECT id FROM fuel_items WHERE business_id = ? AND active = 1 LIMIT 1`, B)) throw bad('Choose what was sold');
    amount = cents(b.amount, 'Amount', { min: 1 });
  }
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO duty_sales (id, shift_id, business_id, entry_date, amount, method_id, customer_id, slsh_amount, rate, note, item_id, item_name, qty, unit_price, price_currency, unit_cost, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, shift.id, B, date, amount, method, customer?.id ?? null, slshAmount, rate, str(b.note, 'Note', { max: 200 }),
    item?.id ?? null, item?.name ?? null, item ? itemQty : null, item?.price ?? null, item?.currency ?? null, item ? item.cost_price : null, ctx.user.id, nowIso());
  const cost = item?.track_stock ? Math.round(itemQty * item.cost_price) : 0;   // what the goods cost us
  if (item?.track_stock) {
    tx.run('UPDATE fuel_items SET stock_qty = ROUND(stock_qty - ?, 3) WHERE id = ?', itemQty, item.id);
    tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, ref_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`, newId(), item.id, date, 'sale', -itemQty!, id, ctx.user.id, nowIso());
  }
  tx.journal({ business: B, date, type: 'fuel_sale', refType: 'fuel_sale', refId: id, amount,
    memo: `Fuel sale${item ? `: ${itemQty} ${item.unit} ${item.name}` : ''} (${shift.shift_name} shift #${shift.number})${customer ? ` on credit to ${customer.name}` : ''}` }, [
    { account: 'sales', amount: -amount },
    debt ? { account: 'receivable', amount, customer: customer!.id } : { account: 'cash', amount, method },
    { account: 'cogs', amount: cost },
    { account: 'inventory', amount: -cost },
  ]);
  tx.audit('create', 'fuel_sale', id, B, { amount, method, customer: customer?.name, item: item?.name, qty: itemQty, slsh: slshAmount });
  return tx.commit(idemKey(ctx), { id, amount, qty: itemQty, slsh: slshAmount });
}

/** A wrong sale is cancelled by a manager or the owner, with a reason (the money is reversed). */
export async function voidSale(ctx: Ctx) {
  requireBiz(ctx, B, 'void');
  const s = await first<any>(ctx.db, 'SELECT * FROM duty_sales WHERE id = ?', ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  if (s.status !== 'completed') throw new HttpError(409, 'Already cancelled');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE duty_sales SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), s.id);
  const sold = s.item_id ? await first<any>(ctx.db, 'SELECT track_stock, cost_price FROM fuel_items WHERE id = ?', s.item_id) : null;
  if (sold?.track_stock) {
    // The goods come back at what they cost; the average cost takes them back in.
    const back = Math.round(s.qty * (s.unit_cost ?? 0));
    tx.run(`UPDATE fuel_items SET cost_price = CASE WHEN MAX(stock_qty, 0) + ? > 0.0005 THEN ROUND((MAX(stock_qty, 0) * cost_price + ?) / (MAX(stock_qty, 0) + ?), 6) ELSE cost_price END WHERE id = ?`, s.qty, back, s.qty, s.item_id);
    tx.run('UPDATE fuel_items SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?', s.qty, s.item_id);
    tx.run(`INSERT INTO fuel_stock_log (id, item_id, entry_date, type, qty, ref_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, newId(), s.item_id, date, 'sale_void', s.qty, s.id, reason, ctx.user.id, nowIso());
  }
  await tx.reverse('fuel_sale', s.id, date, 'fuel_sale_void', `Cancelled fuel sale: ${reason}`);
  tx.audit('void', 'fuel_sale', s.id, B, { reason, amount: s.amount });
  return tx.commit(idemKey(ctx), { id: s.id });
}

/** Close my shift (or, for a manager/owner, someone's forgotten shift). */
export async function closeShift(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  const id = String(ctx.body.shiftId ?? '');
  const shift = id
    ? await first<any>(ctx.db, `SELECT * FROM duty_shifts WHERE id = ? AND business_id = ?`, id, B)
    : await first<any>(ctx.db, `SELECT * FROM duty_shifts WHERE business_id = ? AND user_id = ? AND status = 'open'`, B, ctx.user.id);
  if (!shift) throw new HttpError(409, 'You have no open shift');
  if (shift.status !== 'open') throw new HttpError(409, 'This shift is already closed');
  if (shift.user_id !== ctx.user.id) requireBiz(ctx, B, 'void');   // only a manager or the owner closes someone else's shift
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE duty_shifts SET status = 'closed', closed_at = ?, closed_by = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'open'`,
    nowIso(), ctx.user.id, str(ctx.body.note, 'Note', { max: 300 }), shift.id);
  tx.audit('close', 'fuel_shift', shift.id, B, { by: ctx.user.id === shift.user_id ? 'salesman' : 'manager' });
  return tx.commit(idemKey(ctx), { id: shift.id });
}

// ── Lists ───────────────────────────────────────────────────────
/** Shifts in a period with what was collected in each. Salesmen see their own; managers and the owner see all. */
export async function listShifts(ctx: Ctx) {
  bizScope(ctx, B);
  const from = ctx.url.searchParams.get('from') || today(-6);
  const to = ctx.url.searchParams.get('to') || today();
  const all_ = can(ctx.user, 'reports', B);
  const filter = all_ ? '' : ' AND s.user_id = ?';
  const extra = all_ ? [] : [ctx.user.id];
  const [rows, times, methods] = await Promise.all([
    all<any>(ctx.db, `${SHIFT_SELECT} WHERE s.business_id = ? AND s.entry_date BETWEEN ? AND ?${filter} ORDER BY s.number DESC LIMIT 500`, B, from, to, ...extra),
    shiftTimes(ctx.db),
    all(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort'),
  ]);
  const t = await totals(ctx.db, `s.business_id = ? AND s.entry_date BETWEEN ? AND ?${filter}`, B, from, to, ...extra);
  return { from, to, methods, shifts: rows.map((s) => decorate(s, t.get(s.id), times)) };
}

export async function getShift(ctx: Ctx) {
  bizScope(ctx, B);
  const s = await first<any>(ctx.db, `${SHIFT_SELECT} WHERE s.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  if (s.user_id !== ctx.user.id) requireBiz(ctx, B, 'reports');
  const [t, sales, times, methods] = await Promise.all([totals(ctx.db, 's.id = ?', s.id), salesOf(ctx.db, s.id), shiftTimes(ctx.db), all(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort')]);
  return { ...decorate(s, t.get(s.id), times), sales, methods };
}

// ── Numbers for decisions (dashboard and reports) ───────────────
/**
 * For a period: sales per day, per salesman and per shift (Morning/Evening/Night),
 * how it was received, and the same totals for the period just before it.
 */
export async function summary(ctx: Ctx) {
  requireBiz(ctx, B, 'reports');
  const from = ctx.url.searchParams.get('from') || today(-6);
  const to = ctx.url.searchParams.get('to') || today();
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const pFrom = addDays(from, -span), pTo = addDays(from, -1);
  const [days, people, byShift, methods, shifts, prev, prevShifts, rates, byItem] = await Promise.all([
    all<any>(ctx.db, `SELECT entry_date, method_id, COUNT(*) AS n, SUM(amount) AS amount FROM duty_sales WHERE business_id = ? AND status = 'completed' AND entry_date BETWEEN ? AND ?
      GROUP BY entry_date, method_id`, B, from, to),
    all<any>(ctx.db, `SELECT s.user_id, u.full_name AS name, f.method_id, COUNT(*) AS n, SUM(f.amount) AS amount FROM duty_sales f JOIN duty_shifts s ON s.id = f.shift_id JOIN users u ON u.id = s.user_id
      WHERE f.business_id = ? AND f.status = 'completed' AND f.entry_date BETWEEN ? AND ? GROUP BY s.user_id, f.method_id`, B, from, to),
    all<any>(ctx.db, `SELECT s.shift_name AS name, f.method_id, COUNT(*) AS n, SUM(f.amount) AS amount FROM duty_sales f JOIN duty_shifts s ON s.id = f.shift_id
      WHERE f.business_id = ? AND f.status = 'completed' AND f.entry_date BETWEEN ? AND ? GROUP BY s.shift_name, f.method_id`, B, from, to),
    all(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort'),
    all<any>(ctx.db, `SELECT s.user_id, s.shift_name, s.entry_date, s.status FROM duty_shifts s WHERE s.business_id = ? AND s.entry_date BETWEEN ? AND ?`, B, from, to),
    first<any>(ctx.db, `SELECT COALESCE(SUM(amount), 0) AS sold, COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN amount END), 0) AS debts FROM duty_sales
      WHERE business_id = ? AND status = 'completed' AND entry_date BETWEEN ? AND ?`, B, pFrom, pTo),
    first<any>(ctx.db, `SELECT COUNT(*) AS n FROM duty_shifts WHERE business_id = ? AND entry_date BETWEEN ? AND ?`, B, pFrom, pTo),
    all(ctx.db, 'SELECT rate_date, rate, set_at FROM exchange_rates WHERE rate_date <= ?', to),
    all<any>(ctx.db, `SELECT COALESCE(f.item_name, 'Other (no item)') AS name, i.unit, COUNT(*) AS n, ROUND(COALESCE(SUM(f.qty), 0), 3) AS qty, SUM(f.amount) AS amount,
        SUM(ROUND(COALESCE(f.qty, 0) * COALESCE(f.unit_cost, 0))) AS cost FROM duty_sales f LEFT JOIN fuel_items i ON i.id = f.item_id
      WHERE f.business_id = ? AND f.status = 'completed' AND f.entry_date BETWEEN ? AND ? GROUP BY COALESCE(f.item_name, 'Other (no item)') ORDER BY amount DESC`, B, from, to),
  ]);
  // Group rows (one per method, debts under method_id = null) into { sold, debts, by_method, count }.
  const fold = (rows: any[], key: (r: any) => string) => {
    const out = new Map<string, any>();
    for (const r of rows) {
      const k = key(r);
      const x = out.get(k) ?? { key: k, name: r.name ?? k, user_id: r.user_id, sold: 0, debts: 0, count: 0, by_method: {} as Record<string, number> };
      x.sold += r.amount; x.count += r.n;
      if (r.method_id) x.by_method[r.method_id] = r.amount; else x.debts += r.amount;
      out.set(k, x);
    }
    return [...out.values()];
  };
  const shiftsBy = (key: (s: any) => string) => shifts.reduce((m: Record<string, number>, s) => ({ ...m, [key(s)]: (m[key(s)] ?? 0) + 1 }), {});
  const perUser = shiftsBy((s) => s.user_id), perName = shiftsBy((s) => s.shift_name);
  const sum = (rows: any[]) => rows.reduce((t, r) => t + r.amount, 0);
  const debts = sum(days.filter((r) => !r.method_id));
  return {
    from, to, methods, rates, by_item: byItem, shifts: shifts.length,
    total: { sold: sum(days), debts, count: days.reduce((t, r) => t + r.n, 0) },
    previous: { from: pFrom, to: pTo, sold: prev?.sold ?? 0, debts: prev?.debts ?? 0, shifts: prevShifts?.n ?? 0 },
    days: fold(days, (r) => r.entry_date).map((d) => ({ ...d, date: d.key, shifts: shifts.filter((s) => s.entry_date === d.key).length })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    people: fold(people, (r) => r.user_id).map((p) => ({ ...p, shifts: perUser[p.key] ?? 0, average: perUser[p.key] ? Math.round(p.sold / perUser[p.key]) : 0 })).sort((a, b) => b.sold - a.sold),
    by_shift: fold(byShift, (r) => r.name).map((p) => ({ ...p, shifts: perName[p.key] ?? 0, average: perName[p.key] ? Math.round(p.sold / perName[p.key]) : 0 })).sort((a, b) => b.sold - a.sold),
  };
}

/** Alerts for the owner: shifts still open after their time, or open since an earlier day. */
export async function shiftAlerts(db: D1Database, t: string) {
  const [times, open] = await Promise.all([shiftTimes(db), all<any>(db, `${SHIFT_SELECT} WHERE s.business_id = 'fuel' AND s.status = 'open'`)]);
  const out: { level: 'red' | 'yellow'; title: string; detail: string }[] = [];
  for (const s of open) {
    const end = scheduledEnd(times, s.shift_name, s.opened_at);
    const hours = (Date.now() - Date.parse(s.opened_at)) / 3_600_000;
    if (s.entry_date < t) out.push({ level: 'red', title: `${s.user_name}'s ${s.shift_name} shift is still open since ${s.entry_date}`, detail: `Opened ${Math.round(hours)} hours ago. Ask them to close it, or close it from Sales.` });
    else if (end && Date.now() > Date.parse(end)) out.push({ level: 'yellow', title: `${s.user_name}'s ${s.shift_name} shift should have finished`, detail: `Its time ended at ${new Date(Date.parse(end) + EAT).toISOString().slice(11, 16)}.` });
  }
  return out;
}
