import type {
  ClientMsg, GameEvent, HostState, Phase, PlayerPublic, PublicState, Question, ServerMsg, Settings,
} from "../shared/types";
import {
  BUZZ_BURST, BUZZ_JITTER_MS, BUZZ_MAX_COMP_MS, BUZZ_RATE_PER_S, DEFAULT_SETTINGS, BUZZ_WINDOW_MS, MSG_BURST, MSG_RATE_PER_S,
  isCollectMode, activeTwist, answerSecondsFor, validChoices,
} from "../shared/types";
import {
  type CollectServer, collectHost, collectPublic, markAnswer, scoreAll, scoreSkill, startCollect, submitAnswer, submitSkill,
} from "./collect";
import { SKILLS, correctOrder, orderShuffle, validSkill } from "../shared/skill";
import type { WheelState } from "../shared/types";
import { spinWheel, stealTarget } from "./wheel";
import { collectEnd } from "./collect";
import {
  COINS, EXTRA_TIME_MS, SHOP, TEAM_COLORS, TEAM_NAMES, type CoinNote, type Effects, type ShopItem, type Team,
  type TeamMode, type TokenItem, type Wallet, splitTeams, unitOf,
} from "../shared/teams";

interface Env { HUB: DurableObjectNamespace }
const shuffled = <T,>(xs: T[]) => {
  const a = [...xs];
  const r = crypto.getRandomValues(new Uint32Array(a.length));
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const COLORS = ["#FF5D73", "#FFD23F", "#3DDC97", "#4CC9F0", "#B388FF", "#FF9F45", "#F15BB5", "#9EF01A"];

interface Player extends PlayerPublic {}
interface Conn {
  ws: WebSocket; role: "host" | "tv" | "player"; playerId?: string;
  /** Senaste RTT-mätningarna (ms); lägsta används, så fördröjda spong inte blåser upp kompensationen. */
  rtts: number[];
  /** Utestående sping: bara spong med exakt detta s godtas, och bara en gång. */
  pingS?: number;
  /** Rate-limit: token buckets för alla meddelanden resp. buzzar. */
  msgBucket: Bucket; buzzBucket: Bucket;
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
const RTT_SAMPLES = 5;
const minRtt = (c: Conn) => (c.rtts.length ? Math.min(...c.rtts) : undefined);

/**
 * Hur mycket tidigare än ankomsten en buzz får räknas. Klientens påstådda fördröjning (ankomst - at)
 * godtas bara upp till serverns egen mätning av (lägsta) RTT/2 plus lite brus, och aldrig mer än BUZZ_MAX_COMP_MS.
 */
export function buzzCompensation(arrival: number, at: number | undefined, rtt: number | undefined): number {
  if (typeof at !== "number" || !Number.isFinite(at)) return 0;
  const max = Math.min(BUZZ_MAX_COMP_MS, (rtt ?? 0) / 2 + BUZZ_JITTER_MS);
  return Math.max(0, Math.min(max, arrival - at));
}

interface Persisted {
  code: string;
  title: string;
  phase: Phase;
  players: Player[];
  questions: Question[];
  qIndex: number;
  buzz: { playerId: string; deadline: number; typedAnswer?: string } | null;
  lockedOut: string[];
  settings: Settings;
  lastEvent?: GameEvent;
  hostKey: string;
  /** Pågående/senaste insamlingsrunda för aktuell fråga (null för buzz-frågor). */
  collect?: CollectServer | null;
  wheel?: WheelState | null;
  // Lag och mynt (rum skapade före lagen fylls på i konstruktorn).
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
}

const TEAM_DEFAULTS = (): Pick<Persisted, "teamMode" | "teams" | "wallets" | "coins" | "coinLog" | "streak" | "extraBuyers" | "doubleFor" | "sabotageFor"> => ({
  teamMode: 0, teams: [], wallets: {}, coins: {}, coinLog: [], streak: {}, extraBuyers: [], doubleFor: {}, sabotageFor: {},
});

/** Okänd mode blir buzz. En choice-fråga utan giltiga alternativ blir också buzz (muntligt). */
export function normalizeQuestion(q: Question): Question {
  if (q.mode === "skill") {
    const skill = validSkill(q.skill);
    if (skill) {
      const answer = skill.kind === "order" ? correctOrder(skill.items!).map((i) => i.label).join(" → ") : "";
      return { ...q, answer, skill, choices: undefined };
    }
    return { ...q, mode: undefined, skill: undefined, choices: undefined, answer: q.answer || "–" };
  }
  if (q.mode === "choice") {
    const choices = validChoices(q);
    return choices ? { ...q, answer: q.answer.trim(), choices, skill: undefined } : { ...q, mode: undefined, choices: undefined, skill: undefined };
  }
  return { ...q, mode: isCollectMode(q.mode) ? q.mode : undefined, choices: undefined, skill: undefined };
}

/** Skill-specen som spelarna får: sakerna i "Ordna rätt" blandade och utan värden tills reveal. */
function publicSkill(q: Question, seed: number, revealed: boolean) {
  const sk = q.skill!;
  if (sk.kind !== "order") return sk;
  return { ...sk, items: revealed ? correctOrder(sk.items!) : orderShuffle(sk.items!, seed).map((i) => ({ label: i.label })) };
}

export class Room implements DurableObject {
  private s: Persisted | null = null;
  private conns = new Set<Conn>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Buzzar som samlas under fönstret efter första buzz: playerId -> justerad tid. */
  private pending: { cands: Map<string, number>; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Stänger insamlingen när tiden gått ut. */
  private collectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: DurableObjectState, private env: Env) {
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Persisted>("s")) ?? null;
      if (this.s) {
        this.s.settings = { ...DEFAULT_SETTINGS, ...this.s.settings }; // rum skapade före nya inställningar
        this.s = { ...TEAM_DEFAULTS(), ...this.s };
        // Insamling som pågick när objektet sövdes: stäng den direkt eller vid deadline.
        if (this.s.phase === "collect" && this.s.collect) this.armCollectTimer();
      }
    });
  }

  private async save() { if (this.s) await this.ctx.storage.put("s", this.s); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/init") && req.method === "POST") {
      const body = await req.json<{ code: string; title: string; questions: Question[]; hostKey: string; settings?: Partial<Settings> }>();
      this.s = {
        code: body.code, title: body.title, phase: "lobby", players: [],
        questions: body.questions.map(normalizeQuestion),
        qIndex: -1, buzz: null, lockedOut: [], settings: { ...DEFAULT_SETTINGS, ...body.settings }, hostKey: body.hostKey,
        ...TEAM_DEFAULTS(),
      };
      await this.save();
      return Response.json({ ok: true });
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
    const conn: Conn = { ws: server, role, rtts: [], msgBucket: bucket(MSG_BURST), buzzBucket: bucket(BUZZ_BURST) };
    this.conns.add(conn);

    server.addEventListener("message", (ev) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg?.t !== "spong" && !take(conn.msgBucket, MSG_RATE_PER_S, MSG_BURST)) return;
      if (msg?.t === "buzz" && !take(conn.buzzBucket, BUZZ_RATE_PER_S, BUZZ_BURST)) return;
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

    this.send(conn, { t: "state", state: this.view(role) });
    this.sping(conn);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(c: Conn, m: ServerMsg) { try { c.ws.send(JSON.stringify(m)); } catch { /* stängd */ } }

  private view(role: Conn["role"]): PublicState | HostState {
    const s = this.s!;
    const q = s.questions[s.qIndex];
    const base: PublicState = {
      code: s.code, title: s.title, phase: s.phase, players: s.players, qIndex: s.qIndex, qCount: s.questions.length,
      question: q && s.phase !== "lobby"
        ? { text: q.text, points: q.points ?? 1, category: q.category, imageUrl: q.imageUrl, mode: q.mode ?? "buzz",
            ...(q.mode === "choice" ? { choices: q.choices } : {}),
            ...(q.mode === "skill" && q.skill ? { skill: publicSkill(q, s.collect?.seed ?? 0, s.phase === "reveal") } : {}) } : undefined,
      revealedAnswer: s.phase === "reveal" || s.phase === "finished" ? (q?.answer || undefined) : undefined,
      buzz: s.buzz, lockedOut: s.lockedOut, lastEvent: s.lastEvent, settings: s.settings, serverNow: Date.now(),
      collect: s.collect && s.phase !== "finished" ? collectPublic(s.collect, s.phase === "reveal") : undefined,
      wheel: s.wheel ?? null,
      teamMode: s.teamMode, teams: s.teams, wallets: s.wallets, coinsTonight: s.coins, coinLog: s.coinLog.slice(-12),
      effects: this.effects(),
    };
    if (role === "host") return { ...base, answer: q?.answer, collectHost: s.collect ? collectHost(s.collect) : undefined };
    return base;
  }

  private broadcast() {
    for (const c of this.conns) this.send(c, { t: "state", state: this.view(c.role) });
  }

  /** Servern mäter själv RTT, så klienten inte kan ljuga om sin ping. */
  private sping(c: Conn) {
    const now = Date.now();
    if (c.pingS !== undefined && now - c.pingS < 3000) return; // en mätning i taget
    c.pingS = now;
    this.send(c, { t: "sping", s: now });
  }

  private clearPending() { if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; } }

  /** Fönstret är slut: lägst justerad tid vinner (vid lika vinner den som kom först). */
  private async resolveBuzz() {
    const s = this.s!;
    const cands = this.pending?.cands;
    this.pending = null;
    if (!cands || s.phase !== "question" || s.buzz) return;
    let winner: string | null = null;
    let best = Infinity;
    for (const [pid, t] of cands) {
      if (s.lockedOut.includes(pid) || !s.players.some((x) => x.id === pid)) continue;
      if (t < best) { best = t; winner = pid; }
    }
    if (!winner) return;
    const secs = answerSecondsFor(s);
    const deadline = Date.now() + this.timeFor(winner, secs * 1000);
    s.buzz = { playerId: winner, deadline };
    s.phase = "buzzed";
    s.lastEvent = { kind: "buzz", playerId: winner, at: Date.now() };
    // Ingen automatisk timeout: spelaren har ordet tills hosten dömer rätt, fel eller för långsam.
    this.clearTimer();
    await this.save();
    this.broadcast();
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  // ===== Hemlig svarsinsamling (Alla svarar m.fl.) =====

  private clearCollectTimer() { if (this.collectTimer) { clearTimeout(this.collectTimer); this.collectTimer = null; } }

  private armCollectTimer() {
    this.clearCollectTimer();
    const c = this.s?.collect;
    if (!c) return;
    this.collectTimer = setTimeout(() => { void this.closeCollect(); }, Math.max(0, collectEnd(c) - Date.now()) + 50);
  }

  /** Aktuell fråga är en insamlingsrunda: öppna insamlingen. Returnerar false för vanliga buzz-frågor. */
  private maybeStartCollect(): boolean {
    const s = this.s!;
    const q = s.questions[s.qIndex];
    if (!q || !isCollectMode(q.mode)) { s.collect = null; return false; }
    if (q.mode === "skill" && q.skill) {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      s.collect = startCollect("skill", q.skill.seconds ?? SKILLS[q.skill.kind].seconds, Date.now(), seed);
    } else s.collect = startCollect(q.mode, s.settings.collectSeconds);
    // Extra tid och Sabotage: varje spelare får egen deadline.
    const base = s.collect.deadline - s.collect.startedAt;
    const extra = Object.fromEntries(s.players.map((p) => [p.id, Math.round(this.timeFor(p.id, base) - base)]).filter(([, ms]) => ms !== 0));
    if (Object.keys(extra).length) s.collect.extra = extra;
    s.phase = "collect";
    this.armCollectTimer();
    return true;
  }

  /** Tiden ute, alla har svarat eller hosten stänger: gå till rättning. */
  private async closeCollect() {
    const s = this.s!;
    this.clearCollectTimer();
    if (s.phase !== "collect" || !s.collect) return;
    s.collect.deadline = Math.min(s.collect.deadline, Date.now());
    s.phase = "judge";
    await this.save();
    this.broadcast();
  }

  /** Hosten bekräftar rättningen: dela ut poäng och visa svaren. */
  private judgeCollect() {
    const s = this.s!;
    const c = s.collect;
    if (!c || (s.phase !== "collect" && s.phase !== "judge")) return false;
    this.clearCollectTimer();
    if (s.phase === "collect") c.deadline = Math.min(c.deadline, Date.now());
    const q = s.questions[s.qIndex];
    const mult = activeTwist(s) === "double" ? 2 : 1;
    c.results = c.mode === "skill" && q?.skill ? scoreSkill(c, q.skill, mult) : scoreAll(c, (q?.points ?? 1) * mult, s.settings);
    for (const r of c.results) {
      r.delta *= this.multFor(r.playerId);
      const p = s.players.find((x) => x.id === r.playerId);
      if (p) p.score += r.delta;
      if (c.mode === "skill") { if (r.place === 1) this.award(r.playerId, COINS.skillWin, "vann utmaningen"); }
      else if (r.correct) this.onCorrect(r.playerId); else this.streakReset(r.playerId);
    }
    s.phase = "reveal";
    s.lastEvent = { kind: "judged", correct: c.results.filter((r) => r.correct).map((r) => r.playerId),
      fastestId: c.results.find((r) => r.fastest)?.playerId, at: Date.now() };
    return true;
  }

  private delta(sign: 1 | -1) {
    const q = this.s!.questions[this.s!.qIndex];
    const twist = activeTwist(this.s!);
    if (sign === 1) return (q?.points ?? 1) * (twist === "double" ? 2 : 1);
    return twist === "safe" ? 0 : -this.s!.settings.penalty;
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
    if ((s.sabotageFor[s.qIndex] ?? []).includes(u)) ms /= 2;
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

  /** Fel, för långsam eller pass: dra poäng (inte vid pass), lås ute spelaren, öppna för andra att buzza. */
  private async punish(kind: "wrong" | "timeout" | "pass") {
    const s = this.s!;
    if (s.phase !== "buzzed" || !s.buzz) return;
    this.clearTimer();
    const pid = s.buzz.playerId;
    const d = kind === "pass" ? 0 : this.delta(-1);
    if (kind !== "pass") this.streakReset(pid);
    const p = s.players.find((x) => x.id === pid);
    if (p) p.score += d;
    s.lockedOut.push(pid);
    s.buzz = null;
    s.lastEvent = { kind, playerId: pid, delta: d, at: Date.now() };
    const eligible = s.players.filter((x) => x.connected && !s.lockedOut.includes(x.id));
    s.phase = eligible.length === 0 ? "reveal" : "question";
    await this.save();
    this.broadcast();
  }

  private async shop(c: Conn, m: Extract<ClientMsg, { t: "buy" | "use" | "pass" }>) {
    const s = this.s!;
    const pid = c.playerId;
    const p = pid ? s.players.find((x) => x.id === pid) : undefined;
    if (!pid || !p) return;
    const err = (message: string) => this.send(c, { t: "error", message });

    if (m.t === "pass") {
      if (s.phase !== "buzzed" || s.buzz?.playerId !== pid) return err("Du har inte ordet");
      const r = await this.hubCall("/wallet/use", { name: p.name, item: "pass" });
      if (r.error) return err(r.error);
      s.wallets[pid] = r.wallet!;
      return this.punish("pass");
    }

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
    } else {
      const item = m.item as TokenItem;
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
    }
    await this.save();
    this.broadcast();
  }

  private async handle(c: Conn, m: ClientMsg) {
    const s = this.s!;
    if (m.t === "ping") { this.send(c, { t: "pong", c: m.c, s: Date.now() }); return this.sping(c); }
    if (m.t === "spong") {
      if (c.pingS === undefined || m.s !== c.pingS) return; // förfalskat eller redan använt s
      c.rtts.push(Date.now() - c.pingS);
      if (c.rtts.length > RTT_SAMPLES) c.rtts.shift();
      c.pingS = undefined;
      return;
    }

    if (m.t === "join") {
      const name = m.name.trim().slice(0, 20);
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
      c.role = "player"; c.playerId = p.id;
      this.placeInTeam(p.id);
      this.send(c, { t: "joined", playerId: p.id });
      this.sping(c);
      const w = await this.hubCall("/wallet/get", { name: p.name });
      if (w.wallet) s.wallets[p.id] = w.wallet;
      await this.save();
      return this.broadcast();
    }

    if (m.t === "buzz") {
      if (!c.playerId || s.phase !== "question" || s.buzz) return;
      if (s.lockedOut.includes(c.playerId)) return;
      const now = Date.now();
      const adjusted = now - buzzCompensation(now, m.at, minRtt(c));
      if (!this.pending) {
        this.pending = { cands: new Map(), timer: setTimeout(() => { this.resolveBuzz(); }, BUZZ_WINDOW_MS) };
      }
      if (!this.pending.cands.has(c.playerId)) this.pending.cands.set(c.playerId, adjusted);
      return;
    }

    if (m.t === "answer") {
      if (!c.playerId || !s.collect || s.collect.mode === "skill") return;
      if (s.phase !== "collect") return s.phase === "judge" ? this.send(c, { t: "error", message: "Tiden är ute" }) : undefined;
      if (!s.players.some((x) => x.id === c.playerId)) return;
      const q = s.questions[s.qIndex];
      const choices = s.collect.mode === "choice" ? q?.choices : undefined;
      if (choices && !choices.includes(String(m.text ?? "").trim())) return this.send(c, { t: "error", message: "Välj ett av alternativen" });
      const err = submitAnswer(s.collect, c.playerId, m.text);
      if (err) return this.send(c, { t: "error", message: err });
      // Svarsalternativ rättas automatiskt; hosten kan ändra innan hen bekräftar.
      if (choices && String(m.text).trim() === q!.answer) markAnswer(s.collect, c.playerId, true);
      const waiting = s.players.filter((x) => x.connected && !s.collect!.answers.some((a) => a.playerId === x.id));
      if (waiting.length === 0) return this.closeCollect();
      await this.save();
      return this.broadcast();
    }

    if (m.t === "skill") {
      const q = s.questions[s.qIndex];
      if (!c.playerId || !s.collect || s.collect.mode !== "skill" || !q?.skill) return;
      if (s.phase !== "collect") return s.phase === "judge" ? this.send(c, { t: "error", message: "Tiden är ute" }) : undefined;
      if (!s.players.some((x) => x.id === c.playerId)) return;
      const err = submitSkill(s.collect, q.skill, c.playerId, m);
      if (err) return this.send(c, { t: "error", message: err });
      const waiting = s.players.filter((x) => x.connected && !s.collect!.answers.some((a) => a.playerId === x.id));
      if (waiting.length === 0) return this.closeCollect();
      await this.save();
      return this.broadcast();
    }

    if (m.t === "buy" || m.t === "use" || m.t === "pass") return this.shop(c, m);

    if (m.t === "type") {
      if (s.buzz && s.buzz.playerId === c.playerId) { s.buzz.typedAnswer = m.text.slice(0, 120); this.broadcast(); }
      return;
    }

    if (c.role !== "host") return this.send(c, { t: "error", message: "Bara hosten kan göra det" });

    switch (m.t) {
      case "host:start":
      case "host:next": {
        this.clearTimer(); this.clearPending(); this.clearCollectTimer();
        if (s.qIndex + 1 >= s.questions.length) { s.phase = "finished"; s.buzz = null; s.lockedOut = []; s.lastEvent = { kind: "finished", at: Date.now() }; }
        else { s.qIndex += 1; s.phase = "question"; s.buzz = null; s.lockedOut = []; s.lastEvent = undefined; }
        // Twisten gäller bara frågan den snurrades för.
        if (s.wheel && (s.phase === "finished" || s.wheel.forQ < s.qIndex)) s.wheel = null;
        if (s.phase !== "finished") this.maybeStartCollect();
        break;
      }
      case "host:correct": {
        if (s.phase !== "buzzed" || !s.buzz) return;
        this.clearTimer();
        const d = this.delta(1) * this.multFor(s.buzz.playerId);
        this.onCorrect(s.buzz.playerId);
        const steal = activeTwist(s) === "steal" ? stealTarget(s.players, s.buzz.playerId, d) : null;
        const p = s.players.find((x) => x.id === s.buzz!.playerId);
        if (p) p.score += d;
        if (steal) steal.from.score -= steal.amount;
        s.lastEvent = { kind: "correct", playerId: s.buzz.playerId, delta: d, at: Date.now(),
          ...(steal ? { stolenFrom: steal.from.id, stolen: steal.amount } : {}) };
        s.phase = "reveal";
        break;
      }
      case "host:wrong": return this.punish("wrong");
      case "host:slow": return this.punish("timeout");
      case "host:reveal": {
        // I insamlingsrundor betyder "visa svaret" nästa steg: stäng insamlingen, sedan bekräfta rättningen.
        if (s.phase === "collect") return this.closeCollect();
        if (s.phase === "judge") { this.judgeCollect(); break; }
        this.clearTimer(); this.clearPending(); s.buzz = null; s.phase = "reveal"; s.lastEvent = { kind: "reveal", at: Date.now() };
        break;
      }
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
        const n = m.settings;
        if (n.answerSeconds) s.settings.answerSeconds = Math.max(3, Math.min(60, Math.round(n.answerSeconds)));
        if (n.penalty !== undefined) s.settings.penalty = Math.max(0, Math.min(10, Math.round(n.penalty)));
        if (n.collectSeconds) s.settings.collectSeconds = Math.max(5, Math.min(180, Math.round(n.collectSeconds)));
        if (n.fastestBonus !== undefined) s.settings.fastestBonus = Math.max(0, Math.min(5, Math.round(n.fastestBonus)));
        break;
      }
      case "host:spin": {
        if (s.phase !== "lobby" && s.phase !== "reveal") return this.send(c, { t: "error", message: "Hjulet kan bara snurras mellan frågorna" });
        if (s.qIndex + 1 >= s.questions.length) return this.send(c, { t: "error", message: "Det finns ingen nästa fråga att snurra för" });
        const nextCollect = isCollectMode(s.questions[s.qIndex + 1]?.mode);
        s.wheel = spinWheel(s.wheel, s.qIndex + 1, Date.now(), nextCollect ? (t) => t === "double" || t === "none" : undefined);
        break;
      }
      case "host:finish": {
        this.clearTimer(); this.clearPending(); this.clearCollectTimer(); s.wheel = null; s.phase = "finished"; s.buzz = null; s.lockedOut = []; s.lastEvent = { kind: "finished", at: Date.now() };
        break;
      }
      case "host:mark": {
        if (!s.collect || (s.phase !== "collect" && s.phase !== "judge")) return;
        markAnswer(s.collect, m.playerId, !!m.correct);
        break;
      }
      case "host:close": return this.closeCollect();
      case "host:judge": { if (!this.judgeCollect()) return; break; }
    }
    await this.save();
    this.broadcast();
  }
}
