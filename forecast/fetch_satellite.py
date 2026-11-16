"""Download satellite irradiance for Mount Coffee and 16 surrounding points from Open-Meteo.

Usage:
    python fetch_satellite.py --start 2026-09-17 --end 2026-11-14 --out satellite.csv
    python fetch_satellite.py --past-days 1 --out satellite_recent.csv     # for live forecasting

Writes the same CSV layout that train.py / forecast.py read with --sat.
Open-Meteo is free for non-commercial use; check its licence page for LEC's use.
"""
import argparse
import csv
import json
import math
import urllib.request

LAT0, LON0 = 6.505, -10.648
DIRS = [(0, "N"), (45, "NE"), (90, "E"), (135, "SE"), (180, "S"), (225, "SW"), (270, "W"), (315, "NW")]


def points():
    pts = [(LAT0, LON0, "C")]
    for r, tag in ((0.2, "r20"), (0.45, "r50")):
        for b, d in DIRS:
            a = math.radians(b)
            pts.append((round(LAT0 + r * math.cos(a), 3), round(LON0 + r * math.sin(a), 3), tag + d))
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--past-days", type=int)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pts = points()
    url = ("https://satellite-api.open-meteo.com/v1/archive?"
           f"latitude={','.join(str(p[0]) for p in pts)}&longitude={','.join(str(p[1]) for p in pts)}"
           "&hourly=shortwave_radiation&models=satellite_radiation_seamless&temporal_resolution=native")
    url += f"&past_days={a.past_days}" if a.past_days else f"&start_date={a.start}&end_date={a.end}"
    with urllib.request.urlopen(url, timeout=120) as r:
        js = json.load(r)
    times = js[0]["hourly"]["time"]
    with open(a.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time_utc"] + [f"{p[2]}_{p[0]}_{p[1]}" for p in pts])
        for i, t in enumerate(times):
            w.writerow([t] + ["" if x["hourly"]["shortwave_radiation"][i] is None else x["hourly"]["shortwave_radiation"][i] for x in js])
    print(f"wrote {len(times)} rows x {len(pts)} points to {a.out}")


if __name__ == "__main__":
    main()
