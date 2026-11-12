// Shift closing (xisaab xidh) for the restaurant, and month/year locks.
//
// A shift is everything one person did with money in the restaurant since
// their last closing (no fixed times). Closing compares, per payment method,
// what the system expects with what was counted; any difference needs an
// explanation and is booked as a cash difference. The money is handed to a
// named owner/manager. A person who still has an unclosed shift from an
// earlier day cannot take or pay out money until they close it.

import { HttpError, Tx, addDays, all, bad, cents, first, idemKey, newId, nowIso, placeholders, requireBiz, str, today, type Ctx } from './lib';

const SHIFT_BUSINESSES = ['restaurant'];
// Owner money moves (transfers, owner in/out) and the closing's own entries are not drawer money.
const NOT_DRAWER = ['shift_diff', 'shift_reopen', 'transfer', 'transfer_void', 'owner_in', 'owner_in_void', 'owner_out', 'owner_out_void', 'opening_stock'];
const GROUP: Record<string, string> = {
  sale: 'sales_in', sale_void: 'sales_in', sale_return: 'sales_in',
  customer_payment: 'collections', customer_payment_void: 'collections',
  expense: 'expenses_out', expense_void: 'expenses_out',
};

function shiftBusiness(v: unknown) {
  const b = String(v ?? 'restaurant');
  if (!SHIFT_BUSINESSES.includes(b)) throw bad('Shift closing is used in the restaurant');
  return b;
}

