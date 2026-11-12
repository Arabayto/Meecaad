// Fuel station: shift meter readings (the fuel sales), tank dips, and reconciliation.
//
// A shift record says: these pumps moved from opening to closing meter, so
// N litres were sold and the money expected is N × price. Then the staff
// enter what they actually received (cash, Zaad, Edahab) and what was given
// on credit. Any gap is a visible shortage/overage that needs a reason.

import {
  HttpError, Tx, all, assertDayOpen, bad, bizScope, cents, entryDate, first, idemKey, newId, nowIso, paymentMethod, partyIn, qty, requireBiz, round3, str, today,
  type Ctx, type Line,
} from './lib';

/** How the money was received: cash / Zaad / Edahab amounts and debts (credit given to customers). */
async function receipts(ctx: Ctx, business: string, b: any) {
  const payments: { method: string; amount: number }[] = [];
  for (const p of Array.isArray(b.payments) ? b.payments : []) {
    const amount = cents(p.amount, 'Amount received', { required: false });
    if (amount > 0) payments.push({ method: await paymentMethod(ctx.db, p.method), amount });
  }
  const credits: { customer: string; name: string; amount: number }[] = [];
  for (const c of Array.isArray(b.credits) ? b.credits : []) {
    const amount = cents(c.amount, 'Debt amount', { required: false });
    if (amount <= 0) continue;
    if (!c.customer) throw bad('Choose the customer for each debt');
    const cust = (await partyIn(ctx.db, 'customer', c.customer, business))!;
    credits.push({ customer: cust.id, name: cust.name, amount });
  }
  return { payments, credits };
}

