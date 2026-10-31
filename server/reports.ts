// Owner dashboard, reports, daily cash closing, alerts and audit log.
// Every figure is calculated from saved journal lines and stock records.

import {
  HttpError, Tx, addDays, all, assertDayOpen, bad, bizScope, cents, entryDate, first, idemKey, newId, nowIso, placeholders, requireBiz, str, today,
  type Ctx,
} from './lib';

const PNL_ACCOUNTS = ['sales', 'cogs', 'expense', 'stock_loss', 'cash_diff'];

export interface Pnl { revenue: number; cogs: number; expenses: number; losses: number; cashDiff: number; grossProfit: number; profit: number }
const emptyPnl = (): Pnl => ({ revenue: 0, cogs: 0, expenses: 0, losses: 0, cashDiff: 0, grossProfit: 0, profit: 0 });

/** P&L amounts per day, business and account, from the daily totals (not the full journal). */
function pnlRows(db: D1Database, scope: string[], from: string, to: string) {
  return all<{ entry_date: string; business_id: string; account: string; total: number }>(db,
    `SELECT entry_date, business_id, account, SUM(debit - credit) AS total FROM daily_totals
     WHERE business_id IN (${placeholders(scope)}) AND entry_date BETWEEN ? AND ? AND account IN (${placeholders(PNL_ACCOUNTS)})
     GROUP BY entry_date, business_id, account`, ...scope, from, to, ...PNL_ACCOUNTS);
}

/** Profit and loss per business for a date range (plus 'all'). */
async function pnl(db: D1Database, scope: string[], from: string, to: string) {
  return sumPnl(scope, await pnlRows(db, scope, from, to));
}

function sumPnl(scope: string[], rows: { business_id: string; account: string; total: number }[]) {
  const out: Record<string, Pnl> = { all: emptyPnl() };
  for (const b of scope) out[b] = emptyPnl();
  for (const r of rows) {
    for (const key of [r.business_id, 'all']) {
      const p = out[key];
      if (r.account === 'sales') p.revenue += -r.total;
      if (r.account === 'cogs') p.cogs += r.total;
      if (r.account === 'expense') p.expenses += r.total;
      if (r.account === 'stock_loss') p.losses += r.total;
      if (r.account === 'cash_diff') p.cashDiff += r.total;
    }
  }
  for (const p of Object.values(out)) {
    p.grossProfit = p.revenue - p.cogs;
    p.profit = p.grossProfit - p.expenses - p.losses - p.cashDiff;
  }
  return out;
}

const MONDAY = (d: string) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));

function periods(t: string) {
  const weekStart = MONDAY(t);
  const dayInWeek = Math.round((Date.parse(t) - Date.parse(weekStart)) / 86_400_000);
  const monthStart = t.slice(0, 8) + '01';
  const lastMonthStart = addDays(monthStart, -1).slice(0, 8) + '01';
  const lastMonthEnd = addDays(monthStart, -1);
  const sameDayLastMonth = lastMonthStart.slice(0, 8) + t.slice(8);
  return {
    today: [t, t], yesterday: [addDays(t, -1), addDays(t, -1)],
    week: [weekStart, t], lastWeek: [addDays(weekStart, -7), addDays(weekStart, dayInWeek - 7)],
    month: [monthStart, t], lastMonth: [lastMonthStart, sameDayLastMonth < lastMonthEnd ? sameDayLastMonth : lastMonthEnd],
  } as Record<string, [string, string]>;
}

const CLOSING_GROUPS: Record<string, string> = {
  sale: 'sales_in', sale_void: 'sales_in', sale_return: 'sales_in', fuel_shift: 'sales_in', fuel_shift_void: 'sales_in',
  customer_payment: 'collections', customer_payment_void: 'collections',
  expense: 'expenses_out', expense_void: 'expenses_out',
  purchase: 'suppliers_out', purchase_void: 'suppliers_out', supplier_payment: 'suppliers_out', supplier_payment_void: 'suppliers_out',
  transfer: 'transfers', transfer_void: 'transfers', owner_in: 'transfers', owner_in_void: 'transfers', owner_out: 'transfers', owner_out_void: 'transfers',
};

