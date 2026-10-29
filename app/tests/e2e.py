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

# Lyckohjulet via direkta websocket-klienter. Servern slumpar, så testet snurrar tills varje twist
# kommit upp (läser utfallet ur state) och kontrollerar sedan just den twistens effekt på nästa fråga.
WHEEL_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hjul', settings: { answerSeconds: 10, penalty: 1 },
      questions: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: 'q' + i, text: 'Fråga ' + i, answer: 'Svar ' + i })) }) });
  const { code, hostKey } = await res.json();
  const connect = (role, key) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [], errors: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'sping') ws.send(JSON.stringify({ t: 'spong', s: m.s }));
      if (m.t === 'joined') c.id = m.playerId;
      if (m.t === 'error') c.errors.push(m.message);
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
  const host = await connect('host', hostKey);
  const ps = {};
  for (const n of ['A', 'B', 'C']) { ps[n] = await connect('player'); send(ps[n], { t: 'join', name: n }); }
  await until(host, (st) => st?.players.length === 3);
  const score = (n) => host.state.players.find((p) => p.name === n).score;
  const scores = () => Object.fromEntries(host.state.players.map((p) => [p.name, p.score]));
  const out = { seen: {}, spins: 0 };

  // Snurra tills hjulet ger twisten (servern slumpar; max 120 försök).
  const spinFor = async (twist) => {
    for (let i = 0; i < 120; i++) {
      const before = host.state.wheel?.spinId ?? 0;
      send(host, { t: 'host:spin' });
      const st = await until(host, (s) => (s.wheel?.spinId ?? 0) > before);
      out.spins++;
      out.seen[st.wheel.result] = (out.seen[st.wheel.result] ?? 0) + 1;
      if (st.wheel.forQ !== st.qIndex + 1) throw new Error('snurret gäller inte nästa fråga');
      if (st.wheel.result === twist) return st.wheel;
    }
    throw new Error('hjulet gav aldrig ' + twist);
  };
  const next = async () => {
    const q = host.state.qIndex;
    send(host, { t: host.state.phase === 'lobby' ? 'host:start' : 'host:next' });
    await until(host, (s) => s.qIndex === q + 1 && s.phase === 'question');
    for (const n of ['A', 'B', 'C']) await until(ps[n], (s) => s.qIndex === q + 1 && s.phase === 'question');
  };
  const buzz = async (n) => { send(ps[n], { t: 'buzz' }); return until(host, (s) => s.phase === 'buzzed'); };
  const judge = async (kind) => { const q = host.state.qIndex; send(host, { t: kind }); await until(host, (s) => s.qIndex === q && s.phase !== 'buzzed'); };

  // Spelare får inte snurra; snurr under pågående fråga nekas.
  send(ps.A, { t: 'host:spin' }); await sleep(200);
  out.playerSpin = { errors: ps.A.errors.slice(), wheel: host.state.wheel ?? null };

  // 1) Dubbla poäng (snurras i lobbyn): rätt svar ger 2 p, och spelarna ser twisten.
  let w = await spinFor('double');
  out.playerSeesWheel = (await until(ps.B, (s) => s.wheel?.spinId === w.spinId)).wheel.result;
  await next();
  out.duringQuestion = { ...host.state.wheel, playerWheel: ps.C.state.wheel?.result };
  send(host, { t: 'host:spin' }); await sleep(200);
  out.spinDuringQuestion = { errors: host.errors.slice(), spinId: host.state.wheel?.spinId };
  await buzz('A'); await judge('host:correct');
  out.double = score('A');

  // 2) Utan nytt snurr: twisten är förbrukad, vanlig poäng igen.
  await next();
  out.afterDouble = { wheel: host.state.wheel ?? null };
  await buzz('A'); await judge('host:correct');
  out.plain = score('A');

  // 3) Ingen straffavgift: fel svar kostar inget.
  await spinFor('safe'); await next();
  const b0 = score('B');
  await buzz('B'); await judge('host:wrong');
  out.safe = { delta: score('B') - b0, event: host.state.lastEvent.delta };
  send(host, { t: 'host:reveal' }); await until(host, (s) => s.phase === 'reveal');

  // 4) Stjäl: C tar poängen från ledaren A (A leder med 3).
  await spinFor('steal'); await next();
  const s0 = scores();
  await buzz('C'); await judge('host:correct');
  const s1 = scores();
  out.steal = { A: s1.A - s0.A, C: s1.C - s0.C, B: s1.B - s0.B, stolenFrom: host.state.players.find((p) => p.id === host.state.lastEvent.stolenFrom)?.name };

  // 5) Blixt: halverad svarstid (10 s -> 5 s).
  await spinFor('blitz'); await next();
  const st = await buzz('B');
  out.blitzMs = st.buzz.deadline - st.serverNow;
  await judge('host:correct');

  // 6) Nit: ingen effekt.
  await spinFor('none'); await next();
  const a0 = score('A');
  await buzz('A'); await judge('host:wrong');
  out.none = score('A') - a0;

  // 7) Vanlig fråga efter Nit: full svarstid igen.
  await next();
  const st2 = await buzz('C');
  out.normalMs = st2.buzz.deadline - st2.serverNow;
  await judge('host:correct');

  // Sista frågan: det finns ingen nästa fråga att snurra för.
  await next();
  await buzz('A'); await judge('host:correct');
  const errs = host.errors.length;
  send(host, { t: 'host:spin' }); await sleep(200);
  out.lastSpinRejected = host.errors.length > errs;
  for (const c of [host, ...Object.values(ps)]) c.ws.close();
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


