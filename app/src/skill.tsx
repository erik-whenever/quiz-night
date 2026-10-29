// Skill-utmaningar: minispelen i mobilen, plus TV- och hostvyer för skill-rundor.
// Banorna genereras från rummets frö (shared/skill.ts), så alla spelar exakt samma bana.
// Tiden mäts lokalt med performance.now(), så pingen påverkar inte resultatet.
import { useEffect, useRef, useState } from "react";
import type { ClientMsg, HostState, PlayerPublic } from "../shared/types";
import {
  AIM_MISS_MS, AIM_TARGETS, ARROW_FLIGHT_MS, BOW_COOLDOWN_MS, BOW_DRAW_MS, LASTHIT_CREEPS, SKILLS, type SkillKind, type SkillResult, type SkillSpec,
  aimCourse, lasthitCourse, pourCourse, rankSkill, skillText,
} from "../shared/skill";
import { useCountdown } from "./lib/useRoom";
import { Countdown, initials } from "./components";
import { haptic, sfx } from "./lib/sound";

type Send = (m: ClientMsg) => void;
type Done = (r: SkillResult) => void;
const plus = (n: number) => (n > 0 ? `+${n}` : String(n));
const now = () => performance.now();
/** Resultat när någon laddar om mitt i ett tidsspel (ett försök per spelare). */
const FAIL: Record<Exclude<SkillKind, "order">, SkillResult> = {
  lasthit: { value: LASTHIT_CREEPS * 100000, ok: false },
  aim: { value: 120000, ok: false },
  stopwatch: { value: 60000, ok: false },
  pour: { value: 1000, ok: false },
};

/** Kör en funktion varje bildruta medan komponenten lever. */
function useFrame(fn: (t: number) => void, on = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    let id = 0;
    const loop = () => { ref.current(now()); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [on]);
}

// ===== 1. Last hit =====
//
// Andra creeps nöter ner creepens HP i ryck (banan från fröet, samma för alla). Ett tryck spänner bågen
// (BOW_DRAW_MS) och pilen flyger ARROW_FLIGHT_MS. Skadan räknas först när pilen träffar:
// HP ≤ din skada vid träffen = last hit. Högre = du skadar bara (och gör det lättare för andra att ta den).
// Dör creepen av någon annans slag innan din pil når fram = denied. Ny pil efter BOW_COOLDOWN_MS.

type CreepOutcome = "hit" | "denied";
interface Arrow { firedAt: number; landsAt: number }
interface Float { id: number; text: string; kind: "ally" | "mine" | "gold"; at: number }

const LH_START_MS = 900;
const LH_PAUSE_MS = 1300;

