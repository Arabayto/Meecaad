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
server/ops.ts              sales, returns, purchases, expenses, debt payments (customers paying, suppliers paid)
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
| `transfer`, `owner` | Old transfers between businesses and owner money (no longer possible; kept for history) |

**Profit = sales − cost of goods − expenses − stock losses − cash differences.** Money received is shown separately from profit.

How the common mistakes are avoided:

1. **Credit sale** → sales + customer debt. A later **debt payment** moves debt → cash; it is never a sale (and cannot exceed what is owed).
2. **No transfers.** Money moves only when a customer pays a debt or a supplier is paid. (Older transfers stay in the books, netting to zero.)
3. **Purchases** go to stock (weighted-average cost), not expenses. Cost of goods is recorded when an item is sold (store, stocked drinks) or used (restaurant ingredient usage) or pumped (fuel).
4. **Cancellations and returns** post reversing entries (dated the day they happen) and put stock back; the original record stays, marked cancelled, with who/when/why.
5. **Debts** are always the live sum of the journal, per business and per customer/supplier; statements show every charge and payment with a running balance.
6. **Adjustments** (waste, count corrections, tank dips, cash differences, meter resets, price changes, reopening a day) require a reason and are written to the audit log.
7. **Nothing is deleted.** Database triggers make `journal_entries`, `journal_lines` and `audit_log` append-only.

**Duplicate protection:** the browser sends an `Idempotency-Key` with every save (kept stable until the save succeeds), and the server stores it in the same transaction — a double click or retried request returns the first result instead of saving twice. Receipt numbers are unique per business; stock can never go below zero for shop/kitchen items (a `CHECK` constraint rolls back the whole sale).

## Business modules

- **Restaurant & Cafe** (kept simple) — **one Point of Sale page** for the whole sale: tap the picture menu (a badge shows how many), then either **Pay** at once (Cash / Zaad / Edahab / On credit in one tap; cash given → change; discount and split payment only when needed — the order and its sale are saved together) or **Send to kitchen — pay later**. Unpaid orders sit as chips at the top of the same page: tap one to add or change items and take its payment in the same step (or cancel it with a reason, print its kitchen ticket). After each sale a line offers the receipt or kitchen ticket to print; **today's sales history** (filters, returns, cancellations) is underneath. Table, name and kitchen note are optional; order numbers restart each day; optional table; sales history with returns/cancellations; expenses (paid when recorded); customer debts; dashboard and reports. No stock, kitchen screen, purchases, suppliers, money page or daily closing — profit is sales − expenses (minus any cash found short at shift closings). The owner can move restaurant money from the Owner Admin.
- **Fuel Station** — Dashboard, Sales, Shifts, Inventory, Expenses, Credit Customers, Suppliers, Reports, Users & Roles (owner), Settings (no pumps, fuel types, opening fuel/money, money page or daily closing). Everything reads in **Hargeisa time (UTC+3)**. **Shifts:** every salesman opens **their own shift** (several can be open at once; the shift whose time it is — Morning 06:00–14:00, Evening 14:00–22:00, Night 22:00–06:00 by default, editable in Settings → Shift times — is suggested), records the money collected — **Cash / Zaad / Edahab** (cash can be typed in Shillings at the day's rate) or a **customer debt** (the customer must exist; "+ New" adds one) — and closes the shift when their time finishes. Every sale is in the books as it happens. A manager or the owner can close a forgotten shift and cancel a wrong sale (reason required); the owner does not work shifts. **Inventory (kept by the sales staff, managers and the owner):** any number of items — diesel, petrol, oils, tools — like a normal shop: each has a **cost price** (US dollars per unit; becomes an average as stock comes in at different costs) and a **selling price** (US dollars or Somaliland Shillings), with the margin shown. **Receiving stock** records what it cost and how it was paid — Cash / Zaad / Edahab now, or owed to a supplier (who then appears under Suppliers with what we owe); it is not also an expense. Counts are corrected with a reason (the loss or gain is recorded at cost); every change is logged; low-stock and below-zero alerts. **Salesmen sell by item at that price** — they type a quantity or an amount, the system works out the total (Shilling prices are converted at the day's rate), and stock goes down with the sale and comes back if the sale is cancelled. Each sale also counts what the goods cost, so profit = sales − cost of goods − expenses. Selling is never blocked by stock. Changing a price never changes sales already made. Until the first item exists, a sale can be a plain amount. **Owner view:** the dashboard shows who is working now (live), today's sales vs yesterday, how the money came in, who owes, money held, who sold the most, which shift sells best (per shift averages), what sells and the stock levels, the last 7 days, plain-words insights, and alerts for shifts open past their time. **Shifts page:** every shift with who, when, how long and what was collected (salesmen see only their own). **Reports:** daily reconciliation (per day, with Shillings), per item, per salesman, per shift, compared with the period before; printable. **Expenses** are recorded by sales staff too, choosing the category from a list the manager keeps (Settings → Expense categories). Every business has its own category list (the restaurant and store lists are kept from their Expenses page → *Categories*). **Settings** (manager / owner): the daily USD → SLSH rate (history kept), shift times, expense categories. **Where people are registered:** employees and their roles in *Users & Roles* (owner; in the fuel portal or the owner admin); suppliers under *Suppliers* (fuel portal, store, or owner admin) or straight from "+ New" when receiving stock.
- **Store** — products, categories, barcodes, purchase/selling prices, suppliers, purchases, sales, returns, waste, stock counts, customer debts, supplier payments, best sellers, low-stock alerts. **Point of sale** is a plain till form: type the item name or scan its barcode (Enter adds it), quantity, Add; the lines; customer, discount, payment; Complete sale — with today's sales history underneath. **Purchases**: a *New purchase* button at the top opens the purchase form; the purchase history (search, supplier and status filters, totals) is below. **Expenses**: the category is chosen from a list (Salaries, Rent, Electricity, …) that a manager or the owner keeps with the *Categories* button — add, rename, hide. **Reports** (for any date range, compared with the period before): sales, gross profit, expenses, net profit, items sold, given on credit, customers owe, owed to suppliers, stock value, returns and cancellations as cards; how the profit is made (sales − cost of goods − expenses − losses); day by day; best sellers with cost, profit and margin; products not selling (money tied up); low or out of stock; how customers paid; sales by cashier; where the money went; purchases; best customers; who owes us and whom we owe. *All transactions* is a second tab; the report prints.

