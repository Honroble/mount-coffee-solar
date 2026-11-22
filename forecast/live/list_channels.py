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
    # the page loads its channel list with JavaScript: save the scripts so the request can be found
    root = p.base.rsplit("/cgi-bin", 1)[0]
    for js in ("download.js", "download_react.js"):
        try:
            jr = p.s.get(f"{root}/js/{js}", timeout=60, headers={"Referer": f"{p.base}/download"})
            with open(os.path.join(live, f"logger_{js}"), "w", encoding="utf-8") as fh:
                fh.write(jr.text)
            print(f"saved logger_{js} ({len(jr.text)} bytes, HTTP {jr.status_code})")
        except Exception as e:
            print(f"{js}: {e}")
    # the Datafiles page asks the logger for each interval's channel names: channel_names?iv=iv1|iv2|iv3
    import json as _json
    names, per = [], {}
    for iv in ("iv1", "iv2", "iv3", "iv4"):
        try:
            cr = p.s.get(f"{p.base}/channel_names?iv={iv}", timeout=60, headers={"Referer": f"{p.base}/download"})
            if cr.status_code >= 400:
                print(f"{iv}: HTTP {cr.status_code}")
                continue
            data = cr.json()
        except Exception as e:
            print(f"{iv}: {e}"[:200])
            continue
        with open(os.path.join(live, f"logger_channels_{iv}.json"), "w", encoding="utf-8") as fh:
            _json.dump(data, fh, indent=0)
        found = []
        def walk(x):
            if isinstance(x, dict):
                for k in ("n", "name", "Name"):
                    if isinstance(x.get(k), str):
                        found.append(x[k])
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    if isinstance(v, str):
                        found.append(v)
                    else:
                        walk(v)
        walk(data)
        per[iv] = found
        names += [f"{iv}\t{n}" for n in found]
        print(f"{iv}: {len(found)} channels")
    with open(os.path.join(live, "logger_channels.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(names) + "\n")
    hits = [n for n in names if KEYS.search(n.split("\t", 1)[1])]
    print(f"{len(names)} channel names saved to logger_channels.txt; {len(hits)} look like grid metering / reactive power / voltage / energy:")
    for n in hits[:150]:
        print("  ", n)
    if len(hits) > 150:
        print(f"   ... and {len(hits) - 150} more in logger_channels.txt")
    p.save()


if __name__ == "__main__":
    main()
