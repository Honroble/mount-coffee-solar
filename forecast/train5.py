"""Train the v2 / v2.1 forecast models (15/30/60 minutes ahead).

Usage:
    python train5.py --iv2 iv2_*.csv --iv1 iv1_*.csv --sat satellite.csv [--compare-old] [--out mcsolar_model_v2.joblib]
    v2.1 (issued every minute, fast baseline, cleaner training data, measured satellite delay):
    python train5.py --version 2.1 --iv2 ... --iv1 ... --sat satellite.csv --kpi live/kpi_daily.json --trips live/trips.csv
                     [--ewma-min 2] [--sat-delay 20] [--sat-max-age 30] [--no-sat] [--until 2026-11-16] --out mcsolar_model_v21.joblib
    --no-sat trains the v2.1 fallback used when the satellite data is older than the limit.

Prints a blocked cross-validation report (2-week folds, a day of gap either side) and saves models trained
on all data. With --compare-old it also scores the 15-minute (v1) satellite model on the same points.
"""
import argparse
import glob
import json
import warnings
import numpy as np
import pandas as pd
from mcsolar.data import read_many, clean_plant, mark_bad_days
from mcsolar.clearsky import solar, fit_scale, clear_sky_power
from mcsolar.weather import weather_frame
from mcsolar.satellite import read_satellite, satellite_15min
from mcsolar import features as F, features5 as F5, model as M, exclude as X

warnings.filterwarnings("ignore")


def xy(f, targets, valid, h):
    t = targets[h]
    ok = valid & t["valid_future"] & t["Pcs_future"].gt(0.3) & t["P_future"].notna() & f["k"].notna()
    cols = [c for c in f.columns if not ((c.startswith("Pcs_f") or c.startswith("elev_f")) and not c.endswith(f"f{h}"))]
    y = (t.loc[ok, "P_future"] / t.loc[ok, "Pcs_future"].clip(lower=0.3)).clip(0, 1.3)
    return f.loc[ok, cols], y, t.loc[ok]


def blocked_cv(f, targets, valid, xyfn, horizons, fold_days=14):
    start, end = f.index.min().floor("D"), f.index.max().ceil("D")
    edges = list(pd.date_range(start, end, freq=f"{fold_days}D")) + [end]
    out = {}
    for h in horizons:
        X, y, tt = xyfn(f, targets, valid, h)
        P, T = [], []
        for a, z in zip(edges[:-1], edges[1:]):
            te = (X.index >= a) & (X.index < z)
            tr = (X.index < a - pd.Timedelta("1D")) | (X.index >= z + pd.Timedelta("1D"))
            if te.sum() < 20 or tr.sum() < 200:
                continue
            mdl = M.make_model().fit(X[tr], y[tr])
            P.append(pd.Series(M.to_mw(mdl.predict(X[te]), tt.loc[te, "Pcs_future"]), index=X.index[te]))
            T.append(tt.loc[te, "P_future"])
        out[h] = pd.DataFrame({"pred": pd.concat(P), "truth": pd.concat(T)})
    return out


def _features_like(meta, d, step="1min"):
    """Features on the training data built the way a saved model expects them."""
    sat = d["sat"] if meta.get("uses_satellite") else None
    if meta.get("fast"):
        f, _, _, _ = F5.build(d["m"], step, sat, meta.get("sat_delay", 20), with_targets=False, fast=True,
                              ewma_min=meta.get("ewma_min", 2.0), baseline=meta.get("baseline", "ewma"),
                              sat_max_age=meta.get("sat_max_age"))
    else:
        f, _, _, _ = F5.build(d["m"], step, sat, meta.get("sat_delay", 30), with_targets=False)
    return f


