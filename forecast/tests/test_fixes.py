"""Regression tests for bugs fixed earlier, so they stay fixed.

    cd forecast && python -m pytest tests -q
"""
import csv
import json
import os
import sys
import types
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(os.path.dirname(HERE), "live")
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, LIVE)


# ---------------------------------------------------------------- OFFLINE e-mails (were sent every 2 minutes)
def test_offline_mail_not_repeated_every_run(tmp_path, monkeypatch):
    import ramp_watch as R
    sent = []
    monkeypatch.setattr(R, "read_now", lambda live, now: [])
    monkeypatch.setattr(R, "evaluate", lambda rows, now: {
        "level": "alarm", "offline": True, "message": "Plant OFFLINE", "time_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pv_mw": 0, "drop1_mw": 0, "drop5_mw": 0, "drop15_mw": 0, "sky": "", "reserve_mw": None})
    import subprocess
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: sent.append(1))
    t0 = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)
    for i in range(0, 80, 2):                                   # the poller runs about every 2 minutes
        R.run({"live_dir": str(tmp_path)}, now=t0 + timedelta(minutes=i), send=True)
    expected = 1 + (78 // R.OFFLINE_MAIL_EVERY_MIN)
    assert len(sent) == expected, f"{len(sent)} e-mails in 80 minutes"


# ---------------------------------------------------------------- logger homepage edited ("Config changed")
def test_widget_layout_read_from_start_page(tmp_path):
    import portal_collector as P
    names = list(P.WIDGET_NAMES.items())
    widgets = [{"config": {"title": "Clock"}}] + [{"config": {"title": n}} for _, n in reversed(names)]
    html = ("<script>var WIDGET_CONFIG = " + json.dumps(widgets) + "; var CONFIG_ID = 1795601705;</script>")
    page = types.SimpleNamespace(text=html)
    p = types.SimpleNamespace(base="https://x", s=types.SimpleNamespace(get=lambda url, timeout=60: page))
    cid, idx = P._widget_layout(p, {"live_dir": str(tmp_path)}, refresh=True)
    assert cid == "1795601705"                                   # upper-case CONFIG_ID is found
    for k, (field, _) in enumerate(reversed(names)):
        assert idx[field] == k + 1                               # positions follow the names, not a fixed order
    assert json.load(open(tmp_path / "widget_layout.json"))["config_id"] == "1795601705"


# ---------------------------------------------------------------- retrain skipped when the satellite download failed
def test_satellite_download_retried_and_old_copy_kept(tmp_path, monkeypatch):
    import retrain_monthly as RM
    monkeypatch.setattr(RM.time, "sleep", lambda s: None)
    sat = str(tmp_path / "satellite_history.csv")
    calls = []

    def flaky(cmd, **k):
        calls.append(1)
        if len(calls) < 3:
            raise OSError("getaddrinfo failed")
        open(cmd[-1], "w").write("time_utc,C\n")
    path, note = RM.fetch_satellite_history(sat, "2026-11-27", run=flaky)
    assert path == sat and len(calls) == 3 and "try 3" in note
    calls.clear()

    def down(cmd, **k):
        calls.append(1)
        raise OSError("down")
    path, note = RM.fetch_satellite_history(sat, "2026-11-27", run=down)
    assert path == sat and len(calls) == 3 and "existing copy" in note      # old copy kept, models still retrained
    os.remove(sat)
    path, note = RM.fetch_satellite_history(sat, "2026-11-27", run=down)
    assert path is None


# ---------------------------------------------------------------- gap filler: day edges, missing days, newest first
def _fake_portal(monkeypatch, tmp_path, calls):
    def download(group, chans, t, t2):
        calls.append((t, t2))
        rows, m = [], t.replace(second=0) + timedelta(minutes=1)
        while m < t2:
            rows.append([m.strftime("%d.%m.%Y"), m.strftime("%H:%M:%S"), "+0000", "1.0"])
            m += timedelta(minutes=1)
        return (["date", "time", "tz", "A"], rows)
    portal = type("Portal", (), {"__init__": lambda s, c: None, "ensure": lambda s: None, "save": lambda s: None,
                                 "download": lambda s, *a: download(*a)})
    fake = types.SimpleNamespace(Portal=portal, load_config=lambda p: {"live_dir": str(tmp_path)}, load_extra=lambda: [],
                                 parse_csv=lambda x: x, file_channels=lambda p: ["A"])
    monkeypatch.setitem(sys.modules, "portal_collector", fake)
    sys.modules.pop("fill_gaps", None)
    import fill_gaps
    return fill_gaps


def _write(tmp_path, day, minutes):
    with open(tmp_path / f"iv2_live_{day:%Y%m%d}.csv", "w", newline="", encoding="latin-1") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["date", "time", "tz", "A"])
        w.writerow(["", "", "", "MW"])
        for mm in minutes:
            t = datetime(day.year, day.month, day.day) + timedelta(minutes=mm)
            w.writerow([t.strftime("%d.%m.%Y"), t.strftime("%H:%M:%S"), "+0000", "1"])


