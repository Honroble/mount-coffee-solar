"""Retrain the three forecast models on all data so far (historical exports + live files).

Run monthly by Windows Task Scheduler (see install_live_tasks.ps1), or by hand:
    python live/retrain_monthly.py --config live/config.json

New models are trained into temporary files and only replace the old ones if training succeeds,
so a failed retrain never leaves the live forecast without a model.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    a = ap.parse_args()
    with open(a.config, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    live = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(a.config)), cfg.get("live_dir", "../../data/live")))
    data = os.path.dirname(live)
    iv2 = sorted(glob.glob(os.path.join(data, "iv2_2026*.csv")) + glob.glob(os.path.join(live, "iv2_live_*.csv")))
    iv1 = sorted(glob.glob(os.path.join(data, "iv1_2026*.csv")) + glob.glob(os.path.join(live, "iv1_live_*.csv")))
    iv2 = [p for p in iv2 if "_1.csv" not in p and "(1)" not in p]
    iv1 = [p for p in iv1 if "_1.csv" not in p and "(1)" not in p]
    sat = os.path.join(data, "satellite_history.csv")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report = [f"Retrain {today}: {len(iv2)} plant files, {len(iv1)} weather files"]
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, "fetch_satellite.py"), "--start", "2026-09-17",
                        "--end", today, "--out", sat], check=True, capture_output=True, timeout=600)
    except Exception as e:
        report.append(f"satellite history download failed ({e}); satellite model not retrained")
        sat = None
    jobs = [("mcsolar_model.joblib", []), ("mcsolar_model_weather.joblib", ["--iv1", *iv1])]
    if sat:
        jobs.append(("mcsolar_model_satellite.joblib", ["--iv1", *iv1, "--sat", sat]))
    for name, extra in jobs:
        tmp = os.path.join(ROOT, name + ".new")
        r = subprocess.run([sys.executable, "-W", "ignore", os.path.join(ROOT, "train.py"), "--iv2", *iv2, *extra,
                            "--out", tmp], capture_output=True, text=True, cwd=ROOT)
        if r.returncode == 0 and os.path.exists(tmp):
            shutil.move(tmp, os.path.join(ROOT, name))
            report.append(f"--- {name}\n{r.stdout.strip()}")
        else:
            report.append(f"--- {name} FAILED, old model kept\n{r.stderr.strip()[-1500:]}")
    with open(os.path.join(live, "retrain_log.txt"), "a", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n\n")
    print("\n".join(report))


if __name__ == "__main__":
    main()
