// "Så här går det till": en kort loopande animation och tydliga steg för varje minispel.
// Visas på introskärmen i mobilen, på TV:n under utmaningen och i demoläget.
// Animationerna är ritade i SVG och styrs av en klocka (useLoop), så de går i takt och loopar mjukt.
import { useEffect, useState } from "react";
import { ARROW_FLIGHT_MS, BOW_DRAW_MS, type SkillKind } from "../shared/skill";

/** Stegen i text, kort och i den ordning man gör saker. */
export const HOWTO_STEPS: Record<SkillKind, string[]> = {
  lasthit: [
    "Andra creeps slår på creepen och HP:n sjunker i ryck.",
    "Gula strecket är din skada. Är HP:n under strecket när pilen träffar dödar du creepen.",
    "Pilen tar ungefär 0,65 s att nå fram, så tryck Skjut strax innan HP:n når strecket.",
    "För tidigt: du skadar bara. För sent: någon annan tar den (denied). Tre creeps, färre pilar vinner vid lika.",
  ],
  aim: [
    "Tio mål dyker upp ett i taget. Tryck på dem så snabbt du kan.",
    "De blir mindre och börjar röra sig. Ringen runt målet visar hur länge det står kvar.",
    "Röda lockbeten med kryss: rör dem inte (+1 s). Missar du helt: +0,5 s. Hinner målet försvinna: +1 s.",
    "Snabbast total tid vinner.",
  ],
  stopwatch: [
    "Klockan startar direkt när du trycker Starta.",
    "Efter 3 sekunder blir den svart, sedan räknar du i huvudet.",
    "Tryck STOPP så nära målet du kan. Närmast vinner, före eller efter spelar ingen roll.",
  ],
  pour: [
    "Håll inne Häll. Drycken rinner allt snabbare.",
    "Släpp lite innan strecket: skummet stiger en bit efter att du släppt.",
    "Närmast strecket vinner. Rinner det över är du diskad.",
  ],
  order: [
    "Tryck på sakerna i rätt ordning, till exempel äldst först.",
    "Tryckte du fel? Ångra tar bort den senaste.",
    "Lås ordning när du är klar. Flest par i rätt ordning vinner.",
  ],
};

const C = { ink: "#070b3a", deep: "#0e1563", studio: "#1b28a8", signal: "#ffd23f", buzz: "#ff3b47", go: "#2fe08f", chalk: "#f4f5ff", mist: "#b9bff0", creep: "#8a4f9b" };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (k: number) => 1 - (1 - clamp01(k)) ** 3;
const lerp = (a: number, b: number, k: number) => a + (b - a) * clamp01(k);
const fmt = (s: number) => s.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Tid i ms inom en loop som är `ms` lång. */
function useLoop(ms: number) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let id = 0;
    const f = () => { setT((performance.now() - start) % ms); id = requestAnimationFrame(f); };
    id = requestAnimationFrame(f);
    return () => cancelAnimationFrame(id);
  }, [ms]);
  return t;
}

/** Fingret: en prick som rör sig, trycker (krymper) och lämnar en ring. */
function Finger({ x, y, down, tapAt, t }: { x: number; y: number; down?: boolean; tapAt?: number; t: number }) {
  const since = tapAt === undefined ? Infinity : t - tapAt;
  const ring = since >= 0 && since < 450;
  return (
    <g pointerEvents="none">
      {ring && <circle cx={x} cy={y} r={10 + since / 18} fill="none" stroke={C.chalk} strokeWidth={3} opacity={1 - since / 450} />}
      {down && <circle cx={x} cy={y} r={20} fill="none" stroke={C.chalk} strokeWidth={2} opacity={0.5} />}
      <circle cx={x} cy={y} r={down || (since >= 0 && since < 140) ? 11 : 14} fill={C.chalk} opacity={0.85} stroke={C.ink} strokeWidth={2} />
    </g>
  );
}

function Caption({ text }: { text: string }) {
  return <text x={160} y={22} textAnchor="middle" className="howto-cap">{text}</text>;
}

function Btn({ x, y, w, label, pressed, color = C.signal }: { x: number; y: number; w: number; label: string; pressed?: boolean; color?: string }) {
  return (
    <g transform={`translate(0 ${pressed ? 2 : 0})`}>
      <rect x={x - w / 2} y={y - 15 + (pressed ? 0 : 0)} width={w} height={30} rx={9} fill={color} />
      <text x={x} y={y + 5} textAnchor="middle" className="howto-btn">{label}</text>
    </g>
  );
}

// ===== Last hit =====

