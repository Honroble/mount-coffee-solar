"""Rolling-window features for forecasts issued every 5 minutes (v2 models).

A forecast issued at time t (any 5-minute mark) uses only data up to t:
  - the last 15 minutes (same quantity the 15-minute models used), the last 5 minutes and the last minute
  - 15-minute windows ending 15/30/45/60 minutes before t
  - weather station (pyranometers, temperatures, wind) over the same windows
  - satellite irradiance over and around the plant, usable `delay` minutes after it was measured
Targets: mean plant power over the 15 minutes ending t+15, t+30 and t+60 (as in the 15-minute models),
predicted as a fraction of clear-sky power.
"""
import numpy as np
import pandas as pd

HORIZONS_MIN = (15, 30, 60)
STATIONS = ("STS1", "STS2", "STS3", "STS4")
DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def _roll(s, minutes, how="mean"):
    r = s.rolling(f"{minutes}min", min_periods=max(1, int(minutes * 0.6)))
    return getattr(r, how)()


def _lag(s, minutes):
    """Value of s as it was `minutes` earlier (1-minute index)."""
    return s.shift(freq=pd.Timedelta(minutes=minutes)).reindex(s.index)


def minute_frame(pl, w=None):
    """pl: 1-min plant frame (data.clean_plant + clearsky.solar + Pcs). Returns a regular 1-min frame."""
    idx = pd.date_range(pl.index.min().floor("min"), pl.index.max().ceil("min"), freq="1min")
    m = pl.reindex(idx)
    if w is not None:
        m = m.join(w.reindex(idx))
    return m