/** Money in and out of every account of a business on one day. */
async function closingLines(db: D1Database, business: string, date: string) {
  const methods = await all<any>(db, 'SELECT id, name, active FROM payment_methods ORDER BY sort');
  // Opening = balance now − everything from this day on (reads only recent days, never the whole history).
  const [current, since, day] = await Promise.all([
    all<any>(db, `SELECT method_id, balance FROM account_balances WHERE business_id = ? AND account = 'cash'`, business),
    all<any>(db, `SELECT method_id, SUM(debit - credit) AS total FROM daily_totals WHERE business_id = ? AND entry_date >= ? AND account = 'cash' GROUP BY method_id`, business, date),
    all<any>(db, `SELECT method_id, entry_type, SUM(debit - credit) AS total, SUM(debit + credit) AS n FROM daily_totals
                  WHERE business_id = ? AND entry_date = ? AND account = 'cash' AND entry_type NOT IN ('closing_diff', 'closing_reopen') GROUP BY method_id, entry_type`, business, date),
  ]);
  return methods.map((m) => {
    const opening = (current.find((o) => o.method_id === m.id)?.balance ?? 0) - (since.find((o) => o.method_id === m.id)?.total ?? 0);
    const line: any = { method_id: m.id, method_name: m.name, opening,
      sales_in: 0, collections: 0, expenses_out: 0, suppliers_out: 0, transfers: 0, other: 0, activity: 0 };
    for (const d of day.filter((x) => x.method_id === m.id)) {
      line[CLOSING_GROUPS[d.entry_type] ?? 'other'] += d.total;
      line.activity += d.n;
    }
    line.expected = line.opening + line.sales_in + line.collections + line.expenses_out + line.suppliers_out + line.transfers + line.other;
    line.required = m.active === 1 || line.expected !== 0 || line.activity > 0;
    return line;
  }).filter((l) => l.required);
}

// ── Dashboard ───────────────────────────────────────────────────
export async function dashboard(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const t = today();
  const ps = periods(t);
  const p = placeholders(scope);
  const [figures, cash, receivable, payable, inventory, flow, activity, closings, alerts] = await Promise.all([
    // One read of the daily totals covers all six periods (oldest is last month's start).
    pnlRows(ctx.db, scope, ps.lastMonth[0] < ps.lastWeek[0] ? ps.lastMonth[0] : ps.lastWeek[0], t).then((rows) =>
      Object.fromEntries(Object.entries(ps).map(([k, [f, to]]) => [k, sumPnl(scope, rows.filter((r) => r.entry_date >= f && r.entry_date <= to))]))),
    all(ctx.db, `SELECT b.business_id, b.method_id, pm.name AS method_name, b.balance FROM account_balances b JOIN payment_methods pm ON pm.id = b.method_id
                 WHERE b.account = 'cash' AND b.business_id IN (${p}) ORDER BY pm.sort`, ...scope),
    all(ctx.db, `SELECT business_id, SUM(balance) AS total, COUNT(*) AS parties FROM account_balances
                 WHERE account = 'receivable' AND business_id IN (${p}) AND balance <> 0 GROUP BY business_id`, ...scope),
    all(ctx.db, `SELECT business_id, -SUM(balance) AS total, COUNT(*) AS parties FROM account_balances
                 WHERE account = 'payable' AND business_id IN (${p}) AND balance <> 0 GROUP BY business_id`, ...scope),
    all(ctx.db, `SELECT business_id, ROUND(SUM(stock_qty * avg_cost)) AS value FROM products WHERE business_id IN (${p}) AND track_stock = 1 GROUP BY business_id`, ...scope),
    all(ctx.db, `SELECT business_id, entry_type, SUM(debit) AS money_in, SUM(credit) AS money_out
                 FROM daily_totals WHERE business_id IN (${p}) AND entry_date = ? AND account = 'cash' GROUP BY business_id, entry_type`, ...scope, t),
    all(ctx.db, `SELECT e.id, e.business_id, e.entry_date, e.type, e.memo, e.amount, e.ref_type, e.ref_id, e.created_at, u.full_name AS created_by_name
                 FROM journal_entries e INDEXED BY idx_journal_created JOIN users u ON u.id = e.created_by
                 WHERE e.business_id IN (${p}) ORDER BY e.created_at DESC LIMIT 25`, ...scope),
    all(ctx.db, `SELECT business_id, MAX(entry_date) AS last_closed FROM daily_closings WHERE status = 'closed' AND business_id IN (${p}) GROUP BY business_id`, ...scope),
    buildAlerts(ctx.db, scope),
  ]);
  return { business: ctx.url.searchParams.get('business') || 'all', today: t, periods: ps, scope, figures, cash, receivable, payable, inventory, flow, activity, closings, alerts };
}

