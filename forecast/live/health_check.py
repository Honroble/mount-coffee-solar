"""
Self-check of the monitoring system itself: is the data complete and did every job run?

Added to the morning report (agent_report.py) and printed by:
    python live\\health_check.py            # yesterday and today so far
    python live\\health_check.py --days 7   # the last 7 days

Checks (read-only; looks only at files on this PC and the Windows task list):
  - missing daylight minutes (06:00-19:00 GMT) per data file and day, with the longest gap
  - plant data / forecast / live readings stopped (age of the newest data)
  - "MCSolar ..." scheduled tasks disabled, or their last run failed
  - last model retrain (older than 30 days, or a model failed / was skipped)
  - DC string check ran, trip log, Verification integrity, logger disk and channel errors
Each line starts with OK, WARN or FAIL.
"""
import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

FILES = ["iv2", "iv1", "grid", "ctrl", "inv"]
DAY_START, DAY_END = 6 * 60, 19 * 60
TASK_PREFIX = "MCSolar"


def day_minutes(path):
    """Set of saved minutes of the day (minute of day) in a logger CSV (date;time;tz;...)."""
    out = set()
    try:
        with open(path, encoding="latin-1", newline="") as fh:
            r = csv.reader(fh, delimiter=";")
            next(r, None)
            next(r, None)
            for row in r:
                if len(row) > 1 and len(row[1]) >= 5:
                    try:
                        out.add(int(row[1][:2]) * 60 + int(row[1][3:5]))
                    except ValueError:
                        pass
    except OSError:
        return None
    return out


def missing_report(live, day, upto=None):
    """[(prefix, missing daylight minutes, longest gap (start, minutes))] for one day."""
    end = DAY_END if upto is None else min(DAY_END, upto)
    res = []
    for p in FILES:
        have = day_minutes(os.path.join(live, f"{p}_live_{day:%Y%m%d}.csv"))
        if have is None:
            res.append((p, max(0, end - DAY_START), (DAY_START, max(0, end - DAY_START)), True))
            continue
        miss = [m for m in range(DAY_START, end) if m not in have]
        longest, run_s, run_n = (None, 0), None, 0
        prev = None
        for m in miss:
            if prev is not None and m == prev + 1:
                run_n += 1
            else:
                run_s, run_n = m, 1
            if run_n > longest[1]:
                longest = (run_s, run_n)
            prev = m
        res.append((p, len(miss), longest, False))
    return res


