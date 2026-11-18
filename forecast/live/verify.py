"""Forecast verification for Mount Coffee: seal the forecast logs, score every forecast against the logger, report.

Run on the forecast PC by the "MCSolar Alerts" task (alerts.py starts it once an hour), or by hand:
    python live/verify.py --config live/config.json            score, seal, write the report files
    python live/verify.py --config live/config.json --print    also print the headline table

What it proves, and how
  1. Frozen forecasts. The forecasters append to forecast_log.csv (15/30/60 min), nwp_daily_log.csv (daily energy)
     and nwp_hourly_log.csv (hourly, every issue). Once a UTC day is over, this script seals that day's rows: a
     SHA-256 of the rows, the hashes of the model files in use, and a chain hash that includes the day before
     (verification_ledger.csv, also copied to the Google Sheet tab "VerificationLedger"). Every run re-checks every
     sealed day; a row changed, removed or added afterwards shows as an integrity problem on the dashboard and in
     the report. Rows issued before the first sealing can only be vouched for from that date on.
  2. Fixed truth. Actual = the logger's 1-minute "Information.Inverter sum P" (inverter side, about 1.9 % above the
     J07 grid export). 15/30/60 min: mean of the 15 minutes ending at the target time (12 of 15 minutes needed).
     Hourly: mean MW of the hour ending at the target time (50 of 60 minutes). Daily: energy of the whole day.
  3. Standard measures. MAE, RMSE, bias (forecast - actual: + means the forecast was too high), nMAE (MAE as % of
     the 17.79 MWac rating) and skill (1 - MAE / MAE of a simple reference):
       persistence        output now carried forward (15/30/60 min)
       smart persistence  cloudiness now (output / clear sky) carried forward on the clear-sky curve (15/30/60 min)
       yesterday          the same hour / the whole day one day earlier (weather-model forecasts)
     Ranges: coverage = share of actuals inside the stated low-high range (the weather-model range is meant as a
     likely range, so about 80 % is the aim); width = average high - low.
  4. Conditions. Every sample is also scored by sky type of its day (from kpi.py: energy / clear-sky potential),
     by hour of day (GMT) and by month.
  5. Days that cannot be scored are listed, never dropped quietly: data gaps (daily energy not scored, minutes that
     exist still are), plant/grid outages and curtailment (nothing scored that day - the forecast is for an
     unconstrained plant).
  6. Big misses get a cause tag (inverters down, weather - less / more sun than expected).
  7. A figure is "provisional" until it rests on 30 scored days (weather models, daily energy) or 14 days (15/30/60 min).

Writes to the live folder:
  verification.json              everything the dashboard shows
  verification_ledger.csv        one sealed row per UTC day (append-only)
  verification_days.csv          one row per day: actual, forecasts, misses, status
  reports/verification_YYYY-MM.md   monthly report (every month with data is rewritten each run)
  verification_cache.json        parsed logger minutes (speed only; safe to delete)
Standard library only.
"""
import argparse
import csv
import glob
import hashlib
import json
import math
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the forecast folder (trained models live here)

RATED_MWAC = 17.79
LIMIT_MW = 16.64
P_COL = "Information.Inverter sum P"
SENTINELS = {655.35, 6553.5, 65535.0}
DAYLIGHT = (6 * 60, 18 * 60 + 30)       # minutes of the day (GMT) used to judge whether a day is complete
FULL_DAY_MIN = 675                      # 90 % of the 750 daylight minutes
OUTAGE_MIN = 30                         # plant/grid outage or curtailment minutes that exclude a day
SKY = [("sunny", 0.65), ("mixed", 0.40), ("cloudy", -1.0)]   # day energy / clear-sky potential
MIN_DAYS = {"short": 14, "long": 30}
BIG_DAILY_MWH, BIG_DAILY_FRAC, BIG_HOURLY_MW = 15.0, 0.25, 5.0

PRODUCTS = [
    # key, label, unit, family, references
    ("st15", "Plant data, 15 min ahead", "MW", "short", ["persistence", "smart_persistence"]),
    ("st30", "Plant data, 30 min ahead", "MW", "short", ["persistence", "smart_persistence"]),
    ("st60", "Plant data, 60 min ahead", "MW", "short", ["persistence", "smart_persistence"]),
    ("nwp_h_0_6", "Weather models, hourly, 1-6 h ahead", "MW", "long", ["yesterday"]),
    ("nwp_h_6_24", "Weather models, hourly, 6-24 h ahead", "MW", "long", ["yesterday"]),
    ("nwp_h_dayahead", "Weather models, hourly, day-ahead", "MW", "long", ["yesterday"]),
    ("nwp_h_24_48", "Weather models, hourly, 24-48 h ahead", "MW", "long", ["yesterday"]),
    ("nwp_h_48_72", "Weather models, hourly, 48-72 h ahead", "MW", "long", ["yesterday"]),
    ("daily_dayahead", "Daily energy, day-ahead", "MWh", "long", ["yesterday"]),
    ("daily_sameday", "Daily energy, same day (first issue)", "MWh", "long", ["yesterday"]),
]
REF_LABEL = {"persistence": "repeat the last 15 min", "smart_persistence": "carry today's cloudiness forward",
             "yesterday": "same as yesterday"}


