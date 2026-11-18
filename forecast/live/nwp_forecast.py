"""Hours-to-3-days forecast for Mount Coffee from weather models (Open-Meteo), run hourly on the forecast PC.

Method from J. A. Harris's forecast page (16 Nov 2026 handoff), applied to the plant's 10° south-facing panels:
  Tc   = Ta + G*25/800                                   (cell temperature, °C)
  P_DC = 21170 * G/1000 * (1 - 0.0034*(Tc - 25))  kW      (21.17 MWp)
  P_AC = min(0.97*P_DC, 16640)                    kW      (16.64 MW export limit)
  NEW  = mean over the weather models (5 since 18 Nov 2026) of P_AC*max(0.3, 0.790 - 0.182*AOD), band x0.65 / x1.37, capped at 16.64 MW  (hourly)
  OLD  = P_AC*max(0.3, 0.744 - 0.156*AOD) from the Open-Meteo default model, band x0.63 / x1.36          (15-min)
Factors were calibrated on May-Oct 2026 daily energy. Weather data by Open-Meteo.com (CC BY 4.0).

Writes to the live folder:
  nwp_forecast.json          latest forecast (read by the dashboard)
  nwp_daily_log.csv          every issue's daily energy per forecast day (day-ahead and same-day scoring)
  nwp_hourly_log.csv         every issue's hourly values (append-only; scored by verify.py)
  nwp_profiles/<date>.json   last hourly profile issued on each date (hourly day-ahead scoring)
  nwp_runs.txt               one line per run
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    return cfg

LAT, LON, TILT, AZIMUTH = 6.52, -10.63, 10, 0
# GFS dropped 18 Nov 2026: worst of the six against 54 days of plant output (hourly MAE 2.21 MW, daily 17.2 MWh) and
# removing it improved the average (1.70 -> 1.68 MW hourly). Re-add "gfs_seamless" here to restore it.
MODELS = ["ecmwf_ifs025", "ecmwf_aifs025_single", "icon_seamless", "meteofrance_seamless", "ukmo_seamless"]
LABELS = {"ecmwf_ifs025": "ECMWF IFS", "ecmwf_aifs025_single": "ECMWF AIFS", "gfs_seamless": "GFS",
          "icon_seamless": "ICON", "meteofrance_seamless": "Météo-France", "ukmo_seamless": "UK Met Office"}
DC_KWP, LIMIT_KW = 21170.0, 16640.0
NEW_A, NEW_B, NEW_LO, NEW_HI = 0.790, 0.182, 0.65, 1.37
OLD_A, OLD_B, OLD_LO, OLD_HI = 0.744, 0.156, 0.63, 1.36
RAMP_MW, SPLIT_MW = 3.0, 6.0


def get_json(url, params, tries=3):
    full = url + "?" + urllib.parse.urlencode(params, safe=",")
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": "LEC-MountCoffee-forecast/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(5 * (i + 1))
    raise last


def p_ac_kw(g, ta):
    if g is None or ta is None:
        return None
    g = max(0.0, g)
    tc = ta + g * 25 / 800
    p_dc = DC_KWP * g / 1000 * (1 - 0.0034 * (tc - 25))
    return min(0.97 * p_dc, LIMIT_KW)


def factor(a, b, aod):
    return max(0.3, a - b * (aod if aod is not None else 0.3))


def parse_t(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:00Z")


def load_calibration(live):
    try:
        with open(os.path.join(live, "nwp_calibration.json"), encoding="utf-8") as fh:
            c = json.load(fh)
        return c if c.get("use") else None
    except Exception:
        return None


def build(now, cal=None):
    base = {"latitude": LAT, "longitude": LON, "tilt": TILT, "azimuth": AZIMUTH, "forecast_days": 3, "timezone": "GMT"}
    multi = get_json("https://api.open-meteo.com/v1/forecast",
                     {**base, "hourly": "global_tilted_irradiance,temperature_2m", "models": ",".join(MODELS)})
    old = get_json("https://api.open-meteo.com/v1/forecast",
                   {**base, "minutely_15": "global_tilted_irradiance,temperature_2m"})
    aq = get_json("https://air-quality-api.open-meteo.com/v1/air-quality",
                  {"latitude": LAT, "longitude": LON, "hourly": "aerosol_optical_depth,dust", "forecast_days": 3, "timezone": "GMT"})

    aod = {parse_t(t): v for t, v in zip(aq["hourly"]["time"], aq["hourly"]["aerosol_optical_depth"])}
    dust = {parse_t(t): v for t, v in zip(aq["hourly"]["time"], aq["hourly"].get("dust", [None] * len(aq["hourly"]["time"])))}

    def aod_at(t):
        h = t.replace(minute=0)
        return aod.get(h) if aod.get(h) is not None else aod.get(h - timedelta(hours=1))

    # NEW: hourly; each value is the mean of the hour ending at t, so it is plotted at t - 30 min
    H = multi["hourly"]
    hourly, models_used = [], set()
    for i, ts in enumerate(H["time"]):
        t = parse_t(ts)
        a = aod_at(t)
        per, gti = {}, []
        for m in MODELS:
            g = (H.get(f"global_tilted_irradiance_{m}") or [None] * len(H["time"]))[i]
            ta = (H.get(f"temperature_2m_{m}") or [None] * len(H["time"]))[i]
            p = p_ac_kw(g, ta)
            if p is not None:
                per[m] = p * factor(NEW_A, NEW_B, a) / 1000
                gti.append(max(0.0, g))
                models_used.add(m)
        if not per:
            continue
        mean = min(sum(per.values()) / len(per), LIMIT_KW / 1000)
        harris = mean
        lo_f, hi_f = NEW_LO, NEW_HI
        if cal and str(t.hour) in cal["a_by_hour_end"]:
            # hour-by-hour calibration against the logger (calibrate_nwp.py): undo the daily factor, apply the hour's
            f_old = factor(NEW_A, NEW_B, a)
            pac = sum(per.values()) / len(per) / f_old
            k = max(0.2, cal["a_by_hour_end"][str(t.hour)] - cal["b_aod"] * (a if a is not None else 0.3))
            mean = min(pac * k, LIMIT_KW / 1000)
            lo_f, hi_f = cal["q10_by_hour_end"][str(t.hour)], cal["q90_by_hour_end"][str(t.hour)]
        hourly.append({"t": iso(t - timedelta(minutes=30)), "end": iso(t), "new": round(mean, 3), "harris": round(harris, 3),
                       "low": round(mean * lo_f, 3), "high": round(min(mean * hi_f, LIMIT_KW / 1000), 3),
                       "models": {LABELS[m]: round(min(v * (mean / harris if harris > 0 else 1), LIMIT_KW / 1000), 3) for m, v in per.items()},
                       "gti": round(sum(gti) / len(gti), 1),            # W/m², 10° south, mean of the models
                       "aod": a, "dust": dust.get(t.replace(minute=0))})

    # OLD: 15-min; value = mean of the 15 minutes ending at t, plotted at t - 7.5 min
    Q = old["minutely_15"]
    quarter = []
    for t_s, g, ta in zip(Q["time"], Q["global_tilted_irradiance"], Q["temperature_2m"]):
        t = parse_t(t_s)
        p = p_ac_kw(g, ta)
        if p is None:
            continue
        v = min(p * factor(OLD_A, OLD_B, aod_at(t)), LIMIT_KW) / 1000
        quarter.append({"t": iso(t - timedelta(minutes=7, seconds=30)), "old": round(v, 3), "gti": round(max(0.0, g), 1),
                        "low": round(v * OLD_LO, 3), "high": round(min(v * OLD_HI, LIMIT_KW / 1000), 3)})

    # daily energy
    days = {}
    for h in hourly:
        d = days.setdefault(h["t"][:10], {"new": 0.0, "low": 0.0, "high": 0.0, "old": 0.0})   # by mid-hour time
        d["new"] += h["new"]; d["low"] += h["low"]; d["high"] += h["high"]
    for q in quarter:
        days.setdefault(q["t"][:10], {"new": 0.0, "low": 0.0, "high": 0.0, "old": 0.0})["old"] += q["old"] * 0.25
    day_list = [{"date": k, "newMwh": round(v["new"], 1), "lowMwh": round(v["low"], 1), "highMwh": round(v["high"], 1),
                 "oldMwh": round(v["old"], 1)} for k, v in sorted(days.items()) if k >= now.strftime("%Y-%m-%d")]

    return {"issued": iso(now), "location": {"lat": LAT, "lon": LON, "tilt": TILT, "azimuth": AZIMUTH},
            "modelsUsed": [LABELS[m] for m in MODELS if m in models_used], "hourly": hourly, "quarter": quarter,
            "days": day_list, "alerts": alerts(hourly, now),
            "calibration": ({"fitted": cal["fitted_utc"], "period": cal["period"], "mae": cal["out_of_sample_mae_mw"]} if cal else None),
            "credit": "Weather data by Open-Meteo.com (CC BY 4.0); method: J. A. Harris, LEC SCADA/EMS"}


def alerts(hourly, now):
    out = []
    upcoming = [h for h in hourly if datetime.strptime(h["end"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) > now][:48]
    # ramp: forecast drops >= 3 MW from one hour to the next
    for a, b in zip(upcoming, upcoming[1:]):
        if a["new"] - b["new"] >= RAMP_MW:
            out.append({"kind": "ramp", "time": b["t"],
                        "text": f"Solar expected to drop {a['new'] - b['new']:.1f} MW within an hour "
                                f"({a['new']:.1f} → {b['new']:.1f} MW, hour ending {b['end'][11:16]} on {b['end'][:10]})"})
    # reserve and model split, per day, 10:00-15:00
    by_day = {}
    for h in upcoming:
        if 10 <= int(h["t"][11:13]) < 15:
            by_day.setdefault(h["t"][:10], []).append(h)
    for day, hs in by_day.items():
        hi = max(x["high"] for x in hs); lo = min(x["low"] for x in hs)
        out.append({"kind": "reserve", "time": f"{day}T10:00:00Z",
                    "text": f"{day} 10:00–15:00: solar could be anywhere from {lo:.1f} to {hi:.1f} MW "
                            f"(high edge {hi:.1f} MW). Hold reserve for a loss of up to {hi:.1f} MW."})
        for x in hs:
            if 11 <= int(x["t"][11:13]) < 14 and len(x["models"]) >= 3:
                spread = max(x["models"].values()) - min(x["models"].values())
                if spread >= SPLIT_MW:
                    out.append({"kind": "split", "time": x["t"],
                                "text": f"Weather models disagree by {spread:.1f} MW around {x['t'][11:16]} on {day}: low confidence"})
                    break
    return out


def save(live, fc, now):
    tmp = os.path.join(live, "nwp_forecast.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, separators=(",", ":"))
    os.replace(tmp, os.path.join(live, "nwp_forecast.json"))

    log = os.path.join(live, "nwp_daily_log.csv")
    new = not os.path.exists(log)
    with open(log, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["issued_utc", "date", "new_mwh", "low_mwh", "high_mwh", "old_mwh"])
        for d in fc["days"]:
            if d["date"] >= now.strftime("%Y-%m-%d"):
                w.writerow([fc["issued"], d["date"], d["newMwh"], d["lowMwh"], d["highMwh"], d["oldMwh"]])

    # every issue's hourly values, append-only (verify.py scores each hour by lead time and seals the log daily)
    hlog = os.path.join(live, "nwp_hourly_log.csv")
    new = not os.path.exists(hlog)
    with open(hlog, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["issued_utc", "hour_end", "forecast_mw", "low_mw", "high_mw", "calibrated"])
        for h in fc["hourly"]:
            if h["end"] > fc["issued"] and h["high"] > 0.05:
                w.writerow([fc["issued"], h["end"], h["new"], h["low"], h["high"], bool(fc.get("calibration"))])

    prof = os.path.join(live, "nwp_profiles")
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, now.strftime("%Y-%m-%d") + ".json"), "w", encoding="utf-8") as fh:
        json.dump({"issued": fc["issued"], "hourly": [{k: h[k] for k in ("t", "end", "new", "low", "high")} for h in fc["hourly"]]},
                  fh, separators=(",", ":"))



# ---------------------------------------------------------------- Google Sheet (for the claude.ai dashboard)
SENT = {655.35, 6553.5, 65535}


def post_sheet(cfg, body):
    url = cfg.get("sheet_webhook_url")
    if not url or not cfg.get("sheet_token"):
        return "no sheet configured"
    data = json.dumps({"token": cfg["sheet_token"], **body}).encode("utf-8")
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "text/plain;charset=utf-8"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")[:200]
        except Exception as e:
            last = e
            time.sleep(15 * (attempt + 1))
    return f"failed: {last}"


def daily_actuals(live):
    """Energy (sum of 1-min MW / 60), peak and minutes per day from the collector's iv2_live files."""
    out = {}
    for name in sorted(os.listdir(live)):
        if not (name.startswith("iv2_live_") and name.endswith(".csv")):
            continue
        with open(os.path.join(live, name), encoding="latin-1", newline="") as fh:
            rows = list(csv.reader(fh, delimiter=";"))
        if not rows or "Information.Inverter sum P" not in rows[0]:
            continue
        k = rows[0].index("Information.Inverter sum P")
        e = peak = 0.0
        n = 0
        date = None
        for r in rows[1:]:
            if not r or r[0].startswith("[") or len(r) <= k:
                continue
            try:
                v = float(r[k].replace(",", "."))
            except ValueError:
                continue
            if v in SENT or v < -0.1 or v > 20:
                continue
            dd, mm, yyyy = r[0].split(".")
            date = f"{yyyy}-{mm}-{dd}"
            e += max(v, 0) / 60
            peak = max(peak, v)
            n += 1
        if date:
            out[date] = (round(e, 1), round(peak, 2), n)
    return out


