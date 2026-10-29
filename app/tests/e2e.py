"""
End-to-end-test av Kronan: host + TV + spelare i webbläsare, plus protokolltester mot servern.
Kör mot en lokal server:  npx wrangler dev --port 8787  (med HOST_PIN=1234 i .dev.vars)
    python3 tests/e2e.py [bas-url] [skärmdumpsmapp]
Avslutar med kod 1 om något steg misslyckas. Används av Testaren i AI-rådet.

Sedan 2026-10-29 är alla frågor svarsalternativ (eller skill-utmaningar). Värden kan spela själv,
och då skickas aldrig facit till hostkontrollen; det kontrolleras här.
"""
import sys, os, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "e2e-shots"
PIN = os.environ.get("HOST_PIN", "1234")
os.makedirs(SHOTS, exist_ok=True)

# Gemensamt för protokolltesterna: skapa rum, ansluta websocket-klienter och vänta på state.
LIB = """
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Rummen i testerna spelar "alla samtidigt" utan buzzer om testet inte säger annat.
  const mkRoom = async (body) => {
    body = { ...body, settings: { playMode: 'all', buzzEvery: 0, ...(body.settings ?? {}) } };
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  const connect = (code, role, key) => new Promise((resolve) => {
    const q = new URLSearchParams({ role, ...(key ? { key } : {}) });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
    const c = { ws, state: null, id: null, waiters: [], raw: [], errors: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'joined') c.id = m.playerId;
      if (m.t === 'error') c.errors.push(m.message);
      if (m.t === 'state') { c.raw.push(ev.data); c.state = m.state; c.waiters = c.waiters.filter((w) => !w()); }
    };
    ws.onopen = () => resolve(c);
  });
  const until = (c, pred, ms = 4000) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error('timeout i väntan på state: ' + JSON.stringify(c.state?.phase))), ms);
    c.waiters.push(() => (c.state && pred(c.state)) ? (clearTimeout(t), resolve(c.state), true) : false);
  });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const players = async (code, names) => {
    const ps = {};
    for (const n of names) { ps[n] = await connect(code, 'player'); send(ps[n], { t: 'join', name: n }); }
    for (const n of names) await until(ps[n], () => !!ps[n].id);
    return ps;
  };
  const score = (st, id) => st.players.find((p) => p.id === id).score;
  const closeAll = (...cs) => cs.forEach((c) => c.ws.close());
"""


def js(body):
    return "async ([pin]) => {" + LIB + body + "\n}"


POOL = "['R', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']"

# Svarsalternativ: urval, antal, rättning, poäng, spelbara frågor och att facit inte läcker.
CHOICE_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const room = await mkRoom({ title: 'Alt', settings: { choiceCount: 4, collectSeconds: 10, hostPlays: false }, questions: [
    { id: 'c1', text: 'Ett', answer: 'R', choices: """ + POOL + """ },
    { id: 'c2', text: 'Två', answer: 'R', choices: """ + POOL + """ },
    { id: 'c3', text: 'Tre', answer: 'R', choices: ['R', 'F1', 'F2'] },
    { id: 'x1', text: 'Gammal muntlig fråga utan alternativ', answer: 'Hemligt' } ] });
  const out = { skipped: room.skipped };
  const host = await connect(room.code, 'host', room.hostKey);
  const tv = await connect(room.code, 'tv');
  const ps = await players(room.code, ['A' + tag, 'B' + tag]);
  const [A, B] = Object.values(ps);
  await until(tv, (s) => s.players.length === 2);
  out.qCount = tv.state.qCount;
  send(host, { t: 'host:start' });
  const s1 = await until(tv, (s) => s.phase === 'collect');
  out.shown1 = s1.question.choices.length;
  out.hasAnswer = s1.question.choices.includes('R') && new Set(s1.question.choices).size === s1.question.choices.length;
  out.hostSeesAnswer = host.state.answer;
  send(host, { t: 'host:next' }); await sleep(150);
  out.nextBlocked = host.errors.slice();
  send(host, { t: 'host:settings', settings: { choiceCount: 6 } }); await sleep(150);
  out.shownAfterChange = tv.state.question.choices.length;
  send(A, { t: 'answer', text: 'Påhittat' }); await sleep(150);
  out.invalid = A.errors.slice();
  const wrong = s1.question.choices.find((x) => x !== 'R');
  send(B, { t: 'answer', text: wrong }); await sleep(60);
  send(A, { t: 'answer', text: 'R' });
  await until(tv, (s) => s.phase === 'judge');
  send(A, { t: 'answer', text: wrong }); await sleep(150);
  out.lateOrTwice = A.errors.slice(1);
  out.leak = tv.raw.filter((r) => /"revealedAnswer"|"results"|"collectHost"|"answer":/.test(r)).length;
  out.autoMarked = host.state.collectHost.correct.length === 1 && host.state.collectHost.correct[0] === A.id;
  send(host, { t: 'host:judge' });
  const r1 = await until(tv, (s) => s.phase === 'reveal');
  out.revealed = r1.revealedAnswer;
  out.scores = [score(r1, A.id), score(r1, B.id)];
  send(host, { t: 'host:next' });
  const s2 = await until(tv, (s) => s.phase === 'collect' && s.qIndex === 1);
  out.shown2 = s2.question.choices.length;
  send(host, { t: 'host:judge' });
  await until(tv, (s) => s.phase === 'reveal');
  send(host, { t: 'host:next' });
  const s3 = await until(tv, (s) => s.phase === 'collect' && s.qIndex === 2);
  out.shown3 = s3.question.choices.length;
  const empty = await mkRoom({ title: 'Tomt', questions: [{ id: 'x', text: 'Muntlig', answer: 'Ja' }] });
  out.emptyStatus = empty.status;
  closeAll(host, tv, A, B);
  return out;
""")

# Spelande värd: hostkontrollen får aldrig facit eller andras val, och läget går inte att stänga av under spelet.
HOSTPLAYS_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const room = await mkRoom({ title: 'Värd', settings: { hostPlays: true, collectSeconds: 10 }, questions: [
    { id: 'h1', text: 'Ett', answer: 'HEMLIGT-SVAR', choices: ['HEMLIGT-SVAR', 'Fel A', 'Fel B', 'Fel C'] },
    { id: 'h2', text: 'Två', answer: 'R', choices: ['R', 'F'] } ] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['V' + tag, 'W' + tag]);
  const [V, W] = Object.values(ps);
  const out = {};
  send(host, { t: 'host:start' });
  await until(host, (s) => s.phase === 'collect');
  send(V, { t: 'answer', text: 'Fel A' });
  await until(host, (s) => s.collect.answered.length === 1);
  send(host, { t: 'host:mark', playerId: V.id, correct: true }); await sleep(150);
  send(host, { t: 'host:settings', settings: { hostPlays: false } }); await sleep(150);
  out.errors = host.errors.slice();
  out.stillPlays = host.state.settings.hostPlays;
  const before = host.raw.slice();
  out.leak = before.filter((r) => /"answer":|"collectHost"|"revealedAnswer"|"results"/.test(r)).length;
  out.choicesShown = host.state.question.choices.length;
  send(host, { t: 'host:judge' });
  const r = await until(host, (s) => s.phase === 'reveal');
  out.revealed = r.revealedAnswer;
  out.vScore = score(r, V.id);
  // I lobbyn går läget att stänga av
  const room2 = await mkRoom({ title: 'Lobby', settings: { hostPlays: true }, questions: [{ id: 'l', text: 'L', answer: 'R', choices: ['R', 'F'] }] });
  const host2 = await connect(room2.code, 'host', room2.hostKey);
  await until(host2, () => true);
  send(host2, { t: 'host:settings', settings: { hostPlays: false } });
  await until(host2, (s) => s.settings.hostPlays === false);
  out.lobbyOff = host2.state.settings.hostPlays;
  closeAll(host, host2, V, W);
  return out;
""")

