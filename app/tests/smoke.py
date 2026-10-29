"""
Röktest mot produktion efter publicering. Skapar ett rum, en spelare går med och svarar.
Sparar inget i säsongstabellen eller frågebanken.
    HOST_PIN=... python3 tests/smoke.py https://kronan.example.workers.dev
"""
import sys, os, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1].rstrip("/")
PIN = os.environ["HOST_PIN"]


def req(path, data=None, pin=True):
    r = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                               method="POST" if data is not None else "GET",
                               headers={"content-type": "application/json", "user-agent": "Mozilla/5.0 (Kronan smoke test)", **({"x-host-pin": PIN} if pin else {})})
    return json.loads(urllib.request.urlopen(r, timeout=20).read())


def main():
    assert "league" in req("/api/hub/public", pin=False), "hub/public svarar inte"
    room = req("/api/rooms", {"title": "Röktest", "questions": [{"id": "s1", "text": "Röktest?", "answer": "Ja", "choices": ["Ja", "Nej"]}],
                              "settings": {"collectSeconds": 10}})
    code = room["code"]
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        tv = b.new_page()
        tv.goto(f"{BASE}/tv/{code}")
        expect(tv.get_by_label("Rumskod")).to_have_text(code, timeout=15000)
        p = b.new_page(viewport={"width": 390, "height": 844})
        p.goto(f"{BASE}/play/{code}")
        p.get_by_label("Ditt namn").fill("Röktest")
        p.get_by_role("button", name="Hoppa in").click()
        expect(tv.get_by_text("1 spelare inne")).to_be_visible(timeout=15000)
        b.close()
    print(f"Röktest OK mot {BASE} (rum {code})")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"::error title=Röktest::{type(e).__name__}: {str(e)[:400]}".replace("\n", " "))
        sys.exit(1)
