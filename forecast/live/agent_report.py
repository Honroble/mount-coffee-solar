"""Shift report written by the AI agent, e-mailed to the operators (ALERT_TO list in the Apps Script).

  python live\\agent_report.py --period morning   # 07:00 GMT: yesterday's production + today's outlook
  python live\\agent_report.py --period evening   # 19:05 GMT: today's review
  python live\\agent_report.py --period weekly    # Monday morning: last 7 days, losses, trips, open contractor issues
  add --dry-run to print the report without sending it

The report is written by the dashboard's /api/agent (Claude with read-only plant-data tools), so the dashboard
must be running on this PC and dashboard\\.env.local must hold the API key (setup_agent.ps1).
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from alerts import load_config, post  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--period", choices=["morning", "evening", "weekly"], default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg = load_config(a.config)
    now = datetime.now(timezone.utc)
    period = a.period or ("morning" if now.hour < 12 else "evening")
    url = cfg.get("agent_url", "http://127.0.0.1:3000").rstrip("/") + "/api/agent"
    req = urllib.request.Request(url, data=json.dumps({"mode": "weekly"} if period == "weekly" else {"mode": "report", "period": period}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    log = os.path.join(cfg["live_dir"], "alerts_log.txt")
    try:
        with urllib.request.urlopen(req, timeout=400 if period == "weekly" else 240) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        j = {"error": str(e)}
    if not j.get("answer"):
        msg = f"{now:%Y-%m-%d %H:%M} agent_report: no report ({j.get('error', 'no answer')})"
        print(msg)
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(msg + "\n")
        return
    title = {"morning": "morning report", "evening": "evening report", "weekly": "weekly plant review"}[period]
    text = j["answer"].strip() + ("\n\n(Automatic report from the plant data.)" if j.get("free")
                                  else "\n\n(Written by the AI assistant from the plant data - read-only. Check before acting.)")
    if a.dry_run:
        print(text)
        return
    res = post(cfg, {"action": "notify", "kind": "report", "subject": f"Mount Coffee solar: {title} {now:%Y-%m-%d}", "text": text})
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(f"{now:%Y-%m-%d %H:%M} report ({period}) sent [{res[:60]}]\n")
    # remember a delivered report, so alerts.py can resend one that failed (e.g. no internet right after the PC wakes)
    if '"ok":true' in res.replace(" ", ""):
        sp = os.path.join(cfg["live_dir"], "reports_sent.json")
        try:
            sent = json.load(open(sp, encoding="utf-8"))
        except Exception:
            sent = {}
        sent[f"{now:%Y-%m-%d}_{period}"] = now.strftime("%H:%M")
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump(dict(sorted(sent.items())[-60:]), fh)
    print(res)


if __name__ == "__main__":
    main()
