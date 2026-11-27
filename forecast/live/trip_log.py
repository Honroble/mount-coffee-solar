"""
Trip log: finds plant and station trips in the logger's 1-minute files and logs them to the Google Sheet.

A trip is a minute when at least 80 % of the plant's (or one station's) inverters go to Fault / Emergency stop
while they had been producing (more than 1 MW plant-wide, or 0.2 MW for one station, in the 5 minutes before).
Morning start-up faults (for example the insulation alarms before sunrise) are therefore not counted.

For each trip it records the trip and restore times (GMT), duration, the inverter alarm that caused it, grid
frequency around the trip (P07), the 22 kV breaker states, output just before, and an estimate of the energy lost
(output before the trip, scaled by irradiance through the outage).

Output: data/live/trips.csv (kept on the PC), and
  - the "Trips" tab of the Google Sheet (whole table, action "replace"; needs 'Trips' in REPLACEABLE in the Apps Script)
  - one "trip" notification per new trip (Alerts tab + e-mail to ALERT_TO), so it is logged even before the tab exists

Reads only files already on the PC; never connects to the logger.

  python live\\trip_log.py            # yesterday and today, post new trips
  python live\\trip_log.py --all      # every day with inverter files (backfill)
  python live\\trip_log.py --dry-run  # print, send nothing
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import load_config  # noqa: E402

FAULT = {0x5500, 0x1500}
RUN = {0x0000, 0x8100, 0x8200, 0x9100}
ALARMS = {2: "Grid overvoltage", 3: "Grid transient overvoltage", 4: "Grid undervoltage", 5: "Grid low voltage",
          7: "AC instantaneous overcurrent", 8: "Grid over-frequency", 9: "Grid under-frequency", 10: "Grid power outage",
          12: "Excessive leakage current", 13: "Grid abnormal", 14: "10-minute grid overvoltage", 15: "Grid overvoltage",
          16: "Output overload", 17: "Grid voltage unbalance", 39: "Low insulation resistance", 106: "Grounding cable fault"}
FIELDS = ["date", "trip_utc", "restored_utc", "duration_min", "scope", "inverters_tripped", "cause", "alarm_codes",
          "freq_min_hz", "freq_max_hz", "breakers", "mw_before", "energy_lost_mwh_est", "logged_utc"]
FEEDERS = ["P07 (OUTGOING FEEDER )", "P01 - MVSTS 1..2", "P04 - MVSTS 3..5"]


def num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def read(live, prefix, ymd):
    f = os.path.join(live, f"{prefix}_live_{ymd}.csv")
    if not os.path.exists(f):
        return None, {}
    with open(f, encoding="latin-1", newline="") as fh:
        rows = list(csv.reader(fh, delimiter=";"))
    if len(rows) < 3:
        return None, {}
    head, out = rows[0], {}
    for r in rows[2:]:
        t = (r[1] if len(r) > 1 else "")[:5]
        if t and t not in out:
            out[t] = r
    return head, out


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def day_trips(live, date):
    ymd = date.strftime("%Y%m%d")
    ih, inv = read(live, "inv", ymd)
    ph, pv = read(live, "iv2", ymd)
    gh, grid = read(live, "grid", ymd)
    wh, wx = read(live, "iv1", ymd)
    if not ih or not ph:
        return []
    names = [h[:-len(".work_state_01")] for h in ih if h.endswith(".work_state_01")]
    cs = {n: ih.index(f"{n}.work_state_01") for n in names}
    ca = {n: ih.index(f"{n}.alarm_code") for n in names if f"{n}.alarm_code" in ih}
    cp = {n: ph.index(f"{n}.active_power_total") for n in names if f"{n}.active_power_total" in ph}
    groups = {"plant": names}
    for n in names:
        groups.setdefault(n.split(".")[0], []).append(n)
    fi = gh.index(f"{FEEDERS[0]}.Frequency") if gh and f"{FEEDERS[0]}.Frequency" in gh else -1
    gi = [wh.index(c) for c in ("FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated",
                                "FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated") if wh and c in wh]

    def state(n, t):
        r = inv.get(t)
        v = num(r[cs[n]]) if r else None
        return None if v is None else int(v)

    def kw(ns, t):
        r = pv.get(t)
        if not r:
            return None
        vals = [num(r[cp[n]]) for n in ns if n in cp]
        vals = [v for v in vals if v is not None]
        return sum(max(0.0, v) for v in vals) if vals else None

    def irr(t):
        r = wx.get(t)
        if not r:
            return None
        v = [num(r[i]) for i in gi]
        v = [x for x in v if x is not None and x >= 0]
        return sum(v) / len(v) if v else None

    trips, busy = [], set()
    for scope in ["plant"] + sorted(k for k in groups if k != "plant"):
        ns = groups[scope]
        need_kw = 1000 if scope == "plant" else 200
        m = 5
        while m < 1440:
            t, tp = hhmm(m), hhmm(m - 1)
            st = [state(n, t) for n in ns]
            known = [s for s in st if s is not None]
            if len(known) < 0.8 * len(ns):
                m += 1
                continue
            nf = sum(1 for s in known if s in FAULT)
            nf_prev = sum(1 for n in ns if state(n, tp) in FAULT)
            before = [kw(ns, hhmm(x)) for x in range(m - 5, m)]
            before = [b for b in before if b is not None]
            if nf >= 0.8 * len(ns) and nf_prev < 0.5 * len(ns) and before and max(before) > need_kw:
                if scope != "plant" and any(a0 - 3 <= m <= a1 + 3 for a0, a1 in busy):   # part of a plant trip
                    m += 1
                    continue
                # restore: first minute with half the group back in Run (or producing again)
                end = None
                for x in range(m + 1, 1440):
                    sx = [state(n, hhmm(x)) for n in ns]
                    k = kw(ns, hhmm(x))
                    if sum(1 for s in sx if s in RUN) >= 0.5 * len(ns) or (k is not None and k > 0.5 * max(before)):
                        end = x
                        break
                codes = {}
                for x in range(m - 1, m + 3):
                    r = inv.get(hhmm(x))
                    for n in ns:
                        c = num(r[ca[n]]) if r and n in ca else None
                        if c:
                            codes[int(c)] = codes.get(int(c), 0) + 1
                top = max(codes, key=codes.get) if codes else None
                freqs = []
                for x in range(m - 3, m + 3):
                    r = grid.get(hhmm(x))
                    f = num(r[fi]) if r and fi >= 0 else None
                    if f is not None and f > 40:
                        freqs.append(f)
                brk = []
                r = grid.get(t)
                if r and gh:
                    for fd in FEEDERS:
                        on, off = f"{fd}.C.B ON", f"{fd}.C.B OFF"
                        if on in gh and off in gh:
                            brk.append(f"{fd[:3]} {'open' if num(r[gh.index(off)]) == 1 else 'closed' if num(r[gh.index(on)]) == 1 else '?'}")
                g0 = irr(tp) or irr(hhmm(m - 2))
                mw0 = max(before) / 1000
                lost = 0.0
                for x in range(m, end if end else min(1440, m + 120)):
                    g = irr(hhmm(x))
                    k = kw(ns, hhmm(x)) or 0.0
                    exp = mw0 * 1000 * (g / g0 if g is not None and g0 else 1.0)
                    lost += max(0.0, exp - k) / 60
                trips.append({
                    "date": date.isoformat(), "trip_utc": f"{date.isoformat()} {t}",
                    "restored_utc": f"{date.isoformat()} {hhmm(end)}" if end else "",
                    "duration_min": (end - m) if end else "", "scope": scope, "inverters_tripped": nf,
                    "cause": ALARMS.get(top, f"alarm code {top}") if top else "no alarm code reported",
                    "alarm_codes": " ".join(f"{c}x{n}" for c, n in sorted(codes.items(), key=lambda z: -z[1])),
                    "freq_min_hz": round(min(freqs), 2) if freqs else "", "freq_max_hz": round(max(freqs), 2) if freqs else "",
                    "breakers": ", ".join(brk), "mw_before": round(mw0, 2), "energy_lost_mwh_est": round(lost / 1000, 2),
                })
                if scope == "plant":
                    busy.add((m, end if end else m + 120))
                m = (end or m + 30) + 1
                continue
            m += 1
    return trips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--all", action="store_true", help="scan every day with inverter files")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    now = datetime.now(timezone.utc)
    if a.all:
        days = sorted({f[9:17] for f in os.listdir(live) if f.startswith("inv_live_") and f.endswith(".csv")})
        dates = [datetime.strptime(d, "%Y%m%d").date() for d in days]
    else:
        dates = [(now - timedelta(days=1)).date(), now.date()]
    path = os.path.join(live, "trips.csv")
    old = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                old[(r["trip_utc"], r["scope"])] = r
    new, changed = [], False
    for d in dates:
        found = day_trips(live, d)
        keys = {(t["trip_utc"], t["scope"]) for t in found}
        for k in [k for k, r in old.items() if r.get("date") == d.isoformat() and k not in keys]:
            del old[k]                   # no longer a separate trip (e.g. a station trip inside a plant trip)
            changed = True
        for t in found:
            key = (t["trip_utc"], t["scope"])
            prev = old.get(key)
            t["logged_utc"] = prev["logged_utc"] if prev else now.strftime("%Y-%m-%d %H:%M")
            if not prev:
                new.append(t)
            if not prev or any(str(prev.get(k, "")) != str(t[k]) for k in FIELDS if k != "logged_utc"):
                changed = True
            old[key] = t
    rows = sorted(old.values(), key=lambda r: r["trip_utc"], reverse=True)
    for t in new:
        print(f"NEW TRIP {t['trip_utc']} {t['scope']}: {t['cause']}, {t['inverters_tripped']} inverters, "
              f"restored {t['restored_utc'] or 'not yet'}, ~{t['energy_lost_mwh_est']} MWh lost")
    if a.dry_run:
        print(f"{len(rows)} trips on file, {len(new)} new (dry run, nothing written or sent)")
        return
    if changed:
        with open(path, "w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, "") for k in FIELDS})
    from alerts import post
    log = []
    flag = os.path.join(live, "trips_sheet_sent.txt")      # exists once the Trips tab has accepted the current table
    if changed and os.path.exists(flag):
        os.remove(flag)
    if rows and not os.path.exists(flag):
        res = post(cfg, {"action": "replace", "sheet": "Trips", "header": FIELDS,
                         "rows": [[r.get(k, "") for k in FIELDS] for r in rows[:2000]]})
        if '"ok":true' in res.replace(" ", ""):
            with open(flag, "w", encoding="utf-8") as fh:
                fh.write(now.isoformat())
        if changed or '"ok":true' in res.replace(" ", ""):
            log.append(f"Trips tab: {res}")
    def describe(t):
        dur = f" ({t['duration_min']} min)" if t["duration_min"] != "" else ""
        return (f"{t['trip_utc']} GMT, {t['scope']}: {t['cause']} ({t['inverters_tripped']} inverters). "
                f"Grid frequency at P07 {t['freq_min_hz']}-{t['freq_max_hz']} Hz. Breakers: {t['breakers'] or 'n/a'}. "
                f"Output before {t['mw_before']} MW. Restored {t['restored_utc'][-5:] or 'not yet'}{dur}. "
                f"Estimated energy lost {t['energy_lost_mwh_est']} MWh.")
    if len(new) > 2:   # backfill or a burst: one combined notice instead of many e-mails
        res = post(cfg, {"action": "notify", "kind": "trip", "subject": f"Mount Coffee solar: {len(new)} trips logged",
                         "text": "Trips found in the logger data:\n" + "\n".join("- " + describe(t) for t in sorted(new, key=lambda z: z["trip_utc"]))})
        log.append(f"trip notice ({len(new)} trips): {res}")
    else:
        for t in new:
            res = post(cfg, {"action": "notify", "kind": "trip",
                             "subject": f"Mount Coffee solar TRIP {t['trip_utc']} GMT ({t['scope']})",
                             "text": "PLANT TRIP at Mount Coffee solar: " + describe(t)})
            log.append(f"trip notice {t['trip_utc']} {t['scope']}: {res}")
    if log:
        with open(os.path.join(live, "alerts_log.txt"), "a", encoding="utf-8") as fh:
            for line in log:
                fh.write(f"{now:%Y-%m-%d %H:%M} {line}\n")
        print("\n".join(log))
    print(f"{len(rows)} trips on file, {len(new)} new")


if __name__ == "__main__":
    main()
