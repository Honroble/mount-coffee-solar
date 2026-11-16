"""Train the Mount Coffee short-term forecast models.

Usage:
    python train.py --iv2 iv2_*.csv [--iv1 iv1_*.csv ...] [--out model.joblib]

Prints a blocked cross-validation report (2-week folds) and saves models trained on all data.
"""
import argparse
import glob
import numpy as np
import pandas as pd
from mcsolar.data import read_many, clean_plant, mark_bad_days
from mcsolar.clearsky import solar, fit_scale, clear_sky_power
from mcsolar.weather import weather_frame
from mcsolar.satellite import read_satellite, satellite_15min
from mcsolar import features as F, model as M


def prepare(iv2_paths, iv1_paths=(), scale=None):
    raw = read_many(iv2_paths)
    pl = clean_plant(raw)
    pl = pl.join(solar(pl.index))
    if scale is None:
        scale = fit_scale(pl["P"], pl["ghi_cs"], pl["elev"])
    pl["Pcs"] = clear_sky_power(pl["ghi_cs"], scale)
    w = weather_frame(read_many(iv1_paths)) if iv1_paths else None
    b = F.to_15min(pl, w)
    return pl, b, scale


def blocked_cv(f, t, v, P15, fold_days=14):
    start, end = f.index.min().floor("D"), f.index.max().ceil("D")
    edges = list(pd.date_range(start, end, freq=f"{fold_days}D")) + [end]
    rows = []
    for h in F.HORIZONS:
        X, y, tt = M._xy(f, t, v, h)
        P, T, S = [], [], []
        for a, z in zip(edges[:-1], edges[1:]):
            te = (X.index >= a) & (X.index < z)
            tr = (X.index < a - pd.Timedelta("1D")) | (X.index >= z + pd.Timedelta("1D"))
            if te.sum() < 20 or tr.sum() < 200:
                continue
            m = M.make_model().fit(X[tr], y[tr])
            P.append(pd.Series(M.to_mw(m.predict(X[te]), tt.loc[te, "Pcs_future"]), index=X.index[te]))
            T.append(tt.loc[te, "P_future"])
            S.append(P15.reindex(X.index[te]))
        P, T, S = (pd.concat(x) for x in (P, T, S))
        rmse = lambda p: float(np.sqrt(((p - T) ** 2).mean()))
        rows.append({"horizon_min": h * 15, "persistence_MAE_MW": (S - T).abs().mean(),
                     "model_MAE_MW": (P - T).abs().mean(), "persistence_RMSE_MW": rmse(S),
                     "model_RMSE_MW": rmse(P), "model_bias_MW": (P - T).mean(),
                     "skill_vs_persistence_%": 100 * (1 - rmse(P) / rmse(S)), "n_blocks": len(T)})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iv2", nargs="+", required=True)
    ap.add_argument("--iv1", nargs="*", default=[])
    ap.add_argument("--sat", help="satellite CSV (Open-Meteo archive, plant + 16 surrounding points)")
    ap.add_argument("--sat-delay", type=int, default=30, help="minutes before satellite data is usable live")
    ap.add_argument("--out", default="mcsolar_model.joblib")
    a = ap.parse_args()
    iv2 = sorted(sum((glob.glob(p) for p in a.iv2), []))
    iv1 = sorted(sum((glob.glob(p) for p in a.iv1), []))
    pl, b, scale = prepare(iv2, iv1)
    bad = mark_bad_days(pl, pl["Pcs"])
    f, t, v = F.build(b, bad)
    if a.sat:
        f = f.join(satellite_15min(read_satellite(a.sat), b["ghi_cs"], a.sat_delay))
    print(f"Data {b.index.min()} -> {b.index.max()}, clear-sky scale {scale:.5f} MW per W/m2")
    print("Excluded days (outage/no data):", [d.date().isoformat() for d in bad])
    print(f"Weather features: {'yes' if iv1 else 'no (plant data only)'}; satellite: {f'yes, {a.sat_delay} min delay' if a.sat else 'no'}")
    cv = blocked_cv(f, t, v, b["P"])
    print("\nBlocked cross-validation (2-week folds):")
    print(cv.round(2).to_string(index=False))
    models = M.fit_all(f, t, v)
    M.save(models, {"scale": scale, "uses_weather": bool(iv1), "uses_satellite": bool(a.sat), "sat_delay": a.sat_delay, "cv": cv.to_dict("records"),
                    "trained_until": str(b.index.max())}, a.out)
    print(f"\nSaved models to {a.out}")


if __name__ == "__main__":
    main()
