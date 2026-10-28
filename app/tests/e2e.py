"""
End-to-end-test av ett helt quizflöde: host + TV + två spelare.
Kör mot en lokal server:  npx wrangler dev --port 8787  (med HOST_PIN=1234 i .dev.vars)
    python3 tests/e2e.py [bas-url] [skärmdumpsmapp]
Avslutar med kod 1 om något steg misslyckas. Används av Testaren i AI-rådet.
"""
import sys, os, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "e2e-shots"
PIN = os.environ.get("HOST_PIN", "1234")
os.makedirs(SHOTS, exist_ok=True)

FAIR_BUZZ_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Rättvis buzz', questions: [1, 2, 3].map((i) => ({ id: 'q' + i, text: 'Fråga ' + i, answer: 'Svar ' + i })) }) });
  const { code, hostKey } = await res.json();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Klient som svarar på serverns RTT-mätning (sping) efter spongDelay ms.
  const connect = (role, spongDelay = 0, key) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'sping') setTimeout(() => ws.send(JSON.stringify({ t: 'spong', s: m.s })), spongDelay);
      if (m.t === 'joined') c.id = m.playerId;
      if (m.t === 'state') { c.state = m.state; c.waiters = c.waiters.filter((w) => !w()); }
    };
    ws.onopen = () => resolve(c);
  });
  const until = (c, pred, ms = 3000) => new Promise((resolve, reject) => {
    if (pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error('timeout i väntan på state')), ms);
    c.waiters.push(() => pred(c.state) ? (clearTimeout(t), resolve(c.state), true) : false);
  });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const host = await connect('host', 0, hostKey);
  const snabb = await connect('player', 0);      // låg ping
  const seg = await connect('player', 250);      // simulerad hög ping (~250 ms RTT)
  const fusk = await connect('player', 0);       // låg ping men ljuger om tidsstämpeln
  for (const [c, n] of [[snabb, 'Snabb'], [seg, 'Seg'], [fusk, 'Fuskare']]) send(c, { t: 'join', name: n });
  await sleep(900); // låt servern hinna mäta RTT
  const name = (st) => st.players.find((p) => p.id === st.buzz?.playerId)?.name;
  const out = {};

  // 1) Snabb anländer först, Seg 60 ms senare men tryckte 110 ms innan ankomst => justerat 50 ms före Snabb.
  send(host, { t: 'host:start' });
  await until(snabb, (st) => st?.phase === 'question' && st.qIndex === 0);
  await until(seg, (st) => st?.phase === 'question' && st.qIndex === 0);
  send(snabb, { t: 'buzz', at: Date.now() });
  await sleep(60);
  send(seg, { t: 'buzz', at: Date.now() - 110 });
  out.fair = name(await until(host, (st) => st?.phase === 'buzzed'));

  // 2) Fuskaren (låg ping) skickar en tidsstämpel 10 s bakåt, 60 ms efter Snabb => klampas, Snabb vinner.
  send(host, { t: 'host:next' });
  await until(snabb, (st) => st?.phase === 'question' && st.qIndex === 1);
  await until(fusk, (st) => st?.phase === 'question' && st.qIndex === 1);
  send(snabb, { t: 'buzz', at: Date.now() });
  await sleep(60);
  send(fusk, { t: 'buzz', at: Date.now() - 10000 });
  out.cheat = name(await until(host, (st) => st?.phase === 'buzzed'));

  // 3) Ensam buzz utan tidsstämpel fungerar som förut.
  send(host, { t: 'host:next' });
  await until(fusk, (st) => st?.phase === 'question' && st.qIndex === 2);
  send(fusk, { t: 'buzz' });
  out.single = name(await until(host, (st) => st?.phase === 'buzzed'));
  for (const c of [host, snabb, seg, fusk]) c.ws.close();
  return out;
}
"""


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        host = b.new_page(viewport={"width": 1280, "height": 860})
        tv = b.new_page(viewport={"width": 1600, "height": 900})
        p1 = b.new_page(viewport={"width": 390, "height": 844})
        p2 = b.new_page(viewport={"width": 390, "height": 844})

        # Startsida
        p1.goto(BASE + "/")
        expect(p1.get_by_role("heading", name="Vem tar kronan i veckan?")).to_be_visible()
        shot(p1, "01-start-mobil")

        # Host loggar in och sätter kort svarstid
        host.goto(BASE + "/host")
        host.get_by_label("Host-PIN").fill(PIN)
        host.get_by_role("button", name="Lås upp").click()
        expect(host.get_by_role("heading", name="Starta kvällens quiz")).to_be_visible()
        host.get_by_label("Sekunder att svara efter buzz").fill("3")
        host.get_by_label("Straff vid fel eller timeout (poäng)").fill("1")
        shot(host, "02-host-dashboard")
        host.get_by_role("button", name="Öppna rum").click()
        host.wait_for_url("**/host/*")
        code = host.url.rstrip("/").split("/")[-1]
        print("Rum:", code)

        tv.goto(f"{BASE}/tv/{code}")
        expect(tv.get_by_label("Rumskod")).to_have_text(code)

        # Spelare går med via koden
        for page, name in [(p1, "Erik"), (p2, "Tobbe")]:
            page.goto(BASE + "/")
            page.get_by_label("Rumskod från hosten").fill(code)
            page.get_by_role("button", name="Gå med").click()
            page.get_by_label("Ditt namn").fill(name)
            page.get_by_role("button", name="Hoppa in").click()
            expect(page.get_by_text("Väntar på att hosten startar")).to_be_visible()
        expect(tv.get_by_text("2 spelare inne")).to_be_visible()
        shot(tv, "03-tv-lobby")
        shot(p1, "04-spelare-lobby")

        # Fråga 1: Erik buzzar och svarar rätt
        host.get_by_role("button", name="Starta första frågan").click()
        expect(p1.get_by_role("button", name="Buzza")).to_be_enabled()
        shot(tv, "05-tv-fraga")
        shot(p1, "06-spelare-buzzer")
        p1.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(p2.get_by_text("Erik svarar")).to_be_visible()
        expect(p2.get_by_role("button", name="Buzza")).to_be_disabled()
        shot(tv, "07-tv-buzz")
        shot(host, "08-host-buzz")
        # Hosten ser svaret, TV:n gör det inte
        expect(host.get_by_text("Svar: 2010")).to_be_visible()
        assert "2010" not in tv.inner_text("body"), "TV-vyn läcker svaret innan reveal!"
        host.get_by_role("button", name="Rätt (R)").click()
        expect(tv.locator(".answer-reveal")).to_have_text("2010")
        expect(p1.locator(".chip").first).to_contain_text("1")

        # Fråga 2: Tobbe buzzar och svarar fel, låses ute; Erik låter tiden gå ut
        host.get_by_role("button", name="Nästa fråga (N)").click()
        p2.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(host.get_by_role("button", name="Fel (F)")).to_be_visible()
        host.get_by_role("button", name="Fel (F)").click()
        expect(p2.get_by_text("Du är utlåst")).to_be_visible()
        p1.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(p1.get_by_role("timer")).to_be_visible()
        shot(p1, "09-spelare-nedrakning")
        # Timeout efter 3 s => straff, alla utlåsta => svaret visas automatiskt
        expect(tv.locator(".answer-reveal")).to_be_visible(timeout=6000)

        before = len(json.loads(urllib.request.urlopen(BASE + "/api/hub/public").read())["league"])

        # Avsluta och kröna
        host.once("dialog", lambda d: d.accept())
        host.get_by_role("button", name="Avsluta i förtid").click()
        expect(tv.get_by_role("heading", name="Kvällens kung")).to_be_visible()
        host.get_by_role("button", name="Kröna vinnaren och spara i tabellen").click()
        expect(host.get_by_text("Sparat i tabellen")).to_be_visible()
        tv.wait_for_timeout(600)
        shot(tv, "10-tv-pallen")

        league = json.loads(urllib.request.urlopen(BASE + "/api/hub/public").read())["league"]
        assert len(league) == before + 1, "Kröningen sparades inte i tabellen"
        res = {r["name"]: r["score"] for r in league[0]["results"]}
        assert res == {"Erik": 0, "Tobbe": -1}, f"Fel slutpoäng: {res}"
        p1.goto(BASE + "/tabell")
        expect(p1.get_by_role("heading", name="Säsongen")).to_be_visible()
        shot(p1, "11-tabell")

        # Frågebank: skapa set via snabbinklistring
        host.goto(BASE + "/bank")
        host.get_by_role("button", name="Nytt set").click()
        host.get_by_label("Titel").fill("Test-set")
        host.get_by_text("Klistra in många på en gång").click()
        host.get_by_placeholder("Vilket år kom HoN ut?").fill("Fråga A | Svar A\nFråga B | Svar B | 2")
        host.get_by_role("button", name="Lägg till raderna").click()
        shot(host, "12-bank-editor")
        host.get_by_role("button", name="Spara set").click()
        expect(host.get_by_text("Test-set").first).to_be_visible()

        # Rättvis buzz: direkta websocket-klienter med simulerad ping
        raw = b.new_page()
        raw.goto(BASE + "/")
        fair = raw.evaluate(FAIR_BUZZ_JS, [PIN])
        print("Rättvis buzz:", fair)
        assert fair["fair"] == "Seg", f"Spelaren med lägst justerad tid ska vinna, vann: {fair['fair']}"
        assert fair["cheat"] == "Snabb", f"Fusk-tidsstämpeln klampades inte, vann: {fair['cheat']}"
        assert fair["single"] == "Fuskare", f"Ensam buzz utan tidsstämpel ska fungera, vann: {fair['single']}"
        raw.close()

        b.close()
        print("E2E OK. Slutpoäng:", res)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("E2E MISSLYCKADES:", e)
        sys.exit(1)
