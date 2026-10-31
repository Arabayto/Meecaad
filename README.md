# Meecaad Integrated Business Management System

One application for the three Meecaad businesses — **Restaurant & Cafe**, **Fuel Station** and **Store** — with one login, one navigation and one owner dashboard that shows what each business sells, spends, owes, is owed and holds, and where money or stock is going missing.

The look and feel (Inter, the green brand tokens, sidebar/topbar shell, cards, panels, tables, modals, toasts, sign-in screen) is reused from the Al-Hayat ERP (`Arabayto/al-hayat-erp-wms`, `web/src/styles/global.css` and its components). That repository was only read; nothing in it was changed.

## Stack

| Part | What |
|---|---|
| Frontend | React 18 + Vite + TypeScript SPA (`src/`), `react-router-dom`, `lucide-react` icons. No other UI libraries. |
| API | **One** Cloudflare Pages Function: `functions/api/[[path]].ts`, with the logic in `server/`. |
| Database | Cloudflare D1 (SQLite), schema in `migrations/`. Reached only through the `DB` binding inside the function — no credentials or tokens in the browser. |
| Hosting | Cloudflare Pages (static `dist/` + the function, same origin). |

```
migrations/0001_init.sql   database schema (tables, constraints, indexes, append-only triggers)
functions/api/[[path]].ts  router: auth, CSRF check, permission check, JSON errors
server/lib.ts              validation, roles/permissions, journal posting, atomic write batch (Tx)
server/auth.ts             sign-in, sessions, users
server/catalog.ts          products, stock adjustments, customers, suppliers, payment methods, tanks, pumps
server/ops.ts              sales, returns, purchases, expenses, debt payments, transfers, owner money
server/fuel.ts             shift meter readings, tank dips, fuel reconciliation
server/reports.ts          owner dashboard, alerts, reports, daily closing, audit log
src/pages/*                one page per screen
tests/run.mjs              end-to-end test against the real stack (wrangler + local D1)
```

## How the money is recorded (the important part)

Every financial event writes one **balanced journal entry** (`journal_entries` + `journal_lines`, amounts in integer cents) in the same atomic D1 batch as the business record (sale, purchase, …), its stock movements and its audit row. Every number on the dashboard and in reports is a sum over those saved lines — there are no stored totals that can drift and no hard-coded figures.

The owner never sees accounting jargon; internally the accounts are:

| Account | Meaning |
|---|---|
| `cash` (per business **and** payment method) | Money in the drawer / Zaad / Edahab / any added method |
| `receivable` (per customer) | What a customer owes that business |
| `payable` (per supplier) | What that business owes a supplier |
| `inventory` | Stock at cost |
| `sales`, `cogs` | Revenue, and the cost of the goods sold or used |
| `expense` (with category) | Rent, salaries, electricity, … |
| `stock_loss` | Waste, damage, count corrections, fuel tank variance |
| `cash_diff` | Cash shortages/overages from closings and fuel shifts |
| `transfer`, `owner` | Money moved between businesses; owner money in/out and opening balances |

**Profit = sales − cost of goods − expenses − stock losses − cash differences.** Money received is shown separately from profit.

How the common mistakes are avoided:

1. **Credit sale** → sales + customer debt. A later **debt payment** moves debt → cash; it is never a sale (and cannot exceed what is owed).
2. **Transfers** move cash between accounts/businesses only. Between businesses each side posts against `transfer`, which nets to zero across all businesses — revenue and profit are unchanged (tested).
3. **Purchases** go to stock (weighted-average cost), not expenses. Cost of goods is recorded when an item is sold (store, stocked drinks) or used (restaurant ingredient usage) or pumped (fuel).
4. **Cancellations and returns** post reversing entries (dated the day they happen) and put stock back; the original record stays, marked cancelled, with who/when/why.
5. **Debts** are always the live sum of the journal, per business and per customer/supplier; statements show every charge and payment with a running balance.
6. **Adjustments** (waste, count corrections, tank dips, cash differences, meter resets, price changes, reopening a day) require a reason and are written to the audit log.
7. **Nothing is deleted.** Database triggers make `journal_entries`, `journal_lines` and `audit_log` append-only.

