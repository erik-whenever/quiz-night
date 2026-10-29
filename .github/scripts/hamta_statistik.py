"""Hämtar publik Steam-profildata för gängets konton till council/data/steam.json.

Läser Steam-id ur council/gänget.md. Bara publik data, ingen nyckel:
https://steamcommunity.com/profiles/<id>/?xml=1 (namn, konto skapat, timmar senaste 2 veckorna).
Spellistan (CS2-timmar) kräver numera inloggning, så det kräver Steam Web API-nyckel.
HoN Reborn hämtas inte: WardUp har inget dokumenterat publikt API (se council/statistik.md).
"""
import json
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
OUT = Path("council/data")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # nätverksfel ska inte stoppa resten
        return 0, str(e)


def text(node, tag):
    el = node.find(tag)
    return el.text.strip() if el is not None and el.text else None


def num(s):
    try:
        return float(s.replace(",", "")) if s else None
    except ValueError:
        return None


def steam(ids):
    players = []
    for sid in ids:
        p = {"steamid": sid}
        status, body = get(f"https://steamcommunity.com/profiles/{sid}/?xml=1")
        p["profileStatus"] = status
        if status == 200 and body.lstrip().startswith("<?xml"):
            try:
                root = ET.fromstring(body)
                p["name"] = text(root, "steamID")
                p["privacy"] = text(root, "privacyState")
                p["memberSince"] = text(root, "memberSince")
                p["hoursPlayed2Wk"] = num(text(root, "hoursPlayed2Wk"))
                p["mostPlayed"] = [
                    {"name": text(g, "gameName"), "hours2wk": num(text(g, "hoursPlayed")),
                     "hoursTotal": num(text(g, "hoursOnRecord"))}
                    for g in root.findall("mostPlayedGames/mostPlayedGame")
                ]
            except ET.ParseError as e:
                p["error"] = f"profil-xml: {e}"
        time.sleep(2)
        players.append(p)
    return players


def main():
    g = Path("council/gänget.md").read_text()
    ids = re.findall(r"\b7656119\d{10}\b", g)
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())
    (OUT / "steam.json").write_text(json.dumps({"fetchedAt": stamp, "players": steam(ids)},
                                               ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
