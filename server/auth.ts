// Sign-in, sessions and user management.
// Passwords: PBKDF2-SHA256 (WebCrypto). Sessions: random token in an HttpOnly
// cookie; only its SHA-256 is stored, so a database leak does not leak sessions.

import { BUSINESSES, HttpError, Tx, all, bad, bool, first, newId, nowIso, str, type BizRole, type Ctx, type Role, type User } from './lib';

const COOKIE = 'mc_session';
const SESSION_DAYS = 7;                    // a session ends after 7 days at most…
const IDLE_HOURS = 12;                     // …or after 12 hours without use
const TOUCH_MINUTES = 10;                  // how often "last used" is written (keeps writes low)
const IP_FAILS = 20;                       // failed sign-ins from one address in 15 minutes before it is slowed down
const ITERATIONS = 100_000;
const BIZ_ROLES: BizRole[] = ['manager', 'cashier', 'staff'];

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

async function verifyPassword(password: string, stored: string) {
  const [, iter, salt, hash] = stored.split('$');
  const actual = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const expected = unb64(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', '87654321', 'qwerty123', 'qwertyuiop',
  'abc12345', 'iloveyou', '11111111', '00000000', 'admin123', 'welcome1', 'letmein1', 'meecaad1', 'meecaad123', 'somalia1', 'hargeisa1']);

/** At least 8 characters with letters and numbers; not the username and not a well-known password. */
export function validPassword(v: unknown, username?: string | null) {
  const p = String(v ?? '');
  if (p.length < 8) throw bad('Password must be at least 8 characters');
  if (p.length > 200) throw bad('Password is too long');
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) throw bad('Password must contain both letters and numbers');
  if (COMMON.has(p.toLowerCase())) throw bad('This password is too easy to guess. Choose another one.');
  if (username && p.toLowerCase().includes(username.toLowerCase())) throw bad('The password must not contain the username');
  return p;
}

const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0].trim() ?? 'local';

async function loadUser(db: D1Database, id: string): Promise<User | null> {
  const u = await first<any>(db, 'SELECT id, username, full_name, role FROM users WHERE id = ? AND active = 1', id);
  if (!u) return null;
  const owner = u.role === 'owner';
  const links = owner ? [] : await all<{ business_id: string; role: BizRole }>(db, 'SELECT business_id, role FROM user_businesses WHERE user_id = ?', id);
  const roles: User['roles'] = owner ? Object.fromEntries(BUSINESSES.map((b) => [b, 'owner'])) : Object.fromEntries(links.map((l) => [l.business_id, l.role]));
  return { ...u, owner, roles, businesses: BUSINESSES.filter((b) => roles[b]) };
}

export async function userFromRequest(db: D1Database, req: Request): Promise<User | null> {
  const token = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const id = await sha256(token);
  const now = Date.now();
  const session = await first<{ user_id: string; last_seen_at: string | null }>(db, 'SELECT user_id, last_seen_at FROM sessions WHERE id = ? AND expires_at > ?', id, nowIso());
  if (!session) return null;
  const seen = Date.parse(session.last_seen_at ?? '') || 0;
  if (now - seen > IDLE_HOURS * 3600_000) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  if (now - seen > TOUCH_MINUTES * 60_000) await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(), id).run();
  return loadUser(db, session.user_id);
}

function cookie(req: Request, token: string, maxAge: number) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function startSession(db: D1Database, req: Request, userId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
    db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
      .bind(await sha256(token), userId, expires, nowIso(), nowIso(), clientIp(req), (req.headers.get('User-Agent') ?? '').slice(0, 200)),
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), userId),
  ]);
  return cookie(req, token, SESSION_DAYS * 86_400);
}

const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// ── Public endpoints ────────────────────────────────────────────
export async function me(db: D1Database, req: Request) {
  const user = await userFromRequest(db, req);
  const setupRequired = !user && !(await first(db, 'SELECT id FROM users LIMIT 1'));
  return json({ user, setupRequired });
}