# 50/50: köps i lobbyn, används under frågan och tar bort hälften av felen bara för köparen.
FIFTY_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const room = await mkRoom({ title: '50/50', settings: { choiceCount: 8, collectSeconds: 15 }, questions: [
    { id: 'f1', text: 'Ett', answer: 'R', choices: """ + POOL + """ } ] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['K' + tag, 'L' + tag]);
  const [K, L] = Object.values(ps);
  await until(host, (s) => Object.keys(s.wallets).length === 2);
  const out = {};
  send(K, { t: 'use', item: 'fifty' }); await sleep(150);            // i lobbyn: går inte
  send(K, { t: 'buy', item: 'fifty' });
  await until(K, (s) => s.wallets[K.id].items.fifty === 1);
  send(host, { t: 'host:start' });
  await until(K, (s) => s.phase === 'collect');
  send(K, { t: 'use', item: 'fifty' });
  const k = await until(K, (s) => (s.myRemoved ?? []).length > 0);
  out.removed = k.myRemoved.length;
  out.answerKept = !k.myRemoved.includes('R');
  out.othersSee = (L.state.myRemoved ?? []).length + L.raw.filter((r) => r.includes('"myRemoved"')).length + host.raw.filter((r) => r.includes('"myRemoved"')).length;
  send(K, { t: 'use', item: 'fifty' }); await sleep(150);            // två gånger: nej
  out.errors = K.errors.slice();
  out.left = K.state.wallets[K.id].items.fifty;
  closeAll(host, K, L);
  return out;
""")

# Lyckohjulet med svarsalternativ: snurra tills varje twist kommit upp och kontrollera effekten.
WHEEL_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const q = (i) => ({ id: 'w' + i, text: 'Fråga ' + i, answer: 'R', choices: """ + POOL + """ });
  const room = await mkRoom({ title: 'Hjul', settings: { choiceCount: 8, collectSeconds: 20, fastestBonus: 1 }, questions: [
    q(1), q(2), q(3), q(4), q(5), { id: 'ws', text: 'Skill', answer: '', mode: 'skill', skill: { kind: 'aim' } }] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['A' + tag, 'B' + tag]);
  const [A, B] = Object.values(ps);
  const out = { seen: {} };
  const spin = async () => {
    await sleep(45);  // under serverns rate-limit (30 meddelanden/s), annars slängs snurr tyst
    const prev = host.state.wheel?.spinId ?? 0;
    send(host, { t: 'host:spin' });
    const st = await until(host, (s) => (s.wheel?.spinId ?? 0) > prev);
    out.seen[st.wheel.result] = (out.seen[st.wheel.result] ?? 0) + 1;
    return st.wheel.result;
  };
  const spinFor = async (want) => {
    for (let i = 0; i < 80; i++) if (await spin() === want) return;
    throw new Error('hjulet gav aldrig ' + want);
  };
  const next = async () => { const i = host.state.qIndex; send(host, { t: 'host:next' }); return until(host, (s) => s.phase === 'collect' && s.qIndex === i + 1); };
  const answer = async (c, text) => { send(c, { t: 'answer', text }); await until(host, (s) => s.collect.answered.includes(c.id)); };
  const judge = async () => { send(host, { t: 'host:judge' }); return until(host, (s) => s.phase === 'reveal'); };
  // Spelare kan inte snurra
  send(A, { t: 'host:spin' }); await sleep(150);
  out.playerSpin = A.errors.slice();
  // Dubbla poäng: rätt 1 p + bonus 1, dubblat
  await spinFor('double');
  let st = await next();
  await answer(A, 'R');
  st = await judge();
  out.double = score(st, A.id);
  // 50/50 för alla: 8 alternativ blir rätt + hälften av 7 fel = 5
  await spinFor('fifty');
  st = await next();
  out.fifty = st.question.choices.length;
  await judge();
  // Blixt: halverad svarstid
  await spinFor('blitz');
  st = await next();
  out.blitzMs = st.collect.deadline - st.collect.startedAt;
  await judge();
  // Stjäl: B svarar snabbast rätt och tar frågans poäng från ledaren A
  await spinFor('steal');
  st = await next();
  const a0 = score(st, A.id), b0 = score(st, B.id);
  await answer(B, 'R'); await sleep(30);
  await answer(A, 'R');
  st = await judge();
  out.steal = { a: score(st, A.id) - a0, b: score(st, B.id) - b0, stealer: st.lastEvent.stealer === B.id, from: st.lastEvent.stolenFrom === A.id };
  // Nit: inget särskilt, normal tid
  await spinFor('none');
  st = await next();
  out.normalMs = st.collect.deadline - st.collect.startedAt;
  out.noneShown = st.question.choices.length;
  await judge();
  // Före skill-utmaningen: bara Dubbla poäng, Stjäl eller Nit
  const skillTwists = new Set();
  for (let i = 0; i < 30; i++) skillTwists.add(await spin());
  out.skillTwists = [...skillTwists].sort();
  closeAll(host, A, B);
  return out;
""")