/** Start of a person's open shift: after their last closing (and never before shift closing existed). */
async function shiftStart(db: D1Database, business: string, userId: string) {
  const [last, since] = await Promise.all([
    first<{ t: string | null }>(db, `SELECT MAX(to_ts) AS t FROM shift_closings WHERE business_id = ? AND user_id = ? AND status = 'closed'`, business, userId),
    first<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'shifts_since'`),
  ]);
  return [last?.t ?? '', since?.value ?? ''].sort().pop() as string;
}

const notDrawer = placeholders(NOT_DRAWER);
/** Business day (UTC+3) on which a moment fell. */
const localDay = (ts: string | null | undefined) => (ts ? new Date(Date.parse(ts) + 3 * 3600_000).toISOString().slice(0, 10) : null);
/** UTC moments between which business days `from`..`to` (East Africa Time) fall. */
const dayBounds = (from: string, to: string): [string, string] => [
  new Date(Date.parse(from + 'T00:00:00Z') - 3 * 3600_000).toISOString(),
  new Date(Date.parse(addDays(to, 1) + 'T00:00:00Z') - 3 * 3600_000).toISOString(),
];

/** What one person's open shift contains, per payment method. */
async function openShift(db: D1Database, business: string, userId: string) {
  const from = await shiftStart(db, business, userId);
  const [methods, cash, firstDay, sales, expenses] = await Promise.all([
    all<any>(db, 'SELECT id, name, active FROM payment_methods ORDER BY sort'),
    all<any>(db, `SELECT l.method_id, e.type, SUM(l.amount) AS total FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account = 'cash'
                  WHERE e.business_id = ? AND e.created_by = ? AND e.created_at > ? AND e.type NOT IN (${notDrawer}) GROUP BY l.method_id, e.type`,
      business, userId, from, ...NOT_DRAWER),
    first<{ d: string | null; t: string | null; n: number }>(db, `SELECT MIN(entry_date) AS d, MIN(created_at) AS t, COUNT(*) AS n FROM journal_entries
      WHERE business_id = ? AND created_by = ? AND created_at > ? AND type NOT IN (${notDrawer})`, business, userId, from, ...NOT_DRAWER),
    first<any>(db, `SELECT COUNT(*) AS n, COALESCE(SUM(total - returned_amount), 0) AS total, COALESCE(SUM(credit_amount), 0) AS credit FROM sales
      WHERE business_id = ? AND created_by = ? AND created_at > ? AND status = 'completed'`, business, userId, from),
    first<any>(db, `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE business_id = ? AND created_by = ? AND created_at > ? AND status = 'completed'`, business, userId, from),
  ]);
  const lines = methods.map((m) => {
    const line: any = { method_id: m.id, method_name: m.name, sales_in: 0, collections: 0, expenses_out: 0, other: 0, used: false };
    for (const c of cash.filter((x) => x.method_id === m.id)) { line[GROUP[c.type] ?? 'other'] += c.total; line.used = true; }
    line.expected = line.sales_in + line.collections + line.expenses_out + line.other;
    return line;
  }).filter((l) => l.used || methods.find((m) => m.id === l.method_id)?.active);
  return {
    // firstDate: the day the person started this shift; oldestEntry: the earliest date on its records (may be backdated).
    from, firstDate: localDay(firstDay?.t), startedAt: firstDay?.t ?? null, oldestEntry: firstDay?.d ?? null, activity: firstDay?.n ?? 0, lines,
    sales: { count: sales?.n ?? 0, total: sales?.total ?? 0, credit: sales?.credit ?? 0 }, expenses: expenses?.total ?? 0,
  };
}

/**
 * Called before anyone takes or pays out money in the restaurant: an unclosed
 * shift from an earlier day must be closed first.
 */
export async function assertShiftCurrent(ctx: Ctx, business: string) {
  // The owner's money is not drawer money: the owner has no shift.
  if (!SHIFT_BUSINESSES.includes(business) || ctx.user.owner) return;
  const from = await shiftStart(ctx.db, business, ctx.user.id);
  // Judged by when the work was done, not the date on the record: entering yesterday's forgotten bill today is fine.
  const old = await first<{ t: string | null }>(ctx.db, `SELECT MIN(created_at) AS t FROM journal_entries
    WHERE business_id = ? AND created_by = ? AND created_at > ? AND type NOT IN (${notDrawer})`, business, ctx.user.id, from, ...NOT_DRAWER);
  const day = localDay(old?.t);
  if (day && day < today()) {
    throw new HttpError(409, `Close your shift from ${day} first (Close My Shift), then you can continue.`);
  }
}

/** People who can receive the money: the owner(s) and the business's managers. */
async function receivers(db: D1Database, business: string) {
  return all<any>(db, `SELECT u.id, u.full_name, CASE WHEN u.role = 'owner' THEN 'owner' ELSE 'manager' END AS role FROM users u
    WHERE u.active = 1 AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id AND ub.business_id = ? AND ub.role = 'manager'))
    ORDER BY u.role = 'owner' DESC, u.full_name`, business);
}

async function unpaidOrders(db: D1Database, business: string) {
  if (business !== 'restaurant') return { count: 0, total: 0 };
  const r = await first<any>(db, `SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(ROUND(i.qty * p.sale_price)), 0) AS total FROM open_orders o
    JOIN open_order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id WHERE o.business_id = ? AND o.status = 'open'`, business);
  return { count: r?.n ?? 0, total: r?.total ?? 0 };
}

// ── My shift ────────────────────────────────────────────────────
export async function myShift(ctx: Ctx) {
  const business = shiftBusiness(ctx.url.searchParams.get('business'));
  requireBiz(ctx, business, 'sell');
  if (ctx.user.owner) return { owner: true };
  const [shift, unpaid, people, recent] = await Promise.all([
    openShift(ctx.db, business, ctx.user.id), unpaidOrders(ctx.db, business), receivers(ctx.db, business),
    all(ctx.db, `SELECT s.*, h.full_name AS handed_to_name FROM shift_closings s JOIN users h ON h.id = s.handed_to
                 WHERE s.business_id = ? AND s.user_id = ? ORDER BY s.closed_at DESC LIMIT 10`, business, ctx.user.id),
  ]);
  return { ...shift, mustClose: Boolean(shift.firstDate && shift.firstDate < today()), unpaid, receivers: people, recent };
}

export async function closeShift(ctx: Ctx) {
  const b = ctx.body;
  const business = shiftBusiness(b.business);
  requireBiz(ctx, business, 'sell');
  if (ctx.user.owner) throw bad('The owner does not close shifts');
  const shift = await openShift(ctx.db, business, ctx.user.id);
  if (!shift.activity) throw bad('Nothing to close: you have not recorded any money since your last closing');
  const people = await receivers(ctx.db, business);
  const handedTo = people.find((p) => p.id === String(b.handedTo ?? ''));
  if (!handedTo) throw bad('Choose who receives the money (the owner or a manager)');
  const startFloat = cents(b.startFloat ?? 0, 'Change money in the drawer at the start', { required: false });
  const counted = b.counted ?? {};
  for (const l of shift.lines) {
    if (l.method_id === 'cash') l.expected += startFloat;
    if (counted[l.method_id] === undefined || counted[l.method_id] === '') throw bad(`Enter what you have in ${l.method_name}`);
    l.counted = cents(counted[l.method_id], `${l.method_name} counted`);
    l.difference = l.counted - l.expected;
  }
  const expected = shift.lines.reduce((s, l) => s + l.expected, 0);
  const total = shift.lines.reduce((s, l) => s + l.counted, 0);
  const anyDiff = shift.lines.some((l) => l.difference !== 0);
  const explanation = str(b.explanation, 'Explanation', { max: 500 });
  if (anyDiff && !explanation) throw bad('What you counted does not match what is expected. Explain the difference before closing.');
  const unpaid = await unpaidOrders(ctx.db, business);
  const id = newId();
  const closedAt = nowIso();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO shift_closings (id, business_id, user_id, from_ts, to_ts, first_date, sales_count, sales_total, credit_total, expenses_total, start_float,
            total_expected, total_counted, total_difference, explanation, handed_to, unpaid_orders, unpaid_total, closed_by, closed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, business, ctx.user.id, shift.from, closedAt, shift.firstDate, shift.sales.count, shift.sales.total, shift.sales.credit, shift.expenses, startFloat,
    expected, total, total - expected, explanation, handedTo.id, unpaid.count, unpaid.total, ctx.user.id, closedAt);
  for (const l of shift.lines) {
    tx.run(`INSERT INTO shift_closing_lines (id, closing_id, method_id, sales_in, collections, expenses_out, other, expected, counted, difference) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), id, l.method_id, l.sales_in, l.collections, l.expenses_out, l.other, l.expected, l.counted, l.difference);
  }
  // The difference is booked so the books match the money really handed over; it stays visible as a cash difference.
  const diffs = shift.lines.filter((l) => l.difference !== 0);
  if (diffs.length) {
    tx.journal({ business, date: today(), type: 'shift_diff', refType: 'shift', refId: id, amount: diffs.reduce((s, l) => s + Math.abs(l.difference), 0),
      memo: `Shift closing ${ctx.user.full_name}: counted ${(total / 100).toFixed(2)}, expected ${(expected / 100).toFixed(2)} — ${explanation}` },
      diffs.flatMap((l) => [{ account: 'cash' as const, amount: l.difference, method: l.method_id }, { account: 'cash_diff' as const, amount: -l.difference, category: 'Shift closing' }]));
  }
  tx.audit('close_shift', 'shift', id, business, { expected, counted: total, difference: total - expected, handedTo: handedTo.full_name });
  try {
    return await tx.commit(idemKey(ctx), { id });
  } catch (e: any) {
    if (String(e?.message).includes('already exists')) throw new HttpError(409, 'This shift was just closed');
    throw e;
  }
}

