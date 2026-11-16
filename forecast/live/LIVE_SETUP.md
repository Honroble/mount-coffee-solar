# Going live: Mount Coffee 15-minute forecast

Once set up, this PC collects the plant data every 5 minutes through the Gantner web portal LEC already
uses, makes a forecast every 15 minutes, and sends it to the Google Sheet "Mount Coffee Solar – Live
Forecast Log", which the online dashboard shows live. No API key or request to Gantner is needed.

```
Gantner portal + Q.reader logger --(sign in, download 70 channels, every 5 min)--> portal_collector.py --> data\live\*.csv
Open-Meteo satellite --(every 15 min)------------------------------------------> live_forecast.py --> forecast_log.csv + Google Sheet --> dashboard
                                                                                   retrain_monthly.py (every 4 weeks)
```

**Read-only:** the collector only signs in and downloads, the same as "Datafiles → Download specific period".
It never changes a logger setting. Internet use is about 1 MB a day.

**Passwords** are never written to a file. They are kept in Windows Credential Manager
("MCSolar Gantner portal", "MCSolar Q.reader logger"). If a password changes, run `python live\set_credentials.py` again.

## Before you start
- [ ] **Change the logger's default admin password** (Gantner portal → logger → System → Management or Settings).
- [ ] Set this PC to never sleep (Settings → System → Power) and keep this user signed in.

## Step 1: Set up the Google Sheet receiver (5 minutes)
1. Open the sheet **Mount Coffee Solar – Live Forecast Log** → Extensions → **Apps Script**.
2. Delete what is there, paste all of `live\apps_script_receiver.gs`, **Save**.
3. Deploy → **New deployment** → type **Web app** → Execute as **Me**, Who has access **Anyone** → Deploy → allow access.
4. Copy the **Web app URL**.

## Step 2: Install
In PowerShell, in the `forecast` folder:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\live\install_live_tasks.ps1
```
1. The first run creates `live\config.json` with a secret token and opens it in Notepad.
   Paste the Web app URL into `sheet_webhook_url` and Save. Copy the `sheet_token` value into the Apps Script line
   `const TOKEN = '...';`, Save, then Deploy → Manage deployments → edit → **New version**.
2. Run the same command again. It asks once for the portal e-mail and password and the logger user and password
   (typed hidden, stored in Windows Credential Manager), trains the fallback models, tests one small read,
   and registers three scheduled tasks: **MCSolar Collector** (every 5 min), **MCSolar Forecast** (every 15 min),
   **MCSolar Retrain** (every 4 weeks, Sunday 22:00).

## Step 3: Check it
- After 10 minutes: `data\live\collector_log.txt` shows lines like `iv2: +5 rows; iv1: +5 rows`.
- After about 2 hours (the model needs recent history): a new row every 15 minutes in the Google Sheet,
  and the **Live forecast** section of the dashboard fills in.
- The sheet's `status` column says `ok`, `stale data (...)` or `error: ...`.

## Keep in mind
- If the portal or logger sign-in changes (new password, new page layout), the collector log shows ERROR lines.
  Run `python live\portal_collector.py --test` to see the message.
- `live\config.json` holds the sheet token: don't email or share it.
- To stop everything: `.\live\install_live_tasks.ps1 -Uninstall`
- Later, with a Gantner RAS API key, switch with `.\live\install_live_tasks.ps1 -Source api`
  (the 70 read-only channel mappings are already saved on the logger).
- Anyone viewing the dashboard needs access to the Google Sheet and the Google Sheets connector in Claude.