**Duplicate protection:** the browser sends an `Idempotency-Key` with every save (kept stable until the save succeeds), and the server stores it in the same transaction — a double click or retried request returns the first result instead of saving twice. Receipt numbers are unique per business; stock can never go below zero for shop/kitchen items (a `CHECK` constraint rolls back the whole sale).

## Business modules

- **Restaurant & Cafe** — menu items and prices; fast POS with categories and search; split payments (Cash/Zaad/Edahab/any method); credit to a customer; discounts; printable receipts; sales history with returns/cancellations; ingredients with purchases, kitchen usage (→ cost of food) and waste; drinks can be stock-tracked.
- **Fuel Station** — fuel types and price per litre (every change kept in price history); tanks with book stock; pumps with meters; deliveries into a tank (purchases, paid or on supplier credit); **shift readings**: opening → closing meter = litres sold → money expected, then cash/mobile received and credit customers, with any shortage/overage requiring a reason; a meter that does not continue from the last reading is flagged; **tank dips** compare measured litres to the book and record the variance; **reconciliation**: start + delivered − sold ± dips = should-be-now, vs the last dip, plus daily expected/received/difference.
- **Store** — products, categories, barcodes, purchase/selling prices, suppliers, purchases, sales, returns, waste, stock counts, customer debts, supplier payments, best sellers, low-stock alerts.

## Owner dashboard, closing, alerts

- Switch **All Businesses / Restaurant & Cafe / Fuel Station / Store**; **Today / This week / This month**, each compared with yesterday / the same days last week / the same days last month. Combined figures are always shown next to each business's own figures.
- Sales, cost of goods, expenses, losses, estimated profit, money available (per business × payment method), customers owe us, we owe suppliers, stock value, money received/paid today, recent activity, and alerts: out-of-stock/low stock, low or negative tanks, fuel missing in dips, fuel shift shortages, meter gaps, cash shortages at closing, days not closed, overdue debts (no payment for 30 days), negative money balances.
- **Daily closing** per business: opening balance, sales, debts collected, expenses, stock/supplier payments, transfers/owner money, **expected** (calculated), **counted** (entered), **difference** (explanation required). The difference is posted as a cash difference so the books match the real money — it is never hidden. Closed days are locked; only the owner/manager can reopen the latest day, with a reason, which reverses the difference.

## Roles

| Role | Can |
|---|---|
| Owner | Everything, all businesses, users, settings, audit log |
| Manager | For their assigned businesses: sell, stock, purchases, expenses, closing, cancellations/returns, prices, transfers, reports |
| Cashier | Sell, collect debts, close the day (assigned businesses) |
| Restaurant / Store staff | Sell and record usage/waste in their business |
| Fuel station staff | Shift readings, money received, credit customers, tank dips |

The server enforces every permission; the UI only hides what a user cannot use.

## Run locally

```bash
npm install
```

```bash
npm run db:migrate:local
```

```bash
npm run build && npm run pages:dev
```

Open http://localhost:8788 — the first visit asks you to create the owner account. For hot-reload UI work run `npm run dev` in a second terminal (Vite proxies `/api` to port 8788).

## Tests

```bash
npm test
```

Starts `wrangler pages dev` on a fresh local D1 and walks through the real workflows, checking every figure against hand-calculated values: first-run setup and auth guards, cash sale with idempotent retry, split mobile payment, credit sale + debt collection, purchase on part credit (average cost), supplier payment, expense, return, cancelled sale, oversell rejection, restaurant usage/waste, fuel tank/pump/delivery/shift shortage/dip/reconciliation, inter-business transfer, daily closing with difference + lock + reopen, consolidated dashboard (all = sum of businesses), cashier permissions, and database integrity (every entry balances, stock = movements, inventory ledger = stock value, transfers net to zero, journal append-only).

## Deploy to Cloudflare (first time)

**No computer?** Follow [docs/SETUP_FROM_PHONE.md](docs/SETUP_FROM_PHONE.md). It does everything in the Cloudflare and GitHub websites and includes a 10-minute test.

The app creates its database tables itself on the first request (`server/migrate.ts`). It records them in wrangler's `d1_migrations` table, so step 2 below is optional.

This is a new, separate Pages project and D1 database; it does not touch the Al-Hayat deployment or its PostgreSQL data.