const LH_LOOP = 6000;
const LH_DMG = 30;
const LH_HITS: [number, number][] = [[300, 82], [900, 66], [1500, 51], [2050, 40], [2650, 26]];
const LH_TAP = 2300;
const LH_LAND = LH_TAP + BOW_DRAW_MS + ARROW_FLIGHT_MS; // 2950: HP 26 ≤ 30 → last hit

function LastHitDemo() {
  const t = useLoop(LH_LOOP);
  let hp = 100;
  for (const [at, h] of LH_HITS) if (t >= at) hp = h;
  const dead = t >= LH_LAND;
  if (dead) hp = 0;
  const lastAlly = [...LH_HITS].reverse().find(([at]) => t >= at && t - at < 220);
  const killable = !dead && hp <= LH_DMG;
  const flight = (t - LH_TAP - BOW_DRAW_MS) / ARROW_FLIGHT_MS;
  const fade = t > LH_LOOP - 500 ? (LH_LOOP - t) / 500 : t < 250 ? t / 250 : 1;
  const cap = t < 1500 ? "Andra creeps nöter ner HP:n" : t < LH_LAND ? "Skjut strax innan gula strecket" : "Under strecket när pilen träffar: last hit!";
  const fingerX = 160, fingerY = t < LH_TAP - 500 ? lerp(205, 172, (t - 1600) / 400) : 172;
  const CX = 238, CY = 112;
  return (
    <svg viewBox="0 0 320 200" className="howto-svg" role="img" aria-label="Så går Last hit till">
      <g opacity={fade}>
        <Caption text={cap} />
        <rect x={0} y={136} width={320} height={20} fill={C.deep} rx={6} />
        {/* bågskytt */}
        <g transform="translate(46 78)">
          <circle cx={10} cy={8} r={8} fill={C.signal} />
          <path d="M10 16 L10 42 M10 42 L2 58 M10 42 L18 58 M10 24 L28 28" stroke={C.chalk} strokeWidth={4} strokeLinecap="round" fill="none" />
          <path d="M28 4 Q46 28 28 52" stroke="#c98a3c" strokeWidth={4} fill="none" strokeLinecap="round" />
          <path d={`M28 4 L${t > LH_TAP && t < LH_TAP + BOW_DRAW_MS ? 17 : 28} 28 L28 52`} stroke={C.chalk} strokeWidth={1.2} fill="none" />
        </g>
        {/* allierad creep som hugger */}
        <g transform={`translate(${178 + (lastAlly ? Math.sin(((t - lastAlly[0]) / 220) * Math.PI) * 10 : 0)} 104)`}>
          <ellipse cx={12} cy={18} rx={16} ry={13} fill="#3f8f6a" />
          <circle cx={20} cy={14} r={3} fill="#7ff6ff" />
        </g>
        {/* målcreepen */}
        <g opacity={dead ? Math.max(0, 1 - (t - LH_LAND) / 700) : 1} transform={`translate(${CX} ${CY + (dead ? Math.min(20, (t - LH_LAND) / 30) : 0)}) rotate(${dead ? Math.min(70, (t - LH_LAND) / 8) : 0})`}>
          <ellipse cx={0} cy={4} rx={26} ry={20} fill={lastAlly && !dead ? "#c57bd6" : C.creep} />
          <circle cx={-9} cy={0} r={4.5} fill={C.signal} /><circle cx={9} cy={0} r={4.5} fill={C.signal} />
        </g>
        {/* HP-mätaren */}
        {!dead && (
          <g transform={`translate(${CX - 40} 66)`}>
            <rect x={0} y={0} width={80} height={10} rx={3} fill={C.ink} />
            <rect x={0} y={0} width={(80 * hp) / 100} height={10} rx={3} fill={killable ? C.go : C.buzz} />
            <rect x={(80 * LH_DMG) / 100 - 1.5} y={-4} width={3} height={18} fill={C.signal} />
            <text x={40} y={-8} textAnchor="middle" className="howto-small">{Math.round(hp * 5.5)} HP</text>
          </g>
        )}
        {killable && <ellipse cx={CX} cy={136} rx={30} ry={6} fill="none" stroke={C.go} strokeWidth={2.5} opacity={0.6 + Math.sin(t / 80) * 0.3} />}
        {/* pilen */}
        {flight >= 0 && flight <= 1 && (() => {
          const x = lerp(78, CX - 22, flight), y = 104 - Math.sin(Math.PI * flight) * 22;
          const ang = (Math.atan2(-Math.cos(Math.PI * flight) * 22 * Math.PI, CX - 100) * 180) / Math.PI;
          return (
            <g transform={`translate(${x} ${y}) rotate(${ang})`}>
              <line x1={-20} y1={0} x2={0} y2={0} stroke={C.chalk} strokeWidth={2.5} strokeLinecap="round" />
              <path d="M0 -4 L8 0 L0 4 Z" fill={C.signal} />
            </g>
          );
        })()}
        {/* tidslinje: tryck → 0,65 s → träff */}
        {t >= LH_TAP && t < LH_LAND + 900 && (
          <g opacity={0.9}>
            <line x1={78} x2={CX - 22} y1={142} y2={142} stroke={C.mist} strokeDasharray="3 4" />
            <text x={(78 + CX) / 2 - 10} y={153} textAnchor="middle" className="howto-small">pilen tar 0,65 s</text>
          </g>
        )}
        {dead && t < LH_LAND + 1700 && (
          <g transform={`translate(${CX} ${88 - Math.min(18, (t - LH_LAND) / 40)})`}>
            <text textAnchor="middle" className="howto-win">LAST HIT!</text>
            <text y={20} textAnchor="middle" className="howto-gold">+45 guld</text>
          </g>
        )}
        <Btn x={160} y={176} w={150} label="Skjut!" pressed={t >= LH_TAP && t < LH_TAP + 140} />
        {t > 1600 && t < LH_TAP + 700 && <Finger x={fingerX} y={fingerY} tapAt={LH_TAP} t={t} />}
      </g>
    </svg>
  );
}

