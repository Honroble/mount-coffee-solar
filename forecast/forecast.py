"""Produce a 15/30/60-minute forecast from the latest logger data.

Usage:
    python forecast.py --model mcsolar_model.joblib --iv2 recent_iv2*.csv [--iv1 recent_iv1*.csv] [--sat sat.csv] [--at "2026-11-13 11:00"]

Needs at least the last ~2 hours of 1-minute data. The live job (live/live_forecast.py)
calls make_forecast() every 15 minutes.
"""
import argparse
import glob
import json
import pandas as pd
from mcsolar.data import clean_plant, read_many, AC_LIMIT_MW
from mcsolar.clearsky import solar, clear_sky_power
from mcsolar.weather import weather_frame
from mcsolar.satellite import read_satellite, satellite_15min
from mcsolar import features as F, model as M


def _expand(paths):
    out = []
    for p in paths or []:
        out += glob.glob(p) or ([p] if not any(ch in p for ch in "*?[") else [])
    return sorted(set(out))


def make_forecast(model_path, iv2, iv1=(), sat=None, at=None):
    """Return a dict with the forecast issued at the last complete 15-min block (UTC)."""
    bundle = M.load(model_path)
    meta, models = bundle["meta"], bundle["models"]
    raw = read_many(_expand(iv2))
    if at:
        raw = raw[raw.index <= pd.Timestamp(at, tz="UTC")]
    pl = clean_plant(raw)
    # extend 75 min into the future so clear-sky / sun position exist for the targets
    fut = pd.date_range(pl.index.max() + pd.Timedelta("1min"), periods=75, freq="1min")
    pl = pl.reindex(pl.index.append(fut))
    pl = pl.join(solar(pl.index))
    pl["Pcs"] = clear_sky_power(pl["ghi_cs"], meta["scale"])
    iv1 = _expand(iv1)
    w = weather_frame(read_many(iv1)) if (iv1 and meta.get("uses_weather")) else None
    if meta.get("uses_weather") and w is None:
        raise SystemExit("This model needs --iv1 (it was trained with weather-station data)")
    b = F.to_15min(pl, w)
    f, _, _ = F.build(b)
    if meta.get("uses_satellite"):
        if not sat:
            raise SystemExit("This model needs --sat (it was trained with satellite data)")
        f = f.join(satellite_15min(read_satellite(sat), b["ghi_cs"], meta.get("sat_delay", 30)))
    complete = b.index[b["p_valid"] >= 0.9]
    if len(complete) == 0:
        raise SystemExit("No complete 15-minute block of plant data yet")
    t0 = complete[-1]
    out = {"issued_utc": t0.strftime("%Y-%m-%d %H:%M"), "P_now_MW": round(float(b.loc[t0, "P"]), 2),
           "inverters_online": int(round(float(b.loc[t0, "n_inv"]))) if pd.notna(b.loc[t0, "n_inv"]) else None}
    for h in F.HORIZONS:
        mdl, cols = models[h]
        x = f.loc[[t0]].reindex(columns=cols)
        pcs = b["Pcs"].shift(-h).loc[[t0]]
        if pcs.iloc[0] < 0.3:            # night / sun too low
            p = 0.0
        elif x["k"].isna().iloc[0]:      # no recent plant data -> no forecast
            p = float("nan")
        else:
            p = float(M.to_mw(mdl.predict(x), pcs).iloc[0])
        out[f"P_{h*15}min_MW"] = round(min(p, AC_LIMIT_MW + 0.3), 2)
        out[f"clear_sky_{h*15}min_MW"] = round(float(pcs.iloc[0]), 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--iv2", nargs="+", required=True)
    ap.add_argument("--iv1", nargs="*", default=[])
    ap.add_argument("--sat", help="recent satellite CSV (needed if the model was trained with --sat)")
    ap.add_argument("--at", help="issue time (UTC); default = latest complete 15-min block")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    out = make_forecast(a.model, a.iv2, a.iv1, a.sat, a.at)
    print(json.dumps(out) if a.json else pd.Series(out).to_string())


if __name__ == "__main__":
    main()
