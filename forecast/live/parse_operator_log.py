"""Turn the control-room operators' log (SOLAR PV Operations_MTC_Control .xlsx, one tab per day) into hourly plant output.

  python live\\parse_operator_log.py data\\SOLAR_PV_Operations_MTC_Control.xlsx

Writes data\\operator_hourly.csv: hour_end_utc, mw, partial, two_station, curtailed, readings
  mw           mean output over the hour ending at hour_end_utc (trapezoid over the HH-1:00 .. HH:00 readings)
  partial      a station read 0 kW while the plant was producing (station off)
  two_station  the tab only has STS1/STS2 columns (April - early May): output is not the whole plant
  curtailed    the power-limit percentage was below 100 %
calibrate_nwp.py uses the unflagged hours from before the first logger export to train the hourly weather-model
correction. Against the logger (17 Sep - 17 Nov, 714 hours) these hourly values differ by about 1.0 MW on average.
Liberia is on GMT, so the log's clock times are UTC.
"""
import csv
import datetime as dt
import os
import re
import sys

MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[,%\s]", "", str(v))
    try:
        return float(s)
    except ValueError:
        return None


def minutes(v):
    if isinstance(v, dt.datetime):
        return v.hour * 60 + v.minute
    if isinstance(v, dt.time):
        return v.hour * 60 + v.minute
    if isinstance(v, (int, float)) and 0 <= v < 1:          # Excel time fraction
        return int(round(v * 1440))
    m = re.match(r"^\s*(\d{1,2}):(\d\d)", str(v or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def tab_date(name):
    m = re.match(r"^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})", name.strip())
    if not m or m.group(1)[:3].lower() not in MON:
        return None
    return dt.date(int(m.group(3)), MON[m.group(1)[:3].lower()], int(m.group(2)))


def columns(rows):
    """Combined header label per column from the rows above the first time row."""
    first = next((i for i, r in enumerate(rows) if r and minutes(r[0]) is not None and i > 0), None)
    if first is None:
        return None, None
    width = max(len(r) for r in rows[:first + 1])
    labels = [" ".join(str(rows[i][j]) for i in range(first) if j < len(rows[i]) and rows[i][j] not in (None, ""))
              for j in range(width)]
    labels = [re.sub(r"\s+", " ", x) for x in labels]

    def find(pat):
        return next((j for j, x in enumerate(labels) if re.search(pat, x, re.I)), -1)
    c = {f"s{k}": find(rf"STS ?{k} ?\(KW\)") for k in (1, 2, 3, 4)}
    c["tot"] = find(r"Total \(kW\)")
    c["pct"] = find(r"Percentage|Limit_User")
    return c, first


def parse_tab(ws_rows):
    c, first = columns(ws_rows)
    if not c or c["tot"] < 0 and c["s1"] < 0:
        return []
    four = c["s3"] >= 0 and c["s4"] >= 0
    out = []
    for r in ws_rows[first:]:
        if not r:
            continue
        m = minutes(r[0])
        if m is None:
            continue
        get = lambda j: num(r[j]) if 0 <= j < len(r) else None   # noqa: E731
        s = [get(c[f"s{k}"]) for k in (1, 2, 3, 4)]
        tot = get(c["tot"])
        if four and all(v is not None for v in s):
            tot = sum(s)
        if tot is None:
            continue
        pct = get(c["pct"])
        if pct is not None and pct <= 1.5:
            pct *= 100
        out.append({"m": m, "kw": tot, "s": s, "four": four, "pct": pct})
    return out


def hourly(date, rd):
    res = []
    for H in range(7, 20):
        w = sorted((x for x in rd if (H - 1) * 60 <= x["m"] <= H * 60), key=lambda x: x["m"])
        if len(w) < 2 or w[0]["m"] != (H - 1) * 60 or w[-1]["m"] != H * 60:
            continue
        area = sum((w[i]["kw"] + w[i - 1]["kw"]) / 2 * (w[i]["m"] - w[i - 1]["m"]) for i in range(1, len(w)))
        mw = area / 60 / 1000
        partial = any(x["four"] and x["kw"] > 800 and any(v is not None and v <= 1 for v in x["s"]) for x in w)
        curt = any(x["pct"] is not None and x["pct"] < 99.5 for x in w)
        res.append([f"{date:%Y-%m-%d} {H:02d}:00", round(mw, 3), int(partial), int(not w[0]["four"]), int(curt), len(w)])
    return res


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    try:
        import openpyxl
    except ImportError:
        print("needs openpyxl:  pip install openpyxl"); sys.exit(1)
    path = sys.argv[1]
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    today = dt.date.today()
    out = []
    for ws in wb.worksheets:
        d = tab_date(ws.title)
        if not d or d >= today:
            continue
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        out.extend(hourly(d, parse_tab(rows)))
    out.sort()
    dest = os.path.join(os.path.dirname(os.path.abspath(path)), "operator_hourly.csv")
    with open(dest, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["hour_end_utc", "mw", "partial", "two_station", "curtailed", "readings"])
        w.writerows(out)
    print(f"{len(out)} hours from {out[0][0][:10] if out else '-'} to {out[-1][0][:10] if out else '-'} -> {dest}")


if __name__ == "__main__":
    main()