def holdout_check(f, t, v, d, a, v21):
    """Train a candidate on all but the last N days; MAE (MW) of candidate and old model on the same hold-out rows."""
    cut = f.index.max().floor("D") - pd.Timedelta(days=a.holdout_days - 1)
    old = M.load(a.old) if a.old and __import__("os").path.exists(a.old) else None
    fo = _features_like(old["meta"], d, "1min" if v21 else "5min") if old else None
    out = {"holdout_from": str(cut.date()), "horizons": {}}
    for h in F5.HORIZONS_MIN:
        X, y, tt = xy(f, t, v, h)
        tr, te = X.index < cut - pd.Timedelta("1D"), X.index >= cut
        if te.sum() < 50 or tr.sum() < 500:
            out["horizons"][str(h)] = {"n": int(te.sum()), "note": "too few rows"}
            continue
        cand = M.make_model().fit(X[tr], y[tr])
        truth, pcs = tt.loc[te, "P_future"], tt.loc[te, "Pcs_future"]
        r = {"n": int(te.sum()), "new_mae": float((M.to_mw(cand.predict(X[te]), pcs) - truth).abs().mean())}
        if old is not None:
            mdl, cols = old["models"][h]
            xo = fo.reindex(X.index[te]).reindex(columns=cols)
            po = pd.Series(M.to_mw(mdl.predict(xo), pcs), index=truth.index)
            r["old_mae"] = float((po - truth).abs().mean())
        out["horizons"][str(h)] = r
    hz = out["horizons"]
    out["new_wins"] = old is None or all(("old_mae" in hz.get(k, {})) and hz[k]["new_mae"] <= hz[k]["old_mae"]
                                         for k in ("15", "30"))
    return out


def thin(f, t, v, every):
    keep = f.index[(f.index.minute % every) == 0]
    return f.loc[keep], {h: x.loc[keep] for h, x in t.items()}, v.loc[keep]


