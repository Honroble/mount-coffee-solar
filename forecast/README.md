# Mount Coffee Solar – Short-Term Output Forecast (v0.1)

Forecasts plant AC output (MW) **15, 30 and 60 minutes ahead** from Gantner Q.reader data.
Plant: LEC Mount Coffee, 20 MW DC / 16.64 MW AC, 52 × 320 kW inverters in stations STS1–STS4.

## Quick start (Windows, one click)
1. Unzip this folder to `C:\mcsolar\forecast`.
2. Leave the data files in your Downloads folder (or put them in `C:\mcsolar\data`):
   `iv2_20260917_000000_20261114_000000.csv`, `iv1_20260917_000000_20261114_000000.csv`,
   `mount_coffee_satellite_ghi.csv`.
3. Double-click **SETUP_AND_RUN.bat**. It installs Python 3.13 if missing (via winget), copies the
   data files, installs the packages, trains the model and runs a test forecast.
   Results are saved in `training_report.txt` and `test_forecast.txt`.
   If it installs Python, it asks you to double-click it once more.

## How it works
1. **Clean** (`mcsolar/data.py`) – reads Gantner CSV exports (`;`-separated, units row, latin-1),
   removes "no data" codes (655.35, 6553.5, 65535), converts kW → MW, flags outage days
   (no grid frequency, missing data, or near-zero output in daylight).
2. **Clear-sky model** (`mcsolar/clearsky.py`) – pvlib Ineichen clear-sky GHI at 6.505° N, 10.648° W,
   scaled to plant MW from the clearest minutes and capped at the plant's ~16.9 MW ceiling.
3. **Features** (`mcsolar/features.py`) – per 15-min block: clear-sky index (actual ÷ clear-sky),
   its recent lags and variability, 1-minute variability inside the block, spread across the 52 inverters,
   per-station (STS1–4) index, sun position, and the known clear-sky power at the target time.
4. **Model** (`mcsolar/model.py`) – gradient-boosted trees (scikit-learn), one per horizon, predicting the
   future clear-sky index; converted back to MW and clipped to the plant limit.
5. **Weather hook** (`mcsolar/weather.py`) – adds pyranometers, temperatures, DustIQ and WS600
   (humidity, pressure, wind, rain) from the iv1 export once it is available. No code change needed.

## Usage
```bash
pip install pandas numpy scikit-learn pvlib joblib

# train (prints cross-validation report, saves model)
python train.py --iv2 "data/iv2_*.csv" [--iv1 "data/iv1_*.csv"] --out mcsolar_model.joblib

# forecast from the latest data (run every 15 min)
python forecast.py --model mcsolar_model.joblib --iv2 "data/iv2_*.csv" --json
# back-test a past moment
python forecast.py --model mcsolar_model.joblib --iv2 "data/iv2_*.csv" --at "2026-11-13 11:30"
```

iv2 export channels needed: `Information.Inverter sum P`, `Active Power.Frequency`,
`Active Power.Power_Setpoint`, and `STSx.INVyy.active_power_total` for all 52 inverters.

## Results so far (17 Sep – 13 Nov 2026)
Blocked cross-validation, 2-week folds (each fold tested on data the model never saw). Daytime only.
Persistence = "the next 15 minutes will equal the last 15 minutes". Mean absolute error (MAE):

| Horizon | Persistence | Plant only | + Weather station | + Satellite | Improvement vs persistence (RMSE) |
|---|---|---|---|---|---|
| 15 min | 1.57 MW | 1.20 MW | 1.19 MW | 1.16 MW | 24.8 % |
| 30 min | 2.26 MW | 1.85 MW | 1.85 MW | 1.83 MW | 18.4 % |
| 60 min | 3.09 MW | 2.36 MW | 2.28 MW | 2.22 MW | 26.8 % |

Satellite data is used only 30 minutes after it was measured (as it would arrive live).
With no delay the 60-min improvement would be 29.6 %, so a faster satellite feed is worth a little.
The satellite reads ~40 % above the plant pyranometers in cloudy weather (they agree under clear sky);
the model uses it for change and approaching cloud, not as an absolute value.

Models included:
- `mcsolar_model.joblib` – plant data only (`--iv2`)
- `mcsolar_model_weather.joblib` – plant + weather station (`--iv2 --iv1`)
- `mcsolar_model_satellite.joblib` – plant + weather + satellite (`--iv2 --iv1 --sat`)

Get satellite data with `python fetch_satellite.py --past-days 1 --out sat_recent.csv`
(needs internet access to satellite-api.open-meteo.com).

## Known limits / next steps
- Only ~8 weeks of data, all in the rainy-to-dry season transition; retrain monthly.
- Add iv1 weather features (expected to help most with storm build-up and humidity changes).
- Live feed: Gantner RAS API (needs channel mapping + API key), Modbus TCP, or SFTP upload.
