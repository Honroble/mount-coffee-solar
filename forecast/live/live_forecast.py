"""Every 15 minutes: fetch satellite data, forecast 15/30/60 min ahead, log it and send it to the Google Sheet.

Run by Windows Task Scheduler (see install_live_tasks.ps1):
    python live/live_forecast.py --config live/config.json

Uses the best model the available data allows:
  plant + weather + satellite  ->  plant + weather  ->  plant only
Each forecast is appended to <live_dir>/forecast_log.csv and POSTed to the Google Sheet web app.
"""
import argparse
import csv
import glob
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the forecast folder
sys.path.insert(0, ROOT)

from forecast import make_forecast  # noqa: E402

FIELDS = ["issued_utc", "p_now_mw", "p_15min_mw", "p_30min_mw", "p_60min_mw", "clear_sky_15min_mw",
          "clear_sky_30min_mw", "clear_sky_60min_mw", "inverters_online", "model", "satellite_used", "status"]


def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    return cfg


def recent(live_dir, group, days=2):
    today = datetime.now(timezone.utc).date()
    names = [os.path.join(live_dir, f"{group}_live_{(today - timedelta(days=d)):%Y%m%d}.csv") for d in range(days)]
    return [p for p in sorted(names) if os.path.exists(p)]


def fetch_satellite(live_dir):
    out = os.path.join(live_dir, "sat_recent.csv")
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, "fetch_satellite.py"), "--past-days", "1", "--out", out],
                       check=True, capture_output=True, timeout=120)
        return out
    except Exception:
        # an older file (< 3 h) is still usable: the model only uses satellite data 30 min old or more
        if os.path.exists(out) and (datetime.now().timestamp() - os.path.getmtime(out)) < 3 * 3600:
            return out
        return None


def send_to_sheet(cfg, row):
    url = cfg.get("sheet_webhook_url")
    if not url:
        return "no sheet configured"
    body = json.dumps({"token": cfg.get("sheet_token", ""), "row": row}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:   # Apps Script answers with a redirect + JSON
        return r.read().decode("utf-8", "replace")[:200]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--no-send", action="store_true", help="do not post to the Google Sheet")
    ap.add_argument("--at", help="(testing) forecast as if it were this UTC time")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    os.makedirs(live, exist_ok=True)
    iv2 = cfg.get("iv2_override") or recent(live, "iv2")
    iv1 = cfg.get("iv1_override") or recent(live, "iv1")
    sat = cfg.get("sat_override") or fetch_satellite(live)
    models = [("satellite", "mcsolar_model_satellite.joblib", True, True),
              ("weather", "mcsolar_model_weather.joblib", True, False),
              ("plant", "mcsolar_model.joblib", False, False)]
    row, errors = None, []
    if not iv2:
        errors.append("no live plant data yet - is the collector running?")
    for name, fname, need_iv1, need_sat in models:
        if not iv2 or (need_iv1 and not iv1) or (need_sat and not sat):
            continue
        path = os.path.join(ROOT, fname)
        if not os.path.exists(path):
            continue
        try:
            fc = make_forecast(path, iv2, iv1 if need_iv1 else [], sat if need_sat else None, a.at)
            row = {"issued_utc": fc["issued_utc"], "p_now_mw": fc["P_now_MW"],
                   "p_15min_mw": fc["P_15min_MW"], "p_30min_mw": fc["P_30min_MW"], "p_60min_mw": fc["P_60min_MW"],
                   "clear_sky_15min_mw": fc["clear_sky_15min_MW"], "clear_sky_30min_mw": fc["clear_sky_30min_MW"],
                   "clear_sky_60min_mw": fc["clear_sky_60min_MW"], "inverters_online": fc["inverters_online"],
                   "model": name, "satellite_used": bool(need_sat), "status": "ok"}
            age = datetime.now(timezone.utc) - datetime.strptime(fc["issued_utc"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            if not a.at and age > timedelta(minutes=45):
                row["status"] = f"stale data ({int(age.total_seconds() // 60)} min old)"
            break
        except BaseException as e:   # SystemExit from make_forecast too
            errors.append(f"{name}: {e}")
    if row is None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        row = {k: "" for k in FIELDS}
        row.update({"issued_utc": now, "model": "none", "satellite_used": False,
                    "status": "error: " + " | ".join(errors)[:300]})
    for k, v in row.items():   # NaN -> empty cell
        if isinstance(v, float) and v != v:
            row[k] = ""
    log = os.path.join(live, "forecast_log.csv")
    new = not os.path.exists(log)
    with open(log, "a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)
    sent = "not sent (--no-send)"
    if not a.no_send:
        try:
            sent = send_to_sheet(cfg, [row[k] for k in FIELDS])
        except Exception as e:
            sent = f"send failed: {e}"
    print(json.dumps(row), "|", sent)


if __name__ == "__main__":
    main()
