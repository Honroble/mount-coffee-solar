"""Daily string check (read-only): compare the DC string currents of every inverter around midday.

  python live\\string_check.py                 today, 11:30-13:30 GMT
  python live\\string_check.py --date 2026-11-21

Downloads dc_current_string_01..32 of all 52 inverters for the window (one station at a time), averages each string
over the minutes when its inverter was producing well, and classifies each string against the other strings of the
same inverter:
  dead     below 0.1 A while the inverter's typical string carries more than 2 A
  weak     below 70 % of the inverter's typical (median) string
  unused   a string position that is ~0 on most inverters of the station (not wired by design)
Writes data/live/string_check_YYYYMMDD.json and string_check_latest.json, and prints a summary.
Run daily by alerts.py after 14:00 GMT. Nothing is changed on the logger.
"""
import argparse
import json
import os
import re
import statistics
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import Portal, load_config, parse_csv  # noqa: E402

N_STRINGS = 32


def inverters():
    names = []
    path = os.path.join(HERE, "channel_map.csv")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.search(r"(STS\d\.INV\d+)\.active_power_total", line)
            if m:
                names.append(m.group(1))
    return names


def fnum(s):
    try:
        v = float(s)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--date", help="YYYY-MM-DD (default today, GMT)")
    ap.add_argument("--from-time", default="11:30")
    ap.add_argument("--to-time", default="13:30")
    a = ap.parse_args()
    cfg = load_config(a.config)
    day = datetime.strptime(a.date, "%Y-%m-%d") if a.date else datetime.now(timezone.utc).replace(tzinfo=None)
    beg = datetime.strptime(f"{day:%Y-%m-%d} {a.from_time}", "%Y-%m-%d %H:%M")
    end = datetime.strptime(f"{day:%Y-%m-%d} {a.to_time}", "%Y-%m-%d %H:%M")
    p = Portal(cfg)
    p.ensure()
    invs = inverters()
    result = {"date": f"{day:%Y-%m-%d}", "window_gmt": f"{a.from_time}-{a.to_time}", "inverters": {}}
    for sts in sorted({i.split(".")[0] for i in invs}):
        group = [i for i in invs if i.startswith(sts + ".")]
        chans = [f"{i}.active_power_total" for i in group] + \
                [f"{i}.dc_current_string_{k:02d}" for i in group for k in range(1, N_STRINGS + 1)]
        header, body = parse_csv(p.download("iv2", chans, beg, end))
        idx = {h: n for n, h in enumerate(header)}
        for inv in group:
            ip = idx.get(f"{inv}.active_power_total")
            rows = [r for r in body if ip is not None and ip < len(r) and (fnum(r[ip]) or 0) > 100]   # inverter above 100 kW
            means = []
            for k in range(1, N_STRINGS + 1):
                ic = idx.get(f"{inv}.dc_current_string_{k:02d}")
                vals = [fnum(r[ic]) for r in rows if ic is not None and ic < len(r)]
                vals = [v for v in vals if v is not None]
                means.append(round(sum(vals) / len(vals), 2) if vals else None)
            result["inverters"][inv] = {"minutes": len(rows), "strings": means}
    # strings unused by design: ~0 on most inverters of a station
    unused = {}
    for sts in sorted({i.split(".")[0] for i in invs}):
        ii = [v for k, v in result["inverters"].items() if k.startswith(sts + ".") and v["minutes"] >= 10]
        for k in range(N_STRINGS):
            zero = sum(1 for v in ii if v["strings"][k] is not None and v["strings"][k] < 0.1)
            if ii and zero >= 0.8 * len(ii):
                unused.setdefault(sts, []).append(k + 1)
    result["unused_by_station"] = unused
    findings = []
    for inv, v in result["inverters"].items():
        sts = inv.split(".")[0]
        live = [(k + 1, c) for k, c in enumerate(v["strings"]) if c is not None and (k + 1) not in unused.get(sts, [])]
        if v["minutes"] < 10 or len(live) < 3:
            v["status"] = "not enough sun / data"
            continue
        med = statistics.median(c for _, c in live)
        v["median_a"] = round(med, 2)
        v["dead"] = [k for k, c in live if c < 0.1 and med > 2]
        v["weak"] = [k for k, c in live if 0.1 <= c < 0.7 * med]
        v["used_strings"] = len(live)
        if v["dead"] or v["weak"]:
            findings.append(f"{inv}: " + ", ".join(
                ([f"dead {v['dead']}"] if v["dead"] else []) + ([f"weak {v['weak']}"] if v["weak"] else [])) +
                f" (typical string {med:.1f} A, {len(live)} strings)")
    result["findings"] = findings
    result["checked_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    live_dir = cfg["live_dir"]
    for name in (f"string_check_{day:%Y%m%d}.json", "string_check_latest.json"):
        with open(os.path.join(live_dir, name), "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=1)
    p.save()
    print(f"String check {day:%Y-%m-%d} {a.from_time}-{a.to_time} GMT: {len(result['inverters'])} inverters")
    print("Unused string positions by station:", unused or "none")
    print(f"{len(findings)} inverters with dead or weak strings:" if findings else "No dead or weak strings found.")
    for f in findings:
        print("  ", f)


if __name__ == "__main__":
    main()
