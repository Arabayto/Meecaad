// Fuel station shifts, the way the station works:
//   open a shift with the fuel it works with (e.g. 2,000 L worth $2,000) →
//   record each sale (Cash / Zaad / Edahab, or a customer debt) →
//   xisaab xidh: the sales are added up per method; when they match the
//   opening value the shift is done and the next one can open.
// Price per litre = opening value ÷ opening litres (no pumps or fuel types).

import { HttpError, Tx, all, assertDayOpen, bad, bizScope, bool, cents, first, idemKey, newId, nowIso, partyIn, paymentMethod, qty, requireBiz, round3, str, today, type Ctx } from './lib';
import { rateOn } from './fuel';

const B = 'fuel';

/** Totals of a set of shifts: sold, litres, per method, debts. */
async function totals(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const ph = ids.map(() => '?').join(',');
  const [sums, methods] = await Promise.all([
    all<any>(db, `SELECT session_id, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sold, ROUND(COALESCE(SUM(liters), 0), 3) AS liters,
                    COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN amount END), 0) AS debts
                  FROM fuel_sales WHERE session_id IN (${ph}) AND status = 'completed' GROUP BY session_id`, ...ids),
    all<any>(db, `SELECT session_id, method_id, SUM(amount) AS amount FROM fuel_sales
                  WHERE session_id IN (${ph}) AND status = 'completed' AND method_id IS NOT NULL GROUP BY session_id, method_id`, ...ids),
  ]);
  return new Map(ids.map((id) => {
    const s = sums.find((x) => x.session_id === id) ?? { count: 0, sold: 0, liters: 0, debts: 0 };
    return [id, { count: s.count, sold: s.sold, liters: s.liters, debts: s.debts,
      by_method: Object.fromEntries(methods.filter((m) => m.session_id === id).map((m) => [m.method_id, m.amount])) }];
  }));
}

function withTotals(s: any, t: any) {
  const price = s.opening_value / s.opening_liters;   // cents per litre
  const remaining = s.opening_value - t.sold;
  return { ...s, ...t, price, remaining_now: remaining, remaining_liters: round3(remaining / price), matched: remaining === 0 };
}

const SESSION_SELECT = `SELECT s.*, o.full_name AS opened_by_name, c.full_name AS closed_by_name FROM fuel_sessions s
  JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by`;

async function salesOf(db: D1Database, sessionId: string) {
  return all(db, `SELECT f.*, pm.name AS method_name, cu.name AS customer_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
    FROM fuel_sales f LEFT JOIN payment_methods pm ON pm.id = f.method_id LEFT JOIN customers cu ON cu.id = f.customer_id
    JOIN users u ON u.id = f.created_by LEFT JOIN users v ON v.id = f.voided_by
    WHERE f.session_id = ? ORDER BY f.created_at DESC`, sessionId);
}

async function currentRate(db: D1Database) {
  const r = await first<{ rate: number }>(db, 'SELECT rate FROM exchange_rates WHERE rate_date <= ? ORDER BY rate_date DESC, set_at DESC LIMIT 1', today());
  return r?.rate ?? null;
}

/** The open shift (with its sales and totals), or the last closed one to carry over from. */
export async function current(ctx: Ctx) {
  bizScope(ctx, B);
  const [open, last, rate] = await Promise.all([
    first<any>(ctx.db, `${SESSION_SELECT} WHERE s.business_id = ? AND s.status = 'open'`, B),
    first<any>(ctx.db, `${SESSION_SELECT} WHERE s.business_id = ? AND s.status = 'closed' ORDER BY s.closed_at DESC LIMIT 1`, B),
    currentRate(ctx.db),
  ]);
  const t = await totals(ctx.db, [open?.id, last?.id].filter(Boolean));
  return {
    rate,
    shift: open ? withTotals(open, t.get(open.id)) : null,
    sales: open ? await salesOf(ctx.db, open.id) : [],
    last: last ? withTotals(last, t.get(last.id)) : null,
  };
}