// ===== Flick =====

const AIM_LOOP = 6200;
// Tre mål: ett stilla, ett med ett rött lockbete bredvid, ett som rör sig. Fingret träffar rätt varje gång.
const AIM_SEQ = [
  { x: 228, y: 80, at: 500, hit: 1050, r: 19 },
  { x: 92, y: 132, at: 1450, hit: 2250, r: 16, decoy: [196, 140] as [number, number] },
  { x: 170, y: 92, at: 2650, hit: 3500, r: 14, move: true },
];
const aimX = (s: (typeof AIM_SEQ)[number], t: number) => (s.move ? s.x + Math.sin((t - s.at) / 260) * 55 : s.x);

function AimDemo() {
  const t = useLoop(AIM_LOOP);
  const k = AIM_SEQ.findIndex((s) => t < s.hit + 120);
  const s = k >= 0 ? AIM_SEQ[k] : null;
  const done = k < 0;
  const prev = k > 0 ? AIM_SEQ[k - 1] : null;
  const from = prev ? [aimX(prev, prev.hit), prev.y] : [160, 200];
  const to = s ? [aimX(s, s.hit), s.y] : [160, 200];
  const travel = s ? ease((t - (s.hit - 320)) / 300) : 0;
  const fx = lerp(from[0], to[0], travel), fy = lerp(from[1], to[1], travel);
  const cap = !s ? "Snabbast tid vinner" : k === 0 ? "Träffa målet så snabbt du kan" : k === 1 ? "Rör inte det röda lockbetet (+1 s)" : "Senare mål är mindre och rör sig";
  const life = s && t >= s.at ? clamp01(1 - (t - s.at) / 2400) : 1;
  return (
    <svg viewBox="0 0 320 200" className="howto-svg" role="img" aria-label="Så går Flick till">
      <Caption text={cap} />
      <rect x={20} y={34} width={280} height={154} rx={12} fill={C.deep} />
      {[0, 1, 2, 3].map((g) => <rect key={g} x={20 + g * 18} y={34 + g * 12} width={280 - g * 36} height={154 - g * 24} rx={10} fill="none" stroke="#3b5bff" strokeOpacity={0.35 - g * 0.07} />)}
      {s && t >= s.at && t < s.hit && (() => {
        const x = aimX(s, t), sc = ease((t - s.at) / 180);
        return (
          <g>
            {s.decoy && (
              <g transform={`translate(${s.decoy[0]} ${s.decoy[1]}) scale(${sc})`}>
                <circle r={s.r + 1} fill="#1a0006" stroke={C.buzz} strokeWidth={3} />
                <path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke={C.chalk} strokeWidth={3} strokeLinecap="round" />
              </g>
            )}
            <g transform={`translate(${x} ${s.y}) scale(${sc})`}>
              <circle r={s.r + 5} fill="none" stroke="#46d9ff" strokeWidth={2} />
              <path d={`M0 ${-(s.r + 2)} A ${s.r + 2} ${s.r + 2} 0 ${life > 0.5 ? 1 : 0} 1 ${Math.sin(life * Math.PI * 2) * (s.r + 2)} ${-Math.cos(life * Math.PI * 2) * (s.r + 2)}`} fill="none" stroke={C.signal} strokeWidth={2} />
              <circle r={s.r} fill={C.chalk} /><circle r={s.r * 0.66} fill={C.buzz} /><circle r={s.r * 0.33} fill={C.signal} />
            </g>
          </g>
        );
      })()}
      {AIM_SEQ.map((q) => t >= q.hit && t < q.hit + 500 && (
        <g key={q.at}>
          <circle cx={aimX(q, q.hit)} cy={q.y} r={q.r + (t - q.hit) / 12} fill="none" stroke={C.signal} strokeWidth={3} opacity={1 - (t - q.hit) / 500} />
          <text x={aimX(q, q.hit)} y={q.y - q.r - 8 - (t - q.hit) / 30} textAnchor="middle" className="howto-small" style={{ fill: C.go }}>{((q.hit - q.at) / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 2 })} s</text>
        </g>
      ))}
      {!done && <text x={290} y={52} textAnchor="end" className="howto-small">Mål {Math.min(3, k + 1)}/10</text>}
      {done ? <text x={160} y={118} textAnchor="middle" className="howto-win">Klart: 7,42 s</text>
        : t > 300 && <Finger x={fx} y={fy} tapAt={s?.hit} t={t} />}
    </svg>
  );
}

