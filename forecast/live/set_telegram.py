"""Set up the Telegram bot for the Mount Coffee assistant.

  python live\\set_telegram.py              save the bot token (hidden prompt) in Windows Credential Manager
  python live\\set_telegram.py --allow ID   let a Telegram chat (person or group) use the bot
  python live\\set_telegram.py --remove ID  take it away again
  python live\\set_telegram.py --list       show allowed chats

Create the bot first: in Telegram, message @BotFather, send /newbot, choose a name; it gives you the token.
"""
import argparse
import getpass
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, "config.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow", type=int)
    ap.add_argument("--remove", type=int)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    cfg = json.load(open(CFG, encoding="utf-8"))
    chats = [int(c) for c in cfg.get("telegram_chats", [])]
    if a.allow is not None or a.remove is not None or a.list:
        if a.allow is not None and a.allow not in chats:
            chats.append(a.allow)
        if a.remove is not None:
            chats = [c for c in chats if c != a.remove]
        cfg["telegram_chats"] = chats
        with open(CFG, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        print("Allowed Telegram chats:", chats or "none")
        return
    import keyring
    tok = getpass.getpass("Telegram bot token from @BotFather (hidden): ").strip()
    if not tok:
        sys.exit("Nothing entered.")
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/getMe", timeout=20) as r:
            me = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        sys.exit(f"Telegram did not accept that token ({e}). Nothing saved.")
    keyring.set_password("mcsolar-telegram", "bot", tok)
    print(f"Saved. Bot: @{me['result']['username']}. Now message the bot /start from each operator's phone;"
          " it replies with the chat id to add with --allow.")


if __name__ == "__main__":
    main()