export async function openShift(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  if (await first(ctx.db, `SELECT id FROM fuel_sessions WHERE business_id = ? AND status = 'open'`, B)) throw new HttpError(409, 'A shift is already open. Close it first (Xisaab xidh).');
  const liters = qty(ctx.body.liters, 'Litres', { positive: true });
  const value = cents(ctx.body.value, 'Value', { min: 1 });
  // Fuel passed on from the last shift must be part of this one (new fuel is added on top).
  const passed = await first<any>(ctx.db, `SELECT * FROM fuel_sessions WHERE business_id = ? AND status = 'closed' AND carried = 1 AND carried_to IS NULL ORDER BY number DESC LIMIT 1`, B);
  if (passed && (value < passed.remaining || liters < round3(passed.remaining / (passed.opening_value / passed.opening_liters)) - 0.0005)) {
    throw bad(`This shift must include the ${(passed.remaining / 100).toFixed(2)} passed on from shift #${passed.number}. Add any new fuel on top of it.`);
  }
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  if (passed) tx.run('UPDATE fuel_sessions SET carried_to = ? WHERE id = ? AND carried_to IS NULL', id, passed.id);
  tx.run(`INSERT INTO fuel_sessions (id, business_id, number, entry_date, opening_liters, opening_value, note, opened_by, opened_at)
          VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM fuel_sessions WHERE business_id = ?), ?,?,?,?,?,?)`,
    id, B, B, date, liters, value, str(ctx.body.note, 'Note', { max: 300 }), ctx.user.id, nowIso());
  tx.audit('open', 'fuel_shift', id, B, { liters, value });
  try {
    return await tx.commit(idemKey(ctx), { id });
  } catch (e: any) {
    if (/UNIQUE|already exists/i.test(String(e?.message))) throw new HttpError(409, 'A shift is already open. Close it first (Xisaab xidh).');
    throw e;
  }
}

/** One sale: an amount paid by Cash / Zaad / Edahab, or given as a customer debt. Cash may be taken in Shillings. */
export async function createSale(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  const b = ctx.body;
  const shift = await first<any>(ctx.db, `SELECT * FROM fuel_sessions WHERE business_id = ? AND status = 'open'`, B);
  if (!shift) throw new HttpError(409, 'Open a shift first');
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  const debt = Boolean(b.customer);
  const customer = debt ? await partyIn(ctx.db, 'customer', b.customer, B) : null;
  const method = debt ? null : await paymentMethod(ctx.db, b.method);
  let amount: number, slshAmount: number | null = null, rate: number | null = null;
  if (b.slsh !== undefined && b.slsh !== null && b.slsh !== '') {
    if (method !== 'cash') throw bad('Only cash can be taken in Shillings');
    rate = await currentRate(ctx.db);
    if (!rate) throw bad('Set the exchange rate first (Settings)');
    slshAmount = Math.round(Number(String(b.slsh).replace(/,/g, '')));
    if (!Number.isFinite(slshAmount) || slshAmount <= 0) throw bad('Enter the amount in Shillings');
    amount = Math.round((slshAmount / rate) * 100);
    if (amount <= 0) throw bad('The amount is too small');
  } else {
    amount = cents(b.amount, 'Amount', { min: 1 });
  }
  const t = (await totals(ctx.db, [shift.id])).get(shift.id);
  const left = shift.opening_value - t.sold;
  if (amount > left) throw bad(`This is more than the fuel left in this shift (${(left / 100).toFixed(2)}). Check the amount.`);
  const liters = round3(amount / (shift.opening_value / shift.opening_liters));
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO fuel_sales (id, session_id, business_id, entry_date, amount, liters, method_id, customer_id, slsh_amount, rate, note, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, shift.id, B, date, amount, liters, method, customer?.id ?? null, slshAmount, rate, str(b.note, 'Note', { max: 200 }), ctx.user.id, nowIso());
  tx.journal({ business: B, date, type: 'fuel_sale', refType: 'fuel_sale', refId: id, amount,
    memo: `Fuel sale (shift #${shift.number}): ${liters} L${customer ? ` on credit to ${customer.name}` : ''}` }, [
    { account: 'sales', amount: -amount },
    debt ? { account: 'receivable', amount, customer: customer!.id } : { account: 'cash', amount, method },
  ]);
  tx.audit('create', 'fuel_sale', id, B, { amount, liters, method, customer: customer?.name, slsh: slshAmount });
  return tx.commit(idemKey(ctx), { id, amount, liters });
}

