"""
Kentas röst (Piper): laddar den svenska rösten från Hugging Face i en riktig webbläsare, syntetiserar
några repliker och sparar dem som WAV (nykter och full) så att man kan lyssna. Kräver internet, så
testet körs i CI (sandlådan når inte Hugging Face).
    python3 tests/piper_check.py http://127.0.0.1:8787 piper-wav
"""
import sys, os, base64
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/")
OUT = sys.argv[2] if len(sys.argv) > 2 else "piper-wav"
os.makedirs(OUT, exist_ok=True)

LINES = [
    ("1-intro-nykter", 1, "Tjeeena! Det är jag, Kenta. Åh, Tobbe är min buddy. Asså MIN BUDDYYY! Jag hejar fan på dig hela kvällen."),
    ("2-vinst-lite-full", 3, "Faaaan! Jag VISSTE att du var min buddy! Buddy buddy, buddy! Det här firas med en sup."),
    ("3-forlust-full", 5, "Neeej, Tobbe... min buddy. Det där var tungt. Det kräver en sjup. För sorgen."),
    ("4-hookoff-helt-borta", 6, "HÖRRNI! Nu är det dags för lite hooker-grejer vaaaa? Erik! Du är hookern."),
]

def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_page()
        errors = []
        p.on("pageerror", lambda e: errors.append(str(e)))
        p.goto(f"{BASE}/host/minispel")
        # Testkroken laddas med demo-sidans Kenta-flik (usePiper), så öppna den.
        p.get_by_role("tab", name="Kenta (fyllot)").click()
        p.wait_for_function("typeof window.kentaPiperTest === 'function'", timeout=20000)
        res = p.evaluate("async () => await window.kentaPiperTest()")
        print("Piper:", res)
        assert res.get("ok"), f"Piper laddades inte: {res} {errors}"
        assert res["seconds"] > 0.8 and res["rms"] > 0.01, f"Piper gav tyst eller för kort ljud: {res}"
        for name, level, text in LINES:
            b64 = p.evaluate("async ([t, l]) => await window.kentaPiperWav(t, l)", [text, level])
            path = os.path.join(OUT, f"kenta-{name}.wav")
            with open(path, "wb") as f:
                f.write(base64.b64decode(b64))
            print("Sparade", path, os.path.getsize(path), "byte")
        # Andra laddningen ska gå från webbläsarens cache
        p.reload()
        p.get_by_role("tab", name="Kenta (fyllot)").click()
        p.wait_for_function("typeof window.kentaPiperTest === 'function'", timeout=20000)
        again = p.evaluate("async () => { const t = performance.now(); const r = await window.kentaPiperTest('Skål!'); return { ...r, total: Math.round(performance.now() - t) }; }")
        print("Från cache:", again)
        assert again.get("ok"), f"Piper från cache misslyckades: {again}"
        assert not errors, f"Sidfel: {errors}"
        b.close()
    print("Piper OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("PIPER MISSLYCKADES:", e)
        sys.exit(1)