def _rows(tmp_path, day):
    p = tmp_path / f"iv2_live_{day:%Y%m%d}.csv"
    return sum(1 for _ in open(p)) - 2 if p.exists() else None


def test_gap_filler_edges_and_missing_day(tmp_path, monkeypatch):
    calls = []
    F = _fake_portal(monkeypatch, tmp_path, calls)
    today = datetime.now(timezone.utc).replace(tzinfo=None).date()
    d1, d2, d3 = (today - timedelta(days=i) for i in (1, 2, 3))
    _write(tmp_path, today, range(0, 10))
    _write(tmp_path, d1, range(0, 1440))
    _write(tmp_path, d3, range(0, 600))                         # stops at 10:00: gap at the end of the day
    monkeypatch.setattr(sys, "argv", ["x", "--auto", "--files", "iv2"])
    for _ in range(4):                                          # hourly runs; each has a download budget
        F.main()
    assert _rows(tmp_path, d2) and _rows(tmp_path, d2) > 1400   # missing day created and filled
    assert _rows(tmp_path, d3) > 1400                           # end-of-day gap filled
    assert _rows(tmp_path, d1) == 1440                          # complete day untouched
    first = [c for c in calls][0][0].date()
    assert first == today                                       # newest day first


def test_gap_filler_gives_up_after_two_tries(tmp_path, monkeypatch):
    calls = []
    F = _fake_portal(monkeypatch, tmp_path, calls)
    import portal_collector as P
    P.Portal.download = lambda s, *a: (calls.append(1), (["date", "time", "tz", "A"], []))[1]   # logger has nothing
    today = datetime.now(timezone.utc).replace(tzinfo=None).date()
    for i in range(0, 8):
        _write(tmp_path, today - timedelta(days=i), range(0, 1440) if i else range(0, 1440 * 0 + 5))
    d = today - timedelta(days=2)
    _write(tmp_path, d, list(range(0, 600)) + list(range(700, 1440)))       # 100-minute hole the logger lost
    monkeypatch.setattr(sys, "argv", ["x", "--auto", "--files", "iv2"])
    n = []
    for _ in range(4):
        before = len(calls)
        F.main()
        n.append(len(calls) - before)
    assert n[2] < n[0] and n[3] == n[2]                         # the lost hole stops being retried after two runs


# ---------------------------------------------------------------- daily self-check
def test_health_check_reports_gaps_and_missing_files(tmp_path):
    import health_check as H
    day = datetime(2026, 11, 26).date()
    _write(tmp_path, day, list(range(0, 13 * 60 + 41)) + list(range(22 * 60, 1440)))   # stops 13:41, like 26 Nov
    now = datetime(2026, 11, 27, 9, 0, tzinfo=timezone.utc)
    lines = H.check(str(tmp_path), now, days=1)
    d = [l for l in lines if "2026-11-26" in l and l.split()[1] == "Data"][0]
    assert d.startswith("FAIL") and "longest 13:41 for 319 min" in d and "iv1 no file" in d
    _w = [l for l in lines if "DC string check" in l][0]
    assert _w.startswith("WARN")
