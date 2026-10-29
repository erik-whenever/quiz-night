"""Hämtar HoN Reborn-matchhistorik för gängets fem spelarnamn från WardUp (ward-up.com).

WardUp har inget dokumenterat publikt API. Erik godkände 2026-10-29 att rådet hämtar
från det API som deras webbsida själv använder (ward-up.com/api). Håll trafiken låg:
bara gängets namn, en förfrågan i sekunden, och bara när arbetsflödet körs.
Resultat: council/data/hon/<namn>.json (profil + matcher med kills/deaths/assists/tid).
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
API = "https://ward-up.com/api"
OUT = Path("council/data/hon")
MAX_PAGES = 40          # tak per spelare
KEEP = ("game_id", "played_at", "date", "hero_name", "kda", "map", "is_ranked", "level", "hero", "hero_name", "hero_id", "kills", "deaths", "assists",
        "win", "won", "result", "duration", "mode", "game_mode", "gpm", "kda", "team")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json",
                                               "Referer": "https://ward-up.com/"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return 0, str(e)
    finally:
        time.sleep(1)
    try:
        return status, json.loads(body)
    except ValueError:
        return status, body[:300]


def find(d, keys, depth=0):
    if depth > 5 or d is None:
        return None
    if isinstance(d, dict):
        for k in keys:
            if d.get(k) not in (None, ""):
                return d[k]
        for v in d.values():
            r = find(v, keys, depth + 1)
            if r is not None:
                return r
    if isinstance(d, list) and d:
        return find(d[0], keys, depth + 1)
    return None


def match_list(d, depth=0):
    """Första listan med matcher (dicts med game_id) i svaret."""
    if depth > 4:
        return None
    if isinstance(d, list):
        if d and isinstance(d[0], dict) and "game_id" in d[0]:
            return d
        if not d:
            return d
    if isinstance(d, dict):
        for v in d.values():
            r = match_list(v, depth + 1)
            if r is not None:
                return r
    return None


def slim(m):
    out = {k: m[k] for k in KEEP if k in m}
    for k, v in m.items():  # ta med övriga enkla siffror, t.ex. last_hits
        if k not in out and isinstance(v, (int, float, bool)) and len(out) < 40:
            out[k] = v
    return out


def player(name):
    q = urllib.parse.quote(name)
    res = {"name": name}
    st, look = get(f"{API}/players/quick-lookup?q={q}")
    res["lookupStatus"] = st
    prof = look.get("profile") if isinstance(look, dict) else None
    if isinstance(prof, dict):
        res["profile"] = {k: v for k, v in prof.items()
                          if k not in ("match_history", "teammate_rival_game_ids")}
    acc = prof.get("id") if isinstance(prof, dict) else None
    res["accountId"] = acc
    matches, seen, offset = [], set(), 0

    def add(lst):
        n = 0
        for m in lst:
            if m.get("game_id") in seen:
                continue
            seen.add(m.get("game_id"))
            matches.append(slim(m))
            n += 1
        return n

    if isinstance(prof, dict):
        add(prof.get("match_history") or [])
    if acc:
        # Sidindelningen är odokumenterad: prova offset i antal matcher, annars sidnummer.
        res["pages"] = []
        mode = "count"
        page_no = 0
        for page in range(MAX_PAGES):
            st, data = get(f"{API}/players/match-history?account_id={acc}&offset={offset}")
            if page == 0:
                res["historyStatus"] = st
                if isinstance(data, dict):
                    res["historyKeys"] = list(data.keys())
                elif not isinstance(data, list):
                    res["historySample"] = data
            lst = match_list(data) if st == 200 else None
            more = data.get("has_more") if isinstance(data, dict) else None
            n = add(lst) if lst else 0
            res["pages"].append({"offset": offset, "status": st, "got": len(lst or []), "new": n, "has_more": more})
            if lst and n == 0 and mode == "count" and page > 0:
                mode = "page"  # offset verkar vara sidnummer
                page_no = 1
                offset = page_no
                continue
            if not lst or n == 0 or more is False:
                break
            if mode == "count":
                offset += len(lst)
            else:
                page_no += 1
                offset = page_no
    for m in matches:  # "kda": "3/1/5" -> kills/deaths/assists
        parts = str(m.get("kda", "")).split("/")
        if len(parts) == 3 and all(x.strip().isdigit() for x in parts):
            m["kills"], m["deaths"], m["assists"] = (int(x) for x in parts)
    res["matchCount"] = len(matches)
    res["matches"] = matches
    return res


def main():
    g = Path("council/gänget.md").read_text()
    m = re.search(r"HoN Reborn-användarnamn:\*\*\s*(.+)", g)
    names = [n.strip() for n in m.group(1).split(",")] if m else []
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())
    for name in names:
        p = player(name)
        p["fetchedAt"] = stamp
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower().replace("ö", "o").replace("ä", "a").replace("å", "a"))
        (OUT / f"{slug}.json").write_text(json.dumps(p, ensure_ascii=False, indent=1))
        print(name, p.get("lookupStatus"), p.get("accountId"), p.get("historyStatus"), p["matchCount"])


if __name__ == "__main__":
    main()
