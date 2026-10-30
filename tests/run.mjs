// End-to-end test against the real stack: wrangler Pages dev server + local D1
// (fresh database each run). Walks through the daily workflows of all three
// businesses and checks every figure against hand-calculated values.
//
//   npm test            (builds nothing; uses dist/ if present, else a stub page)

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}/api`;
const persist = mkdtempSync(join(tmpdir(), 'meecaad-test-'));
if (!existsSync('dist/index.html')) { mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', '<!doctype html><title>test</title>'); }

const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } }).toString();
// No migration step: the app must create its own schema on the first request.
const sql = (q) => JSON.parse(wrangler('d1', 'execute', 'meecaad', '--local', '--persist-to', persist, '--json', '--command', q))[0].results;

const server = spawn('npx', ['wrangler', 'pages', 'dev', 'dist', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/auth/me`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start\n' + log);
}

function client() {
  let cookie = '';
  const call = async (method, path, body, key) => {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'meecaad', Cookie: cookie };
    if (method === 'POST') headers['Idempotency-Key'] = key ?? crypto.randomUUID();
    const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  };
  const ok = async (method, path, body, key) => {
    const r = await call(method, path, body, key);
    if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { call, ok, get: (p) => ok('GET', p), post: (p, b, k) => ok('POST', p, b, k) };
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e}`); process.exitCode = 1; throw e; }
}

const owner = client();
const store = (p) => p.figures.today.store;

try {
  await waitUp();
  console.log('Meecaad end-to-end tests');
  let customer, supplier, rice, tea, sugar, diesel, tank, pump, sale1, sale2, today;

  await step('first run: owner account setup, login, CSRF and auth guards', async () => {
    assert.equal((await owner.get('/auth/me')).setupRequired, true);
    await owner.post('/auth/setup', { fullName: 'Owner', username: 'owner', password: 'owner-pass-1' });
    assert.equal((await owner.call('POST', '/auth/setup', { fullName: 'X', username: 'x', password: 'xxxxxxxx' })).status, 409);
    const anon = client();
    assert.equal((await anon.call('GET', '/dashboard')).status, 401);
    assert.equal((await anon.call('POST', '/auth/login', { username: 'owner', password: 'wrong-pass' })).status, 401);
    const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, 'mutation without X-Requested-With is blocked');
    const boot = await owner.get('/bootstrap');
    today = boot.today;
    assert.equal(boot.businesses.length, 3);
    assert.deepEqual(boot.methods.map((m) => m.name), ['Cash', 'Zaad', 'Edahab']);
  });

  await step('setup: customer, supplier, products with opening stock, owner money', async () => {
    customer = (await owner.post('/customers', { name: 'Ahmed Ali', phone: '063' })).id;
    supplier = (await owner.post('/suppliers', { name: 'Berbera Traders' })).id;
    rice = (await owner.post('/products', { business: 'store', name: 'Rice 25kg', kind: 'item', salePrice: 2500, openingQty: 10, openingCost: 2000, reorderLevel: 3 })).id;
    tea = (await owner.post('/products', { business: 'restaurant', name: 'Tea', kind: 'menu', salePrice: 50 })).id;
    sugar = (await owner.post('/products', { business: 'restaurant', name: 'Sugar', kind: 'ingredient', unit: 'kg', openingQty: 10, openingCost: 100 })).id;
    assert.equal((await owner.call('POST', '/products', { business: 'store', name: 'Bad', kind: 'fuel' })).status, 400);
    await owner.post('/money', { type: 'owner_in', business: 'store', method: 'cash', amount: 20000, note: 'Opening cash' });
  });

  await step('store: normal cash sale (with idempotent retry)', async () => {
    const key = crypto.randomUUID();
    const body = { business: 'store', items: [{ product: rice, qty: 2 }], payments: [{ method: 'cash', amount: 5000 }] };
    sale1 = (await owner.post('/sales', body, key)).id;
    assert.equal((await owner.post('/sales', body, key)).id, sale1, 'double click returns the first sale');
    const sales = await owner.get(`/sales?business=store`);
    assert.equal(sales.length, 1, 'only one sale was saved');
    const s = await owner.get(`/sales/${sale1}`);
    assert.equal(s.total, 5000); assert.equal(s.cost_total, 4000); assert.equal(s.number, 1);
  });

  await step('store: mobile payment sale split across Zaad and Edahab', async () => {
    sale2 = (await owner.post('/sales', { business: 'store', items: [{ product: rice, qty: 1 }], payments: [{ method: 'zaad', amount: 1500 }, { method: 'edahab', amount: 1000 }] })).id;
    const bad = await owner.call('POST', '/sales', { business: 'store', items: [{ product: rice, qty: 1 }], payments: [{ method: 'zaad', amount: 1000 }] });
    assert.equal(bad.status, 400, 'unpaid balance without a customer is rejected');
  });

  await step('store: credit sale, then debt collection reduces the debt (not sales)', async () => {
    await owner.post('/sales', { business: 'store', customer, items: [{ product: rice, qty: 2 }], payments: [] });
    let c = (await owner.get('/customers?business=store')).find((x) => x.id === customer);
    assert.equal(c.balance, 5000);
    await owner.post('/money', { type: 'customer_payment', business: 'store', customer, method: 'cash', amount: 3000 });
    assert.equal((await owner.call('POST', '/money', { type: 'customer_payment', business: 'store', customer, method: 'cash', amount: 3000 })).status, 400, 'cannot collect more than owed');
    c = (await owner.get('/customers?business=store')).find((x) => x.id === customer);
    assert.equal(c.balance, 2000);
    const d = await owner.get('/dashboard?business=store');
    assert.equal(store(d).revenue, 12500, 'collection is not counted as a sale');
  });

  await step('store: purchase on part credit updates stock and average cost; supplier payment', async () => {
    await owner.post('/purchases', { business: 'store', supplier, items: [{ product: rice, qty: 10, total: 22000 }], paid: 10000, method: 'cash' });
    let p = (await owner.get('/products?business=store')).find((x) => x.id === rice);
    assert.equal(p.stock_qty, 15);
    assert.ok(Math.abs(p.avg_cost - 2133.333) < 0.01, `avg ${p.avg_cost}`);
    await owner.post('/money', { type: 'supplier_payment', business: 'store', supplier, method: 'cash', amount: 5000 });
    const s = (await owner.get('/suppliers?business=store')).find((x) => x.id === supplier);
    assert.equal(s.balance, 7000);
  });

  await step('store: expense, product return, cancelled sale', async () => {
    await owner.post('/expenses', { business: 'store', category: 'Rent', amount: 3000, method: 'cash' });
    const s = await owner.get(`/sales/${sale1}`);
    assert.equal((await owner.call('POST', `/sales/${sale1}/return`, { items: [{ saleItem: s.items[0].id, qty: 1 }], refundMethod: 'cash' })).status, 400, 'reason required');
    const ret = await owner.post(`/sales/${sale1}/return`, { items: [{ saleItem: s.items[0].id, qty: 1 }], refundMethod: 'cash', reason: 'Torn bag' });
    assert.equal(ret.amount, 2500);
    assert.equal((await owner.call('POST', `/sales/${sale1}/return`, { items: [{ saleItem: s.items[0].id, qty: 5 }], refundMethod: 'cash', reason: 'x' })).status, 400);
    await owner.post(`/sales/${sale2}/void`, { reason: 'Entered by mistake' });
    assert.equal((await owner.call('POST', `/sales/${sale2}/void`, { reason: 'again' })).status, 409);
    const p = (await owner.get('/products?business=store')).find((x) => x.id === rice);
    assert.equal(p.stock_qty, 17);
    assert.equal(Math.round(p.stock_qty * p.avg_cost), 36000);
    const big = await owner.call('POST', '/sales', { business: 'store', items: [{ product: rice, qty: 100 }], payments: [{ method: 'cash', amount: 250000 }] });
    assert.equal(big.status, 409, 'cannot sell more than the stock');
  });

  await step('restaurant: menu sale, kitchen usage, waste', async () => {
    await owner.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 10 }], payments: [{ method: 'cash', amount: 500 }] });
    await owner.post('/stock/adjust', { product: sugar, type: 'usage', qty: 2 });
    assert.equal((await owner.call('POST', '/stock/adjust', { product: sugar, type: 'waste', qty: 1 })).status, 400, 'waste needs a reason');
    await owner.post('/stock/adjust', { product: sugar, type: 'waste', qty: 1, reason: 'Got wet' });
    const r = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant;
    assert.deepEqual([r.revenue, r.cogs, r.losses, r.profit], [500, 200, 100, 200]);
  });

  await step('fuel: tank, pump, delivery, shift readings with shortage, tank dip', async () => {
    diesel = (await owner.post('/products', { business: 'fuel', name: 'Diesel', kind: 'fuel', unit: 'L', salePrice: 100 })).id;
    tank = (await owner.post('/fuel/tanks', { product: diesel, name: 'Tank 1', capacity: 10000, openingQty: 1000, openingCost: 80 })).id;
    pump = (await owner.post('/fuel/pumps', { tank, name: 'Pump 1', meter: 5000 })).id;
    await owner.post('/purchases', { business: 'fuel', supplier, items: [{ product: diesel, tank, qty: 2000, total: 170000 }], paid: 0 });
    const shift = { readings: [{ pump, closing: 5300 }], payments: [{ method: 'cash', amount: 25000 }, { method: 'zaad', amount: 4000 }], credits: [{ customer, amount: 500 }] };
    const noReason = await owner.call('POST', '/fuel/shifts', shift);
    assert.equal(noReason.status, 400); assert.match(noReason.data.message, /short by 5\.00/);
    const s = await owner.post('/fuel/shifts', { ...shift, differenceReason: 'Attendant gave wrong change' });
    assert.deepEqual([s.liters, s.expected, s.difference], [300, 30000, -500]);
    assert.equal((await owner.call('POST', '/fuel/shifts', { readings: [{ pump, closing: 5200 }] })).status, 400, 'meter cannot go backwards');
    const dip = await owner.post('/fuel/dips', { tank, measuredQty: 2690, reason: 'Evaporation / leak check' });
    assert.deepEqual([dip.variance, dip.value], [-10, -833]);
    const rec = await owner.get('/fuel/reconciliation');
    const t = rec.tanks[0];
    assert.deepEqual([t.opened, t.delivered, t.sold, t.dip_variance, t.closing], [1000, 2000, 300, -10, 2690]);
    const f = (await owner.get('/dashboard?business=fuel')).figures.today.fuel;
    assert.deepEqual([f.revenue, f.cogs, f.losses, f.cashDiff, f.profit], [30000, 25000, 833, 500, 3667]);
  });

  await step('transfer between businesses is not revenue or expense', async () => {
    const before = (await owner.get('/dashboard')).figures.today.all;
    await owner.post('/money', { type: 'transfer', business: 'store', method: 'cash', toBusiness: 'fuel', toMethod: 'cash', amount: 1000 });
    const after = (await owner.get('/dashboard')).figures.today.all;
    assert.deepEqual(after, before);
  });

  await step('daily cash closing: difference must be explained, day locks, reopen', async () => {
    const pre = await owner.get(`/closing/preview?business=store&date=${today}`);
    const cash = pre.lines.find((l) => l.method_id === 'cash');
    assert.equal(cash.opening, 0);
    assert.equal(cash.expected, 6500);
    assert.deepEqual([cash.sales_in, cash.collections, cash.expenses_out, cash.suppliers_out, cash.transfers], [2500, 3000, -3000, -15000, 19000]);
    const counted = { cash: 6400, zaad: 0, edahab: 0 };
    assert.equal((await owner.call('POST', '/closing', { business: 'store', date: today, counted })).status, 400, 'explanation required');
    const closing = await owner.post('/closing', { business: 'store', date: today, counted, explanation: 'Missing 1 dollar' });
    assert.equal((await owner.call('POST', '/closing', { business: 'store', date: today, counted, explanation: 'again' })).status, 409);
    const locked = await owner.call('POST', '/sales', { business: 'store', items: [{ product: rice, qty: 1 }], payments: [{ method: 'cash', amount: 2500 }] });
    assert.equal(locked.status, 409, 'closed day is locked');
    const d = await owner.get('/dashboard?business=store');
    assert.equal(store(d).profit, -1600);
    assert.equal(d.cash.find((c) => c.method_id === 'cash').balance, 6400);
    assert.ok(d.alerts.some((a) => /Cash short \$1\.00/.test(a.title)));
    await owner.post(`/closing/${closing.id}/reopen`, { reason: 'Recount' });
    const d2 = await owner.get('/dashboard?business=store');
    assert.equal(store(d2).profit, -1500);
    await owner.post('/closing', { business: 'store', date: today, counted, explanation: 'Missing 1 dollar after recount' });
  });

  await step('owner dashboard: combined figures equal the sum of the businesses', async () => {
    const d = await owner.get('/dashboard');
    const t = d.figures.today;
    for (const k of ['revenue', 'cogs', 'expenses', 'losses', 'cashDiff', 'profit']) {
      assert.equal(t.all[k], t.restaurant[k] + t.fuel[k] + t.store[k], k);
    }
    assert.deepEqual([t.all.revenue, t.all.profit], [38000, 2267]);
    const rec = Object.fromEntries(d.receivable.map((r) => [r.business_id, r.total]));
    const pay = Object.fromEntries(d.payable.map((r) => [r.business_id, r.total]));
    assert.deepEqual(rec, { store: 2000, fuel: 500 });
    assert.deepEqual(pay, { store: 7000, fuel: 170000 });
    const cash = Object.fromEntries(d.cash.map((c) => [`${c.business_id}:${c.method_id}`, c.balance]));
    assert.equal(cash['fuel:cash'], 26000); assert.equal(cash['fuel:zaad'], 4000); assert.equal(cash['restaurant:cash'], 500);
    const summary = await owner.get('/reports/summary');
    assert.equal(summary.profit.all.profit, 2267);
    assert.equal(summary.topProducts.find((p) => p.product_id === rice).qty, 3);
  });

  await step('permissions: cashier limited to own business and actions', async () => {
    await owner.post('/users', { fullName: 'Cashier', username: 'cashier1', password: 'cashier-pass', role: 'cashier', businesses: ['restaurant'] });
    const c = client();
    await c.post('/auth/login', { username: 'cashier1', password: 'cashier-pass' });
    assert.equal((await c.call('GET', '/dashboard')).status, 403);
    assert.equal((await c.call('POST', '/sales', { business: 'store', items: [{ product: rice, qty: 1 }], payments: [{ method: 'cash', amount: 2500 }] })).status, 403);
    assert.equal((await c.call('POST', '/expenses', { business: 'restaurant', category: 'x', amount: 100, method: 'cash' })).status, 403);
    await c.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    const sale = (await owner.get('/sales?business=restaurant'))[0];
    assert.equal((await c.call('POST', `/sales/${sale.id}/void`, { reason: 'x' })).status, 403, 'cashier cannot cancel sales');
  });

  await step('database integrity: every journal entry balances, nothing deleted, audit kept', async () => {
    assert.deepEqual(sql('SELECT entry_id, SUM(amount) s FROM journal_lines GROUP BY entry_id HAVING s <> 0'), []);
    assert.deepEqual(sql(`SELECT p.id FROM products p WHERE p.kind <> 'fuel' AND ABS(p.stock_qty - (SELECT COALESCE(SUM(qty),0) FROM stock_movements m WHERE m.product_id = p.id)) > 0.001`), []);
    assert.deepEqual(sql(`SELECT t.id FROM fuel_tanks t WHERE ABS(t.stock_qty - (SELECT COALESCE(SUM(qty),0) FROM stock_movements m WHERE m.tank_id = t.id)) > 0.001`), []);
    const inv = sql(`SELECT business_id, SUM(amount) v FROM journal_lines WHERE account = 'inventory' GROUP BY business_id`);
    const stock = sql(`SELECT business_id, ROUND(SUM(stock_qty * avg_cost)) v FROM products GROUP BY business_id`);
    for (const r of inv) assert.ok(Math.abs(r.v - stock.find((s) => s.business_id === r.business_id).v) <= 1, `inventory ledger matches stock for ${r.business_id}`);
    assert.equal(sql(`SELECT SUM(amount) s FROM journal_lines WHERE account = 'transfer'`)[0].s, 0);
    let blocked = false;
    try { sql('DELETE FROM journal_lines'); } catch { blocked = true; }
    assert.ok(blocked, 'journal is append-only');
    assert.ok(sql('SELECT COUNT(*) n FROM audit_log')[0].n > 20);
    assert.match(wrangler('d1', 'migrations', 'list', 'meecaad', '--local', '--persist-to', persist), /No migrations to apply/, 'auto-setup is recorded for wrangler');
  });

  console.log(`\n${passed} test groups passed`);
} catch (e) {
  process.exitCode = 1;
  if (!String(e?.message).includes('→')) console.error(e);
  console.error('\nServer log (tail):\n' + log.split('\n').slice(-30).join('\n'));
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  rmSync(persist, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