def prepare(iv2, iv1, sat_path=None, until=None, v21=False, kpi=None, trips=None, ctrl=()):
    """Read and clean the logger exports once; shared by training and the replay test."""
    raw = read_many(iv2)
    raw1 = read_many(iv1) if iv1 else None
    if until:
        u = pd.Timestamp(until, tz="UTC")
        raw = raw[raw.index < u]
        raw1 = raw1[raw1.index < u] if raw1 is not None else None
    pl = clean_plant(raw).join(solar(raw.index))
    scale = fit_scale(pl["P"], pl["ghi_cs"], pl["elev"])
    pl["Pcs"] = clear_sky_power(pl["ghi_cs"], scale)
    w = weather_frame(raw1) if raw1 is not None else None
    sat = read_satellite(sat_path) if sat_path else None
    bad = mark_bad_days(pl, pl["Pcs"])
    m = F5.minute_frame(pl, w)
    out = {"pl": pl, "scale": scale, "w": w, "sat": sat, "bad": bad, "m": m, "raw": raw, "raw1": raw1}
    if v21:
        lim = None
        if ctrl:
            c = read_many(sorted(sum((glob.glob(p) for p in ctrl), [])))
            if "Setpoint.PowerLimit_User" in c:
                lim = pd.to_numeric(c["Setpoint.PowerLimit_User"], errors="coerce").reindex(raw.index, method="nearest",
                                                                                          tolerance=pd.Timedelta("2min"))
                if "Setpoint.PowerLimit_User" in raw:
                    lim = pd.to_numeric(raw["Setpoint.PowerLimit_User"], errors="coerce").fillna(lim)
        flags = X.minute_flags(raw, raw1, lim)
        k = X.load_kpi(kpi)
        out["excluded"] = X.excluded_days(flags, k)
        out["bad_minutes"] = X.bad_minutes(m.index, flags, k, trips)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iv2", nargs="+", required=True)
    ap.add_argument("--iv1", nargs="+", required=True)
    ap.add_argument("--sat")
    ap.add_argument("--sat-delay", type=int, default=None, help="minutes after its time stamp a satellite value is usable "
                    "(v2: 30; v2.1: 20, measured on the live feed)")
    ap.add_argument("--version", default="2", choices=["2", "2.1"])
    ap.add_argument("--ewma-min", type=float, default=2.0)
    ap.add_argument("--baseline", default="ewma", choices=["ewma", "mean1"])
    ap.add_argument("--sat-max-age", type=float, default=30.0)
    ap.add_argument("--no-sat", action="store_true")
    ap.add_argument("--kpi", help="kpi_daily.json (Verification day rules)")
    ap.add_argument("--trips", help="trips.csv")
    ap.add_argument("--ctrl", nargs="*", default=[], help="ctrl_live_*.csv (PowerLimit_User for live days)")
    ap.add_argument("--until", help="train only on data before this UTC date (replay tests)")
    ap.add_argument("--no-cv", action="store_true")
    ap.add_argument("--holdout-days", type=int, default=0,
                    help="also train on all but the last N days and score that candidate and --old on those days")
    ap.add_argument("--old", help="current model file to compare against (with --holdout-days)")
    ap.add_argument("--compare-old", action="store_true")
    ap.add_argument("--out", default="mcsolar_model_v2.joblib")
    a = ap.parse_args()
    v21 = a.version == "2.1"
    if a.sat_delay is None:
        a.sat_delay = 20 if v21 else 30
    if not a.sat and not (v21 and a.no_sat):
        ap.error("--sat is required (or --version 2.1 --no-sat)")
    iv2 = sorted(sum((glob.glob(p) for p in a.iv2), []))
    iv1 = sorted(sum((glob.glob(p) for p in a.iv1), []))
    d = prepare(iv2, iv1, None if a.no_sat else a.sat, a.until, v21, a.kpi, a.trips, a.ctrl)
    pl, scale, bad = d["pl"], d["scale"], d["bad"]
    w, sat, m = d["w"], d["sat"], d["m"]
    if v21:
        f, t, v, _ = F5.build(m, "1min", sat, a.sat_delay, bad, fast=True, ewma_min=a.ewma_min, baseline=a.baseline,
                              sat_max_age=a.sat_max_age, bad_minutes=d["bad_minutes"])
        f, t, v = thin(f, t, v, 2)       # every 2nd minute: same information, half the memory and time
    else:
        f, t, v, _ = F5.build(m, "5min", sat, a.sat_delay, bad)
    print(f"Data {f.index.min()} -> {f.index.max()}, clear-sky scale {scale:.5f} MW per W/m2")
    print("Excluded days (outage/no data):", [d.date().isoformat() for d in bad])
    if v21:
        print("Excluded days (Verification rules):", d["excluded"])
        print(f"Minutes left out inside kept days (outage, curtailment, trips): {int(d['bad_minutes'].sum())}")
    if a.no_cv:
        res, rows = None, []
    else:
        res = blocked_cv(f, t, v, xy, F5.HORIZONS_MIN)
    rows = []
    old = None
    if a.compare_old and res is not None:
        b = F.to_15min(pl, w)
        fo, to, vo = F.build(b, bad)
        fo = fo.join(satellite_15min(sat, b["ghi_cs"], a.sat_delay))
        old = blocked_cv(fo, to, vo, M._xy, F.HORIZONS)
    for h in (F5.HORIZONS_MIN if res is not None else ()):
        e = res[h].pred - res[h].truth
        r = {"horizon_min": h, "model_MAE_MW": round(float(e.abs().mean()), 3),
             "model_RMSE_MW": round(float(np.sqrt((e ** 2).mean())), 3), "n": len(e)}
        if old is not None:
            o = old[h // 15]
            common = o.index.intersection(res[h].index)
            r["same_points_new_MAE"] = round(float(e.loc[common].abs().mean()), 3)
            r["same_points_old_MAE"] = round(float((o.pred - o.truth).loc[common].abs().mean()), 3)
        rows.append(r)
    if rows:
        print("\nBlocked cross-validation (2-week folds):")
        print(pd.DataFrame(rows).to_string(index=False))
    if a.holdout_days:
        check = holdout_check(f, t, v, d, a, v21)
        with open(a.out + ".check.json", "w", encoding="utf-8") as fh:
            json.dump(check, fh, indent=1)
        print("\nHold-out check (last", a.holdout_days, "days):", json.dumps(check))
    models = {}
    for h in F5.HORIZONS_MIN:
        X, y, _ = xy(f, t, v, h)
        models[h] = (M.make_model().fit(X, y), list(X.columns))
    meta = {"version": 2, "step": "5min", "scale": scale, "uses_weather": True, "uses_satellite": True,
            "sat_delay": a.sat_delay, "cv": rows, "trained_until": str(f.index.max())}
    if v21:
        meta.update({"version": "2.1", "step": "1min", "fast": True, "ewma_min": a.ewma_min, "baseline": a.baseline,
                     "uses_satellite": not a.no_sat, "sat_max_age": a.sat_max_age,
                     "training_exclusions": "Verification day rules + outage/curtailed/trip minutes"})
    M.save(models, meta, a.out)
    print(f"\nSaved models to {a.out}")


if __name__ == "__main__":
    main()
