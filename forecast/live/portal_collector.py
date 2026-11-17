"""Collect live Mount Coffee data through the Gantner web portal (no API key needed).

Signs in to the Gantner RAS portal and to the Q.reader logger with the accounts LEC already has,
then asks the logger's own "Download specific period" function for ONLY the 70 channels in
channel_map.csv over the last 20 minutes (about 1-3 KB per request). New rows are appended to
daily files in the logger's CSV layout, which live_forecast.py reads:
    <live_dir>/iv2_live_YYYYMMDD.csv  and  <live_dir>/iv1_live_YYYYMMDD.csv

Read-only: it only signs in and downloads. It never changes a logger setting.
Passwords are NOT stored in any file: they live in Windows Credential Manager
(run  python live/set_credentials.py  once). Session cookies are kept in
%LOCALAPPDATA%\\MCSolar so it signs in again only when a session expires.

Run every minute (install_live_tasks.ps1 sets this up):
    python live/portal_collector.py --config live/config.json
    python live/portal_collector.py --config live/config.json --test     # sign in + one small read, saves nothing
"""
import argparse
import csv
import io
import json
import os
import pickle
import sys
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import keyring
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
PORTAL = "https://ras.gantner-webportal.com"
SERVICE_PORTAL = "MCSolar Gantner portal"
SERVICE_LOGGER = "MCSolar Q.reader logger"
STATE = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MCSolar")


