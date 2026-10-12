# 9010 Grocery Store — Full guide

The detailed version of the README: setup, signing in, the workspace, troubleshooting, data and project structure.
For the short version, see [../README.md](../README.md).

Electron + React + TypeScript + Vite + Tailwind CSS on the front end; Node.js + Express + MySQL on the
server PC; a Python ML service (XGBoost, CatBoost, LightGBM, Random Forest) called by the API.
Runs offline on the store LAN: one server PC and any number of cashier terminals (PC-01, PC-02, …; three by default).

> **This is not a PHP project.** Do not put it in XAMPP's `htdocs`. Keep it anywhere (e.g. your Documents folder).
> From XAMPP we only use **MySQL**. Apache is not needed.

---

## 1. First-time setup (development machine)

### What to install
| Tool | Notes |
|---|---|
| **Node.js 20+** | https://nodejs.org (LTS) |
| **MySQL** | Either XAMPP (ships MariaDB 10.4, works fine) or MySQL 8 |
| **Python 3.11 or 3.12** | Only for the AI features. Tick **"Add python.exe to PATH"** in the installer |
| **Git** | To clone and pull the project |

### Steps
1. **Start MySQL.** With XAMPP: open the XAMPP Control Panel and click **Start** next to **MySQL**.
   It should turn green and show port `3306`.

2. **Create your `.env` file.** Copy `.env.example` to `.env` in the project root.
   `.env` is git-ignored; every collaborator keeps their own.
   ```
   copy .env.example .env
   ```
   Pick a database password and put it in `DB_PASSWORD`. Leave `DB_PORT=3306` unless your MySQL uses another port.

3. **Create the database user** `pos_app` with the **same password** as `DB_PASSWORD` in your `.env`.
   Open `database/create-db-user.sql`, replace `change-this-password` with your password, then run it as root:
   ```
   # XAMPP (root has no password by default)
   C:\xampp\mysql\bin\mysql.exe -u root < database/create-db-user.sql

   # MySQL 8
   mysql -u root -p < database/create-db-user.sql
   ```
   You can also paste the file into phpMyAdmin (XAMPP → MySQL → **Admin** → **SQL** tab).
   Do not commit your real password back into that file.

