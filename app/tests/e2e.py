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
      // Olika anslutningar har ingen inbördes ordning på servern: vänta på en pong på Flods anslutning
      // så att hela floden är behandlad innan host:next, annars kan en flod-buzz med token kvar landa i nya frågan.
      await new Promise((resolve) => {
        const c = -100 - q;
        const h = (ev) => { const m = JSON.parse(ev.data); if (m.t === 'pong' && m.c === c) { flod.ws.removeEventListener('message', h); resolve(); } };
        flod.ws.addEventListener('message', h); send(flod, { t: 'ping', c });
      });
      send(r.host, { t: 'host:next' }); await until(flod, (st) => st?.phase === 'question' && st.qIndex === q);
      send(flod, { t: 'buzz', at: Date.now() });
      out.throttleGapMs = Math.round(performance.now() - t0);
      await sleep(250);
      send(r.ps.Vanlig, { t: 'buzz', at: Date.now() });
      out.throttled = await winner(r.host);
      if (out.throttleGapMs < 150) break;
    }
    await sleep(2500);
    pongs = 0;
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

# Svarsalternativ och "för långsam" på protokollnivå.
CHOICE_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Alt', settings: { collectSeconds: 10, answerSeconds: 3 }, questions: [
      { id: 'c1', text: 'Välj', answer: 'B1', mode: 'choice', choices: ['A1', 'B1', 'C1'] },
      { id: 'c2', text: 'Muntlig', answer: 'Hemligt' } ] }) });
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
  for (const n of ['A', 'B']) { ps[n] = await connect('player'); send(ps[n], { t: 'join', name: n }); }
  await sleep(300);
  const out = {};
  send(host, { t: 'host:start' });
  const st = await until(tv, (s) => s?.phase === 'collect');
  out.mode = st.question.mode; out.choices = st.question.choices;
  send(ps.A, { t: 'answer', text: 'Påhittat' }); await sleep(150);
  out.invalidRejected = ps.A.errors.slice();
  send(ps.B, { t: 'answer', text: 'B1' }); await sleep(80);
  send(ps.A, { t: 'answer', text: 'C1' });
  await until(host, (s) => s?.phase === 'judge');
  const name = (id) => host.state.players.find((p) => p.id === id).name;
  out.autoMarked = host.state.collectHost.correct.map(name);
  out.leak = tv.raw.filter((r) => /"revealedAnswer"|"results"|"collectHost"|"answer":/.test(r)).length;
  // Hosten ändrar: A:s val räknas också som rätt
  send(host, { t: 'host:mark', playerId: ps.A.id, correct: true });
  await sleep(100);
  send(host, { t: 'host:judge' });
  await until(tv, (s) => s?.phase === 'reveal');
  out.scores = Object.fromEntries(tv.state.players.map((p) => [p.name, p.score]));
  // Muntlig buzz: ingen automatisk timeout, hosten säger "för långsam"
  send(host, { t: 'host:next' });
  await until(tv, (s) => s?.phase === 'question');
  send(ps.A, { t: 'buzz' });
  await until(tv, (s) => s?.phase === 'buzzed');
  await sleep(3600);
  out.noAutoTimeout = tv.state.phase;
  const before = tv.state.players.find((p) => p.name === 'A').score;
  send(host, { t: 'host:slow' });
  const after = await until(tv, (s) => s?.lastEvent?.kind === 'timeout');
  out.slow = { kind: after.lastEvent.kind, delta: after.players.find((p) => p.name === 'A').score - before, locked: after.lockedOut.includes(ps.A.id) };
  for (const c of [host, tv, ps.A, ps.B]) c.ws.close();
  return out;
}
"""

# Lag, mynt och butik på protokollnivå. Unika namn per körning, eftersom plånböckerna sparas i Hub.
TEAMS_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tag = Math.random().toString(36).slice(2, 6);
  const N = (n) => n + tag;
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Lag', settings: { answerSeconds: 10, penalty: 1, collectSeconds: 20 }, questions: [
      { id: 'q1', text: 'Ett', answer: '1' }, { id: 'q2', text: 'Två', answer: '2' },
      { id: 'q3', text: 'Tre', answer: '3', mode: 'all' }, { id: 'q4', text: 'Fyra', answer: '4' } ] }) });
  const { code, hostKey } = await res.json();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
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
    const t = setTimeout(() => reject(new Error('timeout i väntan på state: ' + JSON.stringify(c.state?.phase))), ms);
    c.waiters.push(() => pred(c.state) ? (clearTimeout(t), resolve(c.state), true) : false);
  });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const host = await connect('host', hostKey);
  const ps = {};
  for (const n of ['A', 'B', 'C', 'D']) { ps[n] = await connect('player'); send(ps[n], { t: 'join', name: N(n) }); }
  await until(host, (s) => s && Object.keys(s.wallets).length === 4);
  const st = () => host.state;
  const id = (n) => ps[n].id;
  const w = (n) => st().wallets[id(n)];
  const teamOf = (n) => st().teams.find((t) => t.members.includes(id(n)));
  const mate = (n) => teamOf(n).members.find((x) => x !== id(n));
  const out = {};
  out.welcome = ['A', 'B', 'C', 'D'].map((n) => w(n).coins);

  send(host, { t: 'host:teams', mode: 3 });
  await until(host, (s) => s.teams.length > 0);
  out.split3 = st().teams.map((t) => t.members.length).sort();
  send(host, { t: 'host:teams', mode: 2 });
  await until(host, (s) => s.teamMode === 2);
  out.split2 = st().teams.map((t) => t.members.length).sort();

  // Butiken
  send(ps.A, { t: 'buy', item: 'extra' });
  await until(host, (s) => s.wallets[id('A')].coins === 4);
  send(ps.A, { t: 'buy', item: 'extra' }); await sleep(150);   // laget har redan
  send(ps.A, { t: 'buy', item: 'pass' });
  await until(host, (s) => s.wallets[id('A')].items.pass === 1);
  send(ps.A, { t: 'buy', item: 'double' }); await sleep(150);  // 1 mynt kvar: för dyrt
  out.errorsA = ps.A.errors.slice();
  // Veto: D slumpar om och hamnar inte med samma lagkamrat
  const oldMate = mate('D');
  send(ps.D, { t: 'buy', item: 'veto' });
  await until(host, (s) => s.wallets[id('D')].coins === 5);
  out.vetoNewMate = mate('D') !== oldMate;
  // B köper och aktiverar Dubbla poäng för fråga 1; C köper Sabotage
  send(ps.B, { t: 'buy', item: 'double' });
  await until(host, (s) => s.wallets[id('B')].items.double === 1);
  send(ps.B, { t: 'use', item: 'double' });
  await until(host, (s) => s.effects.double.length === 1);
  out.doubleUnit = st().effects.double[0] === teamOf('B').id;
  send(ps.C, { t: 'buy', item: 'sabotage' });
  await until(host, (s) => s.wallets[id('C')].items.sabotage === 1);
  const pub = await (await fetch('/api/hub/public')).json();
  out.hubWallet = pub.wallets.find((x) => x.name === N('A'))?.coins;

  // Fråga 1: B:s lagkamrat svarar rätt med dubbla poäng
  const bm = Object.keys(ps).find((n) => id(n) === mate('B'));
  send(host, { t: 'host:start' });
  await until(host, (s) => s.phase === 'question');
  send(ps[bm], { t: 'buzz' });
  await until(host, (s) => s.phase === 'buzzed');
  send(host, { t: 'host:correct' });
  await until(host, (s) => s.phase === 'reveal');
  out.doubleScore = st().players.find((p) => p.id === id(bm)).score;
  out.coinCorrect = st().coinsTonight[id(bm)];

  // Mellan frågorna: C saboterar A:s lag inför fråga 2. A har Extra tid: (10 + 5) / 2 = 7,5 s.
  send(ps.C, { t: 'use', item: 'sabotage', target: teamOf('C').id }); await sleep(150);  // eget lag: nej
  out.errorsC = ps.C.errors.slice();
  const aTeam = teamOf('A').id;
  if (aTeam !== teamOf('C').id) {
    send(ps.C, { t: 'use', item: 'sabotage', target: aTeam });
    await until(host, (s) => s.effects.sabotage.includes(aTeam));
  }
  out.sameTeamAC = aTeam === teamOf('C').id;
  send(host, { t: 'host:next' });
  await until(host, (s) => s.phase === 'question' && s.qIndex === 1);
  send(ps.A, { t: 'buzz' });
  const b2 = await until(host, (s) => s.phase === 'buzzed');
  out.buzzMs = b2.buzz.deadline - b2.lastEvent.at;
  const scoreA = b2.players.find((p) => p.id === id('A')).score;
  send(ps.A, { t: 'pass' });
  const p2 = await until(host, (s) => s.lastEvent?.kind === 'pass');
  out.pass = { delta: p2.players.find((p) => p.id === id('A')).score - scoreA, locked: p2.lockedOut.includes(id('A')), left: p2.wallets[id('A')].items.pass };

  // Fråga 3 (Alla svarar): A:s lag har +5 s egen deadline, sabotaget gällde bara fråga 2
  send(host, { t: 'host:next' });
  const c3 = await until(host, (s) => s.phase === 'collect');
  out.extraCollect = c3.collect.extra?.[id('A')] ?? 0;
  out.extraOther = c3.collect.extra?.[id('C')] ?? 0;
  send(host, { t: 'host:finish' });
  await until(host, (s) => s.phase === 'finished');

  // Kröning: lagets snitt som resultat, mynt betalas ut en gång
  const before = Object.fromEntries((await (await fetch('/api/hub/public')).json()).wallets.map((x) => [x.name, x.coins]));
  const entry = await (await fetch(`/api/rooms/${code}/crown`, { method: 'POST', headers: { 'x-host-pin': pin } })).json();
  await fetch(`/api/rooms/${code}/crown`, { method: 'POST', headers: { 'x-host-pin': pin } }); // dubbelklick
  const after = Object.fromEntries((await (await fetch('/api/hub/public')).json()).wallets.map((x) => [x.name, x.coins]));
  out.results = entry.results.map((r) => [r.name.replace(tag, ''), r.score, !!r.team]);
  out.paid = Object.fromEntries(Object.keys(entry.coins).map((n) => [n.replace(tag, ''), after[n] - before[n] === entry.coins[n]]));
  out.winnerBonus = entry.coins[N(bm)];
  for (const c of [host, ...Object.values(ps)]) c.ws.close();
  return out;
}
"""

