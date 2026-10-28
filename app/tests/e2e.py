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
    body: JSON.stringify({ title: 'Rättvis buzz', questions: [1, 2, 3, 4, 5].map((i) => ({ id: 'q' + i, text: 'Fråga ' + i, answer: 'Svar ' + i })) }) });
  const { code, hostKey } = await res.json();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Klient som svarar på serverns RTT-mätning (sping) efter spongDelay ms; fakeS ekar ett förfalskat s.
  const connect = (role, spongDelay = 0, key, fakeS = 0) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'sping') setTimeout(() => ws.send(JSON.stringify({ t: 'spong', s: m.s - fakeS })), spongDelay);
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
  const seg = await connect('player', 120);      // simulerad verklig hög ping: alla spong fördröjs 120 ms
  const fusk = await connect('player', 0);       // låg ping men ljuger om tidsstämpeln
  const falskS = await connect('player', 0, undefined, 9000); // låtsas ha 9 s RTT via falskt s
  const drojer = await connect('player', 300);   // låg ping men fördröjer spong 300 ms för att blåsa upp RTT
  for (const [c, n] of [[snabb, 'Snabb'], [seg, 'Seg'], [fusk, 'Fuskare'], [falskS, 'FalskS'], [drojer, 'Fördröjd']]) send(c, { t: 'join', name: n });
  await sleep(900); // låt servern hinna mäta RTT
  const name = (st) => st.players.find((p) => p.id === st.buzz?.playerId)?.name;
  const out = {};

  // 1) Snabb anländer först, Seg 30 ms senare men tryckte 60 ms innan ankomst (≈ RTT/2) => justerat ~30 ms före Snabb.
  send(host, { t: 'host:start' });
  await until(snabb, (st) => st?.phase === 'question' && st.qIndex === 0);
  await until(seg, (st) => st?.phase === 'question' && st.qIndex === 0);
  send(snabb, { t: 'buzz', at: Date.now() });
  await sleep(30);
  send(seg, { t: 'buzz', at: Date.now() - 60 });
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

  // 4) Falskt s i spong ignoreras: ingen RTT godtas, så 120 ms efter Snabb med at långt bakåt förlorar.
  send(host, { t: 'host:next' });
  await until(falskS, (st) => st?.phase === 'question' && st.qIndex === 3);
  send(snabb, { t: 'buzz', at: Date.now() });
  await sleep(120);
  send(falskS, { t: 'buzz', at: Date.now() - 100000 });
  out.fakeS = name(await until(host, (st) => st?.phase === 'buzzed'));

  // 5) Fördröjd spong ger högst taket (70 ms) i fördel: 120 ms efter Snabb förlorar ändå.
  send(host, { t: 'host:next' });
  await until(drojer, (st) => st?.phase === 'question' && st.qIndex === 4);
  send(snabb, { t: 'buzz', at: Date.now() });
  await sleep(120);
  send(drojer, { t: 'buzz', at: Date.now() - 100000 });
  out.delayedSpong = name(await until(host, (st) => st?.phase === 'buzzed'));
  for (const c of [host, snabb, seg, fusk, falskS, drojer]) c.ws.close();
  return out;
}
"""

# Kantfall kring buzz-fönstret. Varje fall får ett eget rum.
EDGE_BUZZ_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const connect = (code, role, key) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [], states: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'sping') ws.send(JSON.stringify({ t: 'spong', s: m.s }));
      if (m.t === 'joined') c.id = m.playerId;
      if (m.t === 'state') { c.state = m.state; c.states.push(m.state); c.waiters = c.waiters.filter((w) => !w()); }
    };
    ws.onopen = () => resolve(c);
  });
  const until = (c, pred, ms = 3000) => new Promise((resolve, reject) => {
    if (pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error('timeout i väntan på state')), ms);
    c.waiters.push(() => pred(c.state) ? (clearTimeout(t), resolve(c.state), true) : false);
  });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const name = (st) => st.players.find((p) => p.id === st.buzz?.playerId)?.name ?? null;
  const setup = async (names) => {
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Kantfall', questions: [1, 2, 3].map((i) => ({ id: 'q' + i, text: 'Fråga ' + i, answer: 'Svar ' + i })) }) });
    const { code, hostKey } = await res.json();
    const host = await connect(code, 'host', hostKey);
    const ps = {};
    for (const n of names) { ps[n] = await connect(code, 'player'); send(ps[n], { t: 'join', name: n }); }
    await sleep(400);
    send(host, { t: 'host:start' });
    await until(host, (st) => st?.phase === 'question');
    for (const n of names) await until(ps[n], (st) => st?.phase === 'question');
    return { code, host, ps, all: [host, ...Object.values(ps)] };
  };
  const winner = async (host) => { try { return name(await until(host, (st) => st?.phase === 'buzzed', 1500)); } catch { return null; } };
  const done = (r) => r.all.forEach((c) => c.ws.close());
  const out = {};

  // Exakt samtidigt (samma tick, samma at): den som kom först vinner, alltid.
  out.simultaneous = [];
  for (let i = 0; i < 3; i++) {
    const r = await setup(['A', 'B']);
    const at = Date.now(); send(r.ps.A, { t: 'buzz', at }); send(r.ps.B, { t: 'buzz', at });
    out.simultaneous.push(await winner(r.host)); done(r);
  }

  // Host går till nästa fråga / visar svaret / avslutar mitt i fönstret: ingen buzz ska dyka upp efteråt.
  for (const [k, msg, phase] of [['next', 'host:next', 'question'], ['reveal', 'host:reveal', 'reveal'], ['finish', 'host:finish', 'finished']]) {
    const r = await setup(['A', 'B']);
    send(r.ps.A, { t: 'buzz' }); await sleep(20); send(r.host, { t: msg });
    await sleep(400);
    out[k] = { phase: r.host.state.phase === phase, buzz: name(r.host.state) };
    if (k === 'next') { send(r.ps.B, { t: 'buzz' }); out[k].after = await winner(r.host); }
    done(r);
  }

  // Utlåst spelare som buzzar (även med fusk-tidsstämpel) räknas inte.
  { const r = await setup(['Ut', 'Kvar']);
    send(r.ps.Ut, { t: 'buzz' }); await until(r.host, (st) => st?.phase === 'buzzed');
    send(r.host, { t: 'host:wrong' }); await until(r.host, (st) => st?.phase === 'question' && st.lockedOut.length === 1);
    send(r.ps.Kvar, { t: 'buzz', at: Date.now() }); send(r.ps.Ut, { t: 'buzz', at: Date.now() - 9999 });
    out.lockedOut = await winner(r.host); done(r); }

  // Samma spelare spammar buzz med allt bättre tidsstämplar: första buzzen gäller.
  { const r = await setup(['Lugn', 'Spam']);
    send(r.ps.Lugn, { t: 'buzz', at: Date.now() }); await sleep(40);
    send(r.ps.Spam, { t: 'buzz', at: Date.now() });
    for (let i = 0; i < 30; i++) send(r.ps.Spam, { t: 'buzz', at: 0 });
    out.spam = await winner(r.host); await sleep(300);
    out.spamBuzzed = r.host.states.filter((s) => s.phase === 'buzzed').length; done(r); }

  // Spelare buzzar och laddar om mitt i fönstret: buzzen står kvar, ny buzz efter återanslutning ignoreras.
  { const r = await setup(['Ladd', 'Annan']);
    const id = r.ps.Ladd.id;
    send(r.ps.Ladd, { t: 'buzz', at: Date.now() }); r.ps.Ladd.ws.close();
    await sleep(30); send(r.ps.Annan, { t: 'buzz', at: Date.now() });
    const re = await connect(r.code, 'player'); send(re, { t: 'join', name: 'Ladd', playerId: id });
    await sleep(30); send(re, { t: 'buzz', at: Date.now() - 5000 });
    out.reload = await winner(r.host); r.all.push(re); done(r); }
  return out;
}
"""


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


