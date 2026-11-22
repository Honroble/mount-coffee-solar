"""Copy the forecast PC's data files to Google Drive, through the Apps Script receiver (action "backup").

The logger keeps only its last few weeks (it deletes its oldest files when the disk fills), so the files in data\\
are the only long-term record. Run nightly by alerts.py; can be run by hand:

  python live\\backup_drive.py            back up finished days not sent yet, plus the one-off files
  python live\\backup_drive.py --all      send everything again

Each file is gzip-compressed and saved in Drive under "Mount Coffee solar backup/<YYYY-MM>/" (one-off files under "history").
What was sent is remembered in data\\live\\backup_state.json (file name -> size and time), so a file is sent again
only if it changed. Today's files are left until the day is over.
"""
import argparse
import base64
import glob
import gzip
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DAILY = re.compile(r"^(iv1_live|iv2_live|now|grid_live|ctrl_live|inv_live)_(\d{8})\.csv$")
LIVE_EXTRA = ["string_check_latest.json", "kpi_daily.json", "nwp_calibration.json", "nwp_daily_log.csv", "nwp_hourly_log.csv", "forecast_log.csv",
              "verification_ledger.csv", "verification_days.csv", "widget_log.csv"]
MAX_BYTES = 30 * 1024 * 1024      # compressed size limit per file (Apps Script accepts ~50 MB per request)


def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))        # live_dir is relative to the config file, as in the other scripts
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    return cfg


def send(cfg, folder, name, raw):
    gz = gzip.compress(raw, 6)
    if len(gz) > MAX_BYTES:
        return f"too large ({len(gz) // 1048576} MB compressed), skipped"
    body = json.dumps({"token": cfg["sheet_token"], "action": "backup", "folder": folder, "name": name + ".gz",
                       "b64": base64.b64encode(gz).decode("ascii")}).encode("utf-8")
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(cfg["sheet_webhook_url"], data=body, headers={"Content-Type": "text/plain;charset=utf-8"})
            with urllib.request.urlopen(req, timeout=300) as r:
                text = r.read().decode("utf-8", "replace")
            if '"ok":true' in text.replace(" ", ""):
                return "ok"
            last = text[:150]
        except Exception as e:
            last = str(e)[:150]
        time.sleep(10 * (attempt + 1))
    return f"failed: {last}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--all", action="store_true", help="send every file again")
    a = ap.parse_args()
    cfg = load_config(a.config)
    if not cfg.get("sheet_webhook_url") or not cfg.get("sheet_token"):
        print("no receiver configured"); sys.exit(1)
    live = cfg["live_dir"]
    data = os.path.normpath(os.path.join(live, ".."))
    state_path = os.path.join(live, "backup_state.json")
    try:
        with open(state_path, encoding="utf-8") as fh:
            state = {} if a.all else json.load(fh)
    except Exception:
        state = {}
    today = datetime.now(timezone.utc).strftime("%Y%m%d")

    jobs = []                                            # (path, drive folder)
    for p in sorted(glob.glob(os.path.join(live, "*.csv"))):
        m = DAILY.match(os.path.basename(p))
        if m and m.group(2) < today:
            jobs.append((p, f"{m.group(2)[:4]}-{m.group(2)[4:6]}"))
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    jobs += [(os.path.join(live, n), month) for n in LIVE_EXTRA if os.path.exists(os.path.join(live, n))]
    for pat in ("iv1_2026*.csv", "iv2_2026*.csv", "operator_hourly.csv", "*.xlsx", "mount_coffee_satellite_ghi.csv"):
        jobs += [(p, "history") for p in sorted(glob.glob(os.path.join(data, pat)))]

    sent = skipped = 0
    log = []
    for path, folder in jobs:
        st = os.stat(path)
        key = os.path.relpath(path, data)
        sig = [st.st_size, int(st.st_mtime)]
        if state.get(key) == sig:
            skipped += 1
            continue
        with open(path, "rb") as fh:
            raw = fh.read()
        res = send(cfg, folder, os.path.basename(path), raw)
        if res == "ok":
            state[key] = sig
            sent += 1
            tmp = state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(state, fh, indent=0)
            os.replace(tmp, state_path)
        else:
            log.append(f"{key}: {res}")
    msg = f"backup: {sent} sent, {skipped} unchanged" + (f", {len(log)} problems: " + " | ".join(log[:5]) if log else "")
    with open(os.path.join(live, "backup_log.txt"), "a", encoding="utf-8") as fh:
        fh.write(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC  {msg}\n")
    print(msg)


if __name__ == "__main__":
    main()
