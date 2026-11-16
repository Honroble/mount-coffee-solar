"""Loading and cleaning Gantner Q.reader CSV exports for the Mount Coffee solar plant.

Gantner CSV layout: row 1 = channel names, row 2 = units, then one row per minute.
Separator ';', encoding latin-1, Date 'dd.mm.YYYY', Time 'HH:MM:SS', Timezone '+0000'.
"""
import re
import numpy as np
import pandas as pd

# Plant constants (LEC Mount Coffee: 20 MW DC / 16.64 MW AC, 52 x 320 kW inverters)
LAT, LON, ALT = 6.505, -10.648, 30.0
AC_LIMIT_MW = 16.64          # controller setpoint (static power limit)
CLIP_MW = 16.90              # observed practical ceiling of plant output
SENTINELS = (655.35, 6553.5, 65535.0, 65535)


def read_gantner_csv(path):
    """Read one Gantner CSV export into a DataFrame indexed by UTC timestamp."""
    df = pd.read_csv(path, sep=";", encoding="latin-1", skiprows=[1], low_memory=False)
    ts = pd.to_datetime(df["Date"] + " " + df["Time"], format="%d.%m.%Y %H:%M:%S")
    tz = df["Timezone"].iloc[0] if "Timezone" in df else "+0000"
    ts = ts - pd.to_timedelta(int(str(tz)[:3]), unit="h")  # convert to UTC
    df = df.drop(columns=[c for c in ("Date", "Time", "Timezone") if c in df])
    df.index = ts.dt.tz_localize("UTC")
    df.index.name = "ts"
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.mask(df.isin(list(SENTINELS)))
    df = df[~df.index.duplicated()].sort_index()
    return df


def read_many(paths):
    return pd.concat([read_gantner_csv(p) for p in paths]).sort_index().loc[lambda d: ~d.index.duplicated()]


def inverter_columns(df):
    return [c for c in df.columns if re.match(r"^STS\d\.INV\d+\.active_power_total$", c)]


def clean_plant(df):
    """Return a 1-minute frame with plant power (MW), station powers (MW), counts and flags."""
    out = pd.DataFrame(index=df.index)
    P = df["Information.Inverter sum P"]
    inv = inverter_columns(df)
    X = df[inv].where((df[inv] >= -5) & (df[inv] < 400)) / 1000.0  # kW -> MW, drop impossible
    out["P"] = P.where((P >= -0.1) & (P < 20))
    for st in sorted({c.split(".")[0] for c in inv}):
        cols = [c for c in inv if c.startswith(st + ".")]
        out[f"P_{st}"] = X[cols].sum(axis=1, min_count=1)
        out[f"cap_{st}"] = len(cols) * 0.32
    out["n_inv_online"] = (X > 0.005).sum(axis=1)
    out["inv_spread"] = X.std(axis=1) / X.mean(axis=1).replace(0, np.nan)
    f = df.get("Active Power.Frequency")
    out["freq"] = f.where(f > 45) if f is not None else np.nan
    # grid / plant outage: no valid frequency reading (logger writes 0 or 40 Hz)
    out["grid_ok"] = out["freq"].notna()
    return out


def mark_bad_days(plant, cs_power):
    """Flag days where plant was unavailable (outage) so they don't train the model."""
    dl = plant[cs_power > 0.2]
    cs = cs_power[cs_power > 0.2]
    day = dl.index.floor("D")
    ratio = dl["P"].fillna(0).groupby(day).sum() / cs.groupby(day).sum()
    grid_bad = (~dl["grid_ok"]).groupby(day).mean()
    p_missing = dl["P"].isna().groupby(day).mean()
    bad = (ratio < 0.05) | (grid_bad > 0.2) | (p_missing > 0.2)
    return bad[bad].index
