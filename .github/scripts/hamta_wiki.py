"""Hämtar wikisidor (publika) för HoN-trivia till council/data/wiki/.

Rader i council/data/wiki/sidor.txt: "wikiwiki:<Sida>" (wikiwiki.jp/hon, följer HoN Reborn)
eller "fandom:<Sida>" (hon.fandom.com via MediaWiki-API:t, wikitext).
"""
import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
OUT = Path("council/data/wiki")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,ja"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)
    finally:
        time.sleep(2)


def to_text(page):
    """Grov HTML -> text som behåller tabellrader (celler separeras med ' | ')."""
    m = re.search(r'<div id="content".*', page, re.S) or re.search(r"<body.*", page, re.S)
    s = m.group(0) if m else page
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", s, flags=re.S)
    s = re.sub(r"</t[dh]>", " | ", s)
    s = re.sub(r"<(br|/tr|/p|/div|/li|/h\d)[^>]*>", "\n", s)
    s = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>', r"[\1] ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def main():
    lines = [l.strip() for l in (OUT / "sidor.txt").read_text().splitlines()]
    log = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        site, _, page = line.partition(":")
        slug = re.sub(r"[^A-Za-z0-9]+", "-", page).strip("-") or "sida"
        if site == "wikiwiki":
            url = "https://wikiwiki.jp/hon/" + urllib.parse.quote(page)
            st, body = get(url)
            text = to_text(body) if st == 200 else body[:500]
            fn = OUT / f"wikiwiki-{slug}.txt"
        elif site == "fandom":
            url = ("https://hon.fandom.com/api.php?action=parse&prop=wikitext&format=json&page="
                   + urllib.parse.quote(page))
            st, body = get(url)
            try:
                text = json.loads(body)["parse"]["wikitext"]["*"]
            except Exception:
                text = body[:500]
            fn = OUT / f"fandom-{slug}.txt"
        else:
            continue
        fn.write_text(f"Källa: {url}\nHämtad: {time.strftime('%Y-%m-%d')}\n\n{text[:300_000]}\n")
        log[line] = {"status": st, "file": fn.name, "chars": len(text)}
        print(line, st, len(text))
    (OUT / "logg.json").write_text(json.dumps(log, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
