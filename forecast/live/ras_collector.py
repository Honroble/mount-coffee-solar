"""Read the Mount Coffee logger's current values from the Gantner RAS API and save them.

Run once a minute (Windows Task Scheduler, see install_live_tasks.ps1):
    python live/ras_collector.py --config live/config.json

Each run makes ONE read-only request:  GET https://ras.gantner-webportal.com/api/v1/devices/<device>/values
It never writes to the logger (the API's PUT call is not used anywhere in this program).

Values are appended to daily files in the same layout as the logger's own CSV exports
(Date;Time;Timezone;<channel names>, units row), so train.py and forecast.py read them unchanged:
    <live_dir>/iv2_live_YYYYMMDD.csv   plant power, frequency, setpoint, 52 inverters
    <live_dir>/iv1_live_YYYYMMDD.csv   pyranometers, temperatures, DustIQ, WS600
The API gives no timestamps, so each row is stamped with this PC's clock in UTC, rounded to the minute.
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://ras.gantner-webportal.com/api/v1"


def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    return cfg


def load_map(path=os.path.join(HERE, "channel_map.csv")):
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def fetch_values(cfg, retries=3, timeout=30):
    url = f"{BASE}/devices/{urllib.parse.quote(cfg['device_id'], safe='')}/values"
    req = urllib.request.Request(url, headers={"X-API-KEY": cfg["ras_api_key"], "Accept": "application/json"})
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            last = f"HTTP {e.code}: {body}"
            if e.code in (400, 401, 403, 404):   # wrong key / device / mapping: retrying will not help
                break
        except Exception as e:                   # network error, timeout, device offline
            last = str(e)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"RAS API read failed: {last}")


def append_row(path, channels, units, values, now):
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="latin-1", errors="replace") as fh:
        w = csv.writer(fh, delimiter=";")
        if new:
            w.writerow(["Date", "Time", "Timezone"] + channels)
            w.writerow(["[dd.mm.YYYY]", "[HH:MM:SS]", "[+/-HHMM]"] + [f"[{u}]" for u in units])
        w.writerow([now.strftime("%d.%m.%Y"), now.strftime("%H:%M:%S"), "+0000"] + values)


def collect_once(cfg, chmap):
    data = fetch_values(cfg)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    os.makedirs(cfg["live_dir"], exist_ok=True)
    missing = []
    for group in ("iv2", "iv1"):
        rows = [m for m in chmap if m["group"] == group]
        vals = []
        for m in rows:
            v = data.get(m["api_name"])
            if not isinstance(v, dict) or "data" not in v or v.get("error"):
                missing.append(m["api_name"])
                vals.append("")
            else:
                vals.append(v["data"])
        path = os.path.join(cfg["live_dir"], f"{group}_live_{now:%Y%m%d}.csv")
        append_row(path, [m["local_channel"] for m in rows], [m["unit"] for m in rows], vals, now)
    return now, len(chmap) - len(missing), missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--test", action="store_true", help="read once and print what came back, write nothing")
    a = ap.parse_args()
    cfg = load_config(a.config)
    chmap = load_map()
    if a.test:
        data = fetch_values(cfg)
        names = {m["api_name"] for m in chmap}
        print(f"API returned {len(data)} values; {len(names & set(data))} of {len(names)} expected channels found")
        for m in chmap:
            print(f"  {m['api_name']:<16} {data.get(m['api_name'], 'MISSING')}")
        return
    try:
        now, ok, missing = collect_once(cfg, chmap)
        msg = f"{now:%Y-%m-%d %H:%M} UTC  saved {ok}/{len(chmap)} channels"
        if missing:
            msg += f"  missing: {', '.join(missing[:8])}{' ...' if len(missing) > 8 else ''}"
        status = 0
    except Exception as e:
        msg, status = f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC  ERROR {e}", 1
    os.makedirs(cfg["live_dir"], exist_ok=True)
    with open(os.path.join(cfg["live_dir"], "collector_log.txt"), "a", encoding="utf-8") as fh:
        fh.write(msg + "\n")
    print(msg)
    sys.exit(status)


if __name__ == "__main__":
    main()
