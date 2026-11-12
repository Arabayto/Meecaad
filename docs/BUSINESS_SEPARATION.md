# Business separation: audit, changes and migration

Meecaad runs three independent businesses: **Restaurant & Cafe**, **Store** and **Fuel Station**. This document records what the audit found, what was changed, how existing data was migrated, and how the separation is tested.

## 1. Audit findings (before the change)

| Area | Finding |
|---|---|
| Products, stock, sales, purchases, expenses, fuel tanks/pumps/shifts, closings, money records | **Already business-owned.** Every row has a `business_id` (child rows inherit it from their parent), and the server checked access. A store item could not be sold or created in another business. |
| "Drinks, Rice, Oil" in the Fuel *Add item* form | **Fixed hint text** shared by all businesses. It was not Store data in the Fuel Station. The Category field was also shown for fuel, where it makes no sense. |
| Customers and suppliers | **Shared across all businesses** (no business link). Tested with real requests: a store-only cashier could *see* restaurant customers and fuel suppliers, *rename* a restaurant customer, and *sell on credit* to a restaurant-only customer. |
| Roles | **One global role per person.** A person could not be a manager in one business and a cashier in another. |
| Application structure | **One app with a "Working in" business switcher.** Pages changed behaviour based on a remembered selection, and navigation was shared. |
| Payment methods | Shared settings (Cash/Zaad/Edahab), by design. Balances are already separate per business and method. |
| Restaurant | No tables, no orders paid later, no recipes (ingredient use had to be entered by hand). |

## 2. What changed

### Database and API (the real boundary)
- `customer_businesses` and `supplier_businesses` link each customer and supplier to the business(es) it belongs to.
  - A person who deals with two businesses stays **one record**. Their debts were already kept separately per business.
  - The owner can share a record with another business from the Owner Admin. It can only be removed from a business when nothing is owed there.
- Every customer/supplier list, edit, statement, sale, purchase, expense, payment and fuel credit is checked against the business **on the server** (`partyIn`, `requireBiz`, `bizScope` in `server/lib.ts`).
- **Roles per business:** `user_businesses.role` is `manager`, `cashier` or `staff`. Permissions depend on the role *and* the kind of business (`BIZ_ROLE_PERMS`); for example, at the fuel station a cashier records pump shifts instead of using a till. The owner flag gives everything.
- Dashboards and reports require report permission in **each** business they include. A "combined" view only covers the businesses where the person has it.
- Restaurant-only tables (`restaurant_tables`, `open_orders`, `open_order_items`, `order_sales`) are fixed to the restaurant with `CHECK (business_id = 'restaurant')`.
- **Features per business** (`BUSINESS_FEATURES`, limits the owner too): the restaurant has no stock, purchases, suppliers or daily closing (`migrations/0006_simple_restaurant.sql` removed recipes and kitchen statuses; past financial records are kept).

### Portals
| Address | Who | Navigation |
|---|---|---|
| `/restaurant` (`/restaurant/login`) | Restaurant roles, owner | Dashboard, New Order, Orders, Sales History, Menu, Expenses, Customers & Debts, Reports |
| `/store` (`/store/login`) | Store roles, owner | Dashboard, Point of Sale, Sales & Returns, Products & Stock, Purchases, Expenses, Customers & Debts, Suppliers, Money, Daily Closing, Reports |
| `/fuel` (`/fuel/login`) | Fuel roles, owner | Dashboard, Pumps & Shifts, Fuel Types & Prices, Deliveries, Expenses, Credit Customers, Suppliers, Money, Daily Closing, Reports |
| `/admin` (`/admin/login`) | Owner only | All Businesses, Combined Reports, Money & Transfers, Customers, Suppliers, Users & Roles, Settings, Audit Log |
| `/` | Everyone | Choose a portal. People with one portal go straight in. |

- **No business switcher.** The business comes from the address.
- Moving to another portal starts fresh: no cart or form carries over.
- A person who opens a portal they have no role in is sent back to `/` with "Your account does not have access to …". The server would refuse the requests anyway.
- One account works in every portal it has a role in.

### Business-specific screens
- **Catalog pages per kind:** Menu (dishes and drinks), Ingredients & Stock, Products & Stock, Fuel Types & Prices.
- **Categories:** suggestions come only from that business's own items. Hints are per business. Fuel has no category.
- **Restaurant:**
  - Tables, and orders saved now and paid later.
  - **Recipes:** selling a dish takes its ingredients out of stock at their current cost.
  - **Cancelling** a sale puts the ingredients back. A **returned** dish does not, because cooked food cannot go back into stock.
  - The Menu page shows the cost and margin of every dish.
- **Fuel Station:** no Point of Sale (fuel is sold through pump readings). A convenience shop is **not** part of the Fuel Station today. If one is added, it should be its own submodule with its own catalog, not the Store's.

## 3. Migration of existing data (`migrations/0003_business_boundaries.sql`, `0004_restaurant.sql`)
- Only **adds** tables and one column. Nothing is deleted, renamed or recreated.
- **Customers and suppliers** are linked to every business where they already have a transaction: journal lines, sales, money movements, fuel credits, purchases, expenses.
  - Ones with no transactions are linked to the businesses of the person who created them. The owner's go to all three, so no contact is lost; the owner can narrow this in the Owner Admin.
- **Users** keep exactly their old access:

  | Old role | New role(s) |
  |---|---|
  | manager | manager in each of their businesses |
  | cashier | cashier in each of their businesses |
  | `*_staff` | staff in that business |
  | owner | owner |

- Applied automatically on the first request after deployment (`server/migrate.ts`). Can also be applied with `npm run db:migrate:remote`.

**Verified on a copy with existing data:** identical sales, customer debts and supplier debts before and after; correct links; every user could still sign in with the same access; same number of records.

## 4. Tests (`npm test`, plus the browser checks)
Acceptance criteria and where they are checked:
1. **A Store employee cannot reach Restaurant or Fuel data.** API test "business separation": lists, edits, statements, sales, credit, dashboards, closings and purchases across the boundary are all refused. Browser: typing a restaurant/admin address returns to the chooser.
2. **Restaurant categories never appear elsewhere; Store products never appear in other catalogs.** Catalog pages filter by business *and* kind. The server refuses cross-business products, menu items and recipe ingredients (tested).
3. **Fuel uses fuel-only workflows.** No till; tanks, pumps, shifts and dips are fuel-only; a store product cannot be a fuel type (tested).
4. **Each portal has its own dashboard and navigation.** Browser: each portal's menu is checked, and there is no switcher anywhere.
5. **Sales, expenses and reports use the right business.** The existing figure tests per business; combined = sum of businesses.
6. **Multi-business users reach their authorized portals.** Test: manager in Store and cashier in Restaurant sees the Store dashboard, not the Restaurant's; can sell in both; cannot add restaurant expenses.
7. **Direct API requests cannot bypass authorization.** All of the above are done with direct API calls, not through the screens.
8. **Historical records remain intact.** Upgrade check above, plus the integrity test: every journal entry balances, stock equals its movements, summaries equal the journal, the journal is append-only.
9. **No global business dropdown.** Removed; browser checks confirm.