def http_get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return r.status, r.headers.get("content-type", ""), r.read()


def check_pwa(page):
    """Manifest, ikoner och service worker: appen ska gå att installera på hemskärmen."""
    status, ctype, body = http_get("/manifest.webmanifest")
    assert status == 200 and "html" not in ctype, f"Manifestet serveras fel: {status} {ctype}"
    m = json.loads(body)
    assert m["name"] == "Kronan" and m["display"] == "standalone", f"Fel manifest: {m}"
    assert m["start_url"] and m["theme_color"].lower() == "#1b28a8" and m["background_color"], "Manifest saknar färger/start_url"
    sizes = {(i["sizes"], i.get("purpose", "any")) for i in m["icons"]}
    assert ("192x192", "any") in sizes and ("512x512", "any") in sizes and ("512x512", "maskable") in sizes, f"Ikoner saknas: {sizes}"
    for src in [i["src"] for i in m["icons"]] + ["/apple-touch-icon.png"]:
        status, ctype, body = http_get(src)
        assert status == 200 and ctype.startswith("image/png") and body[:8] == b"\x89PNG\r\n\x1a\n", f"Ikon {src}: {status} {ctype}"
    status, ctype, body = http_get("/sw.js")
    assert status == 200 and "javascript" in ctype and b"<html" not in body, f"sw.js serveras fel: {status} {ctype}"
    assert page.locator('link[rel="manifest"]').get_attribute("href") == "/manifest.webmanifest", "Manifestlänk saknas i HTML"
    assert page.locator('link[rel="apple-touch-icon"]').count() == 1, "apple-touch-icon saknas i HTML"
    scope = page.evaluate("""async () => {
        const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
        return reg.scope;
    }""")
    assert scope == BASE + "/", f"Service workern registrerades inte rätt: {scope}"
    # Chromes egen bedömning av installerbarhet (samma som "Installera app"-knappen)
    cdp = page.context.new_cdp_session(page)
    errs = cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]
    assert not errs, f"Chrome anser inte appen installerbar: {errs}"
    assert not cdp.send("Page.getAppManifest").get("errors"), "Chrome hittar fel i manifestet"
    cdp.detach()
    # API och sidan fungerar fortfarande med SW aktiv (ingen cachning)
    page.reload()
    expect(page.get_by_role("heading", name="Vem tar kronan i veckan?")).to_be_visible()
    assert page.evaluate("fetch('/api/hub/public', {cache: 'no-store'}).then(r => r.status)") == 200


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
        page_errors = []
        p1.on("pageerror", lambda e: page_errors.append(str(e)))
        p1.goto(BASE + "/")
        expect(p1.get_by_role("heading", name="Vem tar kronan i veckan?")).to_be_visible()
        shot(p1, "01-start-mobil")

        # Installbar som app (PWA)
        check_pwa(p1)
        assert not page_errors, f"Sidfel på startsidan: {page_errors}"

        # Host loggar in och sätter kort svarstid
        host.goto(BASE + "/host")
        host.get_by_label("Host-PIN").fill(PIN)
        host.get_by_role("button", name="Lås upp").click()
        expect(host.get_by_role("heading", name="Starta kvällens quiz")).to_be_visible()
        host.get_by_label("Sekunder att svara efter buzz").fill("3")
        host.get_by_label("Straff vid fel eller timeout (poäng)").fill("1")
        shot(host, "02-host-dashboard")
        # Välj alltid premiärsetet uttryckligen: nyare set hamnar överst och testet förväntar sig dess svar.
        host.locator("label", has_text="Premiär: Blandat").get_by_role("radio").check()
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
        # Spelarsidan styrs av service workern och klarar en omladdning (websocket återansluter)
        assert p1.evaluate("!!navigator.serviceWorker.controller"), "/play styrs inte av service workern"
        p1.reload()
        expect(p1.get_by_text("Väntar på att hosten startar")).to_be_visible()
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

        # Lyckohjulet: hosten snurrar mellan frågorna, TV och spelare ser samma utfall
        host.get_by_role("button", name="Snurra hjulet").click()
        expect(tv.locator(".wheel")).to_be_visible()
        expect(tv.get_by_text("Lyckohjulet snurrar")).to_be_visible()
        expect(p1.get_by_text("Lyckohjulet snurrar")).to_be_visible()
        tv.wait_for_timeout(1200)
        shot(tv, "08b-tv-hjul-snurrar")
        # Omladdning mitt i snurret (TV och en spelare): hjulet ska fortsätta och landa på serverns fält
        tv.reload(); p2.reload()
        expect(tv.get_by_text("Lyckohjulet snurrar")).to_be_visible()
        tv_twist = tv.locator(".wheel-caption[data-twist]")
        expect(tv_twist).to_be_visible(timeout=8000)
        twist = tv_twist.get_attribute("data-twist")
        label = tv.locator(".wheel-result").inner_text()
        print("Lyckohjulet gav:", twist, label)
        expect(p1.locator(".wheel-result")).to_have_text(label)
        expect(p2.locator(".wheel-result")).to_have_text(label)
        expect(host.get_by_text("Nästa fråga: " + label)).to_be_visible()
        expect(tv.locator(".wheel-seg.hit")).to_have_count(1)
        tv.wait_for_timeout(500)
        under_pointer = tv.evaluate("""() => {
          const m = new DOMMatrix(getComputedStyle(document.querySelector('.wheel-disc')).transform);
          const deg = ((Math.atan2(m.b, m.a) * 180 / Math.PI) % 360 + 360) % 360;
          const segs = [...document.querySelectorAll('.wheel-seg')];
          return [Math.floor(((360 - deg) % 360) / (360 / segs.length)), segs.findIndex((e) => e.classList.contains('hit'))];
        }""")
        assert under_pointer[0] == under_pointer[1], f"Hjulet på TV:n stannade på fel fält efter omladdning: {under_pointer}"
        shot(tv, "08c-tv-hjul-landat")
        shot(p1, "08d-spelare-hjul")
        shot(host, "08e-host-hjul")

        # Fråga 2: Tobbe buzzar och svarar fel, låses ute; Erik låter tiden gå ut
        host.get_by_role("button", name="Nästa fråga (N)").click()
        expect(p2.get_by_role("button", name="Buzza")).to_be_enabled()
        if twist != "none":
            expect(tv.locator(f'.twist-badge[data-twist="{twist}"]')).to_be_visible()
            expect(p1.locator(f'.twist-badge[data-twist="{twist}"]')).to_be_visible()
            shot(tv, "08f-tv-fraga-med-twist")
            shot(p1, "08g-spelare-twist")
        expect(tv.locator(".wheel")).to_have_count(0)
        assert "Guld" not in tv.inner_text("body"), "TV-vyn läcker svaret innan reveal (fråga 2)!"
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
        # Ingen straffavgift gör fråga 2:s fel och timeout gratis; övriga twistar påverkar inte fel svar.
        expected = {"Erik": 1, "Tobbe": 0} if twist == "safe" else {"Erik": 0, "Tobbe": -1}
        assert res == expected, f"Fel slutpoäng med twisten {twist}: {res}, väntade {expected}"
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

        wheel = raw.evaluate(WHEEL_JS, [PIN])
        print("Lyckohjulet:", wheel)
        assert wheel["playerSpin"]["errors"] and wheel["playerSpin"]["wheel"] is None, f"Spelare kunde snurra hjulet: {wheel['playerSpin']}"
        assert wheel["playerSeesWheel"] == "double", "Spelarna fick inte hjulets utfall"
        assert wheel["duringQuestion"]["forQ"] == 0 and wheel["duringQuestion"]["playerWheel"] == "double", f"Twisten gäller inte första frågan: {wheel['duringQuestion']}"
        assert wheel["spinDuringQuestion"]["errors"] and wheel["spinDuringQuestion"]["spinId"] == wheel["duringQuestion"]["spinId"], "Hjulet gick att snurra under en fråga"
        assert wheel["double"] == 2, f"Dubbla poäng gav {wheel['double']}"
        assert wheel["afterDouble"]["wheel"] is None and wheel["plain"] == 3, f"Twisten nollställdes inte: {wheel}"
        assert wheel["safe"] == {"delta": 0, "event": 0}, f"Ingen straffavgift drog ändå poäng: {wheel['safe']}"
        assert wheel["steal"] == {"A": -1, "C": 1, "B": 0, "stolenFrom": "A"}, f"Stjäl fungerade inte: {wheel['steal']}"
        assert 4000 < wheel["blitzMs"] <= 5100, f"Blixt halverade inte svarstiden: {wheel['blitzMs']} ms"
        assert wheel["none"] == -1, f"Nit ska inte ändra något: {wheel['none']}"
        assert wheel["normalMs"] > 9000, f"Svarstiden återställdes inte efter Blixt: {wheel['normalMs']} ms"
        assert wheel["lastSpinRejected"], "Hjulet gick att snurra efter sista frågan"
        raw.close()

        b.close()
        print("E2E OK. Slutpoäng:", res)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("E2E MISSLYCKADES:", e)
        sys.exit(1)
