"""Clear-sky model for Mount Coffee: pvlib Ineichen GHI scaled empirically to plant power."""
import numpy as np
import pandas as pd
import pvlib
from .data import LAT, LON, ALT, CLIP_MW

_site = pvlib.location.Location(LAT, LON, tz="UTC", altitude=ALT)


def solar(index):
    sp = _site.get_solarposition(index)
    cs = _site.get_clearsky(index, model="ineichen")
    return pd.DataFrame({"elev": sp["apparent_elevation"], "azim": sp["azimuth"],
                         "ghi_cs": cs["ghi"]}, index=index)


def fit_scale(power, ghi_cs, elev, q=0.985):
    """Plant MW per W/m2 of clear-sky GHI, from the clearest unclipped minutes."""
    m = (elev > 25) & (power < CLIP_MW * 0.95) & (power > 1) & (ghi_cs > 300)
    r = (power[m] / ghi_cs[m]).dropna()
    return float(r.quantile(q))


def clear_sky_power(ghi_cs, scale):
    return np.minimum(scale * ghi_cs, CLIP_MW).clip(lower=0)