export async function createShift(ctx: Ctx) {
  const business = requireBiz(ctx, 'fuel', 'fuel');
  const b = ctx.body;
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  const pumps = await all<any>(ctx.db,
    `SELECT pu.*, t.product_id, p.name AS fuel_name, p.sale_price, p.avg_cost FROM fuel_pumps pu
     JOIN fuel_tanks t ON t.id = pu.tank_id JOIN products p ON p.id = t.product_id WHERE pu.active = 1`);
  const seen = new Set<string>();
  const gaps: string[] = [];
  const readings = (Array.isArray(b.readings) ? b.readings : []).map((r: any) => {
    const pump = pumps.find((p) => p.id === String(r.pump));
    if (!pump) throw bad('Unknown pump');
    if (seen.has(pump.id)) throw bad(`${pump.name} is entered twice`);
    seen.add(pump.id);
    const opening = r.opening === undefined || r.opening === '' ? pump.last_meter : qty(r.opening, `${pump.name} opening meter`, { min: 0 });
    const closing = qty(r.closing, `${pump.name} closing meter`, { min: 0 });
    if (closing < opening) throw bad(`${pump.name}: closing meter (${closing}) is lower than opening (${opening})`);
    if (Math.abs(opening - pump.last_meter) >= 0.0005) gaps.push(`${pump.name}: opening ${opening} but last closing was ${pump.last_meter}`);
    const liters = round3(closing - opening);
    return { id: newId(), pump, opening, closing, liters, amount: Math.round(liters * pump.sale_price), cost: Math.round(liters * pump.avg_cost) };
  });
  if (!readings.length) throw bad('Enter the closing meter of at least one pump');

  const { payments, credits } = await receipts(ctx, business, b);
  const expected = readings.reduce((s: number, r: any) => s + r.amount, 0);
  const collected = payments.reduce((s, p) => s + p.amount, 0);
  const credit = credits.reduce((s, c) => s + c.amount, 0);
  const difference = collected + credit - expected;
  const given = str(b.differenceReason, 'Note', { max: 300 });
  // Money still to be accounted for is allowed (it stays "outstanding" until it is received);
  // more money than the sales needs an explanation.
  if (difference > 0 && !given) {
    throw bad(`Money received is over by ${(difference / 100).toFixed(2)}. Explain the difference before saving.`);
  }
  const reason = difference === 0 ? null : given ?? 'Not yet accounted for (outstanding)';
  const cost = readings.reduce((s: number, r: any) => s + r.cost, 0);
  const liters = round3(readings.reduce((s: number, r: any) => s + r.liters, 0));
  const shiftName = str(b.shiftName, 'Shift', { max: 40 }) ?? 'Day';

  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO fuel_shifts (id, business_id, entry_date, shift_name, total_liters, expected_amount, collected_amount, credit_amount, difference,
            difference_reason, meter_gap_note, cost_total, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, business, date, shiftName, liters, expected, collected, credit, difference, reason, gaps.length ? gaps.join('; ') : null,
    cost, str(b.note, 'Note', { max: 300 }), ctx.user.id, nowIso());
  for (const r of readings) {
    tx.run(`INSERT INTO fuel_shift_readings (id, shift_id, pump_id, tank_id, product_id, opening_meter, closing_meter, liters, unit_price, amount, unit_cost)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, r.id, id, r.pump.id, r.pump.tank_id, r.pump.product_id, r.opening, r.closing, r.liters, r.pump.sale_price, r.amount, r.pump.avg_cost);
    tx.run('UPDATE fuel_pumps SET last_meter = ? WHERE id = ?', r.closing, r.pump.id);
    if (r.liters > 0) {
      tx.stock({ business, product: r.pump.product_id, tank: r.pump.tank_id, date, type: 'fuel_sale', qty: -r.liters, unitCost: r.pump.avg_cost, value: -r.cost, refType: 'fuel_shift', refId: id });
    }
  }
  for (const p of payments) tx.run('INSERT INTO fuel_shift_payments (id, shift_id, method_id, amount) VALUES (?,?,?,?)', newId(), id, p.method, p.amount);
  for (const c of credits) tx.run('INSERT INTO fuel_shift_payments (id, shift_id, customer_id, amount) VALUES (?,?,?,?)', newId(), id, c.customer, c.amount);
  tx.journal({ business, date, type: 'fuel_shift', refType: 'fuel_shift', refId: id, amount: expected,
    memo: `Fuel sales ${shiftName}: ${liters} L${difference ? ` (${difference < 0 ? 'outstanding' : 'over'} ${(Math.abs(difference) / 100).toFixed(2)})` : ''}` }, [
    { account: 'sales', amount: -expected },
    ...payments.map((p): Line => ({ account: 'cash', amount: p.amount, method: p.method })),
    ...credits.map((c): Line => ({ account: 'receivable', amount: c.amount, customer: c.customer })),
    { account: 'cash_diff', amount: -difference, category: 'Fuel shift' },
    { account: 'cogs', amount: cost },
    { account: 'inventory', amount: -cost },
  ]);
  tx.audit('create', 'fuel_shift', id, business, { liters, expected, collected, credit, difference, gaps });
  return tx.commit(idemKey(ctx), { id, liters, expected, difference });
}

export async function listShifts(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const from = ctx.url.searchParams.get('from') || today(-30);
  const to = ctx.url.searchParams.get('to') || today();
  return all(ctx.db,
    `SELECT s.*, u.full_name AS created_by_name FROM fuel_shifts s JOIN users u ON u.id = s.created_by
     WHERE s.business_id = 'fuel' AND s.entry_date BETWEEN ? AND ? ORDER BY s.entry_date DESC, s.created_at DESC`, from, to);
}

export async function getShift(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const s = await first<any>(ctx.db, `SELECT s.*, u.full_name AS created_by_name, v.full_name AS voided_by_name FROM fuel_shifts s
    JOIN users u ON u.id = s.created_by LEFT JOIN users v ON v.id = s.voided_by WHERE s.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Shift not found');
  const [readings, payments] = await Promise.all([
    all(ctx.db, `SELECT r.*, pu.name AS pump_name, p.name AS fuel_name, t.name AS tank_name FROM fuel_shift_readings r JOIN fuel_pumps pu ON pu.id = r.pump_id
                 JOIN products p ON p.id = r.product_id JOIN fuel_tanks t ON t.id = r.tank_id WHERE shift_id = ? ORDER BY pu.name`, s.id),
    all(ctx.db, `SELECT fp.*, pm.name AS method_name, c.name AS customer_name FROM fuel_shift_payments fp LEFT JOIN payment_methods pm ON pm.id = fp.method_id
                 LEFT JOIN customers c ON c.id = fp.customer_id WHERE shift_id = ?`, s.id),
  ]);
  return { ...s, readings, payments };
}

export async function voidShift(ctx: Ctx) {
  const business = requireBiz(ctx, 'fuel', 'void');
  const s = await first<any>(ctx.db, 'SELECT * FROM fuel_shifts WHERE id = ?', ctx.params.id);
  if (!s) throw new HttpError(404, 'Shift not found');
  if (s.status !== 'completed') throw new HttpError(409, 'This shift is already cancelled');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  const readings = await all<any>(ctx.db, 'SELECT r.*, pu.last_meter FROM fuel_shift_readings r JOIN fuel_pumps pu ON pu.id = r.pump_id WHERE shift_id = ?', s.id);
  for (const r of readings) {
    if (Math.abs(r.last_meter - r.closing_meter) >= 0.0005) throw new HttpError(409, 'A later shift used these pumps. Cancel the later shift first.');
  }
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE fuel_shifts SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'completed'`, reason, ctx.user.id, nowIso(), s.id);
  for (const r of readings) {
    tx.run('UPDATE fuel_pumps SET last_meter = ? WHERE id = ?', r.opening_meter, r.pump_id);
    if (r.liters > 0) {
      const value = Math.round(r.liters * r.unit_cost);
      tx.run(`UPDATE products SET avg_cost = CASE WHEN MAX(stock_qty, 0) + ? > 0.0005 THEN (MAX(stock_qty, 0) * avg_cost + ?) / (MAX(stock_qty, 0) + ?) ELSE avg_cost END WHERE id = ?`,
        r.liters, value, r.liters, r.product_id);
      tx.stock({ business, product: r.product_id, tank: r.tank_id, date, type: 'fuel_sale_void', qty: r.liters, unitCost: r.unit_cost, value, refType: 'fuel_shift', refId: s.id, reason });
    }
  }
  await tx.reverse('fuel_shift', s.id, date, 'fuel_shift_void', `Cancelled fuel shift (${s.entry_date} ${s.shift_name}): ${reason}`);
  tx.audit('void', 'fuel_shift', s.id, business, { reason });
  return tx.commit(idemKey(ctx), { id: s.id });
}

/** A physical dip of a tank. The gap from the book stock is recorded and costed. */
export async function createDip(ctx: Ctx) {
  const business = requireBiz(ctx, 'fuel', 'fuel');
  const b = ctx.body;
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  const t = await first<any>(ctx.db, 'SELECT t.*, p.avg_cost, p.name AS fuel_name FROM fuel_tanks t JOIN products p ON p.id = t.product_id WHERE t.id = ? AND t.active = 1', String(b.tank ?? ''));
  if (!t) throw bad('Choose the tank');
  const measured = qty(b.measuredQty, 'Measured litres', { min: 0 });
  const variance = round3(measured - t.stock_qty);
  const reason = str(b.reason, 'Reason', { max: 300 });
  if (variance !== 0 && !reason) {
    throw bad(`The tank has ${Math.abs(variance)} L ${variance < 0 ? 'less' : 'more'} than the system expects. Give a reason (e.g. evaporation, leak, meter error).`);
  }
  const value = Math.round(variance * t.avg_cost);
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO tank_dips (id, tank_id, business_id, entry_date, book_qty, measured_qty, variance, variance_value, reason, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, t.id, business, date, t.stock_qty, measured, variance, value, reason, ctx.user.id, nowIso());
  if (variance !== 0) {
    tx.stock({ business, product: t.product_id, tank: t.id, date, type: 'tank_dip', qty: variance, unitCost: t.avg_cost, value, refType: 'tank_dip', refId: id, reason });
    tx.journal({ business, date, type: 'tank_dip', refType: 'tank_dip', refId: id, amount: Math.abs(value),
      memo: `Tank dip ${t.name}: ${variance > 0 ? '+' : ''}${variance} L ${t.fuel_name} — ${reason}` },
      [{ account: 'inventory', amount: value }, { account: 'stock_loss', amount: -value, category: 'Fuel tank variance' }]);
  }
  tx.audit('create', 'tank_dip', id, business, { tank: t.name, book: t.stock_qty, measured, variance, reason });
  return tx.commit(idemKey(ctx), { id, variance, value });
}

export async function listDips(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  return all(ctx.db, `SELECT d.*, t.name AS tank_name, p.name AS fuel_name, u.full_name AS created_by_name FROM tank_dips d
    JOIN fuel_tanks t ON t.id = d.tank_id JOIN products p ON p.id = t.product_id JOIN users u ON u.id = d.created_by
    ORDER BY d.entry_date DESC, d.created_at DESC LIMIT 200`);
}

/**
 * Per tank, for a period: book stock at the start, + deliveries, − litres sold
 * by the meters, ± dip variances = book stock at the end; and the last dip.
 */
export async function reconciliation(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const from = ctx.url.searchParams.get('from') || today(-6);
  const to = ctx.url.searchParams.get('to') || today();
  const tanks = await all<any>(ctx.db,
    `SELECT t.id, t.name, t.capacity, t.stock_qty, p.name AS fuel_name, p.sale_price, p.avg_cost,
       COALESCE((SELECT SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date < ?), 0) AS opening,
       COALESCE((SELECT SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date BETWEEN ? AND ? AND type IN ('purchase', 'purchase_void')), 0) AS delivered,
       COALESCE((SELECT -SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date BETWEEN ? AND ? AND type IN ('fuel_sale', 'fuel_sale_void')), 0) AS sold,
       COALESCE((SELECT SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date BETWEEN ? AND ? AND type = 'tank_dip'), 0) AS dip_variance,
       COALESCE((SELECT SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date BETWEEN ? AND ? AND type = 'opening'), 0) AS opened,
       COALESCE((SELECT SUM(qty) FROM stock_movements WHERE tank_id = t.id AND entry_date <= ?), 0) AS closing,
       (SELECT measured_qty FROM tank_dips WHERE tank_id = t.id AND entry_date <= ? ORDER BY entry_date DESC, created_at DESC LIMIT 1) AS last_dip_qty,
       (SELECT entry_date FROM tank_dips WHERE tank_id = t.id AND entry_date <= ? ORDER BY entry_date DESC, created_at DESC LIMIT 1) AS last_dip_date
     FROM fuel_tanks t JOIN products p ON p.id = t.product_id WHERE t.active = 1 ORDER BY t.name`,
    from, from, to, from, to, from, to, from, to, to, to, to);
  const days = await all<any>(ctx.db,
    `SELECT entry_date, COUNT(*) AS shifts, ROUND(SUM(total_liters), 3) AS liters, SUM(expected_amount) AS expected, SUM(collected_amount) AS collected,
            SUM(credit_amount) AS credit, SUM(difference) AS difference
     FROM fuel_shifts WHERE business_id = 'fuel' AND status = 'completed' AND entry_date BETWEEN ? AND ? GROUP BY entry_date ORDER BY entry_date DESC`, from, to);
  const byFuel = await all<any>(ctx.db,
    `SELECT p.name AS fuel_name, ROUND(SUM(r.liters), 3) AS liters, SUM(r.amount) AS amount
     FROM fuel_shift_readings r JOIN fuel_shifts s ON s.id = r.shift_id JOIN products p ON p.id = r.product_id
     WHERE s.business_id = 'fuel' AND s.status = 'completed' AND s.entry_date BETWEEN ? AND ? GROUP BY p.id ORDER BY p.name`, from, to);
  return { from, to, tanks, days, byFuel };
}

/** Money that arrives after the sales were recorded: it settles (part of) the outstanding amount. */
export async function settleShift(ctx: Ctx) {
  const business = requireBiz(ctx, 'fuel', 'fuel');
  const sh = await first<any>(ctx.db, 'SELECT * FROM fuel_shifts WHERE id = ?', ctx.params.id);
  if (!sh) throw new HttpError(404, 'Not found');
  if (sh.status !== 'completed') throw new HttpError(409, 'This entry was cancelled');
  if (sh.difference >= 0) throw new HttpError(409, 'Nothing is outstanding on this entry');
  const date = today();
  await assertDayOpen(ctx.db, business, date);
  const { payments, credits } = await receipts(ctx, business, ctx.body);
  const received = payments.reduce((t, p) => t + p.amount, 0);
  const debts = credits.reduce((t, c) => t + c.amount, 0);
  const total = received + debts;
  if (total <= 0) throw bad('Enter what was received');
  if (total > -sh.difference) throw bad(`Only ${(-sh.difference / 100).toFixed(2)} is outstanding`);
  const tx = new Tx(ctx.db, ctx.user);
  for (const p of payments) tx.run('INSERT INTO fuel_shift_payments (id, shift_id, method_id, amount, settled_at) VALUES (?,?,?,?,?)', newId(), sh.id, p.method, p.amount, nowIso());
  for (const c of credits) tx.run('INSERT INTO fuel_shift_payments (id, shift_id, customer_id, amount, settled_at) VALUES (?,?,?,?,?)', newId(), sh.id, c.customer, c.amount, nowIso());
  tx.run(`UPDATE fuel_shifts SET collected_amount = collected_amount + ?, credit_amount = credit_amount + ?, difference = difference + ? WHERE id = ? AND status = 'completed'`, received, debts, total, sh.id);
  tx.journal({ business, date, type: 'fuel_settle', refType: 'fuel_shift', refId: sh.id, amount: total,
    memo: `Fuel sales ${sh.entry_date} ${sh.shift_name}: ${(total / 100).toFixed(2)} received later` }, [
    ...payments.map((p): Line => ({ account: 'cash', amount: p.amount, method: p.method })),
    ...credits.map((c): Line => ({ account: 'receivable', amount: c.amount, customer: c.customer })),
    { account: 'cash_diff', amount: -total, category: 'Fuel shift' },
  ]);
  tx.audit('settle', 'fuel_shift', sh.id, business, { received, debts, remaining: -sh.difference - total });
  return tx.commit(idemKey(ctx), { id: sh.id, remaining: -sh.difference - total });
}

// ── Exchange rate (USD → Somaliland Shillings) ───────────────────
/** The rate in force on a day: the latest one set on or before it. */
export function rateOn(rates: { rate_date: string; rate: number; set_at: string }[], day: string): number | null {
  let best: { rate_date: string; rate: number; set_at: string } | null = null;
  for (const r of rates) {
    if (r.rate_date > day) continue;
    if (!best || r.rate_date > best.rate_date || (r.rate_date === best.rate_date && r.set_at > best.set_at)) best = r;
  }
  return best?.rate ?? null;
}

export async function getRates(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const history = await all<any>(ctx.db, `SELECT r.id, r.rate_date, r.rate, r.set_at, u.full_name AS set_by_name FROM exchange_rates r JOIN users u ON u.id = r.set_by
                                          ORDER BY r.rate_date DESC, r.set_at DESC LIMIT 60`);
  const t = today();
  const current = history.find((r) => r.rate_date <= t) ?? null;   // newest first, so the first one on or before today
  return { today: t, current, setToday: current?.rate_date === t, history };
}

export async function setRate(ctx: Ctx) {
  const business = requireBiz(ctx, 'fuel', 'catalog');
  const rate = Math.round(Number(String(ctx.body.rate ?? '').replace(/,/g, '')) * 100) / 100;
  if (!Number.isFinite(rate) || rate < 1 || rate > 10_000_000) throw bad('Enter how many Somaliland Shillings equal $1 (for example 11,900)');
  const date = entryDate(ctx.body.date);
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('INSERT INTO exchange_rates (id, rate_date, rate, set_by, set_at) VALUES (?,?,?,?,?)', id, date, rate, ctx.user.id, nowIso());
  tx.audit('set_rate', 'exchange_rate', id, business, { date, rate });
  return tx.commit(idemKey(ctx), { id, rate });
}

// ── Daily accounting ─────────────────────────────────────────────
/**
 * Per day: sales (litres × price), how it was received per payment method,
 * debts, and what is still outstanding — with the day's SLSH rate.
 */
export async function days(ctx: Ctx) {
  bizScope(ctx, 'fuel');
  const from = ctx.url.searchParams.get('from') || today(-6);
  const to = ctx.url.searchParams.get('to') || today();
  const [rows, byMethod, methods, rates] = await Promise.all([
    all<any>(ctx.db, `SELECT entry_date, COUNT(*) AS entries, ROUND(SUM(total_liters), 3) AS liters, SUM(expected_amount) AS sales,
        SUM(collected_amount) AS received, SUM(credit_amount) AS debts, SUM(difference) AS difference
      FROM fuel_shifts WHERE business_id = 'fuel' AND status = 'completed' AND entry_date BETWEEN ? AND ? GROUP BY entry_date ORDER BY entry_date DESC`, from, to),
    all<any>(ctx.db, `SELECT s.entry_date, fp.method_id, SUM(fp.amount) AS amount FROM fuel_shift_payments fp JOIN fuel_shifts s ON s.id = fp.shift_id
      WHERE s.business_id = 'fuel' AND s.status = 'completed' AND s.entry_date BETWEEN ? AND ? AND fp.method_id IS NOT NULL GROUP BY s.entry_date, fp.method_id`, from, to),
    all<any>(ctx.db, 'SELECT id, name FROM payment_methods WHERE active = 1 ORDER BY sort'),
    all<any>(ctx.db, 'SELECT rate_date, rate, set_at FROM exchange_rates WHERE rate_date <= ?', to),
  ]);
  return {
    from, to, methods,
    days: rows.map((d) => ({
      ...d, outstanding: -d.difference,   // negative = more received than sales
      by_method: Object.fromEntries(byMethod.filter((m) => m.entry_date === d.entry_date).map((m) => [m.method_id, m.amount])),
      rate: rateOn(rates, d.entry_date),
    })),
  };
}