class Forms(HTMLParser):
    """Collect <form> elements with their inputs (enough for simple server-rendered login forms)."""

    def __init__(self):
        super().__init__()
        self.forms, self._cur = [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action"), "method": (a.get("method") or "get").lower(), "inputs": []}
            self.forms.append(self._cur)
        elif tag == "input" and self._cur is not None:
            self._cur["inputs"].append({"name": a.get("name"), "type": (a.get("type") or "text").lower(),
                                        "value": a.get("value", "")})

    def handle_endtag(self, tag):
        if tag == "form":
            self._cur = None


def forms_of(html):
    p = Forms()
    p.feed(html)
    return p.forms


def load_config(path):
    with open(path, encoding="utf-8-sig") as fh:
        cfg = json.load(fh)
    root = os.path.dirname(os.path.abspath(path))
    cfg["live_dir"] = os.path.abspath(os.path.join(root, cfg.get("live_dir", "../../data/live")))
    cfg.setdefault("device_id", "00:12:08:be:32:d9")
    cfg.setdefault("logger_user", "admin")
    return cfg


def load_map(path=os.path.join(HERE, "channel_map.csv")):
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


class Portal:
    def __init__(self, cfg):
        self.cfg = cfg
        self.base = f"{PORTAL}/proxy/{cfg['device_id']}/cgi-bin"
        self.s = requests.Session()
        self.s.headers["User-Agent"] = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 MCSolar-collector")
        os.makedirs(STATE, exist_ok=True)
        self.jar = os.path.join(STATE, "portal_cookies.pkl")
        if os.path.exists(self.jar):
            try:
                with open(self.jar, "rb") as fh:
                    self.s.cookies.update(pickle.load(fh))
            except Exception:
                pass

    def save(self):
        with open(self.jar, "wb") as fh:
            pickle.dump(self.s.cookies, fh)

    def _password(self, service, user):
        pw = keyring.get_password(service, user)
        if not pw:
            raise RuntimeError(f"No password saved for {user} ({service}). Run: python live/set_credentials.py")
        return pw

    @staticmethod
    def _submit(session, page_url, html, user, password, extra=None):
        form = next((f for f in forms_of(html) if any(i["type"] == "password" for i in f["inputs"])), None)
        if form is None:
            raise RuntimeError(f"No sign-in form found at {page_url}")
        data = {}
        for i in form["inputs"]:
            if not i["name"]:
                continue
            if i["type"] == "password":
                data[i["name"]] = password
            elif i["type"] in ("text", "email"):
                data[i["name"]] = user
            elif i["type"] == "checkbox":
                data[i["name"]] = i["value"] or "on"   # the portal's privacy box sends value "privacy"
            elif i["type"] == "hidden":
                data[i["name"]] = i["value"]
        data.update(extra or {})
        action = requests.compat.urljoin(page_url, form["action"] or page_url)
        origin = "/".join(page_url.split("/")[:3])
        return session.post(action, data=data, timeout=60, headers={"Referer": page_url, "Origin": origin})

    def login_portal(self):
        r = self.s.get(f"{PORTAL}/login", timeout=60)
        if "/login" not in r.url:          # already signed in (redirected to /devices)
            return
        user = self.cfg["portal_user"].strip()
        resp = self._submit(self.s, r.url, r.text, user, self._password(SERVICE_PORTAL, user))
        check = self.s.get(f"{PORTAL}/devices", timeout=60)
        if "/login" in check.url or "Logged in as" not in check.text:
            hint = ""
            for key in ("alert", "error", "invalid", "wrong"):
                k = resp.text.lower().find(key)
                if k >= 0:
                    import re
                    hint = re.sub(r"<[^>]+>|\s+", " ", resp.text[k:k + 300]).strip()[:160]
                    break
            raise RuntimeError(f"Portal sign-in failed (HTTP {resp.status_code}, ended at {resp.url}) {hint}".strip()
                               + " - check the portal user name and password (run: python live\\set_credentials.py)")

    def login_logger(self):
        r = self.s.get(f"{self.base}/start", timeout=60)
        if r.status_code in (401, 403) or "/proxy/" not in r.url:   # sent back to the portal sign-in page
            raise PermissionError("portal session missing")
        if any((f["action"] or "").endswith("logout") for f in forms_of(r.text)) and \
                not any(i["type"] == "password" for f in forms_of(r.text) for i in f["inputs"]):
            return                          # already signed in to the logger
        if not any(i["type"] == "password" for f in forms_of(r.text) for i in f["inputs"]):
            return                          # the logger page opened without asking for a sign-in
        user = self.cfg["logger_user"]
        self._submit(self.s, r.url, r.text, user, self._password(SERVICE_LOGGER, user))

    def ensure(self):
        self.login_portal()                 # returns at once if the portal session is still valid
        try:
            self.login_logger()
        except PermissionError:
            self.login_portal()
            self.login_logger()

    def download(self, iv, channels, beg, end):
        body = {"iv": iv, "chs": json.dumps(channels), "beg": beg.strftime("%Y%m%d_%H%M%S"),
                "end": end.strftime("%Y%m%d_%H%M%S")}
        for attempt in range(2):
            # The logger rejects (HTTP 400) a download without a Referer from its own Datafiles page
            r = self.s.post(f"{self.base}/download_csv", data=body, timeout=180,
                            headers={"Referer": f"{self.base}/download", "Origin": PORTAL})
            if r.status_code == 200 and "csv" in r.headers.get("content-type", ""):
                return r.content.decode("latin-1")
            if attempt == 0:                # session expired or not signed in: sign in again once
                self.ensure()
        import re
        page = re.sub(r"<script.*?</script>|<style.*?</style>", " ", r.text, flags=re.S)
        page = re.sub(r"<[^>]+>|\s+", " ", page).strip()[:300]
        raise RuntimeError(f"download_csv failed: HTTP {r.status_code} {r.headers.get('content-type')} at {r.url} | {page}")


WIDGET_FIELDS = ["time_utc", "disk_used_pct", "disk_free_mb", "channels", "channel_errors",
                 "zoneA_tamb_c", "zoneA_tmod_c", "zoneA_ghi_wm2", "zone4_tamb_c", "zone4_tmod_c", "zone4_ghi_wm2",
                 "sts1_kw", "sts2_kw", "sts3_kw", "sts4_kw", "pv_sum_mw", "power_limit_user_pct", "power_setpoint_mw"]


def read_widgets(p, cfg):
    """Live values of the logger homepage (widget_update.json): disk, channel errors, zone sensors, station power, limits."""
    r = p.s.post(f"{p.base}/widget_update.json", data={"config_id": cfg.get("widget_config_id", "1792744806"), "page": "-1"},
                 timeout=60, headers={"Referer": f"{p.base}/start", "Origin": PORTAL})
    r.raise_for_status()
    j = r.json()
    v = lambda i: (float(j[i]["v"]) if isinstance(j[i], dict) and j[i].get("v") not in (None, "") else None)
    info = j[0] if j and isinstance(j[0], dict) else {}
    lim = j[14] if len(j) > 14 and isinstance(j[14], list) else [{}, {}]
    num = lambda d: float(d["v"]) if isinstance(d, dict) and d.get("v") not in (None, "") else None
    return {
        "time_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "disk_used_pct": round(100 * info.get("disk", {}).get("ratio", 0), 2) if info.get("disk") else None,
        "disk_free_mb": info.get("disk", {}).get("free"),
        "channels": info.get("channels", {}).get("count"), "channel_errors": info.get("channels", {}).get("errors"),
        "zoneA_tamb_c": v(2), "zoneA_tmod_c": v(3), "zoneA_ghi_wm2": v(4),
        "zone4_tamb_c": v(6), "zone4_tmod_c": v(7), "zone4_ghi_wm2": v(8),
        "sts1_kw": v(9), "sts2_kw": v(10), "sts3_kw": v(11), "sts4_kw": v(12), "pv_sum_mw": v(13),
        "power_limit_user_pct": num(lim[0]) if lim else None, "power_setpoint_mw": num(lim[1]) if len(lim) > 1 else None,
    }


def save_widgets(live_dir, w):
    with open(os.path.join(live_dir, "widget_latest.json"), "w", encoding="utf-8") as fh:
        json.dump(w, fh)
    path = os.path.join(live_dir, "widget_log.csv")
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        if new:
            wr.writerow(WIDGET_FIELDS)
        wr.writerow([w.get(k, "") if w.get(k) is not None else "" for k in WIDGET_FIELDS])


def parse_csv(text):
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=";") if r]
    if not rows:
        return [], []
    header, body = rows[0], rows[1:]
    if body and body[0] and body[0][0].startswith("["):   # units row
        body = body[1:]
    return header, body


