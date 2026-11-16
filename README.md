# Mount Coffee Solar – Output Forecast & Monitoring

LEC SCADA/EMS project for the 20 MW DC / 16.64 MW AC Mount Coffee PV plant (52 × 320 kW inverters in STS1–STS4,
Gantner Q.reader logger "LEC – Mount Coffee Liberia – QRC").

It collects live plant and weather data from the logger (read-only), forecasts plant output 15, 30 and 60 minutes
ahead every 15 minutes, and shows the results on dashboards for operations and NLDC dispatch.

Current accuracy (blocked cross-validation, 17 Sep – 13 Nov 2026), mean absolute error in MW:

| Horizon | Persistence | This model |
|---|---|---|
| 15 min | 1.57 | **1.16** |
| 30 min | 2.26 | **1.83** |
| 60 min | 3.09 | **2.22** |

## What is in this repository

| Folder | What it is |
|---|---|
| `forecast/` | Python forecast model: training, single forecast, satellite download (`mcsolar/` package, `train.py`, `forecast.py`, `fetch_satellite.py`) |
| `forecast/live/` | The live system on the forecast PC: logger collector (`portal_collector.py`), 15-minute forecaster (`live_forecast.py`), monthly retraining, Windows task installer, Google Sheet receiver (Apps Script) |
| `dashboard/` | Next.js dashboard (live forecast, inverters, weather, history, accuracy) served from the forecast PC on port 3000 |
| `gridsense/` | GridSense "Solar Forecast" page (`solar-forecast.html`) in the lecsystemstudies.net style |

## How the pieces fit

```
Gantner Q.reader logger ──(portal, read-only, every 5 min)──> portal_collector.py ──> data/live/iv1_live_*.csv, iv2_live_*.csv
Open-Meteo satellite GHI ─────────────────────────────────────────────────────────┐
                                                                                  v
                                       live_forecast.py (every 15 min) ──> data/live/forecast_log.csv
                                                                          └──> Google Sheet "Forecasts" (Apps Script web app)
dashboard/ (Next.js, reads data/live)        gridsense/solar-forecast.html (reads a published sheet CSV)
```

Folder layout expected on the forecast PC:

```
mcsolar/
  forecast/     <- forecast/ from this repo (+ trained *.joblib models)
  dashboard/    <- dashboard/ from this repo
  data/         <- logger exports and data/live (NOT in git)
```

## Getting started

- **Forecast model / live system:** see `forecast/README.md` and `forecast/live/LIVE_SETUP.md`.
  Short version: run `forecast\SETUP_AND_RUN.bat` once (trains models from the logger exports in `data\`), then
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\live\install_live_tasks.ps1` from `forecast\`.
- **Dashboard:** double-click `dashboard\SETUP_DASHBOARD.bat` (installs Node.js if needed), then open http://localhost:3000.
  For development: `cd dashboard && npm install && npm run dev`. Set `MCSOLAR_LIVE_DIR` to point at a `data/live` folder.
- **Dashboard on a colleague's PC:** clone this repo, double-click `dashboard\SETUP_DASHBOARD.bat` and, when asked,
  enter the forecast PC's address shown at the bottom of its dashboard (e.g. `http://10.0.0.25:3000`). The colleague then
  opens http://localhost:3000 on their own PC: history comes from the repo, live data from the forecast PC.
  Colleagues can also just open the forecast PC's address in a browser. Both need the LEC network (or VPN); the forecast
  PC's setup opens port 3000 in Windows Firewall for Domain/Private networks only.
- **GridSense page:** open `gridsense/solar-forecast.html`; set `SHEET_CSV_URL` in its `CONFIG` block.

## Secrets – never commit these

Ignored by `.gitignore`, but check before every commit:

- `forecast/live/config.json` (sheet token, web-app URL, API key) – copy `config.example.json` and fill it in locally.
- Passwords: the collector keeps portal and logger passwords in Windows Credential Manager (`set_credentials.py`), never in files.
- The real `TOKEN` in the deployed Apps Script; the repo copy has a placeholder.
- Logger data exports (`data/`) and trained models (`*.joblib`) – large and site data; retrain with `SETUP_AND_RUN.bat`.

## Open items for the team

- [ ] `gridsense/solar-forecast.html` expects sheet columns `timestamp, forecast_mw, actual_mw, p10_mw, p90_mw`,
      but the live sheet writes `issued_utc, p_now_mw, p_15min_mw, …`. Agree one format and adapt one side.
- [ ] Change the logger's default `admin` password, then run `python live\set_credentials.py` on the forecast PC.
- [ ] Logger disk is ~96 % full; plan a data-file clean-up or upload.
- [ ] Forecast range (P10–P90) and day-ahead forecast are not implemented yet.
- [ ] Consider moving the live system from the PC to an always-on LEC server.
- [ ] Colleagues outside the LEC network: decide on a private VPN (e.g. Tailscale) rather than exposing port 3000 to the internet.

## Working together

1. Create a branch for your change: `git checkout -b short-description`.
2. Commit small, clear changes; never commit passwords, tokens or `config.json`.
3. Open a pull request on GitHub and ask a teammate to review before merging into `main`.
4. Anything that changes the logger (Gantner) configuration must be discussed first – the system is designed to be read-only.

Times in all data and pages are UTC (= Monrovia time).
