# Mount Coffee Solar – Output Forecast & Monitoring

LEC SCADA/EMS project for the Mount Coffee PV plant: 21.17 MWp DC / 17.79 MWac, export limit 16.64 MW (plant
controller setpoint), 52 × 320 kW inverters in STS1–STS4, fixed 10° south-facing panels, 22 kV connection,
Gantner Q.reader logger "LEC – Mount Coffee Liberia – QRC".

It collects live plant and weather data from the logger (read-only) and produces two forecasts:

- **Short term (plant data):** 15, 30 and 60 minutes ahead every 15 minutes, from the logger's 1-minute data, the weather
  station and satellite irradiance (`forecast/live/live_forecast.py`).
- **Hours to 3 days (weather models):** every hour, the average of 6 Open-Meteo weather models with a dust (AOD)
  correction plus the single-model 15-minute forecast, with ramp / reserve / model-split alerts and a day-ahead scorecard
  against the logger's daily energy (`forecast/live/nwp_forecast.py`). Method from J. A. Harris (Manager SCADA/EMS),
  calibrated on May–Oct 2026 daily energy. Weather data by Open-Meteo.com (CC BY 4.0).

Both appear on the Next.js dashboard for operations and NLDC dispatch, with:

- a **best estimate for the next 6 hours** (plant-data forecast handing over to the weather models),
- an hour-by-hour **calibration** of the weather models against the logger (`calibrate_nwp.py`, monthly),
- a **dispatch check** (reserve margin vs largest loss, suggested solar cap, tie-line margin, synchronous share),
- **plant health** checks (output vs satellite-implied output, inverters, pyranometers, logger disk/channels/limit),
- an **irradiance** view (4 pyranometers, satellite over the plant and 20 km ring, weather models, clear sky),
- **energy since commissioning** (J07 export from the monthly reports until 31 Oct, logger after),
- a **control-room screen** at `/tv`,
- **e-mail alerts and a daily summary** (`alerts.py` via the Google receiver).

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
- [ ] Move the live system from the PC to an always-on LEC server: see `docs/SERVER_SETUP.md`.
- [ ] Recalibrate the weather-model factors hourly with the logger's 1-minute history (they are fitted on daily energy only).
- [ ] Confirm site coordinates (6.52 N, −10.63 used for the weather models; 6.505 N, −10.648 in the plant-data model).
- [ ] Plant issues from the 16 Nov review: horizontal sensors may read 10–20 % low (retrain the plant-data model if they
      are recalibrated); STS1 INV03/INV14 duplicate Modbus address; PQM-1 CT/VT ratios unset; feeder relay P07 lost
      phase-C voltage; PQM-2/PQM-3 dead; STS3 meteo station silent; STS3/STS4 gauge scale 4,928 instead of 4,224 kW.
- [ ] Optional dispatch panel: reserve margin vs largest loss, recommended solar cap (`PowerLimit_User`), tie-line margin.
- [ ] Colleagues outside the LEC network: decide on a private VPN (e.g. Tailscale) rather than exposing port 3000 to the internet.

## Working together

1. Create a branch for your change: `git checkout -b short-description`.
2. Commit small, clear changes; never commit passwords, tokens or `config.json`.
3. Open a pull request on GitHub and ask a teammate to review before merging into `main`.
4. Anything that changes the logger (Gantner) configuration must be discussed first – the system is designed to be read-only.

Times in all data and pages are UTC (= Monrovia time).