1. Create the database and copy the printed `database_id` into `wrangler.toml`:
   ```bash
   npx wrangler d1 create meecaad
   ```
2. (Optional) Apply the schema ahead of time:
   ```bash
   npm run db:migrate:remote
   ```
3. Create the Pages project once, then deploy:
   ```bash
   npx wrangler pages project create meecaad --production-branch main
   ```
   ```bash
   npm run deploy
   ```
4. Open the site and create the owner account. Then add employees, products, tanks/pumps, and opening cash ("Money & Accounts → Owner adds money").

The D1 binding is declared in `wrangler.toml` (`binding = "DB"`); Pages picks it up on deploy. If you connect the repo through the Cloudflare dashboard instead, use build command `npm run build`, output `dist`, and add the D1 binding `DB` → `meecaad` in the project settings.

## Database changes (migrations)

- Never edit an applied migration. Add a new file `migrations/0002_<what>.sql` — the build embeds it (`scripts/embed-migrations.mjs`). The app applies it on the next request, or you can run `npm run db:migrate:remote`. Both record it in `d1_migrations`.
- Take a backup first (below). Migrations must only add or alter — never drop tables holding financial data.

## Backup and recovery

- **Point-in-time recovery (built into D1):** D1 Time Travel keeps 7 days of history on the free plan and 30 days on Workers Paid ($5/month).
  ```bash
  npx wrangler d1 time-travel info meecaad
  ```
  ```bash
  npx wrangler d1 time-travel restore meecaad --timestamp=2026-10-30T18:00:00Z
  ```
  A restore replaces the current database with the state at that time (it prints a bookmark so the restore itself can be undone).
- **Full SQL export** (do this before every migration and regularly, e.g. weekly, and keep copies off Cloudflare):
  ```bash
  npm run db:backup
  ```
  writes `backups/meecaad-<date>.sql` (git-ignored).
- **Restore an export into a new database** (safe test of a backup, or disaster recovery):
  ```bash
  npx wrangler d1 create meecaad-restore
  ```
  ```bash
  npx wrangler d1 execute meecaad-restore --remote --file=backups/meecaad-YYYYMMDD-HHMMSS.sql
  ```
  then point the `DB` binding at it.

## Costs and limits

Everything runs on Cloudflare's free plan. Cloudflare bills D1 by **rows read**: the free plan allows 5 million per day.

Screens never re-add the whole history. Two summary tables are updated in the same atomic save as every money record (`migrations/0002_summaries.sql`), and the tests check they always equal the full journal:
- `account_balances`: current balance of every money account, customer and supplier.
- `daily_totals`: per business, day and kind of transaction.

All list screens read through indexes, limited to the dates they show.

Measured with `npm run test:volume`, which simulates a year of activity: ~33,000 sales, 106,000 money records, 730 fuel shifts and daily closings. Rows read per screen visit:

| Screen | Rows read |
|---|---:|
| Owner dashboard (all businesses) | ~3,500 (was ~288,000 before the summary tables) |
| Sell (till) | ~500 |
| Daily closing | ~3,300 |
| Stock & products (incl. sold in 30 days) | ~8,200 |
| Reports for a month | ~22,000 (depends on the date range, not on total history) |
| Saving a sale | ~26 |

At these rates, even hundreds of screen visits a day stay far below the free limit. `npm run test:volume` fails if any screen goes over 30,000 rows, so a slow query can't slip back in. Every API response carries an `X-Rows-Read` header, and requests over 50,000 rows are logged in Cloudflare (Workers & Pages → meecaad → Logs).

Still worth checking monthly: **D1 → meecaad → Metrics → Rows read**. If the limit is ever reached, the API stops working until midnight UTC. **Workers Paid ($5/month)** raises the limits far beyond this workload and gives 30 days of Time Travel instead of 7.

## Security notes

- Passwords: PBKDF2-SHA256 (100k iterations, per-user salt). 5 wrong attempts lock the account for 15 minutes.
- Sessions: random token in an `HttpOnly; SameSite=Strict; Secure` cookie; only its SHA-256 is stored. Changing a user's password, role or disabling them ends their sessions.
- CSRF: every non-GET request must carry `X-Requested-With: meecaad` (cross-site pages cannot set it).
- Strict Content-Security-Policy and security headers in `public/_headers`; the API is never cached.
