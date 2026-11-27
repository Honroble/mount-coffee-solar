"""
Fill gaps inside the 1-minute data files from the logger (read-only download, the same as the collector).

The collector only appends minutes after the last one saved, so a gap in the middle of a file (for example when the
portal refused connections from 12:45 to 13:41 GMT on 23 Nov 2026 and only some files caught up) stays there. This
finds missing minutes in each file for the given days, downloads just those spans from the logger (it keeps a few
weeks), and merges them in time order. Columns are taken from each file's own header; nothing is ever written to
the logger, and command channels are never requested.

  python live\\fill_gaps.py --date 2026-11-23            # all five files for that day
  python live\\fill_gaps.py --date 2026-11-23 --files grid inv ctrl
  python live\\fill_gaps.py --date 2026-11-23 --dry-run  # list the gaps, download nothing
  python live\\fill_gaps.py                               # yesterday and today
  python live\\fill_gaps.py --auto                        # as run by alerts.py: skips spans already tried twice
"""
import json
import argparse
import csv
import os
import re
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import Portal, load_config, load_extra, parse_csv, file_channels  # noqa: E402

FILES = ["iv2", "iv1", "grid", "ctrl", "inv"]
MIN_GAP = 2            # minutes missing in a row before a span is downloaded
CHUNK_H = 3            # longest span per download


def group_of(prefix):
    if prefix in ("iv1", "iv2"):
        return prefix
    for (fname, group) in load_extra():
        if fname == prefix:
            return group
    return None


def read_rows(path):
    with open(path, encoding="latin-1", newline="") as fh:
        rows = list(csv.reader(fh, delimiter=";"))
    return rows[0], rows[1], rows[2:]


def stamp(r):
    try:
        return datetime.strptime(r[0] + " " + r[1], "%d.%m.%Y %H:%M:%S")
    except Exception:
        return None


def find_gaps(day, body, now=None):
    """Missing spans (exclusive ends) in the day, including before the first and after the last saved minute.
    The end of today stops 5 minutes before now (the collector is still appending there)."""
    start = datetime(day.year, day.month, day.day) - timedelta(minutes=1)
    end = start + timedelta(days=1, minutes=1)
    now = now or datetime.utcnow()
    if end > now:
        end = now - timedelta(minutes=5)
    have = sorted({s.replace(second=0) for s in (stamp(r) for r in body) if s and s.date() == day})
    have = [start] + [t for t in have if start < t < end] + [end]
    if end <= start:
        return []
    gaps, prev = [], have[0]
    for t in have[1:]:
        if (t - prev).total_seconds() / 60 > MIN_GAP:
            gaps.append((prev, t))
        prev = t
    return gaps


def nearest_file(live, prefix, day):
    best = None
    for f in os.listdir(live):
        m = re.fullmatch(prefix + r"_live_(\d{8})\.csv", f)
        if m:
            d = abs((datetime.strptime(m.group(1), "%Y%m%d").date() - day).days)
            if best is None or d < best[0]:
                best = (d, os.path.join(live, f))
    return best[1] if best else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--date", action="append", help="YYYY-MM-DD (repeatable); default yesterday and today")
    ap.add_argument("--files", nargs="+", default=FILES, choices=FILES)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--auto", action="store_true", help="remember tried spans; give up on a span after 2 tries")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    today = datetime.utcnow().date()  # noqa: DTZ003
    days = [datetime.strptime(d, "%Y-%m-%d").date() for d in a.date] if a.date else [today - timedelta(days=1), today]
    sp = os.path.join(live, "fill_gaps_state.json")
    try:
        tried = json.load(open(sp, encoding="utf-8")) if a.auto else {}
    except Exception:
        tried = {}
    p = None
    for day in days:
        for prefix in a.files:
            path = os.path.join(live, f"{prefix}_live_{day:%Y%m%d}.csv")
            template = path
            if not os.path.exists(path):
                template = nearest_file(live, prefix, day)      # same channels as the nearest day's file
                if not template:
                    print(f"{prefix} {day}: no file, and no other {prefix} file to copy the channel list from")
                    continue
                print(f"{prefix} {day}: no file - will create it with the channels of {os.path.basename(template)}")
            head, units, body = read_rows(template)
            if template != path:
                body = []
            gaps = find_gaps(day, body)
            if a.auto:
                gaps = [g for g in gaps if tried.get(f"{prefix} {g[0]:%Y-%m-%d %H:%M}-{g[1]:%H:%M}", 0) < 2]
            if not gaps:
                print(f"{prefix} {day}: no gaps")
                continue
            span = ", ".join(f"{a0:%H:%M}-{b0:%H:%M}" for a0, b0 in gaps)
            print(f"{prefix} {day}: {len(gaps)} gap(s): {span}")
            if a.dry_run:
                continue
            group = group_of(prefix)
            chans = [c for c in (file_channels(template) or []) if not re.search(r"cmd|Execute|select|Cancel|operation", c, re.I)]
            if not group or not chans:
                print(f"  skipped: no logger group/channels for {prefix}")
                continue
            if p is None:
                p = Portal(cfg)
                p.ensure()
            seen = {stamp(r) for r in body}
            added = []
            for g0, g1 in gaps:
                k = f"{prefix} {g0:%Y-%m-%d %H:%M}-{g1:%H:%M}"
                tried[k] = tried.get(k, 0) + 1
                t = g0
                while t < g1:
                    t2 = min(g1, t + timedelta(hours=CHUNK_H))
                    try:
                        header, rows = parse_csv(p.download(group, chans, t, t2))
                    except Exception as e:
                        print(f"  {t:%H:%M}-{t2:%H:%M}: download failed ({str(e)[:120]})")
                        t = t2
                        continue
                    idx = {n: i for i, n in enumerate(header)}
                    for r in rows:
                        s = stamp(r)
                        if not s or s in seen or not (g0 < s < g1):
                            continue
                        vals = [(r[idx[c]] if c in idx and idx[c] < len(r) else "") for c in head[3:]]
                        if not any(v.strip() for v in vals):
                            continue
                        added.append([r[0], r[1], "+0000"] + vals)
                        seen.add(s)
                    t = t2
            if not added:
                print("  nothing new from the logger (it may no longer hold those minutes)")
                continue
            body = read_rows(path)[2] if os.path.exists(path) else []   # re-read: the collector may have appended
            have = {stamp(r) for r in body}
            merged = sorted(body + [r for r in added if stamp(r) not in have], key=lambda r: stamp(r) or datetime.min)
            tmp = path + ".tmp"
            with open(tmp, "w", newline="", encoding="latin-1", errors="replace") as fh:
                w = csv.writer(fh, delimiter=";")
                w.writerow(head)
                w.writerow(units)
                w.writerows(merged)
            os.replace(tmp, path)
            print(f"  added {len(added)} minutes")
    if a.auto and not a.dry_run:
        cutoff = (datetime.utcnow() - timedelta(days=10)).strftime("%Y-%m-%d")
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump({k: v for k, v in tried.items() if k.split(" ")[1] >= cutoff}, fh)
    if p is not None:
        try:
            p.save()
        except Exception:
            pass


if __name__ == "__main__":
    import threading
    _stop = threading.Timer(900, lambda: os._exit(3))   # never hang (the collector's tasks share the portal session)
    _stop.daemon = True
    _stop.start()
    main()