# Skill-rundor på protokollnivå: frö, validering, rankning och att ordningen inte läcker.
SKILL_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Skill', questions: [
      { id: 'k1', text: 'Flick', answer: '', mode: 'skill', skill: { kind: 'aim' } },
      { id: 'k2', text: 'Ordna', answer: '', mode: 'skill', skill: { kind: 'order', items: [{ label: 'Z', value: 3 }, { label: 'X', value: 1 }, { label: 'Y', value: 2 }] } },
      { id: 'k3', text: 'Trasig', answer: '', mode: 'skill', skill: { kind: 'order', items: [{ label: 'A', value: 1 }] } } ] }) });
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
  const out = {};
  const name = (st, id) => st.players.find((p) => p.id === id).name;
  send(host, { t: 'host:start' });
  await until(ps.A, (s) => s?.phase === 'collect');
  await until(ps.D, (s) => s?.phase === 'collect');
  out.mode = ps.A.state.question.mode;
  out.seedSame = typeof ps.A.state.collect.seed === 'number' && ps.A.state.collect.seed === ps.D.state.collect.seed;
  send(ps.A, { t: 'skill', value: 5, ok: true });          // för snabbt för tio mål
  send(ps.A, { t: 'skill', value: 'snabb', ok: true });
  await sleep(150);
  out.badRejected = ps.A.errors.slice();
  send(ps.A, { t: 'skill', value: 4000, ok: true });
  send(ps.B, { t: 'skill', value: 5200, ok: true });
  send(ps.C, { t: 'skill', value: 4000, ok: true });       // delad förstaplats
  send(ps.D, { t: 'skill', value: 120000, ok: false });
  await until(host, (s) => s?.phase === 'judge');
  send(host, { t: 'host:judge' });
  const r1 = await until(tv, (s) => s?.phase === 'reveal');
  out.places = r1.collect.results.map((r) => [name(r1, r.playerId), r.place, r.delta]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  out.places = [...out.places.filter((x) => x[1] > 0), ...out.places.filter((x) => x[1] === 0)];
  send(host, { t: 'host:next' });
  await until(tv, (s) => s?.phase === 'collect' && s.qIndex === 1);
  out.itemsHidden = tv.raw.filter((r) => r.includes('"Ordna"')).every((r) => !/"value":/.test(r));
  send(ps.A, { t: 'skill', order: ['X', 'Z', 'Y'] });
  send(ps.B, { t: 'skill', order: ['X', 'Y', 'Z'] });
  await sleep(200);
  send(host, { t: 'host:judge' });
  const r2 = await until(tv, (s) => s?.phase === 'reveal');
  out.order = r2.collect.results.map((r) => [name(r2, r.playerId), r.place, r.delta]);
  out.orderReveal = r2.question.skill.items.map((i) => i.label);
  send(host, { t: 'host:next' });
  const r3 = await until(tv, (s) => s?.qIndex === 2);
  out.badSpec = r3.question.mode;
  for (const c of [host, tv, ...Object.values(ps)]) c.ws.close();
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
      { id: 'a3', text: 'Bluff-mode', answer: 'X', mode: 'nonsens' },
      { id: 'a4', text: 'Hjul och alla svarar', answer: 'Y', mode: 'all' } ] }) });
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
  // Lyckohjulet före en Alla svarar-fråga: bara Dubbla poäng eller Nit, och Dubbla poäng dubblar frågans poäng.
  send(host, { t: 'host:reveal' }); await until(host, (st) => st?.phase === 'reveal');
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const before = host.state.wheel?.spinId ?? 0;
    send(host, { t: 'host:spin' });
    const w = (await until(host, (st) => (st?.wheel?.spinId ?? 0) > before)).wheel;
    seen.add(w.result);
    if (seen.size >= 2 && w.result === 'double') break;
  }
  out.wheelBeforeAll = [...seen].sort();
  const a0 = score(host.state, 'A');
  send(host, { t: 'host:next' });
  await until(host, (st) => st?.phase === 'collect' && st.qIndex === 3);
  send(ps.A, { t: 'answer', text: 'Y' });
  await until(host, (st) => st?.collectHost?.answers.length === 1);
  send(host, { t: 'host:close' }); await until(host, (st) => st?.phase === 'judge');
  send(host, { t: 'host:mark', playerId: id('A'), correct: true });
  await until(host, (st) => st?.collectHost?.correct.length === 1);
  send(host, { t: 'host:judge' });
  out.doubleAll = score(await until(host, (st) => st?.phase === 'reveal'), 'A') - a0;
  for (const c of [host, tv, ...Object.values(ps)]) c.ws.close();
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
        host.get_by_label("Straff vid fel eller för långsam (poäng)").fill("1")
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
        expect(p2.get_by_text("Erik har ordet")).to_be_visible()
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
        expect(p1.get_by_text("Du har ordet")).to_be_visible()
        assert p1.locator("input").count() == 0, "Buzz ska vara muntligt, inget svarsfält i mobilen"
        shot(p1, "09-spelare-nedrakning")
        # Ingen automatisk timeout: efter 3 s har Erik fortfarande ordet tills hosten dömer
        expect(tv.get_by_text("Tiden är ute, hosten avgör")).to_be_visible(timeout=6000)
        expect(p1.get_by_text("Tiden är ute, hosten avgör")).to_be_visible()
        host.wait_for_timeout(500)
        expect(host.get_by_role("button", name="För långsam (T)")).to_be_visible()
        assert tv.locator(".answer-reveal").count() == 0, "Servern dömde timeout själv"
        shot(host, "09b-host-for-langsam")
        shot(tv, "09c-tv-tiden-ute")
        host.get_by_role("button", name="För långsam (T)").click()
        # För långsam => straff, alla utlåsta => svaret visas automatiskt
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
        # Erik: +1 -1 +1 +1 bonus, Tobbe: -1 +1, Sanna: fel kostar inget i Alla svarar.
        # Ingen straffavgift (hjulet) gör fråga 2:s fel och timeout gratis; övriga twistar påverkar inte fel svar.
        expected = {"Erik": 3, "Tobbe": 1, "Sanna": 0} if twist == "safe" else {"Erik": 2, "Tobbe": 0, "Sanna": 0}
        assert res == expected, f"Fel slutpoäng med twisten {twist}: {res}, väntade {expected}"
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

        # Snabbinklistring med svarsalternativ och felkontroll
        host.get_by_role("button", name="Nytt set").click()
        host.get_by_label("Titel").fill("Alt-set")
        host.get_by_text("Klistra in många på en gång").click()
        host.get_by_placeholder("Vilket år kom HoN ut?").fill("Fråga X | Rätt | 1 | alt | Fel 1; Rätt; Fel 2\nFråga Y | Saknas | 1 | alt | A; B")
        host.get_by_role("button", name="Lägg till raderna").click()
        expect(host.get_by_label("Rundtyp 1")).to_have_value("choice")
        expect(host.get_by_label("Alternativ 1")).to_have_value("Fel 1; Rätt; Fel 2")
        host.get_by_role("button", name="Spara set").click()
        expect(host.get_by_text("Fråga 2: Svarsalternativ behöver")).to_be_visible()
        host.get_by_label("Alternativ 2").fill("A; B; Saknas")
        host.get_by_role("button", name="Spara set").click()
        expect(host.get_by_text("2 frågor · 2 Svarsalternativ").first).to_be_visible()

        # Svarsalternativ i mobilen: TV visar alternativen men inte vilket som är rätt, hosten bekräftar
        cdata = host.evaluate("""async ([pin]) => {
          const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Alternativ', settings: { collectSeconds: 20 }, questions: [
              { id: 'c1', text: 'Vilken krydda är dyrast per kilo?', answer: 'Saffran', points: 2, mode: 'choice', choices: ['Kardemumma', 'Saffran', 'Vanilj', 'Svartpeppar'] },
              { id: 'c2', text: 'Trasig alternativfråga', answer: 'Z', mode: 'choice', choices: ['X', 'Y'] } ] }) });
          const r = await res.json(); localStorage.setItem('kronan.host.' + r.code, r.hostKey); return r; }""", [PIN])
        ccode = cdata["code"]
        host.goto(f"{BASE}/host/{ccode}")
        tv.goto(f"{BASE}/tv/{ccode}")
        for page, name in [(p1, "Erik"), (p2, "Tobbe"), (p3, "Sanna")]:
            page.goto(f"{BASE}/play/{ccode}")
            page.get_by_label("Ditt namn").fill(name)
            page.get_by_role("button", name="Hoppa in").click()
            expect(page.get_by_text("Väntar på att hosten startar")).to_be_visible()
        host.get_by_role("button", name="Starta första frågan").click()
        choices = tv.get_by_label("Svarsalternativ").locator("li")
        expect(choices).to_have_count(4)
        expect(tv.get_by_text("Välj i mobilen")).to_be_visible()
        assert tv.locator(".choice-tile.right").count() == 0, "TV:n markerar rätt alternativ före reveal!"
        for pg in (p1, p2, p3):
            expect(pg.get_by_role("group", name="Välj svar").get_by_role("button")).to_have_count(4)
            assert pg.get_by_role("button", name="Buzza").count() == 0, "Buzzern visas vid svarsalternativ"
        shot(tv, "20-tv-alternativ")
        shot(p1, "21-spelare-alternativ")
        p2.get_by_role("button", name="Vanilj").click()
        expect(p2.get_by_text("Ditt val är låst")).to_be_visible()
        p1.get_by_role("button", name="Saffran").click()
        expect(p1.get_by_text("Ditt val är låst")).to_be_visible()
        p3.wait_for_timeout(300)
        p3.get_by_role("button", name="Saffran").click()
        expect(tv.get_by_text("Hosten rättar")).to_be_visible()
        assert tv.locator(".choice-tile.right").count() == 0, "TV:n markerar rätt alternativ under rättningen!"
        expect(host.get_by_label("Erik svarade rätt")).to_be_checked()
        expect(host.get_by_label("Sanna svarade rätt")).to_be_checked()
        expect(host.get_by_label("Tobbe svarade rätt")).not_to_be_checked()
        shot(host, "22-host-alternativ")
        host.get_by_role("button", name="Bekräfta och visa svaren").click()
        expect(tv.locator(".choice-tile.right")).to_contain_text("Saffran")
        expect(tv.locator(".choice-tile.right .picks")).to_have_text("2")
        expect(p1.get_by_text("Rätt! +3 p")).to_be_visible()
        expect(p3.get_by_text("Rätt! +2 p")).to_be_visible()
        expect(p2.get_by_text("Fel den här gången")).to_be_visible()
        tv.wait_for_timeout(600)
        shot(tv, "23-tv-alternativ-facit")
        # Ogiltiga alternativ (svaret saknas) blir en vanlig muntlig buzz-fråga
        host.get_by_role("button", name="Nästa fråga (N)").click()
        expect(p1.get_by_role("button", name="Buzza")).to_be_enabled()
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"

        # Skill-utmaningar: Erik spelar alla fem på riktigt, Tobbe laddar om mitt i och blir diskad
        sdata = host.evaluate("""async ([pin]) => {
          const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Skill', questions: [
              { id: 'k1', text: 'Last hit!', answer: '', mode: 'skill', skill: { kind: 'lasthit' } },
              { id: 'k2', text: 'Flick!', answer: '', mode: 'skill', skill: { kind: 'aim' } },
              { id: 'k3', text: 'Stoppa klockan!', answer: '', mode: 'skill', skill: { kind: 'stopwatch', target: 3 } },
              { id: 'k4', text: 'Häll upp!', answer: '', mode: 'skill', skill: { kind: 'pour' } },
              { id: 'k5', text: 'Ordna serierna', answer: '', mode: 'skill', skill: { kind: 'order', prompt: 'Äldst först', items: [
                { label: 'Game of Thrones', value: 2011 }, { label: 'How I Met Your Mother', value: 2005 }, { label: 'Breaking Bad', value: 2008 } ] } } ] }) });
          const r = await res.json(); localStorage.setItem('kronan.host.' + r.code, r.hostKey); return r; }""", [PIN])
        scode = sdata["code"]
        host.goto(f"{BASE}/host/{scode}")
        tv.goto(f"{BASE}/tv/{scode}")
        for page, name in [(p1, "Erik"), (p2, "Tobbe")]:
            page.goto(f"{BASE}/play/{scode}")
            page.get_by_label("Ditt namn").fill(name)
            page.get_by_role("button", name="Hoppa in").click()
            expect(page.get_by_text("Väntar på att hosten startar")).to_be_visible()

        def finish_round(shot_name):
            if host.get_by_role("button", name="Stäng utmaningen").count():
                host.get_by_role("button", name="Stäng utmaningen").click()
            host.get_by_role("button", name="Bekräfta och visa resultaten").click()
            expect(tv.get_by_label("Allas svar")).to_be_visible()
            tv.wait_for_timeout(700)
            shot(tv, shot_name)

        # 1. Last hit
        host.get_by_role("button", name="Starta första frågan").click()
        expect(tv.get_by_text("Spela i mobilen")).to_be_visible()
        expect(tv.locator(".mode-tag")).to_have_text("Last hit")
        shot(tv, "30-tv-skill")
        shot(p1, "31-spelare-skill-intro")
        p2.get_by_role("button", name="Starta").click()
        expect(p2.get_by_role("button", name="Last hit")).to_be_visible()
        p2.reload()  # försöket är förbrukat
        expect(host.get_by_label("Skill-resultat").locator("li", has_text="Tobbe")).to_contain_text("Diskad")
        p1.get_by_role("button", name="Starta").click()
        expect(p1.get_by_role("button", name="Last hit")).to_be_visible()
        shot(p1, "32-spelare-lasthit")
        # Tryck inifrån sidan i samma bildruta som creepen hamnar under strecket (CI-maskinen är för seg för rundresor).
        p1.evaluate("""async () => {
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            for (;;) {
              const e = document.querySelector('.lasthit');
              if (e && e.dataset.running === '1' && +e.dataset.hp > 0 && +e.dataset.hp <= +e.dataset.dmg) break;
              if (performance.now() - t0 > 20000) throw new Error('creepen kom aldrig under strecket');
              await frame();
            }
            document.querySelector('[aria-label="Last hit"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 1100));
          }
        }""")
        expect(p1.get_by_text("Klart!")).to_be_visible(timeout=5000)
        expect(p1.locator(".locked-text")).to_contain_text("last hits")
        finish_round("33-tv-lasthit-resultat")
        res_rows = tv.get_by_label("Allas svar").locator("li")
        expect(res_rows.nth(0)).to_contain_text("Erik")
        expect(res_rows.nth(0)).to_contain_text("1:a +3")
        expect(res_rows.nth(1)).to_contain_text("Diskad")
        expect(p1.get_by_text("1:a plats +3 p")).to_be_visible()

        # 2. Flick
        host.get_by_role("button", name="Nästa fråga (N)").click()
        p1.get_by_role("button", name="Starta").click()
        for i in range(10):
            p1.wait_for_function(f"() => document.querySelector('.aim-field')?.dataset.target === '{i}'", timeout=5000)
            if i == 3: shot(p1, "34-spelare-flick")
            p1.get_by_role("button", name="Mål").dispatch_event("pointerdown")
        expect(p1.get_by_text("Klart!")).to_be_visible()
        finish_round("35-tv-flick-resultat")

        # 3. Stoppa klockan (mål 3 s, klockan blir svart efter 3 s)
        host.get_by_role("button", name="Nästa fråga (N)").click()
        p1.get_by_role("button", name="Starta").click()
        p1.wait_for_timeout(1500)
        shot(p1, "36-spelare-stoppa-klockan")
        p1.wait_for_timeout(1350)
        p1.get_by_role("button", name="Stopp").dispatch_event("pointerdown")
        expect(p1.locator(".locked-text")).to_contain_text(" s")
        sw = p1.locator(".locked-text").inner_text()
        assert sw.startswith(("+", "−")), f"Stoppa klockan visar fel: {sw}"
        finish_round("37-tv-klockan-resultat")

        # 4. Häll upp
        host.get_by_role("button", name="Nästa fråga (N)").click()
        p1.get_by_role("button", name="Starta").click()
        expect(p1.get_by_role("button", name="Häll")).to_be_visible()
        p1.evaluate("""async () => {
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          const btn = document.querySelector('[aria-label="Häll"]');
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          const t0 = performance.now();
          for (;;) {
            const e = document.querySelector('[data-level]');
            if (+e.dataset.level >= +e.dataset.target - 8) break;
            if (performance.now() - t0 > 15000) throw new Error('glaset fylldes aldrig');
            await frame();
          }
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }""")
        shot(p1, "38-spelare-hall-upp")
        expect(p1.get_by_text("Klart!")).to_be_visible(timeout=5000)
        assert "Spillde" not in p1.locator(".locked-text").inner_text(), "Häll upp spillde trots släpp under strecket"
        finish_round("39-tv-hall-resultat")

        # 5. Ordna rätt: TV och mobil visar sakerna men inte årtalen före reveal
        host.get_by_role("button", name="Nästa fråga (N)").click()
        for yr in ("2005", "2008", "2011"):
            assert yr not in tv.inner_text("body") and yr not in p1.inner_text("body"), f"Årtalet {yr} läckte före reveal"
        p1.get_by_role("button", name="Starta").click()
        for label in ("How I Met Your Mother", "Breaking Bad", "Game of Thrones"):
            p1.get_by_role("button", name=label).click()
        shot(p1, "40-spelare-ordna")
        p1.get_by_role("button", name="Lås ordning").click()
        p2.get_by_role("button", name="Starta").click()
        for label in ("Breaking Bad", "How I Met Your Mother", "Game of Thrones"):
            p2.get_by_role("button", name=label).click()
        p2.get_by_role("button", name="Lås ordning").click()
        expect(tv.get_by_text("Hosten kollar resultaten")).to_be_visible()
        host.get_by_role("button", name="Bekräfta och visa resultaten").click()
        expect(tv.get_by_label("Rätt ordning").locator("li").first).to_contain_text("How I Met Your Mother")
        expect(tv.get_by_label("Allas svar").locator("li").nth(0)).to_contain_text("Helt rätt")
        expect(tv.get_by_label("Allas svar").locator("li").nth(1)).to_contain_text("2 av 3 par rätt")
        tv.wait_for_timeout(700)
        shot(tv, "41-tv-ordna-facit")
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"

        # Lag och butik i webbläsaren: hosten slumpar lag, spelarna ser sitt lag och handlar
        tdata = host.evaluate("""async ([pin]) => {
          const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Lagkväll', questions: [ { id: 'l1', text: 'Vad heter Kongors studio?', answer: 'Kongor Studios' } ] }) });
          const r = await res.json(); localStorage.setItem('kronan.host.' + r.code, r.hostKey); return r; }""", [PIN])
        tcode = tdata["code"]
        tag = tcode.lower()
        host.goto(f"{BASE}/host/{tcode}")
        tv.goto(f"{BASE}/tv/{tcode}")
        for page, name in [(p1, "Erik"), (p2, "Tobbe"), (p3, "Sanna")]:
            page.goto(f"{BASE}/play/{tcode}")
            page.get_by_label("Ditt namn").fill(name + tag)
            page.get_by_role("button", name="Hoppa in").click()
            expect(page.get_by_label("Butik")).to_be_visible()
        expect(p1.get_by_label("Mynt", exact=True)).to_contain_text("10")
        host.get_by_label("Lagläge").select_option("2")
        host.get_by_role("button", name="Slumpa lag").click()
        expect(tv.get_by_label("Lagställning").locator("li")).to_have_count(2)  # 3 spelare → 2+1
        expect(p1.get_by_text("Du är i")).to_be_visible()
        shot(host, "50-host-lag")
        shot(tv, "51-tv-lag-lobby")
        # Sanna köper Dubbla poäng och aktiverar det för första frågan; Erik köper ett Pass
        p3.get_by_role("button", name="Köp Dubbla poäng för 4 mynt").click()
        expect(p3.get_by_label("Mynt", exact=True)).to_contain_text("6")
        p3.get_by_role("button", name="Dubbla poäng nästa fråga").click()
        expect(tv.locator(".effect-tag.double")).to_be_visible()
        p1.get_by_role("button", name="Köp Pass för 3 mynt").click()
        expect(p1.get_by_text("Pass ×1")).to_be_visible()
        shot(p1, "52-spelare-butik")
        host.get_by_role("button", name="Starta första frågan").click()
        expect(tv.locator(".effect-tag.double")).to_be_visible()
        p1.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(p1.get_by_role("button", name="Använd pass (1 kvar), inget straff")).to_be_visible()
        shot(p1, "53-spelare-pass")
        host.get_by_role("button", name="Rätt (R)").click()
        expect(p1.locator(".coin-toast")).to_contain_text("rätt svar")
        shot(tv, "54-tv-lag-fraga")
        host.get_by_role("button", name="Avsluta och visa pallen (N)").click()
        expect(tv.get_by_role("heading", name="Kvällens kungar")).to_be_visible()
        host.get_by_role("button", name="Kröna vinnaren och spara i tabellen").click()
        expect(host.get_by_text("mynten utbetalda")).to_be_visible()
        tv.wait_for_timeout(600)
        shot(tv, "55-tv-lag-pallen")
        p1.goto(BASE + "/tabell")
        expect(p1.get_by_role("columnheader", name="Mynt")).to_be_visible()
        shot(p1, "56-tabell-mynt")
        assert not page_errors, f"Sidfel hos spelare: {page_errors}"

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
        assert coll["wheelBeforeAll"] == ["double", "none"], f"Hjulet gav twist som inte passar Alla svarar: {coll['wheelBeforeAll']}"
        cp = raw.evaluate(CHOICE_JS, [PIN])
        print("Svarsalternativ:", cp)
        assert cp["mode"] == "choice" and cp["choices"] == ["A1", "B1", "C1"], f"Alternativen kom inte fram: {cp}"
        assert cp["invalidRejected"] == ["Välj ett av alternativen"], f"Svar utanför alternativen godtogs: {cp['invalidRejected']}"
        assert cp["autoMarked"] == ["B"], f"Rätt alternativ förbockades inte: {cp['autoMarked']}"
        assert cp["leak"] == 0, f"Facit eller val läckte före reveal ({cp['leak']} meddelanden)"
        assert cp["scores"] == {"A": 1, "B": 2}, f"Fel poäng efter hostens ändring: {cp['scores']}"
        assert cp["noAutoTimeout"] == "buzzed", f"Servern dömde timeout själv: {cp['noAutoTimeout']}"
        assert cp["slow"] == {"kind": "timeout", "delta": -1, "locked": True}, f"För långsam fungerar inte: {cp['slow']}"
        tm = raw.evaluate(TEAMS_JS, [PIN])
        print("Lag och butik:", tm)
        assert tm["welcome"] == [10, 10, 10, 10], f"Välkomstbonusen blev fel: {tm['welcome']}"
        assert tm["split3"] == [2, 2] and tm["split2"] == [2, 2], f"Fel lagindelning: {tm}"
        assert tm["errorsA"] == ["Ditt lag har redan Extra tid i kväll", "Du har 1 mynt, Dubbla poäng kostar 4"], f"Butiken släppte igenom fel köp: {tm['errorsA']}"
        assert tm["vetoNewMate"], "Veto gav samma lagkamrat igen"
        assert tm["doubleUnit"] and tm["doubleScore"] == 2 and tm["coinCorrect"] == 1, f"Dubbla poäng/mynt fungerar inte: {tm}"
        assert tm["hubWallet"] == 1, f"Plånboken sparades inte i Hub: {tm['hubWallet']}"
        assert tm["errorsC"] == ["Välj ett annat lag att sabotera"], f"Gick att sabotera eget lag: {tm['errorsC']}"
        want_ms = 15000 if tm["sameTeamAC"] else 7500
        assert abs(tm["buzzMs"] - want_ms) < 5, f"Extra tid/Sabotage gav fel svarstid: {tm['buzzMs']} (väntade {want_ms})"
        assert tm["pass"] == {"delta": 0, "locked": True, "left": 0}, f"Pass fungerar inte: {tm['pass']}"
        assert tm["extraCollect"] == 5000 and tm["extraOther"] in (0, 5000), f"Extra tid i insamling fel: {tm}"
        assert all(t for _, _, t in tm["results"]), "Lagnamn saknas i tabellen"
        scores = sorted(r[1] for r in tm["results"])
        assert scores == [0, 0, 1, 1], f"Kvällens resultat ska vara lagets snitt (2/2 = 1 för vinnarlaget): {tm['results']}"
        assert all(tm["paid"].values()), f"Mynten betalades inte ut exakt en gång: {tm['paid']}"
        assert tm["winnerBonus"] == 1 + 3, f"Vinnaren ska få 1 (rätt svar) + 3 (vinst): {tm['winnerBonus']}"
        sk = raw.evaluate(SKILL_JS, [PIN])
        print("Skill:", sk)
        assert sk["mode"] == "skill" and sk["seedSame"], f"Spelarna fick inte samma frö: {sk}"
        assert sk["itemsHidden"], "Ordna rätt skickade värden före reveal"
        assert sk["badRejected"] == ["Ogiltigt resultat", "Ogiltigt resultat"], f"Orimliga resultat godtogs: {sk['badRejected']}"
        assert sk["places"] == [["A", 1, 3], ["C", 1, 3], ["B", 3, 1], ["D", 0, 0]], f"Fel rankning i Flick: {sk['places']}"
        assert sk["order"] == [["B", 1, 3], ["A", 2, 2]], f"Fel rankning i Ordna rätt: {sk['order']}"
        assert sk["orderReveal"] == ["X", "Y", "Z"], f"Rätt ordning visades inte vid reveal: {sk['orderReveal']}"
        assert sk["badSpec"] == "buzz", f"Ogiltig skill-spec ska bli buzz: {sk['badSpec']}"
        assert coll["doubleAll"] == 3, f"Dubbla poäng i Alla svarar ska ge 2×1 + 1 bonus: {coll['doubleAll']}"

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