async function buildAlerts(db: D1Database, scope: string[]) {
  const p = placeholders(scope);
  const t = today();
  const alerts: { level: 'red' | 'yellow'; business: string; title: string; detail: string; link: string }[] = [];
  const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const low = await all<any>(db, `SELECT business_id, name, stock_qty, reorder_level, unit FROM products
    WHERE business_id IN (${p}) AND active = 1 AND track_stock = 1 AND kind <> 'fuel' AND (stock_qty <= 0 OR stock_qty <= reorder_level) ORDER BY stock_qty LIMIT 30`, ...scope);
  for (const r of low) {
    alerts.push({ level: r.stock_qty <= 0 ? 'red' : 'yellow', business: r.business_id, title: r.stock_qty <= 0 ? `Out of stock: ${r.name}` : `Low stock: ${r.name}`,
      detail: `${r.stock_qty} ${r.unit} left (low level ${r.reorder_level})`, link: '/stock' });
  }
  if (scope.includes('fuel')) {
    for (const r of await all<any>(db, `SELECT t.name, t.stock_qty, t.capacity, p.name AS fuel FROM fuel_tanks t JOIN products p ON p.id = t.product_id
                                        WHERE t.active = 1 AND (t.stock_qty < 0 OR (t.capacity > 0 AND t.stock_qty < t.capacity * 0.15))`)) {
      alerts.push({ level: r.stock_qty < 0 ? 'red' : 'yellow', business: 'fuel', title: r.stock_qty < 0 ? `Tank below zero: ${r.name}` : `Tank low: ${r.name}`,
        detail: r.stock_qty < 0 ? `Book stock is ${r.stock_qty} L ${r.fuel}. A delivery may be missing, or meters/dips are wrong.` : `${r.stock_qty} L of ${r.capacity} L ${r.fuel}`, link: '/fuel' });
    }
    for (const r of await all<any>(db, `SELECT d.*, t.name AS tank FROM tank_dips d JOIN fuel_tanks t ON t.id = d.tank_id
                                        WHERE d.entry_date >= ? AND ABS(d.variance) >= MAX(20, ABS(d.book_qty) * 0.005) ORDER BY d.entry_date DESC`, addDays(t, -14))) {
      alerts.push({ level: r.variance < 0 ? 'red' : 'yellow', business: 'fuel', title: `Fuel ${r.variance < 0 ? 'missing' : 'extra'} in ${r.tank}`,
        detail: `${r.entry_date}: dip ${r.measured_qty} L vs book ${r.book_qty} L (${r.variance > 0 ? '+' : ''}${r.variance} L, ${money(r.variance_value)}). ${r.reason ?? ''}`, link: '/fuel' });
    }
    for (const r of await all<any>(db, `SELECT * FROM fuel_shifts WHERE business_id = 'fuel' AND status = 'completed' AND entry_date >= ? AND (difference <> 0 OR meter_gap_note IS NOT NULL) ORDER BY entry_date DESC`, addDays(t, -7))) {
      if (r.difference) alerts.push({ level: r.difference < 0 ? 'red' : 'yellow', business: 'fuel', title: `Fuel shift ${r.difference < 0 ? 'short' : 'over'} ${money(Math.abs(r.difference))}`,
        detail: `${r.entry_date} ${r.shift_name}: ${r.difference_reason}`, link: '/fuel' });
      if (r.meter_gap_note) alerts.push({ level: 'red', business: 'fuel', title: 'Pump meter did not continue from last reading', detail: `${r.entry_date}: ${r.meter_gap_note}`, link: '/fuel' });
    }
  }
  for (const r of await all<any>(db, `SELECT * FROM daily_closings WHERE status = 'closed' AND total_difference <> 0 AND entry_date >= ? AND business_id IN (${p}) ORDER BY entry_date DESC`, addDays(t, -7), ...scope)) {
    alerts.push({ level: r.total_difference < 0 ? 'red' : 'yellow', business: r.business_id, title: `Cash ${r.total_difference < 0 ? 'short' : 'over'} ${money(Math.abs(r.total_difference))} at closing`,
      detail: `${r.entry_date}: ${r.explanation}`, link: '/closing' });
  }
  const yesterday = addDays(t, -1);
  for (const b of scope) {
    const closed = await first<any>(db, `SELECT MAX(entry_date) AS d FROM daily_closings WHERE business_id = ? AND status = 'closed'`, b);
    const activity = await first<any>(db, `SELECT entry_date AS d FROM daily_totals WHERE business_id = ? AND entry_date > ? AND entry_date <= ?
                                           AND entry_type NOT IN ('closing_diff', 'closing_reopen') ORDER BY entry_date LIMIT 1`,
      b, closed?.d ?? '0000-00-00', yesterday);
    if (activity?.d) alerts.push({ level: 'yellow', business: b, title: 'Day not closed', detail: `Cash has not been counted and closed since ${closed?.d ? addDays(closed.d, 1) : activity.d}.`, link: '/closing' });
  }
  for (const r of await all<any>(db, `SELECT b.business_id, c.name, b.balance, b.last_decrease AS last_paid, b.first_increase AS first_charge
      FROM account_balances b JOIN customers c ON c.id = b.customer_id WHERE b.account = 'receivable' AND b.business_id IN (${p})
        AND b.balance > 0 AND COALESCE(b.last_decrease, b.first_increase) < ?
      ORDER BY b.balance DESC LIMIT 20`, ...scope, addDays(t, -30))) {
    alerts.push({ level: 'yellow', business: r.business_id, title: `Overdue debt: ${r.name} owes ${money(r.balance)}`,
      detail: r.last_paid ? `No payment since ${r.last_paid}` : `Owing since ${r.first_charge}, no payment yet`, link: '/customers' });
  }
  for (const r of await all<any>(db, `SELECT b.business_id, pm.name, b.balance FROM account_balances b JOIN payment_methods pm ON pm.id = b.method_id
      WHERE b.account = 'cash' AND b.business_id IN (${p}) AND b.balance < 0`, ...scope)) {
    alerts.push({ level: 'red', business: r.business_id, title: `${r.name} balance is negative (${money(r.balance)})`,
      detail: 'More money was recorded going out than coming in. Check for a missing sale, opening balance or transfer.', link: '/money' });
  }
  return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
}