def last_stamp(path):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 20000))
        tail = fh.read().decode("latin-1").strip().splitlines()
    for line in reversed(tail):
        parts = line.split(";")
        try:
            return datetime.strptime(parts[0] + " " + parts[1], "%d.%m.%Y %H:%M:%S")
        except Exception:
            continue
    return None


def file_channels(path):
    try:
        with open(path, encoding="latin-1", newline="") as fh:
            head = next(csv.reader(fh, delimiter=";"))
        return head[3:]
    except Exception:
        return None


def append(live_dir, group, chmap_rows, header, body):
    channels = [m["local_channel"] for m in chmap_rows]
    units = [m["unit"] for m in chmap_rows]
    idx = {name: i for i, name in enumerate(header)}
    os.makedirs(live_dir, exist_ok=True)
    written = 0
    for r in body:
        try:
            ts = datetime.strptime(r[0] + " " + r[1], "%d.%m.%Y %H:%M:%S")
        except Exception:
            continue
        vals = [(r[idx[c]] if c in idx and idx[c] < len(r) else "") for c in channels]
        if not any(v.strip() for v in vals):   # minute not stored yet
            continue
        path = os.path.join(live_dir, f"{group}_live_{ts:%Y%m%d}.csv")
        last = last_stamp(path)
        if last and ts <= last:
            continue
        new = not os.path.exists(path)
        if not new:   # a channel added to channel_map during the day starts in tomorrow's file: keep today's columns
            have = file_channels(path)
            if have and have != channels:
                vals = [(r[idx[c]] if c in idx and idx[c] < len(r) else "") for c in have]
        with open(path, "a", newline="", encoding="latin-1", errors="replace") as fh:
            w = csv.writer(fh, delimiter=";")
            if new:
                w.writerow(["Date", "Time", "Timezone"] + channels)
                w.writerow(["[dd.mm.YYYY]", "[HH:MM:SS]", "[+/-HHMM]"] + [f"[{u}]" for u in units])
            w.writerow([r[0], r[1], "+0000"] + vals)
        written += 1
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--test", action="store_true", help="sign in and read 15 minutes of 3 channels; save nothing")
    ap.add_argument("--minutes", type=int, default=20, help="how far back each run asks for (overlap is skipped)")
    a = ap.parse_args()
    cfg = load_config(a.config)
    chmap = load_map()
    now = datetime.now(timezone.utc).replace(tzinfo=None, second=0, microsecond=0)
    beg = now - timedelta(minutes=a.minutes)
    # after a gap (PC asleep or offline) ask for everything since the last saved minute, up to 12 hours back
    last_saved = last_stamp(os.path.join(cfg["live_dir"], f"iv2_live_{now:%Y%m%d}.csv")) or \
        last_stamp(os.path.join(cfg["live_dir"], f"iv2_live_{(now - timedelta(days=1)):%Y%m%d}.csv"))
    if last_saved and last_saved < beg:
        beg = max(last_saved, now - timedelta(hours=12))
    log_lines, status = [], 0
    try:
        p = Portal(cfg)
        p.ensure()
        if a.test:
            text = p.download("iv2", ["Information.Inverter sum P", "Active Power.Frequency",
                                      "STS1.INV01.active_power_total"], now - timedelta(minutes=15), now)
            header, body = parse_csv(text)
            print("Signed in OK. Columns:", header)
            for r in body[-5:]:
                print("  ", r)
            p.save()
            return
        os.makedirs(cfg["live_dir"], exist_ok=True)
        for group in ("iv2", "iv1"):
            rows = [m for m in chmap if m["group"] == group]
            header, body = parse_csv(p.download(group, [m["local_channel"] for m in rows], beg, now))
            missing = [m["local_channel"] for m in rows if m["local_channel"] not in header]
            n = append(cfg["live_dir"], group, rows, header, body)
            log_lines.append(f"{group}: +{n} rows" + (f", {len(missing)} channels missing" if missing else ""))
        try:
            w = read_widgets(p, cfg)
            save_widgets(cfg["live_dir"], w)
            log_lines.append(f"status: disk {w['disk_used_pct']} % used, {w['channel_errors']} channel errors, limit {w['power_limit_user_pct']} %")
        except Exception as e:   # the homepage values are extra: never stop the collector for them
            log_lines.append(f"status read failed: {e}")
        p.save()
    except Exception as e:
        log_lines.append(f"ERROR {e}")
        status = 1
    msg = f"{now:%Y-%m-%d %H:%M} UTC  " + "; ".join(log_lines)
    if not a.test:
        os.makedirs(cfg["live_dir"], exist_ok=True)
        with open(os.path.join(cfg["live_dir"], "collector_log.txt"), "a", encoding="utf-8") as fh:
            fh.write(msg + "\n")
    print(msg)
    sys.exit(status)


if __name__ == "__main__":
    main()
