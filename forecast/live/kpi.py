"""Daily plant KPIs and loss breakdown for Mount Coffee (read-only, from the logger's 1-minute data).

KPIs per day
  energy_mwh          inverter-side energy (sum of 'Information.Inverter sum P')
  insolation_kwh_m2   horizontal irradiation at the STS3 pyranometer (STS1's sensor has drifted low since Sep)
  specific_yield      kWh per kWp (21 170 kWp DC)
  pr_pct              performance ratio = specific yield / insolation (IEC 61724 style, horizontal irradiance)
  pr_temp_pct         PR corrected to 25 C module temperature (gamma -0.34 %/C)
  availability_pct    share of producing minutes for inverters that reported, while the plant ran
  soiling_ratio_pct   DustIQ (100 % = clean)

Loss breakdown (MWh), from what clear sky could give down to what the plant gave:
  clear_sky_mwh  -> cloud -> clipping (export limit) -> curtailment (PowerLimit_User < 100 %)
                 -> plant/grid outage (sunny, plant stopped) -> inverters down -> soiling (DustIQ)
                 -> other (mismatch, wiring, ageing, and sunlight-sensor vs plant differences under broken cloud) -> energy_mwh
Expected output from measured sunlight: P = K * 21.17 MW * G/1000 * (1 - 0.0034 (Tmod - 25)), K = 0.85
(fitted on Sep-Nov 2026 minutes with all reporting inverters on and no clipping).

  python live\\kpi.py                 yesterday and today from data\\live, writes data\\live\\kpi_daily.json
  python live\\kpi.py --days 7        last 7 days
  python live\\kpi.py --iv2 a.csv --iv1 b.csv --out kpi.json   any logger exports (used for the history)
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from mcsolar.data import read_many  # noqa: E402
from mcsolar.clearsky import solar, clear_sky_power  # noqa: E402

DC_MW, DC_KWP, N_INV = 21.17, 21170.0, 52
K_SYSTEM, GAMMA = 0.85, -0.0034
CAP_MW = 16.9            # highest inverter-side output the export limit allows (16.64 MW at the meter)
CS_SCALE = 0.02063       # MW per W/m2 of clear-sky GHI (clearsky.fit_scale on the history)
P_COL = "Information.Inverter sum P"
G_COLS = ["FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated", "FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated"]
T_COL = "FPE.PV.STS1.temperature.Temp01 - Module"
SR_COLS = ["FPE.PV.STS1.DustIQ.soiling_ratio_Sensor01", "FPE.PV.STS1.DustIQ.soiling_ratio_Sensor02"]
LIMIT_COL = "Setpoint.PowerLimit_User"
SENTINELS = [655.35, 6553.5, 65535]


def clean(s, lo, hi):
    s = pd.to_numeric(s, errors="coerce")
    return s.where((s >= lo) & (s <= hi) & ~s.isin(SENTINELS))


def minute_frame(iv2, iv1):
    idx = iv2.index.union(iv1.index) if iv1 is not None and len(iv1) else iv2.index
    f = pd.DataFrame(index=idx)
    f["P"] = clean(iv2[P_COL], -0.1, 20).reindex(idx).clip(lower=0)
    inv = [c for c in iv2.columns if c.endswith(".active_power_total")]
    kw = iv2[inv].apply(lambda s: clean(s, -5, 400)).reindex(idx)
    f["n_valid"] = kw.notna().sum(axis=1)
    f["n_on"] = (kw > 5).sum(axis=1)
    f["limit"] = clean(iv2[LIMIT_COL], 0, 110).reindex(idx) if LIMIT_COL in iv2 else np.nan
    g = None
    if iv1 is not None and len(iv1):
        for c in G_COLS:                       # STS3 first, STS1 only where STS3 is missing
            if c in iv1:
                v = clean(iv1[c], -10, 1600).reindex(idx)
                g = v if g is None else g.fillna(v)
        f["T"] = clean(iv1[T_COL], -5, 90).reindex(idx) if T_COL in iv1 else np.nan
        sr = [clean(iv1[c], 50, 105).reindex(idx) for c in SR_COLS if c in iv1]
        f["SR"] = pd.concat(sr, axis=1).mean(axis=1) if sr else np.nan
    f["G"] = g.clip(lower=0) if g is not None else np.nan
    for c in ("T", "SR"):
        if c not in f:
            f[c] = np.nan
    f = f.join(solar(f.index))
    f["Pcs"] = clear_sky_power(f["ghi_cs"], CS_SCALE)
    return f, kw


def day_kpis(f, kw, date):
    d = f.loc[date]
    k = kw.loc[date]
    if d["P"].notna().sum() < 60:
        return None
    m = 1 / 60.0
    P = d["P"].fillna(0)
    T = d["T"].fillna(d["T"].mean() if d["T"].notna().any() else 30)
    G = d["G"]
    Pexp = (K_SYSTEM * DC_MW * G / 1000 * (1 + GAMMA * (T - 25))).fillna(P)   # no sunlight reading: assume as produced
    run = (G.fillna(0) > 100) | (P > 0.5)
    plant_on = run & (d["n_on"] >= 10)
    # inverters down: reporting, at <= 5 kW while at least 10 others produce
    down = (k <= 5) & plant_on.values[:, None]
    n_down = down.sum(axis=1)
    valid_on = (k.notna() & plant_on.values[:, None]).sum(axis=0)
    inv_avail = 1 - down.sum(axis=0) / valid_on.replace(0, np.nan)
    capped = Pexp.clip(upper=CAP_MW)
    clipping = (Pexp - CAP_MW).clip(lower=0)
    curt_min = d["limit"].fillna(100) < 99
    # whole plant stopped in daylight (trip, grid outage, breaker): sunlight > 150 W/m2 but under 10 inverters on
    outage_min = (G.fillna(0) > 150) & ((d["n_on"] < 10) | (P < 0.3)) & ~curt_min
    curtail = ((capped - P).clip(lower=0)).where(curt_min, 0)
    outage = (capped - P).clip(lower=0).where(outage_min, 0)
    normal = ~curt_min & ~outage_min
    downtime = (capped * n_down / N_INV).where(normal, 0)
    sr = d["SR"].clip(upper=100)
    soiling = (capped * (1 - sr / 100)).fillna(0).clip(lower=0).where(normal, 0)
    cloud = d["Pcs"] - Pexp
    other = (capped - downtime - soiling - P).where(normal, 0)
    E = P.sum() * m
    H = G.fillna(0).sum() * m / 1000                                    # kWh/m2
    tref = (DC_MW * G / 1000 * (1 + GAMMA * (T - 25))).fillna(0).sum() * m
    worst = inv_avail.dropna().sort_values().head(5)
    r = lambda v, n=2: None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), n)
    return {
        "date": date, "minutes": int(d["P"].notna().sum()),
        "energy_mwh": r(E), "insolation_kwh_m2": r(H, 3), "specific_yield": r(E * 1000 / DC_KWP, 3),
        "pr_pct": r(100 * E / (DC_MW * H)) if H > 0.2 else None,
        "pr_temp_pct": r(100 * E / tref) if tref > 1 else None,
        "availability_pct": r(100 * inv_avail.mean()) if inv_avail.notna().any() else None,
        "inverter_channels_missing_pct": r(100 * (1 - d["n_valid"][run].mean() / N_INV)) if run.any() else None,
        "soiling_ratio_pct": r(sr.mean()) if sr.notna().any() else None,
        "peak_mw": r(P.max()), "curtailed_minutes": int(curt_min[run].sum()), "outage_minutes": int(outage_min.sum()),
        "losses_mwh": {
            "clear_sky": r(d["Pcs"].sum() * m), "cloud": r(cloud.sum() * m), "clipping": r(clipping.sum() * m),
            "curtailment": r(curtail.sum() * m), "plant_outage": r(outage.sum() * m), "inverters_down": r(downtime.sum() * m),
            "soiling": r(soiling.sum() * m),
            "other": r(other.sum() * m), "actual": r(E),
        },
        "weakest_inverters": [{"inverter": i.replace(".active_power_total", ""), "availability_pct": r(100 * v, 1)} for i, v in worst.items() if v < 0.99],
    }


def compute(iv2_paths, iv1_paths, dates=None):
    iv2 = read_many(iv2_paths)
    iv1 = read_many(iv1_paths) if iv1_paths else None
    f, kw = minute_frame(iv2, iv1)
    days = sorted({t.strftime("%Y-%m-%d") for t in f.index}) if dates is None else dates
    out = []
    for day in days:
        try:
            k = day_kpis(f, kw, day)
        except KeyError:
            k = None
        if k:
            out.append(k)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--iv2", nargs="*")
    ap.add_argument("--iv1", nargs="*")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.iv2:
        res = compute(sorted(sum((glob.glob(p) for p in a.iv2), [])), sorted(sum((glob.glob(p) for p in (a.iv1 or [])), [])))
        out = a.out or "kpi_daily.json"
        json.dump(res, open(out, "w", encoding="utf-8"), indent=1)
        print(f"{len(res)} days -> {out}")
        return
    sys.path.insert(0, HERE)
    from portal_collector import load_config
    live = load_config(a.config)["live_dir"]
    today = datetime.now(timezone.utc).date()
    days = [(today - timedelta(days=i)).isoformat() for i in range(a.days - 1, -1, -1)]
    iv2 = [p for p in (os.path.join(live, f"iv2_live_{d.replace('-', '')}.csv") for d in days) if os.path.exists(p)]
    iv1 = [p for p in (os.path.join(live, f"iv1_live_{d.replace('-', '')}.csv") for d in days) if os.path.exists(p)]
    if not iv2:
        print("no logger files for", days)
        return
    res = compute(iv2, iv1, [d for d in days if os.path.join(live, f"iv2_live_{d.replace('-', '')}.csv") in iv2])
    path = os.path.join(live, "kpi_daily.json")
    try:
        old = {r["date"]: r for r in json.load(open(path, encoding="utf-8"))}
    except Exception:
        old = {}
    for r in res:
        r["computed_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        old[r["date"]] = r
    tmp = path + ".tmp"
    json.dump([old[k] for k in sorted(old)], open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, path)
    for r in res:
        print(r["date"], r["energy_mwh"], "MWh  PR", r["pr_pct"], "%  PR(temp)", r["pr_temp_pct"], "%  availability", r["availability_pct"], "%")


if __name__ == "__main__":
    main()