// ── Reports ─────────────────────────────────────────────────────
export async function summary(ctx: Ctx) {
  requireBizRead(ctx);
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const from = ctx.url.searchParams.get('from') || today().slice(0, 8) + '01';
  const to = ctx.url.searchParams.get('to') || today();
  const p = placeholders(scope);
  const [profit, expenses, losses, cashFlow, topProducts, fuel, daily, credit] = await Promise.all([
    pnl(ctx.db, scope, from, to),
    all(ctx.db, `SELECT business_id, category, SUM(debit - credit) AS total FROM daily_totals WHERE business_id IN (${p}) AND entry_date BETWEEN ? AND ? AND account = 'expense'
                 GROUP BY business_id, category HAVING SUM(debit - credit) <> 0 ORDER BY total DESC`, ...scope, from, to),
    all(ctx.db, `SELECT business_id, account, CASE WHEN category = '' THEN account ELSE category END AS category, SUM(debit - credit) AS total FROM daily_totals
                 WHERE business_id IN (${p}) AND entry_date BETWEEN ? AND ? AND account IN ('stock_loss', 'cash_diff') GROUP BY business_id, account, 3 HAVING SUM(debit - credit) <> 0`, ...scope, from, to),
    all(ctx.db, `SELECT business_id, entry_type, SUM(debit) AS money_in, SUM(credit) AS money_out
                 FROM daily_totals WHERE business_id IN (${p}) AND entry_date BETWEEN ? AND ? AND account = 'cash' GROUP BY business_id, entry_type ORDER BY business_id, entry_type`, ...scope, from, to),
    all(ctx.db, `SELECT s.business_id, si.product_id, si.name, ROUND(SUM(si.qty - si.returned_qty), 3) AS qty,
                   SUM(ROUND(si.line_total * (1.0 - si.returned_qty / si.qty) * (CASE WHEN s.subtotal > 0 THEN s.total * 1.0 / s.subtotal ELSE 0 END))) AS revenue,
                   SUM(ROUND((si.qty - si.returned_qty) * si.unit_cost)) AS cost
                 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed' AND s.business_id IN (${p}) AND s.entry_date BETWEEN ? AND ?
                 GROUP BY s.business_id, si.product_id ORDER BY revenue DESC LIMIT 30`, ...scope, from, to),
    scope.includes('fuel')
      ? all(ctx.db, `SELECT p.name, ROUND(SUM(r.liters), 3) AS qty, SUM(r.amount) AS revenue, SUM(ROUND(r.liters * r.unit_cost)) AS cost
                     FROM fuel_shift_readings r JOIN fuel_shifts s ON s.id = r.shift_id JOIN products p ON p.id = r.product_id
                     WHERE s.business_id = 'fuel' AND s.status = 'completed' AND s.entry_date BETWEEN ? AND ? GROUP BY p.id`, from, to)
      : Promise.resolve([]),
    all(ctx.db, `SELECT entry_date, business_id, -SUM(CASE WHEN account = 'sales' THEN debit - credit ELSE 0 END) AS revenue, -SUM(debit - credit) AS profit
                 FROM daily_totals WHERE business_id IN (${p}) AND entry_date BETWEEN ? AND ? AND account IN (${placeholders(PNL_ACCOUNTS)})
                 GROUP BY entry_date, business_id ORDER BY entry_date DESC`, ...scope, from, to, ...PNL_ACCOUNTS),
    all(ctx.db, `SELECT business_id, SUM(debit) AS given, SUM(credit) AS collected
                 FROM daily_totals WHERE business_id IN (${p}) AND entry_date BETWEEN ? AND ? AND account = 'receivable' GROUP BY business_id`, ...scope, from, to),
  ]);
  return { business: ctx.url.searchParams.get('business') || 'all', from, to, scope, profit, expenses, losses, cashFlow, topProducts, fuel, daily, credit };
}