# Lag, mynt och butik på protokollnivå. Unika namn per körning, eftersom plånböckerna sparas i Hub.
TEAMS_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const N = (n) => n + tag;
  const q = (i) => ({ id: 'q' + i, text: 'Fråga ' + i, answer: 'R', choices: """ + POOL + """ });
  const room = await mkRoom({ title: 'Lag', settings: { collectSeconds: 20, choiceCount: 8, hostPlays: false }, questions: [q(1), q(2), q(3)] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = {};
  for (const n of ['A', 'B', 'C', 'D']) { ps[n] = await connect(room.code, 'player'); send(ps[n], { t: 'join', name: N(n) }); }
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
  send(ps.A, { t: 'buy', item: 'fifty' });
  await until(host, (s) => s.wallets[id('A')].items.fifty === 1);
  send(ps.A, { t: 'buy', item: 'double' }); await sleep(150);  // 1 mynt kvar: för dyrt
  out.errorsA = ps.A.errors.slice();
  const oldMate = mate('D');
  send(ps.D, { t: 'buy', item: 'veto' });
  await until(host, (s) => s.wallets[id('D')].coins === 5);
  out.vetoNewMate = mate('D') !== oldMate;
  send(ps.B, { t: 'buy', item: 'double' });
  await until(host, (s) => s.wallets[id('B')].items.double === 1);
  send(ps.B, { t: 'use', item: 'double' });
  await until(host, (s) => s.effects.double.length === 1);
  out.doubleUnit = st().effects.double[0] === teamOf('B').id;
  send(ps.C, { t: 'buy', item: 'sabotage' });
  await until(host, (s) => s.wallets[id('C')].items.sabotage === 1);
  const pub = await (await fetch('/api/hub/public')).json();
  out.hubWallet = pub.wallets.find((x) => x.name === N('A'))?.coins;
  // Fråga 1: B:s lagkamrat svarar rätt (1 p + 1 bonus) med dubbla poäng
  const bm = Object.keys(ps).find((n) => id(n) === mate('B'));
  send(host, { t: 'host:start' });
  await until(host, (s) => s.phase === 'collect');
  send(ps[bm], { t: 'answer', text: 'R' });
  await until(host, (s) => s.collect.answered.length === 1);
  send(host, { t: 'host:judge' });
  await until(host, (s) => s.phase === 'reveal');
  out.doubleScore = st().players.find((p) => p.id === id(bm)).score;
  out.coinCorrect = st().coinsTonight[id(bm)];
  // Mellan frågorna: C saboterar A:s lag inför fråga 2. A har Extra tid: (20 + 5) / 2 = 12,5 s, alltså −7,5 s mot grundtiden.
  send(ps.C, { t: 'use', item: 'sabotage', target: teamOf('C').id }); await sleep(150);  // eget lag: nej
  out.errorsC = ps.C.errors.slice();
  const aTeam = teamOf('A').id;
  out.sameTeamAC = aTeam === teamOf('C').id;
  if (!out.sameTeamAC) {
    send(ps.C, { t: 'use', item: 'sabotage', target: aTeam });
    await until(host, (s) => s.effects.sabotage.includes(aTeam));
  }
  send(host, { t: 'host:next' });
  const c2 = await until(host, (s) => s.phase === 'collect' && s.qIndex === 1);
  out.extraQ2 = c2.collect.extra?.[id('A')] ?? 0;
  // A använder 50/50 och svarar fel
  send(ps.A, { t: 'use', item: 'fifty' });
  const a2 = await until(ps.A, (s) => (s.myRemoved ?? []).length > 0);
  const wrongLeft = a2.question.choices.find((x) => x !== 'R' && !a2.myRemoved.includes(x));
  send(ps.A, { t: 'answer', text: wrongLeft });
  await until(host, (s) => s.collect.answered.includes(id('A')));
  send(host, { t: 'host:judge' });
  await until(host, (s) => s.phase === 'reveal');
  out.fiftyLeft = st().wallets[id('A')].items.fifty;
  // Fråga 3: A:s lag har +5 s egen deadline, sabotaget gällde bara fråga 2
  send(host, { t: 'host:next' });
  const c3 = await until(host, (s) => s.phase === 'collect' && s.qIndex === 2);
  out.extraCollect = c3.collect.extra?.[id('A')] ?? 0;
  out.extraOther = c3.collect.extra?.[id('C')] ?? 0;
  send(host, { t: 'host:finish' });
  await until(host, (s) => s.phase === 'finished');
  // Kröning: lagets snitt som resultat, mynt betalas ut en gång
  const before = Object.fromEntries((await (await fetch('/api/hub/public')).json()).wallets.map((x) => [x.name, x.coins]));
  const entry = await (await fetch(`/api/rooms/${room.code}/crown`, { method: 'POST', headers: { 'x-host-pin': pin } })).json();
  await fetch(`/api/rooms/${room.code}/crown`, { method: 'POST', headers: { 'x-host-pin': pin } }); // dubbelklick
  const after = Object.fromEntries((await (await fetch('/api/hub/public')).json()).wallets.map((x) => [x.name, x.coins]));
  out.results = entry.results.map((r) => [r.name.replace(tag, ''), r.score, !!r.team]);
  out.paid = Object.fromEntries(Object.keys(entry.coins).map((n) => [n.replace(tag, ''), after[n] - before[n] === entry.coins[n]]));
  out.winnerBonus = entry.coins[N(bm)];
  closeAll(host, ...Object.values(ps));
  return out;
""")

# Lagens tur och buzzer: bara laget med turen svarar, fel buzz kostar poäng och låser ute, timeout = fel.
MODES_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const q = (i) => ({ id: 'm' + i, text: 'Fråga ' + i, answer: 'R', choices: ['R', 'F1', 'F2', 'F3'] });
  const room = await mkRoom({ title: 'Tur', settings: { playMode: 'turns', buzzEvery: 3, penalty: 1, choiceCount: 4, buzzAnswerSeconds: 3, collectSeconds: 30 },
    questions: [q(1), q(2), q(3), q(4), q(5), q(6)] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['A' + tag, 'B' + tag, 'C' + tag]);
  const [A, B, C] = Object.values(ps);
  await until(host, (s) => s.players.length === 3);
  const out = {};
  const sc = () => [A, B, C].map((p) => score(host.state, p.id));
  const next = async () => { const i = host.state.qIndex; send(host, { t: 'host:next' }); return until(host, (s) => s.phase === 'collect' && s.qIndex === i + 1); };
  const reveal = () => until(host, (s) => s.phase === 'reveal');
  // Fråga 1: A:s tur. B får inte svara. A svarar fel: frågan går bara vidare, inga poäng.
  send(host, { t: 'host:start' });
  let st = await until(host, (s) => s.phase === 'collect');
  out.f1 = { format: st.collect.format, turn: st.collect.turn === A.id };
  send(B, { t: 'answer', text: 'R' }); await sleep(150);
  out.notYourTurn = B.errors.slice();
  send(A, { t: 'answer', text: 'F1' });
  await reveal();
  out.afterWrongTurn = sc();
  // Fråga 2: B:s tur, rätt
  st = await next();
  out.f2turn = st.collect.turn === B.id;
  send(B, { t: 'answer', text: 'R' });
  await reveal();
  // Fråga 3: buzzer. A buzzar först, C:s buzz räknas inte. A fel: −1, utlåst, F1 struken. C buzzar och svarar rätt.
  st = await next();
  out.f3 = { format: st.collect.format, open: st.collect.buzzOpen };
  send(A, { t: 'buzz' }); await sleep(20); send(C, { t: 'buzz' });
  st = await until(host, (s) => !!s.collect.turn);
  out.firstBuzz = st.collect.turn === A.id;
  await sleep(150);
  send(C, { t: 'answer', text: 'R' }); await sleep(150);
  out.otherAnswersDuringBuzz = C.errors.slice();
  send(A, { t: 'answer', text: 'F1' });
  st = await until(host, (s) => s.collect?.buzzOpen && s.collect.lockedOut.length === 1);
  out.lockedA = st.collect.lockedOut[0] === A.id && st.collect.tried.includes('F1');
  send(A, { t: 'buzz' }); await sleep(150);
  out.lockedErr = A.errors.slice();
  send(C, { t: 'buzz' });
  await until(host, (s) => s.collect?.turn === C.id);
  send(C, { t: 'answer', text: 'F1' }); await sleep(150);
  out.triedErr = C.errors.slice(-1);
  send(C, { t: 'answer', text: 'R' });
  await reveal();
  out.afterBuzz = sc();
  // Fråga 4: C:s tur, ingen svarar, värden visar svaret
  st = await next();
  out.f4turn = st.collect.turn === C.id;
  send(host, { t: 'host:judge' });
  await reveal();
  // Fråga 5 (A:s tur) och 6 (buzzer): B buzzar men hinner inte svara inom 3 s = fel
  await next(); send(host, { t: 'host:judge' }); await reveal();
  st = await next();
  out.f6 = st.collect.format;
  send(B, { t: 'buzz' });
  await until(host, (s) => s.collect?.turn === B.id);
  st = await until(host, (s) => s.collect?.lockedOut?.includes(B.id), 6000);
  out.timeoutWrong = st.lastEvent.kind === 'buzzWrong' && st.collect.buzzOpen;
  out.final = sc();
  closeAll(host, A, B, C);
  // Lag: hela laget får poängen när en i laget svarar rätt
  const room2 = await mkRoom({ title: 'Lagtur', settings: { playMode: 'turns', buzzEvery: 0 }, questions: [q(1), q(2)] });
  const h2 = await connect(room2.code, 'host', room2.hostKey);
  const ps2 = await players(room2.code, ['P' + tag, 'Q' + tag, 'R' + tag, 'S' + tag]);
  await until(h2, (s) => s.players.length === 4);
  send(h2, { t: 'host:teams', mode: 2 });
  await until(h2, (s) => s.teams.length === 2);
  send(h2, { t: 'host:start' });
  st = await until(h2, (s) => s.phase === 'collect');
  const turnTeam = st.teams.find((t) => t.id === st.collect.turn);
  const inTeam = Object.values(ps2).filter((p) => turnTeam.members.includes(p.id));
  const outTeam = Object.values(ps2).filter((p) => !turnTeam.members.includes(p.id));
  send(outTeam[0], { t: 'answer', text: 'R' }); await sleep(150);
  out.teamNotTurn = outTeam[0].errors.length === 1;
  send(inTeam[0], { t: 'answer', text: 'R' });
  st = await until(h2, (s) => s.phase === 'reveal');
  out.teamScores = { in: inTeam.map((p) => score(st, p.id)), out: outTeam.map((p) => score(st, p.id)) };
  closeAll(h2, ...Object.values(ps2));
  return out;
""")

# Svårighetsreglaget: nästa fråga väljs närmast målet, skill-utmaningar håller sin plats, ändras i realtid.
DIFF_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const q = (id, d) => ({ id, text: id, answer: 'R', choices: ['R', 'F'], difficulty: d });
  const room = await mkRoom({ title: 'Svårt', settings: { difficulty: 5 }, questions: [
    q('d1', 1), q('d5', 5), { id: 'sk', text: 'sk', answer: '', mode: 'skill', skill: { kind: 'aim' } }, q('d3', 3), q('d2', 2), q('d4', 4)] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['X' + tag]);
  await until(host, (s) => s.players.length === 1);
  const seen = [];
  const step = async (diff) => {
    if (diff !== undefined) { send(host, { t: 'host:settings', settings: { difficulty: diff } }); await until(host, (s) => s.settings.difficulty === diff); }
    const i = host.state.qIndex;
    send(host, { t: i < 0 ? 'host:start' : 'host:next' });
    const st = await until(host, (s) => s.phase === 'collect' && s.qIndex === i + 1);
    seen.push(st.question.text + (st.question.difficulty ? ':' + st.question.difficulty : ''));
    send(host, { t: 'host:judge' });
    await until(host, (s) => s.phase === 'reveal');
  };
  await step();     // mål 5 → d5
  await step(1);    // mål 1 → d1
  await step();     // skill-utmaningen står näst på tur i setet
  await step(0);    // setets ordning → d3
  await step(4);    // → d4
  await step();     // → d2
  closeAll(host, ...Object.values(ps));
  return { seen };
""")

# Last hit där alla tre creeps missas ska godtas (bugg 2026-10-29: avvisades och gick att spela om), och bara en gång.
LASTHIT_JS = js("""
  const tag = Math.random().toString(36).slice(2, 6);
  const room = await mkRoom({ title: 'LH', questions: [{ id: 'k', text: 'LH', answer: '', mode: 'skill', skill: { kind: 'lasthit' } }] });
  const host = await connect(room.code, 'host', room.hostKey);
  const ps = await players(room.code, ['L' + tag, 'M' + tag]);
  const [L, M] = Object.values(ps);
  send(host, { t: 'host:start' });
  await until(L, (s) => s.phase === 'collect');
  send(L, { t: 'skill', value: 3 * 100000 + 7 * 100, ok: false });   // alla tre denied, sju pilar
  await until(host, (s) => s.collect.answered.includes(L.id));
  send(L, { t: 'skill', value: 300, ok: true }); await sleep(150);    // andra försöket
  const out = { errors: L.errors.slice() };
  send(M, { t: 'skill', value: 1 * 100000 + 4 * 100, ok: true });
  const st = await until(host, (s) => s.phase === 'reveal' || s.phase === 'judge');
  if (st.phase === 'judge') { send(host, { t: 'host:judge' }); await until(host, (s) => s.phase === 'reveal'); }
  out.results = host.state.collect.results.map((r) => [r.text, r.place]);
  closeAll(host, L, M);
  return out;
""")

# Skill-rundor på protokollnivå: frö, validering, rankning och att ordningen inte läcker.
SKILL_JS = """
async ([pin]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Skill', settings: { hostPlays: false }, questions: [
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
  out.qCount = r2.qCount;  // den trasiga utmaningen hoppades över
  for (const c of [host, tv, ...Object.values(ps)]) c.ws.close();
  return out;
}
"""


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


# Samma mönster som HAPTIC i src/lib/sound.ts
VIB_RIGHT, VIB_WRONG = [40, 60, 40, 60, 120], [300, 80, 300]

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


def choices_of(page):
    return page.get_by_role("group", name="Välj svar").get_by_role("button")


def pick(page, text):
    choices_of(page).filter(has_text=text).first.click()


def pick_wrong(page, right):
    btns = choices_of(page)
    for i in range(btns.count()):
        t = btns.nth(i).inner_text()
        if right not in t and btns.nth(i).is_enabled():
            btns.nth(i).click()
            return t
    raise AssertionError("hittade inget fel alternativ")


def create_room(host, title, questions, settings):
    """Skapa ett rum via API:t från hostens sida och spara hostnyckeln så att /host/KOD fungerar."""
    return host.evaluate("""async ([pin, body]) => {
      const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await res.json(); localStorage.setItem('kronan.host.' + r.code, r.hostKey); return r; }""",
        [PIN, {"title": title, "questions": questions, "settings": {"playMode": "all", "buzzEvery": 0, **settings}}])


def join(page, code, name):
    page.goto(f"{BASE}/play/{code}")
    page.get_by_label("Ditt namn").fill(name)
    page.get_by_role("button", name="Hoppa in").click()
    expect(page.get_by_text("Väntar på att hosten startar")).to_be_visible()


POOL8 = ["Rätt", "Fel 1", "Fel 2", "Fel 3", "Fel 4", "Fel 5", "Fel 6", "Fel 7"]


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
        for pg in (p1, p2, host, tv):
            pg.on("pageerror", lambda e: page_errors.append(str(e)))

        # Startsida och installbar app
        p1.goto(BASE + "/")
        expect(p1.get_by_role("heading", name="Vem tar kronan i veckan?")).to_be_visible()
        shot(p1, "01-start-mobil")
        check_pwa(p1)

        # Host loggar in, väljer premiärsetet, 4 alternativ och spelar själv (standard)
        host.goto(BASE + "/host")
        host.get_by_label("Host-PIN").fill(PIN)
        host.get_by_role("button", name="Lås upp").click()
        expect(host.get_by_role("heading", name="Starta kvällens quiz")).to_be_visible()
        host.get_by_label("Spelform").select_option("all")
        host.get_by_label("Buzzerfråga").select_option("0")
        host.get_by_label("Antal svarsalternativ").select_option("4")
        expect(host.get_by_label("Jag spelar själv (dölj facit för mig)")).to_be_checked()
        host.locator("label", has_text="Premiär: Blandat").get_by_role("radio").check()
        shot(host, "02-host-dashboard")
        host.get_by_role("button", name="Öppna rum").click()
        host.wait_for_url("**/host/*")
        code = host.url.rstrip("/").split("/")[-1]
        print("Rum:", code)
        tv.goto(f"{BASE}/tv/{code}")
        expect(tv.get_by_label("Rumskod")).to_have_text(code)

        for page, name in [(p1, "Erik"), (p2, "Tobbe")]:
            page.goto(BASE + "/")
            page.get_by_label("Rumskod från hosten").fill(code)
            page.get_by_role("button", name="Gå med").click()
            page.get_by_label("Ditt namn").fill(name)
            page.get_by_role("button", name="Hoppa in").click()
            expect(page.get_by_text("Väntar på att hosten startar")).to_be_visible()
        expect(tv.get_by_text("2 spelare inne")).to_be_visible()
        assert p1.get_by_role("button", name="Buzza").count() == 0, "Buzzern finns kvar"
        # Spelarsidan styrs av service workern och klarar en omladdning (websocket återansluter)
        assert p1.evaluate("!!navigator.serviceWorker.controller"), "/play styrs inte av service workern"
        p1.reload()
        expect(p1.get_by_text("Väntar på att hosten startar")).to_be_visible()
        shot(tv, "03-tv-lobby")
        shot(p1, "04-spelare-lobby")

        # Fråga 1: fyra alternativ. Värden spelar själv och ser inget facit; TV:n visar inte rätt svar.
        host.get_by_role("button", name="Starta första frågan").click()
        expect(choices_of(p1)).to_have_count(4)
        expect(tv.get_by_label("Svarsalternativ").locator("li")).to_have_count(4)
        expect(host.get_by_text("Du spelar själv, så du ser inte facit")).to_be_visible()
        assert host.get_by_text("Svar:").count() == 0, "Hosten ser facit trots att hen spelar"
        assert tv.locator(".choice-tile.right").count() == 0, "TV:n markerar rätt svar före reveal"
        shot(tv, "05-tv-fraga")
        shot(p1, "06-spelare-alternativ")
        shot(host, "07-host-spelande-vard")
        pick_wrong(p2, "2010")
        pick(p1, "2010")
        expect(p1.get_by_text("Ditt val är låst")).to_be_visible()
        expect(tv.get_by_text("Tiden är ute")).to_be_visible()   # alla har svarat: frågan stängs direkt
        host.get_by_role("button", name="Visa svaret (V)").click()
        expect(tv.locator(".answer-reveal")).to_have_text("2010")
        expect(tv.locator(".choice-tile.right")).to_contain_text("2010")
        expect(p1.get_by_text("Rätt! +2 p")).to_be_visible()
        expect(p2.get_by_text("Fel den här gången")).to_be_visible()
        wait_vib(p1, [VIB_RIGHT])
        shot(tv, "08-tv-facit")

        # Lyckohjulet: hosten snurrar mellan frågorna, TV och spelare ser samma utfall
        host.get_by_role("button", name="Snurra hjulet").click()
        expect(tv.locator(".wheel")).to_be_visible()
        expect(p1.get_by_text("Lyckohjulet snurrar")).to_be_visible()
        tv.wait_for_timeout(1200)
        shot(tv, "08b-tv-hjul-snurrar")
        tv.reload(); p2.reload()
        tv_twist = tv.locator(".wheel-caption[data-twist]")
        expect(tv_twist).to_be_visible(timeout=8000)
        twist = tv_twist.get_attribute("data-twist")
        label = tv.locator(".wheel-result").inner_text()
        print("Lyckohjulet gav:", twist, label)
        expect(p1.locator(".wheel-result")).to_have_text(label)
        expect(p2.locator(".wheel-result")).to_have_text(label)
        expect(host.get_by_text("Nästa fråga: " + label)).to_be_visible()
        tv.wait_for_timeout(500)
        under_pointer = tv.evaluate("""() => {
          const m = new DOMMatrix(getComputedStyle(document.querySelector('.wheel-disc')).transform);
          const deg = ((Math.atan2(m.b, m.a) * 180 / Math.PI) % 360 + 360) % 360;
          const segs = [...document.querySelectorAll('.wheel-seg')];
          return [Math.floor(((360 - deg) % 360) / (360 / segs.length)), segs.findIndex((e) => e.classList.contains('hit'))];
        }""")
        assert under_pointer[0] == under_pointer[1], f"Hjulet på TV:n stannade på fel fält efter omladdning: {under_pointer}"
        shot(tv, "08c-tv-hjul-landat")

        # Värden ändrar antal alternativ under kvällen: 6 från nästa fråga
        host.get_by_text("Kvällens regler").click()
        host.get_by_label("Antal svarsalternativ").select_option("6")
        expect(host.get_by_text("gäller från nästa fråga")).to_be_visible()
        # Facit går inte att slå på mitt i kvällen
        expect(host.get_by_label("Jag spelar själv (dölj facit och andras svar för mig)")).to_be_disabled()
        shot(host, "09-host-regler")

        # Fråga 2 (Guld): 6 alternativ (4 med 50/50 från hjulet). Erik väljer med tangentbordet, Tobbe hinner inte.
        host.get_by_role("button", name="Nästa fråga (N)").click()
        want = 4 if twist == "fifty" else 6
        expect(choices_of(p1)).to_have_count(want)
        if twist != "none":
            expect(tv.locator(f'.twist-badge[data-twist="{twist}"]')).to_be_visible()
        letters = [choices_of(p1).nth(i).get_attribute("data-letter") for i in range(want)]
        texts = [choices_of(p1).nth(i).inner_text() for i in range(want)]
        guld = next(l for l, t in zip(letters, texts) if "Guld" in t)
        p1.locator("h2, p").first.click()
        p1.keyboard.press(guld.lower())
        expect(p1.get_by_text("Ditt val är låst")).to_be_visible()
        expect(p1.locator(".locked-text")).to_have_text("”Guld”")
        shot(p1, "10-spelare-last")
        host.get_by_role("button", name="Visa svaret (V)").click()   # stänger frågan i förtid
        expect(tv.locator(".answer-reveal")).to_have_text("Guld")
        expect(p2.get_by_text("Du hann inte svara")).to_be_visible()
        # Erik laddar om: senaste händelsen är gammal och ska inte vibrera igen
        n_vib = len(vib(p1))
        p1.reload()
        expect(p1.locator(".chip").first).to_contain_text("Erik")
        p1.wait_for_timeout(800)
        assert vib(p1) == [], f"Vibrerade för gammal händelse efter omladdning: {vib(p1)} (före: {n_vib})"

        # Fråga 3 (Vänern): Sanna hoppar in mitt i quizet. Alla svarar; snabbaste rätt får bonus.
        p3 = b.new_page(viewport={"width": 390, "height": 844})
        p3.on("pageerror", lambda e: page_errors.append(str(e)))
        p3.goto(f"{BASE}/play/{code}")
        p3.get_by_label("Ditt namn").fill("Sanna")
        p3.get_by_role("button", name="Hoppa in").click()
        expect(tv.locator(".chip", has_text="Sanna")).to_be_visible()
        host.get_by_role("button", name="Nästa fråga (N)").click()
        for pg in (p1, p2, p3):
            expect(choices_of(pg)).to_have_count(6)
        pick(p1, "Vänern")
        expect(tv.locator(".answered.done")).to_have_count(1)
        pick_wrong(p3, "Vänern")
        p2.wait_for_timeout(500)
        pick(p2, "Vänern")
        expect(tv.get_by_text("Tiden är ute")).to_be_visible()
        assert host.locator(".answer-box").count() == 0, "Spelande värd ser facit"
        host.keyboard.press("v")
        results = tv.get_by_label("Allas svar").locator("li")
        expect(results).to_have_count(3)
        expect(results.nth(0)).to_contain_text("Snabbast")
        expect(results.nth(0)).to_contain_text("Rätt +2")
        expect(results.nth(1)).to_contain_text("Fel")
        expect(results.nth(2)).to_contain_text("Rätt +1")
        tv.wait_for_timeout(800)
        shot(tv, "11-tv-alla-svar")
        assert not page_errors, f"Sidfel: {page_errors}"

        # Avsluta och kröna
        before = len(json.loads(urllib.request.urlopen(BASE + "/api/hub/public").read())["league"])
        host.once("dialog", lambda d: d.accept())
        host.get_by_role("button", name="Avsluta i förtid").click()
        expect(tv.get_by_role("heading", name="Kvällens kung")).to_be_visible()
        host.get_by_role("button", name="Kröna vinnaren och spara i tabellen").click()
        expect(host.get_by_text("Sparat i tabellen")).to_be_visible()
        tv.wait_for_timeout(600)
        shot(tv, "12-tv-pallen")
        league = json.loads(urllib.request.urlopen(BASE + "/api/hub/public").read())["league"]
        assert len(league) == before + 1, "Kröningen sparades inte i tabellen"
        res = {r["name"]: r["score"] for r in league[0]["results"]}
        # Erik: 2 + 2 (3 med hjulets dubbla poäng, bonusen dubblas inte) + 2, Tobbe: 1 på fråga 3, Sanna: fel kostar inget
        expected = {"Erik": 7 if twist == "double" else 6, "Tobbe": 1, "Sanna": 0}
        assert res == expected, f"Fel slutpoäng med twisten {twist}: {res}, väntade {expected}"

        # Frågebanken: rätt svar + felalternativ, snabbinklistring och JSON-import
        host.goto(BASE + "/bank")
        host.get_by_role("button", name="Nytt set").click()
        host.get_by_label("Titel").fill("Test-set")
        host.get_by_text("Klistra in många på en gång").click()
        host.locator("textarea").last.fill("Fråga A | Svar A | Fel 1; Fel 2\nFråga B | Svar B | | 2")
        host.get_by_role("button", name="Lägg till raderna").click()
        expect(host.get_by_label("Felalternativ 1")).to_have_value("Fel 1; Fel 2")
        host.get_by_role("button", name="Spara set").click()
        expect(host.get_by_text("Fråga 2: skriv minst ett felalternativ")).to_be_visible()
        host.get_by_label("Felalternativ 2").fill("X; Y; Z")
        shot(host, "13-bank-editor")
        host.get_by_role("button", name="Spara set").click()
        saved = host.locator(".panel", has_text="Test-set").first
        expect(saved).to_contain_text("2 frågor")
        saved.get_by_role("button", name="Redigera").click()
        expect(host.get_by_label("Felalternativ 2")).to_have_value("X; Y; Z")
        host.get_by_label("Rundtyp 2").select_option("skill")
        expect(host.get_by_label("Utmaning 2")).to_be_visible()
        host.get_by_role("button", name="Stäng").click()
        imp = os.path.join(SHOTS, "import-test.json")
        with open(imp, "w") as f:
            json.dump({"title": "Importerat", "questions": [
                {"text": "Importerad", "answer": "X", "choices": ["X", "Y"]},
                {"text": "Skill", "answer": "", "mode": "skill", "skill": {"kind": "aim"}}]}, f)
        host.locator('input[type="file"]').set_input_files(imp)
        expect(host.get_by_label("Rundtyp 1")).to_have_value("choice")
        expect(host.get_by_label("Felalternativ 1")).to_have_value("Y")
        expect(host.get_by_label("Rundtyp 2")).to_have_value("skill")
        os.remove(imp)

        # Värden spelar inte: facit och alla svar syns, 8 alternativ, Sanna använder 50/50
        adata = create_room(host, "Med facit", [
            {"id": "a1", "text": "Vilket är rätt?", "answer": "Rätt", "choices": POOL8, "points": 2}],
            {"hostPlays": False, "choiceCount": 8, "collectSeconds": 30})
        acode = adata["code"]
        at = acode.lower()  # unika namn: plånböckerna sparas mellan körningar
        host.goto(f"{BASE}/host/{acode}")
        tv.goto(f"{BASE}/tv/{acode}")
        for page, name in [(p1, "Erik"), (p2, "Tobbe"), (p3, "Sanna")]:
            join(page, acode, name + at)
        p3.get_by_role("button", name="Köp 50/50 för 3 mynt").click()
        expect(p3.get_by_text("50/50 ×")).to_be_visible()
        host.get_by_role("button", name="Starta första frågan").click()
        expect(host.get_by_text("Svar: Rätt")).to_be_visible()
        expect(choices_of(p3)).to_have_count(8)
        p3.get_by_role("button", name="Använd 50/50").click()
        expect(p3.locator(".choice-btn.gone")).to_have_count(3)
        shot(p3, "14-spelare-5050")
        pick_wrong(p2, "Rätt")
        pick(p1, "Rätt")
        p3.wait_for_timeout(300)
        pick(p3, "Rätt")
        mark = host.get_by_label("Inlämnade svar")
        expect(mark.locator("li")).to_have_count(3)
        expect(host.get_by_label(f"Erik{at} svarade rätt")).to_be_checked()
        expect(host.get_by_label(f"Sanna{at} svarade rätt")).to_be_checked()
        expect(host.get_by_label(f"Tobbe{at} svarade rätt")).not_to_be_checked()
        assert tv.locator(".choice-tile.right").count() == 0, "TV:n markerar rätt alternativ under rättningen!"
        shot(host, "15-host-med-facit")
        host.get_by_role("button", name="Visa svaret (V)").click()
        expect(tv.locator(".choice-tile.right .picks")).to_have_text("2")
        expect(p1.get_by_text("Rätt! +3 p")).to_be_visible()
        expect(p3.get_by_text("Rätt! +2 p")).to_be_visible()
        tv.wait_for_timeout(700)
        shot(tv, "16-tv-8-alternativ")
        assert not page_errors, f"Sidfel: {page_errors}"

        # Lagens tur och buzzer i webbläsaren (två spelare = två "lag"), plus svårighetsreglaget
        bdata = create_room(host, "Tur och buzz", [
            {"id": "t1", "text": "Vilken färg har en banan?", "answer": "Gul", "choices": ["Gul", "Blå", "Röd", "Lila"], "difficulty": 1},
            {"id": "t2", "text": "Vilken planet är störst?", "answer": "Jupiter", "choices": ["Jupiter", "Mars", "Venus", "Saturnus"], "difficulty": 2},
            {"id": "t3", "text": "Svår reservfråga", "answer": "X", "choices": ["X", "Y"], "difficulty": 5}],
            {"playMode": "turns", "buzzEvery": 2, "penalty": 1, "hostPlays": True})
        bcode = bdata["code"]
        bt = bcode.lower()
        host.goto(f"{BASE}/host/{bcode}")
        tv.goto(f"{BASE}/tv/{bcode}")
        join(p1, bcode, "Erik" + bt)
        join(p2, bcode, "Tobbe" + bt)
        host.get_by_role("button", name="Starta första frågan").click()
        expect(tv.locator(".turn-banner")).to_contain_text("har turen")
        assert "snacka" not in host.inner_text("body").lower(), "Hostkontrollen säger åt värden att snacka högt"
        # Åskådaren ser lagets kort med pratande medlemmar, nedräkning och skuggtips
        spec = p2.locator(".spectator")
        expect(spec).to_contain_text("har turen")
        expect(spec.get_by_label("Svarar nu").locator("li")).to_have_count(1)
        expect(spec.get_by_role("timer")).to_be_visible()
        expect(p2.get_by_role("group", name="Skuggtips").get_by_role("button")).to_have_count(4)
        p2.get_by_role("group", name="Skuggtips").get_by_role("button").filter(has_text="Gul").click()
        expect(p2.get_by_text("Ditt skuggtips är sparat")).to_be_visible()
        expect(choices_of(p1)).to_have_count(4)
        shot(tv, "60-tv-lagens-tur")
        shot(p2, "61-spelare-vantar")
        shot(p1, "62-spelare-er-tur")
        pick(p1, "Gul")
        expect(tv.locator(".answer-reveal")).to_have_text("Gul")
        # Den som inte hade turen ser lagets resultat, inte "Du hann inte svara"
        expect(p2.get_by_text("tog den")).to_be_visible()
        expect(p2.get_by_text("Ditt skuggtips var rätt")).to_be_visible()
        assert p2.get_by_text("Du hann inte svara").count() == 0, "Åskådaren fick 'Du hann inte svara'"
        expect(p1.get_by_text("Rätt! +1 p")).to_be_visible()
        shot(p2, "61b-spelare-lagresultat")
        # Värden drar reglaget mitt i kvällen
        host.get_by_label("Svårighet").fill("5")
        expect(host.locator(".difficulty strong")).to_have_text("Riktigt svår")
        host.get_by_label("Svårighet").fill("0")
        expect(host.locator(".difficulty strong")).to_have_text("Setets ordning")
        host.get_by_role("button", name="Nästa fråga (N)").click()
        # Fråga 2 är buzzer: båda kan buzza, Tobbe hinner först och svarar fel, Erik buzzar och tar den
        expect(p1.get_by_role("button", name="Buzza")).to_be_visible()
        expect(tv.get_by_text("Först att buzza får svara")).to_be_visible()
        shot(tv, "63-tv-buzzer")
        shot(p1, "64-spelare-buzzer")
        p2.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(choices_of(p2)).to_have_count(4)
        expect(p1.locator(".spectator")).to_contain_text("buzzade!")
        shot(tv, "65-tv-buzzat")
        pick_wrong(p2, "Jupiter")
        expect(p2.locator(".spectator")).to_contain_text("utlåst")
        shot(p2, "65b-spelare-utlast")
        p1.get_by_role("button", name="Buzza").dispatch_event("pointerdown")
        expect(p1.locator(".choice-btn.gone")).to_have_count(1)
        pick(p1, "Jupiter")
        expect(tv.locator(".answer-reveal")).to_have_text("Jupiter")
        expect(tv.locator(".chip", has_text="Tobbe" + bt)).to_contain_text("-1")
        expect(p2.get_by_text("Fel, −1 p")).to_be_visible()
        tv.wait_for_timeout(500)
        shot(tv, "66-tv-buzz-facit")
        assert not page_errors, f"Sidfel: {page_errors}"

        # Skill-utmaningar: Erik spelar alla fem på riktigt, Tobbe laddar om mitt i och blir diskad
        sdata = host.evaluate("""async ([pin]) => {
          const res = await fetch('/api/rooms', { method: 'POST', headers: { 'x-host-pin': pin, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Skill', settings: { hostPlays: false }, questions: [
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
        expect(p2.get_by_role("button", name="Skjut")).to_be_visible()
        p2.reload()  # försöket är förbrukat
        expect(host.get_by_label("Skill-resultat").locator("li", has_text="Tobbe")).to_contain_text("Diskad")
        p1.get_by_role("button", name="Starta").click()
        expect(p1.get_by_role("button", name="Skjut")).to_be_visible()
        p1.wait_for_timeout(1500)
        shot(p1, "32-spelare-lasthit")
        # Pilen tar BOW_DRAW + FLIGHT ms: skjut så att den landar strax efter att creepen gått under strecket.
        # Tidpunkterna ligger i data-attribut; trycket görs inifrån sidan (CI-maskinen är för seg för rundresor).
        p1.evaluate("""async () => {
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          const el = () => document.querySelector('.lasthit');
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            while (!(el() && el().dataset.running === '1')) { if (performance.now() - t0 > 15000) throw new Error('creep startade aldrig'); await frame(); }
            const fireAt = +el().dataset.enterAt - +el().dataset.lead + 90;
            while (performance.now() < fireAt) await frame();
            document.querySelector('[aria-label="Skjut"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            while (el() && el().dataset.running === '1') { if (performance.now() - t0 > 20000) throw new Error('creepen tog aldrig slut'); await frame(); }
          }
        }""")
        expect(p1.get_by_text("Klart!")).to_be_visible(timeout=5000)
        expect(p1.locator(".locked-text")).to_contain_text("3/3 last hits · 3 pilar")
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
        tdata = create_room(host, "Lagkväll", [
            {"id": "l1", "text": "Vad heter Kongors studio?", "answer": "Kongor Studios", "choices": ["Kongor Studios", "S2 Games", "Garena", "Valve"]}], {})
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
        # Sanna köper Dubbla poäng och aktiverar det för första frågan; Erik köper 50/50
        p3.get_by_role("button", name="Köp Dubbla poäng för 4 mynt").click()
        expect(p3.get_by_label("Mynt", exact=True)).to_contain_text("6")
        p3.get_by_role("button", name="Dubbla poäng nästa fråga").click()
        expect(tv.locator(".effect-tag.double")).to_be_visible()
        p1.get_by_role("button", name="Köp 50/50 för 3 mynt").click()
        expect(p1.get_by_text("50/50 ×1")).to_be_visible()
        shot(p1, "52-spelare-butik")
        host.get_by_role("button", name="Starta första frågan").click()
        expect(tv.locator(".effect-tag.double")).to_be_visible()
        p1.get_by_role("button", name="Använd 50/50 (1 kvar)").click()
        expect(p1.locator(".choice-btn.gone")).to_have_count(1)
        shot(p1, "53-spelare-5050")
        pick(p1, "Kongor Studios")
        expect(p1.get_by_text("Ditt val är låst")).to_be_visible()
        pick_wrong(p2, "Kongor")
        pick_wrong(p3, "Kongor")
        host.get_by_role("button", name="Visa svaret (V)").click()
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
        # Hosten kan ta bort en demokväll ur tabellen
        host.goto(BASE + "/tabell")
        expect(host.get_by_role("button", name="Ta bort Lagkväll").first).to_be_visible()
        nights = host.get_by_role("button", name="Ta bort Lagkväll").count()
        host.once("dialog", lambda d: d.accept())
        host.get_by_role("button", name="Ta bort Lagkväll").first.click()
        expect(host.get_by_role("button", name="Ta bort Lagkväll")).to_have_count(nights - 1)
        assert not page_errors, f"Sidfel: {page_errors}"

        # ===== Protokolltester direkt mot servern =====
        raw = b.new_page()
        raw.goto(BASE + "/")

        ch = raw.evaluate(CHOICE_JS, [PIN])
        print("Svarsalternativ:", ch)
        assert ch["skipped"] == 1 and ch["qCount"] == 3, f"Frågor utan alternativ ska hoppas över: {ch}"
        assert ch["emptyStatus"] == 400, "Ett set utan spelbara frågor ska ge fel"
        assert ch["shown1"] == 4 and ch["hasAnswer"], f"Fel urval av alternativ: {ch}"
        assert ch["hostSeesAnswer"] == "R", "Värd som inte spelar ska se facit"
        assert ch["nextBlocked"] == ["Visa svaret först"], f"Nästa fråga gick under pågående fråga: {ch['nextBlocked']}"
        assert ch["shownAfterChange"] == 4 and ch["shown2"] == 6 and ch["shown3"] == 3, f"Antal alternativ följer inte inställningen: {ch}"
        assert ch["invalid"] == ["Välj ett av alternativen"] and ch["lateOrTwice"] == ["Tiden är ute"], f"Fel felmeddelanden: {ch}"
        assert ch["leak"] == 0, f"Facit eller svar läckte till TV:n före reveal ({ch['leak']} meddelanden)"
        assert ch["autoMarked"] and ch["revealed"] == "R" and ch["scores"] == [2, 0], f"Rättning/poäng fel: {ch}"

        hp = raw.evaluate(HOSTPLAYS_JS, [PIN])
        print("Spelande värd:", hp)
        assert hp["leak"] == 0, f"Facit eller svar skickades till spelande värd ({hp['leak']} meddelanden)"
        assert hp["errors"] == ["Rättningen är automatisk när du spelar själv",
                                "Du spelar själv i kväll: facit kan bara visas om du stänger av det innan start"], f"Fel felmeddelanden: {hp['errors']}"
        assert hp["stillPlays"] is True and hp["lobbyOff"] is False, f"Spelande värd kunde stängas av mitt i: {hp}"
        assert hp["revealed"] == "HEMLIGT-SVAR" and hp["vScore"] == 0 and hp["choicesShown"] == 4, f"Fel efter reveal: {hp}"

        fi = raw.evaluate(FIFTY_JS, [PIN])
        print("50/50:", fi)
        assert fi["removed"] == 3 and fi["answerKept"], f"50/50 tog bort fel antal eller rätt svar: {fi}"
        assert fi["othersSee"] == 0, "Andra fick se vilka alternativ 50/50 tog bort"
        assert fi["errors"] == ["50/50 används under en fråga med alternativ", "Du har redan använt 50/50 på den här frågan"], f"Fel felmeddelanden: {fi['errors']}"
        assert fi["left"] == 0, "50/50 drogs inte från plånboken"

        wh = raw.evaluate(WHEEL_JS, [PIN])
        print("Lyckohjulet:", wh)
        assert wh["playerSpin"] == ["Bara hosten kan göra det"], "Spelare kunde snurra hjulet"
        assert wh["double"] == 3, f"Dubbla poäng dubblar frågans poäng men inte bonusen (1 × 2 + 1): {wh['double']}"
        assert wh["fifty"] == 5, f"50/50 för alla ska ge rätt + 4 av 7 fel: {wh['fifty']}"
        assert wh["blitzMs"] == 10000 and wh["normalMs"] == 20000 and wh["noneShown"] == 8, f"Blixt/Nit fel: {wh}"
        assert wh["steal"] == {"a": 0, "b": 3, "stealer": True, "from": True}, f"Stjäl fungerar inte: {wh['steal']}"
        assert set(wh["skillTwists"]) <= {"double", "steal", "none"}, f"Hjulet gav twist som inte passar en skill-utmaning: {wh['skillTwists']}"

        tm = raw.evaluate(TEAMS_JS, [PIN])
        print("Lag och butik:", tm)
        assert tm["welcome"] == [10, 10, 10, 10], f"Välkomstbonusen blev fel: {tm['welcome']}"
        assert tm["split3"] == [2, 2] and tm["split2"] == [2, 2], f"Fel lagindelning: {tm}"
        assert tm["errorsA"] == ["Ditt lag har redan Extra tid i kväll", "Du har 1 mynt, Dubbla poäng kostar 4"], f"Butiken släppte igenom fel köp: {tm['errorsA']}"
        assert tm["vetoNewMate"], "Veto gav samma lagkamrat igen"
        assert tm["doubleUnit"] and tm["doubleScore"] == 4 and tm["coinCorrect"] == 1, f"Dubbla poäng/mynt fungerar inte: {tm}"
        assert tm["hubWallet"] == 1, f"Plånboken sparades inte i Hub: {tm['hubWallet']}"
        assert tm["errorsC"] == ["Välj ett annat lag att sabotera"], f"Gick att sabotera eget lag: {tm['errorsC']}"
        assert tm["extraQ2"] == (5000 if tm["sameTeamAC"] else -7500), f"Extra tid/Sabotage gav fel svarstid: {tm['extraQ2']}"
        assert tm["fiftyLeft"] == 0, "50/50 drogs inte"
        assert tm["extraCollect"] == 5000 and tm["extraOther"] in (0, 5000), f"Extra tid fel: {tm}"
        assert all(t for _, _, t in tm["results"]), "Lagnamn saknas i tabellen"
        assert sorted(r[1] for r in tm["results"]) == [0, 0, 2, 2], f"Kvällens resultat ska vara lagets snitt (4/2 = 2): {tm['results']}"
        assert all(tm["paid"].values()), f"Mynten betalades inte ut exakt en gång: {tm['paid']}"
        assert tm["winnerBonus"] == 1 + 3, f"Vinnaren ska få 1 (rätt svar) + 3 (vinst): {tm['winnerBonus']}"

        mo = raw.evaluate(MODES_JS, [PIN])
        print("Lagens tur och buzzer:", mo)
        assert mo["f1"] == {"format": "turn", "turn": True} and mo["f2turn"] and mo["f4turn"], f"Turordningen fungerar inte: {mo}"
        assert mo["notYourTurn"] and "tur" in mo["notYourTurn"][0], f"Fel lag fick svara: {mo['notYourTurn']}"
        assert mo["afterWrongTurn"] == [0, 0, 0], f"Fel svar på lagets tur ska bara gå vidare: {mo['afterWrongTurn']}"
        assert mo["f3"] == {"format": "buzz", "open": True} and mo["firstBuzz"], f"Buzzerfrågan fungerar inte: {mo}"
        assert mo["otherAnswersDuringBuzz"] and mo["lockedA"] and mo["lockedErr"] == ["Ert lag är utlåst på den här frågan"], f"Buzz-låsning fel: {mo}"
        assert mo["triedErr"] == ["Det alternativet är redan prövat"], f"Prövat alternativ gick att välja igen: {mo['triedErr']}"
        assert mo["afterBuzz"] == [-1, 1, 1], f"Poäng efter buzz fel (A −1, B 1, C 1): {mo['afterBuzz']}"
        assert mo["f6"] == "buzz" and mo["timeoutWrong"] and mo["final"] == [-1, 0, 1], f"Buzz-timeout ska vara fel: {mo}"
        assert mo["teamNotTurn"] and mo["teamScores"] == {"in": [1, 1], "out": [0, 0]}, f"Laget ska få poängen tillsammans: {mo}"

        df = raw.evaluate(DIFF_JS, [PIN])
        print("Svårighet:", df)
        assert df["seen"] == ["d5:5", "d1:1", "sk", "d3:3", "d4:4", "d2:2"], f"Svårighetsreglaget väljer fel fråga: {df['seen']}"

        lh = raw.evaluate(LASTHIT_JS, [PIN])
        print("Last hit:", lh)
        assert lh["errors"] == ["Du har redan lämnat ditt resultat"], f"Last hit gick att lämna två gånger eller avvisades: {lh['errors']}"
        assert lh["results"] == [["2/3 last hits · 4 pilar", 1], ["Inga last hits · 7 pilar", 0]], f"Fel resultat i Last hit: {lh['results']}"

        sk = raw.evaluate(SKILL_JS, [PIN])
        print("Skill:", sk)
        assert sk["mode"] == "skill" and sk["seedSame"], f"Spelarna fick inte samma frö: {sk}"
        assert sk["itemsHidden"], "Ordna rätt skickade värden före reveal"
        assert sk["badRejected"] == ["Ogiltigt resultat", "Ogiltigt resultat"], f"Orimliga resultat godtogs: {sk['badRejected']}"
        assert sk["places"] == [["A", 1, 3], ["C", 1, 3], ["B", 3, 1], ["D", 0, 0]], f"Fel rankning i Flick: {sk['places']}"
        assert sk["order"] == [["B", 1, 3], ["A", 2, 2]], f"Fel rankning i Ordna rätt: {sk['order']}"
        assert sk["orderReveal"] == ["X", "Y", "Z"], f"Rätt ordning visades inte vid reveal: {sk['orderReveal']}"
        assert sk["qCount"] == 2, f"Ogiltig skill-utmaning ska hoppas över: {sk['qCount']}"
        raw.close()

        b.close()
        print("E2E OK. Slutpoäng:", res)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("E2E MISSLYCKADES:", e)
        sys.exit(1)
