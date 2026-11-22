"""Alerts and the daily summary, run every 15 minutes on the forecast PC (task "MCSolar Alerts").

Checks (each sent at most once per cool-down period):
  ramp         the weather models forecast a drop of >= 3 MW within an hour, in the next 3 hours
  loss         plant output well below what the satellite sunlight says it should give (outage, trip, limit)
  curtailment  PowerLimit_User below 100 %
  inverter     an inverter at ~0 kW for 30 min while the plant makes > 5 MW
  stale        the collector has saved nothing for 30 min in daytime
  disk         logger disk almost full (>= 97 % used or < 200 MB free)
  low_forecast the 15-minute forecast says output will fall below 1 MW within the next hour while the sun is up
               (clear sky >= 3 MW, plant now >= 1 MW). Sent once per drop; a "recovered" message follows when
               all three forecasts are back at 2 MW or more.
After 19:00 GMT, once a day: the daily summary (energy, peak, forecast accuracy, alerts, plant status).

Messages go to the Google receiver (action "notify"), which e-mails the addresses in its ALERT_TO setting and
logs every alert in the sheet tab "Alerts"; the summary is also appended to the tab "DailySummary".
Local copies: data/live/alerts_log.txt and daily_summary_<date>.txt.
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nwp_forecast import load_config, daily_actuals  # noqa: E402

SENT = {655.35, 6553.5, 65535}
SAT_MW_PER_WM2 = 0.02063          # clear-sky mapping of horizontal irradiance to plant MW (plant-data model)
LIMIT_MW = 16.64
LOW_MW, RECOVER_MW, MIN_CLEAR_SKY_MW = 1.0, 2.0, 3.0   # low-forecast alert thresholds
COOLDOWN_H = {"ramp": 3, "loss": 2, "curtailment": 6, "inverter": 6, "stale": 2, "disk": 24, "portal_login": 3, "poller": 3, "forecast_stale": 3}
INVERTERS = [f"STS{s}.INV{i:02d}" for s, n in ((1, 14), (2, 14), (3, 12)) for i in range(1, n + 1)] + [f"STS4.INV{i}" for i in range(1, 13)]


def _json_safe(v):
    """NaN/inf are not valid JSON (the Apps Script receiver rejects them): send them as empty cells."""
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    if isinstance(v, dict):
        return {k: _json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    return v


def post(cfg, body):
    url, tok = cfg.get("sheet_webhook_url"), cfg.get("sheet_token")
    if not url or not tok:
        return "no sheet configured"
    data = json.dumps(_json_safe({"token": tok, **body}), allow_nan=False).encode("utf-8")
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "text/plain;charset=utf-8"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")[:200]
        except Exception as e:
            last = e
            time.sleep(10 * (attempt + 1))
    return f"failed: {last}"


INVESTIGATE = {"low_forecast", "loss", "curtailment", "inverter", "ramp"}


def ai_analysis(cfg, kind, text, now):
    """Ask the dashboard's AI agent (Claude, read-only tools) for a likely cause. Empty string if it is not set up."""
    if kind not in INVESTIGATE or cfg.get("agent_investigate") is False:
        return ""
    url = cfg.get("agent_url", "http://127.0.0.1:3000").rstrip("/") + "/api/agent"
    body = json.dumps({"mode": "investigate", "kind": kind, "text": text, "time": now.strftime("%Y-%m-%d %H:%M GMT")}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=150) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
        if j.get("answer") and j.get("free"):
            return "\n\n" + j["answer"].strip()
        if j.get("answer"):
            return "\n\nAI analysis (Claude, reads plant data only - check before acting):\n" + j["answer"].strip()
    except Exception:
        pass
    return ""