function requireBizRead(ctx: Ctx) {
  if (!['owner', 'manager'].includes(ctx.user.role)) throw new HttpError(403, 'Reports are for the owner and managers');
}

/** Every financial transaction, newest first. */
export async function ledger(ctx: Ctx) {
  requireBizRead(ctx);
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const from = ctx.url.searchParams.get('from') || today(-7);
  const to = ctx.url.searchParams.get('to') || today();
  const type = ctx.url.searchParams.get('type');
  const q = ctx.url.searchParams.get('q');
  return all(ctx.db,
    `SELECT e.*, u.full_name AS created_by_name,
            (SELECT SUM(amount) FROM journal_lines l WHERE l.entry_id = e.id AND l.account = 'cash') AS cash_effect
     FROM journal_entries e JOIN users u ON u.id = e.created_by
     WHERE e.business_id IN (${placeholders(scope)}) AND e.entry_date BETWEEN ? AND ? ${type ? 'AND e.type = ?' : ''} ${q ? 'AND e.memo LIKE ?' : ''}
     ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 1000`, ...scope, from, to, ...(type ? [type] : []), ...(q ? [`%${q}%`] : []));
}

export async function entryLines(ctx: Ctx) {
  requireBizRead(ctx);
  const e = await first<any>(ctx.db, 'SELECT * FROM journal_entries WHERE id = ?', ctx.params.id);
  if (!e) throw new HttpError(404, 'Not found');
  bizScope(ctx, e.business_id);
  const lines = await all(ctx.db, `SELECT l.*, pm.name AS method_name, c.name AS customer_name, s.name AS supplier_name FROM journal_lines l
    LEFT JOIN payment_methods pm ON pm.id = l.method_id LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN suppliers s ON s.id = l.supplier_id WHERE entry_id = ? ORDER BY l.id`, e.id);
  return { ...e, lines };
}