function LastHit({ seed, onDone }: { seed: number; onDone: Done }) {
  const course = useRef(lasthitCourse(seed)).current;
  const [idx, setIdx] = useState(0);
  const [t0, setT0] = useState(() => now() + LH_START_MS);
  const [, setFrame] = useState(0);
  const [outcomes, setOutcomes] = useState<CreepOutcome[]>([]);
  const [flash, setFlash] = useState<CreepOutcome | null>(null);
  const arrows = useRef<Arrow[]>([]);
  const ourDmg = useRef(0);
  const othersSeen = useRef(0);
  const shots = useRef(0);
  const floats = useRef<Float[]>([]);
  const ended = useRef(-1);
  const creep = course[idx];
  const running = !flash && idx < LASTHIT_CREEPS;

  /** HP efter de andra creepsens slag fram till tiden e (ms sedan creepen började). */
  const othersHp = (e: number) => {
    let h = 100;
    for (const x of creep.hits) if (x.at <= e) h = x.hp;
    return h;
  };
  const enterAt = creep ? (creep.hits.find((x) => x.hp <= creep.dmg)?.at ?? 0) : 0;
  const killAt = creep ? creep.hits[creep.hits.length - 1].at : 0;

  const end = (o: CreepOutcome) => {
    if (ended.current === idx) return;
    ended.current = idx;
    const all = [...outcomes, o];
    setOutcomes(all);
    setFlash(o);
    arrows.current = [];
    if (o === "hit") { sfx.lastHit(); haptic.correct(); floats.current.push({ id: Math.random(), text: "+ guld", kind: "gold", at: now() }); }
    else { sfx.denied(); haptic.wrong(); }
    setTimeout(() => {
      if (all.length >= LASTHIT_CREEPS) {
        const misses = all.filter((x) => x !== "hit").length;
        onDone({ value: misses * 100000 + Math.min(999, shots.current) * 100, ok: misses < LASTHIT_CREEPS });
        return;
      }
      ourDmg.current = 0; othersSeen.current = 0; floats.current = [];
      setIdx((i) => i + 1); setFlash(null); setT0(now() + 700);
    }, LH_PAUSE_MS);
  };

  useFrame((t) => {
    setFrame((f) => (f + 1) % 1000000);
    const e = t - t0;
    if (e < 0 || ended.current === idx) return;
    // De andras slag (visa skadesiffror)
    const seen = creep.hits.filter((x) => x.at <= e).length;
    while (othersSeen.current < seen) {
      const h = creep.hits[othersSeen.current];
      const prev = othersSeen.current === 0 ? 100 : creep.hits[othersSeen.current - 1].hp;
      floats.current.push({ id: Math.random(), text: `−${Math.round((prev - h.hp) * 5.5)}`, kind: "ally", at: t });
      othersSeen.current += 1;
      sfx.thud();
    }
    // Pilar som når fram, i ordning
    for (const a of [...arrows.current].sort((x, y) => x.landsAt - y.landsAt)) {
      if (a.landsAt > t) break;
      arrows.current = arrows.current.filter((x) => x !== a);
      const hpAt = othersHp(a.landsAt - t0) - ourDmg.current;
      if (hpAt <= 0) continue; // redan död
      if (hpAt <= creep.dmg) return end("hit");
      ourDmg.current += creep.dmg;
      floats.current.push({ id: Math.random(), text: `−${Math.round(creep.dmg * 5.5)}`, kind: "mine", at: t });
      sfx.arrowHit();
    }
    if (othersHp(e) - ourDmg.current <= 0) end("denied");
    floats.current = floats.current.filter((f) => t - f.at < 900);
  }, running);

  const t = now();
  const e = t - t0;
  const hp = creep ? Math.max(0, (e < 0 ? 100 : othersHp(e)) - ourDmg.current) : 0;
  const last = arrows.current.length ? Math.max(...arrows.current.map((a) => a.firedAt)) : -Infinity;
  const cooldownLeft = Math.max(0, BOW_COOLDOWN_MS - (t - last));
  const drawing = arrows.current.find((a) => t - a.firedAt < BOW_DRAW_MS);

  const shoot = () => {
    if (!running || e < 0 || cooldownLeft > 0) return;
    shots.current += 1;
    const firedAt = now();
    arrows.current.push({ firedAt, landsAt: firedAt + BOW_DRAW_MS + ARROW_FLIGHT_MS });
    sfx.bowDraw();
    setTimeout(() => sfx.bowRelease(), BOW_DRAW_MS);
    haptic.buzz();
  };

  const label = flash === "hit" ? "Last hit!" : flash === "denied" ? "Denied!" : e < 0 ? "Redo…" : "Skjut i förväg, pilen tar en halv sekund";
  // Scenens koordinater (viewBox 360×200)
  const BOW_X = 58, CREEP_X = 290, Y = 128;
  return (
    <div className="skill-game lasthit" data-hp={hp.toFixed(1)} data-dmg={creep?.dmg ?? 0} data-running={running && e >= 0 ? "1" : "0"}
      data-enter-at={(t0 + enterAt).toFixed(0)} data-kill-at={(t0 + killAt).toFixed(0)} data-lead={BOW_DRAW_MS + ARROW_FLIGHT_MS}>
      <p className="muted small">Creep {Math.min(idx + 1, LASTHIT_CREEPS)} av {LASTHIT_CREEPS} · din skada {Math.round((creep?.dmg ?? 0) * 5.5)}</p>
      <svg className="lh-scene" viewBox="0 0 360 200" role="img" aria-label="Bågskytt och creep">
        <defs>
          <linearGradient id="lh-ground" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2b3a8f" /><stop offset="1" stopColor="#141c5c" /></linearGradient>
        </defs>
        <rect x="0" y="150" width="360" height="50" fill="url(#lh-ground)" rx="10" />
        {/* Bågskytten */}
        <g transform={`translate(${BOW_X - 26} ${Y - 46})`}>
          <circle cx="14" cy="10" r="9" fill="#ffd23f" />
          <path d="M14 19 L14 52 M14 52 L4 74 M14 52 L24 74 M14 28 L34 34" stroke="#f4f5ff" strokeWidth="5" strokeLinecap="round" fill="none" />
          <path d="M36 6 Q58 36 36 66" stroke="#c98a3c" strokeWidth="5" fill="none" strokeLinecap="round" />
          <path d={`M36 6 L${drawing ? 22 : 36} 36 L36 66`} stroke="#f4f5ff" strokeWidth="1.5" fill="none" />
        </g>
        {/* Creepen med HP-mätare och strecket för din skada */}
        <g className={`lh-creep${flash ? " " + flash : ""}`} transform={`translate(${CREEP_X - 40} ${Y - 40})`}>
          <rect x="-4" y="-26" width="88" height="12" rx="4" fill="#070b3a" />
          <rect x="-4" y="-26" width={(88 * hp) / 100} height="12" rx="4" fill={hp <= (creep?.dmg ?? 0) ? "#2fe08f" : "#ff3b47"} />
          <rect x={-4 + (88 * (creep?.dmg ?? 0)) / 100 - 1.5} y="-30" width="3" height="20" fill="#ffd23f" />
          <text x="40" y="-33" textAnchor="middle" className="lh-hp" role="meter" aria-label="Creepens HP" aria-valuenow={Math.round(hp)}>{Math.round(hp * 5.5)} HP</text>
          <ellipse cx="40" cy="48" rx="34" ry="26" fill="#6b4e9b" />
          <circle cx="28" cy="42" r="6" fill="#ffd23f" /><circle cx="52" cy="42" r="6" fill="#ffd23f" />
          <path d="M26 60 Q40 52 54 60" stroke="#070b3a" strokeWidth="4" fill="none" />
          <path d="M10 30 L20 40 M70 30 L60 40" stroke="#6b4e9b" strokeWidth="8" strokeLinecap="round" />
        </g>
        {/* Pilar i luften */}
        {arrows.current.filter((a) => t - a.firedAt >= BOW_DRAW_MS).map((a) => {
          const k = Math.min(1, (t - a.firedAt - BOW_DRAW_MS) / ARROW_FLIGHT_MS);
          const x = BOW_X + 12 + (CREEP_X - 34 - BOW_X - 12) * k;
          const y = Y - 10 - Math.sin(Math.PI * k) * 26;
          const ang = Math.atan2(-Math.cos(Math.PI * k) * 26 * Math.PI, CREEP_X - BOW_X) * 180 / Math.PI;
          return (
            <g key={a.firedAt} transform={`translate(${x} ${y}) rotate(${ang})`}>
              <line x1="-26" y1="0" x2="0" y2="0" stroke="#f4f5ff" strokeWidth="3" strokeLinecap="round" />
              <path d="M0 -5 L9 0 L0 5 Z" fill="#ffd23f" />
              <path d="M-26 0 L-31 -5 M-26 0 L-31 5" stroke="#ff9f45" strokeWidth="2" />
            </g>
          );
        })}
        {floats.current.map((f) => (
          <text key={f.id} x={CREEP_X + (f.kind === "mine" ? 34 : f.kind === "gold" ? 0 : -44)} y={Y - 82 - (t - f.at) / 25} textAnchor="middle" className={`lh-float ${f.kind}`}
            opacity={Math.max(0, 1 - (t - f.at) / 900)}>{f.text}</text>
        ))}
      </svg>
      <p className="skill-status" aria-live="polite">{label}</p>
      <button className="btn primary big skill-tap lh-shoot" aria-label="Skjut" disabled={!running || e < 0}
        style={{ "--cd": `${(cooldownLeft / BOW_COOLDOWN_MS) * 100}%` } as React.CSSProperties}
        onPointerDown={(ev) => { ev.preventDefault(); shoot(); }}>{cooldownLeft > 0 ? "Spänner…" : "Skjut!"}</button>
      <ol className="lasthit-log">{outcomes.map((x, i) => <li key={i} className={x}>{x === "hit" ? "✓" : "✕"}</li>)}</ol>
      <p className="muted small">Pilar: {shots.current}</p>
    </div>
  );
}