def hm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def tasks():
    """{task name: (state, last result)} for MCSolar tasks (Windows only; {} elsewhere)."""
    if os.name != "nt":
        return {}
    try:
        out = subprocess.run(["schtasks", "/Query", "/FO", "CSV", "/V"], capture_output=True, text=True, timeout=60,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except Exception:
        return {}
    rows = list(csv.reader(out.splitlines()))
    if not rows:
        return {}
    head = rows[0]
    ix = {k: head.index(k) for k in ("TaskName", "Scheduled Task State", "Last Result") if k in head}
    found = {}
    for r in rows[1:]:
        if len(r) != len(head) or "TaskName" not in ix:
            continue
        name = r[ix["TaskName"]].lstrip("\\")
        if name.startswith(TASK_PREFIX):
            found[name] = (r[ix["Scheduled Task State"]] if "Scheduled Task State" in ix else "",
                           r[ix["Last Result"]] if "Last Result" in ix else "")
    return found


def age_min(now, t):
    return int((now - t).total_seconds() // 60)


def check(live, now=None, days=1):
    now = now or datetime.now(timezone.utc)
    lines = []

    def add(level, text):
        lines.append(f"{level:<4} {text}")

    # 1. data completeness
    today = now.date()
    for i in range(days, -1, -1):
        d = today - timedelta(days=i)
        upto = (now.hour * 60 + now.minute - 3) if d == today else None
        if upto is not None and upto <= DAY_START:
            continue
        rep = missing_report(live, d, upto)
        bad = [(p, n, lg, nofile) for p, n, lg, nofile in rep if n > 5]
        span = f"06:00-{hm(upto) if upto is not None and upto < DAY_END else '19:00'}"
        if not bad:
            add("OK", f"Data {d} ({span}): complete in all 5 files")
        else:
            worst = max(n for _, n, _, _ in bad)
            parts = []
            for p, n, lg, nofile in bad:
                parts.append(f"{p} {'no file' if nofile else f'{n} min missing, longest {hm(lg[0])} for {lg[1]} min'}")
            add("FAIL" if worst >= 60 else "WARN", f"Data {d} ({span}): " + "; ".join(parts))
    # 2. newest data / forecast / live readings
    daytime = 7 <= now.hour < 18
    try:
        mins = day_minutes(os.path.join(live, f"iv2_live_{today:%Y%m%d}.csv")) or set()
        last = max(mins) if mins else None
        if daytime:
            if last is None:
                add("FAIL", "Plant data: nothing saved today")
            else:
                lag = now.hour * 60 + now.minute - last
                add("OK" if lag <= 15 else "FAIL", f"Plant data: newest minute {hm(last)} GMT ({lag} min ago)")
    except Exception as e:
        add("WARN", f"Plant data: could not read ({e})")
    try:
        with open(os.path.join(live, "forecast_log.csv"), encoding="utf-8") as fh:
            last = fh.readlines()[-1].split(",")[0]
        t = datetime.strptime(last, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        if daytime:
            add("OK" if age_min(now, t) <= 15 else "FAIL", f"Forecast: last issued {last[11:]} GMT ({age_min(now, t)} min ago)")
    except Exception:
        add("WARN", "Forecast: no forecast log")
    # 3. scheduled tasks
    ts = tasks()
    if ts:
        off = [n for n, (st, _) in ts.items() if st.lower().startswith("disabled")]
        failed = [f"{n} (result {res})" for n, (st, res) in ts.items()
                  if res not in ("0", "267009", "267011", "267014", "") and not st.lower().startswith("disabled")]
        if off:
            add("FAIL", "Scheduled tasks DISABLED: " + ", ".join(sorted(off)) + " (enable them in Task Scheduler as admin)")
        if failed:
            add("WARN", "Scheduled tasks whose last run failed: " + ", ".join(sorted(failed)))
        if not off and not failed:
            add("OK", f"Scheduled tasks: all {len(ts)} MCSolar tasks enabled, last runs OK")
    # 4. retrain
    st = os.path.join(live, "retrain_state.json")
    lg = os.path.join(live, "retrain_log.txt")
    try:
        if os.path.exists(st):
            s = json.load(open(st, encoding="utf-8"))
            t = datetime.strptime(s["last_run_utc"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            ok = s.get("all_ok", True) and s.get("satellite", True)
        else:
            t = datetime.fromtimestamp(os.path.getmtime(lg), timezone.utc)
            with open(lg, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()[-4000:]
            ok = "FAILED" not in txt and "not retrained" not in txt
        d = (now - t).days
        if d > 30:
            add("WARN", f"Model retrain: last {t:%Y-%m-%d}, {d} days ago (due every 4 weeks)")
        elif not ok:
            add("WARN", f"Model retrain {t:%Y-%m-%d}: a model failed or was skipped - see data\\live\\retrain_log.txt")
        else:
            add("OK", f"Model retrain: last {t:%Y-%m-%d} ({d} days ago)")
    except Exception:
        add("WARN", "Model retrain: no record found")
    # 5. string check, trips, verification, logger
    y = today - timedelta(days=1)
    add("OK" if os.path.exists(os.path.join(live, f"string_check_{y:%Y%m%d}.json")) else "WARN",
        f"DC string check for {y}: {'done' if os.path.exists(os.path.join(live, f'string_check_{y:%Y%m%d}.json')) else 'missing'}")
    try:
        with open(os.path.join(live, "trips.csv"), encoding="utf-8") as fh:
            rows = [r for r in csv.DictReader(fh) if r.get("date") == y.isoformat() and r.get("scope") == "plant"]
        add("WARN" if rows else "OK", f"Trips {y}: {len(rows)} plant trip(s)" +
            (" - " + ", ".join(f"{r['trip_utc'][11:]} {r['cause']}" for r in rows) if rows else ""))
    except Exception:
        pass
    try:
        v = json.load(open(os.path.join(live, "verification.json"), encoding="utf-8"))
        i = v.get("integrity", {})
        add("OK" if i.get("status") == "ok" else "FAIL", f"Verification records: {i.get('status')} ({i.get('sealed_days')} days sealed)")
    except Exception:
        pass
    try:
        w = json.load(open(os.path.join(live, "widget_latest.json"), encoding="utf-8"))
        du, ce = w.get("disk_used_pct"), w.get("channel_errors")
        lvl = "FAIL" if (du or 0) >= 97 else "WARN" if (du or 0) >= 95 or (ce or 0) > 0 else "OK"
        add(lvl, f"Logger: disk {du} % used ({w.get('disk_free_mb')} MB free), {ce} channel errors")
    except Exception:
        pass
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--live", help="(testing) live folder")
    a = ap.parse_args()
    live = a.live
    if not live:
        from portal_collector import load_config
        live = load_config(a.config)["live_dir"]
    print("\n".join(check(live, days=a.days)))


if __name__ == "__main__":
    main()
