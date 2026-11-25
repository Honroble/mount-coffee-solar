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
from mcsolar import features as F, model as M, features5 as F5


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


def _fill_from_live(pl, now_csvs, upto=None):
    """Fill the newest minutes of plant data from live_poller.py readings (10-second logger gauges).

    The logger's data files reach the portal 1-5 minutes late; the gauges are live. One-minute means of
    the 10-second PV sum match 'Information.Inverter sum P' (checked: mean difference 0.001 MW).
    """
    frames = []
    for path in now_csvs or []:
        try:
            n = pd.read_csv(path)
        except Exception:
            continue
        if len(n):
            n.index = pd.to_datetime(n["time_utc"], utc=True)
            frames.append(n)
    if not frames:
        return pl, 0
    n = pd.concat(frames).sort_index()
    if upto is not None:
        n = n[n.index <= upto]
    g = n.resample("1min", label="right", closed="right")
    live = pd.DataFrame({"P": g["pv_sum_mw"].mean()})
    for i in (1, 2, 3, 4):
        if f"sts{i}_kw" in n:
            live[f"P_STS{i}"] = g[f"sts{i}_kw"].mean() / 1000.0
    live = live.dropna(subset=["P"])
    last = pl["P"].last_valid_index()
    live = live[live.index > last] if last is not None else live
    if live.empty:
        return pl, 0
    add = live.reindex(columns=pl.columns)
    for c in pl.columns:
        if c not in live.columns:          # counts, spread, grid flag, capacities: carry the last logger value
            add[c] = pl[c].ffill().iloc[-1]
    return pd.concat([pl, add]).sort_index(), len(live)


class SatelliteTooOld(Exception):
    """v2.1: the newest satellite value is older than the limit; use the no-satellite v2.1 model."""
    def __init__(self, age):
        super().__init__(f"satellite data too old ({age} min)" if age is not None else "no satellite data")
        self.age = age


def make_forecast_v2(model_path, iv2, iv1=(), sat=None, at=None, now_csvs=(), issue_every_min=5, opts=None):
    """v2 models: issued at the latest `issue_every_min` mark with plant data.

    issue_every_min=5 is the original behaviour (the newest 0-4 minutes are not used); 1 issues at the latest minute,
    so a forecast reflects data up to about a minute old. The features are the same rolling windows either way.
    """
    bundle = M.load(model_path)
    meta, models = bundle["meta"], bundle["models"]
    opts = opts or {}
    fast = bool(meta.get("fast"))                 # v2.1
    sat_delay = meta.get("sat_delay", 30)
    max_age = float(opts.get("sat_max_age", meta.get("sat_max_age", 20))) if fast else None
    raw = read_many(_expand(iv2))
    cut = pd.Timestamp(at, tz="UTC") if at else None
    if cut is not None:
        raw = raw[raw.index <= cut]
    pl = clean_plant(raw)
    pl, n_live = _fill_from_live(pl, now_csvs, cut)
    last = pl["P"].last_valid_index()
    step = max(1, int(issue_every_min))
    t0 = last.floor(f"{step}min")
    fut = pd.date_range(pl.index.max() + pd.Timedelta("1min"), t0 + pd.Timedelta("75min"), freq="1min")
    pl = pl.reindex(pl.index.append(fut))
    pl = pl.join(solar(pl.index))
    pl["Pcs"] = clear_sky_power(pl["ghi_cs"], meta["scale"])
    w = weather_frame(read_many(_expand(iv1))) if (iv1 and meta.get("uses_weather")) else None
    if w is not None and cut is not None:
        w = w[w.index <= cut]
    m = F5.minute_frame(pl, w)
    s = read_satellite(sat) if (sat and meta.get("uses_satellite")) else None
    if s is not None and cut is not None:
        s = s[s.index <= cut - pd.Timedelta(minutes=sat_delay)]
    if fast:
        f, _, valid, P15 = F5.build(m, f"{step}min", s, sat_delay, with_targets=False, fast=True,
                                    ewma_min=float(opts.get("ewma_min", meta.get("ewma_min", 2.0))),
                                    baseline=opts.get("baseline", meta.get("baseline", "ewma")), sat_max_age=max_age)
    else:
        f, _, valid, P15 = F5.build(m, f"{step}min", s, sat_delay, with_targets=False)
    if t0 not in f.index or pd.isna(f.loc[t0, "k"]) or f.loc[t0, "P_valid15"] < 0.8:
        raise SystemExit("Not enough plant data in the last 15 minutes")
    sat_age = None
    if s is not None and len(s.dropna(how="all")):
        sat_age = round((t0 - s.dropna(how="all").index.max()).total_seconds() / 60, 1)
    if fast and meta.get("uses_satellite") and (sat_age is None or sat_age > max_age or pd.isna(f.loc[t0].get("sat_kt_C"))):
        raise SatelliteTooOld(sat_age)
    out = {"issued_utc": t0.strftime("%Y-%m-%d %H:%M"), "P_now_MW": round(float(P15.loc[t0]), 2),
           "inverters_online": int(round(float(m.loc[t0, "n_inv_online"]))) if pd.notna(m.loc[t0, "n_inv_online"]) else None,
           "live_minutes_used": n_live, "sat_age_min": sat_age, "model_version": str(meta.get("version", 2))}
    for h in F5.HORIZONS_MIN:
        mdl, cols = models[h]
        x = f.loc[[t0]].reindex(columns=cols)
        pcs = float(f.loc[t0, f"Pcs_f{h}"])
        if not pcs or pcs < 0.3 or pd.isna(pcs):
            p = 0.0
        else:
            p = float(M.to_mw(mdl.predict(x), pd.Series([pcs])).iloc[0])
        out[f"P_{h}min_MW"] = round(min(p, AC_LIMIT_MW + 0.3), 2)
        out[f"clear_sky_{h}min_MW"] = round(pcs if pd.notna(pcs) else 0.0, 2)
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
