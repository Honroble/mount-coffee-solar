"""Weather/sensor features from the iv1 logging group (pyranometers, temps, DustIQ, WS600).

Columns are renamed to short 'w_' names so features.build() picks them up automatically.
Not used until iv1 data is downloaded; the pipeline runs without it.
"""
import numpy as np
import pandas as pd

MAP = {
    "FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated": "w_ghi_sts1",
    "FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated": "w_ghi_sts3",
    "FPE.PV.STS1.Pyranometer.down.irradiation_temp_compensated": "w_alb_sts1",
    "FPE.PV.STS1.temperature.Temp01 - Module": "w_tmod",
    "FPE.PV.STS1.temperature.Temp02 - Ambient": "w_tamb",
    "FPE.PV.STS1.DustIQ.soiling_ratio_Sensor01": "w_soil1",
    "FPE.PV.STS1.DustIQ.soiling_ratio_Sensor02": "w_soil2",
    "FPE.PV.STS1.WS600.relative_humidity_avg": "w_rh",
    "FPE.PV.STS1.WS600.dew_point_avg": "w_dew",
    "FPE.PV.STS1.WS600.air_temperature_avg.": "w_tair",
    "FPE.PV.STS1.WS600.absolute_air_preassure_avg.": "w_press",
    "FPE.PV.STS1.WS600.wind_speed_avg.": "w_wind",
    "FPE.PV.STS1.WS600.wind_speed_max": "w_gust",
    "FPE.PV.STS1.WS600.precipitation_intense": "w_rain",
}
WIND_DIR = "FPE.PV.STS1.WS600.wind_direction_compass_corr."


def weather_frame(iv1):
    """iv1: DataFrame from data.read_gantner_csv on an iv1 export."""
    w = pd.DataFrame(index=iv1.index)
    for src, dst in MAP.items():
        if src in iv1:
            w[dst] = iv1[src]
    for c in ("w_ghi_sts1", "w_ghi_sts3", "w_alb_sts1"):
        if c in w:
            w[c] = w[c].where((w[c] > -20) & (w[c] < 1600))
    if "w_gust" in w:  # logger stores max wind in m/s but average in km/h
        w["w_gust"] = w["w_gust"] * 3.6
    # physically impossible values -> missing (sensor glitches seen in the export)
    limits = {"w_wind": (0, 150), "w_gust": (0, 200), "w_rain": (0, 250), "w_soil1": (80, 105),
              "w_soil2": (80, 105), "w_press": (950, 1050), "w_tmod": (10, 80), "w_tamb": (10, 50)}
    for c, (lo, hi) in limits.items():
        if c in w:
            w[c] = w[c].where(w[c].between(lo, hi))
    if "w_rh" in w:
        w["w_rh"] = w["w_rh"].where(w["w_rh"].between(0, 100))
    if WIND_DIR in iv1:  # direction as vector components so 359 deg ~ 1 deg
        rad = np.deg2rad(iv1[WIND_DIR].where(iv1[WIND_DIR].between(0, 360)))
        w["w_wind_u"] = np.sin(rad)
        w["w_wind_v"] = np.cos(rad)
    if {"w_ghi_sts1", "w_ghi_sts3"} <= set(w):
        w["w_ghi_diff13"] = w["w_ghi_sts1"] - w["w_ghi_sts3"]  # cloud edge between stations
    return w