// ===== 2. Flick =====

function Aim({ seed, onDone }: { seed: number; onDone: Done }) {
  const course = useRef(aimCourse(seed)).current;
  const [i, setI] = useState(-1);
  const [misses, setMisses] = useState(0);
  const start = useRef(0);
  useEffect(() => { const t = setTimeout(() => { start.current = now(); setI(0); }, 900); return () => clearTimeout(t); }, []);
  const hit = () => {
    sfx.tick(); haptic.buzz();
    if (i + 1 >= AIM_TARGETS) {
      const ms = Math.round(now() - start.current + misses * AIM_MISS_MS);
      onDone({ value: Math.max(AIM_TARGETS * 80, Math.min(120000, ms)), ok: true });
    }
    setI(i + 1);
  };
  const p = course[i];
  return (
    <div className="skill-game">
      <p className="skill-status" aria-live="polite">{i < 0 ? "Redo…" : `${Math.min(i + 1, AIM_TARGETS)} av ${AIM_TARGETS}${misses ? ` · ${misses} miss` : ""}`}</p>
      <div className="aim-field" data-target={i} onPointerDown={() => { if (i >= 0 && i < AIM_TARGETS) { setMisses((m) => m + 1); haptic.wrong(); } }}>
        {p && i < AIM_TARGETS && (
          <button className="aim-target" aria-label="Mål" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); hit(); }} />
        )}
      </div>
    </div>
  );
}

