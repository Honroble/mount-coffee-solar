# Mount Coffee Solar – dashboard (Next.js)

Double-click **SETUP_DASHBOARD.bat** once. It installs Node.js if needed, builds the app,
starts it, and sets it to start automatically whenever this user logs on.

Open **http://localhost:3000** (other PCs: http://<this PC's IP>:3000; the address is shown at the bottom of the page).

**On a colleague's PC** (no `..\data\live` folder): the setup asks for the forecast PC's address and saves it in
`.env.local` as `MCSOLAR_SOURCE_URL=http://<forecast PC>:3000`. Their own http://localhost:3000 then shows live data from
the forecast PC. Requires the LEC network or VPN.

- History (17 Sep – 13 Nov 2026) comes from `data/history/*.json`.
- Live data comes from `..\data\live` (written by the forecast tasks): `forecast_log.csv`,
  `iv2_live_*.csv`, `iv1_live_*.csv`. Set `MCSOLAR_LIVE_DIR` to use another folder.
- The page refreshes live data every minute.
- Stop / remove: `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_dashboard.ps1 -Uninstall`
- Log: `dashboard.log`
