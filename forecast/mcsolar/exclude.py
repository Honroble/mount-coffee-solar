"""Which minutes and days must not train the forecast models (v2.1).

The rules are the ones the Verification tab uses to leave days out of the scores, so a model is trained on the
same kind of data it is judged on:
  - a day is excluded when the plant/grid was out for 30 minutes or more, or curtailed for 30 minutes or more
    (verify.py day_info, using kpi.py's minute rules: outage = sunlight > 150 W/m2 but under 10 inverters on or
    under 0.3 MW, not curtailed; curtailed = PowerLimit_User below 99 % while the plant runs).
    For days in kpi_daily.json the stored counts are used as they are; older days are counted from the minutes.
  - inside a kept day, these minutes are also left out: outage minutes, curtailed minutes, and every trip in
    trips.csv from the trip until `after_trip_min` after the plant was restored (inverters ramp back up).
A training row is dropped if any left-out minute falls in its last-15-minute input window or its target window.
"""
import json
import os
import numpy as np
import pandas as pd

OUTAGE_MIN = 30          # verify.py OUTAGE_MIN
LIMIT_COL = "Setpoint.PowerLimit_User"
G_COLS = ["FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated",
          "FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated"]


def _clean(s, lo, hi):
    s = pd.to_numeric(s, errors="coerce")
    return s.where((s >= lo) & (s <= hi) & ~s.isin([655.35, 6553.5, 65535]))


def minute_flags(iv2_raw, iv1_raw=None, limit=None):
    """1-min frame with bool columns outage, curtailed, run (kpi.py rules). `limit` (%, optional) overrides the
    PowerLimit_User channel, e.g. from the ctrl_live files when the iv2 export does not carry it."""
    idx = iv2_raw.index
    P = _clean(iv2_raw["Information.Inverter sum P"], -0.1, 20).clip(lower=0)
    inv = [c for c in iv2_raw.columns if c.endswith(".active_power_total")]
    n_on = (iv2_raw[inv].apply(lambda s: _clean(s, -5, 400)) > 5).sum(axis=1)
    G = None
    if iv1_raw is not None and len(iv1_raw):
        for c in G_COLS:
            if c in iv1_raw:
                v = _clean(iv1_raw[c], -10, 1600).reindex(idx)
                G = v if G is None else G.fillna(v)
    G = (G.clip(lower=0) if G is not None else pd.Series(np.nan, index=idx)).fillna(0)
    if limit is None:
        limit = _clean(iv2_raw[LIMIT_COL], 0, 110) if LIMIT_COL in iv2_raw else pd.Series(np.nan, index=idx)
    lim = limit.reindex(idx)
    curt = lim.fillna(100) < 99
    outage = (G > 150) & ((n_on < 10) | (P < 0.3)) & ~curt
    run = (G > 100) | (P > 0.5)
    return pd.DataFrame({"outage": outage, "curtailed": curt & run, "run": run}, index=idx)


def load_kpi(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {r["date"]: r for r in json.load(fh)}


def excluded_days(flags, kpi=None):
    """{date: reason} for days the Verification tab would leave out (outage or curtailment >= 30 min)."""
    kpi = kpi or {}
    out = {}
    counts = flags[["outage", "curtailed"]].groupby(flags.index.floor("D")).sum()
    for day, r in counts.iterrows():
        d = day.date().isoformat()
        k = kpi.get(d)
        om = (k.get("outage_minutes") or 0) if k else int(r["outage"])
        cm = (k.get("curtailed_minutes") or 0) if k else int(r["curtailed"])
        if om >= OUTAGE_MIN:
            out[d] = f"outage {om} min"
        elif cm >= OUTAGE_MIN:
            out[d] = f"curtailed {cm} min"
    for d, k in kpi.items():                      # days in kpi_daily.json with no minutes here
        if d not in out and ((k.get("outage_minutes") or 0) >= OUTAGE_MIN or (k.get("curtailed_minutes") or 0) >= OUTAGE_MIN):
            out[d] = "kpi_daily"
    return out


def trip_minutes(index, trips_csv, after_trip_min=15):
    bad = pd.Series(False, index=index)
    if not trips_csv or not os.path.exists(trips_csv):
        return bad
    t = pd.read_csv(trips_csv)
    for _, r in t.iterrows():
        a = pd.to_datetime(r.get("trip_utc"), errors="coerce")
        if pd.isna(a):
            continue
        z = pd.to_datetime(r.get("restored_utc"), errors="coerce")
        z = (a + pd.Timedelta(minutes=30)) if pd.isna(z) else z
        a, z = a.tz_localize("UTC") if a.tzinfo is None else a, z.tz_localize("UTC") if z.tzinfo is None else z
        bad |= (index >= a - pd.Timedelta(minutes=1)) & (index <= z + pd.Timedelta(minutes=after_trip_min))
    return bad


def bad_minutes(index, flags, kpi=None, trips_csv=None, after_trip_min=15):
    """True for every minute that must not be used, on the 1-minute `index`."""
    f = flags.reindex(index).fillna(False).astype(bool)
    days = excluded_days(flags, kpi)
    bad = index.floor("D").strftime("%Y-%m-%d").isin(list(days))
    bad = pd.Series(bad, index=index) | f["outage"] | f["curtailed"]
    bad |= trip_minutes(index, trips_csv, after_trip_min)
    return bad


def row_ok(bad, horizons=(15, 30, 60), before=15):
    """For each 1-min issue time t: True if no bad minute in (t-before, t] and none in each target window
    (t+h-15, t+h]. Returns {h: bool Series}."""
    b = bad.astype(float)
    past = b.rolling(f"{before}min", min_periods=1).max().fillna(1) == 0
    win = b.rolling("15min", min_periods=1).max()
    return {h: past & (win.shift(freq=pd.Timedelta(minutes=-h)).reindex(b.index).fillna(1) == 0) for h in horizons}
