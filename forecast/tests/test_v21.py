"""Tests for the v2.1 forecast changes: fast baseline, training exclusion filter, satellite age limit / fallback.

    cd forecast && python -m pytest tests -q
"""
import os
import sys
import numpy as np
import pandas as pd
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "live"))
from mcsolar import features5 as F5, exclude as X  # noqa: E402

IDX = pd.date_range("2026-11-20 08:00", periods=240, freq="1min", tz="UTC")


def minute_frame(k):
    """Plant at clear-sky fraction k (Series on IDX), clear sky 10 MW, 4 stations, weather station."""
    m = pd.DataFrame(index=IDX)
    m["Pcs"] = 10.0
    m["ghi_cs"] = 800.0
    m["P"] = 10.0 * k
    for s, n in (("STS1", 14), ("STS2", 14), ("STS3", 12), ("STS4", 12)):
        m[f"P_{s}"] = m["P"] * n / 52
        m[f"cap_{s}"] = n * 0.32
    m["n_inv_online"], m["inv_spread"], m["elev"], m["grid_ok"] = 52, 0.05, 40.0, True
    m["w_ghi_sts1"] = m["w_ghi_sts3"] = 800.0 * k
    return m


# ------------------------------------------------------------------ baseline
def test_ewma_steady_and_step():
    k = pd.Series(0.8, index=IDX)
    k[IDX >= IDX[120]] = 0.4                                  # cloud arrives at minute 120
    m = minute_frame(k)
    f, _, _, _ = F5.build(m, "1min", fast=True, ewma_min=2.0, with_targets=False)
    assert abs(f["k_ewma"].iloc[100] - 0.8) < 1e-6           # steady -> equals the value
    t = IDX[120]
    # after one time constant (2 min) the EWMA has moved 1 - 1/e of the step (sampled per minute: 1-(e^-1/2)^3)
    moved = (0.8 - f.loc[t + pd.Timedelta("2min"), "k_ewma"]) / 0.4
    assert 0.6 < moved < 0.8
    # the fast baseline reacts long before the 15-min mean
    assert f.loc[t + pd.Timedelta("3min"), "k_ewma"] < 0.5 < f.loc[t + pd.Timedelta("3min"), "k"]
    assert f.loc[t + pd.Timedelta("3min"), "dk_ewma"] < -0.2
    assert f.loc[t + pd.Timedelta("3min"), "n_station_dropping"] == 4


def test_mean1_baseline_is_last_minute():
    k = pd.Series(np.linspace(0.3, 0.9, len(IDX)), index=IDX)
    f, _, _, _ = F5.build(minute_frame(k), "1min", fast=True, baseline="mean1", with_targets=False)
    assert np.allclose(f["k_ewma"].dropna(), f["k_last"].loc[f["k_ewma"].dropna().index])


def test_ewma_not_carried_over_a_gap():
    k = pd.Series(0.8, index=IDX)
    m = minute_frame(k)
    m.loc[IDX[100]:IDX[110], "P"] = np.nan                    # 11-minute data gap
    f, _, _, _ = F5.build(m, "1min", fast=True, with_targets=False)
    assert pd.isna(f.loc[IDX[108], "k_ewma"])


def test_v2_unchanged_by_default():
    m = minute_frame(pd.Series(0.7, index=IDX))
    f, _, _, _ = F5.build(m, "5min", with_targets=False)
    assert "k_ewma" not in f and "sat_age_min" not in f


# ------------------------------------------------------------------ exclusion filter
def raw_iv2(P, n_on, limit=None):
    d = pd.DataFrame(index=IDX)
    d["Information.Inverter sum P"] = P
    for i in range(52):
        d[f"STS1.INV{i:02d}.active_power_total"] = 200.0 if i < n_on else 0.0
    if limit is not None:
        d["Setpoint.PowerLimit_User"] = limit
    return d


def raw_iv1(g):
    return pd.DataFrame({X.G_COLS[0]: g}, index=IDX)


def test_outage_and_curtailment_minutes_follow_kpi_rules():
    P = pd.Series(10.0, index=IDX)
    P[IDX[50]:IDX[89]] = 0.0                                  # 40 min plant stopped in sunshine
    iv2 = raw_iv2(P, 52)
    for c in [c for c in iv2 if c.endswith("active_power_total")]:
        iv2.loc[IDX[50]:IDX[89], c] = 0.0
    limit = pd.Series(100.0, index=IDX)
    limit[IDX[150]:IDX[159]] = 80.0                           # 10 min curtailed
    iv2["Setpoint.PowerLimit_User"] = limit
    fl = X.minute_flags(iv2, raw_iv1(pd.Series(700.0, index=IDX)))
    assert fl["outage"].sum() == 40 and fl["curtailed"].sum() == 10
    days = X.excluded_days(fl)
    assert days == {"2026-11-20": "outage 40 min"}            # >= 30 outage minutes: whole day out (Verification rule)
    # kpi_daily.json values win for days it covers
    assert X.excluded_days(fl, {"2026-11-20": {"outage_minutes": 5, "curtailed_minutes": 0}}) == {}