// ===== 3. Stoppa klockan =====

const STOPWATCH_VISIBLE_MS = 3000;
const STOPWATCH_OVER_MS = 5000;

function Stopwatch({ target, onDone }: { target: number; onDone: Done }) {
  const start = useRef(now());
  const [ms, setMs] = useState(0);
  const [done, setDone] = useState(false);
  const goal = target * 1000;
  useFrame((t) => {
    const e = t - start.current;
    setMs(e);
    if (e > goal + STOPWATCH_OVER_MS && !done) { setDone(true); onDone({ value: STOPWATCH_OVER_MS, ok: false }); }
  }, !done);
  const stop = () => {
    if (done) return;
    setDone(true); haptic.buzz();
    const diff = Math.round(now() - start.current - goal);
    onDone({ value: Math.max(-60000, Math.min(60000, diff)), ok: true });
  };
  const hidden = ms > STOPWATCH_VISIBLE_MS;
  const txt = (ms / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="skill-game">
      <p className="skill-status">Stoppa på exakt <strong>{target.toLocaleString("sv-SE", { minimumFractionDigits: 2 })} s</strong></p>
      <div className={`stopwatch${hidden ? " dark" : ""}`} aria-live="off">{hidden ? "?,??" : txt}</div>
      <button className="buzzer skill-stop" onPointerDown={(e) => { e.preventDefault(); stop(); }} aria-label="Stopp">STOPP</button>
    </div>
  );
}

// ===== 5. Ordna rätt =====