# ------------------------------------------------------------------ small helpers
def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    return cfg


def fnum(v):
    try:
        x = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def to_min(t):
    """datetime (UTC) -> whole minutes since the epoch."""
    return int(t.replace(tzinfo=timezone.utc).timestamp() // 60)


def from_min(m):
    return datetime.fromtimestamp(m * 60, tz=timezone.utc)


def parse_time(s):
    """'2026-11-18 11:00', '2026-11-18T11:00:00Z' or '2026-11-18T11:00' -> minutes since the epoch."""
    s = (s or "").strip().replace("T", " ").rstrip("Z")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return to_min(datetime.strptime(s, fmt))
        except ValueError:
            pass
    return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def rnd(x, d=2):
    return None if x is None else round(x, d)


# ------------------------------------------------------------------ actuals from the logger
def read_logger_file(path):
    """iv2_live file -> {minute: MW}."""
    out = {}
    with open(path, encoding="latin-1", newline="") as fh:
        rows = csv.reader(fh, delimiter=";")
        head = next(rows, None)
        if not head or P_COL not in head:
            return out
        k = head.index(P_COL)
        for r in rows:
            if len(r) <= k or not r[0] or r[0].startswith("["):
                continue
            v = fnum(r[k])
            if v is None or v in SENTINELS or v < -0.1 or v > 20:
                continue
            try:
                dd, mm, yyyy = r[0].split(".")
                t = datetime(int(yyyy), int(mm), int(dd), int(r[1][0:2]), int(r[1][3:5]))
            except (ValueError, IndexError):
                continue
            out[to_min(t)] = max(v, 0.0)
    return out


def load_actuals(live):
    """All iv2_live files -> {minute: MW}, using a cache keyed on file name, size and modification time."""
    cache_path = os.path.join(live, "verification_cache.json")
    try:
        with open(cache_path, encoding="utf-8") as fh:
            cache = json.load(fh)
    except Exception:
        cache = {}
    P, new_cache = {}, {}
    for path in sorted(glob.glob(os.path.join(live, "iv2_live_*.csv"))):
        name, st = os.path.basename(path), os.stat(path)
        key = f"{st.st_size}:{int(st.st_mtime)}"
        c = cache.get(name)
        if c and c.get("key") == key:
            part = {int(m): v for m, v in c["p"].items()}
        else:
            part = read_logger_file(path)
        new_cache[name] = {"key": key, "p": {str(m): v for m, v in part.items()}}
        P.update(part)
    try:
        tmp = cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(new_cache, fh, separators=(",", ":"))
        os.replace(tmp, cache_path)
    except OSError:
        pass
    return P


def window_mean(P, end, length, need):
    vals = [P[m] for m in range(end - length + 1, end + 1) if m in P]
    return sum(vals) / len(vals) if len(vals) >= need else None


def day_energy(P, date):
    d0 = to_min(datetime.strptime(date, "%Y-%m-%d"))
    vals = [P[m] for m in range(d0, d0 + 1440) if m in P]
    daylight = sum(1 for m in range(d0 + DAYLIGHT[0], d0 + DAYLIGHT[1]) if m in P)
    return (sum(vals) / 60.0 if vals else None), daylight


# ------------------------------------------------------------------ which days count
def load_kpi(live):
    try:
        with open(os.path.join(live, "kpi_daily.json"), encoding="utf-8") as fh:
            return {r["date"]: r for r in json.load(fh)}
    except Exception:
        return {}


def sky_of(k):
    if not k:
        return None, None
    cs = (k.get("losses_mwh") or {}).get("clear_sky")
    e = k.get("energy_mwh")
    if not cs or e is None:
        return None, None
    ratio = e / cs
    for name, lo in SKY:
        if ratio >= lo:
            return name, round(ratio, 3)
    return None, None


def day_info(date, P, kpi, today):
    """status: scored | partial (data gap: daily energy not scored) | excluded (outage/curtailment) | today"""
    energy, daylight = day_energy(P, date)
    k = kpi.get(date) or {}
    sky, ratio = sky_of(k)
    info = {"date": date, "actual_mwh": rnd(energy, 1), "daylight_minutes": daylight, "sky": sky, "clear_sky_ratio": ratio,
            "status": "scored", "reason": ""}
    if (k.get("outage_minutes") or 0) >= OUTAGE_MIN:
        info.update(status="excluded", reason=f"plant/grid outage ({k['outage_minutes']} min)")
    elif (k.get("curtailed_minutes") or 0) >= OUTAGE_MIN:
        info.update(status="excluded", reason=f"curtailed by the power limit ({k['curtailed_minutes']} min)")
    elif date >= today:
        info.update(status="today", reason="day not over yet")
    elif daylight == 0:
        info.update(status="partial", reason="no logger data")
    elif daylight < FULL_DAY_MIN:
        info.update(status="partial", reason=f"data gap ({daylight} of 750 daylight minutes logged)")
    info["inverters_down_mwh"] = rnd((k.get("losses_mwh") or {}).get("inverters_down"), 1)
    return info


# ------------------------------------------------------------------ forecast logs
def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def short_term_samples(live, P):
    out = []
    for r in read_csv(os.path.join(live, "forecast_log.csv")):
        if not (r.get("status") or "").startswith("ok") or r.get("model") in ("", "none"):
            continue
        t = parse_time(r.get("issued_utc"))
        now = fnum(r.get("p_now_mw"))
        if t is None or now is None:
            continue
        cs = {h: fnum(r.get(f"clear_sky_{h}min_mw")) for h in (15, 30, 60)}
        cs_now = 2 * cs[15] - cs[30] if cs[15] is not None and cs[30] is not None else None   # clear sky is smooth
        k_now = min(max(now / cs_now, 0.0), 1.3) if cs_now and cs_now >= 1 else None
        for h in (15, 30, 60):
            f = fnum(r.get(f"p_{h}min_mw"))
            if f is None or not cs[h] or cs[h] < 1:          # daylight only
                continue
            target = t + h
            a = window_mean(P, target, 15, 12)
            if a is None:
                continue
            smart = min(k_now * cs[h], LIMIT_MW) if k_now is not None else now
            out.append({"product": f"st{h}", "target": target, "f": f, "a": a,
                        "refs": {"persistence": now, "smart_persistence": smart}, "model": r.get("model")})
    return out


def hourly_issues(live):
    """[(issued_min, [(end_min, f, low, high)])] from nwp_hourly_log.csv, plus older issues saved only in
    nwp_profiles/<date>.json (the last issue of each date, before the hourly log existed)."""
    issues = {}
    for r in read_csv(os.path.join(live, "nwp_hourly_log.csv")):
        t, e = parse_time(r.get("issued_utc")), parse_time(r.get("hour_end"))
        f = fnum(r.get("forecast_mw"))
        if t is None or e is None or f is None:
            continue
        issues.setdefault(t, []).append((e, f, fnum(r.get("low_mw")), fnum(r.get("high_mw"))))
    for path in sorted(glob.glob(os.path.join(live, "nwp_profiles", "*.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                prof = json.load(fh)
        except Exception:
            continue
        t = parse_time(prof.get("issued"))
        if t is None or t in issues:
            continue
        rows = []
        for h in prof.get("hourly", []):
            e = parse_time(h.get("end"))
            if e is not None and e > t and (h.get("high") or 0) > 0.05:
                rows.append((e, h.get("new"), h.get("low"), h.get("high")))
        if rows:
            issues[t] = rows
    return sorted(issues.items())


def hourly_samples(live, P):
    out = []
    issues = hourly_issues(live)
    last_before_day = {}           # target date -> issue time of the last issue before that date
    for t, _ in issues:
        d_next = from_min(t).date() + timedelta(days=1)
        last_before_day[d_next.isoformat()] = t
    for t, rows in issues:
        for e, f, lo, hi in rows:
            a = window_mean(P, e, 60, 50)
            if a is None or (f < 0.1 and a < 0.1):
                continue
            lead = (e - t) / 60.0
            key = "nwp_h_0_6" if lead <= 6 else "nwp_h_6_24" if lead <= 24 else "nwp_h_24_48" if lead <= 48 else "nwp_h_48_72"
            s = {"target": e, "f": f, "a": a, "low": lo, "high": hi,
                 "refs": {"yesterday": window_mean(P, e - 1440, 60, 50)}, "issued": t}
            out.append({**s, "product": key})
            target_date = from_min(e - 1).date().isoformat()
            if last_before_day.get(target_date) == t:
                out.append({**s, "product": "nwp_h_dayahead"})
    return out


def daily_samples(live, days):
    day_ahead, same_day = {}, {}
    for r in read_csv(os.path.join(live, "nwp_daily_log.csv")):
        issued, date = (r.get("issued_utc") or "")[:10], r.get("date")
        if not date or not issued:
            continue
        if issued < date:
            day_ahead[date] = r                       # last issue before the day
        elif issued == date and date not in same_day:
            same_day[date] = r                        # first issue on the day
    out = []
    for date, info in days.items():
        if info["status"] != "scored" or info["actual_mwh"] is None:
            continue
        prev = days.get((datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d"))
        ref = prev["actual_mwh"] if prev and prev["status"] == "scored" else None
        target = to_min(datetime.strptime(date, "%Y-%m-%d") + timedelta(hours=12))
        for key, src in (("daily_dayahead", day_ahead), ("daily_sameday", same_day)):
            r = src.get(date)
            f = fnum(r.get("new_mwh")) if r else None
            if f is None:
                continue
            out.append({"product": key, "target": target, "f": f, "a": info["actual_mwh"],
                        "low": fnum(r.get("low_mwh")), "high": fnum(r.get("high_mwh")), "refs": {"yesterday": ref},
                        "issued": r.get("issued_utc")})
    return out


# ------------------------------------------------------------------ statistics
def stats(samples, unit, refs):
    n = len(samples)
    if not n:
        return {"n": 0}
    err = [s["f"] - s["a"] for s in samples]
    mae = sum(abs(e) for e in err) / n
    out = {"n": n, "days": len({from_min(s["target"] - 1).date() for s in samples}),
           "mae": rnd(mae), "rmse": rnd(math.sqrt(sum(e * e for e in err) / n)), "bias": rnd(sum(err) / n),
           "mean_actual": rnd(sum(s["a"] for s in samples) / n)}
    if unit == "MW":
        out["nmae_pct"] = rnd(mae / RATED_MWAC * 100, 1)
    else:
        mean_a = sum(s["a"] for s in samples) / n
        out["mae_pct_of_actual"] = rnd(mae / mean_a * 100, 1) if mean_a > 0 else None
    out["refs"] = {}
    for ref in refs:
        both = [s for s in samples if s["refs"].get(ref) is not None]
        if len(both) < max(5, n // 2):
            continue
        m_f = sum(abs(s["f"] - s["a"]) for s in both) / len(both)
        m_r = sum(abs(s["refs"][ref] - s["a"]) for s in both) / len(both)
        out["refs"][ref] = {"mae": rnd(m_r), "skill_pct": rnd((1 - m_f / m_r) * 100, 1) if m_r > 0 else None, "n": len(both)}
    ranged = [s for s in samples if s.get("low") is not None and s.get("high") is not None]
    if ranged:
        inside = sum(1 for s in ranged if s["low"] - 1e-6 <= s["a"] <= s["high"] + 1e-6)
        out["coverage_pct"] = rnd(inside / len(ranged) * 100, 1)
        out["below_range_pct"] = rnd(sum(1 for s in ranged if s["a"] < s["low"]) / len(ranged) * 100, 1)
        out["above_range_pct"] = rnd(sum(1 for s in ranged if s["a"] > s["high"]) / len(ranged) * 100, 1)
        out["mean_width"] = rnd(sum(s["high"] - s["low"] for s in ranged) / len(ranged))
    return out


def grouped(samples, keyfn, unit, refs):
    groups = {}
    for s in samples:
        k = keyfn(s)
        if k is not None:
            groups.setdefault(k, []).append(s)
    return {k: stats(v, unit, refs) for k, v in sorted(groups.items())}


# ------------------------------------------------------------------ sealing ledger
LOGS = [("forecast_log.csv", "forecast_rows"), ("nwp_daily_log.csv", "nwp_daily_rows"), ("nwp_hourly_log.csv", "nwp_hourly_rows")]
LEDGER_FIELDS = ["date", "sealed_utc", "forecast_rows", "nwp_daily_rows", "nwp_hourly_rows", "data_sha256", "models",
                 "prev_chain_sha256", "chain_sha256"]


def rows_by_day(live):
    """{date: {log name: [raw line, ...]}} for every data line of the three forecast logs, by issue date."""
    out = {}
    for name, _ in LOGS:
        path = os.path.join(live, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8", newline="") as fh:
            lines = fh.read().splitlines()
        for line in lines[1:]:
            if not line.strip():
                continue
            t = parse_time(line.split(",", 1)[0].strip('"'))
            if t is None:
                continue
            out.setdefault(from_min(t).date().isoformat(), {}).setdefault(name, []).append(line)
    return out


def day_digest(day_rows):
    h = hashlib.sha256()
    for name, _ in LOGS:
        h.update(f"[{name}]\n".encode())
        for line in day_rows.get(name, []):
            h.update(line.encode("utf-8") + b"\n")
    return h.hexdigest()


def model_fingerprint(live):
    parts = []
    for path in sorted(glob.glob(os.path.join(ROOT, "*.joblib"))) + [os.path.join(live, "nwp_calibration.json")]:
        if os.path.exists(path):
            parts.append(f"{os.path.basename(path)}:{sha256_file(path)[:12]}")
    return ";".join(parts)


def chain(prev, row):
    return hashlib.sha256("|".join([prev, row["date"], row["data_sha256"], row["models"]]).encode()).hexdigest()


def seal_and_check(live, today, now):
    path = os.path.join(live, "verification_ledger.csv")
    ledger = read_csv(path)
    by_day = rows_by_day(live)
    issues = []
    prev = ""
    for row in ledger:
        if row.get("prev_chain_sha256", "") != prev or chain(prev, row) != row.get("chain_sha256"):
            issues.append(f"{row.get('date')}: ledger row edited (chain hash does not match)")
        prev = row.get("chain_sha256", "")
        got = by_day.get(row["date"], {})
        if day_digest(got) != row.get("data_sha256"):
            counts = ", ".join(f"{col.replace('_rows', '')} {row.get(col)} sealed / {len(got.get(name, []))} now"
                               for name, col in LOGS)
            issues.append(f"{row['date']}: forecast rows changed after sealing ({counts})")
    last = ledger[-1]["date"] if ledger else ""
    models = model_fingerprint(live)
    added = []
    for date in sorted(d for d in by_day if last < d < today):
        row = {"date": date, "sealed_utc": now.strftime("%Y-%m-%d %H:%M"),
               **{col: len(by_day[date].get(name, [])) for name, col in LOGS},
               "data_sha256": day_digest(by_day[date]), "models": models, "prev_chain_sha256": prev}
        row["chain_sha256"] = chain(prev, row)
        prev = row["chain_sha256"]
        added.append(row)
    if added:
        new = not os.path.exists(path)
        with open(path, "a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=LEDGER_FIELDS)
            if new:
                w.writeheader()
            w.writerows(added)
        ledger += added
    late = sorted(d for d in by_day if ledger and d <= ledger[-1]["date"] and d not in {r["date"] for r in ledger})
    for d in late:
        issues.append(f"{d}: forecast rows appeared for a day that was already past when the ledger was sealed")
    return {"status": "ok" if not issues else "problem", "issues": issues, "sealed_days": len(ledger),
            "first_sealed": ledger[0]["date"] if ledger else None, "first_sealed_utc": ledger[0]["sealed_utc"] if ledger else None,
            "last_sealed": ledger[-1]["date"] if ledger else None,
            "last_chain_sha256": ledger[-1]["chain_sha256"] if ledger else None, "models_now": models}, ledger


# ------------------------------------------------------------------ assembling the results
def build(live, now):
    today = now.date().isoformat()
    P = load_actuals(live)
    kpi = load_kpi(live)
    # a day is sealed an hour after it ends, so its last forecasts have been written
    integrity, ledger = seal_and_check(live, (now - timedelta(hours=1)).date().isoformat(), now)
    st = short_term_samples(live, P)
    hr = hourly_samples(live, P)
    seen = {from_min(m).date().isoformat() for m in P} | {from_min(s["target"] - 1).date().isoformat() for s in st + hr}
    dates = []
    if seen:          # every calendar day from the first to the last, so days with no data at all are listed too
        d, end = datetime.strptime(min(seen), "%Y-%m-%d"), datetime.strptime(max(seen), "%Y-%m-%d")
        while d <= end:
            dates.append(d.strftime("%Y-%m-%d"))
            d += timedelta(days=1)
    days = {d: day_info(d, P, kpi, today) for d in dates}
    dl = daily_samples(live, days)

    def keep(s):        # nothing is scored on outage / curtailment days
        info = days.get(from_min(s["target"] - 1).date().isoformat())
        return info is None or info["status"] != "excluded"

    samples = [s for s in st + hr + dl if keep(s)]
    by_product = {}
    for s in samples:
        by_product.setdefault(s["product"], []).append(s)

    def date_of(s):
        return from_min(s["target"] - 1).date().isoformat()

    products = []
    for key, label, unit, family, refs in PRODUCTS:
        ss = by_product.get(key, [])
        overall = stats(ss, unit, refs)
        entry = {"key": key, "label": label, "unit": unit, "family": family, "overall": overall,
                 "provisional": overall.get("days", 0) < MIN_DAYS[family], "min_days": MIN_DAYS[family],
                 "by_sky": grouped(ss, lambda s: days.get(date_of(s), {}).get("sky"), unit, refs),
                 "by_month": grouped(ss, lambda s: date_of(s)[:7], unit, refs)}
        if unit == "MW":
            entry["by_hour"] = grouped(ss, lambda s: (from_min(s["target"] - 1)).hour, unit, refs)
        products.append(entry)

    # per-day table
    per_day = {}
    for s in samples:
        per_day.setdefault(date_of(s), {}).setdefault(s["product"], []).append(s)
    day_rows = []
    for d in dates:
        info = dict(days[d])
        got = per_day.get(d, {})
        for key in ("st15", "st60", "nwp_h_dayahead"):
            xs = got.get(key, [])
            info[f"{key}_mae"] = rnd(sum(abs(x["f"] - x["a"]) for x in xs) / len(xs)) if xs else None
            info[f"{key}_n"] = len(xs)
        for key in ("daily_dayahead", "daily_sameday"):
            x = (got.get(key) or [None])[0]
            info[key] = None if x is None else {"f": rnd(x["f"], 1), "low": rnd(x["low"], 1), "high": rnd(x["high"], 1),
                                                "miss": rnd(x["f"] - x["a"], 1),
                                                "in_range": None if x["low"] is None else x["low"] <= x["a"] <= x["high"]}
        info["cause"] = None
        da = info["daily_dayahead"]
        if da and abs(da["miss"]) >= max(BIG_DAILY_MWH, BIG_DAILY_FRAC * (info["actual_mwh"] or 0)):
            if (info.get("inverters_down_mwh") or 0) >= 3:
                info["cause"] = f"inverters down ({info['inverters_down_mwh']} MWh lost)"
            else:
                info["cause"] = "weather: less sun than the models expected" if da["miss"] > 0 else "weather: more sun than the models expected"
        day_rows.append(info)

    big_hourly = []
    for s in by_product.get("nwp_h_dayahead", []):
        if abs(s["f"] - s["a"]) >= BIG_HOURLY_MW:
            t = from_min(s["target"])
            big_hourly.append({"date": t.date().isoformat(), "hour_end": t.strftime("%H:%M"), "f": rnd(s["f"]), "a": rnd(s["a"]),
                               "miss": rnd(s["f"] - s["a"]), "cause": "weather: less sun than expected" if s["f"] > s["a"] else "weather: more sun than expected"})
    big_hourly = big_hourly[-30:]

    months = sorted({d["date"][:7] for d in day_rows})
    all_t = [s["target"] for s in samples]
    return {
        "generated_utc": now.strftime("%Y-%m-%dT%H:%M:00Z"),
        "period": {"from": from_min(min(all_t)).date().isoformat() if all_t else None,
                   "to": from_min(max(all_t)).date().isoformat() if all_t else None},
        "integrity": integrity,
        "products": products,
        "days": day_rows,
        "excluded": [{"date": d["date"], "status": d["status"], "reason": d["reason"]} for d in day_rows if d["status"] in ("excluded", "partial")],
        "big_misses": {"daily": [d for d in day_rows if d["cause"]], "hourly": big_hourly},
        "reports": months,
        "references": REF_LABEL,
        "rules": {"rated_mwac": RATED_MWAC, "sky_classes": {n: lo for n, lo in SKY}, "full_day_minutes": FULL_DAY_MIN,
                  "outage_minutes": OUTAGE_MIN, "min_days": MIN_DAYS, "big_daily_mwh": BIG_DAILY_MWH,
                  "big_daily_frac": BIG_DAILY_FRAC, "big_hourly_mw": BIG_HOURLY_MW},
    }, ledger


# ------------------------------------------------------------------ outputs
def fmt(v, d=2, plus=False):
    if v is None:
        return "—"
    s = f"{v:.{d}f}"
    return ("+" + s) if plus and v > 0 else s


def headline_rows(res, month=None):
    rows = []
    for p in res["products"]:
        o = p["by_month"].get(month, {"n": 0}) if month else p["overall"]
        if not o.get("n"):
            continue
        skill = "; ".join(f"{fmt(r['skill_pct'], 0)} % vs {REF_LABEL[k]}" for k, r in o.get("refs", {}).items())
        rel = f"{fmt(o.get('nmae_pct'), 1)} % of 17.79 MW" if p["unit"] == "MW" else f"{fmt(o.get('mae_pct_of_actual'), 1)} % of actual"
        cov = f"{fmt(o['coverage_pct'], 0)} %" if "coverage_pct" in o else "—"
        rows.append([p["label"], str(o["days"]), str(o["n"]), f"{fmt(o['mae'])} {p['unit']}", rel, f"{fmt(o['bias'], plus=True)} {p['unit']}",
                     skill or "—", cov, "provisional" if o["days"] < p["min_days"] else "established"])
    return rows


def md_table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def write_report(live, res, month):
    I = res["integrity"]
    days = [d for d in res["days"] if d["date"].startswith(month)]
    lines = [f"# Mount Coffee solar – forecast verification, {month}", "",
             f"Generated {res['generated_utc'].replace('T', ' ')[:16]} GMT by forecast/live/verify.py. "
             "Actual output is the logger's inverter-side measurement (about 1.9 % above the J07 grid export).", "",
             "## Integrity of the forecast records", ""]
    if I["sealed_days"]:
        lines.append(f"{I['sealed_days']} days sealed, {I['first_sealed']} to {I['last_sealed']} (sealing began "
                     f"{I['first_sealed_utc']} GMT). Latest chain hash `{I['last_chain_sha256'][:16]}…`.")
    else:
        lines.append("No day sealed yet.")
    lines.append("")
    lines.append("**All sealed records unchanged.**" if I["status"] == "ok" else "**Problems found:**\n\n" + "\n".join(f"- {x}" for x in I["issues"]))
    lines += ["", "## Accuracy this month", "",
              md_table(["Forecast", "Days", "Samples", "MAE", "MAE relative", "Bias", "Skill", "Inside range", "Status"], headline_rows(res, month)),
              "", "Bias = forecast − actual (+ means the forecast was too high). Skill = how much smaller the error is than "
              "the simple reference (positive is better). \"Provisional\" = fewer than 14 days (plant-data forecasts) or "
              "30 days (weather models, daily energy).", "", "## By sky type (all data so far)", ""]
    sky_rows = []
    for p in res["products"]:
        if p["key"] not in ("st15", "st60", "nwp_h_dayahead", "daily_dayahead"):
            continue
        for sky in ("sunny", "mixed", "cloudy"):
            o = p["by_sky"].get(sky)
            if o and o.get("n"):
                sky_rows.append([p["label"], sky, str(o["days"]), f"{fmt(o['mae'])} {p['unit']}", f"{fmt(o['bias'], plus=True)}",
                                 f"{fmt(o['coverage_pct'], 0)} %" if "coverage_pct" in o else "—"])
    lines.append(md_table(["Forecast", "Sky", "Days", "MAE", "Bias", "Inside range"], sky_rows) if sky_rows else "Not enough data yet.")
    lines += ["", f"Sky type of a day = its energy ÷ clear-sky potential: sunny ≥ {SKY[0][1]}, mixed ≥ {SKY[1][1]}, cloudy below.", "",
              "## Day by day", ""]
    drows = []
    for d in days:
        da, sd = d.get("daily_dayahead"), d.get("daily_sameday")
        drows.append([d["date"], fmt(d["actual_mwh"], 1), d["sky"] or "—",
                      fmt(da["f"], 1) if da else "—", (f"{fmt(da['low'], 0)}–{fmt(da['high'], 0)}" if da and da["low"] is not None else "—"),
                      fmt(da["miss"], 1, True) if da else "—", fmt(sd["f"], 1) if sd else "—",
                      fmt(d["st15_mae"]), fmt(d["st60_mae"]), fmt(d["nwp_h_dayahead_mae"]),
                      d["status"] + (f" – {d['reason']}" if d["reason"] else ""), d["cause"] or ""])
    lines.append(md_table(["Date", "Actual MWh", "Sky", "Day-ahead MWh", "Range", "Miss", "Same-day MWh", "15-min MAE",
                           "60-min MAE", "Hourly day-ahead MAE", "Status", "Big miss: cause"], drows) if drows else "No days.")
    hb = [h for h in res["big_misses"]["hourly"] if h["date"].startswith(month)]
    if hb:
        lines += ["", f"## Hours missed by {BIG_HOURLY_MW:.0f} MW or more (hourly day-ahead)", "",
                  md_table(["Date", "Hour ending", "Forecast MW", "Actual MW", "Miss", "Cause"],
                           [[h["date"], h["hour_end"], fmt(h["f"]), fmt(h["a"]), fmt(h["miss"], 2, True), h["cause"]] for h in hb])]
    lines += ["", "## How this is measured", "",
              "- Every forecast is logged when it is issued; each finished day is sealed with a SHA-256 hash chain "
              "(verification_ledger.csv, copied to the Google Sheet). Any later change shows above.",
              "- 15/30/60 min: compared with the logger's mean of the 15 minutes ending at the target time.",
              "- Weather models, hourly: the mean MW of the hour, scored for every issue by how far ahead it was issued; "
              "\"day-ahead\" is the last issue before the day.",
              "- Daily energy: day-ahead = last issue before the day, same day = first issue on the day.",
              "- Outage and curtailment days are not scored (the forecast is for the plant running freely); data-gap days "
              "are scored where data exists but their daily energy is not.", ""]
    out = os.path.join(live, "reports")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"verification_{month}.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def write_days_csv(live, res):
    head = ["date", "status", "reason", "actual_mwh", "sky", "clear_sky_ratio", "dayahead_mwh", "dayahead_low", "dayahead_high",
            "dayahead_miss", "dayahead_in_range", "sameday_mwh", "st15_mae_mw", "st60_mae_mw", "hourly_dayahead_mae_mw", "cause"]
    with open(os.path.join(live, "verification_days.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(head)
        for d in res["days"]:
            da, sd = d.get("daily_dayahead") or {}, d.get("daily_sameday") or {}
            w.writerow([d["date"], d["status"], d["reason"], d["actual_mwh"], d["sky"], d["clear_sky_ratio"], da.get("f"), da.get("low"),
                        da.get("high"), da.get("miss"), da.get("in_range"), sd.get("f"), d["st15_mae"], d["st60_mae"],
                        d["nwp_h_dayahead_mae"], d["cause"]])


def post_sheet(cfg, body):
    url = cfg.get("sheet_webhook_url")
    if not url or not cfg.get("sheet_token") or str(url).startswith("PASTE"):
        return "no sheet configured"
    data = json.dumps({"token": cfg["sheet_token"], **body}).encode("utf-8")
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "text/plain;charset=utf-8"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")[:200]
        except Exception as e:
            last = e
            time.sleep(10)
    return f"failed: {last}"


def push_to_sheet(cfg, res, ledger):
    """The ledger in a Google Sheet is an independent, time-stamped copy (Sheets keeps its own version history)."""
    r1 = post_sheet(cfg, {"action": "replace", "sheet": "VerificationLedger", "header": LEDGER_FIELDS,
                          "rows": [[row.get(k, "") for k in LEDGER_FIELDS] for row in ledger[-2000:]]})
    head = ["forecast", "days", "samples", "mae", "unit", "nmae_or_pct", "bias", "skill_pct", "reference", "inside_range_pct", "generated_utc"]
    rows = []
    for p in res["products"]:
        o = p["overall"]
        if not o.get("n"):
            continue
        ref, r = next(iter(o.get("refs", {}).items()), ("", {}))
        rows.append([p["label"], o["days"], o["n"], o["mae"], p["unit"], o.get("nmae_pct", o.get("mae_pct_of_actual")) or "",
                     o["bias"], r.get("skill_pct", "") if r.get("skill_pct") is not None else "", ref, o.get("coverage_pct", ""), res["generated_utc"]])
    r2 = post_sheet(cfg, {"action": "replace", "sheet": "Verification", "header": head, "rows": rows})
    ok = sum('"ok":true' in x.replace(" ", "") for x in (r1, r2))
    return f"sheet {ok}/2" + ("" if ok == 2 else f" ({r1[:60]} | {r2[:60]})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--live", help="(testing) live folder to use instead of the one in the config")
    ap.add_argument("--now", help="(testing) run as if it were this UTC time, e.g. 2026-11-18T19:00")
    ap.add_argument("--no-send", action="store_true", help="do not write to the Google Sheet")
    ap.add_argument("--print", action="store_true", help="print the headline table")
    a = ap.parse_args()
    cfg = load_config(a.config) if os.path.exists(a.config) else {}
    live = os.path.abspath(a.live) if a.live else cfg.get("live_dir")
    if not live:
        raise SystemExit("no live folder: give --config or --live")
    now = (datetime.strptime(a.now, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc) if a.now
           else datetime.now(timezone.utc)).replace(second=0, microsecond=0)
    res, ledger = build(live, now)
    tmp = os.path.join(live, "verification.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(res, fh, separators=(",", ":"))
    os.replace(tmp, os.path.join(live, "verification.json"))
    write_days_csv(live, res)
    for month in res["reports"]:
        write_report(live, res, month)
    sheet = "not sent (--no-send)" if a.no_send or not cfg else push_to_sheet(cfg, res, ledger)
    msg = (f"{now:%Y-%m-%d %H:%M} UTC  integrity {res['integrity']['status']} ({res['integrity']['sealed_days']} days sealed)  "
           + "  ".join(f"{p['key']} {p['overall'].get('mae', '—')}" for p in res["products"] if p["overall"].get("n")) + f"  {sheet}")
    with open(os.path.join(live, "verify_runs.txt"), "a", encoding="utf-8") as fh:
        fh.write(msg + "\n")
    if a.print:
        print(md_table(["Forecast", "Days", "Samples", "MAE", "MAE relative", "Bias", "Skill", "Inside range", "Status"], headline_rows(res)))
        for x in res["integrity"]["issues"]:
            print("INTEGRITY:", x)
    print(msg)


if __name__ == "__main__":
    main()