## Users, roles and security

- **Users & Roles** (owner only; in the Owner Admin and the restaurant portal): one account per person with a role in each business; search and filter by business, role and status; last sign-in and devices signed in; sign a person out on every device (e.g. a lost phone); unlock an account; a table of what each role can do; sign-in history (successful and failed attempts, with address).
- **Passwords:** at least 8 characters with letters and numbers, not the username, not a well-known password; stored with PBKDF2-SHA256. Changing a password signs out every other device.
- **Sign-in protection:** 5 wrong passwords lock an account for 15 minutes; 20 failures from one address in 15 minutes block that address for 15 minutes (even across usernames). Sign-ins are written to the audit log.
- **Sessions:** random token in an HttpOnly, Secure, SameSite=Strict cookie (only its hash is stored); ends after 12 hours unused and after 7 days at most. Changing someone's role, password or blocking them signs them out.
- **Requests:** changes must come from the app's own page (header + same-origin check), only GET/POST/PATCH, size-limited, strict JSON. Every permission is checked on the server; the screens only hide what cannot be used.
- **Browser headers:** strict Content-Security-Policy, HSTS, no framing, no referrer, no sniffing, cross-origin isolation; search engines are told not to index the site.
- There is always at least one active owner. Records are never deleted: the journal and audit log are append-only.
- **Who did what:** lists show who recorded each entry (sales, expenses, orders, closings), and can be searched and filtered by person, status, category and payment method.

## Owner admin (all businesses together)

