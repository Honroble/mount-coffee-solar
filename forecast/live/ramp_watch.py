"""Fast solar drop alarms and the sky-state reserve for dispatch. Decision support only: the dispatcher decides.

Runs at the end of every live_poller.py run (every minute) on the 10-second readings in data/live/now_YYYYMMDD.csv.
Rules (from 58 days of 1-minute plant data, Sep-Nov 2026; review in the dry season):
  WATCH  output down >= 5 MW within 5 min                                      (about 2-3 a day; screen only)
  ALARM  down >= 8 MW within 5 min, or >= 10 MW within 15 min                   (about 1 a day; screen, sound, e-mail)
  TRIP   down >= 5 MW within 1 min and a station drops to ~0 while it was producing, or the plant is near zero
         while the zone sensors show sun (> 300 W/m2)                           (rare; treat as losing a unit)
  Sky state from the swing of the last 30 min (1-minute means): steady < 2 MW, moderate 2-6 MW, variable > 6 MW.
  Reserve to hold against solar = 40 / 60 / 75 % of current output (95 % of 15-minute drops were smaller).
No alarms when the plant was below 2 MW over the last 15 min. An e-mail at most every 15 min; a level clears after
15 min without a new event.
Writes data/live/ramp_state.json (read by the dashboard and the control-room screen) and ramp_events.csv (one line
per WATCH/ALARM/TRIP start, to review the thresholds after a month). Run by hand:  python live\\ramp_watch.py
"""
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WATCH_5, ALARM_5, ALARM_15, TRIP_1 = 5.0, 8.0, 10.0, 5.0
MIN_PLANT_MW = 2.0
STATES = [(2.0, "steady", 0.40), (6.0, "moderate", 0.60), (1e9, "variable", 0.75)]
HOLD_MIN, MAIL_EVERY_MIN = 15, 15
RANK = {"none": 0, "watch": 1, "alarm": 2, "trip": 3}