// ===== Stoppa klockan =====

const SW_LOOP = 6400;
const SW_START = 400, SW_TAP = SW_START + 3950, SW_TARGET = 4;

function StopwatchDemo() {
  const t = useLoop(SW_LOOP);
  const e = Math.max(0, Math.min(t, SW_TAP) - SW_START) / 1000;
  const hidden = e > 3 && t < SW_TAP;
  const stopped = t >= SW_TAP;
  const cap = t < SW_START + 3000 ? "Klockan syns i 3 sekunder…" : !stopped ? "…sedan räknar du i huvudet" : "Tryck STOPP så nära målet du kan";
  return (
    <svg viewBox="0 0 320 200" className="howto-svg" role="img" aria-label="Så går Stoppa klockan till">
      <Caption text={cap} />
      <text x={160} y={48} textAnchor="middle" className="howto-small">Mål: {fmt(SW_TARGET)} s</text>
      <rect x={70} y={58} width={180} height={64} rx={14} fill={hidden ? C.ink : C.deep} />
      <text x={160} y={104} textAnchor="middle" className="howto-clock">{hidden ? "?,??" : fmt(e)}</text>
      {stopped && t < SW_LOOP - 200 && <text x={160} y={140} textAnchor="middle" className="howto-win small">−0,05 s från målet</text>}
      <Btn x={160} y={174} w={120} label="STOPP" color={C.buzz} pressed={t >= SW_TAP && t < SW_TAP + 140} />
      {t > SW_TAP - 900 && t < SW_TAP + 700 && <Finger x={160} y={lerp(205, 174, (t - SW_TAP + 900) / 400)} tapAt={SW_TAP} t={t} />}
    </svg>
  );
}

// ===== Häll upp =====

const PO_LOOP = 6000;
const PO_DOWN = 700, PO_UP = 3106, PO_MARK = 74, PO_FOAM = 5; // släpp på 68,4 % + 5 % skum = 0,6 % under

function PourDemo() {
  const t = useLoop(PO_LOOP);
  const pourLevel = (ms: number) => { const s = Math.max(0, ms - PO_DOWN) / 1000; return 14 * s + 6 * s * s; };
  const atRelease = pourLevel(PO_UP);
  const level = t < PO_UP ? pourLevel(t) : atRelease + PO_FOAM * ease((t - PO_UP) / 700);
  const holding = t >= PO_DOWN && t < PO_UP;
  const cap = t < PO_DOWN ? "Håll inne Häll" : holding ? "Drycken rinner allt snabbare…" : t < PO_UP + 700 ? "Släpp innan strecket, skummet stiger" : "Nära strecket vinner";
  const GX = 120, GY = 40, GW = 80, GH = 110;
  return (
    <svg viewBox="0 0 320 200" className="howto-svg" role="img" aria-label="Så går Häll upp till">
      <Caption text={cap} />
      <rect x={GX} y={GY} width={GW} height={GH} rx={8} fill={C.deep} stroke={C.mist} strokeWidth={2} />
      <rect x={GX + 2} y={GY + GH - (GH - 4) * (level / 100) - 2} width={GW - 4} height={(GH - 4) * (level / 100)} rx={6} fill="#f2a93b" />
      {t >= PO_UP && <rect x={GX + 2} y={GY + GH - (GH - 4) * (level / 100) - 2} width={GW - 4} height={8} rx={4} fill="#fff6dc" />}
      <line x1={GX - 8} x2={GX + GW + 8} y1={GY + GH - (GH - 4) * (PO_MARK / 100) - 2} y2={GY + GH - (GH - 4) * (PO_MARK / 100) - 2} stroke={C.signal} strokeWidth={3} />
      <text x={GX + GW + 12} y={GY + GH - (GH - 4) * (PO_MARK / 100) + 2} className="howto-small">strecket</text>
      {holding && <path d={`M${GX + GW / 2} 30 L${GX + GW / 2} ${GY + GH - (GH - 4) * (level / 100) - 2}`} stroke="#f2a93b" strokeWidth={5} />}
      {t > PO_UP + 800 && t < PO_LOOP - 200 && <text x={160} y={GY - 4} textAnchor="middle" className="howto-win small">0,6 % under</text>}
      <Btn x={160} y={176} w={120} label="Häll" pressed={holding} />
      {t > PO_DOWN - 500 && t < PO_UP + 600 && <Finger x={160} y={holding ? 176 : t < PO_DOWN ? lerp(205, 176, (t - PO_DOWN + 500) / 400) : lerp(176, 205, (t - PO_UP) / 400)} down={holding} t={t} />}
    </svg>
  );
}

