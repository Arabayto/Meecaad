// Profit tracking and "Xisaab Xidhka Maanta" (the day's money summary), one business at a time.
// Each portal asks only for its own business: store, restaurant and fuel station are never mixed.
// Every figure comes from the saved journal (daily totals) and the sale records.

import { HttpError, addDays, all, bad, can, first, placeholders, requireBiz, today, type Ctx } from './lib';

const PNL = ['sales', 'cogs', 'expense', 'stock_loss', 'cash_diff'];
const SALE_TYPES = ['sale', 'fuel_sale'];
const SALE_VOIDS = ['sale_void', 'fuel_sale_void'];

interface Day { date: string; revenue: number; cogs: number; expenses: number; losses: number; cashDiff: number; profit: number }

function range(ctx: Ctx) {
  const from = ctx.url.searchParams.get('from') || today();
  const to = ctx.url.searchParams.get('to') || from;
  const real = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!real(from) || !real(to) || from > to) throw bad('Choose a valid date range');
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (span > 400) throw bad('Choose at most about a year');
  return { from, to, span, pFrom: addDays(from, -span), pTo: addDays(from, -1) };
}

/**
 * One read of the daily totals for a period gives the days, the totals, expenses by kind and losses
 * (the table is keyed by business and date, so each extra query would read the same rows again).
 */
async function days(db: D1Database, business: string, from: string, to: string) {
  const rows = await all<{ entry_date: string; account: string; category: string; total: number }>(db,
    `SELECT entry_date, account, category, SUM(debit - credit) AS total FROM daily_totals
     WHERE business_id = ? AND entry_date BETWEEN ? AND ? AND account IN (${placeholders(PNL)}) GROUP BY entry_date, account, category`, business, from, to, ...PNL);
  const map = new Map<string, Day>();
  const expenses = new Map<string, number>();
  const losses = new Map<string, { account: string; category: string; total: number }>();
  for (const r of rows) {
    const d = map.get(r.entry_date) ?? { date: r.entry_date, revenue: 0, cogs: 0, expenses: 0, losses: 0, cashDiff: 0, profit: 0 };
    if (r.account === 'sales') d.revenue -= r.total;
    if (r.account === 'cogs') d.cogs += r.total;
    if (r.account === 'expense') { d.expenses += r.total; expenses.set(r.category, (expenses.get(r.category) ?? 0) + r.total); }
    if (r.account === 'stock_loss') d.losses += r.total;
    if (r.account === 'cash_diff') d.cashDiff += r.total;
    if (r.account === 'stock_loss' || r.account === 'cash_diff') {
      const key = `${r.account}|${r.category || r.account}`;
      const l = losses.get(key) ?? { account: r.account, category: r.category || r.account, total: 0 };
      l.total += r.total;
      losses.set(key, l);
    }
    map.set(r.entry_date, d);
  }
  const list = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of list) d.profit = d.revenue - d.cogs - d.expenses - d.losses - d.cashDiff;
  const total = list.reduce((t, d) => ({
    revenue: t.revenue + d.revenue, cogs: t.cogs + d.cogs, expenses: t.expenses + d.expenses, losses: t.losses + d.losses, cashDiff: t.cashDiff + d.cashDiff, profit: t.profit + d.profit,
  }), { revenue: 0, cogs: 0, expenses: 0, losses: 0, cashDiff: 0, profit: 0 });
  return {
    list, total,
    expenses: [...expenses].filter(([, v]) => v !== 0).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
    losses: [...losses.values()].filter((l) => l.total !== 0).sort((a, b) => b.total - a.total),
  };
}

