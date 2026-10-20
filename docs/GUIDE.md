# 9010 Grocery Store — Guide

Step-by-step help for running the app, connecting to another person's database, using it, and fixing errors.
For the short version, see [../README.md](../README.md).

> **Not a PHP project.** Don't put it in XAMPP's `htdocs`; keep it anywhere (e.g. Documents). From XAMPP you only need **MySQL**.

> **The real system is local and needs no internet.** In the store, the server PC and the cashier PCs talk over the store's
> own network (a router with no internet, or a LAN cable between them), so it works offline. Tailscale is **only for
> development testing**, when teammates are in different places and still want to share one database.

**Jump to:** [1. Install](#1-install-what-you-need) · [2. Start the app](#2-start-the-app-your-own-data) ·
[3. Join someone else's database](#3-join-someone-elses-database-tailscale) · [4. Sign in and use it](#4-sign-in-and-use-it) ·
[5. Errors and fixes](#5-errors-and-fixes) · [6. Data and importing](#6-data-and-importing) · [7. Project structure](#7-project-structure)

---

## 1. Install what you need

| Tool | Notes |
|---|---|
| **Node.js 20+** | https://nodejs.org (LTS) |
| **MySQL** | XAMPP (MariaDB 10.4 works) or MySQL 8. Only needed on the PC that **hosts** the data |
| **Python 3.11 or 3.12** | Only for the AI features. Tick **"Add python.exe to PATH"** |
| **Git** | To clone and pull the project |
| **Tailscale** | Development testing only, to connect to a teammate's database over the internet ([section 3](#3-join-someone-elses-database-tailscale)). Not used in the store |

---

## 2. Start the app (your own data)

Use this when **you** hold the database. To use another person's database instead, skip to [section 3](#3-join-someone-elses-database-tailscale).

1. **Start MySQL.** XAMPP Control Panel → **Start** next to MySQL (it turns green, port `3306`).
2. **Create `.env`.** Copy `.env.example` to `.env` in the project root and set `DB_PASSWORD`. `.env` is git-ignored.
   ```
   copy .env.example .env
   ```
3. **Create the database user** with the same password. Put it in `database/create-db-user.sql` (replace
   `change-this-password`), then run:
   ```
   C:\xampp\mysql\bin\mysql.exe -u root < database/create-db-user.sql
   ```
   (MySQL 8: `mysql -u root -p < database/create-db-user.sql`.) Don't commit your real password.
4. **Install and create the database:**
   ```
   npm install
   npm run db:init
   npm run ml:install     # optional: AI features
   ```
5. **Run it:**
   ```
   npm run electron:dev
   ```
6. **First sign-in:** choose **I am the owner**, username **`admin`**, PIN **`000000`**. You're taken to
   **Settings → My account** to set your own username, name and PIN; nothing else unlocks until you do.

If any step prints an error, see [section 5](#5-errors-and-fixes).

| Command | What it does |
|---|---|
| `npm run electron:dev` | Desktop app (also starts the server). **Use this normally** |
| `npm run server:dev` | API only; check http://127.0.0.1:4010/api/health |
| `npm run db:reset` | **Deletes** the database and recreates it with only `admin` / `000000` (development only) |
| `npm run ml:health` | Checks the Python ML packages |
| `npm run typecheck` | TypeScript check |
| `npm run electron:build` | Builds the Windows installer into `release/` |

After `git pull`, run `npm install` again if `package.json` changed.

---

## 3. Join someone else's database (Tailscale)

> **Development testing only.** Tailscale needs an internet connection and is just a way to reach a teammate's PC while
> you're apart. In the store you don't use it: the cashier PCs connect to the server PC over the local network, with no
> internet (see "Running in the store" below).

Everyone testing can use **the same data** instead of creating their own. One person is the **host** (their PC runs
the server and holds the database); everyone else connects to it as a cashier terminal. Nothing is copied or synced.

### Everyone
1. Install **Tailscale** (https://tailscale.com/download) and sign in.
2. The host invites you to their tailnet (or shares their PC with you). Check the Tailscale app shows the host as connected.

### Host (the person whose data everyone uses)
1. Do [section 2](#2-start-the-app-your-own-data) so the app runs in server mode (`APP_MODE=server` in `.env`). **Leave it running** while others test.
2. Open **PowerShell as administrator** in the project folder and run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\lan-setup.ps1 -Tailscale
   ```
   This keeps Windows Firewall **on** and only lets Tailscale addresses reach port 4010. It prints your
   **Tailscale IP** (looks like `100.x.y.z`). Send it to your teammates privately. Never open MySQL (3306).
3. Sign in as the owner. In **Admin Station**, click **＋ Add terminal** for each teammate (PC-02, PC-03, …) and tell each person their ID. One PC per ID.

### Teammate (joining the host's database)
1. **Check you can reach the host.** In a browser open `http://<host's Tailscale IP>:4010/api/health`. It should show a status page.
2. **Edit `.env`** (see `.env.example`, setup B). Use these values and don't run your own server or MySQL:
   ```
   APP_MODE=terminal
   TERMINAL_ID=PC-02
   SERVER_HOST=<host's Tailscale IP>
   API_PORT=4010
   ```
3. **Run it:** `npm install` (first time), then `npm run electron:dev`.
4. The screen says it is waiting for the owner. The host assigns you to your terminal in Admin Station, and it unlocks within a couple of seconds.

The **installed** app works the same way: on first launch pick **cashier terminal**, enter the host's Tailscale IP, then choose your terminal ID.

### If it doesn't connect

| What you see | What to do |
|---|---|
| `/api/health` link won't load | Host: is the app running? Everyone: is Tailscale connected (host shown online)? Host: run `lan-setup.ps1 -Tailscale` again as administrator |
| `/api/health` times out only for you | The host's firewall rule is missing or wrong. Host: run the script again and check **Windows Defender Firewall → Inbound Rules** for "9010 POS API (Tailscale)" |
| Health loads, but the app says it can't reach the server | `SERVER_HOST` must be the host's Tailscale IP, **not** `127.0.0.1`. Fix `.env`, or delete the saved settings file (see "Terminal can't find the server" in section 5) and restart |
| Your terminal ID isn't in the list / "not registered" | The host has to add it in Admin Station first |
| "Waiting for owner assignment…" forever | That's normal until the host assigns you to your terminal in Admin Station |
| Your screen is empty or shows your own data | You're running your own server. Set `APP_MODE=terminal`, restart, and make sure no `node.exe` / `electron.exe` is left running |
| The host's IP changed | The Tailscale IP normally stays the same; if not, ask the host for the new one and update `SERVER_HOST` |

### Running in the store (local, no internet)
1. **Server PC:** run `powershell -ExecutionPolicy Bypass -File scripts\lan-setup.ps1` as administrator (no `-Tailscale`). It opens
   port 4010 on the private network and prints the server's local IP. Start the app in server mode.
2. **Connect the PCs:** put them on the same router (it doesn't need internet) or join two PCs with a LAN cable. For a cable with no
   router, set static IPs on both Ethernet adapters (e.g. `192.168.50.1` and `192.168.50.2`, mask `255.255.255.0`, no gateway).
3. **Each cashier PC:** `APP_MODE=terminal`, `SERVER_HOST=<server's local IP>`, `TERMINAL_ID=PC-01` (add it in Admin Station first).
   The installed app asks for the same two values on first launch.
4. Check from a cashier PC: `http://<server's local IP>:4010/api/health` should load.

---

## 4. Sign in and use it

### Signing in
- **Owner:** on a new system the account is **`admin`** / **`000000`**. The first sign-in opens **Settings → My account**;
  set your name, your own username and a PIN (`000000`, `111111`, `123456` are refused). Five wrong PINs lock the account for five minutes.
- **Cashiers** have no PIN. The owner assigns them to a terminal in **Admin Station**, and it unlocks within about two seconds.
- Voids, refunds and large discounts at a terminal need the owner's PIN.

### Main menu
After signing in you land on the **Main Menu**: a grid with one tile per workspace you may open, and a side panel with
today's sales, alerts and (for the owner) the AI demand forecast and notes. Click a tile to open it; **⌂ MAIN MENU**
(top left) returns to the grid.

### Owner: Admin Station
- **Assign a cashier:** pick a name on a terminal card and click **ASSIGN**.
- **Pause shift** locks that terminal but keeps the shift open; **Resume shift** unlocks it. **End shift** ends it for good.
- **＋ Add terminal** adds the next free ID (PC-04, …). **Edit** renames or disables one; **Delete** is only for a terminal added by mistake (one with shifts or sales can only be disabled).
- **Lock all terminals** ends every active shift.
- The **Employees** panel beside it shows each cashier's current shift or when it ended, and their 7-day sales.

### Cashier
- Use **Make a Sale** to ring up items.
- Your name menu (top right) has **Pause shift** (locks the terminal until the owner resumes it) and **End shift** (the end time is recorded).

### Seeing a cashier's screen on your own PC
In **Admin Station**, click **OPEN WINDOW ↗** on a terminal card. A second window opens acting as that terminal; assign a
cashier and it unlocks. On its lock screen, **← Switch to owner sign-in** turns the window back.

### Workspaces
| Workspace | What's in it |
|---|---|
| Admin Station | Owner only. Terminal cards, assigning cashiers, Employees panel |
| Dashboard | Live KPIs, sales by hour, top sellers, AI insights, needs-attention list |
| Point of Sale | Product search / barcode, cart, Senior/PWD VAT-exempt discount, hold/resume, Cash/GCash/Card/Maya, receipt |
| Transactions | Sales journal, reprint, void, returns & refunds (owner PIN), cash drawer |
| Inventory | Stock table, add/edit product, adjustments, AI reorder level. The **⋯** menu on a row: receive delivery, batch discount, stock history, forecast |
| Waste | Waste log, loss by reason, expiry-risk markdowns |
| Purchasing | AI-suggested purchase orders |
| Requests | Customer item requests grouped into demand signals |
| AI Insights | Demand forecast, trends, heatmap, insight feed |
| Reports | X/Z reading, e-Journal, VAT, sales by item, valuation, cashier performance (CSV/print) |
| Settings | Owner only. Business profile, tax & receipts, payment methods, AI parameters, role permissions |

Cashiers only see Point of Sale, Transactions and Requests.

### Arranging panels
- **Change a panel:** the editor menu in its header. **Split:** drag the corner handle inside the same panel (sideways or up/down).
  **Join:** drag the handle onto a neighbour (a red ⊘ means they can't be joined). **Swap:** hold **Ctrl** while dropping on a neighbour.
  **Resize:** drag the gutter between two panels. **Reset layout** (top right) restores the default.
- Layouts reset to the default when the app restarts.

---

## 5. Errors and fixes

Find the message you see, then follow the steps.

### Starting the app

**"Store server could not start — Access denied for user 'pos_app'@'localhost'"**
The `pos_app` user is missing or has a different password than `DB_PASSWORD` in `.env`. Re-running the script won't change an
existing password, so set it directly (use `mysql -u root -p` for MySQL 8):
```
C:\xampp\mysql\bin\mysql.exe -u root -e "ALTER USER 'pos_app'@'localhost' IDENTIFIED BY 'your-DB_PASSWORD'; GRANT ALL PRIVILEGES ON grocery9010.* TO 'pos_app'@'localhost'; FLUSH PRIVILEGES;"
```
Then `npm run db:init` and start the app again.

**"connect ECONNREFUSED 127.0.0.1:3306" / "Check that MySQL is running"**
MySQL isn't running or is on another port. Start it in XAMPP and make sure its port matches `DB_PORT`. If it won't start,
another MySQL service may be using 3306: stop it in Windows **Services**, or change one of the ports.

**"EADDRINUSE: address already in use :::4010" (or 5173)**
A copy of the app is still running. Close the other window, or end leftover `node.exe` / `electron.exe` in Task Manager.

**`db:init`: "was only partly set up by an earlier run"** → run `npm run db:reset`.

**`db:init` on XAMPP fails with a SQL syntax error**
XAMPP uses MariaDB and the schema targets MySQL 8. Send the full error to the team.

**"Migration 00X_….sql failed: …"**
The database couldn't be upgraded on start. Usually `pos_app` lacks ALTER rights (re-run `database/create-db-user.sql`) or an
earlier upgrade stopped halfway. In development, `npm run db:reset` rebuilds it. A new column that's "missing" (for example when
pausing a shift) means the server hasn't been restarted since you pulled: restart the host's app so migrations apply.

**"JWT_SECRET is not set; using a temporary secret"**
Harmless in development: owner sign-ins stop working when the API restarts, so you sign in again. Add `JWT_SECRET=` (32+ random characters) to `.env` to silence it.

**AI panels say the ML service is unavailable**
Run `npm run ml:install`, then `npm run ml:health`. If Python isn't found, install 3.12 with **Add to PATH** ticked, or set `ML_PYTHON` in `.env`. The rest works without it.

### Signing in

**The owner PIN is rejected**
1. Use the username you set in **My account** (on a new system: `admin` / `000000`).
2. Forgot it in development? `npm run db:reset` starts over (wipes the database).
3. Locked after five wrong tries? Wait five minutes, or unlock now:
   ```
   C:\xampp\mysql\bin\mysql.exe -u root grocery9010 -e "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = '<your username>';"
   ```
4. Set a new PIN without resetting:
   ```
   node -e "console.log(require('bcryptjs').hashSync('654321', 12))"
   C:\xampp\mysql\bin\mysql.exe -u root grocery9010 -e "UPDATE users SET pin_hash = '<paste hash>' WHERE username = '<your username>';"
   ```

**"Finish setting up your account first"** → you're on the default `admin` account. Open **Settings → My account** and set your own details.

**Sign-in fails with the right PIN / "can't reach the server"**
The API isn't running. Look in the terminal for lines starting with `[api]` and open http://127.0.0.1:4010/api/health. If it doesn't load,
fix the error shown (usually MySQL).

### While using the app

**Status bar says "NOT CONNECTED"** → the screens couldn't reach the API, so they're empty. Check the API is running and you're signed in; it retries every few seconds and turns to **LIVE** when it connects. On a terminal, see "Terminal can't find the server" below.

**Status bar says "SERVER UNREACHABLE · SHOWING LAST DATA"** → the API stopped answering. Screens keep the last data but **nothing new is saved**. Restart the app on the server PC; on a terminal, check the network (or Tailscale).

**"… was not saved: …" / "Sale not completed: …"** → the server refused the change (e.g. duplicate barcode, shift ended or **paused**). The message says why, and the screen reloads from the database.

**A terminal froze or is stuck on "Shift paused"** → only the owner can resume it: **Admin Station → Resume shift** on that PC's card.

**Splitting a panel does nothing** → drag a short distance *within* the panel you started in, or press **Reset layout**.

**An import shows errors** → each error names the line and problem. Fix those lines and import the same file again (rows already imported are skipped or updated, never duplicated). `08/14/2026` is read month-first; tick **Dates are day first** for `14/08/2026`. Import **products before sales and waste**.

### Terminal can't find the server
- Check `http://<server IP>:4010/api/health` in a browser on the terminal. Use the server's LAN address (`ipconfig` on the server) or its Tailscale IP, **never** `127.0.0.1`.
- Server PC on a LAN: run `scripts\lan-setup.ps1` as administrator (opens TCP 4010 for Private networks). `-Tailscale` is only for development testing.
- Direct cable with no router: give both Ethernet adapters static IPs in one subnet (e.g. `192.168.50.1` and `192.168.50.2`, mask `255.255.255.0`, no gateway).
- The terminal's saved settings are in `%APPDATA%\9010 Grocery Store\config.json` (installed app) or `%APPDATA%\9010-pos\config.json` (development). Delete that file to redo the first-launch setup.
- LAN setup for a second PC: `.env` with `APP_MODE=terminal`, `SERVER_HOST=<server IP>`, `TERMINAL_ID=PC-01` (add it in Admin Station first), then `npm run electron:dev`.

### Still stuck
Copy the **full** error from the terminal (lines starting with `[api]`, `[main]` or `[db]`) and share it, with what you ran and whether you're on XAMPP or MySQL 8.

---

## 6. Data and importing

Everything lives in MySQL on the host/server PC; every PC reads it through the API. The status bar shows **LIVE · STORE DATABASE** when it works.

| Saved in MySQL | Still kept on each PC |
|---|---|
| Products, stock, expiry, supplier names | Purchase orders (receiving one saves the stock) |
| Sales, receipts, voids, refunds | Cash drawer / shift float |
| Waste, customer requests, employees | Settings, layout |
| Sign-in, terminals, sessions, shifts, audit log | |

A new database starts empty. Add products in Inventory or import them. For a quick look with 20 made-up products and 4 cashiers,
set `LOAD_SAMPLE_DATA=true` and run `npm run db:reset`.

### Importing from the old system
**Admin Station → ⇪ Import data.** Export each list from the old system as Excel or CSV, then:
1. Pick the type: **Products & stock**, **Employees**, **Sales history**, **Waste** or **Customer requests** (*Download the template* shows the columns).
2. Choose the file (title rows above the table are fine; for workbooks pick the sheet).
3. Check the column matching, then **Check file** (a dry run listing every problem by line), then **Import**.

Import in this order: **products → employees → sales → waste → requests**. Products match by barcode, then SKU, then name. Sales group
by receipt number, are history only (they don't change stock) and are recorded on a hidden `PC-00` terminal. Every import is audit-logged.

### Database upgrades
Numbered files in `database/migrations/` apply automatically when the API starts (or on `npm run db:init`). Read `database/migrations/README.md` before adding one.

---

## 7. Project structure
- `electron/` — desktop shell: `main.ts` starts the API (server mode), `appConfig.ts` holds per-PC settings, `ipc-handlers.ts` + `preload.cts` bridge to the UI
- `server/` — Express API: `config/`, `middleware/` (auth, rbac, ownerPin, audit), `routes/`, `services/` (all SQL), `utils/`
- `database/` — `create-db-user.sql`, `schema.sql`, `seed.sql`, `sample-data.sql`, `migrations/`
- `ml_service/` — Python ML service; `scripts/` — `ml.mjs`, `lan-setup.ps1`
- `src/pages/` — `OwnerLogin`, `AdminStation`, `TerminalLock`, `DeviceSetup`; `src/context/` — `AuthContext`, `TerminalContext`
- `src/components/Workspace.tsx` — top bar, main menu / workspace switching, account menu and the split-panel layout engine; `MainMenu.tsx` — the home grid
- `src/hooks/` — `useTerminalPolling.ts`, `useOwnShift.ts` (cashier pause/end shift)
- `src/workspace/editors/` — every screen/panel (`index.tsx` registers them); `src/workspace/ui.tsx` — shared UI
- `src/store/StoreContext.tsx` — loads store data from `/api/store` and saves changes back
- `server/services/session.service.ts` (terminals, shifts), `store.service.ts` (store data), `import.service.ts` (imports)