/** Owner/manager overview of what is owed both ways, per business. */
export async function balances(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  const p = placeholders(scope);
  const [cash, customers, suppliers] = await Promise.all([
    all(ctx.db, `SELECT b.business_id, b.method_id, pm.name AS method_name, b.balance FROM account_balances b JOIN payment_methods pm ON pm.id = b.method_id
                 WHERE b.account = 'cash' AND b.business_id IN (${p}) ORDER BY b.business_id, pm.sort`, ...scope),
    all(ctx.db, `SELECT b.business_id, c.id, c.name, c.phone, b.balance FROM account_balances b JOIN customers c ON c.id = b.customer_id
                 WHERE b.account = 'receivable' AND b.business_id IN (${p}) AND b.balance <> 0 ORDER BY b.balance DESC`, ...scope),
    all(ctx.db, `SELECT b.business_id, s.id, s.name, s.phone, -b.balance AS balance FROM account_balances b JOIN suppliers s ON s.id = b.supplier_id
                 WHERE b.account = 'payable' AND b.business_id IN (${p}) AND b.balance <> 0 ORDER BY b.balance`, ...scope),
  ]);
  return { cash, customers, suppliers };
}

// ── Daily closing ───────────────────────────────────────────────
export async function closingPreview(ctx: Ctx) {
  const business = requireBiz(ctx, ctx.url.searchParams.get('business'), 'close');
  const date = entryDate(ctx.url.searchParams.get('date'));
  const [lines, existing, last, dayPnl, credit] = await Promise.all([
    closingLines(ctx.db, business, date),
    first(ctx.db, `SELECT d.*, u.full_name AS closed_by_name FROM daily_closings d JOIN users u ON u.id = d.closed_by
                   WHERE d.business_id = ? AND d.entry_date = ? AND d.status = 'closed'`, business, date),
    first<any>(ctx.db, `SELECT MAX(entry_date) AS d FROM daily_closings WHERE business_id = ? AND status = 'closed'`, business),
    pnl(ctx.db, [business], date, date),
    first<any>(ctx.db, `SELECT COALESCE(SUM(debit), 0) AS given, COALESCE(SUM(credit), 0) AS collected
                        FROM daily_totals WHERE business_id = ? AND entry_date = ? AND account = 'receivable'`, business, date),
  ]);
  return { business, date, lines, closing: existing, lastClosed: last?.d ?? null, locked: Boolean(last?.d && date <= last.d), day: dayPnl[business], credit };
}

