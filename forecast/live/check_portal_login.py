"""Diagnose the Gantner portal sign-in. Prints what is sent, never the password itself.
Run from the forecast folder:  python live\\check_portal_login.py
"""
import json
import os
import sys

import keyring
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from portal_collector import PORTAL, SERVICE_PORTAL, forms_of  # noqa: E402

cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"), encoding="utf-8-sig"))
user = cfg.get("portal_user", "")
pw = keyring.get_password(SERVICE_PORTAL, user) or ""
print(f"user name in config : {user!r}")
print(f"saved password      : {len(pw)} characters"
      f"{', starts/ends with a space!' if pw != pw.strip() else ''}"
      f"{', has non-English characters' if any(ord(c) > 127 for c in pw) else ''}")
other = [c for c in ("MCSolar Gantner portal",) if keyring.get_password(c, user.strip()) and user != user.strip()]
if other:
    print("note: a password is also saved under the user name without spaces")

s = requests.Session()
try:
    r = s.get(f"{PORTAL}/login", timeout=60)
except Exception as e:
    print(f"could not reach the portal: {e}")
    print("-> a network problem on this PC (not the password). Try again in a minute.")
    sys.exit(1)
form = next((f for f in forms_of(r.text) if any(i["type"] == "password" for i in f["inputs"])), None)
if form is None:
    import re
    from portal_collector import load_config
    page = os.path.join(load_config(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))["live_dir"],
                        "portal_login_page.html")
    try:
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(r.text)
    except OSError:
        page = "(could not save)"
    title = re.search(r"<title>(.*?)</title>", r.text, re.S | re.I)
    print(f"the login page has no password box: HTTP {r.status_code}, ended at {r.url}, "
          f"title {title.group(1).strip()[:80] if title else '(none)'!r}, {len(r.text)} characters")
    print(f"page saved to {page} - the portal's sign-in page has changed or is showing a notice")
    sys.exit(2)
print("login form fields   :", [(i["name"], i["type"], i["value"] if i["type"] != "password" else "") for i in form["inputs"]])
print("cookies after GET   :", list(s.cookies.keys()))

for label, data in [
    ("with privacy box", {"username": user.strip(), "password": pw, "privacy": "privacy"}),
    ("privacy=on      ", {"username": user.strip(), "password": pw, "privacy": "on"}),
]:
    s2 = requests.Session()
    s2.get(f"{PORTAL}/login", timeout=60)
    p = s2.post(f"{PORTAL}/login", data=data, timeout=60, allow_redirects=False)
    ok = p.status_code in (301, 302, 303) and "/login" not in p.headers.get("Location", "/login")
    print(f"try {label}: HTTP {p.status_code} -> {p.headers.get('Location', '(no redirect)')}  {'SIGNED IN' if ok else 'rejected'}")
    if ok:
        break

# --- Optional: type the password VISIBLY, try it, and save it only if the portal accepts it
if "--try" in sys.argv:
    print()
    print("Type the portal password so you can see it (clear the screen afterwards with: cls).")
    typed = input("Portal password: ").rstrip("\r\n")
    print(f"you typed {len(typed)} characters")
    s3 = requests.Session()
    s3.get(f"{PORTAL}/login", timeout=60)
    p = s3.post(f"{PORTAL}/login", data={"username": user.strip(), "password": typed, "privacy": "privacy"},
                timeout=60, allow_redirects=False)
    ok = p.status_code in (301, 302, 303) and "/login" not in p.headers.get("Location", "/login")
    if ok:
        keyring.set_password(SERVICE_PORTAL, user, typed)
        print("SIGNED IN - this password is now saved in Windows Credential Manager.")
    else:
        print(f"rejected (HTTP {p.status_code}). Nothing saved.")
