"""Hämtar publik spelstatistik för gängets konton till council/data/.

Läser Steam-id och HoN-namn ur council/gänget.md. Bara publik data, inga nycklar.
- Steam: https://steamcommunity.com/profiles/<id>/?xml=1 och /games?tab=all&xml=1
  (namn, CS2-timmar totalt och senaste 2 veckorna, om profilen är publik)
- HoN Reborn: WardUp (ward-up.com). Sparar startsidan och provar spelarsidor så att
  Quizresearchern kan se vilket URL-mönster/API som fungerar.
"""
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
OUT = Path("council/data")
RAW = OUT / "raw"
CS2_APPID = "730"


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
        status, body = get(f"https://steamcommunity.com/profiles/{sid}/games?tab=all&xml=1")
        p["gamesStatus"] = status
        if status == 200 and body.lstrip().startswith("<?xml"):
            try:
                root = ET.fromstring(body)
                games = root.findall("games/game")
                p["gameCount"] = len(games)
                for g in games:
                    if text(g, "appID") == CS2_APPID:
                        p["cs2HoursTotal"] = num(text(g, "hoursOnRecord"))
                        p["cs2Hours2Wk"] = num(text(g, "hoursLast2Weeks"))
                top = sorted(games, key=lambda g: num(text(g, "hoursOnRecord")) or 0, reverse=True)[:5]
                p["topGames"] = [{"name": text(g, "name"), "hoursTotal": num(text(g, "hoursOnRecord"))}
                                 for g in top]
            except ET.ParseError as e:
                p["error"] = f"spel-xml: {e}"
        time.sleep(2)
        players.append(p)
    return players


def wardup(names):
    RAW.mkdir(parents=True, exist_ok=True)
    result = {"home": None, "tries": []}
    status, body = get("https://ward-up.com/")
    result["home"] = status
    if body:
        (RAW / "wardup-home.html").write_text(body[:400_000])
        # Skript- och API-adresser i sidan, för att hitta ett JSON-API nästa gång
        result["scripts"] = sorted(set(re.findall(r'src="([^"]+\.js)"', body)))[:30]
        result["apiHints"] = sorted(set(re.findall(r'["\'](/api/[^"\']+|https?://[^"\']*api[^"\']*)["\']', body)))[:30]
    for name in names:
        q = urllib.parse.quote(name)
        for pattern in ("https://ward-up.com/player/{}", "https://ward-up.com/players/{}",
                        "https://ward-up.com/api/players/{}", "https://ward-up.com/search?q={}"):
            url = pattern.format(q)
            status, body = get(url)
            entry = {"name": name, "url": url, "status": status, "bytes": len(body)}
            if status == 200 and body:
                fn = RAW / ("wardup-" + re.sub(r"[^a-z0-9]+", "-", url.split("ward-up.com/")[1].lower()) + ".html")
                fn.write_text(body[:400_000])
                entry["saved"] = str(fn)
            result["tries"].append(entry)
            time.sleep(1)
    return result


def main():
    g = Path("council/gänget.md").read_text()
    ids = re.findall(r"\b7656119\d{10}\b", g)
    m = re.search(r"HoN Reborn-användarnamn:\*\*\s*(.+)", g)
    names = [n.strip() for n in m.group(1).split(",")] if m else []
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())
    (OUT / "steam.json").write_text(json.dumps({"fetchedAt": stamp, "players": steam(ids)},
                                               ensure_ascii=False, indent=2))
    (OUT / "hon-wardup.json").write_text(json.dumps({"fetchedAt": stamp, **wardup(names)},
                                                    ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