export async function createClosing(ctx: Ctx) {
  const b = ctx.body;
  const business = requireBiz(ctx, b.business, 'close');
  const date = entryDate(b.date);
  await assertDayOpen(ctx.db, business, date);
  const lines = await closingLines(ctx.db, business, date);
  const counted = b.counted ?? {};
  for (const l of lines) {
    if (counted[l.method_id] === undefined || counted[l.method_id] === '') throw bad(`Enter the counted amount for ${l.method_name}`);
    l.counted = cents(counted[l.method_id], `${l.method_name} counted`, { min: -1e12 });
    l.difference = l.counted - l.expected;
  }
  const totalExpected = lines.reduce((s, l) => s + l.expected, 0);
  const totalCounted = lines.reduce((s, l) => s + l.counted, 0);
  const totalDiff = totalCounted - totalExpected;
  const anyDiff = lines.some((l) => l.difference !== 0);
  const explanation = str(b.explanation, 'Explanation', { max: 500 });
  if (anyDiff && !explanation) throw bad('The counted money does not match the expected money. Explain the difference before closing.');

  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO daily_closings (id, business_id, entry_date, total_expected, total_counted, total_difference, explanation, closed_by, closed_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, id, business, date, totalExpected, totalCounted, totalDiff, explanation, ctx.user.id, nowIso());
  for (const l of lines) {
    tx.run(`INSERT INTO daily_closing_lines (id, closing_id, method_id, opening, sales_in, collections, expenses_out, suppliers_out, transfers, other, expected, counted, difference)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId(), id, l.method_id, l.opening, l.sales_in, l.collections, l.expenses_out, l.suppliers_out, l.transfers, l.other, l.expected, l.counted, l.difference);
  }
  // Book the differences so the system balance equals the money really counted; the gap stays visible as a cash difference.
  tx.journal({ business, date, type: 'closing_diff', refType: 'closing', refId: id, amount: lines.reduce((s, l) => s + Math.abs(l.difference), 0), memo: `Daily closing ${date}: counted ${(totalCounted / 100).toFixed(2)}, expected ${(totalExpected / 100).toFixed(2)}${anyDiff ? ` — ${explanation}` : ''}` },
    lines.flatMap((l) => [{ account: 'cash' as const, amount: l.difference, method: l.method_id }, { account: 'cash_diff' as const, amount: -l.difference, category: 'Daily closing' }]));
  tx.audit('close_day', 'daily_closing', id, business, { date, totalExpected, totalCounted, differences: lines.map((l) => [l.method_id, l.difference]) });
  return tx.commit(idemKey(ctx), { id });
}

export async function listClosings(ctx: Ctx) {
  const scope = bizScope(ctx, ctx.url.searchParams.get('business'));
  return all(ctx.db, `SELECT d.*, u.full_name AS closed_by_name, r.full_name AS reopened_by_name FROM daily_closings d JOIN users u ON u.id = d.closed_by
                      LEFT JOIN users r ON r.id = d.reopened_by WHERE d.business_id IN (${placeholders(scope)}) ORDER BY d.entry_date DESC, d.closed_at DESC LIMIT 200`, ...scope);
}

export async function getClosing(ctx: Ctx) {
  const d = await first<any>(ctx.db, `SELECT d.*, b.name AS business_name, u.full_name AS closed_by_name, r.full_name AS reopened_by_name FROM daily_closings d
    JOIN businesses b ON b.id = d.business_id JOIN users u ON u.id = d.closed_by LEFT JOIN users r ON r.id = d.reopened_by WHERE d.id = ?`, ctx.params.id);
  if (!d) throw new HttpError(404, 'Not found');
  bizScope(ctx, d.business_id);
  const lines = await all(ctx.db, 'SELECT l.*, pm.name AS method_name FROM daily_closing_lines l JOIN payment_methods pm ON pm.id = l.method_id WHERE closing_id = ? ORDER BY pm.sort', d.id);
  return { ...d, lines };
}

export async function reopenClosing(ctx: Ctx) {
  const d = await first<any>(ctx.db, 'SELECT * FROM daily_closings WHERE id = ?', ctx.params.id);
  if (!d) throw new HttpError(404, 'Not found');
  const business = requireBiz(ctx, d.business_id, 'void');
  if (!['owner', 'manager'].includes(ctx.user.role)) throw new HttpError(403, 'Only the owner or a manager can reopen a day');
  if (d.status !== 'closed') throw new HttpError(409, 'This closing was already reopened');
  const later = await first(ctx.db, `SELECT id FROM daily_closings WHERE business_id = ? AND status = 'closed' AND entry_date > ?`, business, d.entry_date);
  if (later) throw new HttpError(409, 'A later day is closed. Reopen the latest day first.');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE daily_closings SET status = 'reopened', reopened_by = ?, reopened_at = ?, reopen_reason = ? WHERE id = ? AND status = 'closed'`, ctx.user.id, nowIso(), reason, d.id);
  await tx.reverse('closing', d.id, d.entry_date, 'closing_reopen', `Reopened day ${d.entry_date}: ${reason}`);
  tx.audit('reopen_day', 'daily_closing', d.id, business, { date: d.entry_date, reason });
  return tx.commit(idemKey(ctx), { id: d.id });
}

// ── Audit ───────────────────────────────────────────────────────
export async function auditLog(ctx: Ctx) {
  const from = ctx.url.searchParams.get('from') || today(-7);
  const to = ctx.url.searchParams.get('to') || today();
  return all(ctx.db, `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                      WHERE a.created_at >= ? AND a.created_at < ? ORDER BY a.created_at DESC LIMIT 1000`, from, addDays(to, 1));
}
