"""Telegram bot for the Mount Coffee AI assistant (operators ask from their phones).

  - Only chats listed in config.json "telegram_chats" get answers; anyone else is told their chat id so the
    SCADA/EMS team can add it:  python live\\set_telegram.py --allow <chat id>
  - /status  live numbers (no AI, free)      /id  your chat id      anything else: question to the AI assistant
  - Read-only: the assistant can only read plant data.

Task "MCSolar Telegram" starts it every 5 minutes; each run listens for about 290 seconds (long polling, so no
public web address or open port is needed on the forecast PC). Bot token: Windows Credential Manager
(service "mcsolar-telegram"), set with set_telegram.py.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from alerts import load_config  # noqa: E402

KEYRING_SERVICE = "mcsolar-telegram"


def token():
    import keyring
    return keyring.get_password(KEYRING_SERVICE, "bot")


def tg(tok, method, params=None, timeout=35):
    data = urllib.parse.urlencode(params or {}).encode("utf-8")
    api = os.environ.get("TELEGRAM_API", "https://api.telegram.org")
    with urllib.request.urlopen(f"{api}/bot{tok}/{method}", data=data, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_json(url, body=None, timeout=200):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def status_text(base):
    n = http_json(base + "/api/now", timeout=20)
    live = http_json(base + "/api/live", timeout=30)
    w, f = n.get("latest") or {}, live.get("latestForecast") or {}
    lines = [f"Mount Coffee solar  {datetime.now(timezone.utc):%H:%M} GMT"]
    if w:
        st = "  ".join(f"STS{i} {w.get(f'sts{i}_kw', 0) / 1000:.2f}" for i in (1, 2, 3, 4) if w.get(f"sts{i}_kw") is not None)
        lines += [f"Actual: {w.get('pv_sum_mw', 0):.2f} MW (read {n.get('ageS')} s ago)", st,
                  f"Irradiance: zone A {w.get('zoneA_ghi_wm2')} / zone 4 {w.get('zone4_ghi_wm2')} W/m2"]
    if f:
        lines.append(f"Forecast ({f.get('issued', '')[11:16]}): +15 {f.get('p15')}  +30 {f.get('p30')}  +60 {f.get('p60')} MW")
    days = ((live.get("nwp") or {}).get("forecast") or {}).get("days") or []
    if days:
        d = days[0]
        lines.append(f"Today (weather models): {d.get('newMwh')} MWh (range {d.get('lowMwh')}-{d.get('highMwh')})")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--seconds", type=int, default=290)
    a = ap.parse_args()
    cfg = load_config(a.config)
    tok = token()
    if not tok:
        print("No Telegram bot token saved. Run: python live\\set_telegram.py")
        return
    base = cfg.get("agent_url", "http://127.0.0.1:3000").rstrip("/")
    allowed = {int(c) for c in cfg.get("telegram_chats", [])}
    state_path = os.path.join(cfg["live_dir"], "telegram_state.json")
    try:
        state = json.load(open(state_path, encoding="utf-8"))
    except Exception:
        state = {"offset": 0, "history": {}}
    end = time.monotonic() + a.seconds
    while time.monotonic() < end - 5:
        try:
            upd = tg(tok, "getUpdates", {"offset": state["offset"], "timeout": min(25, int(end - time.monotonic()) - 3)}, timeout=40)
        except Exception as e:
            print("getUpdates failed:", e)
            time.sleep(10)
            continue
        for u in upd.get("result", []):
            state["offset"] = u["update_id"] + 1
            m = u.get("message") or u.get("edited_message")
            if not m or "text" not in m:
                continue
            chat, text = m["chat"]["id"], m["text"].strip()
            if text.startswith("/id") or (text.startswith("/start") and chat not in allowed):
                reply = (f"Your chat id is {chat}." + ("" if chat in allowed else
                         " This chat is not yet allowed. Ask the LEC SCADA/EMS team to run: python live\\set_telegram.py --allow " + str(chat)))
            elif chat not in allowed:
                reply = f"Not authorised. Your chat id is {chat}; ask the LEC SCADA/EMS team to add it."
            elif text.startswith("/start") or text.startswith("/help"):
                reply = ("Mount Coffee solar assistant (read-only).\n/status  live output and forecast\n"
                         "Or just ask, e.g. 'How much will we produce this afternoon?' or 'Why did output drop at 11:00?'")
            elif text.startswith("/status"):
                try:
                    reply = status_text(base)
                except Exception as e:
                    reply = f"Could not read the dashboard on the forecast PC: {e}"
            else:
                hist = state["history"].get(str(chat), [])[-6:] + [{"role": "user", "content": text}]
                try:
                    tg(tok, "sendChatAction", {"chat_id": chat, "action": "typing"})
                    j = http_json(base + "/api/agent", {"messages": hist})
                    reply = j.get("answer") or j.get("error") or "No answer."
                    if j.get("answer"):
                        state["history"][str(chat)] = (hist + [{"role": "assistant", "content": reply}])[-8:]
                except Exception as e:
                    reply = f"The assistant is not reachable right now: {e}"
            for i in range(0, len(reply), 4000):
                try:
                    tg(tok, "sendMessage", {"chat_id": chat, "text": reply[i:i + 4000]})
                except Exception as e:
                    print("sendMessage failed:", e)
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)


if __name__ == "__main__":
    main()