/** Number of sales (cancelled ones not counted). */
async function saleCount(db: D1Database, business: string, from: string, to: string) {
  const r = business === 'fuel'
    ? await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM duty_sales WHERE business_id = 'fuel' AND status = 'completed' AND entry_date BETWEEN ? AND ?`, from, to)
    : await first<{ n: number }>(db, `SELECT COALESCE(SUM(count), 0) AS n FROM sales_daily WHERE business_id = ? AND entry_date BETWEEN ? AND ?`, business, from, to);
  return r?.n ?? 0;
}

/** What each item brought: quantity, sales (after discounts and returns), cost, profit, and any sold below cost. */
function items(db: D1Database, business: string, from: string, to: string) {
  if (business === 'fuel') {
    return all<any>(db, `SELECT COALESCE(item_id, '') AS id, COALESCE(item_name, 'Sales without an item') AS name, ROUND(SUM(COALESCE(qty, 0)), 3) AS qty,
        SUM(amount) AS revenue, SUM(ROUND(COALESCE(qty, 0) * COALESCE(unit_cost, 0))) AS cost, COUNT(*) AS sales,
        SUM(CASE WHEN qty > 0 AND unit_cost * qty > amount THEN ROUND(unit_cost * qty - amount) ELSE 0 END) AS below_cost
      FROM duty_sales WHERE business_id = 'fuel' AND status = 'completed' AND entry_date BETWEEN ? AND ?
      GROUP BY COALESCE(item_id, ''), COALESCE(item_name, 'Sales without an item')`, from, to);
  }
  // One row per product per day (item_daily, kept by triggers on every sale, return and cancellation).
  return all<any>(db, `SELECT product_id AS id, MAX(name) AS name, ROUND(SUM(qty), 3) AS qty, CAST(ROUND(SUM(revenue)) AS INTEGER) AS revenue,
      CAST(ROUND(SUM(cost)) AS INTEGER) AS cost, SUM(lines) AS sales, CAST(ROUND(SUM(below_cost)) AS INTEGER) AS below_cost
    FROM item_daily WHERE business_id = ? AND entry_date BETWEEN ? AND ? GROUP BY product_id`, business, from, to);
}

/** GET /tracking/profit?business&from&to — profit tracking for one business, compared with the period before. */
export async function profit(ctx: Ctx) {
  const business = requireBiz(ctx, ctx.url.searchParams.get('business'), 'reports');
  const { from, to, span, pFrom, pTo } = range(ctx);
  // The trend chart always shows at least 7 days (like the pharmacy's "7-Day Profit Trend").
  const trendFrom = span < 7 ? addDays(to, -6) : from;
  const [cur, prev, count, prevCount, itemRows, trend] = await Promise.all([
    days(ctx.db, business, from, to), days(ctx.db, business, pFrom, pTo),
    saleCount(ctx.db, business, from, to), saleCount(ctx.db, business, pFrom, pTo),
    items(ctx.db, business, from, to),
    span < 7 ? days(ctx.db, business, trendFrom, to) : Promise.resolve(null),
  ]);
  // Every day of the trend, also the quiet ones (a gap would make the line jump).
  const trendDays = (trend ?? cur).list;
  const filled: Day[] = [];
  for (let d = trendFrom; d <= to; d = addDays(d, 1)) filled.push(trendDays.find((x) => x.date === d) ?? { date: d, revenue: 0, cogs: 0, expenses: 0, losses: 0, cashDiff: 0, profit: 0 });
  const list = itemRows.filter((i) => i.revenue || i.qty).map((i) => ({ ...i, profit: i.revenue - i.cost, margin: i.revenue ? Math.round(((i.revenue - i.cost) / i.revenue) * 1000) / 10 : 0 }));
  const t = cur.total;
  return {
    business, from, to,
    totals: { ...t, grossProfit: t.revenue - t.cogs, sales: count, average: count ? Math.round(t.revenue / count) : 0, margin: t.revenue ? Math.round((t.profit / t.revenue) * 1000) / 10 : 0,
      belowCost: list.reduce((s, i) => s + (i.below_cost ?? 0), 0), qty: Math.round(list.reduce((s, i) => s + (i.qty ?? 0), 0) * 1000) / 1000 },
    previous: { from: pFrom, to: pTo, ...prev.total, sales: prevCount },
    hasCost: business !== 'restaurant',
    top: [...list].sort((a, b) => (business === 'restaurant' ? b.revenue - a.revenue : b.profit - a.profit)).slice(0, 15),
    weakest: business === 'restaurant' ? [] : [...list].filter((i) => i.revenue > 0).sort((a, b) => a.margin - b.margin).slice(0, 5),
    daily: cur.list, trend: filled.length <= 400 ? filled : cur.list, expenses: cur.expenses, losses: cur.losses,
  };
}

const KIND: Record<string, string> = {
  sale: 'Sale', fuel_sale: 'Sale', customer_payment: 'Debt payment', expense: 'Expense', supplier_payment: 'Supplier payment',
  purchase: 'Purchase', fuel_stock_in: 'Stock bought', sale_void: 'Sale cancelled', fuel_sale_void: 'Sale cancelled', sale_return: 'Return',
  purchase_void: 'Purchase cancelled', expense_void: 'Expense cancelled', closing_diff: 'Closing difference', shift_diff: 'Shift difference',
  fuel_shift: 'Shift difference', customer_payment_void: 'Payment cancelled', supplier_payment_void: 'Payment cancelled',
};
const SOURCE: Record<string, string> = {
  sale: 'sales', fuel_sale: 'sales', sale_void: 'sales', fuel_sale_void: 'sales', sale_return: 'sales',
  customer_payment: 'debts', customer_payment_void: 'debts', supplier_payment_void: 'suppliers', expense: 'expenses', expense_void: 'expenses',
  supplier_payment: 'suppliers', purchase: 'suppliers', fuel_stock_in: 'suppliers', purchase_void: 'suppliers',
};

/**
 * GET /tracking/xisaab?business&date — Xisaab Xidhka Maanta: every movement of money that day in one business,
 * with what came in and went out per payment method, sales (paid now / on credit) and debts collected.
 */
export async function xisaab(ctx: Ctx) {
  // Owner and managers; in the store also whoever closes the day (they count this money).
  const business = String(ctx.url.searchParams.get('business') ?? '');
  if (!(business === 'store' && can(ctx.user, 'close', business))) requireBiz(ctx, business, 'reports');
  else if (!ctx.user.businesses.includes(business)) throw new HttpError(403, 'You do not have access to this business');
  const date = ctx.url.searchParams.get('date') || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Choose a valid date');
  const [lines, methods] = await Promise.all([
    all<any>(ctx.db, `SELECT e.id, e.type, e.ref_type, e.ref_id, e.memo, e.created_at, e.reverses_id, u.full_name AS by_name,
        l.account, l.method_id, l.amount, c.name AS customer_name, s.name AS supplier_name
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN users u ON u.id = e.created_by
      LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.business_id = ? AND l.entry_date = ? AND l.account IN ('cash', 'receivable', 'payable', 'sales')
      ORDER BY e.created_at, e.id`, business, date),
    all<any>(ctx.db, 'SELECT id, name, active FROM payment_methods ORDER BY sort, name'),
  ]);
  // Sale numbers for the reference column.
  const saleIds = [...new Set(lines.filter((l) => l.ref_type === 'sale').map((l) => l.ref_id))];
  const numbers = new Map<string, number>();
  for (let i = 0; i < saleIds.length; i += 90) {
    const part = saleIds.slice(i, i + 90);
    for (const r of await all<any>(ctx.db, `SELECT id, number FROM sales WHERE id IN (${placeholders(part)})`, ...part)) numbers.set(r.id, r.number);
  }
  const byEntry = new Map<string, any>();
  for (const l of lines) {
    const t = byEntry.get(l.id) ?? {
      id: l.id, type: l.type, kind: KIND[l.type] ?? (l.reverses_id ? 'Cancelled' : 'Other'), source: SOURCE[l.type] ?? 'other', memo: l.memo, time: l.created_at, by: l.by_name,
      ref: l.ref_type === 'sale' && numbers.has(l.ref_id) ? `#${numbers.get(l.ref_id)}` : null,
      party: null as string | null, in: 0, out: 0, methods: {} as Record<string, number>, credit: 0, collected: 0, owed: 0, sales: 0,
    };
    if (l.customer_name || l.supplier_name) t.party = l.customer_name ?? l.supplier_name;
    if (l.account === 'cash') {
      if (l.amount > 0) t.in += l.amount; else t.out -= l.amount;
      t.methods[l.method_id] = (t.methods[l.method_id] ?? 0) + l.amount;
    }
    // A customer paying a debt is "collected"; a sale, its return or its cancellation changes the credit given.
    if (l.account === 'receivable') { if (String(l.type).startsWith('customer_payment')) t.collected -= l.amount; else t.credit += l.amount; }
    if (l.account === 'payable') t.owed -= l.amount;   // bought on credit (+) or paid off (−)
    if (l.account === 'sales') t.sales -= l.amount;
    byEntry.set(l.id, t);
  }
  const transactions = [...byEntry.values()];
  const perMethod = methods.map((m) => {
    const ins = transactions.reduce((s, t) => s + Math.max(0, t.methods[m.id] ?? 0), 0);
    const outs = transactions.reduce((s, t) => s - Math.min(0, t.methods[m.id] ?? 0), 0);
    return { id: m.id, name: m.name, active: m.active, in: ins, out: outs, net: ins - outs };
  }).filter((m) => m.active || m.in || m.out);
  const sum = (f: (t: any) => number, only?: (t: any) => boolean) => transactions.filter(only ?? (() => true)).reduce((s, t) => s + f(t), 0);
  const isSale = (t: any) => SALE_TYPES.includes(t.type);
  return {
    business, date,
    totals: {
      received: sum((t) => t.in), paidOut: sum((t) => t.out), net: sum((t) => t.in - t.out),
      // Sales of the day after cancellations and returns: a cancelled sale is not counted.
      sales: sum((t) => t.sales), salesCount: transactions.filter(isSale).length - transactions.filter((t) => SALE_VOIDS.includes(t.type)).length,
      salesPaid: sum((t) => t.in - t.out, (t) => t.source === 'sales'), salesCredit: sum((t) => t.credit, (t) => t.source === 'sales'),
      collected: sum((t) => t.collected), expenses: sum((t) => t.out - t.in, (t) => t.source === 'expenses'),
      suppliers: sum((t) => t.out - t.in, (t) => t.source === 'suppliers'), count: transactions.length,
    },
    methods: perMethod,
    transactions: transactions.reverse(),   // newest first
  };
}