/** A wrong sale is cancelled (with a reason) while its shift is still open. */
export async function voidSale(ctx: Ctx) {
  requireBiz(ctx, B, 'void');
  const s = await first<any>(ctx.db, `SELECT f.*, z.status AS shift_status FROM fuel_sales f JOIN fuel_sessions z ON z.id = f.session_id WHERE f.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  if (s.status !== 'completed') throw new HttpError(409, 'Already cancelled');
  if (s.shift_status !== 'open') throw new HttpError(409, 'This shift is already closed');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, B, date);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE fuel_sales SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), s.id);
  await tx.reverse('fuel_sale', s.id, date, 'fuel_sale_void', `Cancelled fuel sale: ${reason}`);
  tx.audit('void', 'fuel_sale', s.id, B, { reason, amount: s.amount });
  return tx.commit(idemKey(ctx), { id: s.id });
}

/** Xisaab xidh: close the open shift. When the sales do not match the opening value, explain why. */
export async function closeShift(ctx: Ctx) {
  requireBiz(ctx, B, 'fuel');
  const shift = await first<any>(ctx.db, `SELECT * FROM fuel_sessions WHERE business_id = ? AND status = 'open'`, B);
  if (!shift) throw new HttpError(409, 'No shift is open');
  const t = (await totals(ctx.db, [shift.id])).get(shift.id);
  const remaining = shift.opening_value - t.sold;
  // Fuel left over can be passed to the next shift (then it is not a mismatch).
  const carry = bool(ctx.body.carry);
  if (carry && remaining <= 0) throw bad('There is nothing left to pass to the next shift');
  const explanation = str(ctx.body.explanation, 'Explanation', { max: 500 }) ?? (carry ? 'Passed to the next shift' : null);
  if (remaining !== 0 && !explanation) throw bad(`The sales are ${(remaining / 100).toFixed(2)} ${remaining > 0 ? 'less' : 'more'} than the opening value. Pass the rest to the next shift, or explain before closing.`);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE fuel_sessions SET status = 'closed', closed_by = ?, closed_at = ?, sold_total = ?, remaining = ?, explanation = ?, carried = ? WHERE id = ? AND status = 'open'`,
    ctx.user.id, nowIso(), t.sold, remaining, explanation, carry ? 1 : 0, shift.id);
  tx.audit('close', 'fuel_shift', shift.id, B, { opening: shift.opening_value, sold: t.sold, remaining, explanation, carried: carry });
  return tx.commit(idemKey(ctx), { id: shift.id, sold: t.sold, remaining, carried: carry });
}

/** All shifts in a period with their totals (Shifts page, dashboard, reports). */
export async function listShifts(ctx: Ctx) {
  bizScope(ctx, B);
  const from = ctx.url.searchParams.get('from') || today(-6);
  const to = ctx.url.searchParams.get('to') || today();
  const [rows, rates] = await Promise.all([
    all<any>(ctx.db, `${SESSION_SELECT} WHERE s.business_id = ? AND s.entry_date BETWEEN ? AND ? ORDER BY s.number DESC LIMIT 500`, B, from, to),
    all<any>(ctx.db, 'SELECT rate_date, rate, set_at FROM exchange_rates WHERE rate_date <= ?', to),
  ]);
  const t = await totals(ctx.db, rows.map((r) => r.id));
  const methods = await all(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort');
  return { from, to, methods, shifts: rows.map((r) => ({ ...withTotals(r, t.get(r.id)), rate: rateOn(rates, r.entry_date) })) };
}

export async function getShift(ctx: Ctx) {
  bizScope(ctx, B);
  const s = await first<any>(ctx.db, `${SESSION_SELECT} WHERE s.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  const [t, sales, methods] = await Promise.all([totals(ctx.db, [s.id]), salesOf(ctx.db, s.id), all(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort')]);
  return { ...withTotals(s, t.get(s.id)), sales, methods };
}