def test_trip_window_and_row_filter(tmp_path):
    trips = tmp_path / "trips.csv"
    trips.write_text("date,trip_utc,restored_utc\n2026-11-20,2026-11-20 10:00,2026-11-20 10:12\n")
    bad = X.trip_minutes(IDX, str(trips), after_trip_min=15)
    assert bad[IDX[119]] and bad[IDX[147]] and not bad[IDX[148]]   # 09:59 .. 10:27 inclusive
    ok = X.row_ok(bad)
    t = pd.Timestamp("2026-11-20 09:40", tz="UTC")
    assert not ok[30][t]          # target window 09:55-10:10 holds the trip
    assert ok[15][pd.Timestamp("2026-11-20 09:30", tz="UTC")]        # 09:30-09:45 window is clean
    assert not ok[15][pd.Timestamp("2026-11-20 10:20", tz="UTC")]    # inputs still inside the trip window


def test_training_targets_drop_bad_rows():
    m = minute_frame(pd.Series(0.7, index=IDX))
    bad = pd.Series(False, index=IDX)
    bad[IDX[100]:IDX[105]] = True
    _, t, _, _ = F5.build(m, "1min", fast=True, bad_minutes=bad)
    assert not t[15]["valid_future"][IDX[90]]                 # target window 90+1..105 hits the bad minutes
    assert t[15]["valid_future"][IDX[60]]


@pytest.mark.skipif(not os.path.exists("/mnt/user-data/uploads/Downloads/mcsolar/data/live/iv2_live_20261124.csv"),
                    reason="needs the staged live files")
def test_same_counts_as_kpi_py_on_a_real_day():
    import kpi
    from mcsolar.data import read_many
    D = "/mnt/user-data/uploads/Downloads/mcsolar/data/live/"
    iv2, iv1 = read_many([D + "iv2_live_20261124.csv"]), read_many([D + "iv1_live_20261124.csv"])
    f, kw = kpi.minute_frame(iv2, iv1)
    k = kpi.day_kpis(f, kw, "2026-11-24")
    fl = X.minute_flags(iv2, iv1)
    assert int(fl["outage"].sum()) == k["outage_minutes"]
    assert int(fl["curtailed"].sum()) == k["curtailed_minutes"]


# ------------------------------------------------------------------ satellite age limit and fallback
def sat_frame(last_stamp):
    st = pd.date_range("2026-11-20 06:00", last_stamp, freq="10min", tz="UTC")
    cols = ["C"] + [f"r{r}{d}" for r in (20, 50) for d in F5.DIRS]
    return pd.DataFrame(600.0, index=st, columns=cols)


def test_satellite_age_and_limit():
    sat = sat_frame("2026-11-20 09:00")
    cs = pd.Series(800.0, index=IDX)
    f = F5.satellite_features(sat, cs, delay_min=20, max_age_min=30, with_age=True)
    assert f.loc["2026-11-20 09:19", "sat_age_min"] == 29               # 09:00 value not usable before 09:20: 08:50 used
    assert f.loc["2026-11-20 09:20", "sat_age_min"] == 20
    assert f.loc["2026-11-20 09:25", "sat_age_min"] == 25
    assert pd.notna(f.loc["2026-11-20 09:30", "sat_kt_C"])
    assert pd.isna(f.loc["2026-11-20 09:31", "sat_kt_C"])               # older than 30 min: dropped (-> fallback)
    assert pd.isna(f.loc["2026-11-20 09:31", "sat_age_min"])
    f20 = F5.satellite_features(sat, cs, delay_min=20, max_age_min=20, with_age=True)
    assert pd.isna(f20.loc["2026-11-20 09:25", "sat_kt_C"])


def test_v2_satellite_rule_unchanged():
    sat = sat_frame("2026-11-20 09:00")
    cs = pd.Series(800.0, index=IDX)
    f = F5.satellite_features(sat, cs, delay_min=30)
    assert pd.notna(f.loc["2026-11-20 10:10", "sat_kt_C"]) and pd.isna(f.loc["2026-11-20 10:11", "sat_kt_C"])
    assert "sat_age_min" not in f


def test_live_satellite_age(tmp_path):
    import live_forecast as LF
    from datetime import datetime, timezone
    p = tmp_path / "sat.csv"
    p.write_text("time_utc,C_x\n2026-11-25T09:10,219\n2026-11-25T09:20,237\n2026-11-25T09:30,\n")
    assert LF.satellite_age(str(p), datetime(2026, 11, 25, 9, 41, tzinfo=timezone.utc)) == 21.0
    assert LF.satellite_age(str(tmp_path / "missing.csv")) is None
