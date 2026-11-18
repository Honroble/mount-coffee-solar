"""Hour-by-hour calibration of the weather-model forecast against the logger (run monthly and at install).

J. A. Harris's factors (NEW = P_AC * max(0.3, 0.790 - 0.182*AOD)) were fitted on daily energy only. This script
fits, for each hour of the day, how much of the models' panel-plane power the plant really delivers:

    ratio = actual MW in the hour / P_AC(mean of the models' irradiance and temperature)
    ratio ~ a[hour] - b * AOD                     (least squares, outage days left out)

and the 10 % / 90 % spread of actual / forecast per hour, used as the likely range. It checks the result on
data it was not fitted on (first half vs second half of the period, both ways) and only switches the live
forecast over if the calibrated forecast is better there.

Inputs: past forecasts from Open-Meteo's historical-forecast API (same models as nwp_forecast.py), past AOD from the air-quality
API, and the plant's 1-minute output from the logger exports in ../data and the live files in data/live.
Output: <live_dir>/nwp_calibration.json
"""
import argparse
import csv
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nwp_forecast import LAT, LON, TILT, AZIMUTH, MODELS, NEW_A, NEW_B, LIMIT_KW, get_json, load_config, p_ac_kw  # noqa: E402

SENT = {655.35, 6553.5, 65535}
OUTAGE_DAYS = {"2026-09-25", "2026-11-02", "2026-11-03", "2026-11-04"}


def hourly_actuals(paths):
    """Mean plant MW per hour ending at HH:00 UTC, from logger CSVs (';', dd.mm.YYYY, 1-minute)."""
    acc = {}
    for path in paths:
        with open(path, encoding="latin-1", newline="") as fh:
            rd = csv.reader(fh, delimiter=";")
            head = next(rd, [])
            if "Information.Inverter sum P" not in head:
                continue
            k = head.index("Information.Inverter sum P")
            for r in rd:
                if not r or r[0].startswith("[") or len(r) <= k:
                    continue
                try:
                    v = float(r[k].replace(",", "."))
                    t = datetime.strptime(r[0] + " " + r[1], "%d.%m.%Y %H:%M:%S")
                except ValueError:
                    continue
                if v in SENT or v < -0.1 or v > 20:
                    continue
                end = (t - timedelta(seconds=1)).replace(minute=0, second=0) + timedelta(hours=1)
                a = acc.setdefault(end, [0.0, 0])
                a[0] += max(v, 0)
                a[1] += 1
    return {t: s / n for t, (s, n) in acc.items() if n >= 45}


def fetch_history(start, end):
    base = {"latitude": LAT, "longitude": LON, "tilt": TILT, "azimuth": AZIMUTH, "timezone": "GMT",
            "start_date": start, "end_date": end}
    m = get_json("https://historical-forecast-api.open-meteo.com/v1/forecast",
                 {**base, "hourly": "global_tilted_irradiance,temperature_2m", "models": ",".join(MODELS)})
    a = get_json("https://air-quality-api.open-meteo.com/v1/air-quality",
                 {"latitude": LAT, "longitude": LON, "hourly": "aerosol_optical_depth", "timezone": "GMT",
                  "start_date": start, "end_date": end})
    aod = {datetime.strptime(t, "%Y-%m-%dT%H:%M"): v for t, v in zip(a["hourly"]["time"], a["hourly"]["aerosol_optical_depth"])}
    H = m["hourly"]
    out = {}
    for i, ts in enumerate(H["time"]):
        t = datetime.strptime(ts, "%Y-%m-%dT%H:%M")
        p = [p_ac_kw((H.get(f"global_tilted_irradiance_{x}") or [None] * len(H["time"]))[i],
                     (H.get(f"temperature_2m_{x}") or [None] * len(H["time"]))[i]) for x in MODELS]
        p = [v for v in p if v is not None]
        if p:
            out[t] = (sum(p) / len(p) / 1000, aod.get(t))
    return out