def read_logger_today(live, group, now):
    path = os.path.join(live, f"{group}_live_{now:%Y%m%d}.csv")
    if not os.path.exists(path):
        return [], []
    with open(path, encoding="latin-1", newline="") as fh:
        rows = list(csv.reader(fh, delimiter=";"))
    head = rows[0]
    out = []
    for r in rows[1:]:
        if not r or r[0].startswith("["):
            continue
        try:
            t = datetime.strptime(r[0] + " " + r[1], "%d.%m.%Y %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        vals = {}
        for i, h in enumerate(head[3:], start=3):
            try:
                v = float(r[i].replace(",", ".")) if i < len(r) and r[i] != "" else None
            except ValueError:
                v = None
            vals[h] = None if v is None or v != v or v in SENT else v      # 'nan' from the logger -> missing
        out.append((t, vals))
    return head, out


def satellite_recent(live):
    path = os.path.join(live, "sat_recent.csv")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", newline="") as fh:
        rows = list(csv.reader(fh))
    out = []
    for r in rows[1:]:
        try:
            out.append((datetime.strptime(r[0], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc), float(r[1])))
        except (ValueError, IndexError):
            pass
    return out


def checks(cfg, live, now):
    found = []
    # forecast ramps in the next 3 hours
    try:
        fc = json.load(open(os.path.join(live, "nwp_forecast.json"), encoding="utf-8"))
        for a in fc.get("alerts", []):
            t = datetime.strptime(a["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if a["kind"] == "ramp" and now <= t <= now + timedelta(hours=3):
                found.append(("ramp", f"ramp:{a['time']}", a["text"]))
    except Exception:
        pass
    widgets = {}
    try:
        widgets = json.load(open(os.path.join(live, "widget_latest.json"), encoding="utf-8"))
    except Exception:
        pass
    limit_pct = widgets.get("power_limit_user_pct") or 100
    if limit_pct < 100:
        found.append(("curtailment", "curtailment", f"Plant output is limited: PowerLimit_User = {limit_pct:.0f} % (setpoint {widgets.get('power_setpoint_mw')} MW)."))
    if widgets.get("disk_used_pct") and (widgets["disk_used_pct"] >= 97 or (widgets.get("disk_free_mb") or 1e9) < 200):
        found.append(("disk", "disk", f"Logger disk {widgets['disk_used_pct']} % full, {widgets.get('disk_free_mb')} MB free. "
                                      "When it is full the logger stops saving data files: delete or download old files."))
    head, iv2 = read_logger_today(live, "iv2", now)
    daytime = 7 <= now.hour < 18
    last_t = iv2[-1][0] if iv2 else None
    if daytime and (last_t is None or now - last_t > timedelta(minutes=30)):
        found.append(("stale", "stale", f"No plant data saved since {last_t:%H:%M} GMT." if last_t else "No plant data saved today."))
    # monitoring the monitoring: portal sign-in, live poller, forecast job
    try:
        with open(os.path.join(live, "collector_log.txt"), encoding="utf-8", errors="replace") as fh:
            tail = fh.readlines()[-40:]
        recent = [l for l in tail if l[:16] >= (now - timedelta(minutes=20)).strftime("%Y-%m-%d %H:%M")]
        bad = [l for l in recent if "sign-in failed" in l.lower() or "invalid login" in l.lower()]
        if bad and len(bad) >= 2:
            found.append(("portal_login", "portal_login", "The forecast PC cannot sign in to the Gantner portal (" + bad[-1].strip()[-160:] +
                          "). Data collection has stopped. Fix: on the forecast PC run  python live\\check_portal_login.py --try  with the current portal password."))
    except Exception:
        pass
    if daytime:
        try:
            w = json.load(open(os.path.join(live, "widget_now.json"), encoding="utf-8"))
            age = now - datetime.strptime(w["time_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if age > timedelta(minutes=10):
                found.append(("poller", "poller", f"Live 10-second readings stopped {int(age.total_seconds() // 60)} min ago (task MCSolar Live Now). "
                              "The dashboard 'Actual MW' and STS values are stale."))
        except Exception:
            pass
        try:
            with open(os.path.join(live, "forecast_log.csv"), encoding="utf-8") as fh:
                last = fh.readlines()[-1].split(",")[0]
            age = now - datetime.strptime(last, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            if age > timedelta(minutes=25):
                found.append(("forecast_stale", "forecast_stale", f"No new forecast for {int(age.total_seconds() // 60)} min (last {last[11:]} GMT; task MCSolar Forecast). "
                              "See data\\live\\forecast_runs.txt."))
        except Exception:
            pass
    # output vs satellite-implied output, last 3 satellite periods (satellite arrives ~20 min late)
    sat = [s for s in satellite_recent(live) if s[0].date() == now.date()][-3:]
    if iv2 and len(sat) == 3 and daytime:
        bad = 0
        for t_end, ghi in sat:
            vals = [v["Information.Inverter sum P"] for t, v in iv2 if t_end - timedelta(minutes=10) < t <= t_end and v.get("Information.Inverter sum P") is not None]
            exp = min(ghi * SAT_MW_PER_WM2, LIMIT_MW * limit_pct / 100)
            if vals and exp > 4 and sum(vals) / len(vals) < 0.6 * exp:
                bad += 1
        if bad == 3:
            act = sum(v["Information.Inverter sum P"] or 0 for t, v in iv2[-10:]) / max(1, len(iv2[-10:]))
            found.append(("loss", "loss", f"Plant output {act:.1f} MW is far below what the satellite sunlight implies for the last 30 minutes "
                                          f"(about {min(sat[-1][1] * SAT_MW_PER_WM2, LIMIT_MW):.1f} MW). Check for trips, outages or limits."))
    # inverters at ~0 while the plant runs
    recent = [v for t, v in iv2 if now - t <= timedelta(minutes=30)]
    if len(recent) >= 20 and all((v.get("Information.Inverter sum P") or 0) > 5 for v in recent):
        off = [n for n in INVERTERS if all((v.get(f"{n}.active_power_total") or 0) < 5 for v in recent)]
        if off:
            found.append(("inverter", "inverter:" + ",".join(off), f"Inverter(s) without output for 30 min while the plant runs: {', '.join(off)}."))
    return found, widgets


def latest_forecast(live, now):
    """The newest row of forecast_log.csv if it was issued in the last 20 minutes and is usable."""
    try:
        with open(os.path.join(live, "forecast_log.csv"), encoding="utf-8", newline="") as fh:
            rows = list(csv.DictReader(fh))
    except Exception:
        return None
    if not rows:
        return None
    r = rows[-1]
    try:
        t = datetime.strptime(r["issued_utc"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    except (KeyError, ValueError):
        return None
    if now - t > timedelta(minutes=20) or not r.get("status", "").startswith("ok"):
        return None
    num = lambda k: float(r[k]) if r.get(k) not in (None, "") else None
    return {"t": t, "now": num("p_now_mw"),
            "p": {m: num(f"p_{m}min_mw") for m in (15, 30, 60)},
            "cs": {m: num(f"clear_sky_{m}min_mw") for m in (15, 30, 60)}}


def low_forecast(live, now, state):
    """Event-style check: returns (kind, text) to send now, or None. Updates state['low_forecast']."""
    f = latest_forecast(live, now)
    if not f or f["now"] is None:
        return None
    low = [m for m in (15, 30, 60) if f["p"][m] is not None and f["p"][m] < LOW_MW
           and (f["cs"][m] or 0) >= MIN_CLEAR_SKY_MW]
    vals = ", ".join(f"+{m} min {f['p'][m]:.1f} MW" for m in (15, 30, 60) if f["p"][m] is not None)
    active = state.get("low_forecast")
    if low and not active and f["now"] >= LOW_MW:
        state["low_forecast"] = f["t"].isoformat()
        first = low[0]
        return ("low_forecast",
                f"LOW OUTPUT FORECAST: Mount Coffee solar is expected to fall below {LOW_MW:.0f} MW in about {first} minutes "
                f"(forecast issued {f['t']:%H:%M} GMT: {vals}; now {f['now']:.1f} MW; clear sky would give "
                f"{f['cs'][first]:.1f} MW). Likely heavy cloud or rain. Be ready to cover the shortfall from other units.")
    if active and all(f["p"][m] is not None and f["p"][m] >= RECOVER_MW for m in (15, 30, 60)):
        state.pop("low_forecast", None)
        return ("low_forecast_recovered",
                f"Recovered: the forecast issued {f['t']:%H:%M} GMT is back above {RECOVER_MW:.0f} MW ({vals}; now {f['now']:.1f} MW). "
                f"Low-output warning from {datetime.fromisoformat(active):%H:%M} GMT is over.")
    return None


def run_low_forecast(cfg, live, now, state, log, dry_run):
    before = state.get("low_forecast")
    lf = low_forecast(live, now, state)
    if not lf:
        return
    kind, text = lf
    subject = ("Mount Coffee solar: OUTPUT FORECAST BELOW 1 MW" if kind == "low_forecast"
               else "Mount Coffee solar: output forecast recovered")
    if not dry_run:
        text = text + ai_analysis(cfg, kind, text, now)
    res = "dry run" if dry_run else post(cfg, {"action": "notify", "kind": kind, "subject": subject, "text": text})
    log.append(f"{now:%Y-%m-%d %H:%M} {kind}: {text} [{res[:60]}]")
    if not dry_run and '"ok":true' not in res.replace(" ", ""):
        # not delivered: put the state back so the next run tries again
        if before is None:
            state.pop("low_forecast", None)
        else:
            state["low_forecast"] = before


def summary(cfg, live, now, widgets):
    day = now.strftime("%Y-%m-%d")
    act = daily_actuals(live).get(day)
    head, iv2 = read_logger_today(live, "iv2", now)
    lines = [f"Mount Coffee Solar - daily summary {day}"]
    mwh = act[0] if act else None
    lines.append(f"Energy (logger, inverter side): {mwh if mwh is not None else 'n/a'} MWh, peak {act[1] if act else 'n/a'} MW, data minutes {act[2] if act else 0}")
    da = None
    try:
        with open(os.path.join(live, "nwp_daily_log.csv"), encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                if r["date"] == day and r["issued_utc"][:10] < day:
                    da = r
    except Exception:
        pass
    if da and mwh is not None:
        lines.append(f"Day-ahead weather-model forecast: {da['new_mwh']} MWh (range {da['low_mwh']}-{da['high_mwh']}), miss {float(da['new_mwh']) - mwh:+.1f} MWh")
    # 15-minute plant-data forecast accuracy today: forecast p_15 vs the next row's p_now
    errs = []
    try:
        with open(os.path.join(live, "forecast_log.csv"), encoding="utf-8", newline="") as fh:
            rows = [r for r in csv.DictReader(fh) if r["issued_utc"].startswith(day)]
        by_t = {r["issued_utc"]: r for r in rows}
        for r in rows:
            t = datetime.strptime(r["issued_utc"], "%Y-%m-%d %H:%M") + timedelta(minutes=15)
            nxt = by_t.get(t.strftime("%Y-%m-%d %H:%M"))
            if nxt and r["p_15min_mw"] and nxt["p_now_mw"]:
                errs.append(abs(float(r["p_15min_mw"]) - float(nxt["p_now_mw"])))
    except Exception:
        pass
    if errs:
        lines.append(f"15-minute forecast: average miss {sum(errs) / len(errs):.2f} MW over {len(errs)} forecasts")
    alerts_today = []
    try:
        with open(os.path.join(live, "alerts_log.txt"), encoding="utf-8") as fh:
            alerts_today = [l.strip() for l in fh if l.startswith(day)]
    except Exception:
        pass
    lines.append(f"Alerts today: {len(alerts_today)}")
    lines += ["  " + l[17:] for l in alerts_today[-10:]]
    if widgets:
        lines.append(f"Logger: disk {widgets.get('disk_used_pct')} % used ({widgets.get('disk_free_mb')} MB free), "
                     f"{widgets.get('channel_errors')} channel errors, PowerLimit_User {widgets.get('power_limit_user_pct')} %")
    row = [day, mwh if mwh is not None else "", act[1] if act else "", float(da["new_mwh"]) if da else "",
           round(sum(errs) / len(errs), 3) if errs else "", len(alerts_today),
           widgets.get("disk_used_pct", ""), widgets.get("channel_errors", "")]
    return "\n".join(lines), row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--dry-run", action="store_true", help="print what would be sent, send nothing")
    ap.add_argument("--low-only", action="store_true", help="only the low-forecast check (run by live_forecast.py after each forecast)")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    now = datetime.now(timezone.utc)
    state_path = os.path.join(live, "alerts_state.json")
    try:
        state = json.load(open(state_path, encoding="utf-8"))
    except Exception:
        state = {}
    log = []
    if a.low_only:
        run_low_forecast(cfg, live, now, state, log, a.dry_run)
        if log:
            with open(os.path.join(live, "alerts_log.txt"), "a", encoding="utf-8") as fh:
                fh.write("\n".join(log) + "\n")
        if not a.dry_run:
            with open(state_path, "w", encoding="utf-8") as fh:
                json.dump(state, fh)
        print("\n".join(log) if log else "no low-forecast change")
        return
    # daily KPIs and loss breakdown for yesterday and today (kpi.py), for the dashboard and the reports
    try:
        import subprocess
        subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "kpi.py"), "--config", a.config], timeout=300, capture_output=True)
    except Exception:
        pass
    # forecast verification (verify.py): seal finished days, score every forecast, monthly report - once an hour
    if now.minute < 15 or not os.path.exists(os.path.join(live, "verification.json")):
        try:
            import subprocess
            subprocess.run([sys.executable, os.path.join(HERE, "verify.py"), "--config", a.config], timeout=300, capture_output=True)
        except Exception:
            pass
    # weather-model calibration (calibrate_nwp.py): refit once a day after sunset, so the 14-day level stays current
    if now.hour >= 20:
        try:
            with open(os.path.join(live, "nwp_calibration.json"), encoding="utf-8") as fh:
                fitted = json.load(fh).get("fitted_utc", "")
        except Exception:
            fitted = ""
        if not fitted.startswith(now.strftime("%Y-%m-%d")):
            try:
                import subprocess
                subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "calibrate_nwp.py"), "--config", a.config],
                               timeout=600, capture_output=True)
            except Exception:
                pass
    # daily DC string check (string_check.py), once after 14:00 GMT on the midday window
    if now.hour >= 14:
        sc = os.path.join(live, f"string_check_{now:%Y%m%d}.json")
        if not os.path.exists(sc):
            try:
                import subprocess
                subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "string_check.py"), "--config", a.config],
                               timeout=900, capture_output=True)
            except Exception:
                pass
    # nightly backup of the data files to Google Drive (backup_drive.py): first run after midnight GMT
    blog = os.path.join(live, "backup_log.txt")
    last_backup = datetime.fromtimestamp(os.path.getmtime(blog), timezone.utc).date() if os.path.exists(blog) else None
    if last_backup is not None and last_backup < now.date():
        try:
            import subprocess
            subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "backup_drive.py"), "--config", a.config],
                           timeout=1500, capture_output=True)
        except Exception:
            pass
    found, widgets = checks(cfg, live, now)
    for kind, key, text in found:
        last = state.get(key)
        if last and now - datetime.fromisoformat(last) < timedelta(hours=COOLDOWN_H[kind]):
            continue
        if not a.dry_run:
            text = text + ai_analysis(cfg, kind, text, now)
        res = "dry run" if a.dry_run else post(cfg, {"action": "notify", "kind": kind, "subject": f"Mount Coffee solar: {kind}", "text": text})
        log.append(f"{now:%Y-%m-%d %H:%M} {kind}: {text} [{res[:60]}]")
        if a.dry_run or '"ok":true' in res.replace(" ", ""):
            state[key] = now.isoformat()
    run_low_forecast(cfg, live, now, state, log, a.dry_run)
    day = now.strftime("%Y-%m-%d")
    if now.hour >= 19 and state.get("summary") != day:
        text, row = summary(cfg, live, now, widgets)
        with open(os.path.join(live, f"daily_summary_{day}.txt"), "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        res = "dry run" if a.dry_run else post(cfg, {"action": "notify", "kind": "summary", "subject": f"Mount Coffee solar: daily summary {day}",
                                                     "text": text, "summary_row": row})
        log.append(f"{now:%Y-%m-%d %H:%M} summary sent [{res[:60]}]")
        if a.dry_run or '"ok":true' in res.replace(" ", ""):
            state["summary"] = day
        if a.dry_run:
            print(text)
    if log:
        with open(os.path.join(live, "alerts_log.txt"), "a", encoding="utf-8") as fh:
            fh.write("\n".join(log) + "\n")
    if not a.dry_run:
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    print("\n".join(log) if log else "no new alerts")


if __name__ == "__main__":
    main()
