"""Replay test: v2 against v2.1 on the live days, scored the way the Verification tab scores (Step 3 of the brief).

Both models are trained only on data before --test-from, then forecast every minute of the test days from the live
logger files, exactly as the live forecast would have (features only use data up to the issue minute; satellite values
become usable `sat_delay` minutes after their time stamp).

    python replay_v21.py --train-iv2 ../data/iv2_2026091*.csv --train-iv1 ../data/iv1_2026091*.csv
                         --test-iv2 ../data/live/iv2_live_*.csv ../data/iv2_*_hist.csv --test-iv1 ...
                         --sat ../data/satellite_history.csv --live ../data/live --test-from 2026-11-16 --out replay
"""
import argparse
import glob
import json
import os
import warnings
import pandas as pd
from mcsolar import features5 as F5, model as M
from mcsolar.data import AC_LIMIT_MW
import train5 as T

warnings.filterwarnings("ignore")
H = F5.HORIZONS_MIN


def g(ps):
    return sorted(set(sum((glob.glob(p) for p in ps), [])))


def fit(f, t, v):
    models = {}
    for h in H:
        X, y, _ = T.xy(f, t, v, h)
        models[h] = (M.make_model().fit(X, y), list(X.columns))
    return models


def predict(models, f):
    out = {}
    for h in H:
        mdl, cols = models[h]
        pcs = f[f"Pcs_f{h}"]
        p = pd.Series(M.to_mw(mdl.predict(f.reindex(columns=cols)), pcs), index=f.index)
        out[h] = p.where(pcs >= 0.3, 0.0).clip(upper=AC_LIMIT_MW + 0.3)
    return out


def score(pred, P15, cs15, k15, keep_issue, label):
    rows = []
    for h in H:
        truth = P15.shift(freq=pd.Timedelta(minutes=-h)).reindex(pred[h].index)
        csf = cs15.shift(freq=pd.Timedelta(minutes=-h)).reindex(pred[h].index)
        ok = keep_issue & truth.notna() & (csf >= 1) & pred[h].notna() & P15.reindex(pred[h].index).notna()
        f, a = pred[h][ok], truth[ok]
        pers = P15.reindex(f.index)
        smart = (k15.reindex(f.index) * csf[ok]).clip(upper=AC_LIMIT_MW)
        mae = (f - a).abs().mean()
        rows.append({"model": label, "horizon_min": h, "n": int(ok.sum()), "MAE_MW": mae, "bias_MW": (f - a).mean(),
                     "skill_vs_repeat_last_%": 100 * (1 - mae / (pers - a).abs().mean()),
                     "skill_vs_smart_persistence_%": 100 * (1 - mae / (smart - a).abs().mean())})
    return rows


