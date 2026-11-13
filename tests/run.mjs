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

// A server left over from an interrupted run would answer with its old database.
if (await fetch(`${BASE}/auth/me`).then(() => true, () => false)) {
  console.error(`Port ${PORT} is already in use (a leftover test server?). Stop it and run again.`);
  process.exit(1);
}
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
  return { call, ok, get: (p) => ok('GET', p), post: (p, b, k) => ok('POST', p, b, k), cookie: () => cookie };
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
  let customer, supplier, rice, tea, diesel, tank, pump, sale1, sale2, today;

  await step('first run: owner account setup, login, CSRF and auth guards', async () => {
    assert.equal((await owner.get('/auth/me')).setupRequired, true);
    await owner.post('/auth/setup', { fullName: 'Owner', username: 'owner', password: 'Meec-test-41' });
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
    customer = (await owner.post('/customers', { business: 'store', name: 'Ahmed Ali', phone: '063' })).id;
    supplier = (await owner.post('/suppliers', { business: 'store', name: 'Berbera Traders' })).id;
    // The same person/company also deals with the fuel station: the owner shares the record (no duplicate).
    await owner.ok('PATCH', `/customers/${customer}`, { businesses: ['store', 'fuel'] });
    await owner.ok('PATCH', `/suppliers/${supplier}`, { businesses: ['store', 'fuel'] });
    rice = (await owner.post('/products', { business: 'store', name: 'Rice 25kg', kind: 'item', salePrice: 2500, openingQty: 10, openingCost: 2000, reorderLevel: 3 })).id;
    tea = (await owner.post('/products', { business: 'restaurant', name: 'Tea', kind: 'menu', salePrice: 50 })).id;
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

  await step('restaurant (simple): menu sale, profit = sales − expenses; stock, purchases, suppliers, closing and money are not part of it', async () => {
    await owner.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 10 }], payments: [{ method: 'cash', amount: 500 }] });
    const r = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant;
    assert.deepEqual([r.revenue, r.cogs, r.losses, r.profit], [500, 0, 0, 500]);
    // Refused by the server even for the owner.
    for (const [m, path, body] of [
      ['POST', '/products', { business: 'restaurant', name: 'Sugar', kind: 'ingredient', unit: 'kg', openingQty: 10, openingCost: 100 }],
      ['POST', '/stock/adjust', { product: tea, type: 'waste', qty: 1, reason: 'x' }],
      ['POST', '/purchases', { business: 'restaurant', items: [{ product: tea, qty: 1, total: 10 }], paid: 10, method: 'cash' }],
      ['POST', '/suppliers', { business: 'restaurant', name: 'x' }], ['GET', '/suppliers?business=restaurant'],
      ['POST', '/expenses', { business: 'restaurant', category: 'Gas', amount: 100, supplier: supplier }],
      ['GET', '/closing/preview?business=restaurant'], ['POST', '/closing', { business: 'restaurant', counted: { cash: 500 } }],
    ]) {
      const res = await owner.call(m, path, body);
      assert.ok([400, 403].includes(res.status), `${m} ${path} should be refused for the restaurant, got ${res.status}`);
    }
    // The menu shows what sells: quantity, sales amount and last sale of each item (30 days).
    const teaRow = (await owner.get('/products?business=restaurant&stats=1')).find((x) => x.id === tea);
    assert.ok(teaRow.sold_30d > 0 && teaRow.revenue_30d === Math.round(teaRow.sold_30d * 50) && teaRow.last_sold === today, 'menu item figures');
    // Several expenses at once: all saved together, or none (the bad row is named).
    const countExp = async () => (await owner.get('/expenses?business=restaurant')).length;
    const n0 = await countExp();
    const bad = await owner.call('POST', '/expenses/batch', { business: 'restaurant', items: [
      { category: 'Water', amount: 50, method: 'cash' }, { category: 'Bread', amount: 70, method: 'zaad' }, { category: '', amount: 30, method: 'cash' }] });
    assert.equal(bad.status, 400); assert.match(bad.data.message, /^Row 3:/);
    assert.equal(await countExp(), n0, 'nothing saved when one row is wrong');
    const bkey = crypto.randomUUID();
    const batch = { business: 'restaurant', items: [{ category: 'Water', amount: 50, method: 'cash' }, { category: 'Bread', amount: 70, method: 'zaad', description: 'for sambusa' }] };
    const saved = await owner.post('/expenses/batch', batch, bkey);
    assert.equal(saved.ids.length, 2);
    assert.deepEqual((await owner.post('/expenses/batch', batch, bkey)).ids, saved.ids, 'a repeated request saves nothing twice');
    assert.equal(await countExp(), n0 + 2);
    for (const id of saved.ids) await owner.post(`/expenses/${id}/void`, { reason: 'test batch' });
    await owner.post('/expenses', { business: 'restaurant', category: 'Gas', amount: 100, method: 'cash' });
    await owner.post('/money', { type: 'transfer', business: 'restaurant', method: 'cash', toBusiness: 'store', toMethod: 'cash', amount: 100 });
    await owner.post('/money', { type: 'transfer', business: 'store', method: 'cash', toBusiness: 'restaurant', toMethod: 'cash', amount: 100 });
    const r2 = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant;
    assert.deepEqual([r2.revenue, r2.expenses, r2.profit], [500, 100, 400], 'owner can still move restaurant money; expenses count');
    assert.ok(!(await owner.get('/dashboard?business=restaurant')).alerts.some((a) => a.title === 'Day not closed'), 'no daily closing in the restaurant');
  });

  await step('fuel: tank, pump, delivery, shift readings with shortage, tank dip', async () => {
    diesel = (await owner.post('/products', { business: 'fuel', name: 'Diesel', kind: 'fuel', unit: 'L', salePrice: 100 })).id;
    tank = (await owner.post('/fuel/tanks', { product: diesel, name: 'Tank 1', capacity: 10000, openingQty: 1000, openingCost: 80 })).id;
    pump = (await owner.post('/fuel/pumps', { tank, name: 'Pump 1', meter: 5000 })).id;
    await owner.post('/purchases', { business: 'fuel', supplier, items: [{ product: diesel, tank, qty: 2000, total: 170000 }], paid: 0 });
    const shift = { readings: [{ pump, closing: 5300 }], payments: [{ method: 'cash', amount: 25000 }, { method: 'zaad', amount: 4000 }], credits: [{ customer, amount: 500 }] };
    const s = await owner.post('/fuel/shifts', shift);   // money still to be accounted for is allowed: it stays outstanding
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
    assert.deepEqual([t.all.revenue, t.all.profit], [38000, 2467]);
    const rec = Object.fromEntries(d.receivable.map((r) => [r.business_id, r.total]));
    const pay = Object.fromEntries(d.payable.map((r) => [r.business_id, r.total]));
    assert.deepEqual(rec, { store: 2000, fuel: 500 });
    assert.deepEqual(pay, { store: 7000, fuel: 170000 });
    const cash = Object.fromEntries(d.cash.map((c) => [`${c.business_id}:${c.method_id}`, c.balance]));
    assert.equal(cash['fuel:cash'], 26000); assert.equal(cash['fuel:zaad'], 4000); assert.equal(cash['restaurant:cash'], 400);   // 500 sales − 100 expense
    const summary = await owner.get('/reports/summary');
    assert.equal(summary.profit.all.profit, 2467);
    assert.equal(summary.topProducts.find((p) => p.product_id === rice).qty, 3);
  });

  await step('permissions: cashier limited to own business and actions', async () => {
    await owner.post('/users', { fullName: 'Cashier', username: 'cashier1', password: 'till-pass-7', access: { restaurant: 'cashier' } });
    const c = client();
    await c.post('/auth/login', { username: 'cashier1', password: 'till-pass-7' });
    assert.equal((await c.call('GET', '/dashboard')).status, 403);
    assert.equal((await c.call('POST', '/sales', { business: 'store', items: [{ product: rice, qty: 1 }], payments: [{ method: 'cash', amount: 2500 }] })).status, 403);
    assert.equal((await c.call('POST', '/expenses', { business: 'store', category: 'x', amount: 100, method: 'cash' })).status, 403);
    await c.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    const sale = (await owner.get('/sales?business=restaurant'))[0];
    assert.equal((await c.call('POST', `/sales/${sale.id}/void`, { reason: 'x' })).status, 403, 'cashier cannot cancel sales');
  });

  await step('business separation: each business only reaches its own customers, suppliers, data and pages', async () => {
    const restCust = (await owner.post('/customers', { business: 'restaurant', name: 'Restaurant regular' })).id;
    const fuelSup = (await owner.post('/suppliers', { business: 'fuel', name: 'Fuel depot' })).id;
    await owner.post('/sales', { business: 'restaurant', customer: restCust, items: [{ product: tea, qty: 2 }], payments: [] });
    await owner.post('/users', { fullName: 'Store cashier', username: 'storecash', password: 'store-pass-1', access: { store: 'cashier' } });
    const sc = client();
    await sc.post('/auth/login', { username: 'storecash', password: 'store-pass-1' });
    // Lists only show this business's records.
    assert.ok(!(await sc.get('/customers?business=store')).some((c) => c.id === restCust), 'restaurant customer hidden from store');
    assert.ok((await sc.get('/customers?business=store')).some((c) => c.id === customer), 'store customer visible');
    assert.equal((await sc.call('GET', '/suppliers?business=fuel')).status, 403);
    assert.ok(!(await owner.get('/suppliers?business=store')).some((x) => x.id === fuelSup), 'fuel supplier not in store list');
    // Direct API attempts across the boundary are refused by the server.
    const denied = [
      ['PATCH', `/customers/${restCust}`, { name: 'renamed by store' }],
      ['GET', `/customers/${restCust}/statement?business=store`],
      ['POST', '/sales', { business: 'store', customer: restCust, items: [{ product: rice, qty: 1 }], payments: [] }],
      ['GET', '/products?business=restaurant'], ['GET', '/sales?business=fuel'], ['GET', '/fuel/setup'], ['GET', '/fuel/shifts'],
      ['POST', '/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] }],
      ['POST', '/sales', { business: 'store', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] }],
      ['POST', '/customers', { business: 'restaurant', name: 'x' }],
      ['GET', '/dashboard?business=store'], ['GET', '/reports/summary?business=store'], ['GET', '/closing?business=restaurant'],
      ['POST', '/purchases', { business: 'store', items: [{ product: rice, qty: 1, total: 100 }], paid: 100, method: 'cash' }],
    ];
    for (const [m, path, body] of denied) {
      const r = await sc.call(m, path, body);
      assert.ok([400, 403, 404].includes(r.status), `${m} ${path} should be refused, got ${r.status}`);
    }
    assert.equal((await owner.get(`/customers/${restCust}/statement?business=restaurant`)).balance, 100, 'restaurant debt intact');
    // Owner products/purchases cannot cross either.
    assert.equal((await owner.call('POST', '/purchases', { business: 'fuel', supplier: customer, items: [{ product: rice, qty: 1, total: 1 }], paid: 0 })).status, 400);
    assert.equal((await owner.call('POST', '/products', { business: 'fuel', name: 'Cooking oil', kind: 'item' })).status, 400);
    // One person, different roles: manager in the store, cashier in the restaurant.
    await owner.post('/users', { fullName: 'Two roles', username: 'tworoles', password: 'two-roles-1', access: { store: 'manager', restaurant: 'cashier' } });
    const tr = client();
    await tr.post('/auth/login', { username: 'tworoles', password: 'two-roles-1' });
    const me = await tr.get('/bootstrap');
    assert.deepEqual(me.user.roles, { restaurant: 'cashier', store: 'manager' });
    assert.equal((await tr.call('GET', '/dashboard?business=store')).status, 200, 'manager sees the store dashboard');
    assert.equal((await tr.call('GET', '/dashboard?business=restaurant')).status, 403, 'cashier does not see the restaurant dashboard');
    assert.deepEqual((await tr.get('/dashboard?business=all')).scope, ['store'], 'combined view only covers businesses with report access');
    await tr.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    assert.equal((await tr.call('POST', '/products', { business: 'restaurant', name: 'Juice', kind: 'menu', salePrice: 100 })).status, 403, 'restaurant cashier cannot change the menu');
    assert.equal((await tr.call('GET', '/fuel/setup')).status, 403);
    assert.equal((await tr.call('GET', '/users')).status, 403);
  });

  await step('restaurant: send order (pending), add items, pay later; tables optional; cancel; pictures', async () => {
    const t1 = (await owner.post('/restaurant/tables', { name: 'Table 1' })).id;
    // Take an order, then add to it, then pay later.
    const order = (await owner.post('/restaurant/orders', { table: t1, items: [{ product: tea, qty: 3 }] })).id;
    assert.equal((await owner.call('POST', '/restaurant/orders', { table: t1, items: [{ product: tea, qty: 1 }] })).status, 409, 'one open order per table');
    assert.equal((await owner.call('POST', '/restaurant/orders', { table: t1, items: [{ product: rice, qty: 1 }] })).status, 400, 'store items are not on the menu');
    const day0 = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant.revenue;
    await owner.ok('PATCH', `/restaurant/orders/${order}`, { items: [{ product: tea, qty: 5 }] });
    assert.equal((await owner.get('/dashboard?business=restaurant')).figures.today.restaurant.revenue, day0, 'a pending order is not a sale yet');
    assert.equal((await owner.get('/restaurant/tables')).find((t) => t.id === t1).order_id, order);
    const key = crypto.randomUUID();
    const paid = await owner.post(`/restaurant/orders/${order}/pay`, { payments: [{ method: 'cash', amount: 250 }] }, key);
    assert.equal((await owner.post(`/restaurant/orders/${order}/pay`, { payments: [{ method: 'cash', amount: 250 }] }, key)).id, paid.id, 'double click returns the same sale');
    assert.equal((await owner.call('POST', `/restaurant/orders/${order}/pay`, { payments: [{ method: 'cash', amount: 250 }] })).status, 409, 'cannot pay twice');
    const sale = await owner.get(`/sales/${paid.id}`);
    assert.deepEqual([sale.total, sale.cost_total], [250, 0]);
    assert.ok(!(await owner.get('/restaurant/tables')).find((t) => t.id === t1).order_id, 'table is free again');
    assert.equal((await owner.get('/dashboard?business=restaurant')).figures.today.restaurant.revenue, day0 + 250);
    // Cancel an unpaid order: nothing changes.
    const o2 = (await owner.post('/restaurant/orders', { label: 'Takeaway – Ali', items: [{ product: tea, qty: 1 }] })).id;
    assert.equal((await owner.call('POST', `/restaurant/orders/${o2}/cancel`, {})).status, 400, 'reason required');
    await owner.post(`/restaurant/orders/${o2}/cancel`, { reason: 'Customer left' });
    assert.equal((await owner.get('/restaurant/orders')).length, 0);
    await owner.post(`/sales/${paid.id}/void`, { reason: 'Wrong table' });
    assert.equal((await owner.get('/dashboard?business=restaurant')).figures.today.restaurant.revenue, day0, 'cancelled sale reversed');
    // Simple POS flow: an order needs no table; it gets a number, stays pending, then is paid.
    const quick = await owner.post('/restaurant/orders', { items: [{ product: tea, qty: 4 }] });
    assert.ok(quick.number >= 1, 'order has a number');
    const next = await owner.post('/restaurant/orders', { items: [{ product: tea, qty: 1 }] });
    assert.equal(next.number, quick.number + 1, 'numbers count up');
    const open = await owner.get('/restaurant/orders');
    assert.equal(open.find((o) => o.id === quick.id).total, 200);
    assert.equal((await owner.call('POST', `/restaurant/orders/${quick.id}/status`, { status: 'ready' })).status, 404, 'no kitchen statuses any more');
    const qs = await owner.post(`/restaurant/orders/${quick.id}/pay`, { payments: [{ method: 'zaad', amount: 200 }] });
    assert.equal((await owner.get(`/sales/${qs.id}`)).payments[0].method_id, 'zaad');
    await owner.post(`/restaurant/orders/${next.id}/cancel`, { reason: 'test' });
    // Pictures: small image saved and served to the restaurant only.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await owner.post(`/products/${tea}/image`, { data: png });
    assert.equal((await owner.call('POST', `/products/${tea}/image`, { data: 'data:text/html;base64,PGgxPg==' })).status, 400, 'only pictures');
    const teaRow = (await owner.get('/products?business=restaurant')).find((p) => p.id === tea);
    assert.ok(teaRow.image_v, 'product list says it has a picture');
    const img = await fetch(`${BASE}/products/${tea}/image?v=1`, { headers: { Cookie: owner.cookie() } });
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    // Restaurant dashboard/reports for its manager: sales, expenses, profit, payments by method, number of sales, best sellers.
    await owner.post('/users', { fullName: 'Rest manager', username: 'restman', password: 'rest-man-1', access: { restaurant: 'manager' } });
    const rm = client();
    await rm.post('/auth/login', { username: 'restman', password: 'rest-man-1' });
    const rs = await rm.get('/reports/summary?business=restaurant');
    const rp = rs.profit.restaurant;
    assert.equal(rp.profit, rp.revenue - rp.expenses, 'restaurant profit = sales − expenses');
    assert.equal(rs.methods.reduce((t, m) => t + m.total, 0) + rs.credit.reduce((t, c) => t + c.given, 0), rp.revenue, 'payments by method + credit = sales');
    assert.equal(rs.counts.reduce((t, c) => t + c.sales, 0), (await rm.get('/sales?business=restaurant')).filter((x) => x.status === 'completed').length);
    assert.ok(rs.topProducts.some((x) => x.product_id === tea));
    assert.equal((await rm.call('GET', '/dashboard?business=restaurant')).status, 200);
    assert.equal((await rm.call('GET', '/dashboard?business=store')).status, 403, 'only their own business');
    assert.ok((await owner.get('/dashboard?business=all')).scope.includes('restaurant'), 'owner admin still includes the restaurant');
    // Other businesses cannot reach restaurant tables, orders or pictures.
    const sc = client();
    await sc.post('/auth/login', { username: 'storecash', password: 'store-pass-1' });
    for (const [m, path, body] of [['GET', '/restaurant/tables'], ['GET', '/restaurant/orders'], ['POST', '/restaurant/orders', { label: 'x', items: [{ product: tea, qty: 1 }] }],
      ['POST', '/restaurant/tables', { name: 'x' }], ['GET', `/products/${tea}/image`],
      ['POST', `/products/${tea}/image`, { data: null }]]) {
      assert.equal((await sc.call(m, path, body)).status, 403, `${m} ${path}`);
    }
  });

  await step('restaurant shift closing (xisaab xidh): count, explain, hand over, reopen, earlier-day block, month lock', async () => {
    await owner.post('/users', { fullName: 'Shift Cashier', username: 'shiftc', password: 'shift-pass-1', access: { restaurant: 'cashier' } });
    await owner.post('/users', { fullName: 'Rest Manager', username: 'rmgr', password: 'mgr-key-55', access: { restaurant: 'manager' } });
    const c = client(), m = client();
    await c.post('/auth/login', { username: 'shiftc', password: 'shift-pass-1' });
    await m.post('/auth/login', { username: 'rmgr', password: 'mgr-key-55' });
    const mgrId = (await m.get('/bootstrap')).user.id;
    const cashierId = (await c.get('/bootstrap')).user.id;
    assert.equal((await c.get('/shifts/mine?business=restaurant')).activity, 0);
    assert.equal((await c.call('POST', '/shifts/close', { business: 'restaurant', counted: {}, handedTo: mgrId })).status, 400, 'nothing to close');
    assert.equal((await c.call('GET', '/shifts?business=restaurant')).status, 403, 'cashier does not see everyone');
    assert.equal((await c.call('GET', '/shifts/mine?business=store')).status, 400, 'restaurant only');

    // Work: two sales (cash, Zaad) and a small expense paid from the drawer.
    await c.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 4 }], payments: [{ method: 'cash', amount: 200 }] });
    await c.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 2 }], payments: [{ method: 'zaad', amount: 100 }] });
    await c.post('/expenses', { business: 'restaurant', category: 'Water', amount: 30, method: 'cash' });
    const mine = await c.get('/shifts/mine?business=restaurant');
    const line = (id) => mine.lines.find((l) => l.method_id === id);
    assert.deepEqual([line('cash').sales_in, line('cash').expenses_out, line('cash').expected, line('zaad').expected], [200, -30, 170, 100]);
    assert.deepEqual([mine.sales.count, mine.sales.total, mine.expenses, mine.mustClose], [2, 300, 30, false]);
    assert.ok(mine.receivers.some((r) => r.id === mgrId) && mine.receivers.some((r) => r.role === 'owner'));
    assert.ok(!mine.receivers.some((r) => r.id === cashierId), 'a cashier cannot receive the money');

    const counted = { cash: 180, zaad: 100, edahab: 0 };   // 20 change money at start → expected cash 190, 10 missing
    const base = { business: 'restaurant', counted, startFloat: 20, handedTo: mgrId };
    assert.equal((await c.call('POST', '/shifts/close', base)).status, 400, 'difference needs an explanation');
    assert.equal((await c.call('POST', '/shifts/close', { ...base, explanation: 'x', handedTo: cashierId })).status, 400, 'must hand to owner/manager');
    assert.equal((await c.call('POST', '/shifts/close', { ...base, explanation: 'x', counted: { cash: 180 } })).status, 400, 'every method counted');
    const d0 = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant;
    const key = crypto.randomUUID();
    const closed = await c.post('/shifts/close', { ...base, explanation: 'Gave wrong change' }, key);
    assert.equal((await c.post('/shifts/close', { ...base, explanation: 'Gave wrong change' }, key)).id, closed.id, 'double tap closes once');
    const slip = await c.get(`/shifts/${closed.id}`);
    assert.deepEqual([slip.total_expected, slip.total_counted, slip.total_difference, slip.handed_to_name, slip.start_float], [290, 280, -10, 'Rest Manager', 20]);
    assert.equal(slip.lines.find((l) => l.method_id === 'cash').difference, -10);
    const d1 = (await owner.get('/dashboard?business=restaurant')).figures.today.restaurant;
    assert.deepEqual([d1.cashDiff - d0.cashDiff, d0.profit - d1.profit], [10, 10], 'shortage counts as a loss');
    assert.equal((await c.get('/shifts/mine?business=restaurant')).activity, 0, 'new shift starts empty');
    assert.equal((await c.call('POST', '/shifts/close', { ...base, explanation: 'again' })).status, 400, 'cannot close twice');
    const alerts = (await owner.get('/dashboard?business=restaurant')).alerts;
    assert.ok(alerts.some((a) => /Shift Cashier's shift short \$0\.10/.test(a.title)));

    // Manager sees every shift and the per-cashier totals; reopens; the cashier closes again correctly.
    const list = await m.get(`/shifts?business=restaurant&from=${today}&to=${today}`);
    assert.ok(list.find((x) => x.id === closed.id).is_latest);
    const sum1 = await m.get(`/shifts/summary?business=restaurant&from=${today}&to=${today}`);
    assert.equal(sum1.cashiers.find((x) => x.user_id === cashierId).short, -10);
    assert.equal((await c.call('POST', `/shifts/${closed.id}/reopen`, { reason: 'x' })).status, 403, 'cashier cannot reopen');
    assert.equal((await m.call('POST', `/shifts/${closed.id}/reopen`, {})).status, 400, 'reason required');
    await m.post(`/shifts/${closed.id}/reopen`, { reason: 'Found the 10 cents' });
    assert.equal((await owner.get('/dashboard?business=restaurant')).figures.today.restaurant.cashDiff, d0.cashDiff, 'difference reversed');
    const again = await c.get('/shifts/mine?business=restaurant');
    assert.equal(again.lines.find((l) => l.method_id === 'cash').expected, 170, 'reopened shift is open again');
    assert.ok((await m.get('/shifts/open?business=restaurant')).some((o) => o.user_id === cashierId));
    await c.post('/shifts/close', { business: 'restaurant', counted: { cash: 170, zaad: 100, edahab: 0 }, handedTo: mgrId });

    // Recording yesterday's forgotten sale today is fine: the shift is judged by when the work was done.
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    await c.post('/sales', { business: 'restaurant', date: yesterday, items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    await c.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    await c.post('/shifts/close', { business: 'restaurant', counted: { cash: 100, zaad: 0, edahab: 0 }, handedTo: mgrId });
    // A shift left open since yesterday blocks new payments until it is closed.
    await owner.post('/users', { fullName: 'Night Cashier', username: 'nightc', password: 'night-pass-1', access: { restaurant: 'cashier' } });
    const n = client();
    await n.post('/auth/login', { username: 'nightc', password: 'night-pass-1' });
    const ns = await n.post('/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    const lastNight = `${yesterday}T18:00:00.000Z`;
    sql(`DROP TRIGGER journal_entries_no_update; UPDATE journal_entries SET created_at = '${lastNight}' WHERE ref_id = '${ns.id}';
         CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
         UPDATE app_settings SET value = '${yesterday}T00:00:00.000Z' WHERE key = 'shifts_since';`);
    const blocked = await n.call('POST', '/sales', { business: 'restaurant', items: [{ product: tea, qty: 1 }], payments: [{ method: 'cash', amount: 50 }] });
    assert.equal(blocked.status, 409); assert.match(blocked.data.message, new RegExp(`Close your shift from ${yesterday}`));
    assert.equal((await n.call('POST', '/expenses', { business: 'restaurant', category: 'x', amount: 10, method: 'cash' })).status, 409);
    const order = (await n.post('/restaurant/orders', { items: [{ product: tea, qty: 1 }] })).id;   // taking orders is still fine
    assert.equal((await n.call('POST', `/restaurant/orders/${order}/pay`, { payments: [{ method: 'cash', amount: 50 }] })).status, 409);
    const nm = await n.get('/shifts/mine?business=restaurant');
    assert.deepEqual([nm.mustClose, nm.firstDate, nm.unpaid.count >= 1], [true, yesterday, true]);
    assert.ok((await owner.get('/dashboard?business=restaurant')).alerts.some((a) => a.title === 'Shift not closed: Night Cashier'));
    const nc = await n.post('/shifts/close', { business: 'restaurant', counted: { cash: 50, zaad: 0, edahab: 0 }, handedTo: mgrId });
    assert.ok((await n.get(`/shifts/${nc.id}`)).unpaid_orders >= 1, 'unpaid orders are handed over on the slip');
    await n.post(`/restaurant/orders/${order}/pay`, { payments: [{ method: 'cash', amount: 50 }] });

    // Month / year closing (owner only, finished periods only).
    const month = today.slice(0, 7);
    const [y, mo] = month.split('-').map(Number);
    const lastMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    assert.equal((await owner.call('POST', '/period-locks', { business: 'restaurant', period: month })).status, 400, 'month not finished');
    assert.equal((await m.call('POST', '/period-locks', { business: 'restaurant', period: lastMonth })).status, 403, 'only the owner');
    const lock = await owner.post('/period-locks', { business: 'restaurant', period: lastMonth });
    assert.equal((await owner.call('POST', '/period-locks', { business: 'restaurant', period: lastMonth })).status, 409, 'already closed');
    const old = await owner.call('POST', '/expenses', { business: 'restaurant', category: 'Late bill', amount: 10, method: 'cash', date: `${lastMonth}-15` });
    assert.equal(old.status, 409); assert.match(old.data.message, /is closed/);
    assert.equal((await owner.call('POST', `/period-locks/${lock.id}/unlock`, {})).status, 400, 'reason required');
    await owner.post(`/period-locks/${lock.id}/unlock`, { reason: 'Late bill arrived' });
    assert.equal((await owner.get('/period-locks?business=restaurant'))[0].status, 'unlocked');
    await owner.post('/period-locks', { business: 'restaurant', period: String(y - 1) });
  });

  await step('security: owner has no shift, passwords, sessions, sign-in limits, users & roles', async () => {
    // The owner's money is not drawer money.
    assert.equal((await owner.get('/shifts/mine?business=restaurant')).owner, true);
    assert.equal((await owner.call('POST', '/shifts/close', { business: 'restaurant', counted: {} })).status, 400);
    assert.ok(!(await owner.get('/shifts/open?business=restaurant')).some((o) => o.user_name === 'Owner'));
    // Passwords.
    for (const [password, why] of [['short1', 'too short'], ['onlyletters', 'no numbers'], ['password123', 'common'], ['weakuser12', 'contains username']]) {
      const r = await owner.call('POST', '/users', { fullName: 'Weak', username: 'weakuser', password, access: { restaurant: 'staff' } });
      assert.equal(r.status, 400, why);
    }
    assert.equal((await owner.call('POST', '/users', { fullName: 'Bad', username: 'has space', password: 'good-pass-12', access: { restaurant: 'staff' } })).status, 400);
    assert.equal((await owner.call('POST', '/users', { fullName: 'Dup', username: 'SHIFTC', password: 'good-pass-12', access: { restaurant: 'staff' } })).status, 409, 'usernames are unique, any case');
    const sec = (await owner.post('/users', { fullName: 'Sec Test', username: 'sectest', password: 'good-pass-12', access: { restaurant: 'cashier' } })).id;
    // Requests from another site are refused even with the header.
    const cross = await fetch(`${BASE}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meecaad', Origin: 'https://evil.example', Cookie: owner.cookie() }, body: '{}' });
    assert.equal(cross.status, 403);
    const del = await fetch(`${BASE}/users/${sec}`, { method: 'DELETE', headers: { 'X-Requested-With': 'meecaad', Cookie: owner.cookie() } });
    assert.equal(del.status, 405);
    const badJson = await fetch(`${BASE}/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meecaad', Cookie: owner.cookie() }, body: '{oops' });
    assert.equal(badJson.status, 400);
    // Two devices; changing the password keeps this one and signs out the other.
    const a = client(), b2 = client();
    await a.post('/auth/login', { username: 'sectest', password: 'good-pass-12' });
    await b2.post('/auth/login', { username: 'sectest', password: 'good-pass-12' });
    assert.equal((await owner.get('/users')).find((u) => u.id === sec).sessions, 2);
    assert.equal((await a.call('POST', '/auth/password', { currentPassword: 'good-pass-12', newPassword: 'good-pass-12' })).status, 400, 'must be new');
    await a.post('/auth/password', { currentPassword: 'good-pass-12', newPassword: 'better-pass-34' });
    assert.equal((await a.call('GET', '/bootstrap')).status, 200);
    assert.equal((await b2.call('GET', '/bootstrap')).status, 401, 'other device signed out');
    // Owner signs a person out everywhere.
    await owner.post(`/users/${sec}/signout`, {});
    assert.equal((await a.call('GET', '/bootstrap')).status, 401);
    // Sessions end after 12 hours without use.
    await a.post('/auth/login', { username: 'sectest', password: 'better-pass-34' });
    sql(`UPDATE sessions SET last_seen_at = '${new Date(Date.now() - 13 * 3600_000).toISOString()}' WHERE user_id = '${sec}'`);
    assert.equal((await a.call('GET', '/bootstrap')).status, 401, 'idle session ended');
    // 5 wrong passwords lock the account; the owner can unlock it.
    for (let i = 0; i < 5; i++) assert.equal((await a.call('POST', '/auth/login', { username: 'sectest', password: 'nope-' + i })).status, 401);
    assert.equal((await a.call('POST', '/auth/login', { username: 'sectest', password: 'better-pass-34' })).status, 429);
    assert.ok((await owner.get('/users')).find((u) => u.id === sec).locked_until);
    assert.equal((await a.call('PATCH', `/users/${sec}`, { unlock: true })).status, 401);
    await owner.ok('PATCH', `/users/${sec}`, { unlock: true });
    await a.post('/auth/login', { username: 'sectest', password: 'better-pass-34' });
    assert.equal((await a.call('GET', '/users')).status, 403, 'only the owner manages users');
    assert.equal((await a.call('GET', '/signins')).status, 403);
    const log = await owner.get('/signins');
    assert.ok(log.some((x) => x.username === 'sectest' && !x.ok) && log.some((x) => x.username === 'sectest' && x.ok));
    assert.ok((await owner.get('/users')).find((u) => u.id === sec).last_login_at);
    // There is always an active owner.
    const me = (await owner.get('/bootstrap')).user.id;
    assert.equal((await owner.call('PATCH', `/users/${me}`, { active: false })).status, 400);
    // One address guessing many passwords (even for different usernames) is slowed down.
    const g = client();
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await g.call('POST', '/auth/login', { username: `guess${i}`, password: 'x1234567' })).status === 429;
    assert.ok(limited, 'too many failures from one device');
    sql(`DELETE FROM login_attempts`);   // let the rest of the run sign in again
  });

  await step('fuel station: rate, open shift with the fuel value, sales, xisaab xidh, no money/closing pages', async () => {
    // Exchange rate: the manager/owner sets it, the day uses the latest rate on or before it.
    assert.equal((await owner.get('/rates')).current, null);
    for (const bad of ['', 'abc', '0', '-5']) assert.equal((await owner.call('POST', '/rates', { rate: bad })).status, 400, `rate "${bad}"`);
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    await owner.post('/rates', { rate: '11,800', date: yesterday });
    await owner.post('/rates', { rate: 11900 });
    const r = await owner.get('/rates');
    assert.deepEqual([r.current.rate, r.setToday, r.history.length], [11900, true, 2]);
    await owner.post('/rates', { rate: 12000 });   // corrected the same day: the latest one counts
    assert.equal((await owner.get('/rates')).current.rate, 12000);
    await owner.post('/rates', { rate: 11900 });
    const fc = client(), fm = client();
    await owner.post('/users', { fullName: 'Fuel Cashier', username: 'fuelc', password: 'pump-key-321', access: { fuel: 'cashier' } });
    await owner.post('/users', { fullName: 'Fuel Manager', username: 'fuelm', password: 'boss-key-654', access: { fuel: 'manager' } });
    await fc.post('/auth/login', { username: 'fuelc', password: 'pump-key-321' });
    await fm.post('/auth/login', { username: 'fuelm', password: 'boss-key-654' });
    assert.equal((await fc.get('/rates')).current.rate, 11900, 'the cashier can read the rate');
    assert.equal((await fc.call('POST', '/rates', { rate: 1 })).status, 403, 'but only the manager changes it');
    assert.equal((await fm.call('POST', '/rates', { rate: 11900 })).status, 200);
    // No daily closing and no money page at the fuel station.
    assert.equal((await fm.call('GET', '/closing/preview?business=fuel')).status, 403);
    assert.equal((await fc.call('GET', '/closing/preview?business=fuel')).status, 403);
    assert.equal((await fm.call('GET', '/money?business=fuel')).status, 403);
    assert.ok(!(await owner.get('/dashboard?business=fuel')).alerts.some((a) => a.title === 'Day not closed'));

    // 1. Open the shift with the fuel it works with: 2,000 L worth $2,000.
    assert.equal((await fc.get('/fuel/current')).shift, null);
    assert.equal((await fc.call('POST', '/fuel/sales', { method: 'cash', amount: 100 })).status, 409, 'no sales before a shift is open');
    assert.equal((await fc.call('POST', '/fuel/open', { liters: 0, value: 200000 })).status, 400);
    const sh = await fc.post('/fuel/open', { liters: 2000, value: 200000 });
    assert.equal((await fm.call('POST', '/fuel/open', { liters: 10, value: 1000 })).status, 409, 'one shift at a time');
    // 2. Sales: cash, Zaad, Edahab, cash in Shillings at the day's rate, and a customer debt.
    await fc.post('/fuel/sales', { method: 'cash', amount: 80000 });
    const z = await fc.post('/fuel/sales', { method: 'zaad', amount: 20000 });
    await fc.post('/fuel/sales', { method: 'edahab', amount: 10000 });
    const sl = await fc.post('/fuel/sales', { method: 'cash', slsh: '1,190,000' });   // 1,190,000 ÷ 11,900 = $100.00
    assert.deepEqual([sl.amount, sl.liters], [10000, 100]);
    assert.equal((await fc.call('POST', '/fuel/sales', { method: 'zaad', slsh: 50000 })).status, 400, 'only cash in Shillings');
    await fc.post('/fuel/sales', { customer, amount: 10000 });
    let cur = await fc.get('/fuel/current');
    assert.deepEqual([cur.shift.sold, cur.shift.remaining_now, cur.shift.remaining_liters, cur.shift.debts, cur.shift.by_method.cash, cur.sales.length], [130000, 70000, 700, 10000, 90000, 5]);
    assert.equal((await fc.call('POST', '/fuel/sales', { method: 'cash', amount: 80000 })).status, 400, 'more than the fuel left');
    // A wrong sale is cancelled by the manager (not the cashier), with a reason.
    assert.equal((await fc.call('POST', `/fuel/sales/${z.id}/void`, { reason: 'x' })).status, 403);
    await fm.post(`/fuel/sales/${z.id}/void`, { reason: 'Typed twice' });
    // 3. Xisaab xidh: not matched yet → needs an explanation; record the rest → matched.
    assert.equal((await fc.call('POST', '/fuel/close', {})).status, 400);
    await fc.post('/fuel/sales', { method: 'cash', amount: 90000 });
    cur = await fc.get('/fuel/current');
    assert.deepEqual([cur.shift.sold, cur.shift.remaining_now, cur.shift.matched], [200000, 0, true]);
    const before = (await owner.get('/dashboard?business=fuel')).figures.today.fuel.revenue;
    const closed = await fc.post('/fuel/close', {});
    assert.deepEqual([closed.sold, closed.remaining], [200000, 0]);
    const one = await fm.get(`/fuel/sessions/${sh.id}`);
    assert.deepEqual([one.status, one.remaining, one.by_method.cash, one.by_method.zaad ?? 0, one.by_method.edahab, one.debts, one.sales.length], ['closed', 0, 180000, 0, 10000, 10000, 6]);
    assert.equal((await owner.get('/dashboard?business=fuel')).figures.today.fuel.revenue, before, 'sales were already counted as they happened');
    assert.equal((await fm.call('POST', `/fuel/sales/${z.id}/void`, { reason: 'again' })).status, 409);
    assert.equal((await fc.call('POST', '/fuel/sales', { method: 'cash', amount: 100 })).status, 409, 'closed: open the next shift first');
    // The next shift does not match: it closes only with an explanation, and is flagged.
    await fm.post('/fuel/open', { liters: 100, value: 10000 });
    await fm.post('/fuel/sales', { method: 'cash', amount: 4000 });
    const c2 = await fm.post('/fuel/close', { explanation: 'Fuel left for the night shift' });
    assert.equal(c2.remaining, 6000);
    assert.equal((await fm.get('/fuel/current')).last.remaining, 6000, 'offered as the next start');
    const list = await fm.get('/fuel/sessions');
    assert.equal(list.shifts.length, 2);
    assert.ok((await owner.get('/dashboard?business=fuel')).alerts.some((a) => /did not match: \$60\.00 short/.test(a.title)));
    // Fuel left over can be passed to the next shift: that is not a mismatch, and the next shift must start with it.
    await fm.post('/fuel/open', { liters: 100, value: 10000 });
    await fm.post('/fuel/sales', { method: 'cash', amount: 4000 });
    assert.equal((await fm.call('POST', '/fuel/close', { carry: true, explanation: '' })).status, 200);
    const passed = (await fm.get('/fuel/current')).last;
    assert.deepEqual([passed.carried, passed.carried_to, passed.remaining, passed.remaining_liters], [1, null, 6000, 60]);
    assert.equal((await fm.call('POST', '/fuel/open', { liters: 50, value: 5000 })).status, 400, 'must include what was passed on');
    assert.equal((await fm.call('POST', '/fuel/open', { liters: 40, value: 20000 })).status, 400, 'litres too');
    const next = await fm.post('/fuel/open', { liters: 160, value: 16000 });   // the 60 L passed on + 100 L new
    const shifts = (await fm.get('/fuel/sessions')).shifts;
    const third = shifts.find((x) => x.number === 3);
    assert.deepEqual([third.carried, third.carried_to === next.id], [1, true]);
    const titles = (await owner.get('/dashboard?business=fuel')).alerts.map((a) => a.title);
    assert.ok(titles.some((t) => /shift #2 did not match/.test(t)) && !titles.some((t) => /shift #3/.test(t)), 'passed-on shifts are not flagged');
  });

  await step('database integrity: every journal entry balances, nothing deleted, audit kept', async () => {
    assert.deepEqual(sql('SELECT entry_id, SUM(amount) s FROM journal_lines GROUP BY entry_id HAVING s <> 0'), []);
    assert.deepEqual(sql(`SELECT p.id FROM products p WHERE p.kind <> 'fuel' AND ABS(p.stock_qty - (SELECT COALESCE(SUM(qty),0) FROM stock_movements m WHERE m.product_id = p.id)) > 0.001`), []);
    assert.deepEqual(sql(`SELECT t.id FROM fuel_tanks t WHERE ABS(t.stock_qty - (SELECT COALESCE(SUM(qty),0) FROM stock_movements m WHERE m.tank_id = t.id)) > 0.001`), []);
    const inv = sql(`SELECT business_id, SUM(amount) v FROM journal_lines WHERE account = 'inventory' GROUP BY business_id`);
    const stock = sql(`SELECT business_id, ROUND(SUM(stock_qty * avg_cost)) v FROM products GROUP BY business_id`);
    for (const r of inv) assert.ok(Math.abs(r.v - stock.find((s) => s.business_id === r.business_id).v) <= 1, `inventory ledger matches stock for ${r.business_id}`);
    assert.equal(sql(`SELECT SUM(amount) s FROM journal_lines WHERE account = 'transfer'`)[0].s, 0);
    // The summary tables the screens read must match the full journal exactly.
    assert.deepEqual(sql(`SELECT * FROM (SELECT business_id, account, COALESCE(method_id,'') m, COALESCE(customer_id,'') c, COALESCE(supplier_id,'') s, SUM(amount) v
        FROM journal_lines GROUP BY 1,2,3,4,5) j FULL OUTER JOIN account_balances b USING (business_id, account)
        WHERE b.method_id = j.m AND b.customer_id = j.c AND b.supplier_id = j.s AND b.balance <> j.v`), [], 'account_balances = journal');
    assert.equal(sql(`SELECT COUNT(*) n FROM account_balances`)[0].n,
      sql(`SELECT COUNT(*) n FROM (SELECT 1 FROM journal_lines GROUP BY business_id, account, COALESCE(method_id,''), COALESCE(customer_id,''), COALESCE(supplier_id,''))`)[0].n);
    assert.deepEqual(sql(`SELECT j.* FROM (SELECT business_id, entry_date, account, entry_type, COALESCE(method_id,'') m, COALESCE(category,'') c,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) d, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) k FROM journal_lines GROUP BY 1,2,3,4,5,6) j
        LEFT JOIN daily_totals t ON t.business_id = j.business_id AND t.entry_date = j.entry_date AND t.account = j.account AND t.entry_type = j.entry_type
          AND t.method_id = j.m AND t.category = j.c
        WHERE t.debit IS NOT j.d OR t.credit IS NOT j.k`), [], 'daily_totals = journal');
    assert.equal(sql(`SELECT COUNT(*) n FROM daily_totals`)[0].n,
      sql(`SELECT COUNT(*) n FROM (SELECT 1 FROM journal_lines GROUP BY business_id, entry_date, account, entry_type, COALESCE(method_id,''), COALESCE(category,''))`)[0].n);
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