def _f(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def read_now(live, now):
    rows = []
    for d in (now - timedelta(days=1), now):
        p = os.path.join(live, f"now_{d:%Y%m%d}.csv")
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                try:
                    t = datetime.strptime(r["time_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except (KeyError, ValueError):
                    continue
                if t < now - timedelta(minutes=45) or t > now + timedelta(minutes=1):
                    continue
                rows.append({"t": t, "p": _f(r.get("pv_sum_mw")), "sts": [_f(r.get(f"sts{i}_kw")) for i in (1, 2, 3, 4)],
                             "ghi": max([v for v in (_f(r.get("zoneA_ghi_wm2")), _f(r.get("zone4_ghi_wm2"))) if v is not None], default=None)})
    return sorted(rows, key=lambda r: r["t"])


def minute_means(rows):
    by = {}
    for r in rows:
        if r["p"] is None:
            continue
        k = r["t"].replace(second=0, microsecond=0)
        by.setdefault(k, []).append(r["p"])
    return sorted((k, sum(v) / len(v)) for k, v in by.items())


def evaluate(rows, now):
    """Current level, drops, sky state and reserve from the last 45 minutes of 10-second readings."""
    mm = minute_means(rows)
    out = {"time_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "level": "none", "message": "", "pv_mw": None,
           "drop1_mw": None, "drop5_mw": None, "drop15_mw": None, "sky": None, "swing30_mw": None,
           "reserve_pct": None, "reserve_mw": None, "data_ok": bool(mm) and (now - mm[-1][0]) <= timedelta(minutes=3)}
    if not out["data_ok"]:
        out["message"] = "no live readings in the last 3 minutes"
        return out
    t_last, p_now = mm[-1]
    out["pv_mw"] = round(p_now, 2)
    win = lambda m: [p for t, p in mm if t >= t_last - timedelta(minutes=m)]   # noqa: E731
    last15 = win(15)
    drop = lambda m: max(0.0, max(win(m)) - p_now) if win(m) else 0.0          # noqa: E731
    d1, d5, d15 = drop(1), drop(5), drop(15)
    out.update(drop1_mw=round(d1, 2), drop5_mw=round(d5, 2), drop15_mw=round(d15, 2))
    w30 = win(30)
    if len(w30) >= 20:
        swing = max(w30) - min(w30)
        for lim, name, pct in STATES:
            if swing < lim:
                out.update(sky=name, swing30_mw=round(swing, 2), reserve_pct=int(pct * 100), reserve_mw=round(pct * p_now, 1))
                break
    if max(last15, default=0) < MIN_PLANT_MW:
        return out
    # trip: a station that was producing went to ~0 within the last minute, or the plant is at ~0 in sunshine
    latest = rows[-1]
    minute_ago = [r for r in rows if r["t"] >= latest["t"] - timedelta(seconds=90)]
    station_trip = []
    for i in range(4):
        before = max([r["sts"][i] for r in minute_ago if r["sts"][i] is not None], default=None)
        nowk = latest["sts"][i]
        if before is not None and nowk is not None and before > 500 and nowk < 20:
            station_trip.append(f"STS{i + 1}")
    sunny_zero = p_now < 0.5 and (latest["ghi"] or 0) > 300
    if d1 >= TRIP_1 and (station_trip or sunny_zero):
        what = ", ".join(station_trip) + " tripped" if station_trip else "plant output near zero in sunshine"
        out.update(level="trip", message=f"PLANT TRIP? Solar down {d1:.1f} MW within 1 minute ({what}); now {p_now:.1f} MW. "
                                         "Treat as losing a unit; check frequency and call the plant.")
    elif d5 >= ALARM_5 or d15 >= ALARM_15:
        span = f"{d5:.1f} MW within 5 min" if d5 >= ALARM_5 else f"{d15:.1f} MW within 15 min"
        out.update(level="alarm", message=f"Solar dropping fast: down {span}; now {p_now:.1f} MW. Raise hydro/thermal and check frequency.")
    elif d5 >= WATCH_5:
        out.update(level="watch", message=f"Solar falling: down {d5:.1f} MW within 5 min; now {p_now:.1f} MW.")
    return out


def run(cfg, now=None, send=True, config_path=None):
    now = now or datetime.now(timezone.utc)
    live = cfg["live_dir"]
    res = evaluate(read_now(live, now), now)
    st_path = os.path.join(live, "ramp_state.json")
    try:
        with open(st_path, encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception:
        prev = {}
    # hold the highest recent level for HOLD_MIN minutes so a screen does not flicker between levels
    held = prev.get("held") or {}
    until = None
    if held.get("until"):
        try:
            until = datetime.strptime(held["until"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            until = None
    active = bool(held) and until is not None and now <= until
    new_event = False
    if RANK[res["level"]] > 0:
        if not active or RANK[res["level"]] > RANK.get(held.get("level", "none"), 0):
            new_event = True
            held = {"level": res["level"], "message": res["message"], "started": res["time_utc"]}
        elif RANK[res["level"]] == RANK.get(held.get("level", "none"), 0):
            held["message"] = res["message"]
        held["until"] = (now + timedelta(minutes=HOLD_MIN)).strftime("%Y-%m-%dT%H:%M:%SZ")
    elif not active:
        held = {}
    res["held"] = held
    res["shown_level"] = held.get("level", "none") if held else "none"
    res["shown_message"] = held.get("message", "") if held else ""
    res["last_mail_utc"] = prev.get("last_mail_utc")
    if new_event:
        with open(os.path.join(live, "ramp_events.csv"), "a", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            if fh.tell() == 0:
                w.writerow(["time_utc", "level", "pv_mw", "drop1_mw", "drop5_mw", "drop15_mw", "sky", "message"])
            w.writerow([res["time_utc"], res["level"], res["pv_mw"], res["drop1_mw"], res["drop5_mw"], res["drop15_mw"], res["sky"], res["message"]])
    if send and res["level"] in ("alarm", "trip"):
        last = res["last_mail_utc"]
        due = True
        if last:
            try:
                due = now - datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) >= timedelta(minutes=MAIL_EVERY_MIN) \
                    or (res["level"] == "trip" and prev.get("last_mail_level") != "trip")
            except ValueError:
                due = True
        if due:
            sky = f" Sky {res['sky']}: hold about {res['reserve_mw']} MW reserve against solar." if res.get("reserve_mw") is not None else ""
            text = (f"{res['message']}{sky}\n\n{now:%Y-%m-%d %H:%M} GMT. Decision support from the Mount Coffee forecast PC; "
                    "the dispatcher decides. Live view: control-room screen / dashboard.")
            subject = f"Mount Coffee solar {'TRIP?' if res['level'] == 'trip' else 'ALARM'}: {res['message'][:70]}"
            # send in a separate process: the e-mail can take a minute and must not hold up the live poller
            with open(os.path.join(live, "ramp_mail_pending.json"), "w", encoding="utf-8") as fh:
                json.dump({"action": "notify", "kind": "ramp", "subject": subject, "text": text}, fh)
            try:
                import subprocess
                flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0      # DETACHED_PROCESS | NEW_PROCESS_GROUP
                subprocess.Popen([sys.executable, os.path.abspath(__file__), "--send-pending", "--config",
                                  config_path or os.path.join(HERE, "config.json")], creationflags=flags,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
            except Exception as e:
                res["last_mail_result"] = f"could not start sender: {e}"[:120]
            res["last_mail_utc"] = res["time_utc"]
            res["last_mail_level"] = res["level"]
    else:
        res["last_mail_level"] = prev.get("last_mail_level")
    tmp = st_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    os.replace(tmp, st_path)
    return res


if __name__ == "__main__":
    from portal_collector import load_config
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--no-send", action="store_true", help="evaluate and write ramp_state.json, but send no e-mail")
    ap.add_argument("--send-pending", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    cfg = load_config(a.config)
    if a.send_pending:
        from alerts import post
        pend = os.path.join(cfg["live_dir"], "ramp_mail_pending.json")
        with open(pend, encoding="utf-8") as fh:
            body = json.load(fh)
        r = post(cfg, body)
        with open(os.path.join(cfg["live_dir"], "alerts_log.txt"), "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC  ramp: {body['subject']} -> {str(r)[:120]}\n")
        os.remove(pend)
    else:
        print(json.dumps(run(cfg, send=not a.no_send, config_path=a.config), indent=1))
