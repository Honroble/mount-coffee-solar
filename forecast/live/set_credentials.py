"""Save the Gantner portal and logger passwords in Windows Credential Manager (run once, and after a password change).

    python live/set_credentials.py

Nothing is written to any file in this folder. To view or delete them later:
Control Panel > Credential Manager > Windows Credentials > "MCSolar Gantner portal" / "MCSolar Q.reader logger".
"""
import getpass
import json
import os

import keyring

HERE = os.path.dirname(os.path.abspath(__file__))
cfg_path = os.path.join(HERE, "config.json")
cfg = json.load(open(cfg_path, encoding="utf-8-sig")) if os.path.exists(cfg_path) else {}

portal_user = input(f"Gantner portal e-mail [{cfg.get('portal_user', '')}]: ").strip() or cfg.get("portal_user", "")
keyring.set_password("MCSolar Gantner portal", portal_user, getpass.getpass("Gantner portal password (hidden): "))
logger_user = input(f"Logger user name [{cfg.get('logger_user', 'admin')}]: ").strip() or cfg.get("logger_user", "admin")
keyring.set_password("MCSolar Q.reader logger", logger_user, getpass.getpass("Logger password (hidden): "))

cfg["portal_user"], cfg["logger_user"] = portal_user, logger_user
with open(cfg_path, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, indent=2)
print("Saved. User names are in live\\config.json; passwords are only in Windows Credential Manager.")
