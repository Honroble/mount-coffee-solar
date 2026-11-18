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

## Forecast verification (proving accuracy)

`verify.py` runs once an hour from the **MCSolar Alerts** task (no new task needed). It:

1. **Seals** each finished UTC day of `forecast_log.csv`, `nwp_daily_log.csv` and `nwp_hourly_log.csv` an hour after
   the day ends: SHA-256 of that day's rows + the model files in use + a chain hash over all earlier days
   (`verification_ledger.csv`, copied to the sheet tab **VerificationLedger**). Every run re-checks every sealed day;
   any later change, deletion or late-added row shows in red on the dashboard and in the report.
   **Never edit or trim those three logs by hand** – archive them whole if they grow too big.
2. **Scores** every forecast against the logger: MAE, RMSE, bias, nMAE (% of 17.79 MWac), skill against simple
   references, and for the weather models how often the actual falls inside the low–high range.
3. **Breaks it down** by sky type, hour of day and month, lists unscored days with the reason, tags big misses.
4. Writes `verification.json` (dashboard section "Forecast verification"), `verification_days.csv` and
   `reports/verification_YYYY-MM.md` (download from the dashboard).

After pulling this version: paste the updated `apps_script_receiver.gs` into the Apps Script and deploy a
**New version** (it adds the `Verification` and `VerificationLedger` tabs). Run it once by hand to check:

```
python live\verify.py --config live\config.json --print
```

## Keep in mind
- If the portal or logger sign-in changes (new password, new page layout), the collector log shows ERROR lines.
  Run `python live\portal_collector.py --test` to see the message.
- `live\config.json` holds the sheet token: don't email or share it.
- To stop everything: `.\live\install_live_tasks.ps1 -Uninstall`
- Later, with a Gantner RAS API key, switch with `.\live\install_live_tasks.ps1 -Source api`
  (the 70 read-only channel mappings are already saved on the logger).
- Anyone viewing the dashboard needs access to the Google Sheet and the Google Sheets connector in Claude.