4. **Install and create the database:**
   ```
   npm install
   npm run db:init        # creates the tables and settings (no products, people or owner yet)
   npm run ml:install     # optional: Python venv + ML packages in ml_service/.venv
   ```
   `db:init` should print `Created "grocery9010" (schema v3) ...`. If it prints an error, see [Troubleshooting](#5-troubleshooting).

5. **Run it:**
   ```
   npm run electron:dev
   ```
   On the first launch choose **I am the owner** and sign in with username **`admin`**, PIN **`000000`**. You're taken
   to **Settings → My account** to set your own username, name and PIN before anything else unlocks.

---

## 2. Everyday commands
| Command | What it does |
|---|---|
| `npm run electron:dev` | Desktop app with hot reload. With `APP_MODE=server` it also starts the API. **Use this normally.** |
| `npm run server:dev` | API only, at http://127.0.0.1:4010 (check http://127.0.0.1:4010/api/health) |
| `npm run dev` | UI only in a browser at http://localhost:5173 (needs the API running) |
| `npm run db:init` | Creates the database on first run; does nothing if it already exists |
| `npm run db:reset` | **Deletes** the database and creates it again with only `admin` / `000000` (development only). Each PC notices the new database and drops its saved data and sign-in |
| `npm run ml:health` | Checks the Python ML packages |
| `npm run typecheck` | TypeScript check for the UI, server and Electron code |
| `npm run electron:build` | Builds the Windows installer into `release/` |

After `git pull`, run `npm install` again if `package.json` changed.

---

## 3. Signing in
- **Owner**: a new system starts with one default account, username **`admin`**, PIN **`000000`** (the sign-in
  screen says so while it's still in place). The server creates it whenever no owner account exists.
  - The first sign-in opens **Settings → My account** and nothing else: set your first and last name, your own
    username (not "admin") and a new PIN. The server refuses every other request from the default account, so
    `admin` / `000000` can't be used for anything until this is done.
  - After saving, everything unlocks and you're taken to **Business profile** for the store details. The store
    name is saved on the server, so every PC and receipt shows it.
  - **My account** stays in Settings for changing your username, name or PIN later (your current PIN confirms it).
  - PINs like `000000`, `111111` or `123456` are refused. Five wrong PINs lock the account for five minutes.
  - The sign-in screen remembers the last username used on that PC.
- **Cashiers** have no PIN or password. The owner assigns them to a terminal from the **Admin Station**;
  the terminal unlocks within about two seconds and shows `Cashier: <name>`. Ending the shift locks it again.
- Voids, refunds and large discounts at a terminal need the owner's PIN.

### Seeing a cashier PC's view on one machine
The server PC starts on **Who is using this PC?**: *I am the owner* goes to the PIN sign-in, *I am a cashier* lets
you pick a register (PC-01, PC-02, …) and shows its lock screen. A register with a cashier on shift is greyed out
until the owner ends that shift; "Also open on another screen" means another window is showing it but nobody is assigned.

To see the owner's screen and a register **side by side** (best for testing and demos):
1. Sign in as the owner. In **Admin Station**, click **OPEN WINDOW ↗** on a terminal card (e.g. PC-02).
   In Electron this opens a second window acting as PC-02; in a browser, a new tab (`?terminal=PC-02`).
2. Assign a cashier to PC-02 in the owner window: the PC-02 window unlocks within a couple of seconds and shows
   only Point of Sale, Transactions and Requests.
3. **End shift** locks it again. On the lock screen, **← Switch to owner sign-in** turns that window back.

Real cashier PCs never show the chooser or the switch: their role and terminal are fixed at setup.

On first launch of the **installed** app, each PC asks whether it is the **server PC** or a **cashier terminal**
(the server's LAN address, then its terminal ID from the list the server sends).

### Adding, renaming or removing cashier PCs
In **Admin Station**:
- **＋ Add terminal** suggests the next free ID (e.g. `PC-04`). IDs are `PC-` plus two digits, so up to PC-99.
  Then set up the new PC as a cashier terminal and pick that ID.
- **Edit** on a terminal card lets you rename it or **disable** it. A disabled terminal stays locked, can't be assigned,
  and keeps its history. End the cashier's shift first if one is on it.
- **Delete** (inside Edit) is only for a terminal added by mistake. Once a terminal has had a shift or a sale it
  can only be disabled, because those records point at it.
Every add, edit and delete is written to the audit log.

---

## 4. Using the workspace

### Workspaces (top tabs)
If the tabs don't fit, scroll the mouse wheel over the tab bar or use the ‹ › arrows at its edges.

| Workspace | Panels |
|---|---|
| Admin Station | Owner only. Terminal cards (online/offline, assigned cashier, end shift), active sessions, assign cashiers, lock all terminals, **plus the Employees panel** (team, roles, 7-day sales per employee) |
| Dashboard | Live KPIs, sales by hour vs 6-day average, top sellers, AI insights, needs-attention list |
| Point of Sale | Product grid (search / SKU / barcode + Enter), cart with Senior/PWD VAT-exempt discount, hold/resume, Cash/GCash/Card/Maya payment, printable receipt, AI "frequently bought with" upsell |
| Transactions | Sales journal with receipt detail, reprint, void and returns & refunds (owner PIN), shift & cash drawer |
| Inventory | Stock metrics, sortable/filterable table, add/edit product, stock adjustments, AI reorder level & days of cover |
| Waste | Waste log, loss by reason, AI expiry-risk with one-click markdowns |
| Purchasing | AI-suggested purchase orders (editable quantities), purchase order lifecycle |
| Requests | Customer item requests with automatic grouping into demand signals |
| AI Insights | Demand forecast chart, model backtest, category trends, rising/falling movers, traffic heatmap, insight feed and "Ask AI" |
| Reports | X/Z reading, e-Journal, VAT summary, sales by item, inventory valuation, waste, cashier performance (CSV export + print); market-basket analysis and ABC classes |
| Settings | Owner only. Business profile, tax & receipts, payment methods, inventory & AI parameters, notifications, role permissions |

Cashiers only see Point of Sale, Transactions and Requests, and the editor menu only offers their editors.

### Arranging panels (Blender-style)
- **Change a panel**: use the editor menu in the panel header.
- **Split**: drag the handle in a panel header *inside the same panel*. Drag sideways for a left/right split,
  up/down for a top/bottom split.
- **Join**: drag the handle onto a neighbouring panel. A red ⊘ means those two can't be joined (they don't share a full edge).
- **Swap**: hold **Ctrl** while dropping on a neighbouring panel.
- **Resize**: drag the gutter between two panels.
- **Reset layout** (top right) restores the workspace's default arrangement.

Layouts are kept per workspace while the app is open and go back to the default when the app restarts.

---

## 5. Troubleshooting

### "Store server could not start — Access denied for user 'pos_app'@'localhost' (using password: YES)"
MySQL is running, but the `pos_app` user doesn't exist or has a **different password** than `DB_PASSWORD` in your `.env`.
`CREATE USER IF NOT EXISTS` does **not** change the password of an existing user, so re-running the script won't fix it.
Set the password directly as root (XAMPP shown; use `mysql -u root -p` for MySQL 8):
```
C:\xampp\mysql\bin\mysql.exe -u root -e "ALTER USER 'pos_app'@'localhost' IDENTIFIED BY 'your-DB_PASSWORD'; GRANT ALL PRIVILEGES ON grocery9010.* TO 'pos_app'@'localhost'; FLUSH PRIVILEGES;"
```
Then run `npm run db:init` and start the app again.

### "connect ECONNREFUSED 127.0.0.1:3306" or "Check that MySQL is running"
MySQL isn't running, or it's on another port. Start it in XAMPP and make sure the port it shows matches `DB_PORT` in `.env`.
If XAMPP's MySQL won't start, another MySQL service may already be using port 3306. Stop it in Windows **Services**,
or change the port in one of them.

### The owner PIN is rejected
1. Check the username: it's the one you set in **My account** (shown in the account menu, top right). On a new
   system it's `admin` with PIN `000000`.
2. Forgot the PIN or username in development? `npm run db:reset` starts over with `admin` / `000000` (this wipes the database).
3. After five wrong tries the account locks for five minutes. To unlock it right away:
   ```
   C:\xampp\mysql\bin\mysql.exe -u root grocery9010 -e "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = '<your username>';"
   ```
4. To set a new PIN without resetting the database:
   ```
   node -e "console.log(require('bcryptjs').hashSync('654321', 12))"
   C:\xampp\mysql\bin\mysql.exe -u root grocery9010 -e "UPDATE users SET pin_hash = '<paste hash>' WHERE username = '<your username>';"
   ```

### "Finish setting up your account first"
You're signed in with the default `admin` account. Open **Settings → My account**, set your own username, name and
PIN, and save; everything else unlocks.

### Sign-in fails even with the right PIN / the screen says it can't reach the server
The API isn't running. Look at the terminal where you ran `npm run electron:dev` for lines starting with `[api]`.
Open http://127.0.0.1:4010/api/health: if it doesn't load, the API isn't up. Fix the error it printed (usually MySQL).

### `db:init`: "was only partly set up by an earlier run"
A previous `db:init` stopped halfway. Run `npm run db:reset`.

### `db:init` on XAMPP fails with a SQL syntax error
XAMPP uses MariaDB, and the schema is written for MySQL 8. Copy the full error into the team chat. Some
MySQL-only syntax may need a MariaDB-compatible version.

### "EADDRINUSE: address already in use :::4010" (or 5173)
Another copy of the app or API is still running. Close the other terminal/window, or end the leftover
`node.exe` / `electron.exe` in Task Manager.

### "JWT_SECRET is not set; using a temporary secret for this run"
Harmless in development: owner sign-ins just stop working when the API restarts, so you sign in again.
The desktop app generates and keeps its own secret, so you'll mostly see this from `db:init` and `server:dev`.
To silence it, add `JWT_SECRET=` with 32+ random characters to `.env`.

### AI panels say the ML service is unavailable
Run `npm run ml:install`, then `npm run ml:health`. If Python isn't found, install Python 3.12 with **"Add to PATH"**
ticked, or set `ML_PYTHON` in `.env` to the full path of `python.exe`. The rest of the system works without it.

### Splitting a panel does nothing
Drag at least a short distance *within* the panel you started in. If the layout gets into a strange state,
press **Reset layout**.

### The status bar says "NOT CONNECTED" instead of "LIVE · STORE DATABASE"
The screens couldn't reach the API, so they are empty. Check the API is running (see above) and that
you're signed in. The app retries on its own every few seconds; once it connects, the status bar turns to **LIVE**.

### Status bar says "SERVER UNREACHABLE · SHOWING LAST DATA"
The API was reachable and then stopped answering. Screens keep the last data they loaded, but **nothing new is saved**
until it's back. Restart the app on the server PC; on a terminal, check the network.

### "… was not saved: …" or "Sale not completed: …"
The server refused a change (e.g. a duplicate barcode, or a cashier's shift was ended). The message says why; the
screen reloads from the database so it shows what's actually saved.

### "Migration 002_imports_and_live_data.sql failed: …"
The database couldn't be upgraded on start. Common causes: the `pos_app` user lacks ALTER rights (re-run
`database/create-db-user.sql`), or a previous upgrade stopped halfway. In development, `npm run db:reset` rebuilds it.

### An import shows errors
Each error names the line in your file and the problem (unknown product, missing price, a date it can't read…). Fix
those lines and import the same file again: rows already imported are skipped or updated, never duplicated. Dates like
`08/14/2026` are read month-first; tick **Dates are day first** for `14/08/2026`. Import **products before sales
and waste**, because those are matched to products by barcode, SKU or name.

### Running on two devices (same Wi-Fi/router, or a direct LAN cable)
1. **Server PC**: run `powershell -ExecutionPolicy Bypass -File scripts\lan-setup.ps1` as administrator. It opens
   port 4010 and prints the server's IP. Start the app with `APP_MODE=server` (`npm run electron:dev`).
2. **Direct cable, no router**: give both Ethernet adapters static IPs in the same subnet (e.g. `192.168.50.1` and
   `192.168.50.2`, mask `255.255.255.0`, no gateway). Wi-Fi/router users can skip this.
3. **Second PC** (development): in its `.env` set `APP_MODE=terminal`, `SERVER_HOST=<server IP>`,
   `TERMINAL_ID=PC-01` (add the terminal in Admin Station first), then `npm run electron:dev`.
   For the installed app, pick **cashier terminal** on first launch and enter the same values.
4. Check from the second PC: open `http://<server IP>:4010/api/health` in a browser.

### A cashier terminal can't find the server (real LAN setup)
- On the server PC, allow **TCP port 4010** through Windows Firewall (private network) — `scripts\lan-setup.ps1` does this.
- On the terminal, the server address must be the server PC's LAN IP (run `ipconfig` on the server), not `127.0.0.1`.
- The terminal's saved settings live in `%APPDATA%\9010 Grocery Store\config.json` (installed app) or
  `%APPDATA%\9010-pos\config.json` (development). Delete that file to run the first-launch setup again.

### Still stuck
Copy the **full** error from the terminal (the lines starting with `[api]`, `[main]` or `[db]`) and share it,
along with what you ran and whether you're on XAMPP or MySQL 8.

---

## 6. Data
Everything is stored in MySQL on the server PC and every PC reads it through the API; the status bar shows
**LIVE · STORE DATABASE** when that's working.

| Saved in MySQL | Still kept on each PC (for now) |
|---|---|
| Products, stock, expiry, suppliers' names | Purchase orders (receiving one *does* save the stock to MySQL) |
| Sales, receipts (numbered by the server), voids, refunds (owner PIN) | Cash drawer / shift float |
| Waste, customer requests, employees | Settings, layout |
| Sign-in, terminals, sessions, audit log | |

Without a reachable server (e.g. `npm run dev` alone) the screens are empty; there is no built-in demo data.
A new database starts empty too (`LOAD_SAMPLE_DATA=false`): add products in Inventory or import them. Set
`LOAD_SAMPLE_DATA=true` and run `npm run db:reset` for a quick look with 20 made-up products and 4 cashiers. Senior/PWD sales ask for the ID number and name on the card; the database requires them.

### Importing from the old system
**Admin Station → ⇪ Import data** (or pick the *Data Import* panel from any panel's editor menu). Export each list from
the old system as **Excel (.xlsx/.xls) or CSV**, then:
1. Pick what it is: **Products & stock**, **Employees**, **Sales history**, **Waste** or **Customer requests**.
   *Download the template* if you want to see the expected columns.
2. Choose the file. Title rows above the table are fine; for workbooks, pick the sheet.
3. Check the column matching (done automatically from names like "Item Description", "SRP", "SOH", "OR No.").
4. **Check file** runs the whole import without saving and lists every problem by line number.
   Then **Import** saves the good rows and skips the bad ones.

Import in this order: **products → employees → sales → waste → requests**.
- Products are matched by barcode, then SKU, then name; existing ones are updated, and "stock on hand" replaces the count.
- Sales: one row per item; rows with the same receipt number become one receipt. Re-importing skips receipts that are
  already there. Old sales are history only (reports and AI forecasting) and don't change stock. Cashiers named in the
  file but not in Employees are added as inactive employees. Old sales are recorded on `PC-00`, a hidden
  "server PC / imported history" terminal that also holds sales the owner rings up on the server PC.
- Every import is written to the audit log.

### Database upgrades
`database/migrations/` holds numbered changes after `schema.sql`. They apply automatically when the API starts
(or on `npm run db:init`); see `database/migrations/README.md` before adding one.

## 7. Project structure
- `electron/` — desktop shell: `main.ts` starts the API as a child process (server mode), checks the Python service,
  `appConfig.ts` holds per-PC settings, `ipc-handlers.ts` + `preload.cts` bridge to the UI
- `server/` — Express API: `config/` (env, MySQL pool, first-run database setup), `middleware/` (auth, rbac, ownerPin,
  audit, errors), `routes/`, `services/` (all SQL lives here), `utils/`
- `database/` — `create-db-user.sql`, `schema.sql`, `seed.sql`, `sample-data.sql` (development only), `migrations/`
- `ml_service/` — Python ML service: `predict.py` (entry), `train.py`, `models.py`, `backtest.py`, `anomaly.py`
- `scripts/ml.mjs` — `ml:install` / `ml:health`
- `src/pages/` — `OwnerLogin`, `AdminStation`, `TerminalLock`, `DeviceSetup`
- `src/context/` — `AuthContext` (owner JWT), `TerminalContext` (this PC's role and assignment)
- `src/hooks/useTerminalPolling.ts`, `src/services/api.ts` (axios), `src/components/OwnerPinModal.tsx`
- `src/components/Workspace.tsx` — workspace tabs and the split-panel layout engine
- `src/workspace/editors/` — every screen/panel; `index.tsx` registers them and says which workspace each belongs to
- `src/workspace/ui.tsx` — shared UI: modal, fields, segmented control, charts
- `src/store/StoreContext.tsx` — the screens' data: loads it from `/api/store` and saves changes back (empty without a server)
- `server/services/store.service.ts` (store data), `import.service.ts` (imports), `src/workspace/editors/DataImport.tsx` (import screen)
- `src/components/OwnerMainMenu.tsx`, `MakeSale.tsx`, `ReturnRefund.tsx`, `ReceiptHistory.tsx` — earlier light-theme
  owner screens, reachable at `#/owner` after the owner signs in