// ===== Ordna rätt =====

const OR_LOOP = 5600;
const OR_ITEMS = [{ label: "Breaking Bad", y: 64 }, { label: "Game of Thrones", y: 100 }, { label: "How I Met Your Mother", y: 136 }];
const OR_TAPS = [{ item: 2, at: 900 }, { item: 0, at: 1700 }, { item: 1, at: 2500 }];
const OR_LOCK = 3300;

function OrderDemo() {
  const t = useLoop(OR_LOOP);
  const done = OR_TAPS.filter((x) => t >= x.at);
  const next = OR_TAPS.find((x) => t < x.at);
  const target = next ? { x: 210, y: OR_ITEMS[next.item].y } : { x: 160, y: 180 };
  const prevTap = [...OR_TAPS].reverse().find((x) => t >= x.at);
  const from = prevTap ? { x: 210, y: OR_ITEMS[prevTap.item].y } : { x: 210, y: 205 };
  const goalAt = next ? next.at : OR_LOCK;
  const k = ease((t - (goalAt - 450)) / 350);
  const fx = lerp(from.x, target.x, k), fy = lerp(from.y, target.y, k);
  const tapAt = t >= OR_LOCK ? OR_LOCK : prevTap?.at;
  return (
    <svg viewBox="0 0 320 200" className="howto-svg" role="img" aria-label="Så går Ordna rätt till">
      <Caption text={t < OR_LOCK ? "Äldst först: tryck i ordning" : "Lås ordning när du är klar"} />
      {OR_ITEMS.map((it, i) => {
        const n = done.findIndex((d) => d.item === i);
        return (
          <g key={it.label}>
            <rect x={40} y={it.y - 14} width={240} height={28} rx={8} fill={n >= 0 ? C.studio : C.deep} stroke={n >= 0 ? C.signal : "none"} strokeWidth={2} />
            <rect x={48} y={it.y - 10} width={20} height={20} rx={5} fill={C.signal} />
            <text x={58} y={it.y + 5} textAnchor="middle" className="howto-btn">{n >= 0 ? n + 1 : ""}</text>
            <text x={78} y={it.y + 5} className="howto-item">{it.label}</text>
          </g>
        );
      })}
      <Btn x={160} y={180} w={140} label="Lås ordning" pressed={t >= OR_LOCK && t < OR_LOCK + 140} />
      {t >= OR_LOCK + 300 && t < OR_LOCK + 2000 && <text x={160} y={46} textAnchor="middle" className="howto-win small">Helt rätt!</text>}
      {t > 400 && t < OR_LOCK + 600 && <Finger x={fx} y={fy} tapAt={tapAt} t={t} />}
    </svg>
  );
}

const DEMOS: Record<SkillKind, () => React.ReactElement> = {
  lasthit: LastHitDemo, aim: AimDemo, stopwatch: StopwatchDemo, pour: PourDemo, order: OrderDemo,
};

/** Animation + numrerade steg. `size` styr bara bredden; "tv" ger större text för den delade skärmen. */
export function HowTo({ kind, size = "phone" }: { kind: SkillKind; size?: "phone" | "tv" }) {
  const Demo = DEMOS[kind];
  return (
    <div className={`howto ${size}`}>
      <div className="howto-anim"><Demo /></div>
      <ol className="howto-steps">
        {HOWTO_STEPS[kind].map((s) => <li key={s}>{s}</li>)}
      </ol>
    </div>
  );
}
