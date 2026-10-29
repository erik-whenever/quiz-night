import type {
  ClientMsg, GameEvent, HostState, Phase, PlayerPublic, PublicState, Question, ServerMsg, Settings, WheelState,
} from "../shared/types";
import {
  DEFAULT_SETTINGS, MAX_SHOWN, MIN_SHOWN, MSG_BURST, MSG_RATE_PER_S, SKILL_TWISTS, activeTwist, difficultyOf, effectiveChoiceRules, validChoices,
} from "../shared/types";
import {
  type CollectServer, collectEnd, collectHost, collectPublic, markAnswer, scoreAll, scoreSkill, startCollect, submitAnswer, submitSkill,
} from "./collect";
import { SKILLS, correctOrder, orderShuffle, validSkill } from "../shared/skill";
import { spinWheel, stealTarget } from "./wheel";
import {
  COINS, EXTRA_TIME_MS, SHOP, TEAM_COLORS, TEAM_NAMES, type CoinNote, type Effects, type ShopItem, type Team,
  type TeamMode, type TokenItem, type Wallet, splitTeams, unitOf,
} from "../shared/teams";

interface Env { HUB: DurableObjectNamespace }

/** Slumpad ordning med crypto. */
const shuffled = <T,>(xs: T[]) => {
  const a = [...xs];
  const r = crypto.getRandomValues(new Uint32Array(a.length));
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const COLORS = ["#FF5D73", "#FFD23F", "#3DDC97", "#4CC9F0", "#B388FF", "#FF9F45", "#F15BB5", "#9EF01A"];
/** Kortaste svarstid efter Blixt eller Sabotage. */
const MIN_COLLECT_MS = 5000;

interface Conn {
  ws: WebSocket; role: "host" | "tv" | "player"; playerId?: string;
  /** Rate-limit: token bucket för alla meddelanden. */
  msgBucket: Bucket;
}

/** Enkel token bucket: fylls på med rate/s upp till burst. Överskjutande meddelanden ignoreras tyst. */
interface Bucket { tokens: number; last: number }
const bucket = (burst: number): Bucket => ({ tokens: burst, last: Date.now() });
function take(b: Bucket, rate: number, burst: number): boolean {
  const now = Date.now();
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rate);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

interface Persisted {
  code: string;
  title: string;
  phase: Phase;
  players: PlayerPublic[];
  questions: Question[];
  qIndex: number;
  settings: Settings;
  lastEvent?: GameEvent;
  hostKey: string;
  /** Pågående/senaste fråga. */
  collect?: CollectServer | null;
  wheel?: WheelState | null;
  teamMode: TeamMode;
  teams: Team[];
  wallets: Record<string, Wallet>;
  coins: Record<string, number>;
  coinLog: CoinNote[];
  streak: Record<string, number>;
  /** Spelare som köpt Extra tid i kväll; effekten gäller deras lag. */
  extraBuyers: string[];
  /** Fråga -> enheter (lag/spelare) med Dubbla poäng resp. Sabotage. */
  doubleFor: Record<number, string[]>;
  sabotageFor: Record<number, string[]>;
  /** Omgång -> frågeindex. qIndex är omgången; frågan väljs när omgången startar (svårighetsreglaget). */
  order: number[];
  /** Vems tur det är (räknare över enheterna) och hur många alternativfrågor som spelats (för buzzEvery). */
  turnIdx: number;
  choiceRounds: number;
}

const TEAM_DEFAULTS = (): Pick<Persisted, "teamMode" | "teams" | "wallets" | "coins" | "coinLog" | "streak" | "extraBuyers" | "doubleFor" | "sabotageFor" | "order" | "turnIdx" | "choiceRounds"> => ({
  teamMode: 0, teams: [], wallets: {}, coins: {}, coinLog: [], streak: {}, extraBuyers: [], doubleFor: {}, sabotageFor: {},
  order: [], turnIdx: 0, choiceRounds: 0,
});

/**
 * Normalisera en fråga från JSON eller frågebanken. Skill med giltig spec blir skill, allt med giltiga
 * alternativ blir choice (oavsett gammalt mode). Frågor utan alternativ går inte att spela: null.
 */
export function normalizeQuestion(q: Question): Question | null {
  if (q.mode === "skill") {
    const skill = validSkill(q.skill);
    if (!skill) return null;
    const answer = skill.kind === "order" ? correctOrder(skill.items!).map((i) => i.label).join(" → ") : "";
    return { ...q, mode: "skill", answer, skill, choices: undefined };
  }
  const choices = validChoices(q);
  return choices ? { ...q, mode: "choice", answer: q.answer.trim(), choices, skill: undefined } : null;
}

/** Skill-specen som spelarna får: sakerna i "Ordna rätt" blandade och utan värden tills reveal. */
function publicSkill(q: Question, seed: number, revealed: boolean) {
  const sk = q.skill!;
  if (sk.kind !== "order") return sk;
  return { ...sk, items: revealed ? correctOrder(sk.items!) : orderShuffle(sk.items!, seed).map((i) => ({ label: i.label })) };
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const clampSettings = (s: Settings): Settings => ({
  collectSeconds: clamp(s.collectSeconds, 5, 180, DEFAULT_SETTINGS.collectSeconds),
  fastestBonus: clamp(s.fastestBonus, 0, 5, DEFAULT_SETTINGS.fastestBonus),
  choiceCount: clamp(s.choiceCount, MIN_SHOWN, MAX_SHOWN, DEFAULT_SETTINGS.choiceCount),
  hostPlays: !!s.hostPlays,
  playMode: s.playMode === "all" ? "all" : "turns",
  buzzEvery: clamp(s.buzzEvery, 0, 10, DEFAULT_SETTINGS.buzzEvery),
  penalty: clamp(s.penalty, 0, 5, DEFAULT_SETTINGS.penalty),
  buzzAnswerSeconds: clamp(s.buzzAnswerSeconds, 3, 30, DEFAULT_SETTINGS.buzzAnswerSeconds),
  difficulty: clamp(s.difficulty, 0, 5, DEFAULT_SETTINGS.difficulty),
});

export class Room implements DurableObject {
  private s: Persisted | null = null;
  private conns = new Set<Conn>();
  /** Stänger frågan när tiden gått ut. */
  private collectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: DurableObjectState, private env: Env) {
    ctx.blockConcurrencyWhile(async () => {
      const s = (await ctx.storage.get<Persisted>("s")) ?? null;
      if (s) {
        this.s = { ...TEAM_DEFAULTS(), ...s, settings: clampSettings({ ...DEFAULT_SETTINGS, ...s.settings }) };
        // Fråga som pågick när objektet sövdes: stäng den direkt eller vid deadline.
        if (this.s.phase === "collect" && this.s.collect) this.armCollectTimer();
      }
    });
  }

  private async save() { if (this.s) await this.ctx.storage.put("s", this.s); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/init") && req.method === "POST") {
      const body = await req.json<{ code: string; title: string; questions: Question[]; hostKey: string; settings?: Partial<Settings> }>();
      const questions = body.questions.map(normalizeQuestion).filter((q): q is Question => !!q);
      if (!questions.length) return Response.json({ error: "Inga spelbara frågor: varje fråga behöver svarsalternativ eller vara en skill-utmaning" }, { status: 400 });
      this.s = {
        code: body.code, title: body.title, phase: "lobby", players: [], questions, qIndex: -1,
        settings: clampSettings({ ...DEFAULT_SETTINGS, ...body.settings }), hostKey: body.hostKey,
        ...TEAM_DEFAULTS(),
      };
      await this.save();
      return Response.json({ ok: true, skipped: body.questions.length - questions.length });
    }

    if (url.pathname.endsWith("/results")) {
      if (!this.s) return new Response("not found", { status: 404 });
      return Response.json({ title: this.s.title, players: this.s.players, teams: this.s.teams, coins: this.s.coins });
    }

    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (!this.s) return new Response("Rummet finns inte", { status: 404 });

    const role = (url.searchParams.get("role") ?? "player") as Conn["role"];
    if (role === "host" && url.searchParams.get("key") !== this.s.hostKey) {
      return new Response("fel hostnyckel", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const conn: Conn = { ws: server, role, msgBucket: bucket(MSG_BURST) };
    this.conns.add(conn);

    server.addEventListener("message", (ev) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (!take(conn.msgBucket, MSG_RATE_PER_S, MSG_BURST)) return;
      this.handle(conn, msg).catch((e) => this.send(conn, { t: "error", message: String(e) }));
    });
    const close = () => {
      this.conns.delete(conn);
      if (conn.playerId && this.s) {
        const p = this.s.players.find((x) => x.id === conn.playerId);
        const stillThere = [...this.conns].some((c) => c.playerId === conn.playerId);
        if (p && !stillThere) { p.connected = false; this.broadcast(); }
      }
    };
    server.addEventListener("close", close);
    server.addEventListener("error", close);

    this.send(conn, { t: "state", state: this.view(conn) });
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(c: Conn, m: ServerMsg) { try { c.ws.send(JSON.stringify(m)); } catch { /* stängd */ } }

  private view(c: Conn): PublicState | HostState {
    const s = this.s!;
    const q = s.qIndex >= 0 ? this.cur() : undefined;
    const col = s.collect;
    const base: PublicState = {
      code: s.code, title: s.title, phase: s.phase, players: s.players, qIndex: s.qIndex, qCount: s.questions.length,
      question: q && s.phase !== "lobby"
        ? { text: q.text, points: q.points ?? 1, category: q.category, imageUrl: q.imageUrl, mode: q.mode ?? "choice",
            ...(q.mode !== "skill" ? { difficulty: difficultyOf(q) } : {}),
            ...(q.mode === "choice" && col?.choices ? { choices: col.choices } : {}),
            ...(q.mode === "skill" && q.skill ? { skill: publicSkill(q, col?.seed ?? 0, s.phase === "reveal") } : {}) } : undefined,
      revealedAnswer: s.phase === "reveal" || s.phase === "finished" ? (q?.answer || undefined) : undefined,
      lastEvent: s.lastEvent, settings: s.settings, serverNow: Date.now(),
      collect: col && s.phase !== "finished" ? collectPublic(col, s.phase === "reveal") : undefined,
      wheel: s.wheel ?? null,
      teamMode: s.teamMode, teams: s.teams, wallets: s.wallets, coinsTonight: s.coins, coinLog: s.coinLog.slice(-12),
      effects: this.effects(),
      diffLeft: this.diffLeft(),
      ...(c.playerId && col?.removed?.[c.playerId] ? { myRemoved: col.removed[c.playerId] } : {}),
    };
    // Spelande värd: hostkontrollen får exakt samma som alla andra, inget facit och inga svar.
    if (c.role === "host" && !s.settings.hostPlays) {
      return { ...base, answer: q?.answer, collectHost: col ? collectHost(col) : undefined };
    }
    return base;
  }

  private broadcast() {
    for (const c of this.conns) this.send(c, { t: "state", state: this.view(c) });
  }

  // ===== Frågorna =====

  private clearCollectTimer() { if (this.collectTimer) { clearTimeout(this.collectTimer); this.collectTimer = null; } }

  private armCollectTimer() {
    this.clearCollectTimer();
    const c = this.s?.collect;
    if (!c) return;
    this.collectTimer = setTimeout(() => { void this.closeCollect(); }, Math.max(0, collectEnd(c) - Date.now()) + 50);
  }

  /** Aktuell fråga (qIndex är omgången, order mappar till frågan). */
  private cur(): Question {
    const s = this.s!;
    return s.questions[s.order[s.qIndex] ?? s.qIndex];
  }

  /**
   * Nästa fråga med svårighetsreglaget. 0 = setets ordning. Annars: ligger en skill-utmaning näst på tur i
   * setets ordning spelas den (så de håller sitt avstånd), annars den ospelade alternativfrågan vars
   * svårighet ligger närmast målet (vid lika: tidigast i setet).
   */
  private pickNext(): number | null {
    const s = this.s!;
    const played = new Set(s.order.slice(0, s.qIndex + 1));
    const left = s.questions.map((_, i) => i).filter((i) => !played.has(i));
    if (!left.length) return null;
    const target = s.settings.difficulty;
    if (!target || s.questions[left[0]].mode === "skill") return left[0];
    const choice = left.filter((i) => s.questions[i].mode !== "skill");
    if (!choice.length) return left[0];
    return choice.reduce((best, i) =>
      Math.abs(difficultyOf(s.questions[i]) - target) < Math.abs(difficultyOf(s.questions[best]) - target) ? i : best, choice[0]);
  }

  private diffLeft(): number[] {
    const s = this.s!;
    const played = new Set(s.order.slice(0, s.qIndex + 1));
    const out = [0, 0, 0, 0, 0];
    s.questions.forEach((q, i) => { if (!played.has(i) && q.mode !== "skill") out[difficultyOf(q) - 1] += 1; });
    return out;
  }

  /** Enheter som kan få turen: lag med någon ansluten spelare, eller anslutna spelare utan lag. */
  private units(): string[] {
    const s = this.s!;
    const on = new Set(s.players.filter((p) => p.connected).map((p) => p.id));
    if (s.teams.length) return s.teams.filter((t) => t.members.some((id) => on.has(id))).map((t) => t.id);
    return s.players.filter((p) => p.connected).map((p) => p.id);
  }
  private members(unit: string) {
    const s = this.s!;
    const t = s.teams.find((x) => x.id === unit);
    return t ? t.members : [unit];
  }
  private unitName(unit: string) {
    const s = this.s!;
    return s.teams.find((x) => x.id === unit)?.name ?? s.players.find((p) => p.id === unit)?.name ?? "?";
  }

  /**
   * Öppna aktuell fråga. Alternativfrågor: rätt svar plus (choiceCount − 1) slumpade fel, i slumpad ordning
   * (50/50-twisten tar bort hälften av felen, Blixt halverar tiden). Spelformen avgör vem som svarar:
   * alla samtidigt, ett lags tur (lagen roterar) eller buzzer (var buzzEvery:e alternativfråga).
   * Skill: slumpfrö och utmaningens egen tid, alla spelar.
   */
  private startQuestion() {
    const s = this.s!;
    const q = this.cur();
    const twist = activeTwist({ phase: "collect", qIndex: s.qIndex, wheel: s.wheel });
    if (q.mode === "skill" && q.skill) {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      s.collect = startCollect("skill", q.skill.seconds ?? SKILLS[q.skill.kind].seconds, Date.now(), seed);
    } else {
      const wrong = shuffled(q.choices!.filter((x) => x !== q.answer));
      // Svårighetsreglaget styr också antal alternativ och tid (nivå 0 = värdens egna inställningar).
      const rules = effectiveChoiceRules(s.settings);
      let n = Math.min(rules.choices - 1, wrong.length);
      if (twist === "fifty") n = Math.max(1, Math.ceil(n / 2));
      const secs = twist === "blitz" ? Math.max(MIN_COLLECT_MS / 1000, rules.seconds / 2) : rules.seconds;
      s.choiceRounds += 1;
      const buzz = s.settings.buzzEvery > 0 && s.choiceRounds % s.settings.buzzEvery === 0;
      const units = this.units();
      const format = buzz && units.length > 1 ? "buzz" : s.settings.playMode === "turns" && units.length > 1 ? "turn" : "all";
      s.collect = startCollect("choice", secs, Date.now(), undefined, format);
      s.collect.choices = shuffled([q.answer, ...wrong.slice(0, n)]);
      if (format === "turn") { s.collect.turn = units[s.turnIdx % units.length]; s.turnIdx += 1; }
      if (format === "buzz") { s.collect.buzzOpen = true; s.collect.lockedOut = []; s.collect.tried = []; }
    }
    // Extra tid och Sabotage: varje spelare får egen deadline.
    const base = s.collect.deadline - s.collect.startedAt;
    const extra = Object.fromEntries(s.players.map((p) => [p.id, Math.round(this.timeFor(p.id, base) - base)]).filter(([, ms]) => ms !== 0));
    if (Object.keys(extra).length) s.collect.extra = extra;
    s.phase = "collect";
    this.armCollectTimer();
  }

  /** Buzzerfråga: laget som svarat fel (eller för långsamt) får straff, låses ute och de andra kan buzza igen. */
  private async buzzWrong(answerText?: string) {
    const s = this.s!;
    const c = s.collect!;
    const unit = c.turn!;
    const d = -s.settings.penalty;
    for (const id of this.members(unit)) { const p = s.players.find((x) => x.id === id); if (p) p.score += d; this.streakReset(id); }
    if (answerText && !c.tried!.includes(answerText)) c.tried!.push(answerText);
    c.lockedOut = [...(c.lockedOut ?? []), unit];
    c.turn = undefined; c.answerDeadline = undefined;
    s.lastEvent = { kind: "buzzWrong", unit, delta: d, at: Date.now() };
    const remaining = this.units().filter((u) => !c.lockedOut!.includes(u));
    if (!remaining.length || Date.now() >= c.deadline) { this.judgeCollect(); await this.save(); return this.broadcast(); }
    c.buzzOpen = true;
    this.armCollectTimer();
    await this.save();
    this.broadcast();
  }

  /** Tiden ute, alla har svarat eller hosten stänger. */
  private async closeCollect() {
    const s = this.s!;
    this.clearCollectTimer();
    if (s.phase !== "collect" || !s.collect) return;
    const c = s.collect;
    // Buzzer: laget som buzzade hann inte svara = fel. Ingen buzzade i tid = svaret visas.
    if (c.format === "buzz" && c.turn) return this.buzzWrong();
    // Lagens tur och buzzer behöver ingen rättning av värden: visa svaret direkt.
    if (c.format === "turn" || c.format === "buzz") { this.judgeCollect(); await this.save(); return this.broadcast(); }
    s.collect.deadline = Math.min(s.collect.deadline, Date.now());
    s.phase = "judge";
    await this.save();
    this.broadcast();
  }

  /** Visa svaret: dela ut poäng (rättat automatiskt) och avslöja facit. */
  private judgeCollect() {
    const s = this.s!;
    const c = s.collect;
    if (!c || (s.phase !== "collect" && s.phase !== "judge")) return false;
    this.clearCollectTimer();
    if (s.phase === "collect") c.deadline = Math.min(c.deadline, Date.now());
    const q = this.cur();
    const twist = activeTwist(s);
    const mult = twist === "double" ? 2 : 1;
    if (c.format === "turn" || c.format === "buzz") {
      // Laget svarar tillsammans: rätt ger frågans poäng till alla i laget. Fel kostar inget i lagens tur
      // (frågan går bara vidare); fel buzzersvar har redan dragits i buzzWrong.
      const pts = (q?.points ?? 1) * mult;
      c.results = c.answers.map((a) => {
        const correct = a.text === q.answer;
        return { ...a, correct, fastest: false, delta: correct ? pts : c.format === "buzz" ? -s.settings.penalty : 0 };
      });
      for (const r of c.results) {
        if (!r.correct) continue;
        for (const id of this.members(this.unit(r.playerId))) {
          const p = s.players.find((x) => x.id === id);
          if (p) p.score += pts * this.multFor(id);
          this.onCorrect(id);
        }
      }
      s.phase = "reveal";
      s.lastEvent = { kind: "judged", correct: c.results.filter((r) => r.correct).flatMap((r) => this.members(this.unit(r.playerId))), at: Date.now() };
      return true;
    }
    c.results = c.mode === "skill" && q?.skill ? scoreSkill(c, q.skill, mult) : scoreAll(c, (q?.points ?? 1) * mult, s.settings);
    for (const r of c.results) {
      r.delta *= this.multFor(r.playerId);
      const p = s.players.find((x) => x.id === r.playerId);
      if (p) p.score += r.delta;
      if (c.mode === "skill") { if (r.place === 1) this.award(r.playerId, COINS.skillWin, "vann utmaningen"); }
      else if (r.correct) this.onCorrect(r.playerId); else this.streakReset(r.playerId);
    }
    // Stjäl: snabbaste rätt (eller vinnaren av utmaningen) tar frågans poäng från ledaren.
    const fastest = c.results.find((r) => r.fastest && r.delta > 0);
    const steal = twist === "steal" && fastest ? stealTarget(s.players, fastest.playerId, (q?.points ?? 1)) : null;
    if (steal) {
      steal.from.score -= steal.amount;
      const p = s.players.find((x) => x.id === fastest!.playerId);
      if (p) p.score += steal.amount;
    }
    s.phase = "reveal";
    s.lastEvent = { kind: "judged", correct: c.results.filter((r) => r.correct).map((r) => r.playerId),
      fastestId: fastest?.playerId, at: Date.now(),
      ...(steal ? { stolenFrom: steal.from.id, stolen: steal.amount, stealer: fastest!.playerId } : {}) };
    return true;
  }

  // ===== Lag, mynt och butik =====

  private hub() { return this.env.HUB.get(this.env.HUB.idFromName("global")); }
  private async hubCall(path: string, body: unknown): Promise<{ wallet?: Wallet; error?: string }> {
    try {
      const r = await this.hub().fetch(new Request("https://hub/hub" + path, { method: "POST", body: JSON.stringify(body) }));
      const data = await r.json<Wallet & { error?: string }>();
      return r.ok ? { wallet: data } : { error: data.error ?? "Butiken svarar inte" };
    } catch { return { error: "Butiken svarar inte" }; }
  }

  private unit(pid: string) { return unitOf(this.s!.teams, pid); }

  /** Vilken fråga butikseffekter gäller nu: pågående fråga, eller nästa mellan frågorna. */
  private effectQ() {
    const s = this.s!;
    return s.phase === "lobby" || s.phase === "reveal" ? s.qIndex + 1 : s.qIndex;
  }

  private effects(): Effects {
    const s = this.s!;
    const q = this.effectQ();
    return { forQ: q, extra: [...new Set(s.extraBuyers.filter((id) => s.players.some((p) => p.id === id)).map((id) => this.unit(id)))],
      double: s.doubleFor[q] ?? [], sabotage: s.sabotageFor[q] ?? [] };
  }

  /** Tid för en spelare på aktuell fråga: +5 s med Extra tid, halverad om laget saboteras. */
  private timeFor(pid: string, baseMs: number) {
    const s = this.s!;
    const u = this.unit(pid);
    let ms = baseMs;
    if (s.extraBuyers.some((id) => this.unit(id) === u)) ms += EXTRA_TIME_MS;
    if ((s.sabotageFor[s.qIndex] ?? []).includes(u)) ms = Math.max(MIN_COLLECT_MS, ms / 2);
    return ms;
  }

  private multFor(pid: string) { return (this.s!.doubleFor[this.s!.qIndex] ?? []).includes(this.unit(pid)) ? 2 : 1; }

  private award(pid: string, n: number, why: string) {
    const s = this.s!;
    s.coins[pid] = (s.coins[pid] ?? 0) + n;
    s.coinLog.push({ playerId: pid, n, why, at: Date.now() });
    if (s.coinLog.length > 40) s.coinLog.splice(0, s.coinLog.length - 40);
  }
  private onCorrect(pid: string) {
    const s = this.s!;
    this.award(pid, COINS.correct, "rätt svar");
    s.streak[pid] = (s.streak[pid] ?? 0) + 1;
    if (s.streak[pid] >= COINS.streakLen) { this.award(pid, COINS.streak, `${COINS.streakLen} rätt i rad`); s.streak[pid] = 0; }
  }
  private streakReset(pid: string) { this.s!.streak[pid] = 0; }

  /** Slumpa lag. avoid: spelaren som lade veto ska inte hamna med samma lagkamrater. */
  private drawTeams(avoid?: { pid: string; mates: string[] }) {
    const s = this.s!;
    if (!s.teamMode) { s.teams = []; return; }
    let groups: string[][] = [];
    for (let i = 0; i < 80; i++) {
      groups = splitTeams(shuffled(s.players.map((p) => p.id)), s.teamMode);
      if (!avoid) break;
      const mine = groups.find((g) => g.includes(avoid.pid)) ?? [];
      if (!mine.some((id) => avoid.mates.includes(id))) break;
    }
    const names = shuffled(TEAM_NAMES);
    s.teams = groups.map((members, i) => ({ id: "t" + i + "-" + Date.now().toString(36), name: names[i % names.length], color: TEAM_COLORS[i % TEAM_COLORS.length], members }));
    // Effekter för kommande frågor siktade på gamla lag-id gäller inte längre.
    s.doubleFor = {}; s.sabotageFor = {};
  }

  /** Ny spelare när lagen redan är slumpade: in i minsta laget. */
  private placeInTeam(pid: string) {
    const s = this.s!;
    if (!s.teamMode || !s.teams.length || s.teams.some((t) => t.members.includes(pid))) return;
    [...s.teams].sort((a, b) => a.members.length - b.members.length)[0].members.push(pid);
  }

  private async shop(c: Conn, m: Extract<ClientMsg, { t: "buy" | "use" }>) {
    const s = this.s!;
    const pid = c.playerId;
    const p = pid ? s.players.find((x) => x.id === pid) : undefined;
    if (!pid || !p) return;
    const err = (message: string) => this.send(c, { t: "error", message });

    if (m.t === "buy") {
      const item = m.item as ShopItem;
      if (!SHOP[item]) return err("Okänd vara");
      if (s.phase !== "lobby") return err("Butiken är bara öppen i lobbyn");
      if (item === "extra" && s.extraBuyers.some((id) => this.unit(id) === this.unit(pid))) return err("Ditt lag har redan Extra tid i kväll");
      if (item === "veto" && !s.teams.length) return err("Det finns inga lag att lägga veto mot än");
      const mates = s.teams.find((t) => t.members.includes(pid))?.members.filter((id) => id !== pid) ?? [];
      const r = await this.hubCall("/wallet/buy", { name: p.name, item });
      if (r.error) return err(r.error);
      s.wallets[pid] = r.wallet!;
      if (item === "extra") s.extraBuyers.push(pid);
      if (item === "veto") this.drawTeams({ pid, mates });
      await this.save();
      return this.broadcast();
    }

    const item = m.item as TokenItem;
    if (item === "fifty") {
      const col = s.collect;
      if (s.phase !== "collect" || !col?.choices) return err("50/50 används under en fråga med alternativ");
      if (col.answers.some((a) => a.playerId === pid)) return err("Du har redan svarat");
      if (col.removed?.[pid]) return err("Du har redan använt 50/50 på den här frågan");
      const q = this.cur();
      const wrong = col.choices.filter((x) => x !== q.answer);
      if (wrong.length < 2) return err("Det finns för få fel alternativ kvar");
      const r = await this.hubCall("/wallet/use", { name: p.name, item });
      if (r.error) return err(r.error);
      s.wallets[pid] = r.wallet!;
      col.removed = { ...col.removed, [pid]: shuffled(wrong).slice(0, Math.floor(wrong.length / 2)) };
      await this.save();
      return this.broadcast();
    }
    if (item !== "double" && item !== "sabotage") return err("Okänd vara");
    if (s.phase !== "lobby" && s.phase !== "reveal") return err("Aktivera mellan frågorna");
    const q = this.effectQ();
    if (q >= s.questions.length) return err("Det finns ingen nästa fråga");
    const own = this.unit(pid);
    if (item === "double") {
      if ((s.doubleFor[q] ?? []).includes(own)) return err("Dubbla poäng är redan aktiverat för nästa fråga");
    } else {
      const units = s.teams.length ? s.teams.map((t) => t.id) : s.players.map((x) => x.id);
      if (!m.target || !units.includes(m.target) || m.target === own) return err("Välj ett annat lag att sabotera");
      if ((s.sabotageFor[q] ?? []).includes(m.target)) return err("De är redan saboterade på nästa fråga");
    }
    const r = await this.hubCall("/wallet/use", { name: p.name, item });
    if (r.error) return err(r.error);
    s.wallets[pid] = r.wallet!;
    if (item === "double") s.doubleFor[q] = [...(s.doubleFor[q] ?? []), own];
    else s.sabotageFor[q] = [...(s.sabotageFor[q] ?? []), m.target!];
    await this.save();
    this.broadcast();
  }

  /** Stäng frågan direkt när alla anslutna har svarat. */
  private async afterAnswer() {
    const s = this.s!;
    const waiting = s.players.filter((x) => x.connected && !s.collect!.answers.some((a) => a.playerId === x.id));
    if (waiting.length === 0) return this.closeCollect();
    await this.save();
    this.broadcast();
  }

  private async handle(c: Conn, m: ClientMsg) {
    const s = this.s!;
    if (m.t === "ping") return this.send(c, { t: "pong", c: m.c, s: Date.now() });

    if (m.t === "join") {
      const name = String(m.name ?? "").trim().slice(0, 20);
      if (!name) return this.send(c, { t: "error", message: "Skriv ett namn" });
      let p = m.playerId ? s.players.find((x) => x.id === m.playerId) : undefined;
      if (!p) p = s.players.find((x) => x.name.toLowerCase() === name.toLowerCase() && !x.connected);
      if (!p) {
        if (s.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          return this.send(c, { t: "error", message: "Namnet är upptaget i rummet" });
        }
        p = { id: crypto.randomUUID(), name, color: COLORS[s.players.length % COLORS.length], score: 0, connected: true };
        s.players.push(p);
      }
      p.connected = true;
      if (c.role !== "host") c.role = "player";
      c.playerId = p.id;
      this.placeInTeam(p.id);
      this.send(c, { t: "joined", playerId: p.id });
      const w = await this.hubCall("/wallet/get", { name: p.name });
      if (w.wallet) s.wallets[p.id] = w.wallet;
      await this.save();
      return this.broadcast();
    }

    if (m.t === "answer") {
      const col = s.collect;
      if (!c.playerId || !col || col.mode !== "choice") return;
      if (s.phase !== "collect") return s.phase === "judge" ? this.send(c, { t: "error", message: "Tiden är ute" }) : undefined;
      if (!s.players.some((x) => x.id === c.playerId)) return;
      const text = String(m.text ?? "").trim();
      if (!col.choices?.includes(text)) return this.send(c, { t: "error", message: "Välj ett av alternativen" });
      const unit = this.unit(c.playerId);
      if (col.format === "turn" && col.turn !== unit) return this.send(c, { t: "error", message: `Det är ${this.unitName(col.turn!)}s tur` });
      if (col.format === "turn" && col.answers.length) return this.send(c, { t: "error", message: "Ditt lag har redan svarat" });
      if (col.format === "buzz") {
        if (col.turn !== unit) return this.send(c, { t: "error", message: col.turn ? `${this.unitName(col.turn)} svarar` : "Buzza först" });
        if (col.answerDeadline && Date.now() > col.answerDeadline + 500) return this.send(c, { t: "error", message: "Tiden är ute" });
        if (col.tried?.includes(text)) return this.send(c, { t: "error", message: "Det alternativet är redan prövat" });
      }
      const err = submitAnswer(col, c.playerId, text);
      if (err) return this.send(c, { t: "error", message: err });
      const right = text === this.cur().answer;
      if (right) markAnswer(col, c.playerId, true);
      if (col.format === "turn") { this.clearCollectTimer(); this.judgeCollect(); await this.save(); return this.broadcast(); }
      if (col.format === "buzz") {
        this.clearCollectTimer();
        if (right) { this.judgeCollect(); await this.save(); return this.broadcast(); }
        return this.buzzWrong(text);
      }
      return this.afterAnswer();
    }

    if (m.t === "buzz") {
      const col = s.collect;
      if (!c.playerId || !col || col.format !== "buzz" || s.phase !== "collect" || !col.buzzOpen) return;
      if (!s.players.some((x) => x.id === c.playerId)) return;
      const unit = this.unit(c.playerId);
      if (col.lockedOut?.includes(unit)) return this.send(c, { t: "error", message: "Ert lag är utlåst på den här frågan" });
      const now = Date.now();
      const ms = this.timeFor(c.playerId, s.settings.buzzAnswerSeconds * 1000);
      col.buzzOpen = false; col.turn = unit; col.answerDeadline = now + ms;
      col.deadline = Math.max(col.deadline, now) + ms; // de andra får tillbaka tiden som gick åt
      s.lastEvent = { kind: "buzzed", unit, playerId: c.playerId, at: now };
      this.armCollectTimer();
      await this.save();
      return this.broadcast();
    }

    if (m.t === "skill") {
      const q = this.cur();
      if (!c.playerId || !s.collect || s.collect.mode !== "skill" || !q?.skill) return;
      if (s.phase !== "collect") return s.phase === "judge" ? this.send(c, { t: "error", message: "Tiden är ute" }) : undefined;
      if (!s.players.some((x) => x.id === c.playerId)) return;
      const err = submitSkill(s.collect, q.skill, c.playerId, m);
      if (err) return this.send(c, { t: "error", message: err });
      return this.afterAnswer();
    }

    if (m.t === "buy" || m.t === "use") return this.shop(c, m);

    if (c.role !== "host") return this.send(c, { t: "error", message: "Bara hosten kan göra det" });

    switch (m.t) {
      case "host:start":
      case "host:next": {
        if (s.phase === "collect" || s.phase === "judge") return this.send(c, { t: "error", message: "Visa svaret först" });
        this.clearCollectTimer();
        const next = this.pickNext();
        if (next === null) { s.phase = "finished"; s.collect = null; s.lastEvent = { kind: "finished", at: Date.now() }; }
        else { s.qIndex += 1; s.order[s.qIndex] = next; s.lastEvent = undefined; }
        // Twisten gäller bara frågan den snurrades för.
        if (s.wheel && (s.phase === "finished" || s.wheel.forQ < s.qIndex)) s.wheel = null;
        if (s.phase !== "finished") this.startQuestion();
        break;
      }
      case "host:judge": { if (!this.judgeCollect()) return; break; }
      case "host:close": return this.closeCollect();
      case "host:adjust": {
        const p = s.players.find((x) => x.id === m.playerId); if (p) p.score += m.delta; break;
      }
      case "host:teams": {
        if (s.phase !== "lobby") return this.send(c, { t: "error", message: "Lagen slumpas i lobbyn" });
        s.teamMode = m.mode === 2 || m.mode === 3 ? m.mode : 0;
        this.drawTeams();
        break;
      }
      case "host:kick": {
        s.players = s.players.filter((x) => x.id !== m.playerId);
        for (const t of s.teams) t.members = t.members.filter((id) => id !== m.playerId);
        for (const cc of this.conns) if (cc.playerId === m.playerId) { try { cc.ws.close(4000, "kicked"); } catch {} }
        break;
      }
      case "host:settings": {
        const n = m.settings ?? {};
        // Spelande värd kan slås på när som helst, men av bara i lobbyn (annars kan man fuska fram facit).
        if (n.hostPlays === false && s.settings.hostPlays && s.phase !== "lobby") {
          return this.send(c, { t: "error", message: "Du spelar själv i kväll: facit kan bara visas om du stänger av det innan start" });
        }
        s.settings = clampSettings({ ...s.settings, ...Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined && v !== null)) });
        break;
      }
      case "host:spin": {
        if (s.phase !== "lobby" && s.phase !== "reveal") return this.send(c, { t: "error", message: "Hjulet kan bara snurras mellan frågorna" });
        if (s.qIndex + 1 >= s.questions.length) return this.send(c, { t: "error", message: "Det finns ingen nästa fråga att snurra för" });
        const peek = this.pickNext();
        const nextSkill = peek !== null && s.questions[peek].mode === "skill";
        s.wheel = spinWheel(s.wheel, s.qIndex + 1, Date.now(), nextSkill ? (t) => SKILL_TWISTS.includes(t) : undefined);
        break;
      }
      case "host:finish": {
        this.clearCollectTimer(); s.wheel = null; s.phase = "finished"; s.collect = null; s.lastEvent = { kind: "finished", at: Date.now() };
        break;
      }
      case "host:mark": {
        if (s.settings.hostPlays) return this.send(c, { t: "error", message: "Rättningen är automatisk när du spelar själv" });
        if (!s.collect || (s.phase !== "collect" && s.phase !== "judge")) return;
        markAnswer(s.collect, m.playerId, !!m.correct);
        break;
      }
      default: return;
    }
    await this.save();
    this.broadcast();
  }
}