def fit(rows):
    """rows: (hour, pac_mw, aod, actual_mw). Returns a[hour], b, q10[hour], q90[hour]."""
    hours = sorted({r[0] for r in rows})
    X = np.zeros((len(rows), len(hours) + 1))
    y = np.zeros(len(rows))
    w = np.zeros(len(rows))
    for i, (h, pac, aod, act) in enumerate(rows):
        X[i, hours.index(h)] = 1.0
        X[i, -1] = -(aod if aod is not None else 0.3)
        y[i] = act / pac
        w[i] = pac                       # weigh hours by how much power is at stake
    sw = np.sqrt(w)
    coef, *_ = np.linalg.lstsq(X * sw[:, None], y * sw, rcond=None)
    a = {h: float(np.clip(coef[j], 0.2, 1.1)) for j, h in enumerate(hours)}
    b = float(np.clip(coef[-1], 0.0, 0.6))
    q10, q90 = {}, {}
    for h in hours:
        r = [act / max(0.05, min(pac * (a[h] - b * (aod if aod is not None else 0.3)), LIMIT_KW / 1000))
             for (hh, pac, aod, act) in rows if hh == h]
        q10[h] = float(np.clip(np.percentile(r, 10), 0.2, 1.0)) if len(r) >= 8 else 0.65
        q90[h] = float(np.clip(np.percentile(r, 90), 1.0, 2.5)) if len(r) >= 8 else 1.37
    return a, b, q10, q90


def predict(model, h, pac, aod):
    a, b = model[0], model[1]
    k = a.get(h)
    if k is None:
        return min(pac * max(0.3, NEW_A - NEW_B * (aod if aod is not None else 0.3)), LIMIT_KW / 1000)
    return min(pac * max(0.2, k - b * (aod if aod is not None else 0.3)), LIMIT_KW / 1000)


def harris(pac, aod):
    return min(pac * max(0.3, NEW_A - NEW_B * (aod if aod is not None else 0.3)), LIMIT_KW / 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    data_dir = os.path.abspath(os.path.join(live, ".."))
    paths = sorted(glob.glob(os.path.join(data_dir, "iv2_2026*.csv"))) + sorted(glob.glob(os.path.join(live, "iv2_live_*.csv")))
    paths = [p for p in paths if "_1.csv" not in p and "(1)" not in p]
    act = hourly_actuals(paths)
    if not act:
        print("no logger data found"); sys.exit(1)
    first, last = min(act).date(), (datetime.now(timezone.utc) - timedelta(days=1)).date()
    fc = fetch_history(first.isoformat(), last.isoformat())

    rows = []
    for t, mw in act.items():
        if t.strftime("%Y-%m-%d") in OUTAGE_DAYS or t not in fc:
            continue
        pac, aod = fc[t]
        if pac < 0.5:
            continue
        rows.append((t.hour, pac, aod, mw, t))
    rows.sort(key=lambda r: r[4])
    if len(rows) < 200:
        print(f"only {len(rows)} usable hours - keeping the current factors"); sys.exit(0)

    # out-of-sample check: fit on one half, score on the other, both ways
    half = len(rows) // 2
    err_cal, err_old = [], []
    for train, test in ((rows[:half], rows[half:]), (rows[half:], rows[:half])):
        m = fit([r[:4] for r in train])
        for h, pac, aod, mw, _ in test:
            err_cal.append(abs(predict(m, h, pac, aod) - mw))
            err_old.append(abs(harris(pac, aod) - mw))
    mae_cal, mae_old = float(np.mean(err_cal)), float(np.mean(err_old))
    a_h, b, q10, q90 = fit([r[:4] for r in rows])
    out = {
        "fitted_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "period": [rows[0][4].strftime("%Y-%m-%d"), rows[-1][4].strftime("%Y-%m-%d")], "hours_used": len(rows),
        "a_by_hour_end": {str(h): round(v, 4) for h, v in a_h.items()}, "b_aod": round(b, 4),
        "q10_by_hour_end": {str(h): round(v, 3) for h, v in q10.items()},
        "q90_by_hour_end": {str(h): round(v, 3) for h, v in q90.items()},
        "out_of_sample_mae_mw": {"calibrated": round(mae_cal, 3), "harris_daily_factors": round(mae_old, 3)},
        "use": bool(mae_cal < mae_old),
    }
    with open(os.path.join(live, "nwp_calibration.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    msg = (f"{len(rows)} hours, out-of-sample MAE {mae_cal:.2f} MW calibrated vs {mae_old:.2f} MW daily factors -> "
           f"{'using calibrated' if out['use'] else 'keeping daily factors'}")
    with open(os.path.join(live, "nwp_runs.txt"), "a", encoding="utf-8") as fh:
        fh.write(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC  calibration: {msg}\n")
    print(msg)


if __name__ == "__main__":
    main()
