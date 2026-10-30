// Sign-in, sessions and user management.
// Passwords: PBKDF2-SHA256 (WebCrypto). Sessions: random token in an HttpOnly
// cookie; only its SHA-256 is stored, so a database leak does not leak sessions.

import { BUSINESSES, HttpError, STAFF_BUSINESS, Tx, all, bad, bool, first, newId, nowIso, str, type Ctx, type Role, type User } from './lib';

const COOKIE = 'mc_session';
const SESSION_DAYS = 7;
const ITERATIONS = 100_000;
const ROLES: Role[] = ['owner', 'manager', 'cashier', 'restaurant_staff', 'fuel_staff', 'store_staff'];

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

function validPassword(v: unknown) {
  const p = String(v ?? '');
  if (p.length < 8) throw bad('Password must be at least 8 characters');
  if (p.length > 200) throw bad('Password is too long');
  return p;
}

async function loadUser(db: D1Database, id: string): Promise<User | null> {
  const u = await first<any>(db, 'SELECT id, username, full_name, role FROM users WHERE id = ? AND active = 1', id);
  if (!u) return null;
  const businesses = u.role === 'owner'
    ? BUSINESSES
    : (await all<{ business_id: string }>(db, 'SELECT business_id FROM user_businesses WHERE user_id = ?', id)).map((r) => r.business_id);
  return { ...u, businesses: BUSINESSES.filter((b) => businesses.includes(b)) };
}

export async function userFromRequest(db: D1Database, req: Request): Promise<User | null> {
  const token = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const session = await first<{ user_id: string }>(db, 'SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?', await sha256(token), nowIso());
  return session ? loadUser(db, session.user_id) : null;
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
    db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?,?,?,?)').bind(await sha256(token), userId, expires, nowIso()),
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
    db.prepare(`INSERT INTO users (id, username, full_name, role, password_hash, created_at) VALUES (?,?,?,'owner',?,?)`)
      .bind(id, username, fullName, await hashPassword(validPassword(body.password)), nowIso()),
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, created_at) VALUES (?, 'setup', 'user', ?, ?)`).bind(id, id, nowIso()),
  ]);
  return json({ user: await loadUser(db, id) }, { 'Set-Cookie': await startSession(db, req, id) });
}

export async function login(db: D1Database, req: Request, body: any) {
  const username = String(body.username ?? '').trim();
  const u = await first<any>(db, 'SELECT * FROM users WHERE username = ?', username);
  const fail = () => new HttpError(401, 'Wrong username or password');
  if (!u || !u.active) {
    await verifyPassword(String(body.password ?? ''), 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    throw fail();
  }
  if (u.locked_until && u.locked_until > nowIso()) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
  if (!(await verifyPassword(String(body.password ?? ''), u.password_hash))) {
    const failed = u.failed_logins + 1;
    const lock = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failed, lock, u.id).run();
    throw fail();
  }
  await db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(u.id).run();
  return json({ user: await loadUser(db, u.id) }, { 'Set-Cookie': await startSession(db, req, u.id) });
}

export async function logout(db: D1Database, req: Request) {
  const token = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
  return json({ ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
}

// ── User management (owner) ─────────────────────────────────────
function userBusinesses(role: Role, list: unknown): string[] {
  if (role === 'owner') return [];
  const staff = STAFF_BUSINESS[role];
  if (staff) return [staff];
  const ids = Array.isArray(list) ? list.map(String).filter((b) => BUSINESSES.includes(b)) : [];
  if (!ids.length) throw bad('Choose at least one business for this employee');
  return [...new Set(ids)];
}

function role(v: unknown): Role {
  if (!ROLES.includes(v as Role)) throw bad('Choose a valid role');
  return v as Role;
}

export async function listUsers(ctx: Ctx) {
  const users = await all<any>(ctx.db, `SELECT id, username, full_name, phone, role, active, created_at FROM users ORDER BY active DESC, full_name`);
  const links = await all<any>(ctx.db, 'SELECT user_id, business_id FROM user_businesses');
  return users.map((u) => ({
    ...u,
    businesses: u.role === 'owner' ? BUSINESSES : links.filter((l) => l.user_id === u.id).map((l) => l.business_id),
  }));
}

export async function createUser(ctx: Ctx) {
  const b = ctx.body;
  const r = role(b.role);
  const id = newId();
  const tx = new Tx(ctx.db, ctx.user);
  tx.run(`INSERT INTO users (id, username, full_name, phone, role, password_hash, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    id, str(b.username, 'Username', { required: true, max: 60 }), str(b.fullName, 'Full name', { required: true, max: 120 }),
    str(b.phone, 'Phone', { max: 40 }), r, await hashPassword(validPassword(b.password)), nowIso(), ctx.user.id);
  for (const biz of userBusinesses(r, b.businesses)) tx.run('INSERT INTO user_businesses (user_id, business_id) VALUES (?,?)', id, biz);
  tx.audit('create', 'user', id, null, { username: b.username, role: r });
  return tx.commit(null, { id });
}

export async function updateUser(ctx: Ctx) {
  const id = ctx.params.id;
  const existing = await first<any>(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'User not found');
  const b = ctx.body;
  const r = role(b.role ?? existing.role);
  const active = b.active === undefined ? existing.active : bool(b.active) ? 1 : 0;
  if (id === ctx.user.id && (r !== 'owner' || !active)) throw bad('You cannot remove your own owner access');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE users SET full_name = ?, phone = ?, role = ?, active = ? WHERE id = ?',
    str(b.fullName ?? existing.full_name, 'Full name', { required: true, max: 120 }), str(b.phone ?? existing.phone, 'Phone', { max: 40 }), r, active, id);
  tx.run('DELETE FROM user_businesses WHERE user_id = ?', id);
  for (const biz of userBusinesses(r, b.businesses)) tx.run('INSERT INTO user_businesses (user_id, business_id) VALUES (?,?)', id, biz);
  if (b.password) {
    tx.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', await hashPassword(validPassword(b.password)), id);
  }
  if (b.password || !active || r !== existing.role) tx.run('DELETE FROM sessions WHERE user_id = ?', id);
  tx.audit('update', 'user', id, null, { role: r, active, passwordReset: Boolean(b.password) });
  return tx.commit(null, { id });
}

export async function changeOwnPassword(ctx: Ctx) {
  const u = await first<any>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
  if (!(await verifyPassword(String(ctx.body.currentPassword ?? ''), u.password_hash))) throw bad('Current password is wrong');
  const tx = new Tx(ctx.db, ctx.user);
  tx.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(validPassword(ctx.body.newPassword)), ctx.user.id);
  tx.audit('change_password', 'user', ctx.user.id, null);
  return tx.commit(null, { ok: true });
}
