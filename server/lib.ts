// Shared server helpers: request context, validation, permissions, and the
// atomic write batch (Tx) that every financial operation goes through.

export interface Env { DB: D1Database }

export type Role = 'owner' | 'manager' | 'cashier' | 'restaurant_staff' | 'fuel_staff' | 'store_staff';   // users.role (owner flag + history)
export type BizRole = 'manager' | 'cashier' | 'staff';                                                        // role inside one business
export type Perm = 'sell' | 'stock' | 'fuel' | 'purchase' | 'expense' | 'close' | 'void' | 'catalog' | 'money' | 'reports' | 'users';

export interface User {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  owner: boolean;
  businesses: string[];                       // businesses this user may open
  roles: Record<string, BizRole | 'owner'>;   // role in each of them
}

export interface Ctx {
  db: D1Database;
  req: Request;
  url: URL;
  params: Record<string, string>;
  body: any;
  user: User;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const bad = (message: string) => new HttpError(400, message);

// ── Roles ───────────────────────────────────────────────────────
export const BUSINESSES = ['restaurant', 'fuel', 'store'];

/**
 * What each business does at all — this limits everyone, the owner included.
 * The restaurant is kept simple: orders, menu, sales, expenses, customers and
 * reports (no stock, purchases, suppliers or daily closing). Its money can
 * still be moved by the owner from the owner admin ('money').
 * The fuel station has no till; its sales are pump readings.
 */
export const BUSINESS_FEATURES: Record<string, Perm[]> = {
  restaurant: ['sell', 'expense', 'void', 'catalog', 'money', 'reports', 'users'],
  store: ['sell', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports', 'users'],
  fuel: ['fuel', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports', 'users'],
};

/** What each role may do, per business. */
export const BIZ_ROLE_PERMS: Record<BizRole, Record<string, Perm[]>> = {
  manager: {
    restaurant: ['sell', 'expense', 'void', 'catalog', 'reports'],
    store: ['sell', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports'],
    fuel: ['fuel', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports'],
  },
  cashier: { restaurant: ['sell'], store: ['sell', 'close'], fuel: ['fuel', 'close'] },
  staff: { restaurant: ['sell'], store: ['sell', 'stock'], fuel: ['fuel'] },
};

export function permsIn(user: User, business: string): Perm[] {
  if (user.owner) return BUSINESS_FEATURES[business] ?? [];
  const r = user.roles[business];
  return r && r !== 'owner' ? BIZ_ROLE_PERMS[r][business] ?? [] : [];
}

/** With a business: may the user do this there? Without: in at least one business. */
export function can(user: User, perm: Perm, business?: string) {
  if (business) return permsIn(user, business).includes(perm);
  return user.owner ? true : user.businesses.some((b) => permsIn(user, b).includes(perm));
}

/** Throws unless the user holds `perm` in `business`. Returns the business id. */
export function requireBiz(ctx: Ctx, business: unknown, perm: Perm): string {
  const id = String(business ?? '');
  if (!BUSINESSES.includes(id)) throw bad('Choose a business');
  if (!ctx.user.businesses.includes(id)) throw new HttpError(403, 'You do not have access to this business');
  if (!can(ctx.user, perm, id)) throw new HttpError(403, 'You do not have permission for this action');
  return id;
}

/**
 * For read endpoints: one business, or 'all' = every business the user may
 * open (and, if `perm` is given, holds that permission in).
 */
export function bizScope(ctx: Ctx, business: unknown, perm?: Perm): string[] {
  const id = String(business ?? 'all');
  const allowed = ctx.user.businesses.filter((b) => !perm || can(ctx.user, perm, b));
  if (id === 'all' || id === '') {
    if (!allowed.length) throw new HttpError(403, 'You do not have permission for this');
    return allowed;
  }
  if (!ctx.user.businesses.includes(id)) throw new HttpError(403, 'You do not have access to this business');
  if (perm && !can(ctx.user, perm, id)) throw new HttpError(403, 'You do not have permission for this');
  return [id];
}

/** A customer or supplier linked to this business (and active). */
export async function partyIn(db: D1Database, kind: 'customer' | 'supplier', id: unknown, business: string) {
  if (!id) return null;
  const row = await first<{ id: string; name: string }>(db,
    `SELECT p.id, p.name FROM ${kind}s p JOIN ${kind}_businesses l ON l.${kind}_id = p.id AND l.business_id = ? WHERE p.id = ? AND p.active = 1`, business, String(id));
  if (!row) throw bad(`${kind === 'customer' ? 'Customer' : 'Supplier'} not found in this business`);
  return row;
}

// ── Values ──────────────────────────────────────────────────────
export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

/** Business day in East Africa Time (UTC+3). */
export function today(offsetDays = 0) {
  return new Date(Date.now() + 3 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
}
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function str(v: unknown, name: string, opts: { required?: boolean; max?: number } = {}): string | null {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (opts.required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > (opts.max ?? 500)) throw bad(`${name} is too long`);
  return s;
}

/** Whole cents. */
export function cents(v: unknown, name: string, opts: { min?: number; required?: boolean } = {}): number {
  if (v === undefined || v === null || v === '') {
    if (opts.required === false) return 0;
    throw bad(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number of cents`);
  if (n < (opts.min ?? 0)) throw bad(`${name} must be at least ${((opts.min ?? 0) / 100).toFixed(2)}`);
  if (n > 1e12) throw bad(`${name} is too large`);
  return n;
}

export function qty(v: unknown, name: string, opts: { min?: number; positive?: boolean } = {}): number {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (opts.positive && n <= 0) throw bad(`${name} must be more than zero`);
  if (opts.min !== undefined && n < opts.min) throw bad(`${name} must be at least ${opts.min}`);
  if (Math.abs(n) > 1e9) throw bad(`${name} is too large`);
  return round3(n);
}

export function bool(v: unknown) { return v === true || v === 1 || v === '1' || v === 'true'; }

/** A business date: valid, not in the future. */
export function entryDate(v: unknown): string {
  if (v === undefined || v === null || v === '') return today();
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw bad('Invalid date');
  if (s > today()) throw bad('Date cannot be in the future');
  return s;
}

export async function first<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}
export async function all<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
export const placeholders = (list: unknown[]) => list.map(() => '?').join(',');

/**
 * Rejects writes into a closed business day. Days are closed in order, so any
 * date on or before the latest closing of the business is locked: a closed
 * day's figures (and every later day's opening balance) can never change.
 */
export async function assertDayOpen(db: D1Database, business: string, date: string) {
  const last = await first<{ d: string | null }>(db, `SELECT MAX(entry_date) AS d FROM daily_closings WHERE business_id = ? AND status = 'closed'`, business);
  if (last?.d && date <= last.d) {
    throw new HttpError(409, `The ${business} business is closed up to ${last.d}. Use a later date, or ask the owner/manager to reopen that day.`);
  }
}

export async function paymentMethod(db: D1Database, id: unknown, name = 'Payment method'): Promise<string> {
  const m = await first<{ id: string }>(db, 'SELECT id FROM payment_methods WHERE id = ? AND active = 1', String(id ?? ''));
  if (!m) throw bad(`${name} is not valid`);
  return m.id;
}

// ── Journal ─────────────────────────────────────────────────────
export type Account = 'cash' | 'receivable' | 'inventory' | 'payable' | 'sales' | 'cogs' | 'expense' | 'stock_loss' | 'cash_diff' | 'transfer' | 'owner';

export interface Line {
  account: Account;
  amount: number;           // + debit, − credit (cents)
  method?: string | null;
  customer?: string | null;
  supplier?: string | null;
  category?: string | null;
}

export interface EntryHead {
  business: string;
  date: string;
  type: string;
  refType: string;
  refId: string;
  memo: string;
  amount: number;
  reversesId?: string | null;
}

/**
 * Collects every statement of one operation and runs them in a single D1
 * batch, which is one SQL transaction: either everything is saved or nothing.
 */
export class Tx {
  stmts: D1PreparedStatement[] = [];
  constructor(public db: D1Database, public user: User) {}

  run(sql: string, ...params: unknown[]) {
    this.stmts.push(this.db.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p))));
  }

  audit(action: string, entity: string, entityId: string | null, business: string | null, details?: unknown) {
    this.run(
      'INSERT INTO audit_log (user_id, business_id, action, entity, entity_id, details, created_at) VALUES (?,?,?,?,?,?,?)',
      this.user.id, business, action, entity, entityId, details === undefined ? null : JSON.stringify(details), nowIso(),
    );
  }

  /** Posts one balanced journal entry. Zero lines are dropped. */
  journal(head: EntryHead, lines: Line[]): string {
    const kept = lines.filter((l) => l.amount !== 0);
    for (const l of kept) if (!Number.isInteger(l.amount)) throw new Error(`Non-integer journal amount on ${l.account}`);
    const sum = kept.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) throw new Error(`Unbalanced journal entry (${head.type}): ${sum}`);
    const id = newId();
    if (!kept.length) return id;
    this.run(
      `INSERT INTO journal_entries (id, business_id, entry_date, type, ref_type, ref_id, memo, amount, reverses_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, head.business, head.date, head.type, head.refType, head.refId, head.memo, head.amount, head.reversesId ?? null, this.user.id, nowIso(),
    );
    for (const l of kept) {
      this.run(
        `INSERT INTO journal_lines (entry_id, business_id, entry_date, entry_type, account, method_id, customer_id, supplier_id, category, amount)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, head.business, head.date, head.type, l.account, l.method ?? null, l.customer ?? null, l.supplier ?? null, l.category ?? null, l.amount,
      );
    }
    // Keep the summary tables (migrations/0002) in step, in the same batch.
    const balances = new Map<string, { l: Line; amount: number }>();
    const days = new Map<string, { l: Line; debit: number; credit: number }>();
    for (const l of kept) {
      const bk = [l.account, l.method ?? '', l.customer ?? '', l.supplier ?? ''].join('|');
      const b = balances.get(bk) ?? { l, amount: 0 };
      b.amount += l.amount;
      balances.set(bk, b);
      const dk = [l.account, l.method ?? '', l.category ?? ''].join('|');
      const d = days.get(dk) ?? { l, debit: 0, credit: 0 };
      if (l.amount > 0) d.debit += l.amount; else d.credit -= l.amount;
      days.set(dk, d);
    }
    for (const { l, amount } of balances.values()) {
      const up = amount > 0 ? head.date : null, down = amount < 0 ? head.date : null;
      this.run(
        `INSERT INTO account_balances (business_id, account, method_id, customer_id, supplier_id, balance, first_increase, last_increase, last_decrease)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO UPDATE SET balance = balance + excluded.balance,
           first_increase = CASE WHEN first_increase IS NULL OR excluded.first_increase < first_increase THEN COALESCE(excluded.first_increase, first_increase) ELSE first_increase END,
           last_increase = CASE WHEN excluded.last_increase > COALESCE(last_increase, '') THEN excluded.last_increase ELSE last_increase END,
           last_decrease = CASE WHEN excluded.last_decrease > COALESCE(last_decrease, '') THEN excluded.last_decrease ELSE last_decrease END`,
        head.business, l.account, l.method ?? '', l.customer ?? '', l.supplier ?? '', amount, up, up, down,
      );
    }
    for (const { l, debit, credit } of days.values()) {
      this.run(
        `INSERT INTO daily_totals (business_id, entry_date, account, entry_type, method_id, category, debit, credit) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT DO UPDATE SET debit = debit + excluded.debit, credit = credit + excluded.credit`,
        head.business, head.date, l.account, head.type, l.method ?? '', l.category ?? '', debit, credit,
      );
    }
    return id;
  }

  /** Reverses every not-yet-reversed journal entry of a record, dated `date`. */
  async reverse(refType: string, refId: string, date: string, type: string, memo: string) {
    const entries = await all<{ id: string; business_id: string; amount: number }>(
      this.db,
      `SELECT e.id, e.business_id, e.amount FROM journal_entries e
       WHERE e.ref_type = ? AND e.ref_id = ? AND e.reverses_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id)`,
      refType, refId,
    );
    for (const e of entries) {
      const lines = await all<any>(this.db, 'SELECT * FROM journal_lines WHERE entry_id = ?', e.id);
      this.journal(
        { business: e.business_id, date, type, refType, refId, memo, amount: -e.amount, reversesId: e.id },
        lines.map((l) => ({ account: l.account, amount: -l.amount, method: l.method_id, customer: l.customer_id, supplier: l.supplier_id, category: l.category })),
      );
    }
  }

  stock(m: { business: string; product: string; tank?: string | null; date: string; type: string; qty: number; unitCost: number; value: number; refType: string; refId: string; reason?: string | null }) {
    this.run(
      `INSERT INTO stock_movements (id, business_id, product_id, tank_id, entry_date, type, qty, unit_cost, value, ref_type, ref_id, reason, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(), m.business, m.product, m.tank ?? null, m.date, m.type, round3(m.qty), m.unitCost, m.value, m.refType, m.refId, m.reason ?? null, this.user.id, nowIso(),
    );
    this.run('UPDATE products SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?', round3(m.qty), m.product);
    if (m.tank) this.run('UPDATE fuel_tanks SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?', round3(m.qty), m.tank);
  }

  async commit(idemKey: string | null, response: unknown) {
    if (idemKey) {
      this.stmts.unshift(
        this.db.prepare('INSERT INTO idempotency_keys (key, user_id, response, created_at) VALUES (?,?,?,?)')
          .bind(idemKey, this.user.id, JSON.stringify(response), nowIso()),
      );
    }
    try {
      await this.db.batch(this.stmts);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (idemKey && msg.includes('idempotency_keys.key')) {
        const prior = await first<{ response: string }>(this.db, 'SELECT response FROM idempotency_keys WHERE key = ?', idemKey);
        if (prior) return JSON.parse(prior.response);
      }
      if (msg.includes('CHECK constraint failed') && msg.includes('stock_qty')) throw new HttpError(409, 'Not enough stock for this transaction');
      if (msg.includes('CHECK constraint failed') && msg.includes('returned_qty')) throw new HttpError(409, 'More items returned than were sold');
      if (msg.includes('UNIQUE constraint failed: daily_closings')) throw new HttpError(409, 'This day is already closed');
      if (msg.includes('UNIQUE constraint failed: sales.business_id') || msg.includes('UNIQUE constraint failed: purchases.business_id')) {
        throw new HttpError(409, 'Another transaction was saved at the same moment. Please try again.');
      }
      if (msg.includes('UNIQUE constraint failed')) throw new HttpError(409, 'This record already exists');
      throw err;
    }
    return response;
  }
}

export function idemKey(ctx: Ctx): string | null {
  const key = ctx.req.headers.get('Idempotency-Key');
  if (!key) return null;
  if (key.length > 100) throw bad('Invalid Idempotency-Key');
  return `${ctx.user.id}:${key}`;
}
