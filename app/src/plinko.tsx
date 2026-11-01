// Plinko-runda: intro → alla släpper sin kula (insats + risk) → kulorna landar → sammanfattning.
// Servern äger tidslinjen och slumpar varje kulas väg (shared/plinko.ts); här ritas samma animation på
// TV:n, i alla mobiler och i hostkontrollen. Brädet är en canvas (lätt att rita, även på svaga mobiler).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientMsg, HostState, PlayerPublic } from "../shared/types";
import {
  MULTS, PLINKO, RISKS, RISK_NAME, ballAt, bankroll, betFor, pegTimes, plinkoStage,
  type PlinkoDrop, type PlinkoRisk, type PlinkoStage,
} from "../shared/plinko";
import { plinkoSfx, sfx, haptic } from "./lib/sound";

type Role = "tv" | "player" | "host";

const multText = (m: number) => (m >= 10 ? `${m}×` : `${m.toString().replace(".", ",")}×`);
/** Färg på ett fack efter multiplikatorn: kallt för små, varmt och glödande för stora. */
function binColor(m: number) {
  if (m >= 5) return "#ff3b6a";
  if (m >= 2) return "#ff8a3d";
  if (m >= 1) return "#ffd23f";
  if (m >= 0.5) return "#3ddc97";
  return "#4f5bd5";
}

function useStage(p: HostState["plinko"], serverNow: () => number): PlinkoStage | null {
  const [st, setSt] = useState<PlinkoStage | null>(() => (p ? plinkoStage(p, serverNow()) : null));
  useEffect(() => {
    if (!p) { setSt(null); return; }
    const tick = () => setSt(plinkoStage(p, serverNow()));
    tick();
    const id = window.setInterval(tick, 100);
    return () => clearInterval(id);
  }, [p, serverNow]);
  return st;
}

export function Plinko(props: { state: HostState; role: Role; me?: string; send: (m: ClientMsg) => void; serverNow: () => number }) {
  return createPortal(<PlinkoInner {...props} />, document.body);
}

