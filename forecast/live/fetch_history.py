"""Download past 1-minute logger data (read-only) from the Gantner portal, one day per file.

  python live\\fetch_history.py --from 2026-03-23 --to 2026-09-16

Writes data\\iv2_YYYYMMDD_hist.csv (plant, stations, inverters) and data\\iv1_YYYYMMDD_hist.csv (weather station)
for each day, using the same channels as the live collector (channel_map.csv). Days already downloaded are skipped,
so it can be stopped and run again. retrain_monthly.py picks these files up automatically (data\\iv2_2026*.csv).
It only reads from the logger; nothing is changed there.
"""
import argparse
import os
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import Portal, load_config, load_map  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--from", dest="start", required=True, help="first day, YYYY-MM-DD")
    ap.add_argument("--to", dest="end", required=True, help="last day, YYYY-MM-DD")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between downloads (be gentle with the logger)")
    a = ap.parse_args()
    cfg = load_config(a.config)
    data = os.path.normpath(os.path.join(cfg["live_dir"], ".."))
    groups = {}
    for m in load_map():
        groups.setdefault(m["group"], []).append(m["local_channel"])
    p = Portal(cfg)
    p.ensure()
    day = datetime.strptime(a.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    last = datetime.strptime(a.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    done = skipped = failed = 0
    while day <= last:
        for group, chans in groups.items():
            out = os.path.join(data, f"{group}_{day:%Y%m%d}_hist.csv")
            if os.path.exists(out) and os.path.getsize(out) > 2000:
                skipped += 1
                continue
            try:
                text = p.download(group, chans, day, day + timedelta(days=1) - timedelta(seconds=1))
                rows = text.count("\n")
                if rows < 10:
                    print(f"{day:%Y-%m-%d} {group}: no data on the logger for this day")
                    failed += 1
                    continue
                tmp = out + ".tmp"
                with open(tmp, "w", encoding="latin-1", newline="") as fh:
                    fh.write(text)
                os.replace(tmp, out)
                done += 1
                print(f"{day:%Y-%m-%d} {group}: {rows} rows")
            except Exception as e:
                failed += 1
                print(f"{day:%Y-%m-%d} {group}: FAILED {e}"[:300])
            time.sleep(a.pause)
        p.save()
        day += timedelta(days=1)
    print(f"Done: {done} files downloaded, {skipped} already there, {failed} missing or failed. Files in {data}")


if __name__ == "__main__":
    main()
