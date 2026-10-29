import { useEffect, useState } from "react";
import type { HostState, PlayerPublic } from "../shared/types";

export function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export function Scorebar({ state, highlight }: { state: HostState; highlight?: string }) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return <p className="muted" style={{ textAlign: "center" }}>Inga spelare än.</p>;
  return (
    <div className="scorebar" aria-label="Poängställning">
      {sorted.map((p) => <Chip key={p.id} p={p} active={highlight === p.id} />)}
    </div>
  );
}

export function Chip({ p, locked, active }: { p: PlayerPublic; locked?: boolean; active?: boolean }) {
  return (
    <div className={`chip${p.connected ? "" : " off"}${locked ? " locked" : ""}${active ? " active" : ""}`}
      style={{ "--c": p.color } as React.CSSProperties} title={p.connected ? undefined : "Frånkopplad"}>
      <span className="dot">{initials(p.name)}</span>
      <span>{p.name}</span>
      <span className="pts" key={p.score}>{p.score}</span>
    </div>
  );
}

export function Countdown({ ms, total, size = 120 }: { ms: number; total: number; size?: number }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const frac = total ? ms / total : 0;
  const color = frac < 0.3 ? "var(--buzz)" : "var(--signal)";
  return (
    <div className="ring" role="timer" aria-label={`${Math.ceil(ms / 1000)} sekunder kvar`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.15)" strokeWidth="10" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="10" fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span className="num" style={{ fontSize: size / 3 }}>{Math.ceil(ms / 1000)}</span>
    </div>
  );
}

export function Podium({ players }: { players: PlayerPublic[] }) {
  const top = [...players].sort((a, b) => b.score - a.score).slice(0, 3);
  const order = [top[1], top[0], top[2]];
  const cls = ["p2", "p1", "p3"];
  return (
    <div className="podium">
      {order.map((p, i) => p ? (
        <div key={p.id} className={`step ${cls[i]}`}>
          {i === 1 && <div style={{ fontSize: "2.4rem" }} aria-hidden>👑</div>}
          <div className="name">{p.name}</div>
          <div className="score">{p.score} p</div>
        </div>
      ) : <div key={i} />)}
    </div>
  );
}

/**
 * Autoplay-remsa: visar när nästa steg sker ("Svaret visas…" / "Nästa fråga om 6 s") som en krympande ljus linje.
 * Används på TV, i mobilen och i hostkontrollen.
 */
export function NextBar({ state, serverNow }: { state: HostState; serverNow: () => number }) {
  const [now, setNow] = useState(() => serverNow());
  const at = state.nextAt;
  useEffect(() => {
    if (!at) return;
    let raf = 0;
    const tick = () => { setNow(serverNow()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [at, serverNow]);
  if (state.paused && (state.phase === "reveal" || state.phase === "judge")) return <p className="next-bar paused" role="status">Pausat av värden</p>;
  if (!at) return null;
  const total = state.phase === "judge" ? 1300 : state.settings.revealSeconds * 1000;
  const left = Math.max(0, at - now);
  const last = state.qIndex + 1 >= state.qCount;
  const label = state.phase === "judge" ? "Svaret visas…" : `${last ? "Pallen" : "Nästa fråga"} om ${Math.ceil(left / 1000)} s`;
  return (
    <div className={`next-bar ${state.phase}`} role="status" aria-label={label}>
      <span className="next-label">{label}</span>
      <span className="next-track"><span className="next-fill" style={{ transform: `scaleX(${Math.min(1, left / total)})` }} /></span>
    </div>
  );
}

/** Frågeintro: "Fråga 7" med kategori och svårighet glider in en kort stund innan svaren öppnas. */
export function QuestionIntro({ state, serverNow, big }: { state: HostState; serverNow: () => number; big?: boolean }) {
  const until = state.phase === "collect" ? state.collect?.introUntil : undefined;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!until) { setShow(false); return; }
    const left = until - serverNow();
    if (left <= 0) { setShow(false); return; }
    setShow(true);
    const t = setTimeout(() => setShow(false), left);
    return () => clearTimeout(t);
  }, [until, serverNow]);
  if (!show || !state.question) return null;
  const q = state.question;
  return (
    <div className={`q-intro${big ? " big" : ""}`} aria-hidden="true">
      <div className="q-intro-card">
        <span className="q-intro-n">Fråga {state.qIndex + 1}</span>
        {q.category && <span className="q-intro-cat">{q.category}</span>}
        {q.difficulty ? <span className="q-intro-pips">{"●".repeat(q.difficulty)}{"○".repeat(5 - q.difficulty)}</span> : null}
      </div>
    </div>
  );
}