Kept short on purpose. **Overview:** one card per business with **Sales, Spent and Profit** (Today / This week / This month, with the change against the period before; tap a card to open that business), then the three totals, a few lines in plain words (which business brings the most, who is losing money, what customers owe), the top things that need attention, and a small money-position box. **Reports:** summary cards for the period (sales, spent, profit, number of sales, compared with the period before) and the money position now (customers owe, we owe suppliers, stock value), a card per business, best sellers, by business, where the money went (expenses by kind), how customers paid, and day by day; "All transactions" is a second tab. *Spent* = cost of goods + expenses + losses and cash shortages; *Profit* = Sales − Spent. There is no Money page and no transfers anywhere: money moves only when a customer pays a debt or a supplier is paid (from Customers / Suppliers; a wrong payment is cancelled from the person's statement). Transfers between businesses and owner money in/out were removed; any made before stay in the books and can be seen.

## Owner dashboard, closing, alerts

- Switch **All Businesses / Restaurant & Cafe / Fuel Station / Store**; **Today / This week / This month**, each compared with yesterday / the same days last week / the same days last month. Combined figures are always shown next to each business's own figures.
- Sales, cost of goods, expenses, losses, estimated profit, money available (per business × payment method), customers owe us, we owe suppliers, stock value, money received/paid today, recent activity, and alerts: out-of-stock/low stock, low or negative tanks, fuel missing in dips, fuel shift shortages, meter gaps, cash shortages at closing, days not closed, overdue debts (no payment for 30 days), negative money balances.
- **Restaurant shift closing (xisaab xidh)** — every person who takes money closes their own shift: everything they did since their last closing (no fixed hours). Per payment method (Cash, Zaad, Edahab) the system shows sales, debts collected and expenses paid from the drawer, so the **expected** amount; the person enters what they **have** (optional: change money that was already in the drawer). Any difference needs an explanation, is booked as a cash difference under their name, and appears in alerts. The money is handed to a named owner/manager, unpaid orders are handed over to the next shift, and a slip can be printed. Someone who still has an unclosed shift started on an earlier day cannot take payments or pay expenses until they close it (taking orders still works). Owner/manager see **Closings**: all shifts (reopen the latest with a reason), who has not closed yet, per-day and per-cashier totals (short/over). The owner can **close a finished month or year**: nothing dated in it can be added, changed or cancelled until reopened with a reason (all shifts with money in it must be closed first).
- **Daily closing** (store): the day at a glance — sales, given on credit, expenses, purchases, profit of the day, top items and expenses — then one card per money account (Cash, Zaad, Edahab): *start of the day*, *+ came in*, *− went out* (each with what it was), *= should have*, and the amount counted, marked **Matches / Short / Over**; a total line, then **difference** (explanation required). The difference is posted as a cash difference so the books match the real money — it is never hidden. Closed days are locked; only the owner/manager can reopen the latest day, with a reason, which reverses the difference.

## Portals and roles

Three independent business portals plus an owner area. Each has its own sign-in page, sidebar, dashboard and navigation; there is no business switcher.

| Address | For |
|---|---|
| `/restaurant` | Restaurant & Cafe: point of sale (orders, payment and sales history on one page), close my shift, menu, expenses, customers, closings, reports |
| `/store` | Store: point of sale, products & stock, purchases |
| `/fuel` | Fuel Station: pumps & shifts, tanks, deliveries, fuel prices |
| `/admin` | Owner only: all businesses together, users & roles, settings, audit log |
| `/` | Choose a portal (one portal → straight in) |

A person has one account and a **role in each business** they work in:

| Role | Restaurant / Store | Fuel Station |
|---|---|---|
| Manager | Everything for that business except users | Same, with pump shifts instead of a till |
| Cashier | Sell, collect debts, close the day (restaurant: take orders and payments, pay small expenses, close own shift) | Record pump shifts, collect debts, close the day |
| Staff | Sell, record stock usage/waste (restaurant: take orders and payments) | Pump readings and tank dips |
| Owner | Everything, every business, the owner admin | |

Customers and suppliers belong to the business(es) they are linked to. The server enforces every business boundary and permission; the screens only hide what cannot be used. Audit findings, changes and the data migration are in [docs/BUSINESS_SEPARATION.md](docs/BUSINESS_SEPARATION.md).

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

Starts `wrangler pages dev` on a fresh local D1 and walks through the real workflows, checking every figure against hand-calculated values: first-run setup and auth guards, cash sale with idempotent retry, split mobile payment, credit sale + debt collection, purchase on part credit (average cost), supplier payment, expense, return, cancelled sale, oversell rejection, restaurant usage/waste, fuel tank/pump/delivery/shift shortage/dip/reconciliation, inter-business transfer, daily closing with difference + lock + reopen, restaurant shift closing (explanation, hand-over, reopen, earlier-day block, month/year lock), consolidated dashboard (all = sum of businesses), cashier permissions, and database integrity (every entry balances, stock = movements, inventory ledger = stock value, transfers net to zero, journal append-only).

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