def build(m, step="5min", sat=None, sat_delay=30, bad_days=(), with_targets=True):
    """m: regular 1-min frame from minute_frame (may extend into the future for clear-sky columns)."""
    cs = m["Pcs"]
    P = m["P"]
    P15, cs15 = _roll(P, 15), _roll(cs, 15)
    P5, cs5 = _roll(P, 5), _roll(cs, 5)
    k15 = (P15 / cs15.clip(lower=0.3)).clip(0, 1.3)
    f = pd.DataFrame(index=m.index)
    f["k"] = k15
    f["k5"] = (P5 / cs5.clip(lower=0.3)).clip(0, 1.3)
    f["k_last"] = (P / cs.clip(lower=0.3)).clip(0, 1.3)
    for L in (15, 30, 45, 60):
        f[f"k_lag{L}"] = _lag(k15, L)
    f["dk15"] = f["k"] - f["k_lag15"]
    f["dk5"] = f["k5"] - f["k"]
    f["k_std_1h"] = f[["k", "k_lag15", "k_lag30", "k_lag45"]].std(axis=1)
    f["var15"] = _roll(P, 15, "std") / cs15.clip(lower=0.3)
    f["var5"] = _roll(P, 5, "std") / cs5.clip(lower=0.3)
    f["range15"] = (_roll(P, 15, "max") - _roll(P, 15, "min")) / cs15.clip(lower=0.3)
    f["P_valid15"] = P.notna().astype(float).rolling("15min").sum() / 15
    f["spread"] = _roll(m["inv_spread"], 15)
    st = []
    for s in STATIONS:
        if f"P_{s}" in m:
            share = m[f"cap_{s}"].dropna().iloc[0] / 16.64 if m[f"cap_{s}"].notna().any() else 0.25
            f[f"k_{s}"] = (_roll(m[f"P_{s}"], 15) / (cs15 * share).clip(lower=0.1)).clip(0, 1.3)
            f[f"k5_{s}"] = (_roll(m[f"P_{s}"], 5) / (cs5 * share).clip(lower=0.1)).clip(0, 1.3)
            st.append(s)
    if st:
        f["k_station_std"] = f[[f"k_{s}" for s in st]].std(axis=1)
        f["k5_station_std"] = f[[f"k5_{s}" for s in st]].std(axis=1)
    f["elev"] = m["elev"]
    hour = m.index.hour + m.index.minute / 60
    f["hour_sin"], f["hour_cos"] = np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24)
    f["n_inv_frac"] = _roll(m["n_inv_online"], 15) / 52.0
    gcs15, gcs5 = _roll(m["ghi_cs"], 15).clip(lower=50), _roll(m["ghi_cs"], 5).clip(lower=50)
    for c in [c for c in m.columns if c.startswith("w_")]:
        v15 = _roll(m[c], 15)
        f[c] = v15
        f[c + "_d1h"] = v15 - _lag(v15, 60)
    for s in ("sts1", "sts3"):
        c = f"w_ghi_{s}"
        if c in m:
            kt15 = (_roll(m[c], 15) / gcs15).clip(0, 1.6)
            kt5 = (_roll(m[c], 5) / gcs5).clip(0, 1.6)
            f[f"kt_{s}"], f[f"kt5_{s}"] = kt15, kt5
            f[f"kt_{s}_lag15"] = _lag(kt15, 15)
            f[f"kt_{s}_std1h"] = (m[c] / m["ghi_cs"].clip(lower=50)).clip(0, 1.6).rolling("60min", min_periods=30).std()
            f[f"kt_{s}_d5"] = kt5 - kt15
    if "w_tmod" in m and "w_tamb" in m:
        f["t_rise"] = _roll(m["w_tmod"] - m["w_tamb"], 15)
    if sat is not None:
        f = f.join(satellite_features(sat, m["ghi_cs"], sat_delay))
    # known in advance: clear sky and sun height over each target window
    for h in HORIZONS_MIN:
        f[f"Pcs_f{h}"] = _lag(cs15, -h)
        f[f"elev_f{h}"] = _lag(m["elev"], -(h - 7))
    grid15 = m["grid_ok"].astype(float).rolling("15min", min_periods=10).mean()
    valid = (grid15 > 0.9) & (f["P_valid15"] > 0.8) & (m["elev"] > 3)
    valid &= ~m.index.floor("D").isin(pd.DatetimeIndex(bad_days))
    targets = {}
    if with_targets:
        for h in HORIZONS_MIN:
            targets[h] = pd.DataFrame({"P_future": _lag(P15, -h), "Pcs_future": _lag(cs15, -h),
                                       "valid_future": _lag(valid.astype(float), -h).fillna(0) > 0.5}, index=m.index)
    keep = m.index[(m.index.minute % int(pd.Timedelta(step).total_seconds() // 60)) == 0]
    f = f.loc[keep]
    return f, {h: t.loc[keep] for h, t in targets.items()}, valid.loc[keep], P15.loc[keep]


def satellite_features(sat, ghi_cs_1min, delay_min=30):
    """sat: frame from satellite.read_satellite (10-min). Values usable delay_min after their time stamp."""
    g = sat.copy()
    g.index = g.index + pd.Timedelta(minutes=delay_min)            # when each value becomes usable
    cs = ghi_cs_1min.reindex(sat.index, method="nearest").clip(lower=50).values
    kt = g.div(cs, axis=0).clip(0, 1.6)
    kt = kt.rolling(2, min_periods=1).mean()                         # last 20 minutes
    f = pd.DataFrame(index=kt.index)
    f["sat_kt_C"] = kt["C"]
    for ring in ("r20", "r50"):
        cols = [f"{ring}{d}" for d in DIRS if f"{ring}{d}" in kt]
        f[f"sat_kt_{ring}_mean"] = kt[cols].mean(axis=1)
        f[f"sat_kt_{ring}_std"] = kt[cols].std(axis=1)
        for d in DIRS:
            if f"{ring}{d}" in kt:
                f[f"sat_kt_{ring}{d}"] = kt[f"{ring}{d}"]
    f["sat_kt_C_d30"] = f["sat_kt_C"] - f["sat_kt_C"].shift(3)
    f["sat_ring_minus_C"] = f["sat_kt_r20_mean"] - f["sat_kt_C"]
    # as-of join onto the 1-minute timeline (latest usable satellite value at each minute)
    return f.reindex(ghi_cs_1min.index, method="ffill", limit=40)