function PlinkoInner({ state, role, me, send, serverNow }: { state: HostState; role: Role; me?: string; send: (m: ClientMsg) => void; serverNow: () => number }) {
  const p = state.plinko;
  const stage = useStage(p, serverNow);
  const sound = role === "tv";
  const [risk, setRisk] = useState<PlinkoRisk>("mid");
  const prev = useRef<PlinkoStage | null>(null);
  useEffect(() => {
    if (!stage || stage === prev.current) return;
    prev.current = stage;
    if (sound && stage === "intro" && p && serverNow() - p.startedAt < 3000) plinkoSfx.intro();
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p || !stage) return null;
  const P = state.players;
  const mine = p.drops.find((d) => d.playerId === me);
  const player = P.find((x) => x.id === me);

  if (stage === "intro") {
    return (
      <div className="pk pk-intro" role="dialog" aria-label="Plinko">
        <FallingDots />
        <div className="pk-title-wrap">
          <h1 className="pk-title">PLINKO</h1>
          <p className="pk-kicker">{p.n === 1 ? "Kvällens första kula" : "Sista chansen att bli rik (eller pank)"}</p>
          <p className="pk-sub">Satsa mynt, välj risk och släpp kulan. Facken ger 0,1×–10× insatsen.</p>
        </div>
      </div>
    );
  }

  if (stage === "summary") return <Summary drops={p.drops} players={P} me={me} role={role} send={send} />;

  const left = Math.max(0, Math.ceil((p.dropUntil - serverNow()) / 1000));
  return (
    <div className={`pk pk-play pk-${role}`} role="region" aria-label="Plinko">
      <div className="pk-head">
        <span className="pk-logo">PLINKO</span>
        {stage === "drop" ? <span className="pk-timer" aria-label={`${left} sekunder kvar`}>{left}</span> : <span className="pk-timer done">Kulorna landar…</span>}
        <span className="pk-count">{p.drops.length} av {P.filter((x) => x.connected).length} släppta</span>
      </div>
      <Board drops={p.drops} players={P} serverNow={serverNow} sound={sound} me={me} risk={role === "player" ? (mine?.risk ?? risk) : null} />
      {role === "player" && player && (
        mine ? <MyBall drop={mine} serverNow={serverNow} />
          : stage === "drop" ? <Controls state={state} me={player} send={send} risk={risk} setRisk={setRisk} />
            : <p className="pk-note">Du hann inte släppa någon kula den här gången.</p>
      )}
      {role === "host" && <button className="btn sm ghost pk-abort" onClick={() => send({ t: "host:plinko:stop" })}>Avbryt Plinko</button>}
    </div>
  );
}

/** Insats, risk och SLÄPP. Saldot är plånboken plus kvällens mynt. */
function Controls({ state, me, send, risk, setRisk }: {
  state: HostState; me: PlayerPublic; send: (m: ClientMsg) => void; risk: PlinkoRisk; setRisk: (r: PlinkoRisk) => void;
}) {
  const bank = bankroll(state.wallets?.[me.id]?.coins ?? 0, state.coinsTonight?.[me.id] ?? 0);
  const [bet, setBet] = useState<number | "all">(() => Math.min(2, bank));
  const [sent, setSent] = useState(false);
  const real = betFor(bet, bank);
  const drop = () => {
    if (sent) return;
    setSent(true);
    sfx.unlock(); haptic.buzz();
    send({ t: "plinko", bet, risk });
  };
  return (
    <div className="pk-controls">
      <p className="pk-bank">Du har <strong>{bank}</strong> mynt</p>
      <div className="pk-row" role="radiogroup" aria-label="Insats">
        {PLINKO.BETS.map((b) => (
          <button key={b} role="radio" aria-checked={bet === b} className={`pk-chip${bet === b ? " on" : ""}`} disabled={b > bank} onClick={() => setBet(b)}>
            {b === 0 ? "Gratis" : b}
          </button>
        ))}
        <button role="radio" aria-checked={bet === "all"} className={`pk-chip allin${bet === "all" ? " on" : ""}`} disabled={bank === 0} onClick={() => setBet("all")}>Allt</button>
      </div>
      <div className="pk-row" role="radiogroup" aria-label="Risk">
        {RISKS.map((r) => (
          <button key={r} role="radio" aria-checked={risk === r} className={`pk-risk${risk === r ? " on" : ""} ${r}`} onClick={() => setRisk(r)}>{RISK_NAME[r]}</button>
        ))}
      </div>
      <button className="btn primary big pk-drop" onClick={drop} disabled={sent}>
        {sent ? "Släpper…" : real > 0 ? `Släpp kulan · ${real} mynt` : "Släpp en gratiskula"}
      </button>
    </div>
  );
}

/** Min kula: spänning medan den faller, utfallet när den landat. */
function MyBall({ drop, serverNow }: { drop: PlinkoDrop; serverNow: () => number }) {
  const [landed, setLanded] = useState(() => serverNow() - drop.at >= PLINKO.BALL_MS);
  useEffect(() => {
    if (landed) return;
    const id = window.setTimeout(() => {
      setLanded(true);
      if (drop.bet > 0) { if (drop.win > drop.bet) haptic.correct(); else if (drop.win < drop.bet) haptic.wrong(); }
    }, Math.max(0, drop.at + PLINKO.BALL_MS - serverNow()));
    return () => clearTimeout(id);
  }, [drop, landed, serverNow]);
  if (!landed) return <p className="pk-note big">Din kula faller… {drop.bet > 0 ? `${drop.bet} mynt på ${RISK_NAME[drop.risk].toLowerCase()} risk` : "(gratiskula)"}</p>;
  const net = drop.win - drop.bet;
  return (
    <div className={`pk-mine ${net > 0 ? "win" : net < 0 ? "lose" : ""}`} role="status">
      <span className="pk-mine-mult">{multText(drop.mult)}</span>
      <span>{drop.bet === 0 ? "Gratiskula, inget på spel." : net > 0 ? `+${net} mynt!` : net < 0 ? `${net} mynt` : "Jämnt, du fick tillbaka insatsen."}</span>
    </div>
  );
}

function Summary({ drops, players, me, role, send }: { drops: PlinkoDrop[]; players: PlayerPublic[]; me?: string; role: Role; send: (m: ClientMsg) => void }) {
  const rows = [...drops].sort((a, b) => (b.win - b.bet) - (a.win - a.bet) || b.mult - a.mult);
  const name = (id: string) => players.find((x) => x.id === id)?.name ?? "?";
  const color = (id: string) => players.find((x) => x.id === id)?.color ?? "#fff";
  const best = rows[0], worst = rows[rows.length - 1];
  return (
    <div className="pk pk-summary" role="status" aria-label="Plinko-resultat">
      <FallingDots />
      <div className="pk-sum-card">
        <p className="pk-kicker">PLINKO · resultat</p>
        {rows.length === 0 ? <h2>Ingen vågade släppa en kula. Fegt.</h2> : (
          <>
            {best && best.win - best.bet > 0 && <h2><span style={{ color: color(best.playerId) }}>{name(best.playerId)}</span> vann {best.win - best.bet} mynt</h2>}
            {best && best.win - best.bet <= 0 && <h2>Banken vann. Som vanligt.</h2>}
            <ol className="pk-list">
              {rows.map((d) => {
                const net = d.win - d.bet;
                return (
                  <li key={d.playerId} className={d.playerId === me ? "me" : ""}>
                    <span className="pk-dot" style={{ background: color(d.playerId) }} />
                    <span className="pk-name">{name(d.playerId)}</span>
                    <span className="pk-meta">{d.bet ? `${d.bet} på ${RISK_NAME[d.risk].toLowerCase()}` : "gratis"}</span>
                    <span className="pk-m" style={{ color: binColor(d.mult) }}>{multText(d.mult)}</span>
                    <span className={`pk-net ${net > 0 ? "win" : net < 0 ? "lose" : ""}`}>{net > 0 ? `+${net}` : net}</span>
                  </li>
                );
              })}
            </ol>
            {worst && worst !== best && worst.win - worst.bet < 0 && <p className="pk-sub">{name(worst.playerId)} blev av med {worst.bet - worst.win} mynt. Det svider.</p>}
          </>
        )}
        <p className="pk-sub small">Mynten räknas in i kväll och hamnar i plånboken vid kröningen.</p>
        {role === "host" && <button className="btn sm ghost" onClick={() => send({ t: "host:plinko:stop" })}>Vidare</button>}
      </div>
    </div>
  );
}

function FallingDots() {
  const dots = useMemo(() => Array.from({ length: 26 }, (_, i) => ({
    left: (i * 37) % 100, delay: (i * 0.23) % 3, dur: 2.2 + ((i * 7) % 10) / 6, hue: ["#ffd23f", "#4cc9f0", "#ff5d73", "#3ddc97", "#b388ff"][i % 5],
  })), []);
  return (
    <div className="pk-dots" aria-hidden="true">
      {dots.map((d, i) => <i key={i} style={{ left: `${d.left}%`, animationDelay: `${d.delay}s`, animationDuration: `${d.dur}s`, background: d.hue }} />)}
    </div>
  );
}

// ===== Brädet =====

const ROWS = PLINKO.ROWS;
const PEG_TIMES = pegTimes();

function Board({ drops, players, serverNow, sound, me, risk }: {
  drops: PlinkoDrop[]; players: PlayerPublic[]; serverNow: () => number; sound: boolean; me?: string; risk: PlinkoRisk | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ drops, players, sound, me, risk });
  useLayoutEffect(() => { live.current = { drops, players, sound, me, risk }; });

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const heard = new Map<string, number>(); // kula → antal pinnljud/landning som spelats
    const flash = new Map<string, number>(); // "rad,x" → ms när pinnen träffades
    const pops: { x: number; text: string; color: string; at: number; big: boolean }[] = [];
    const binHit: number[] = Array(ROWS + 1).fill(-1e9);
    const startedAt = serverNow();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { drops, players, sound, me, risk } = live.current;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const W = cv.clientWidth, H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const UW = ROWS + 2.6, UH = ROWS + 2.9;
      const S = Math.min(W / UW, H / UH);
      const ox = W / 2, oy = (H - UH * S) / 2 + 0.9 * S;
      const X = (x: number) => ox + x * S, Y = (y: number) => oy + y * S;
      const now = serverNow(), wall = performance.now();

      // Kulornas läge och ljud
      const balls = drops.map((d) => {
        const ms = now - d.at;
        const b = ballAt(d, ms);
        const key = d.playerId + d.at;
        // Kulor som redan var på väg när brädet öppnades: hoppa över det som redan hänt (inget ljudregn)
        const before = startedAt - d.at;
        const done = heard.get(key) ?? (before >= PLINKO.BALL_MS ? 99 : PEG_TIMES.filter((t) => t <= before).length);
        let n = done;
        while (n < ROWS && ms >= PEG_TIMES[n]) {
          let px = 0; for (let i = 0; i < n; i++) px += d.path[i] ? 0.5 : -0.5;
          flash.set(`${n},${px}`, wall);
          if (sound) plinkoSfx.peg(n);
          n++;
        }
        if (n === ROWS && b.landed) {
          n = 99;
          binHit[d.bin] = wall;
          const pl = players.find((x) => x.id === d.playerId);
          const net = d.win - d.bet;
          pops.push({ x: d.bin - ROWS / 2, text: `${pl?.name ?? "?"} ${multText(d.mult)}${d.bet ? (net >= 0 ? ` +${net}` : ` ${net}`) : ""}`, color: pl?.color ?? "#fff", at: wall, big: d.mult >= 5 && d.bet > 0 });
          if (sound) plinkoSfx.land(d.mult);
        }
        if (n !== done) heard.set(key, n);
        if (ms >= 0 && ms < 120 && sound && !heard.has(key + "d")) { heard.set(key + "d", 1); plinkoSfx.drop(); }
        return { d, b, mine: d.playerId === me, color: players.find((x) => x.id === d.playerId)?.color ?? "#fff", name: players.find((x) => x.id === d.playerId)?.name ?? "" };
      });

      // Pinnar
      for (let r = 0; r < ROWS; r++) {
        for (let j = 0; j < r + 3; j++) {
          const x = j - (r + 2) / 2;
          const f = flash.get(`${r},${x}`);
          const k = f ? Math.max(0, 1 - (wall - f) / 350) : 0;
          ctx.beginPath();
          ctx.arc(X(x), Y(r + 1), S * (0.09 + k * 0.05), 0, Math.PI * 2);
          ctx.fillStyle = k > 0 ? `rgba(255, 233, 168, ${0.6 + k * 0.4})` : "rgba(220, 226, 255, 0.85)";
          ctx.shadowColor = "#ffd23f"; ctx.shadowBlur = k * 18;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // Facken
      const mults = risk ? MULTS[risk] : null;
      for (let k = 0; k <= ROWS; k++) {
        const x = k - ROWS / 2;
        const bw = S * 0.9, bh = S * (mults ? 0.62 : 0.95);
        const hit = Math.max(0, 1 - (wall - binHit[k]) / 450);
        const bx = X(x) - bw / 2, by = Y(ROWS + 1) - S * 0.15 + hit * S * 0.12;
        const ref = mults ? mults[k] : MULTS.mid[k];
        ctx.fillStyle = binColor(ref);
        ctx.globalAlpha = 0.85;
        roundRect(ctx, bx, by, bw, bh, S * 0.12); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#0b0420";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        if (mults) {
          ctx.font = `800 ${Math.max(9, S * 0.26)}px "Bricolage Grotesque", system-ui`;
          ctx.fillText(multText(mults[k]).replace("×", ""), bx + bw / 2, by + bh / 2 + 1);
        } else {
          // TV:n/hosten: alla tre risknivåerna, liten text
          ctx.font = `700 ${Math.max(8, S * 0.18)}px "Familjen Grotesk", system-ui`;
          RISKS.forEach((r, i) => ctx.fillText(multText(MULTS[r][k]).replace("×", ""), bx + bw / 2, by + bh * (0.22 + i * 0.28)));
        }
      }
      if (!mults) {
        ctx.font = `600 ${Math.max(9, S * 0.17)}px "Familjen Grotesk", system-ui`;
        ctx.fillStyle = "rgba(244,245,255,0.7)"; ctx.textAlign = "right";
        const bh = S * 0.95, by = Y(ROWS + 1) - S * 0.15;
        ["låg", "medel", "hög"].forEach((t, i) => ctx.fillText(t, X(-ROWS / 2) - S * 0.55, by + bh * (0.22 + i * 0.28)));
      }

      // Kulor (egen kula sist och störst)
      balls.sort((a, b) => +a.mine - +b.mine);
      for (const { b, mine, color, name } of balls) {
        if (b.landed) continue; // har blivit ett utfall
        const r = S * (mine ? 0.27 : 0.22);
        const x = X(b.x), y = Y(b.y) - r * 0.9;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
        g.addColorStop(0, "#fff"); g.addColorStop(0.35, color); g.addColorStop(1, shade(color));
        ctx.fillStyle = g; ctx.shadowColor = color; ctx.shadowBlur = mine ? 22 : 12;
        ctx.fill(); ctx.shadowBlur = 0;
        if (mine) { ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke(); }
        if (b.row < 2 || mine) {
          ctx.font = `700 ${Math.max(10, S * 0.24)}px "Familjen Grotesk", system-ui`;
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(mine ? "Du" : name, x, y - r - 3);
        }
      }

      // Utfall som svävar upp ur facket
      for (let i = pops.length - 1; i >= 0; i--) {
        const pp = pops[i], age = (wall - pp.at) / 1000;
        if (age > 2.4) { pops.splice(i, 1); continue; }
        const a = age < 0.15 ? age / 0.15 : Math.max(0, 1 - (age - 1.6) / 0.8);
        ctx.globalAlpha = a;
        ctx.font = `800 ${Math.max(12, S * (pp.big ? 0.48 : 0.3))}px "Bricolage Grotesque", system-ui`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = pp.color; ctx.shadowColor = "#000"; ctx.shadowBlur = 8;
        const px = Math.max(S * 1.5, Math.min(W - S * 1.5, X(pp.x)));
        ctx.fillText(pp.text, px, Y(ROWS + 0.2) - age * S * 1.4);
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [serverNow]);

  return <canvas ref={canvas} className="pk-board" aria-label="Plinkobrädet" />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Mörkare kant på kulan. */
function shade(hex: string) {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const f = (v: number) => Math.round(v * 0.45);
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
