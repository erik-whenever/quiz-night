// Lyckohjulet på klienten. Servern har redan slumpat utfallet; här animeras bara hjulet fram till det.
import { useEffect, useRef, useState } from "react";
import type { ClientMsg, HostState, TwistId, WheelState } from "../shared/types";
import { TWISTS, WHEEL_SEGMENTS, activeTwist } from "../shared/types";

const N = WHEEL_SEGMENTS.length;
const SEG = 360 / N;
const R = 190;
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Två rader per etikett så de får plats i ett smalt fält. */
const LINES: Record<TwistId, string[]> = {
  double: ["Dubbla", "poäng"], fifty: ["50/50"], steal: ["Stjäl"], blitz: ["Blixt"], none: ["Nit"],
};

const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/** Vinkel (medsols) hjulet ska vridas så att fältets mitt hamnar under pekaren. Liten, deterministisk variation per snurr. */
function landAngle(w: WheelState) {
  const jitter = (mod(w.spinId * 37, 21) - 10) * (SEG * 0.035);
  return mod(-(w.segment * SEG + SEG / 2 + jitter), 360);
}

/** Har snurret landat (enligt servertid)? */
export function useWheelLanded(wheel: WheelState | null | undefined, serverNow: () => number) {
  // Räkna ut direkt vid första renderingen så utfallet aldrig blinkar fram innan hjulet stannat.
  const [landed, setLanded] = useState(() => !wheel || wheel.startedAt + wheel.spinMs - serverNow() <= 0 || reducedMotion());
  useEffect(() => {
    if (!wheel) { setLanded(true); return; }
    const left = wheel.startedAt + wheel.spinMs - serverNow();
    if (left <= 0 || reducedMotion()) { setLanded(true); return; }
    setLanded(false);
    const t = setTimeout(() => setLanded(true), left);
    return () => clearTimeout(t);
  }, [wheel?.spinId, wheel?.startedAt, serverNow]); // eslint-disable-line react-hooks/exhaustive-deps
  return landed;
}

/** Ett snurr som väntar på att användas: gäller nästa fråga och vi är mellan frågor. */
export function pendingWheel(st: HostState): WheelState | null {
  const w = st.wheel;
  return w && w.forQ === st.qIndex + 1 && (st.phase === "lobby" || st.phase === "reveal") ? w : null;
}

export function Wheel({ wheel, serverNow, size, landed }: { wheel: WheelState; serverNow: () => number; size: number; landed: boolean }) {
  const [view, setView] = useState({ rot: 0, ms: 0 });
  const rot = useRef(0);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (seen.current === wheel.spinId) return;
    seen.current = wheel.spinId;
    const left = wheel.startedAt + wheel.spinMs - serverNow();
    const base = rot.current - mod(rot.current, 360);
    if (left < 400 || reducedMotion()) {
      rot.current = base + landAngle(wheel);
      setView({ rot: rot.current, ms: 0 });
      return;
    }
    // Fler varv ju mer tid som är kvar, så sena anslutare ändå landar samtidigt som alla andra.
    const turns = Math.max(2, Math.round((6 * left) / wheel.spinMs));
    const prev = rot.current;
    rot.current = base + 360 * turns + landAngle(wheel);
    let started = false;
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { started = true; setView({ rot: rot.current, ms: left }); }); });
    return () => {
      cancelAnimationFrame(raf);
      // Avbröts innan animationen startade: släpp snurret så nästa körning startar det igen.
      // Annars står hjulet still på fel fält (hände vid omladdning mitt i snurr).
      if (!started) { rot.current = prev; seen.current = null; }
    };
    // Bara spinId/startedAt: varje state-meddelande ger ett nytt wheel-objekt.
  }, [wheel.spinId, wheel.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`wheel${landed ? " landed" : ""}`} style={{ width: size, height: size }}
      role="img" aria-label={landed ? `Lyckohjulet stannade på ${TWISTS[wheel.result].label}` : "Lyckohjulet snurrar"}>
      <svg viewBox="-200 -212 400 412" width={size} height={size} aria-hidden="true">
        <g className="wheel-disc" style={{ transform: `rotate(${view.rot}deg)`, transition: view.ms ? `transform ${view.ms}ms cubic-bezier(0.12, 0.62, 0.12, 1)` : "none" }}>
          <circle r={R + 8} className="wheel-rim" />
          {WHEEL_SEGMENTS.map((t, i) => {
            const a0 = (i * SEG * Math.PI) / 180, a1 = ((i + 1) * SEG * Math.PI) / 180;
            const d = `M0 0 L${R * Math.sin(a0)} ${-R * Math.cos(a0)} A${R} ${R} 0 0 1 ${R * Math.sin(a1)} ${-R * Math.cos(a1)}Z`;
            const hit = landed && i === wheel.segment;
            const lines = LINES[t];
            return (
              <g key={i} className={`wheel-seg seg-${t}${i % 2 ? " odd" : ""}${hit ? " hit" : ""}`}>
                <path d={d} />
                <g transform={`rotate(${i * SEG + SEG / 2}) translate(0 ${-R * 0.7})`}>
                  {lines.map((l, j) => (
                    <text key={j} y={(j - (lines.length - 1) / 2) * 19 + 6} textAnchor="middle">{l}</text>
                  ))}
                </g>
              </g>
            );
          })}
          {WHEEL_SEGMENTS.map((_, i) => (
            <circle key={i} className="wheel-peg" r={4} cx={(R + 1) * Math.sin((i * SEG * Math.PI) / 180)} cy={-(R + 1) * Math.cos((i * SEG * Math.PI) / 180)} />
          ))}
        </g>
        <circle r={34} className="wheel-hub" />
        <path d="M-14 6 -18 -10 -9 -3 0 -14 9 -3 18 -10 14 6Z" className="wheel-crown" />
        <path d="M-15 -212 15 -212 0 -182Z" className="wheel-pointer" />
      </svg>
    </div>
  );
}

