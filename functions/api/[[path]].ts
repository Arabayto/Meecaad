// The whole API: one Cloudflare Pages Function in the same project as the SPA.
// The D1 database is reached only through the `DB` binding here; no database
// credentials or API tokens ever reach the browser.

import * as auth from '../../server/auth';
import * as cat from '../../server/catalog';
import * as fuel from '../../server/fuel';
import * as ops from '../../server/ops';
import * as rep from '../../server/reports';
import { ensureSchema } from '../../server/migrate';
import { BUSINESSES, HttpError, all, can, today, type Ctx, type Env, type Perm } from '../../server/lib';

type Handler = (ctx: Ctx) => Promise<unknown>;
// [method, path, handler, permission required for any business ('' = signed in)]
const routes: [string, string, Handler, Perm | ''][] = [
  ['GET', '/bootstrap', bootstrap, ''],
  ['POST', '/auth/password', auth.changeOwnPassword, ''],
  ['GET', '/users', auth.listUsers, 'users'],
  ['POST', '/users', auth.createUser, 'users'],
  ['PATCH', '/users/:id', auth.updateUser, 'users'],

  ['GET', '/payment-methods', cat.listMethods, ''],
  ['POST', '/payment-methods', cat.createMethod, 'users'],
  ['PATCH', '/payment-methods/:id', cat.updateMethod, 'users'],

  ['GET', '/products', cat.listProducts, ''],
  ['POST', '/products', cat.createProduct, 'catalog'],
  ['PATCH', '/products/:id', cat.updateProduct, 'catalog'],
  ['GET', '/products/:id/prices', cat.priceHistory, ''],
  ['POST', '/stock/adjust', cat.adjustStock, ''],
  ['GET', '/stock/movements', cat.stockMovements, ''],

  ['GET', '/customers', cat.customers.list, ''],
  ['POST', '/customers', cat.customers.create, ''],
  ['PATCH', '/customers/:id', cat.customers.update, ''],
  ['GET', '/customers/:id/statement', cat.customers.statement, ''],
  ['GET', '/suppliers', cat.suppliers.list, ''],
  ['POST', '/suppliers', cat.suppliers.create, ''],
  ['PATCH', '/suppliers/:id', cat.suppliers.update, ''],
  ['GET', '/suppliers/:id/statement', cat.suppliers.statement, ''],

  ['GET', '/sales', ops.listSales, ''],
  ['POST', '/sales', ops.createSale, ''],
  ['GET', '/sales/:id', ops.getSale, ''],
  ['POST', '/sales/:id/void', ops.voidSale, ''],
  ['POST', '/sales/:id/return', ops.returnSale, ''],
  ['GET', '/purchases', ops.listPurchases, ''],
  ['POST', '/purchases', ops.createPurchase, ''],
  ['POST', '/purchases/:id/void', ops.voidPurchase, ''],
  ['GET', '/expenses', ops.listExpenses, ''],
  ['POST', '/expenses', ops.createExpense, ''],
  ['POST', '/expenses/:id/void', ops.voidExpense, ''],
  ['GET', '/money', ops.listMovements, ''],
  ['POST', '/money', ops.createMovement, ''],
  ['POST', '/money/:id/void', ops.voidMovement, ''],

  ['GET', '/fuel/setup', cat.fuelSetup, ''],
  ['POST', '/fuel/tanks', cat.createTank, ''],
  ['PATCH', '/fuel/tanks/:id', cat.updateTank, ''],
  ['POST', '/fuel/pumps', cat.createPump, ''],
  ['PATCH', '/fuel/pumps/:id', cat.updatePump, ''],
  ['GET', '/fuel/shifts', fuel.listShifts, ''],
  ['POST', '/fuel/shifts', fuel.createShift, ''],
  ['GET', '/fuel/shifts/:id', fuel.getShift, ''],
  ['POST', '/fuel/shifts/:id/void', fuel.voidShift, ''],
  ['GET', '/fuel/dips', fuel.listDips, ''],
  ['POST', '/fuel/dips', fuel.createDip, ''],
  ['GET', '/fuel/reconciliation', fuel.reconciliation, ''],

  ['GET', '/dashboard', rep.dashboard, 'reports'],
  ['GET', '/reports/summary', rep.summary, 'reports'],
  ['GET', '/reports/ledger', rep.ledger, 'reports'],
  ['GET', '/reports/entries/:id', rep.entryLines, 'reports'],
  ['GET', '/balances', rep.balances, ''],
  ['GET', '/closing/preview', rep.closingPreview, 'close'],
  ['GET', '/closing', rep.listClosings, ''],
  ['POST', '/closing', rep.createClosing, 'close'],
  ['GET', '/closing/:id', rep.getClosing, ''],
  ['POST', '/closing/:id/reopen', rep.reopenClosing, 'void'],
  ['GET', '/audit', rep.auditLog, 'users'],
];

async function bootstrap(ctx: Ctx) {
  const [businesses, methods] = await Promise.all([
    all(ctx.db, `SELECT * FROM businesses WHERE id IN (${ctx.user.businesses.map(() => '?').join(',') || "''"}) ORDER BY sort`, ...ctx.user.businesses),
    all(ctx.db, 'SELECT * FROM payment_methods ORDER BY sort, name'),
  ]);
  return { user: ctx.user, businesses, methods, today: today() };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/'), b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  try {
    // Mutations must come from our own page: a cross-site form or script cannot set this header.
    if (method !== 'GET' && request.headers.get('X-Requested-With') !== 'meecaad') throw new HttpError(403, 'Request blocked');
    const body = method === 'GET' ? {} : await request.json().catch(() => ({}));
    const db = env.DB;
    if (!db) throw new HttpError(503, 'The database is not connected yet. Put your D1 database ID in wrangler.toml (see docs/SETUP_FROM_PHONE.md) and redeploy.');
    await ensureSchema(db);

    if (path === '/auth/me' && method === 'GET') return await auth.me(db, request);
    if (path === '/auth/login' && method === 'POST') return await auth.login(db, request, body);
    if (path === '/auth/setup' && method === 'POST') return await auth.setup(db, request, body);
    if (path === '/auth/logout' && method === 'POST') return await auth.logout(db, request);

    const user = await auth.userFromRequest(db, request);
    if (!user) throw new HttpError(401, 'Please sign in');
    for (const [m, pattern, handler, perm] of routes) {
      if (m !== method) continue;
      const params = match(pattern, path);
      if (!params) continue;
      if (perm && !can(user, perm)) throw new HttpError(403, 'You do not have permission for this action');
      if (!user.businesses.length && BUSINESSES.length) throw new HttpError(403, 'Your account has no business assigned');
      return json(await handler({ db, req: request, url, params, body, user }));
    }
    throw new HttpError(404, 'Not found');
  } catch (err: any) {
    if (err instanceof HttpError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: 'Something went wrong. Nothing was saved. Please try again.' }, 500);
  }
}