def scorecard_rows(live):
    log = os.path.join(live, "nwp_daily_log.csv")
    day_ahead, same_day = {}, {}
    if os.path.exists(log):
        with open(log, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if r["issued_utc"][:10] < r["date"]:
                    day_ahead[r["date"]] = r                    # last issue before the day
                elif r["issued_utc"][:10] == r["date"] and r["date"] not in same_day:
                    same_day[r["date"]] = r                     # first issue on the day
    act = daily_actuals(live)
    rows = []
    for d in sorted(set(act) | set(day_ahead)):
        a = act.get(d, ("", "", ""))
        da, sd = day_ahead.get(d, {}), same_day.get(d, {})
        num = lambda x: float(x) if x not in ("", None) else ""
        rows.append([d, a[0], a[1], a[2], num(da.get("new_mwh")), num(da.get("low_mwh")), num(da.get("high_mwh")),
                     num(da.get("old_mwh")), num(sd.get("new_mwh"))])
    return rows[-120:]


def push_to_sheet(cfg, live, fc):
    names = list(LABELS.values())
    quarter_by_hour = {}
    for q in fc["quarter"]:
        t = datetime.strptime(q["t"], "%Y-%m-%dT%H:%M:%SZ") + timedelta(minutes=7, seconds=30)   # end of its 15 min
        end = (t - timedelta(minutes=1)).replace(minute=0) + timedelta(hours=1)
        quarter_by_hour.setdefault(end.strftime("%Y-%m-%dT%H:%M:00Z"), []).append(q["old"])
    hourly = []
    for h in fc["hourly"]:
        olds = quarter_by_hour.get(h["end"], [])
        hourly.append([h["t"], h["end"], h["new"], h["low"], h["high"], round(sum(olds) / len(olds), 3) if olds else ""]
                      + [h["models"].get(n, "") for n in names] + [h["aod"] if h["aod"] is not None else "", fc["issued"], h.get("gti", "")])
    results = [
        post_sheet(cfg, {"action": "replace", "sheet": "WeatherHourly",
                         "header": ["time_mid", "hour_end", "forecast_mw", "low_mw", "high_mw", "single_model_mw"] + names + ["aod", "issued", "gti_wm2"],
                         "rows": hourly}),
        post_sheet(cfg, {"action": "replace", "sheet": "WeatherDays",
                         "header": ["date", "forecast_mwh", "low_mwh", "high_mwh", "single_model_mwh", "issued"],
                         "rows": [[d["date"], d["newMwh"], d["lowMwh"], d["highMwh"], d["oldMwh"], fc["issued"]] for d in fc["days"]]}),
        post_sheet(cfg, {"action": "replace", "sheet": "WeatherAlerts", "header": ["kind", "time", "text", "issued"],
                         "rows": [[a["kind"], a["time"], a["text"], fc["issued"]] for a in fc["alerts"]]}),
        post_sheet(cfg, {"action": "replace", "sheet": "DailyEnergy",
                         "header": ["date", "actual_mwh", "peak_mw", "minutes", "dayahead_mwh", "dayahead_low_mwh",
                                    "dayahead_high_mwh", "dayahead_single_model_mwh", "sameday_mwh"],
                         "rows": scorecard_rows(live)}),
    ]
    ok = sum('"ok":true' in r.replace(" ", "") for r in results)
    return f"sheet {ok}/4" + ("" if ok == 4 else " " + " | ".join(r[:80] for r in results if '"ok":true' not in r.replace(" ", "")))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--no-send", action="store_true", help="do not write to the Google Sheet")
    a = ap.parse_args()
    cfg = load_config(a.config)
    live = cfg["live_dir"]
    os.makedirs(live, exist_ok=True)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    try:
        fc = build(now, load_calibration(live))
        save(live, fc, now)
        sheet = "not sent (--no-send)" if a.no_send else push_to_sheet(cfg, live, fc)
        msg = f"ok  {sheet}  models: {len(fc['modelsUsed'])}  days: " + "  ".join(f"{d['date']} {d['newMwh']} MWh" for d in fc["days"])
    except Exception as e:
        msg = f"ERROR {e}"
    with open(os.path.join(live, "nwp_runs.txt"), "a", encoding="utf-8") as fh:
        fh.write(f"{now:%Y-%m-%d %H:%M} UTC  {msg}\n")
    print(msg)
    if msg.startswith("ERROR"):
        sys.exit(1)


if __name__ == "__main__":
    main()