function Order({ items, prompt, send }: { items: { label: string }[]; prompt: string; send: Send }) {
  const [order, setOrder] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const toggle = (l: string) => setOrder((o) => (o.includes(l) ? o : [...o, l]));
  return (
    <div className="skill-game">
      <p className="skill-status"><strong>{prompt}</strong>: tryck i ordning</p>
      <div className="order-list" role="group" aria-label="Saker att ordna">
        {items.map((it) => {
          const n = order.indexOf(it.label);
          return (
            <button key={it.label} className={`choice-btn${n >= 0 ? " placed" : ""}`} onClick={() => toggle(it.label)} disabled={sent}>
              <span className="letter">{n >= 0 ? n + 1 : ""}</span><span className="txt">{it.label}</span>
            </button>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: "center" }}>
        <button className="btn ghost" disabled={!order.length || sent} onClick={() => setOrder((o) => o.slice(0, -1))}>Ångra</button>
        <button className="btn primary big" disabled={order.length !== items.length || sent}
          onClick={() => { setSent(true); send({ t: "skill", order }); }}>Lås ordning</button>
      </div>
    </div>
  );
}

// ===== 7. Häll upp =====

const FOAM_MS = 700;

function Pour({ seed, onDone }: { seed: number; onDone: Done }) {
  const c = useRef(pourCourse(seed)).current;
  const [level, setLevel] = useState(0);
  const st = useRef<{ phase: "idle" | "pour" | "foam" | "done"; t0: number; last: number; base: number }>({ phase: "idle", t0: 0, last: 0, base: 0 });
  const lvl = useRef(0);
  const end = (final: number, spilled: boolean) => {
    st.current.phase = "done";
    onDone(spilled ? { value: 1000, ok: false } : { value: Math.max(-1000, Math.min(1000, Math.round((final - c.target) * 10))), ok: true });
  };
  useFrame((t) => {
    const s = st.current;
    if (s.phase === "pour") {
      const dt = (t - s.last) / 1000, e = (t - s.t0) / 1000;
      s.last = t;
      lvl.current += (c.rate + c.accel * e) * dt;
    } else if (s.phase === "foam") {
      const k = Math.min(1, (t - s.t0) / FOAM_MS);
      lvl.current = s.base + c.foam * (1 - (1 - k) * (1 - k));
      if (k >= 1 && lvl.current <= 100) { setLevel(lvl.current); return end(lvl.current, false); }
    } else return;
    if (lvl.current > 100) { setLevel(100); sfx.wrong(); haptic.wrong(); return end(100, true); }
    setLevel(lvl.current);
  }, true);
  const down = () => { if (st.current.phase === "idle") { const t = now(); st.current = { phase: "pour", t0: t, last: t, base: 0 }; } };
  const up = () => { if (st.current.phase === "pour") st.current = { phase: "foam", t0: now(), last: now(), base: lvl.current }; };
  const phase = st.current.phase;
  return (
    <div className="skill-game" data-level={level.toFixed(1)} data-target={c.target}>
      <p className="skill-status" aria-live="polite">{phase === "idle" ? "Håll inne för att hälla" : phase === "pour" ? "Släpp vid strecket!" : phase === "foam" ? "Skummet stiger…" : level >= 100 ? "Spillde!" : "Klart"}</p>
      <div className="glass" aria-hidden>
        <div className="beer" style={{ height: `${Math.min(100, level)}%` }} />
        <div className="mark" style={{ bottom: `${c.target}%` }} />
      </div>
      <button className="btn primary big skill-tap" aria-label="Häll" disabled={phase !== "idle" && phase !== "pour"}
        onPointerDown={(e) => { e.preventDefault(); down(); }} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}>Häll</button>
    </div>
  );
}

// ===== Spelarens skill-vy =====

const startedKey = (code: string, q: number) => `kronan.skill.${code}.${q}`;
const readFlag = (k: string) => { try { return sessionStorage.getItem(k) === "1"; } catch { return false; } };
const setFlag = (k: string) => { try { sessionStorage.setItem(k, "1"); } catch { /* */ } };

export function SkillPlay({ state, me, send, serverNow }: { state: HostState; me: PlayerPublic; send: Send; serverNow: () => number }) {
  const spec = state.question?.skill as SkillSpec | undefined;
  const c = state.collect;
  const key = startedKey(state.code, state.qIndex);
  const [playing, setPlaying] = useState(false);
  const [mine, setMine] = useState<SkillResult | null>(null);
  const left = useCountdown(state.phase === "collect" ? c?.deadline : undefined, serverNow);
  const locked = !!c?.answered.includes(me.id);

  // Laddade om mitt i ett tidsspel: försöket är förbrukat. Skickas om vid varje nytt state tills servern
  // har låst resultatet, eftersom första försöket kan komma innan anslutningen hunnit gå med igen.
  const reloaded = useRef<boolean | null>(null);
  if (reloaded.current === null) reloaded.current = readFlag(key);
  const failSent = useRef(0);
  useEffect(() => {
    if (!reloaded.current || !spec || spec.kind === "order" || locked || state.phase !== "collect" || playing || mine) return;
    if (failSent.current++ > 20) return;
    send({ t: "skill", ...FAIL[spec.kind] });
  }, [state, locked]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!spec || !c) return null;
  const info = SKILLS[spec.kind];
  const done: Done = (r) => { setMine(r); setPlaying(false); send({ t: "skill", ...r }); };

  const result = c.results?.find((r) => r.playerId === me.id);
  if (state.phase === "reveal" && c.results) {
    return (
      <div className={`locked-card ${result ? (result.delta > 0 ? "right" : "wrong") : ""}`} role="status">
        {result ? (
          <>
            <p className="display big-verdict">{result.place ? `${result.place}:a plats ${plus(result.delta)} p` : "Diskad den här gången"}</p>
            <p className="muted">{result.text}</p>
          </>
        ) : <p className="display big-verdict">Du hann inte spela</p>}
      </div>
    );
  }
  // Ett försök per spelare: har jag spelat klart visas resultatet, även innan servern hunnit bekräfta.
  if (locked || mine) {
    return (
      <div className="locked-card" role="status">
        <p className="display big-verdict">Klart!</p>
        {mine && <p className="locked-text">{skillText(spec.kind, mine)}</p>}
        <p className="muted">{state.phase === "collect" ? `${c.answered.length} av ${state.players.length} är klara` : "Hosten kollar resultaten…"}</p>
      </div>
    );
  }
  if (state.phase !== "collect") return <div className="locked-card" role="status"><p className="display big-verdict">Tiden är ute</p></div>;

  if (!playing && reloaded.current && spec.kind !== "order") {
    return <div className="locked-card" role="status"><p className="display big-verdict">Försöket är förbrukat</p><p className="muted">Du laddade om mitt i utmaningen.</p></div>;
  }
  if (!playing) {
    return (
      <div className="stack skill-intro" style={{ alignItems: "center", textAlign: "center" }}>
        <Countdown ms={left} total={c.deadline - c.startedAt} size={90} />
        <h3>{info.name}</h3>
        <p>{info.info}</p>
        <p className="muted small">Ett försök. Bäst får 3 p, tvåa 2 p, trea 1 p.</p>
        <button className="btn primary big" onClick={() => { sfx.unlock(); setFlag(key); reloaded.current = false; setPlaying(true); }}>Starta</button>
      </div>
    );
  }
  const seed = c.seed ?? 1;
  switch (spec.kind) {
    case "lasthit": return <LastHit seed={seed} onDone={done} />;
    case "aim": return <Aim seed={seed} onDone={done} />;
    case "stopwatch": return <Stopwatch target={spec.target ?? 10} onDone={done} />;
    case "pour": return <Pour seed={seed} onDone={done} />;
    case "order": return <Order items={spec.items ?? []} prompt={spec.prompt ?? "Lägst först"} send={send} />;
  }
}

// ===== TV och host =====

/** TV under en skill-runda: vilken utmaning, regler, vilka som är klara. */
export function SkillTv({ state, serverNow }: { state: HostState; serverNow: () => number }) {
  const spec = state.question?.skill;
  const c = state.collect;
  const left = useCountdown(state.phase === "collect" ? c?.deadline : undefined, serverNow);
  if (!spec || !c) return null;
  const answered = new Set(c.answered);
  return (
    <div className="stack" style={{ alignItems: "center", width: "100%" }}>
      <div className="collect-banner">
        <span className="mode-tag">{SKILLS[spec.kind].name}</span>
        {state.phase === "collect" ? <><span>Spela i mobilen</span><Countdown ms={left} total={c.deadline - c.startedAt} size={90} /></> : <span>Hosten kollar resultaten…</span>}
      </div>
      <p className="qmeta" style={{ maxWidth: 760 }}>{SKILLS[spec.kind].info}</p>
      {spec.kind === "order" && <p className="qmeta">{spec.prompt}: {(spec.items ?? []).map((i) => i.label).join(" · ")}</p>}
      <ul className="answered-grid" aria-label="Vilka är klara">
        {state.players.map((p) => (
          <li key={p.id} className={`answered${answered.has(p.id) ? " done" : ""}`} style={{ "--c": p.color } as React.CSSProperties}>
            <span className="dot">{initials(p.name)}</span><span>{p.name}</span>
            <span className="state">{answered.has(p.id) ? "Klar" : "Spelar…"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rätt ordning med värden, visas vid reveal i "Ordna rätt". */
export function OrderReveal({ state }: { state: HostState }) {
  const spec = state.question?.skill;
  if (spec?.kind !== "order" || state.phase !== "reveal") return null;
  return (
    <ol className="order-reveal" aria-label="Rätt ordning">
      {(spec.items ?? []).map((it, i) => (
        <li key={it.label}><span className="letter">{i + 1}</span><span className="txt">{it.label}</span><span className="val">{it.show ?? it.value}</span></li>
      ))}
    </ol>
  );
}

/** Host: förhandsrankning medan folk spelar, sedan bekräfta. */
export function SkillHost({ state, send }: { state: HostState; send: Send }) {
  const spec = state.question?.skill;
  const c = state.collect, h = state.collectHost;
  if (!spec || !c || !h) return null;
  if (state.phase !== "collect" && state.phase !== "judge") return null;
  const ranked = rankSkill(spec.kind, h.answers.map((a) => ({ ...a, value: a.value ?? 0, ok: !!a.ok })));
  const missing = state.players.filter((p) => !h.answers.some((a) => a.playerId === p.id));
  return (
    <div className="stack">
      <p className="muted" aria-live="polite">{SKILLS[spec.kind].name}: {h.answers.length} av {state.players.length} klara.{state.phase === "judge" ? " Tiden är ute." : ""}</p>
      {ranked.length > 0 && (
        <ol className="mark-list" aria-label="Skill-resultat">
          {ranked.map(({ item, place, points }) => {
            const p = state.players.find((x) => x.id === item.playerId);
            return (
              <li key={item.playerId}><div className={`mark nobox${points > 0 ? " on" : ""}`}>
                <span className="n">{place || "–"}</span>
                <span className="who" style={{ color: p?.color }}>{p?.name ?? "Okänd"}</span>
                <span className="txt">{item.text}</span>
                <span className="time">{points > 0 ? `+${points} p` : item.ok ? "0 p" : "Diskad"}</span>
              </div></li>
            );
          })}
        </ol>
      )}
      {missing.length > 0 && <p className="muted small">Inte klara: {missing.map((p) => p.name).join(", ")}</p>}
      <div className="row">
        {state.phase === "collect" && <button className="btn ghost" onClick={() => send({ t: "host:close" })}>Stäng utmaningen</button>}
        <button className="btn primary big" onClick={() => send({ t: "host:judge" })}>Bekräfta och visa resultaten</button>
      </div>
    </div>
  );
}
