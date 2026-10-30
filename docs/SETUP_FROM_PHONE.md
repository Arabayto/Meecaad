# Put Meecaad online using only a phone

You need: a free **Cloudflare** account and your **GitHub** account. Everything below is done in the phone's web browser (Chrome or Safari). No computer and no commands are needed. It takes about 15 minutes.

Cloudflare sometimes renames menu items. If a name below doesn't match exactly, look for the closest one.

> Tip: in Chrome or Safari, use "Desktop site" if a Cloudflare page looks cramped.

## 1. Create the database (Cloudflare)

1. Go to **dash.cloudflare.com** and sign in (or sign up, it's free).
2. Open the menu → **Storage & Databases** → **D1 SQL Database** → **Create**.
3. Name it `meecaad` → **Create**.
4. On the database page, find **Database ID** (a long code like `3f2a9c1e-…`). Copy it.

You do not need to create any tables. Meecaad creates them itself the first time it opens.

## 2. Put the database ID into the code (GitHub)

1. Go to **github.com/Arabayto/Meecaad**, branch **main**.
2. Open the file **`wrangler.toml`** → tap the **pencil** (Edit).
3. Find the line `database_id = "00000000-0000-0000-0000-000000000000"`.
   Replace the zeros with the ID you copied. Keep the quotes:
   `database_id = "3f2a9c1e-…"`
4. Tap **Commit changes** → commit directly to `main`.

## 3. Publish the app (Cloudflare Pages)

1. In Cloudflare: **Workers & Pages** → **Create** → the **Pages** tab → **Connect to Git**.
2. Connect GitHub if asked, and allow access to the **Meecaad** repository.
3. Choose **Arabayto/Meecaad** → **Begin setup**:
   - Project name: `meecaad`
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Tap **Save and Deploy**. Wait 2–4 minutes until it says **Success**.
5. Open the link it shows, e.g. `https://meecaad.pages.dev`.

From now on, every change pushed to `main` is published automatically.

## 4. First use

1. The first screen says **Set up Meecaad**. Create the owner account and **remember the password**.
2. Add the phone to the home screen so it opens like an app:
   - Chrome: menu ⋮ → **Add to Home screen**.
   - Safari: Share → **Add to Home Screen**.

## 5. A 10-minute test

Do these in order. The money figures in brackets are what you should see.

1. **Opening cash:** Money & Accounts → Owner adds money → Store, Cash, `100`.
2. **Product:** switch to **Store** (left menu, "Working in") → Stock & Products → Add item. Use name `Sugar 1kg`, selling price `1.50`, quantity now `20`, cost per unit `1.00`.
3. **Cash sale:** Sell → tap Sugar twice → Complete sale ($3.00). Print or close the receipt.
4. **Credit sale:** Sell → tap Sugar → change the payment amount to `0` → Customer **+ New** → `Ahmed` → Complete sale.
5. **Debt payment:** Customers & Debts → Ahmed owes $1.50 → Receive payment `1.00` (he now owes $0.50; sales did **not** go up).
6. **Expense:** Expenses → `Electricity`, `0.75`, Cash.
7. **Fuel:**
   - Switch to **Fuel Station** → Stock & Products → Add fuel type `Diesel`, price `1.10`.
   - Fuel Station → Tanks & pumps: add tank `Tank A`, 10000 L capacity, 5000 L now, cost `0.90`. Add pump `Pump 1`, meter `12000`.
   - Record shift readings: closing meter `12100` (100 L = $110 expected). Cash received `105`. It asks why $5 is short → type a reason → Save.
8. **Daily closing:** switch to **Store** → Daily Closing.
   - Expected cash is $103.25. Type `102.25` for cash and `0` for the others.
   - It asks you to explain the $1 → type a reason → Close the day.
9. **Owner Dashboard:** sales today $114.50. Alerts show the fuel shortage and the cash shortage.
10. **Reports** → Profit & loss shows each business and the total.

If something looks wrong, note which step and what you saw.

## If something goes wrong

- **Build failed:** Workers & Pages → meecaad → Deployments → the failed one → read the last lines of the log.
- **"The database is not connected yet":** the `database_id` in `wrangler.toml` is still zeros or has a typo. Fix it on GitHub (step 2). The app redeploys by itself.
- **Forgot the owner password:** another owner can reset it in Users & Settings. If there is no other owner, ask a developer. This needs a database command.