/** Text om utfallet, visas först när hjulet stannat. */
export function WheelCaption({ wheel, landed, compact }: { wheel: WheelState; landed: boolean; compact?: boolean }) {
  const t = TWISTS[wheel.result];
  if (!landed) return <p className="wheel-caption muted" aria-live="polite">Lyckohjulet snurrar…</p>;
  return (
    <div className={`wheel-caption${compact ? " compact" : ""}`} aria-live="polite" data-twist={wheel.result}>
      <span className="muted small">Nästa fråga</span>
      <strong className="display wheel-result">{t.label}</strong>
      <span className="small">{t.info}</span>
    </div>
  );
}

/** Hjul + text för ett snurr som gäller nästa fråga. */
export function WheelPanel({ wheel, serverNow, size, compact, onLanded }: {
  wheel: WheelState; serverNow: () => number; size: number; compact?: boolean; onLanded?: () => void;
}) {
  const landed = useWheelLanded(wheel, serverNow);
  const prev = useRef(landed);
  useEffect(() => { if (landed && !prev.current) onLanded?.(); prev.current = landed; }, [landed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`wheel-panel${compact ? " compact" : ""}`}>
      <Wheel wheel={wheel} serverNow={serverNow} size={size} landed={landed} />
      <WheelCaption wheel={wheel} landed={landed} compact={compact} />
    </div>
  );
}

/** Liten etikett under en fråga med aktiv twist. */
export function TwistBadge({ state }: { state: HostState }) {
  const t = activeTwist(state);
  if (!t) return null;
  return (
    <span className="twist-badge" data-twist={t} title={TWISTS[t].info}>
      <span className="twist-dot" aria-hidden="true" />Lyckohjulet: <strong>{TWISTS[t].label}</strong>
      <span className="twist-info">{TWISTS[t].info}</span>
    </span>
  );
}

/** "Erik stal 1 p från Tobbe" efter en fråga med Stjäl. */
export function StealNote({ state }: { state: HostState }) {
  const ev = state.lastEvent;
  if (state.phase !== "reveal" || ev?.kind !== "judged" || !ev.stolenFrom) return null;
  const who = state.players.find((p) => p.id === ev.stealer)?.name ?? "Någon";
  const from = state.players.find((p) => p.id === ev.stolenFrom)?.name ?? "ledaren";
  return <p className="qmeta steal-note">{who} stal {ev.stolen} p från {from}</p>;
}

/** Hostkontrollens del: snurra mellan frågorna, se vad som gäller. */
export function HostWheel({ state, send, serverNow }: { state: HostState; send: (m: ClientMsg) => void; serverNow: () => number }) {
  const pending = pendingWheel(state);
  const landed = useWheelLanded(pending, serverNow);
  const twist = activeTwist(state);
  const between = state.phase === "lobby" || state.phase === "reveal";
  const hasNext = state.qIndex + 1 < state.qCount;
  if (!between) {
    return twist ? <p className="small">Lyckohjulet: <strong style={{ color: "var(--signal)" }}>{TWISTS[twist].label}</strong> <span className="muted">· {TWISTS[twist].info}</span></p> : null;
  }
  if (!hasNext) return null;
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <p className="small" aria-live="polite">
        {!pending ? <span className="muted">Lyckohjulet ger nästa fråga en twist.</span>
          : !landed ? <span className="muted">Hjulet snurrar på TV:n…</span>
          : <>Nästa fråga: <strong style={{ color: "var(--signal)" }}>{TWISTS[pending.result].label}</strong> <span className="muted">· {TWISTS[pending.result].info}</span></>}
      </p>
      <button className="btn ghost" disabled={!landed} onClick={() => send({ t: "host:spin" })}>
        {pending ? "Snurra igen" : "Snurra hjulet"}
      </button>
    </div>
  );
}
