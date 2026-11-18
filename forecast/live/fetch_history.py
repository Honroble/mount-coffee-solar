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


def naive(t):
    return t.replace(tzinfo=None)


def fetch_day(p, group, chans, day, hours, pause):
    """One day in pieces of `hours`; keeps the header from the first piece only."""
    parts, t = [], day
    while t < day + timedelta(days=1):
        e = min(t + timedelta(hours=hours), day + timedelta(days=1)) - timedelta(seconds=1)
        txt = p.download(group, chans, naive(t), naive(e))
        lines = [l for l in txt.splitlines() if l.strip()]
        if parts and lines:
            lines = [l for l in lines[1:] if not l.startswith("[")]   # drop repeated header and units row
        parts.extend(lines)
        t += timedelta(hours=hours)
        time.sleep(pause / 2)
    return "\n".join(parts) + "\n"


def probe(p, a):
    chans = ["Information.Inverter sum P", "Active Power.Frequency", "STS1.INV01.active_power_total"]
    start = datetime.strptime(a.start, "%Y-%m-%d")
    for d in [start, start + timedelta(days=60), datetime(2026, 9, 17), datetime(2026, 11, 1),
              datetime.utcnow().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)]:
        b = d.replace(hour=12) if d.hour == 0 else d
        try:
            txt = p.download("iv2", chans, b, b + timedelta(hours=1))
            lines = txt.splitlines()
            print(f"{b:%Y-%m-%d %H:%M}: {len(txt)} bytes, {len(lines)} lines | first: {lines[:2]} | last: {lines[-1:]}"[:400])
        except Exception as e:
            print(f"{b:%Y-%m-%d %H:%M}: FAILED {e}"[:300])
        time.sleep(a.pause)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--from", dest="start", required=True, help="first day, YYYY-MM-DD")
    ap.add_argument("--to", dest="end", required=True, help="last day, YYYY-MM-DD")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between downloads (be gentle with the logger)")
    ap.add_argument("--hours", type=int, default=6, help="hours per download (the logger may refuse long requests)")
    ap.add_argument("--probe", action="store_true", help="try one hour of 3 channels on a few dates and show what the logger returns")
    a = ap.parse_args()
    cfg = load_config(a.config)
    data = os.path.normpath(os.path.join(cfg["live_dir"], ".."))
    groups = {}
    for m in load_map():
        groups.setdefault(m["group"], []).append(m["local_channel"])
    p = Portal(cfg)
    p.ensure()
    if a.probe:
        probe(p, a)
        return
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
                text = fetch_day(p, group, chans, day, a.hours, a.pause)
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
