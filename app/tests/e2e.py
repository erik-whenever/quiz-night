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

  // Rate-limit: 50 buzzar + 200 ping i en klump. Servern lever, taket håller och vanliga spelare påverkas inte.
  { const r = await setup(['Flod', 'Vanlig']);
    const flod = r.ps.Flod; let pongs = 0;
    flod.ws.addEventListener('message', (ev) => { if (JSON.parse(ev.data).t === 'pong') pongs++; });
    for (let i = 0; i < 50; i++) send(flod, { t: 'buzz', at: Date.now() });
    out.floodWinner = await winner(r.host);
    send(r.host, { t: 'host:wrong' }); await until(r.host, (st) => st?.phase === 'question' && st.lockedOut.length === 1);
    send(r.ps.Vanlig, { t: 'buzz', at: Date.now() });
    out.normalAfterFlood = await winner(r.host);
    // Ny fråga direkt efter en ny flod: Flods tomma hink släpper inte igenom nästa buzz, Vanlig vinner.
    // Tidskänsligt: hinken fylls på med en buzz per 200 ms. Vänta först tills den är exakt full (taket 5),
    // så floden tömmer den till ~0 och marginalen blir hela 200 ms. Tog host:next-rundan ändå för lång tid
    // (långsam CI) görs ett nytt försök på nästa fråga; Python hoppar över kontrollen om alla blev för långsamma.
    for (let q = 1; q <= 2; q++) {
      await sleep(1100);
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) send(flod, { t: 'buzz', at: Date.now() });
      send(r.host, { t: 'host:next' }); await until(flod, (st) => st?.phase === 'question' && st.qIndex === q);
      send(flod, { t: 'buzz', at: Date.now() });
      out.throttleGapMs = Math.round(performance.now() - t0);
      await sleep(250);
      send(r.ps.Vanlig, { t: 'buzz', at: Date.now() });
      out.throttled = await winner(r.host);
      if (out.throttleGapMs < 150) break;
    }
    await sleep(2500);
    for (let i = 0; i < 200; i++) send(flod, { t: 'ping', c: i });
    await sleep(500);
    out.floodPongs = pongs;
    pongs = 0; await sleep(1500); send(flod, { t: 'ping', c: -1 }); await sleep(300);
    out.pongAfter = pongs;
    const tv = await connect(r.code, 'tv'); r.all.push(tv);
    out.alive = (await until(tv, (st) => !!st)).players.length;
    done(r); }

  // Legitimt snabbt spel: buzz, fel, ny fråga, buzz direkt igen (tre gånger i rad) går alltid igenom,
  // och hosten kan rätta poäng med 40 host:adjust i följd utan att något stryps.
  { const r = await setup(['Snabb', 'Annan']);
    out.fastRebuzz = [];
    for (let q = 0; q < 3; q++) {
      if (q > 0) { send(r.host, { t: 'host:next' }); await until(r.ps.Snabb, (st) => st?.phase === 'question' && st.qIndex === q); }
      send(r.ps.Snabb, { t: 'buzz', at: Date.now() });
      out.fastRebuzz.push(await winner(r.host));
      send(r.host, { t: 'host:wrong' }); await until(r.host, (st) => st?.phase === 'question' && st.lockedOut.length === 1);
    }
    const before = r.host.state.players.find((p) => p.name === 'Annan').score;
    for (let i = 0; i < 40; i++) send(r.host, { t: 'host:adjust', playerId: r.ps.Annan.id, delta: 1 });
    const st = await until(r.host, (s) => s.players.find((p) => p.name === 'Annan').score === before + 40, 1500).catch(() => r.host.state);
    out.adjusted = st.players.find((p) => p.name === 'Annan').score - before;
    done(r); }
  return out;
}
"""

# "Alla svarar" på protokollnivå: sekretess, låsning, deadline och poäng. TV-klientens råa meddelanden granskas.
COLLECT_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Alla svarar', settings: { collectSeconds: 5 }, questions: [
      { id: 'a1', text: 'Hemlig fråga', answer: 'FACIT-XYZ', points: 2, mode: 'all' },
      { id: 'a2', text: 'Vanlig fråga', answer: 'Buzzsvar' },
      { id: 'a3', text: 'Bluff-mode', answer: 'X', mode: 'nonsens' } ] }) });
  const { code, hostKey } = await res.json();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const connect = (role, key) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [], raw: [], errors: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'sping') ws.send(JSON.stringify({ t: 'spong', s: m.s }));
      if (m.t === 'joined') c.id = m.playerId;
      if (m.t === 'error') c.errors.push(m.message);
      if (m.t === 'state') { c.raw.push(ev.data); c.state = m.state; c.waiters = c.waiters.filter((w) => !w()); }
    };
    ws.onopen = () => resolve(c);
  });
  const until = (c, pred, ms = 3000) => new Promise((resolve, reject) => {
    if (pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error('timeout i väntan på state: ' + JSON.stringify(c.state?.phase))), ms);
    c.waiters.push(() => pred(c.state) ? (clearTimeout(t), resolve(c.state), true) : false);
  });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const host = await connect('host', hostKey);
  const tv = await connect('tv');
  const ps = {};
  for (const n of ['A', 'B', 'C', 'D']) { ps[n] = await connect('player'); send(ps[n], { t: 'join', name: n }); }
  await sleep(300);
  const id = (n) => ps[n].id;
  const score = (st, n) => st.players.find((p) => p.name === n).score;
  const out = {};

  send(host, { t: 'host:start' });
  const st0 = await until(tv, (st) => st?.phase === 'collect');
  out.startPhase = st0.phase; out.mode = st0.question.mode;
  out.countdown = st0.collect.deadline - st0.collect.startedAt;
  send(ps.A, { t: 'buzz' }); await sleep(250);
  out.buzzIgnored = host.state.phase === 'collect' && host.state.buzz === null;

  send(ps.B, { t: 'answer', text: '   ' });           // tomt: avvisas
  send(ps.B, { t: 'answer', text: 'Fel-svar-B' });    // först, men fel
  await sleep(80);
  send(ps.A, { t: 'answer', text: 'Ratt-svar-A' });   // rätt, näst först
  await sleep(80);
  send(ps.A, { t: 'answer', text: 'Byter-svar-A' });  // låst: avvisas
  await until(host, (st) => st?.collectHost?.answers.length === 2);
  await sleep(200); // låt felsvaren hinna fram
  out.order = host.state.collectHost.answers.map((a) => a.text);
  out.timesIncreasing = host.state.collectHost.answers[0].at <= host.state.collectHost.answers[1].at;
  out.publicAnswered = tv.state.collect.answered.length;
  out.errorsB = ps.B.errors.slice(); out.errorsA = ps.A.errors.slice();

  // C och D svarar inte: servern stänger själv vid deadline. C:s sena svar avvisas.
  await until(tv, (st) => st?.phase === 'judge', 7000);
  send(ps.C, { t: 'answer', text: 'For-sent-C' }); await sleep(200);
  out.lateRejected = ps.C.errors.includes('Tiden är ute') && host.state.collectHost.answers.length === 2;

  // Hosten markerar B rätt, ångrar sig, markerar A rätt. Sedan bekräftelse.
  send(host, { t: 'host:mark', playerId: id('B'), correct: true });
  send(host, { t: 'host:mark', playerId: id('A'), correct: true });
  send(host, { t: 'host:mark', playerId: id('B'), correct: false });
  send(host, { t: 'host:mark', playerId: id('C'), correct: true }); // har inget svar: ignoreras
  await until(host, (st) => st?.collectHost?.correct.length === 1 && st.collectHost.correct[0] === id('A'));
  const secret = ['FACIT-XYZ', 'Fel-svar-B', 'Ratt-svar-A', 'Byter-svar-A', 'For-sent-C'];
  out.leakBeforeReveal = [tv, ps.A, ps.B, ps.C, ps.D].flatMap((c) => c.raw).filter((r) => secret.some((x) => r.includes(x))).length;
  send(host, { t: 'host:judge' });
  const st1 = await until(tv, (st) => st?.phase === 'reveal');
  out.scores = { A: score(st1, 'A'), B: score(st1, 'B'), C: score(st1, 'C'), D: score(st1, 'D') };
  out.results = st1.collect.results.map((r) => [r.text, r.correct, r.fastest, r.delta]);
  out.revealed = st1.revealedAnswer;
  send(host, { t: 'host:mark', playerId: id('B'), correct: true }); await sleep(200); // efter rättning: ingen effekt
  out.afterJudge = score(tv.state, 'B');

  // Nästa fråga är en vanlig buzz-fråga och fungerar som förut.
  send(host, { t: 'host:next' });
  const st2 = await until(tv, (st) => st?.phase === 'question' && st.qIndex === 1);
  out.buzzMode = st2.question.mode; out.buzzCollect = st2.collect ?? null;
  send(ps.C, { t: 'answer', text: 'ignoreras' });
  send(ps.C, { t: 'buzz' });
  out.buzzWinner = (await until(host, (st) => st?.phase === 'buzzed')).buzz.playerId === id('C');
  // Okänd mode behandlas som buzz.
  send(host, { t: 'host:next' });
  out.unknownMode = (await until(tv, (st) => st?.qIndex === 2)).phase;
  for (const c of [host, tv, ...Object.values(ps)]) c.ws.close();
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

        # Fråga 3: Alla svarar. En tredje spelare hoppar in mitt i quizet.
        p3 = b.new_page(viewport={"width": 390, "height": 844})
        p3.on("pageerror", lambda e: page_errors.append(str(e)))
        p3.goto(f"{BASE}/play/{code}")
        p3.get_by_label("Ditt namn").fill("Sanna")
        p3.get_by_role("button", name="Hoppa in").click()
        expect(tv.locator(".chip", has_text="Sanna")).to_be_visible()
        host.get_by_role("button", name="Nästa fråga (N)").click()
        for pg in (p1, p2, p3):
            expect(pg.get_by_label("Ditt svar")).to_be_visible()
            assert pg.get_by_role("button", name="Buzza").count() == 0, "Buzzern visas i Alla svarar"
        expect(tv.get_by_text("Skriv ditt svar i mobilen")).to_be_visible()
        expect(tv.get_by_role("timer")).to_be_visible()
        shot(p1, "13-spelare-alla-svarar")
        p1.get_by_label("Ditt svar").fill("Vänern")
        p1.get_by_role("button", name="Lås svar").click()
        expect(p1.get_by_text("Ditt svar är låst")).to_be_visible()
        expect(p1.locator(".locked-text")).to_have_text("”Vänern”")
        p3.get_by_label("Ditt svar").fill("Vättern")
        p3.get_by_role("button", name="Lås svar").click()
        expect(p3.get_by_text("Ditt svar är låst")).to_be_visible()
        expect(tv.locator(".answered.done")).to_have_count(2)
        expect(host.get_by_label("Inlämnade svar").locator("li")).to_have_count(2)
        shot(tv, "14-tv-alla-svarar")
        shot(p1, "15-spelare-svar-last")
        for secret in ("Vänern", "Vättern"):
            assert secret not in tv.inner_text("body"), f"TV-vyn läcker {secret} under insamlingen!"
        p2.wait_for_timeout(700)  # Tobbe är långsammast
        p2.get_by_label("Ditt svar").fill("vänern")
        p2.get_by_role("button", name="Lås svar").click()
        # Alla har svarat: insamlingen stängs direkt och hosten rättar
        expect(tv.get_by_text("Hosten rättar")).to_be_visible()
        expect(p2.get_by_text("Hosten rättar").first).to_be_visible()
        for secret in ("Vänern", "Vättern", "vänern"):
            assert secret not in tv.inner_text("body"), f"TV-vyn läcker {secret} före reveal!"
        mark = host.get_by_label("Inlämnade svar")
        assert [t.split("”")[1] for t in mark.locator("li").all_inner_texts()] == ["Vänern", "Vättern", "vänern"], "Fel inlämningsordning hos hosten"
        host.get_by_label("Sanna svarade rätt").check()
        expect(host.get_by_label("Sanna svarade rätt")).to_be_checked()
        host.get_by_label("Sanna svarade rätt").uncheck()  # hosten ångrar sig
        host.get_by_label("Erik svarade rätt").check()
        host.get_by_label("Tobbe svarade rätt").check()
        expect(host.get_by_label("Tobbe svarade rätt")).to_be_checked()
        expect(host.get_by_label("Sanna svarade rätt")).not_to_be_checked()
        expect(mark.locator("li", has_text="Erik")).to_contain_text("Bonus")
        shot(host, "16-host-ratta")
        # Under rättningen får varken knapp eller N/V-tangent hoppa vidare och kasta allas svar
        assert host.get_by_role("button", name="Nästa fråga (N)").count() == 0, "Nästa fråga visas under rättningen"
        host.locator("h1, h2").first.click()
        host.keyboard.press("n")
        host.keyboard.press("v")
        host.wait_for_timeout(400)
        expect(host.get_by_text("Insamlingen är stängd")).to_be_visible()
        expect(host.get_by_label("Erik svarade rätt")).to_be_checked()
        host.get_by_role("button", name="Bekräfta och visa svaren").click()
        expect(tv.locator(".answer-reveal")).to_have_text("Vänern")
        results = tv.get_by_label("Allas svar").locator("li")
        expect(results).to_have_count(3)
        expect(results.nth(0)).to_contain_text("Snabbast")
        expect(results.nth(0)).to_contain_text("Rätt +2")
        expect(results.nth(1)).to_contain_text("Fel")
        expect(results.nth(2)).to_contain_text("Rätt +1")
        expect(p1.get_by_text("Rätt! +2 p")).to_be_visible()
        expect(p2.get_by_text("Rätt! +1 p")).to_be_visible()
        expect(p3.get_by_text("Fel den här gången")).to_be_visible()
        wait_vib(p1, [VIB_RIGHT])
        tv.wait_for_timeout(800)
        shot(tv, "17-tv-alla-svarar-facit")
        shot(p1, "18-spelare-alla-svarar-ratt")
        shot(p3, "19-spelare-alla-svarar-fel")
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"

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
        # Erik: +1 -1 +1 +1 bonus, Tobbe: -1 +1, Sanna: fel kostar inget i Alla svarar
        assert res == {"Erik": 2, "Tobbe": 0, "Sanna": 0}, f"Fel slutpoäng: {res}"
        p1.goto(BASE + "/tabell")
        expect(p1.get_by_role("heading", name="Säsongen")).to_be_visible()
        shot(p1, "11-tabell")

        # Frågebank: skapa set via snabbinklistring
        host.goto(BASE + "/bank")
        host.get_by_role("button", name="Nytt set").click()
        host.get_by_label("Titel").fill("Test-set")
        host.get_by_text("Klistra in många på en gång").click()
        host.get_by_placeholder("Vilket år kom HoN ut?").fill("Fråga A | Svar A\nFråga B | Svar B | 2\nFråga C | Svar C | 1 | alla")
        host.get_by_role("button", name="Lägg till raderna").click()
        expect(host.get_by_label("Rundtyp 3")).to_have_value("all")
        expect(host.get_by_label("Rundtyp 1")).to_have_value("buzz")
        host.get_by_label("Rundtyp 1").select_option("all")
        shot(host, "12-bank-editor")
        host.get_by_role("button", name="Spara set").click()
        expect(host.get_by_text("Test-set").first).to_be_visible()
        expect(host.get_by_text("3 frågor · 2 Alla svarar").first).to_be_visible()
        saved = host.locator(".panel", has_text="Test-set").first
        saved.get_by_role("button", name="Redigera").click()
        expect(host.get_by_label("Rundtyp 1")).to_have_value("all")
        expect(host.get_by_label("Rundtyp 2")).to_have_value("buzz")
        expect(host.get_by_label("Rundtyp 3")).to_have_value("all")
        host.get_by_role("button", name="Stäng").click()
        # JSON-import läser "mode": "all"
        imp = os.path.join(SHOTS, "import-test.json")
        with open(imp, "w") as f:
            json.dump({"title": "Importerat", "questions": [
                {"text": "Importerad 1", "answer": "X", "mode": "all"}, {"text": "Importerad 2", "answer": "Y"}]}, f)
        host.locator('input[type="file"]').set_input_files(imp)
        expect(host.get_by_label("Rundtyp 1")).to_have_value("all")
        expect(host.get_by_label("Rundtyp 2")).to_have_value("buzz")
        os.remove(imp)

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
        assert edge["floodWinner"] == "Flod" and edge["normalAfterFlood"] == "Vanlig", f"Servern klarade inte buzz-flod: {edge}"
        if edge["throttleGapMs"] < 150:
            assert edge["throttled"] == "Vanlig", f"Buzz-taket släppte igenom flod-buzz: {edge['throttled']} ({edge['throttleGapMs']} ms)"
        else:
            print(f"VARNING: buzz-taket kunde inte kontrolleras, host:next tog {edge['throttleGapMs']} ms (gräns 150)")
        assert 0 < edge["floodPongs"] <= 70, f"Meddelandetaket håller inte (pongs={edge['floodPongs']})"
        assert edge["pongAfter"] == 1 and edge["alive"] == 2, f"Anslutningen återhämtade sig inte efter flod: {edge}"
        assert edge["fastRebuzz"] == ["Snabb"] * 3, f"Legitim snabb buzz ströps: {edge['fastRebuzz']}"
        assert edge["adjusted"] == 40, f"Hostens poängjusteringar ströps: {edge['adjusted']} av 40"
        assert edge["reload"] == "Ladd", f"Buzz försvann vid omladdning mitt i fönstret: {edge['reload']}"
        coll = raw.evaluate(COLLECT_JS, [PIN])
        print("Alla svarar:", coll)
        assert coll["startPhase"] == "collect" and coll["mode"] == "all", f"Insamlingen startade inte: {coll}"
        assert 4900 <= coll["countdown"] <= 5100, f"Servern satte fel nedräkning: {coll['countdown']}"
        assert coll["buzzIgnored"], "Buzz godtogs under insamlingen"
        assert coll["order"] == ["Fel-svar-B", "Ratt-svar-A"] and coll["timesIncreasing"], f"Fel ordning/låsning: {coll['order']}"
        assert coll["errorsA"] == ["Du har redan låst ditt svar"] and coll["errorsB"] == ["Skriv ett svar först"], f"Fel felmeddelanden: {coll}"
        assert coll["publicAnswered"] == 2, "Publikt state visar inte vilka som svarat"
        assert coll["lateRejected"], "Svar efter deadline godtogs eller insamlingen stängdes inte"
        assert coll["leakBeforeReveal"] == 0, f"Svar eller facit läckte i publikt state före reveal ({coll['leakBeforeReveal']} meddelanden)"
        assert coll["scores"] == {"A": 3, "B": 0, "C": 0, "D": 0}, f"Fel poäng (2 p + 1 bonus till A, inget straff): {coll['scores']}"
        assert coll["results"] == [["Fel-svar-B", False, False, 0], ["Ratt-svar-A", True, True, 3]], f"Fel resultat: {coll['results']}"
        assert coll["revealed"] == "FACIT-XYZ" and coll["afterJudge"] == 0, f"Fel efter rättning: {coll}"
        assert coll["buzzMode"] == "buzz" and coll["buzzCollect"] is None and coll["buzzWinner"], f"Buzz-fråga efter Alla svarar trasig: {coll}"
        assert coll["unknownMode"] == "question", f"Okänd mode ska bli buzz: {coll['unknownMode']}"
        raw.close()

        b.close()
        print("E2E OK. Slutpoäng:", res)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("E2E MISSLYCKADES:", e)
        sys.exit(1)
