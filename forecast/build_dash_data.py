"""Builds the dashboard's data files from the Gantner exports (iv2 plant, iv1 weather).

Forecasts shown are out-of-sample: each 2-week block is predicted by a model trained
on the other blocks (blocked cross-validation), so no day is forecast by a model that saw it.
"""
import json, sys, os
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import prepare
from mcsolar.data import mark_bad_days, read_gantner_csv
from mcsolar import features as F, model as M
from mcsolar.satellite import read_satellite, satellite_15min

IV2 = "/mnt/user-data/uploads/iv2_20260917_000000_20261114_000000.csv"
IV1 = "/mnt/user-data/uploads/e234cc37-iv1_20260917_000000_20261114_000000.csv"
SAT = "/mnt/user-data/uploads/9920972a-mount_coffee_satellite_ghi.csv"
SAT_DELAY = 30  # minutes: satellite data is only used once it would have arrived live
OUT = "/home/claude/work/dash"
os.makedirs(OUT, exist_ok=True)
CODE = open(os.path.abspath(__file__)).read()


def dump(name, rows, inputs):
    meta = [{"label": "build_dash_data.py", "value": CODE, "type": "code", "lang": "python"},
            {"label": "Input", "value": inputs}]
    json.dump({"rows": rows, "meta": meta}, open(f"{OUT}/{name}.json", "w"), allow_nan=False)


def clean(v, nd=2):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), nd)


pl, b, scale = prepare([IV2], [IV1])
bad = mark_bad_days(pl, pl["Pcs"])
f, t, v = F.build(b, bad)
f_w = f.copy()  # plant + weather only, for the accuracy comparison
f = f.join(satellite_15min(read_satellite(SAT), b["ghi_cs"], SAT_DELAY))

# ---- out-of-sample forecasts (blocked CV, 2-week folds) for 15 and 60 min
start, end = f.index.min().floor("D"), f.index.max().ceil("D")
edges = list(pd.date_range(start, end, freq="14D")) + [end]
fc = {}
for h in (1, 4):
    X, y, tt = M._xy(f, t, v, h)
    parts = []
    for a, z in zip(edges[:-1], edges[1:]):
        te = (X.index >= a) & (X.index < z)
        tr = (X.index < a - pd.Timedelta("1D")) | (X.index >= z + pd.Timedelta("1D"))
        if te.sum() < 20:
            continue
        m = M.make_model().fit(X[tr], y[tr])
        p = pd.Series(M.to_mw(m.predict(X[te]), tt.loc[te, "Pcs_future"]), index=X.index[te])
        parts.append(p)
    p = pd.concat(parts)
    p.index = p.index + pd.Timedelta(minutes=15 * h)  # stamp at the time being forecast
    fc[h] = p

# ---- 15-minute day replay (daylight only)
d15 = pd.DataFrame({"actual_mw": b["P"], "clearsky_mw": b["Pcs"],
                    "forecast15_mw": fc[1], "forecast60_mw": fc[4],
                    "persistence15_mw": b["P"].shift(1)})
d15 = d15[(b["elev"] > 0) | (d15["actual_mw"] > 0.05)]
rows = []
for ts, r in d15.iterrows():
    rows.append({"time": ts.strftime("%Y-%m-%dT%H:%M:%SZ"), "date": ts.strftime("%Y-%m-%d"),
                 **{k: clean(r[k]) for k in d15.columns}})
dump("replay15", rows, "iv2 + iv1 exports + Open-Meteo satellite GHI (30 min delay), 17 Sep - 13 Nov 2026")

# ---- daily energy
day = pl["P"].fillna(0).groupby(pl.index.floor("D")).sum() / 60
cs = pl["Pcs"].groupby(pl.index.floor("D")).sum() / 60
pk = pl["P"].groupby(pl.index.floor("D")).max()
rows = [{"date": d.strftime("%Y-%m-%d"), "energy_mwh": clean(day[d], 1), "clearsky_mwh": clean(cs[d], 1),
         "peak_mw": clean(pk[d]), "status": "Outage / missing data" if d in bad else "Normal"}
        for d in day.index]
dump("daily", rows, "iv2 export: Information.Inverter sum P, 1-minute")

# ---- accuracy by horizon (blocked CV)
from train import blocked_cv
cv_s = blocked_cv(f, t, v, b["P"])
cv_w = blocked_cv(f_w, t, v, b["P"])
pl0, b0, _ = prepare([IV2])
f0, t0, v0 = F.build(b0, mark_bad_days(pl0, pl0["Pcs"]))
cv_p = blocked_cv(f0, t0, v0, b0["P"])
rows = []
for (_, w), (_, p), (_, sa) in zip(cv_w.iterrows(), cv_p.iterrows(), cv_s.iterrows()):
    rows.append({"horizon": f"{int(w.horizon_min)} min", "horizon_min": int(w.horizon_min),
                 "persistence_mae_mw": clean(w.persistence_MAE_MW), "plant_only_mae_mw": clean(p.model_MAE_MW),
                 "with_weather_mae_mw": clean(w.model_MAE_MW), "with_satellite_mae_mw": clean(sa.model_MAE_MW),
                 "rmse_improvement_pct": clean(sa["skill_vs_persistence_%"], 1), "blocks": int(sa.n_blocks)})
dump("accuracy", rows, "iv2 + iv1 exports + satellite CSV; blocked cross-validation, 2-week folds")

# ---- inverter health (strong-sun minutes)
raw = read_gantner_csv(IV2)
P = raw["Information.Inverter sum P"]
sun = raw[(raw.index.hour >= 9) & (raw.index.hour < 15) & (P > 5)]
inv = [c for c in raw.columns if c.endswith("active_power_total")]
X = sun[inv].where(sun[inv] < 1000)
med = X.median(axis=1)
rows = []
for c in inv:
    name = c.replace(".active_power_total", "")
    a = sun[name + ".alarm_code"].fillna(0)
    nz = a[a != 0]
    rows.append({"inverter": name, "station": name.split(".")[0],
                 "relative_output_pct": clean(100 * (X[c] / med).median(), 1),
                 "dropout_pct": clean(100 * (X[c] < 5).mean(), 2),
                 "alarm_minutes": int((a != 0).sum()),
                 "main_alarm_code": int(nz.mode().iloc[0]) if len(nz) else None})
rows.sort(key=lambda r: (-r["dropout_pct"], -r["alarm_minutes"]))
dump("inverters", rows, "iv2 export: STSx.INVyy.active_power_total and alarm_code, 09:00-15:00, plant > 5 MW")

# ---- grid frequency per day
fq = pl["freq"].dropna()
g = fq.groupby(fq.index.floor("D"))
rows = [{"date": d.strftime("%Y-%m-%d"), "median_hz": clean(x.median(), 3), "min_hz": clean(x.min(), 2),
         "max_hz": clean(x.max(), 2), "in_band_pct": clean(100 * x.between(49.8, 50.2).mean(), 1)}
        for d, x in g if len(x) > 60]
dump("frequency", rows, "iv2 export: Active Power.Frequency, 1-minute (0 / 40 Hz = no reading, removed)")
print({n: len(json.load(open(f'{OUT}/{n}.json'))['rows']) for n in ['replay15', 'daily', 'accuracy', 'inverters', 'frequency']})
