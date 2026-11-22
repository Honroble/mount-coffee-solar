"""List the logger's channel names (read-only) and show the ones for grid metering.

  python live\\list_channels.py

Signs in like the collector, opens the logger's Datafiles page (read-only, nothing is changed) and writes
  data\\live\\logger_channels.txt        every channel name found, one per line
  data\\live\\logger_download_page.html  the raw page, in case the names need to be read another way
Then prints the channels whose names suggest reactive power, voltage, power factor, energy meters, import/export
or auxiliary consumption.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from portal_collector import Portal, load_config  # noqa: E402

KEYS = re.compile(r"reactive|react|\bvar\b|kvar|mvar|cos|phi|power.?factor|\bpf\b|voltage|\bu_?l|\bu\d|kv\b|\bv_|"
                  r"energy|kwh|mwh|import|export|meter|j07|22 ?kv|grid|aux|apparent|kva|\bq\b|_q_|\.q\.|current|\bi_?l",
                  re.I)


def main():
    cfg = load_config(os.path.join(HERE, "config.json"))
    live = cfg["live_dir"]
    p = Portal(cfg)
    p.ensure()
    r = p.s.get(f"{p.base}/download", timeout=60, headers={"Referer": f"{p.base}/start"})
    html = r.text
    with open(os.path.join(live, "logger_download_page.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    # channel names look like "STS1.INV01.active_power_total" or "FPE.PV.STS1.WS600.wind_speed_avg."
    cand = set(re.findall(r'["\'>]([A-Za-z][A-Za-z0-9_ \-]*(?:\.[A-Za-z0-9_ \-]*)+)["\'<]', html))
    names = sorted(c.strip() for c in cand if 3 < len(c) < 140 and not c.lower().startswith(("http", "www", "cgi")) and
                   not re.search(r"\.(js|css|png|jpg|gif|ico|html|json|csv)$", c, re.I))
    with open(os.path.join(live, "logger_channels.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(names) + "\n")
    hits = [n for n in names if KEYS.search(n)]
    print(f"HTTP {r.status_code}, page {len(html)} bytes, {len(names)} channel-like names saved to logger_channels.txt")
    print(f"{len(hits)} look like grid metering / reactive power / voltage / energy:")
    for n in hits[:200]:
        print("  ", n)
    p.save()


if __name__ == "__main__":
    main()