# Samma mönster som HAPTIC i src/lib/sound.ts
VIB_BUZZ, VIB_RIGHT, VIB_WRONG = [60], [40, 60, 40, 60, 120], [300, 80, 300]

# Android-liknande: spela in navigator.vibrate-anrop
STUB_VIBRATE = """
window.__vib = [];
Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, writable: true,
  value: function (p) { window.__vib.push(Array.isArray(p) ? p : [p]); return true; } });
"""
# iOS Safari-liknande: navigator.vibrate finns inte alls
NO_VIBRATE = "delete Navigator.prototype.vibrate; delete navigator.vibrate;"


def vib(page):
    return page.evaluate("window.__vib")


def wait_vib(page, expected):
    page.wait_for_function("n => window.__vib.length >= n", arg=len(expected), timeout=5000)
    page.wait_for_timeout(200)  # fånga eventuella extra anrop
    got = vib(page)
    assert got == expected, f"Fel vibrationer: {got}, väntade {expected}"


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        host = b.new_page(viewport={"width": 1280, "height": 860})
        tv = b.new_page(viewport={"width": 1600, "height": 900})
        p1 = b.new_page(viewport={"width": 390, "height": 844})
        p2 = b.new_page(viewport={"width": 390, "height": 844})
        p1.add_init_script(STUB_VIBRATE)
        p2.add_init_script(NO_VIBRATE)
        page_errors = []
        for pg in (p1, p2):
            pg.on("pageerror", lambda e: page_errors.append(str(e)))

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
        wait_vib(p1, [VIB_BUZZ])
        assert p2.evaluate("'vibrate' in navigator") is False, "iOS-stubben fungerar inte"
        shot(tv, "07-tv-buzz")
        shot(host, "08-host-buzz")
        # Hosten ser svaret, TV:n gör det inte
        expect(host.get_by_text("Svar: 2010")).to_be_visible()
        assert "2010" not in tv.inner_text("body"), "TV-vyn läcker svaret innan reveal!"
        host.get_by_role("button", name="Rätt (R)").click()
        expect(tv.locator(".answer-reveal")).to_have_text("2010")
        expect(p1.locator(".chip").first).to_contain_text("1")
        wait_vib(p1, [VIB_BUZZ, VIB_RIGHT])

        # Fråga 2: Tobbe buzzar och svarar fel, låses ute; Erik låter tiden gå ut
        host.get_by_role("button", name="Nästa fråga (N)").click()
        p2.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(host.get_by_role("button", name="Fel (F)")).to_be_visible()
        host.get_by_role("button", name="Fel (F)").click()
        expect(p2.get_by_text("Du är utlåst")).to_be_visible()
        # Tobbe (utan vibrate) kunde buzza och få fel utan sidfel; Erik vibrerar inte för andras buzz
        assert vib(p1) == [VIB_BUZZ, VIB_RIGHT], f"Vibrerade för annan spelare: {vib(p1)}"
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"
        p1.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(p1.get_by_role("timer")).to_be_visible()
        shot(p1, "09-spelare-nedrakning")
        # Timeout efter 3 s => straff, alla utlåsta => svaret visas automatiskt
        expect(tv.locator(".answer-reveal")).to_be_visible(timeout=6000)
        wait_vib(p1, [VIB_BUZZ, VIB_RIGHT, VIB_BUZZ, VIB_WRONG])
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"
        # Erik laddar om: senaste händelsen (hans timeout) är gammal och ska inte vibrera igen
        p1.reload()
        expect(p1.locator(".chip").first).to_contain_text("Erik")
        p1.wait_for_timeout(1000)
        assert vib(p1) == [], f"Vibrerade för gammal händelse efter omladdning: {vib(p1)}"

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
        assert fair["fakeS"] == "Snabb", f"Falskt s i spong godtogs, vann: {fair['fakeS']}"
        assert fair["delayedSpong"] == "Snabb", f"Fördröjd spong gav mer än taket i fördel, vann: {fair['delayedSpong']}"

        edge = raw.evaluate(EDGE_BUZZ_JS, [PIN])
        print("Buzz-kantfall:", edge)
        assert edge["simultaneous"] == ["A", "A", "A"], f"Exakt samtidiga buzzar ska vinnas av den som kom först: {edge['simultaneous']}"
        for k in ("next", "reveal", "finish"):
            assert edge[k]["phase"] and edge[k]["buzz"] is None, f"host:{k} under buzz-fönstret läckte en buzz: {edge[k]}"
        assert edge["next"]["after"] == "B", f"Buzz på nästa fråga efter avbrutet fönster fungerar inte: {edge['next']}"
        assert edge["lockedOut"] == "Kvar", f"Utlåst spelare fick buzza: {edge['lockedOut']}"
        assert edge["spam"] == "Lugn" and edge["spamBuzzed"] == 1, f"Spam-buzz skrev över första buzzen: {edge}"
        assert edge["reload"] == "Ladd", f"Buzz försvann vid omladdning mitt i fönstret: {edge['reload']}"
        raw.close()

        b.close()
        print("E2E OK. Slutpoäng:", res)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("E2E MISSLYCKADES:", e)
        sys.exit(1)
