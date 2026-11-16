# Moving the live system to an always-on LEC server

The forecast PC works, but it misses runs whenever it sleeps, restarts or is signed out. An always-on Windows
server (or a VM) inside the LEC network removes those gaps. Nothing in the code is tied to the PC.

## What the server needs
- Windows Server 2019+ or Windows 10/11, always on, internet access to `ras.gantner-webportal.com`,
  `*.open-meteo.com` and `script.google.com`.
- Python 3.11–3.13 with the packages in `forecast/requirements` (run `forecast\SETUP_AND_RUN.bat` once),
  Node.js 20 LTS for the dashboard.
- A local service account (e.g. `svc-mcsolar`) that stays signed in, or tasks set to "Run whether user is
  logged on or not" (then store the passwords with `set_credentials.py` while signed in as that account).
- Port 3000 open to the LEC network (Domain/Private profile only).

## Steps
1. Copy the `mcsolar` folder (forecast, dashboard, data) from the PC, or clone this repository and copy `data\`.
2. Copy `forecast\live\config.json` from the PC (it holds the sheet token, never commit it).
3. As the service account: `python forecast\live\set_credentials.py` (portal and logger passwords).
4. From `forecast\`: `powershell -NoProfile -ExecutionPolicy Bypass -File .\live\install_live_tasks.ps1`.
5. In `dashboard\`: `SETUP_DASHBOARD.bat`.
6. On the old PC: `install_live_tasks.ps1 -Uninstall` and `setup_dashboard.ps1 -Uninstall`, so only one machine
   writes to the Google Sheet.
7. Tell colleagues the new address (`http://<server>:3000`) and update `MCSOLAR_SOURCE_URL` in their `.env.local`.

## Power settings (if it stays on the PC)
Settings > System > Power > "When plugged in, put my device to sleep after" = Never. The collector now
backfills up to 12 hours after a gap, but forecasts for the missed quarter-hours are not made afterwards.