/** First run only: creates the owner account. */
export async function setup(db: D1Database, req: Request, body: any) {
  if (await first(db, 'SELECT id FROM users LIMIT 1')) throw new HttpError(409, 'The system is already set up');
  const id = newId();
  const username = str(body.username, 'Username', { required: true, max: 60 })!;
  const fullName = str(body.fullName, 'Full name', { required: true, max: 120 })!;
  await db.batch([
    db.prepare(`INSERT INTO users (id, username, full_name, role, password_hash, created_at, password_changed_at) VALUES (?,?,?,'owner',?,?,?)`)
      .bind(id, username, fullName, await hashPassword(validPassword(body.password, username)), nowIso(), nowIso()),
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, created_at) VALUES (?, 'setup', 'user', ?, ?)`).bind(id, id, nowIso()),
  ]);
  return json({ user: await loadUser(db, id) }, { 'Set-Cookie': await startSession(db, req, id) });
}

export async function login(db: D1Database, req: Request, body: any) {
  const username = String(body.username ?? '').trim().slice(0, 60);
  const password = String(body.password ?? '').slice(0, 200);
  const ip = clientIp(req);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  // One address trying many passwords (or many usernames) is slowed down.
  const recent = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND created_at > ? AND ok = 0', ip, since);
  if ((recent?.n ?? 0) >= IP_FAILS) throw new HttpError(429, 'Too many wrong attempts from this device. Try again in 15 minutes.');
  const attempt = (ok: 0 | 1) => db.prepare('INSERT INTO login_attempts (ip, username, ok, created_at) VALUES (?,?,?,?)').bind(ip, username, ok, nowIso());
  const u = await first<any>(db, 'SELECT * FROM users WHERE username = ?', username);
  const fail = () => new HttpError(401, 'Wrong username or password');
  if (!u || !u.active) {
    await verifyPassword(password, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await attempt(0).run();
    throw fail();
  }
  if (u.locked_until && u.locked_until > nowIso()) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
  if (!(await verifyPassword(password, u.password_hash))) {
    const failed = u.failed_logins + 1;
    const lock = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await db.batch([
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failed, lock, u.id),
      attempt(0),
      ...(lock ? [db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'account_locked', 'user', ?, ?, ?)`)
        .bind(u.id, u.id, JSON.stringify({ ip, reason: '5 wrong passwords' }), nowIso())] : []),
    ]);
    throw fail();
  }
  await db.batch([
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(u.id),
    attempt(1),
    db.prepare('DELETE FROM login_attempts WHERE created_at < ?').bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'sign_in', 'user', ?, ?, ?)`)
      .bind(u.id, u.id, JSON.stringify({ ip }), nowIso()),
  ]);
  return json({ user: await loadUser(db, u.id) }, { 'Set-Cookie': await startSession(db, req, u.id) });
}

export async function logout(db: D1Database, req: Request) {
  const token = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
  return json({ ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
}

// ── User management (owner) ─────────────────────────────────────
// A user is either the owner (everything) or has a role in each business they work in,
// e.g. { store: 'manager', restaurant: 'cashier' }.
function access(owner: boolean, v: unknown): [string, BizRole][] {
  if (owner) return [];
  const entries = Object.entries((v && typeof v === 'object' ? v : {}) as Record<string, unknown>)
    .filter(([b, r]) => BUSINESSES.includes(b) && r);
  for (const [, r] of entries) if (!BIZ_ROLES.includes(r as BizRole)) throw bad('Choose a valid role');
  if (!entries.length) throw bad('Choose at least one business and the role in it');
  return entries as [string, BizRole][];
}

/** users.role keeps a summary for history; permissions come from the per-business roles. */
function summaryRole(owner: boolean, a: [string, BizRole][]): Role {
  if (owner) return 'owner';
  if (a.some(([, r]) => r === 'manager')) return 'manager';
  if (a.some(([, r]) => r === 'cashier')) return 'cashier';
  return `${a[0][0]}_staff` as Role;
}

export async function listUsers(ctx: Ctx) {
  const [users, links, sessions] = await Promise.all([
    all<any>(ctx.db, `SELECT id, username, full_name, phone, role, active, created_at, last_login_at, password_changed_at,
                        CASE WHEN locked_until > ? THEN locked_until END AS locked_until FROM users ORDER BY active DESC, full_name`, nowIso()),
    all<any>(ctx.db, 'SELECT user_id, business_id, role FROM user_businesses'),
    all<any>(ctx.db, 'SELECT user_id, COUNT(*) AS n, MAX(last_seen_at) AS seen FROM sessions WHERE expires_at > ? GROUP BY user_id', nowIso()),
  ]);
  return users.map((u) => ({
    ...u,
    owner: u.role === 'owner',
    sessions: sessions.find((x) => x.user_id === u.id)?.n ?? 0,
    last_seen_at: sessions.find((x) => x.user_id === u.id)?.seen ?? null,
    access: u.role === 'owner' ? {} : Object.fromEntries(links.filter((l) => l.user_id === u.id).map((l) => [l.business_id, l.role])),
  }));
}

export async function createUser(ctx: Ctx) {
  const b = ctx.body;
  const owner = bool(b.owner);
  const a = access(owner, b.access);
  const id = newId();
  const username = str(b.username, 'Username', { required: true, max: 60 })!;
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) throw bad('Username: at least 3 letters or numbers (no spaces)');
  if (await first(ctx.db, 'SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'This username is already taken');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO users (id, username, full_name, phone, role, password_hash, created_at, created_by, password_changed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, username, str(b.fullName, 'Full name', { required: true, max: 120 }),
    str(b.phone, 'Phone', { max: 40 }), summaryRole(owner, a), await hashPassword(validPassword(b.password, username)), nowIso(), ctx.user.id, nowIso());
  for (const [biz, r] of a) tx.run('INSERT INTO user_businesses (user_id, business_id, role) VALUES (?,?,?)', id, biz, r);
  tx.audit('create', 'user', id, null, { username: b.username, owner, access: Object.fromEntries(a) });
  return tx.commit(null, { id });
}

export async function updateUser(ctx: Ctx) {
  const id = ctx.params.id;
  const existing = await first<any>(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'User not found');
  const b = ctx.body;
  const owner = b.owner === undefined ? existing.role === 'owner' : bool(b.owner);
  const before = await all<any>(ctx.db, 'SELECT business_id, role FROM user_businesses WHERE user_id = ?', id);
  const a = access(owner, b.access ?? Object.fromEntries(before.map((l) => [l.business_id, l.role])));
  const active = b.active === undefined ? existing.active : bool(b.active) ? 1 : 0;
  if (id === ctx.user.id && (!owner || !active)) throw bad('You cannot remove your own owner access');
  if (existing.role === 'owner' && (!owner || !active)) {
    const owners = await first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id <> ?`, id);
    if (!owners?.n) throw bad('There must always be at least one active owner');
  }
  const changedAccess = JSON.stringify(Object.fromEntries(a)) !== JSON.stringify(Object.fromEntries(before.map((l) => [l.business_id, l.role]))) || owner !== (existing.role === 'owner');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE users SET full_name = ?, phone = ?, role = ?, active = ? WHERE id = ?',
    str(b.fullName ?? existing.full_name, 'Full name', { required: true, max: 120 }), str(b.phone ?? existing.phone, 'Phone', { max: 40 }), summaryRole(owner, a), active, id);
  tx.run('DELETE FROM user_businesses WHERE user_id = ?', id);
  for (const [biz, r] of a) tx.run('INSERT INTO user_businesses (user_id, business_id, role) VALUES (?,?,?)', id, biz, r);
  if (b.password) {
    tx.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, password_changed_at = ? WHERE id = ?',
      await hashPassword(validPassword(b.password, existing.username)), nowIso(), id);
  }
  if (b.unlock) tx.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', id);
  if (b.password || !active || changedAccess) tx.run('DELETE FROM sessions WHERE user_id = ?', id);
  tx.audit('update', 'user', id, null, { owner, access: Object.fromEntries(a), active, passwordReset: Boolean(b.password) });
  return tx.commit(null, { id });
}