def reaction(pred, P1, t0, t1, min_drop=3.0):
    """Sharp drops between t0 and t1: 1-min power falls by >= min_drop MW within 10 minutes. Onset = first minute of the
    fall. For each forecast: the first issue minute from 10 min before the onset at which its 15-min forecast is at
    least half the drop below what it said just before (minutes after the onset; negative = it saw it coming)."""
    seg = P1[t0:t1].dropna()
    drops, last = [], None
    for t, p in seg.items():
        w = seg[t - pd.Timedelta(minutes=10): t]
        b = w.max()
        if b - p >= min_drop and (last is None or t - last > pd.Timedelta(minutes=30)):
            on = w.index[w.values.argmax()] + pd.Timedelta(minutes=1)
            drops.append((on, b, p))
            last = t
    out = []
    for on, b, p in drops:
        row = {"onset": on.strftime("%H:%M"), "from_MW": round(b, 1), "to_MW": round(p, 1)}
        for name, pr in pred.items():
            ref = pr.get(on - pd.Timedelta(minutes=11))
            s = pr[on - pd.Timedelta(minutes=10): on + pd.Timedelta(minutes=30)]
            hit = s[s <= ref - 0.5 * (b - p)] if ref is not None and pd.notna(ref) else s.iloc[:0]
            row[f"{name}_min_after_onset"] = int((hit.index[0] - on).total_seconds() // 60) if len(hit) else None
        out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-iv2", nargs="+", required=True)
    ap.add_argument("--train-iv1", nargs="+", required=True)
    ap.add_argument("--test-iv2", nargs="+", required=True)
    ap.add_argument("--test-iv1", nargs="+", required=True)
    ap.add_argument("--sat", required=True)
    ap.add_argument("--live", required=True, help="live folder (kpi_daily.json, trips.csv, verification_days.csv)")
    ap.add_argument("--test-from", default="2026-11-16")
    ap.add_argument("--ewma-min", type=float, default=2.0)
    ap.add_argument("--sat-max-age", type=float, nargs="+", default=[20.0, 30.0])
    ap.add_argument("--sharp-day", default="2026-11-20")
    ap.add_argument("--out", default="replay")
    ap.add_argument("--reaction-only", action="store_true", help="re-run only the sharp-drop test from saved predictions")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.reaction_only:
        p = pd.read_csv(os.path.join(a.out, "replay_predictions.csv"), header=[0, 1], index_col=0)
        p.index = pd.to_datetime(p.index)
        from mcsolar.data import read_many, clean_plant
        P1 = clean_plant(read_many(g(a.test_iv2)))["P"]
        for day in a.sharp_day.split(","):
            d0 = pd.Timestamp(day, tz="UTC")
            seen5 = p[("v2_every5", "15")].dropna().reindex(p.index, method="ffill", limit=4).shift(2)
            rx = reaction({"v2_every5": seen5, "v2_every1": p[("v2_every1", "15")], "v2.1": p[("v2.1_age20", "15")]},
                          P1, d0, d0 + pd.Timedelta("1D"))
            print(f"\n== {day}: minutes after the onset until the 15-min forecast has fallen by half the drop")
            print(pd.DataFrame(rx).to_string(index=False))
        return
    kpi, trips = os.path.join(a.live, "kpi_daily.json"), os.path.join(a.live, "trips.csv")
    ctrl = glob.glob(os.path.join(a.live, "ctrl_live_*.csv"))

    tr = T.prepare(g(a.train_iv2), g(a.train_iv1), a.sat, a.test_from, True, kpi, trips, ctrl)
    te = T.prepare(g(a.test_iv2), g(a.test_iv1), a.sat, None, False)
    print("train", tr["m"].index.min(), "->", tr["m"].index.max(), " test", te["m"].index.min(), "->", te["m"].index.max())
    print("training days left out (Verification rules):", tr["excluded"])
    # test frame uses the training clear-sky scale, as the live forecast uses the model's
    from mcsolar.clearsky import clear_sky_power
    mt = te["m"].copy()
    mt["Pcs"] = clear_sky_power(mt["ghi_cs"], tr["scale"])
    test_from = pd.Timestamp(a.test_from, tz="UTC")

    days = pd.read_csv(os.path.join(a.live, "verification_days.csv")).set_index("date")["status"].to_dict()
    preds = {}

    # ---- v2: same code and settings as the live v2 (5-min steps, satellite 30 min old), retrained to the same cut-off
    f2, t2, v2, _ = F5.build(tr["m"], "5min", tr["sat"], 30, tr["bad"])
    m2 = fit(f2, t2, v2)
    ft, _, _, P15 = F5.build(mt, "1min", te["sat"], 30, with_targets=False)
    ft = ft[ft.index >= test_from]
    preds["v2_every1"] = predict(m2, ft)
    t5 = ft.index[ft.index.minute % 5 == 0]
    p5 = predict(m2, ft.loc[t5])                           # v2 as it ran before Stage 1: every 5 minutes, run at +2 min
    preds["v2_every5"] = p5                                 # scored on the 5-min marks, as it was logged
    seen5 = {h: p5[h].reindex(ft.index, method="ffill", limit=4).shift(2) for h in H}   # what the operator saw

    # ---- v2.1 (satellite with each age limit, and the no-satellite fallback)
    v21 = {}
    for nosat in (True, False):
        for age in ([None] if nosat else a.sat_max_age):
            f, t, v, _ = F5.build(tr["m"], "1min", None if nosat else tr["sat"], 20, tr["bad"], fast=True,
                                  ewma_min=a.ewma_min, sat_max_age=age, bad_minutes=tr["bad_minutes"])
            f, t, v = T.thin(f, t, v, 2)
            mdl = fit(f, t, v)
            fx, _, _, _ = F5.build(mt, "1min", None if nosat else te["sat"], 20, with_targets=False, fast=True,
                                   ewma_min=a.ewma_min, sat_max_age=age)
            fx = fx[fx.index >= test_from]
            v21["nosat" if nosat else age] = (mdl, fx, predict(mdl, fx))
    fb = v21["nosat"][2]
    for age in a.sat_max_age:
        _, fx, ps = v21[age]
        use_sat = fx["sat_age_min"].notna() if "sat_age_min" in fx else pd.Series(False, index=fx.index)
        preds[f"v2.1_age{int(age)}"] = {h: ps[h].where(use_sat, fb[h]) for h in H}
        print(f"v2.1 age limit {age:g} min: satellite used for {100 * use_sat[ft['Pcs_f15'] >= 1].mean():.0f} % of daylight issues")
    preds["v2.1_nosat"] = fb

    cs15 = mt["Pcs"].rolling("15min", min_periods=9).mean()
    P15m = mt["P"].rolling("15min", min_periods=12).mean()
    k15 = (P15m / cs15.clip(lower=0.3)).clip(0, 1.3)
    date = ft.index.strftime("%Y-%m-%d")
    sets = {"Verification-scored days (scored + partial + today)": ~pd.Series(date, index=ft.index).map(days).isin(["excluded"]),
            "Fully scored days only": pd.Series(date, index=ft.index).map(days).eq("scored")}
    tables = {}
    for name, keep in sets.items():
        rows = []
        for label, p in preds.items():
            rows += score(p, P15m, cs15, k15, keep, label)
        tab = pd.DataFrame(rows)
        tables[name] = tab
        print(f"\n== {name}: days {sorted(set(date[keep.values]))}")
        print(tab.pivot(index="model", columns="horizon_min", values=["MAE_MW", "bias_MW", "skill_vs_repeat_last_%",
                                                                       "skill_vs_smart_persistence_%"]).round(2).to_string())
    with pd.ExcelWriter(os.path.join(a.out, "replay_v2_vs_v21.xlsx")) as xw:
        for i, (name, tab) in enumerate(tables.items()):
            tab.round(3).to_excel(xw, sheet_name=f"table{i + 1}", index=False)
    d0 = pd.Timestamp(a.sharp_day, tz="UTC")
    rx = reaction({"v2_every5": seen5[15], **{k: preds[k][15] for k in ("v2_every1", f"v2.1_age{int(a.sat_max_age[0])}", "v2.1_nosat")}},
                  mt["P"], d0, d0 + pd.Timedelta("1D"))
    print(f"\n== Sharp drops on {a.sharp_day}: minutes after the onset until the 15-min forecast has fallen by half the drop")
    print(pd.DataFrame(rx).to_string(index=False))
    json.dump({"tables": {k: v.round(3).to_dict("records") for k, v in tables.items()}, "reaction": rx},
              open(os.path.join(a.out, "replay.json"), "w"), indent=1, default=str)
    keep_cols = {k: pd.DataFrame(v) for k, v in preds.items()}
    pd.concat(keep_cols, axis=1).to_csv(os.path.join(a.out, "replay_predictions.csv"))


if __name__ == "__main__":
    main()
