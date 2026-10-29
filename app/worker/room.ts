import type {
  ClientMsg, GameEvent, HostState, Phase, PlayerPublic, PublicState, Question, ServerMsg, Settings,
} from "../shared/types";
import {
  BUZZ_BURST, BUZZ_JITTER_MS, BUZZ_MAX_COMP_MS, BUZZ_RATE_PER_S, DEFAULT_SETTINGS, BUZZ_WINDOW_MS, MSG_BURST, MSG_RATE_PER_S,
} from "../shared/types";

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
}

export class Room implements DurableObject {
  private s: Persisted | null = null;
  private conns = new Set<Conn>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Buzzar som samlas under fönstret efter första buzz: playerId -> justerad tid. */
  private pending: { cands: Map<string, number>; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private ctx: DurableObjectState, private env: unknown) {
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Persisted>("s")) ?? null;
    });
  }

  private async save() { if (this.s) await this.ctx.storage.put("s", this.s); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/init") && req.method === "POST") {
      const body = await req.json<{ code: string; title: string; questions: Question[]; hostKey: string; settings?: Partial<Settings> }>();
      this.s = {
        code: body.code, title: body.title, phase: "lobby", players: [], questions: body.questions,
        qIndex: -1, buzz: null, lockedOut: [], settings: { ...DEFAULT_SETTINGS, ...body.settings }, hostKey: body.hostKey,
      };
      await this.save();
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/results")) {
      if (!this.s) return new Response("not found", { status: 404 });
      return Response.json({ title: this.s.title, players: this.s.players });
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
      question: q && s.phase !== "lobby" ? { text: q.text, points: q.points ?? 1, category: q.category, imageUrl: q.imageUrl } : undefined,
      revealedAnswer: s.phase === "reveal" || s.phase === "finished" ? q?.answer : undefined,
      buzz: s.buzz, lockedOut: s.lockedOut, lastEvent: s.lastEvent, settings: s.settings, serverNow: Date.now(),
    };
    if (role === "host") return { ...base, answer: q?.answer };
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
    const deadline = Date.now() + s.settings.answerSeconds * 1000;
    s.buzz = { playerId: winner, deadline };
    s.phase = "buzzed";
    s.lastEvent = { kind: "buzz", playerId: winner, at: Date.now() };
    this.clearTimer();
    this.timer = setTimeout(() => { this.punish("timeout"); }, s.settings.answerSeconds * 1000 + 150);
    await this.save();
    this.broadcast();
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  private delta(sign: 1 | -1) {
    const q = this.s!.questions[this.s!.qIndex];
    return sign === 1 ? (q?.points ?? 1) : -this.s!.settings.penalty;
  }

  /** Fel eller timeout: dra poäng, lås ute spelaren, öppna för andra att buzza. */
  private async punish(kind: "wrong" | "timeout") {
    const s = this.s!;
    if (s.phase !== "buzzed" || !s.buzz) return;
    this.clearTimer();
    const pid = s.buzz.playerId;
    const d = this.delta(-1);
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
      this.send(c, { t: "joined", playerId: p.id });
      this.sping(c);
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

    if (m.t === "type") {
      if (s.buzz && s.buzz.playerId === c.playerId) { s.buzz.typedAnswer = m.text.slice(0, 120); this.broadcast(); }
      return;
    }

    if (c.role !== "host") return this.send(c, { t: "error", message: "Bara hosten kan göra det" });

    switch (m.t) {
      case "host:start":
      case "host:next": {
        this.clearTimer(); this.clearPending();
        if (s.qIndex + 1 >= s.questions.length) { s.phase = "finished"; s.buzz = null; s.lockedOut = []; s.lastEvent = { kind: "finished", at: Date.now() }; }
        else { s.qIndex += 1; s.phase = "question"; s.buzz = null; s.lockedOut = []; s.lastEvent = undefined; }
        break;
      }
      case "host:correct": {
        if (s.phase !== "buzzed" || !s.buzz) return;
        this.clearTimer();
        const d = this.delta(1);
        const p = s.players.find((x) => x.id === s.buzz!.playerId);
        if (p) p.score += d;
        s.lastEvent = { kind: "correct", playerId: s.buzz.playerId, delta: d, at: Date.now() };
        s.phase = "reveal";
        break;
      }
      case "host:wrong": return this.punish("wrong");
      case "host:reveal": {
        this.clearTimer(); this.clearPending(); s.buzz = null; s.phase = "reveal"; s.lastEvent = { kind: "reveal", at: Date.now() };
        break;
      }
      case "host:adjust": {
        const p = s.players.find((x) => x.id === m.playerId); if (p) p.score += m.delta; break;
      }
      case "host:kick": {
        s.players = s.players.filter((x) => x.id !== m.playerId);
        for (const cc of this.conns) if (cc.playerId === m.playerId) { try { cc.ws.close(4000, "kicked"); } catch {} }
        break;
      }
      case "host:settings": {
        const n = m.settings;
        if (n.answerSeconds) s.settings.answerSeconds = Math.max(3, Math.min(60, Math.round(n.answerSeconds)));
        if (n.penalty !== undefined) s.settings.penalty = Math.max(0, Math.min(10, Math.round(n.penalty)));
        break;
      }
      case "host:finish": {
        this.clearTimer(); this.clearPending(); s.phase = "finished"; s.buzz = null; s.lockedOut = []; s.lastEvent = { kind: "finished", at: Date.now() };
        break;
      }
    }
    await this.save();
    this.broadcast();
  }
}
