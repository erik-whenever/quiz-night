import type { HostState, PlayerPublic } from "../shared/types";

export function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export function Scorebar({ state, highlight }: { state: HostState; highlight?: string }) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return <p className="muted" style={{ textAlign: "center" }}>Inga spelare än.</p>;
  return (
    <div className="scorebar" aria-label="Poängställning">
      {sorted.map((p) => <Chip key={p.id} p={p} locked={state.lockedOut.includes(p.id)} active={highlight === p.id || state.buzz?.playerId === p.id} />)}
    </div>
  );
}

export function Chip({ p, locked, active }: { p: PlayerPublic; locked?: boolean; active?: boolean }) {
  return (
    <div className={`chip${p.connected ? "" : " off"}${locked ? " locked" : ""}${active ? " active" : ""}`}
      style={{ "--c": p.color } as React.CSSProperties} title={p.connected ? undefined : "Frånkopplad"}>
      <span className="dot">{initials(p.name)}</span>
      <span>{p.name}</span>
      <span className="pts">{p.score}</span>
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