export async function changeOwnPassword(ctx: Ctx) {
  const u = await first<any>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
  if (!(await verifyPassword(String(ctx.body.currentPassword ?? '').slice(0, 200), u.password_hash))) throw bad('Current password is wrong');
  const next = validPassword(ctx.body.newPassword, ctx.user.username);
  if (next === String(ctx.body.currentPassword)) throw bad('Choose a new password different from the current one');
  const current = await sessionId(ctx.req);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', await hashPassword(next), nowIso(), ctx.user.id);
  // Every other device is signed out; this one stays signed in.
  tx.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', ctx.user.id, current ?? '');
  tx.audit('change_password', 'user', ctx.user.id, null);
  return tx.commit(null, { ok: true });
}

async function sessionId(req: Request) {
  const token = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return token ? sha256(token) : null;
}

/** Owner: sign a person out on every device (e.g. a lost phone). */
export async function signOutUser(ctx: Ctx) {
  const u = await first<any>(ctx.db, 'SELECT id FROM users WHERE id = ?', ctx.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const current = await sessionId(ctx.req);
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, current ?? '');
  tx.audit('sign_out_everywhere', 'user', u.id, null);
  return tx.commit(null, { ok: true });
}

/** Owner: recent sign-ins and failed attempts. */
export async function signInLog(ctx: Ctx) {
  return all(ctx.db, `SELECT a.id, a.ip, a.username, a.ok, a.created_at, u.full_name FROM login_attempts a LEFT JOIN users u ON u.username = a.username
                      ORDER BY a.created_at DESC LIMIT 200`);
}
