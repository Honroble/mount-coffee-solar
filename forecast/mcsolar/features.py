"""15-minute feature table for short-term (15/30/60 min) plant output forecasting.

Everything is computed from data available at the END of each 15-min block, so a
row stamped t (block t-15min .. t) can be used to forecast blocks ending t+15, t+30, t+60.
"""
import numpy as np
import pandas as pd

HORIZONS = (1, 2, 4)  # in 15-min steps -> 15, 30, 60 minutes
STATIONS = ("STS1", "STS2", "STS3", "STS4")


def to_15min(plant, weather=None):
    """plant: 1-min frame from data.clean_plant joined with solar + Pcs columns."""
    g = plant.resample("15min", label="right", closed="right")
    b = pd.DataFrame({
        "P": g["P"].mean(),
        "Pcs": g["Pcs"].mean(),
        "P_std1m": g["P"].std(),                      # within-block variability
        "P_last": g["P"].last(),                      # most recent minute
        "P_range": g["P"].max() - g["P"].min(),
        "elev": g["elev"].mean(),
        "ghi_cs": g["ghi_cs"].mean(),
        "n_inv": g["n_inv_online"].mean(),
        "spread": g["inv_spread"].mean(),
        "grid_ok": g["grid_ok"].mean(),
        "p_valid": g["P"].count() / 15.0,
    })
    for st in STATIONS:
        if f"P_{st}" in plant:
            b[f"k_{st}"] = g[f"P_{st}"].mean() / (b["Pcs"] * plant[f"cap_{st}"].iloc[0] / 16.64).replace(0, np.nan)
    if weather is not None:
        w = weather.resample("15min", label="right", closed="right").mean()
        b = b.join(w)
    return b


def build(b, bad_days=()):
    f = pd.DataFrame(index=b.index)
    cs = b["Pcs"].clip(lower=0.3)
    f["k"] = (b["P"] / cs).clip(0, 1.3)
    f["k_last"] = (b["P_last"] / cs).clip(0, 1.3)
    for L in (1, 2, 3, 4):
        f[f"k_lag{L}"] = f["k"].shift(L)
    f["dk1"] = f["k"] - f["k_lag1"]
    f["k_std_1h"] = f["k"].rolling(4).std()
    f["var_in_block"] = b["P_std1m"] / cs
    f["range_in_block"] = b["P_range"] / cs
    f["spread"] = b["spread"]
    st_cols = [c for c in b.columns if c.startswith("k_STS")]
    for c in st_cols:
        f[c] = b[c].clip(0, 1.3)
    if st_cols:
        f["k_station_std"] = b[st_cols].std(axis=1)  # cloud shadow partially over plant
    f["elev"] = b["elev"]
    hour = b.index.hour + b.index.minute / 60
    f["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    f["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    f["n_inv_frac"] = b["n_inv"] / 52.0
    wcols = [c for c in b.columns if c.startswith("w_")]
    for c in wcols:
        f[c] = b[c]
        f[c + "_d1h"] = b[c] - b[c].shift(4)
    gcs = b["ghi_cs"].clip(lower=50)
    for st in ("sts1", "sts3"):                       # pyranometer clear-sky index
        if f"w_ghi_{st}" in b:
            kt = (b[f"w_ghi_{st}"] / gcs).clip(0, 1.6)
            f[f"kt_{st}"] = kt
            f[f"kt_{st}_lag1"] = kt.shift(1)
            f[f"kt_{st}_std1h"] = kt.rolling(4).std()
    if "w_tmod" in b and "w_tamb" in b:
        f["t_rise"] = b["w_tmod"] - b["w_tamb"]       # module heating ~ recent sunshine
    valid = (b["grid_ok"] > 0.9) & (b["p_valid"] > 0.8) & (b["elev"] > 3)
    valid &= ~b.index.floor("D").isin(pd.DatetimeIndex(bad_days))
    targets = {}
    for h in HORIZONS:
        targets[h] = pd.DataFrame({
            "P_future": b["P"].shift(-h),
            "Pcs_future": b["Pcs"].shift(-h),
            "valid_future": valid.shift(-h, fill_value=False),
        })
        f[f"Pcs_f{h}"] = b["Pcs"].shift(-h)          # known in advance (astronomy)
        f[f"elev_f{h}"] = b["elev"].shift(-h)
    return f, targets, valid
