"""Train the v2 forecast models (issued every 5 minutes; 15/30/60 minutes ahead).

Usage:
    python train5.py --iv2 iv2_*.csv --iv1 iv1_*.csv --sat satellite.csv [--compare-old] [--out mcsolar_model_v2.joblib]

Prints a blocked cross-validation report (2-week folds, a day of gap either side) and saves models trained
on all data. With --compare-old it also scores the 15-minute (v1) satellite model on the same points.
"""
import argparse
import glob
import warnings
import numpy as np
import pandas as pd
from mcsolar.data import read_many, clean_plant, mark_bad_days
from mcsolar.clearsky import solar, fit_scale, clear_sky_power
from mcsolar.weather import weather_frame
from mcsolar.satellite import read_satellite, satellite_15min
from mcsolar import features as F, features5 as F5, model as M

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iv2", nargs="+", required=True)
    ap.add_argument("--iv1", nargs="+", required=True)
    ap.add_argument("--sat", required=True)
    ap.add_argument("--sat-delay", type=int, default=30)
    ap.add_argument("--compare-old", action="store_true")
    ap.add_argument("--out", default="mcsolar_model_v2.joblib")
    a = ap.parse_args()
    iv2 = sorted(sum((glob.glob(p) for p in a.iv2), []))
    iv1 = sorted(sum((glob.glob(p) for p in a.iv1), []))
    raw = read_many(iv2)
    pl = clean_plant(raw).join(solar(raw.index))
    scale = fit_scale(pl["P"], pl["ghi_cs"], pl["elev"])
    pl["Pcs"] = clear_sky_power(pl["ghi_cs"], scale)
    w = weather_frame(read_many(iv1))
    sat = read_satellite(a.sat)
    bad = mark_bad_days(pl, pl["Pcs"])
    m = F5.minute_frame(pl, w)
    f, t, v, _ = F5.build(m, "5min", sat, a.sat_delay, bad)
    print(f"Data {f.index.min()} -> {f.index.max()}, clear-sky scale {scale:.5f} MW per W/m2")
    print("Excluded days (outage/no data):", [d.date().isoformat() for d in bad])
    res = blocked_cv(f, t, v, xy, F5.HORIZONS_MIN)
    rows = []
    old = None
    if a.compare_old:
        b = F.to_15min(pl, w)
        fo, to, vo = F.build(b, bad)
        fo = fo.join(satellite_15min(sat, b["ghi_cs"], a.sat_delay))
        old = blocked_cv(fo, to, vo, M._xy, F.HORIZONS)
    for h in F5.HORIZONS_MIN:
        e = res[h].pred - res[h].truth
        r = {"horizon_min": h, "model_MAE_MW": round(float(e.abs().mean()), 3),
             "model_RMSE_MW": round(float(np.sqrt((e ** 2).mean())), 3), "n": len(e)}
        if old is not None:
            o = old[h // 15]
            common = o.index.intersection(res[h].index)
            r["same_points_new_MAE"] = round(float(e.loc[common].abs().mean()), 3)
            r["same_points_old_MAE"] = round(float((o.pred - o.truth).loc[common].abs().mean()), 3)
        rows.append(r)
    print("\nBlocked cross-validation (2-week folds):")
    print(pd.DataFrame(rows).to_string(index=False))
    models = {}
    for h in F5.HORIZONS_MIN:
        X, y, _ = xy(f, t, v, h)
        models[h] = (M.make_model().fit(X, y), list(X.columns))
    M.save(models, {"version": 2, "step": "5min", "scale": scale, "uses_weather": True, "uses_satellite": True,
                    "sat_delay": a.sat_delay, "cv": rows, "trained_until": str(f.index.max())}, a.out)
    print(f"\nSaved models to {a.out}")


if __name__ == "__main__":
    main()
