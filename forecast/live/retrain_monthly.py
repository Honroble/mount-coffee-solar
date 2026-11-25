"""Retrain the forecast models (v2 every-5-minute model and the three 15-minute fallbacks) on all data so far (historical exports + live files).

Run monthly by Windows Task Scheduler (see install_live_tasks.ps1), or by hand:
    python live/retrain_monthly.py --config live/config.json

New models are trained into temporary files and only replace the old ones if training succeeds,
so a failed retrain never leaves the live forecast without a model. The v2 and v2.1 models are also checked on the
last 14 days: a new model replaces the old one only if it is at least as good at 15 and 30 minutes ahead.
The satellite history download is tried 3 times. retrain_state.json records the last successful run; alerts.py starts
a catch-up retrain at night when the last one is more than 30 days old (PC asleep or offline on the planned Sunday).
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time
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
    err = None
    for attempt in range(3):            # the PC's internet / DNS is often not ready right after waking
        try:
            subprocess.run([sys.executable, os.path.join(ROOT, "fetch_satellite.py"), "--start", "2026-09-17",
                            "--end", today, "--out", sat + ".new"], check=True, capture_output=True, timeout=600)
            shutil.move(sat + ".new", sat)
            err = None
            break
        except Exception as e:
            err = e
            time.sleep(120)
    if err is not None:
        if os.path.exists(sat):
            report.append(f"satellite history download failed 3 times ({err}); using the existing copy")
        else:
            report.append(f"satellite history download failed ({err}); satellite models not retrained")
            sat = None
    v21 = ["--version", "2.1", "--kpi", os.path.join(live, "kpi_daily.json"), "--trips", os.path.join(live, "trips.csv"),
           "--ctrl", *sorted(glob.glob(os.path.join(live, "ctrl_live_*.csv"))),
           "--ewma-min", str(cfg.get("baseline_ewma_min", 2)), "--baseline", str(cfg.get("baseline_mode", "ewma")),
           "--sat-max-age", str(cfg.get("satellite_max_age_min", 20)), "--sat-delay", str(cfg.get("satellite_delay_min", 20))]
    jobs = [("mcsolar_model.joblib", []), ("mcsolar_model_weather.joblib", ["--iv1", *iv1])]
    if sat:
        jobs.append(("mcsolar_model_satellite.joblib", ["--iv1", *iv1, "--sat", sat]))
        jobs.append(("mcsolar_model_v2.joblib", ["--iv1", *iv1, "--sat", sat]))
        jobs.append(("mcsolar_model_v21.joblib", ["--iv1", *iv1, "--sat", sat, *v21]))
    jobs.append(("mcsolar_model_v21_nosat.joblib", ["--iv1", *iv1, "--no-sat", *v21]))
    ok_all = True
    for name, extra in jobs:
        tmp = os.path.join(ROOT, name + ".new")
        dest = os.path.join(ROOT, name)
        script = "train5.py" if name.startswith("mcsolar_model_v2") else "train.py"
        check = ["--holdout-days", "14", "--old", dest] if script == "train5.py" and os.path.exists(dest) else []
        r = subprocess.run([sys.executable, "-W", "ignore", os.path.join(ROOT, script), "--iv2", *iv2, *extra, *check,
                            "--out", tmp], capture_output=True, text=True, cwd=ROOT)
        if r.returncode == 0 and os.path.exists(tmp):
            verdict = None
            if check and os.path.exists(tmp + ".check.json"):
                with open(tmp + ".check.json", encoding="utf-8") as fh:
                    verdict = json.load(fh)
                os.remove(tmp + ".check.json")
            if verdict is not None and not verdict.get("new_wins"):
                os.remove(tmp)
                report.append(f"--- {name}: new model not better on the last 14 days, old model kept\n{json.dumps(verdict)}")
                continue
            shutil.move(tmp, dest)
            report.append(f"--- {name}\n{r.stdout.strip()}")
        else:
            ok_all = False
            report.append(f"--- {name} FAILED, old model kept\n{r.stderr.strip()[-1500:]}")
    with open(os.path.join(live, "retrain_state.json"), "w", encoding="utf-8") as fh:
        json.dump({"last_run_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"), "all_ok": ok_all,
                   "satellite": bool(sat)}, fh)
    r = subprocess.run([sys.executable, os.path.join(HERE, "calibrate_nwp.py"), "--config", a.config],
                       capture_output=True, text=True, timeout=900)
    report.append("--- weather-model calibration\n" + (r.stdout or r.stderr).strip()[-800:])
    with open(os.path.join(live, "retrain_log.txt"), "a", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n\n")
    print("\n".join(report))


if __name__ == "__main__":
    main()
