// Volume test: fills a fresh local D1 with DAYS of realistic activity for all
// three businesses through the real API, then measures how many database rows
// every screen reads (what Cloudflare D1 bills). Fails if a screen goes over
// its budget.
//
//   npm run test:volume            (365 days, takes a few minutes)
//   DAYS=60 npm run test:volume

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAYS = Number(process.env.DAYS ?? 365);
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}/api`;
const persist = mkdtempSync(join(tmpdir(), 'meecaad-volume-'));
if (!existsSync('dist/index.html')) { mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', '<!doctype html><title>t</title>'); }
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost' };
const server = spawn('npx', ['wrangler', 'pages', 'dev', 'dist', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

let cookie = '';
async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'meecaad', Cookie: cookie };
  if (method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return { data, rows: Number(r.headers.get('x-rows-read')) };
}
const post = async (p, b) => (await call('POST', p, b)).data;
const get = async (p) => (await call('GET', p)).data;

// Deterministic pseudo-random numbers so runs are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const dayStr = (today, back) => new Date(Date.parse(today + 'T00:00:00Z') - back * 86400000).toISOString().slice(0, 10);

async function main() {
  for (let i = 0; i < 120; i++) { try { await fetch(`${BASE}/auth/me`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await post('/auth/setup', { fullName: 'Owner', username: 'owner', password: 'owner-pass-1' });
  const { today } = await get('/bootstrap');
  const start = dayStr(today, DAYS);
  const t0 = Date.now();

  const supplier = (await post('/suppliers', { name: 'Main Supplier' })).id;
  const customers = [];
  for (let i = 0; i < 60; i++) customers.push((await post('/customers', { name: `Customer ${i}` })).id);
  const store = [], menu = [], ingredients = [];
  for (let i = 0; i < 40; i++) store.push((await post('/products', { business: 'store', name: `Item ${i}`, kind: 'item', salePrice: 100 + i * 25, openingQty: 400, openingCost: 60 + i * 15, date: start })).id);
  for (let i = 0; i < 25; i++) menu.push((await post('/products', { business: 'restaurant', name: `Dish ${i}`, kind: 'menu', salePrice: 150 + i * 20 })).id);
  for (let i = 0; i < 8; i++) ingredients.push((await post('/products', { business: 'restaurant', name: `Ingredient ${i}`, kind: 'ingredient', unit: 'kg', openingQty: 5000, openingCost: 80, date: start })).id);
  const fuels = [(await post('/products', { business: 'fuel', name: 'Diesel', kind: 'fuel', salePrice: 110 })).id, (await post('/products', { business: 'fuel', name: 'Petrol', kind: 'fuel', salePrice: 120 })).id];
  const tanks = [];
  for (const [i, f] of fuels.entries()) tanks.push((await post('/fuel/tanks', { product: f, name: `Tank ${i + 1}`, capacity: 40000, openingQty: 30000, openingCost: 90, date: start })).id);
  const pumps = [];
  for (let i = 0; i < 4; i++) pumps.push({ id: (await post('/fuel/pumps', { tank: tanks[i % 2], name: `Pump ${i + 1}`, meter: 10000 })).id, meter: 10000, tank: i % 2 });
  await post('/money', { type: 'owner_in', business: 'store', method: 'cash', amount: 1000000, date: start });

  const methods = ['cash', 'cash', 'cash', 'zaad', 'zaad', 'edahab'];
  for (let back = DAYS - 1; back >= 1; back--) {
    const date = dayStr(today, back);
    // Store and restaurant sales: about 45 each per day, ~10% on credit.
    const price = (biz, id) => (biz === 'store' ? 100 + store.indexOf(id) * 25 : 150 + menu.indexOf(id) * 20);
    for (const [biz, list] of [['store', store], ['restaurant', menu]]) {
      for (let s = 0; s < 45; s++) {
        const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ product: pick(list), qty: 1 }));
        const total = items.reduce((t, i) => t + price(biz, i.product), 0);
        const credit = rnd() < 0.1;
        await post('/sales', credit
          ? { business: biz, date, items, payments: [], customer: pick(customers) }
          : { business: biz, date, items, payments: [{ method: pick(methods), amount: total }] });
      }
    }
    // Restaurant kitchen usage, an expense per business, debt payments.
    await post('/stock/adjust', { product: pick(ingredients), type: 'usage', qty: 3, date });
    for (const biz of ['store', 'restaurant', 'fuel']) await post('/expenses', { business: biz, category: pick(['Salaries', 'Electricity', 'Transport', 'Repairs']), amount: 500 + Math.floor(rnd() * 3000), method: 'cash', date });
    for (let k = 0; k < 3; k++) {
      const c = pick(customers);
      const owed = (await get(`/customers?business=store`)).find((x) => x.id === c)?.balance ?? 0;
      if (owed > 0) await post('/money', { type: 'customer_payment', business: 'store', customer: c, method: 'cash', amount: Math.min(owed, 2000), date });
    }
    // Fuel: two shifts a day, all four pumps.
    for (const shift of ['Day', 'Night']) {
      const readings = pumps.map((p) => { p.meter += 300 + Math.floor(rnd() * 300); return { pump: p.id, closing: p.meter }; });
      const r = await post('/fuel/shifts', { date, shiftName: shift, readings, payments: [], credits: [], differenceReason: 'volume test' }).catch(() => null);
      if (!r) throw new Error('fuel shift failed');
    }
    // Weekly restock and fuel delivery, weekly tank dip.
    if (back % 7 === 0) {
      await post('/purchases', { business: 'store', supplier, date, items: store.map((p) => ({ product: p, qty: 30, total: 30 * 70 })), paid: 0 });
      for (const [i, f] of fuels.entries()) await post('/purchases', { business: 'fuel', supplier, date, items: [{ product: f, tank: tanks[i], qty: 9000, total: 9000 * 92 }], paid: 0 });
      const setup = await get('/fuel/setup');
      for (const t of setup.tanks) await post('/fuel/dips', { tank: t.id, measuredQty: Math.max(0, Math.round(t.stock_qty - 5)), reason: 'evaporation', date });
    }
    // Close each business's day with the counted money equal to expected.
    for (const biz of ['store', 'restaurant', 'fuel']) {
      const pre = await get(`/closing/preview?business=${biz}&date=${date}`);
      await post('/closing', { business: biz, date, counted: Object.fromEntries(pre.lines.map((l) => [l.method_id, l.expected])) });
    }
    if (back % 30 === 0) process.stdout.write(`  …${date} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  console.log(`Seeded ${DAYS} days in ${Math.round((Date.now() - t0) / 1000)}s`);

  // Today: a few sales so "today" figures are not empty.
  for (let s = 0; s < 10; s++) await post('/sales', { business: 'store', items: [{ product: store[s], qty: 1 }], payments: [{ method: 'cash', amount: 100 + s * 25 }] });

  const counts = execFileSync('npx', ['wrangler', 'd1', 'execute', 'meecaad', '--local', '--persist-to', persist, '--json', '--command',
    "SELECT (SELECT COUNT(*) FROM journal_lines) lines, (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM sale_items) items, (SELECT COUNT(*) FROM stock_movements) moves, (SELECT COUNT(*) FROM audit_log) audit"],
  { env }).toString();
  console.log('Database size:', JSON.stringify(JSON.parse(counts)[0].results[0]));

  // Every GET a screen makes when it opens (with its default filters).
  const month = today.slice(0, 8) + '01';
  const screens = {
    'Sign-in check / bootstrap': ['/auth/me', '/bootstrap'],
    'Owner dashboard (all)': ['/dashboard?business=all'],
    'Owner dashboard (one business)': ['/dashboard?business=store'],
    'Sell (POS)': ['/products?business=store', '/customers?business=store'],
    'Sales history (7 days)': [`/sales?business=store&from=${dayStr(today, 6)}&to=${today}`],
    'Stock & products': ['/products?business=store'],
    'Stock history': ['/stock/movements?business=store'],
    'Purchases': ['/products?business=store', '/suppliers?business=store', `/purchases?business=store&from=${dayStr(today, 30)}&to=${today}`],
    'Expenses (month)': [`/expenses?business=store&from=${month}&to=${today}`, '/suppliers?business=store'],
    'Customers & debts': ['/customers?business=store'],
    'Customers (all businesses)': ['/customers?business=all'],
    'Money & accounts': ['/balances?business=all', `/money?business=all&from=${dayStr(today, 30)}&to=${today}`],
    'Fuel station': ['/fuel/setup', `/fuel/shifts?from=${dayStr(today, 6)}&to=${today}`, '/customers?business=fuel'],
    'Fuel reconciliation': [`/fuel/reconciliation?from=${dayStr(today, 6)}&to=${today}`],
    'Daily closing': [`/closing/preview?business=store&date=${today}`, '/closing?business=all'],
    'Reports (month)': [`/reports/summary?business=all&from=${month}&to=${today}`],
    'All transactions (7 days)': [`/reports/ledger?business=all&from=${dayStr(today, 6)}&to=${today}`],
    'Audit log (7 days)': [`/audit?from=${dayStr(today, 6)}&to=${today}`],
  };
  const results = [];
  for (const [name, paths] of Object.entries(screens)) {
    let rows = 0;
    for (const p of paths) rows += (await call('GET', p)).rows;
    results.push([name, rows]);
  }
  const sale = await call('POST', '/sales', { business: 'store', items: [{ product: store[0], qty: 1 }], payments: [{ method: 'cash', amount: 100 }] });
  results.push(['Saving one sale', sale.rows]);
  console.log('\nRows read per screen:');
  for (const [n, r] of results) console.log(`  ${String(r).padStart(9)}  ${n}`);
  const total = results.reduce((t, [, r]) => t + r, 0);
  console.log(`  ${String(total).padStart(9)}  TOTAL (every screen opened once)`);
  const BUDGET = Number(process.env.BUDGET ?? 0);
  if (BUDGET && results.some(([, r]) => r > BUDGET)) { console.error(`Over budget (${BUDGET} rows per screen)`); process.exitCode = 1; }
}

try { await main(); }
catch (e) { process.exitCode = 1; console.error(e); console.error(log.split('\n').slice(-20).join('\n')); }
finally { try { process.kill(-server.pid, 'SIGTERM'); } catch {} rmSync(persist, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }
