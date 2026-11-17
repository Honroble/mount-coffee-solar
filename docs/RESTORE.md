# Restore points

## restore-2026-11-17-before-kpis  (commit f67d653, 17 Nov 2026 17:46 GMT)
The working version before these were added:
- Performance & losses panel (PR, availability, specific yield, daily loss breakdown) and `forecast/live/kpi.py`
- "PR & losses" quick answer and KPI section in the shift reports
- Self-monitoring: red "Data system problem" banner, alerts for portal sign-in failure / live poller stopped / forecast stopped
- Google-side watchdog (`forecast/live/apps_script_watchdog.gs`)

### To go back
Easiest: ask Claude "restore the version before the KPIs" - it copies the old files back to the forecast PC.

By hand on the forecast PC:
1. GitHub > Honroble/mount-coffee-solar > branch `restore-2026-11-17-before-kpis` > Code > Download ZIP.
2. Copy its `dashboard` and `forecast` folders over `C:\Users\Admin\Downloads\mcsolar\` (keep `data\`, `forecast\live\config.json`,
   `dashboard\.env.local` and the `*.joblib` model files - they are not in GitHub).
3. Run `dashboard\setup_dashboard.ps1`.
4. If the Google watchdog was installed: in Apps Script, delete the "watchdog" file and its trigger (Triggers, clock icon).
Files that only exist in the new version (safe to delete after going back): `forecast/live/kpi.py`, `data/live/kpi_daily.json`,
`dashboard/lib/kpi.js`, `dashboard/lib/system.js`, `dashboard/app/PerformanceSection.jsx`, `dashboard/app/SystemBanner.jsx`,
`dashboard/app/api/kpi/`, `dashboard/app/api/system/`, `dashboard/data/history/kpi_daily.json`.