// ── All shifts (managers and owner) ─────────────────────────────
export async function listShifts(ctx: Ctx) {
  const business = shiftBusiness(ctx.url.searchParams.get('business'));
  requireBiz(ctx, business, 'reports');
  const from = ctx.url.searchParams.get('from') || today().slice(0, 8) + '01';
  const to = ctx.url.searchParams.get('to') || today();
  return all(ctx.db, `SELECT s.*, u.full_name AS user_name, h.full_name AS handed_to_name, r.full_name AS reopened_by_name,
      (SELECT MAX(x.to_ts) FROM shift_closings x WHERE x.business_id = s.business_id AND x.user_id = s.user_id AND x.status = 'closed') = s.to_ts AS is_latest
    FROM shift_closings s JOIN users u ON u.id = s.user_id JOIN users h ON h.id = s.handed_to LEFT JOIN users r ON r.id = s.reopened_by
    WHERE s.business_id = ? AND s.closed_at >= ? AND s.closed_at < ? ORDER BY s.closed_at DESC LIMIT 500`, business, ...dayBounds(from, to));
}

export async function getShift(ctx: Ctx) {
  const s = await first<any>(ctx.db, `SELECT s.*, b.name AS business_name, u.full_name AS user_name, h.full_name AS handed_to_name, r.full_name AS reopened_by_name
    FROM shift_closings s JOIN businesses b ON b.id = s.business_id JOIN users u ON u.id = s.user_id JOIN users h ON h.id = s.handed_to
    LEFT JOIN users r ON r.id = s.reopened_by WHERE s.id = ?`, ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  if (s.user_id !== ctx.user.id) requireBiz(ctx, s.business_id, 'reports');
  else requireBiz(ctx, s.business_id, 'sell');
  const lines = await all(ctx.db, `SELECT l.*, pm.name AS method_name FROM shift_closing_lines l JOIN payment_methods pm ON pm.id = l.method_id WHERE closing_id = ? ORDER BY pm.sort`, s.id);
  return { ...s, lines };
}

/** Owner/manager reopens a person's latest closing (with a reason); they then close it again. */
export async function reopenShift(ctx: Ctx) {
  const s = await first<any>(ctx.db, 'SELECT * FROM shift_closings WHERE id = ?', ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  const business = requireBiz(ctx, s.business_id, 'void');
  if (s.status !== 'closed') throw new HttpError(409, 'This closing was already reopened');
  const later = await first(ctx.db, `SELECT id FROM shift_closings WHERE business_id = ? AND user_id = ? AND status = 'closed' AND to_ts > ?`, business, s.user_id, s.to_ts);
  if (later) throw new HttpError(409, 'This person closed another shift after this one. Reopen the latest one first.');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE shift_closings SET status = 'reopened', reopened_by = ?, reopened_at = ?, reopen_reason = ? WHERE id = ? AND status = 'closed'`, ctx.user.id, nowIso(), reason, s.id);
  await tx.reverse('shift', s.id, today(), 'shift_reopen', `Reopened shift closing: ${reason}`);
  tx.audit('reopen_shift', 'shift', s.id, business, { reason });
  return tx.commit(idemKey(ctx), { id: s.id });
}

/** Who still has money they have not closed, and since when. */
export async function openShifts(ctx: Ctx) {
  const business = shiftBusiness(ctx.url.searchParams.get('business'));
  requireBiz(ctx, business, 'reports');
  const people = await all<any>(ctx.db, `SELECT u.id, u.full_name FROM users u WHERE u.active = 1 AND u.role <> 'owner'
    AND EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id AND ub.business_id = ?)`, business);
  const out = [];
  for (const p of people) {
    const s = await openShift(ctx.db, business, p.id);
    if (s.activity) out.push({ user_id: p.id, user_name: p.full_name, since: s.firstDate, oldestEntry: s.oldestEntry, sales: s.sales, expected: s.lines.reduce((t: number, l: any) => t + l.expected, 0) });
  }
  return out;
}

/** Per day and per cashier for a period: shifts, sales, differences. */
export async function shiftSummary(ctx: Ctx) {
  const business = shiftBusiness(ctx.url.searchParams.get('business'));
  requireBiz(ctx, business, 'reports');
  const from = ctx.url.searchParams.get('from') || today().slice(0, 8) + '01';
  const to = ctx.url.searchParams.get('to') || today();
  const [cashiers, days] = await Promise.all([
    all(ctx.db, `SELECT s.user_id, u.full_name AS user_name, COUNT(*) AS shifts, SUM(s.sales_total) AS sales, SUM(s.expenses_total) AS expenses,
        SUM(CASE WHEN s.total_difference < 0 THEN s.total_difference ELSE 0 END) AS short, SUM(CASE WHEN s.total_difference > 0 THEN s.total_difference ELSE 0 END) AS over,
        SUM(s.total_difference) AS difference
      FROM shift_closings s JOIN users u ON u.id = s.user_id WHERE s.business_id = ? AND s.status = 'closed' AND s.closed_at >= ? AND s.closed_at < ?
      GROUP BY s.user_id ORDER BY difference`, business, ...dayBounds(from, to)),
    all(ctx.db, `SELECT date(s.closed_at, '+3 hours') AS day, COUNT(*) AS shifts, SUM(s.sales_total) AS sales, SUM(s.total_difference) AS difference
      FROM shift_closings s WHERE s.business_id = ? AND s.status = 'closed' AND s.closed_at >= ? AND s.closed_at < ? GROUP BY 1 ORDER BY 1 DESC`, business, ...dayBounds(from, to)),
  ]);
  return { from, to, cashiers, days };
}

// ── Month / year locks (owner) ──────────────────────────────────
export async function listLocks(ctx: Ctx) {
  const business = String(ctx.url.searchParams.get('business') ?? '');
  requireBiz(ctx, business, 'reports');
  return all(ctx.db, `SELECT l.*, u.full_name AS locked_by_name, x.full_name AS unlocked_by_name FROM period_locks l JOIN users u ON u.id = l.locked_by
    LEFT JOIN users x ON x.id = l.unlocked_by WHERE l.business_id = ? ORDER BY l.locked_at DESC`, business);
}

export async function lockPeriod(ctx: Ctx) {
  if (!ctx.user.owner) throw new HttpError(403, 'Only the owner can close a month or a year');
  const business = requireBiz(ctx, ctx.body.business, 'reports');
  const period = String(ctx.body.period ?? '');
  let kind: 'month' | 'year', end: string;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    kind = 'month';
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5));
    end = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
  }
  else if (/^\d{4}$/.test(period)) { kind = 'year'; end = `${period}-12-31`; }
  else throw bad('Choose a month (YYYY-MM) or a year (YYYY)');
  if (end >= today()) throw bad(`${period} has not finished yet`);
  // Everyone must have closed the shifts with money in that period first.
  if (SHIFT_BUSINESSES.includes(business)) {
    const open = (await openShifts({ ...ctx, url: new URL(`https://x/?business=${business}`) } as Ctx)) as any[];
    const late = open.filter((o) => (o.since && o.since <= end) || (o.oldestEntry && o.oldestEntry <= end));
    if (late.length) throw new HttpError(409, `Not all shifts are closed: ${late.map((o) => `${o.user_name} (since ${o.since})`).join(', ')}`);
  }
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO period_locks (id, business_id, period, kind, locked_until, locked_by, locked_at) VALUES (?,?,?,?,?,?,?)`,
    id, business, period, kind, end, ctx.user.id, nowIso());
  tx.audit('lock_period', 'period', id, business, { period, until: end });
  try {
    return await tx.commit(idemKey(ctx), { id, period, lockedUntil: end });
  } catch (e: any) {
    if (String(e?.message).includes('already exists')) throw new HttpError(409, `${period} is already closed`);
    throw e;
  }
}

export async function unlockPeriod(ctx: Ctx) {
  if (!ctx.user.owner) throw new HttpError(403, 'Only the owner can reopen a month or a year');
  const l = await first<any>(ctx.db, 'SELECT * FROM period_locks WHERE id = ?', ctx.params.id);
  if (!l) throw new HttpError(404, 'Not found');
  if (l.status !== 'locked') throw new HttpError(409, 'Already reopened');
  const reason = str(ctx.body.reason, 'Reason', { required: true, max: 300 });
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`UPDATE period_locks SET status = 'unlocked', unlocked_by = ?, unlocked_at = ?, unlock_reason = ? WHERE id = ? AND status = 'locked'`, ctx.user.id, nowIso(), reason, l.id);
  tx.audit('unlock_period', 'period', l.id, l.business_id, { period: l.period, reason });
  return tx.commit(idemKey(ctx), { id: l.id });
}

