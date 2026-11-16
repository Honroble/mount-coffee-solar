"""Satellite irradiance features (Open-Meteo satellite archive, EUMETSAT/DWD, 10-minute).

Input CSV: time_utc + one column per location named <tag>_<lat>_<lon>, tag C (plant),
r20N..r20NW (20 km ring) and r50N..r50NW (50 km ring). Each value is the mean GHI over
the 10 minutes ending at its timestamp (checked against the plant pyranometer).

Live satellite data arrives late (about 20-30 min), so features at issue time t only use
satellite values up to t - delay. Default delay 30 min keeps the back-test honest.
"""
import numpy as np
import pandas as pd

DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def read_satellite(path):
    s = pd.read_csv(path)
    s.index = pd.to_datetime(s["time_utc"]).dt.tz_localize("UTC")
    s = s.drop(columns=["time_utc"])
    s.columns = [c.split("_")[0] for c in s.columns]
    return s.apply(pd.to_numeric, errors="coerce")


def satellite_15min(sat, ghi_cs_15, delay_min=30):
    """Return 15-min features (label = block end), shifted so only data older than delay is used."""
    g = sat.resample("15min", label="right", closed="right").mean()
    g = g.shift(freq=pd.Timedelta(minutes=delay_min))  # value usable only `delay` after it was measured
    g = g.reindex(ghi_cs_15.index)
    cs = ghi_cs_15.clip(lower=50)
    kt = g.div(cs, axis=0).clip(0, 1.6)
    f = pd.DataFrame(index=g.index)
    f["sat_kt_C"] = kt["C"]
    for ring in ("r20", "r50"):
        cols = [f"{ring}{d}" for d in DIRS if f"{ring}{d}" in kt]
        f[f"sat_kt_{ring}_mean"] = kt[cols].mean(axis=1)
        f[f"sat_kt_{ring}_std"] = kt[cols].std(axis=1)       # broken cloud nearby
        for d in DIRS:
            if f"{ring}{d}" in kt:
                f[f"sat_kt_{ring}{d}"] = kt[f"{ring}{d}"]
    f["sat_kt_C_d30"] = f["sat_kt_C"] - f["sat_kt_C"].shift(2)
    f["sat_ring_minus_C"] = f["sat_kt_r20_mean"] - f["sat_kt_C"]  # clouds around vs over plant
    return f
