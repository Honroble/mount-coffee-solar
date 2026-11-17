"""Near-real-time values for the dashboard: reads the logger homepage gauges every 10 seconds.

The logger's data files reach the portal in batches (1-5 minutes late), so the collector's minute rows lag.
The homepage gauges (widget_update.json) are live, so this script polls them:
  - PV sum, STS1-STS4 power, zone sensors (irradiance, temperatures), power limit
  - writes data/live/widget_now.json (latest values, read by the dashboard's /api/now)
  - appends data/live/now_YYYYMMDD.csv (one row per poll, for the live chart)

Read-only: it only reads the same page you see at .../cgi-bin/start.
Task "MCSolar Live Now" starts it every minute; each run polls for 55 seconds (6 reads), so no
long-running process has to be watched. Run by hand:  python live\\live_poller.py --seconds 30
"""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import Portal, load_config, read_widgets  # noqa: E402

FIELDS = ["time_utc", "pv_sum_mw", "sts1_kw", "sts2_kw", "sts3_kw", "sts4_kw",
          "zoneA_ghi_wm2", "zone4_ghi_wm2", "zoneA_tmod_c", "zone4_tmod_c", "power_limit_user_pct"]


def write_now(live, w):
    tmp = os.path.join(live, "widget_now.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(w, fh)
    os.replace(tmp, os.path.join(live, "widget_now.json"))   # atomic: the dashboard never reads half a file
    day = w["time_utc"][:10].replace("-", "")
    path = os.path.join(live, f"now_{day}.csv")
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        if new:
            wr.writerow(FIELDS)
        wr.writerow(["" if w.get(k) is None else w.get(k) for k in FIELDS])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--seconds", type=int, default=55, help="how long this run keeps polling")
    ap.add_argument("--every", type=int, default=10, help="seconds between reads")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    os.makedirs(live, exist_ok=True)
    end = time.monotonic() + a.seconds
    p, errors = None, 0
    while True:
        t0 = time.monotonic()
        try:
            if p is None:
                p = Portal(cfg)
                p.ensure()
            w = read_widgets(p, cfg)
            if w.get("pv_sum_mw") is None and w.get("sts1_kw") is None:
                raise RuntimeError("logger homepage returned no values (session expired?)")
            write_now(live, w)
            errors = 0
        except Exception as e:
            errors += 1
            p = None   # sign in again next time
            if errors == 1:
                with open(os.path.join(live, "collector_log.txt"), "a", encoding="utf-8") as fh:
                    fh.write(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC  live poller: {e}\n")
        if p is not None:
            try:
                p.save()
            except Exception:
                pass
        left = end - time.monotonic()
        if left < a.every:
            break
        time.sleep(max(0, a.every - (time.monotonic() - t0)))


if __name__ == "__main__":
    main()
