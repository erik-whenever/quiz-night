// Kenta, fyllot (Eriks idé 2026-11-01, i andan av Pipey i Silicon Valley: en medvetet töntig hjälpreda).
// Servern bestämmer NÄR han säger något och vem som är buddy/hooker (worker/drunk.ts). Här finns
// replikerna, sluddret, rösten (webbläsarens talsyntes, gratis) och figuren på TV:n.
import { useEffect, useRef, useState } from "react";
import type { DrunkCue, DrunkPublic, PlayerPublic } from "../shared/types";
import { DRUNK_HOOK_SPIN_MS, DRUNK_HOOK_TALK_MS, DRUNK_NAME, drunkCueMs } from "../shared/types";
import { sfx } from "./lib/sound";

// ===== Repliker =====
// {b} = buddyn, {h} = hookern, {o} = motståndaren. Ljud i hakparentes: [rap] [hick] [skål] [klunk].

const LINES: Record<"intro" | "win" | "lose" | "hook" | "hookLand", string[]> = {
  intro: [
    "Tjeeena! Det är jag, Kenta. Åh, {b}... {b} är min buddy. Asså MIN BUDDYYY! [hick] Jag hejar fan på dig hela kvällen.",
    "Hörrni, hörrni. Kenta här. Jag har bestämt mig. {b}! Du är min buddy. MIN. BUDDY. [rap] Ingen annan. Jag hejar fan på dig.",
    "Vafan, är det quiz i kväll? Ingen sa nåt. Okej. {b}, kom hit. Du är min buddy. Buddy, buddy... [hick] Nu kör vi.",
  ],
  win: [
    "Faaaan! Jag VISSTE att du var min buddy! Buddy buddy, buddy! [rap] Det här firas med en sup. [skål]",
    "{b}! Det är MIN buddy det där! Såg ni? [hick] Jag sa ju det. Sup på det! [skål]",
    "J-j-jag gråter lite nu. {b}, du är för bra. Min buddy... [rap] Sup! [skål]",
    "Där satt den! {b} levererar. Det är såhär buddies gör. [skål] Skååål!",
  ],
  lose: [
    "Neeej, {b}... min buddy. Det där var tungt. [rap] Det kräver en sup. För sorgen. [klunk]",
    "Vad hände där, {b}? Nej nej, jag är inte arg. Jag är bara... besviken. [hick] En sup. Bara en. [klunk]",
    "Det är okej, {b}. Det är okej. Alla gör fel. Jag gör fel hela tiden. [rap] Sup. [klunk]",
    "Fel?! Min buddy?! Vem har skrivit den här frågan? [hick] Jag behöver en sup. Kanske två. [klunk]",
  ],
  hook: [
    "HÖRRNI! Nu är det dags för lite hooker-grejer vaaaa? [hick] {h}! Du är hookern. Och du ska möta... hjulet får bestämma!",
    "Tyst, tyst, tyst! [rap] Hooker-off! {h}, ta fram kroken. Och motståndaren är... snurra!",
  ],
  hookLand: [
    "{h} mot {o}! Krok i krok. Ingen fuskar, jag ser allt. [hick]",
    "{o}! Haha, lycka till. {h} mot {o}, nu kör vi! [rap]",
  ],
};

/** Hur full han är: 1 (lite på) – 6 (helt borta). Varje replik efter introt är en sup till. */
export const drunkLevel = (sips: number) => Math.min(6, 1 + sips);

/** Liten deterministisk slump, så att TV och demo säger samma sak för samma replik. */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOWELS = /[aeiouyåäöAEIOUYÅÄÖ]/;

/** Sluddra en mening: sj-ljud, utdragna vokaler, upprepade ord och tappad tråd. Namn lämnas i fred. */
export function slur(text: string, level: number, seed: number, keep: string[] = []): string {
  const r = rng(seed);
  const p = Math.max(0, level - 1);
  return text.split(" ").map((w) => {
    if (w.startsWith("[") || keep.some((k) => k && w.includes(k))) return w;
    let x = w;
    if (r() < 0.1 * p) x = x.replace(/s(?!j)/, "sj").replace(/^S(?!j)/, "Sj");
    if (r() < 0.07 * p) {
      const m = [...x].map((ch, i) => (VOWELS.test(ch) ? i : -1)).filter((i) => i >= 0).pop();
      if (m !== undefined) x = x.slice(0, m + 1) + x[m].toLowerCase().repeat(1 + Math.floor(r() * 3)) + x.slice(m + 1);
    }
    if (r() < 0.035 * p && /^[\p{L}]+$/u.test(x)) x = `${x} ${x.toLowerCase()}`;
    if (level >= 4 && r() < 0.05 * p && !/[.!?,]$/.test(x)) x += "...";
    return x;
  }).join(" ");
}

type Names = { b: string; h?: string; o?: string };

/** Repliken för en cue, ifylld med namn och sluddrad efter fyllenivå. land = hooker-off efter hjulet. */
export function drunkLine(cue: DrunkCue, names: Names, land = false): string {
  const key = cue.kind === "hookoff" ? (land ? "hookLand" : "hook") : cue.kind;
  const bank = LINES[key];
  let line = bank[(cue.id * 7 + (land ? 3 : 0)) % bank.length];
  if (land && names.b && (names.b === names.h || names.b === names.o)) line += " Och jag hejar på {b}, självklart.";
  const filled = line.replaceAll("{b}", names.b).replaceAll("{h}", names.h ?? "någon").replaceAll("{o}", names.o ?? "någon");
  return slur(filled, drunkLevel(cue.sips), cue.id * 131 + (land ? 17 : 0), [names.b, names.h ?? "", names.o ?? ""]);
}

// ===== Röst =====

const EFFECTS: Record<string, (lvl: number) => void> = {
  rap: (lvl) => sfx.burp(Math.min(1, 0.25 + lvl * 0.12)),
  hick: () => sfx.hiccup(),
  skål: () => sfx.clink(),
  klunk: () => sfx.gulp(),
};

/** Dela upp en replik i tal och ljud. */
function parts(line: string): { say?: string; fx?: string }[] {
  return line.split(/(\[[^\]]+\])/).map((x) => x.trim()).filter(Boolean)
    .map((x) => (x.startsWith("[") ? { fx: x.slice(1, -1) } : { say: x }));
}

function svVoice(): SpeechSynthesisVoice | null {
  try {
    const vs = window.speechSynthesis.getVoices();
    return vs.find((v) => v.lang.toLowerCase().startsWith("sv")) ?? null;
  } catch { return null; }
}

/**
 * Säg repliken: tal via webbläsarens talsyntes (svensk röst om den finns) med ljuden emellan.
 * Fullare = långsammare och mer vinglig tonhöjd. Utan röst spelas bara ljuden. Returnerar en stoppfunktion.
 */
export function speak(line: string, level: number, voiceOn: boolean, onTalking?: (on: boolean) => void): () => void {
  let stopped = false;
  const timers: number[] = [];
  const queue = parts(line);
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const voice = voiceOn && synth ? svVoice() : null;
  const keep: SpeechSynthesisUtterance[] = []; // Chrome släpper annars uttalet mitt i
  let i = 0;
  const next = () => {
    if (stopped) return;
    const part = queue[i++];
    if (!part) { onTalking?.(false); return; }
    if (part.fx) {
      onTalking?.(false);
      EFFECTS[part.fx]?.(level);
      timers.push(window.setTimeout(next, part.fx === "rap" ? 650 : 450));
      return;
    }
    if (!synth || !voiceOn || (!voice && !synth.getVoices().length)) {
      // Ingen röst: bara pratbubblan, ge läsaren lite tid innan nästa ljud.
      timers.push(window.setTimeout(next, Math.min(2600, 40 * (part.say?.length ?? 0))));
      return;
    }
    const u = new SpeechSynthesisUtterance(part.say!);
    if (voice) u.voice = voice;
    u.lang = "sv-SE";
    u.rate = Math.max(0.62, 1.02 - level * 0.06);
    u.pitch = Math.max(0.5, Math.min(1.6, 0.95 + (Math.random() - 0.5) * 0.08 * level));
    u.volume = 1;
    u.onstart = () => onTalking?.(true);
    u.onend = () => { onTalking?.(false); timers.push(window.setTimeout(next, 120)); };
    u.onerror = () => { onTalking?.(false); timers.push(window.setTimeout(next, 120)); };
    keep.push(u);
    synth.speak(u);
  };
  next();
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    try { if (keep.length) synth?.cancel(); } catch { /* */ }
    onTalking?.(false);
  };
}

// ===== Figuren =====

/** Kenta: rund skalle, röd näsa och halvstängda ögon. Rodnar och vinglar mer ju fullare han är. */
export function DrunkFace({ level, talking, size = 120 }: { level: number; talking: boolean; size?: number }) {
  const lid = 4 + level * 1.6;
  return (
    <svg className={`drunk-face${talking ? " talking" : ""}`} viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
      <ellipse cx="60" cy="64" rx="40" ry="44" fill="#F2C6A0" />
      <path d="M24 46 Q30 18 60 18 Q92 18 96 46 Q86 30 60 32 Q36 30 24 46Z" fill="#6B4B33" />
      <ellipse cx="38" cy="76" rx="9" ry="6" fill="#FF5D73" opacity={0.15 + level * 0.09} />
      <ellipse cx="82" cy="76" rx="9" ry="6" fill="#FF5D73" opacity={0.15 + level * 0.09} />
      <g className="drunk-eyes">
        <ellipse cx="45" cy="58" rx="8" ry="9" fill="#fff" />
        <ellipse cx="75" cy="58" rx="8" ry="9" fill="#fff" />
        <circle cx={46 + (level % 2)} cy="60" r="3.6" fill="#1b1b2f" />
        <circle cx={73 - (level % 3)} cy="61" r="3.6" fill="#1b1b2f" />
        <rect x="36" y="48" width="18" height={lid} rx="3" fill="#E7B08A" />
        <rect x="66" y="48" width="18" height={lid + 1.5} rx="3" fill="#E7B08A" />
      </g>
      <ellipse cx="60" cy="72" rx={8 + level * 0.6} ry={7 + level * 0.5} fill="#E8434F" />
      <ellipse cx="57" cy="69" rx="2.5" ry="2" fill="#fff" opacity="0.5" />
      <path className="drunk-mouth" d="M46 90 Q60 98 74 88" stroke="#5a2a2a" strokeWidth="4" fill="#7a2f2f" strokeLinecap="round" />
    </svg>
  );
}

/** En liten sejdel att vifta med. */
function Mug() {
  return (
    <svg className="drunk-mug" viewBox="0 0 48 56" width="44" height="52" aria-hidden="true">
      <rect x="6" y="14" width="28" height="38" rx="5" fill="#FFD23F" opacity="0.9" />
      <path d="M34 22 h6 a6 6 0 0 1 6 6 v8 a6 6 0 0 1 -6 6 h-6" stroke="#F4F5FF" strokeWidth="4" fill="none" />
      <path d="M4 16 Q8 4 18 9 Q24 2 32 9 Q40 8 36 18 Z" fill="#F4F5FF" />
      <rect x="6" y="14" width="28" height="38" rx="5" fill="none" stroke="#F4F5FF" strokeWidth="2.5" />
    </svg>
  );
}

// ===== Hooker-off-hjulet =====

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Hjul med spelarnas namn. Snurrar från startAt och landar på motståndaren. */
function PlayerWheel({ names, colors, target, startAt, spinMs, serverNow, size, onLanded }: {
  names: string[]; colors: string[]; target: number; startAt: number; spinMs: number; serverNow: () => number; size: number; onLanded: () => void;
}) {
  const n = Math.max(1, names.length);
  const seg = 360 / n;
  const final = 360 * 6 + mod(-(target * seg + seg / 2), 360);
  const [view, setView] = useState({ rot: 0, ms: 0 });
  const landedCb = useRef(onLanded);
  useEffect(() => { landedCb.current = onLanded; });
  useEffect(() => {
    const wait = startAt - serverNow();
    const end = startAt + spinMs - serverNow();
    if (end <= 0) { setView({ rot: final, ms: 0 }); landedCb.current(); return; }
    const timers = [
      window.setTimeout(() => { sfx.next(); setView({ rot: final, ms: Math.min(spinMs, end) }); }, Math.max(0, wait)),
      window.setTimeout(() => landedCb.current(), end),
    ];
    return () => timers.forEach(clearTimeout);
  }, [startAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const R = 150;
  return (
    <svg className="drunk-wheel" viewBox="-170 -182 340 352" width={size} height={size} role="img" aria-label="Hjulet väljer motståndare">
      <g style={{ transform: `rotate(${view.rot}deg)`, transition: view.ms ? `transform ${view.ms}ms cubic-bezier(0.12, 0.62, 0.12, 1)` : "none" }}>
        <circle r={R + 6} className="wheel-rim" />
        {names.map((name, i) => {
          const a0 = (i * seg * Math.PI) / 180, a1 = ((i + 1) * seg * Math.PI) / 180;
          const d = n === 1 ? `M0 ${-R} A${R} ${R} 0 1 1 -0.01 ${-R}Z`
            : `M0 0 L${R * Math.sin(a0)} ${-R * Math.cos(a0)} A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${R * Math.sin(a1)} ${-R * Math.cos(a1)}Z`;
          return (
            <g key={i}>
              <path d={d} fill={colors[i] ?? "#4CC9F0"} opacity={i % 2 ? 0.85 : 1} stroke="rgba(0,0,0,.25)" />
              <g transform={`rotate(${i * seg + seg / 2}) translate(0 ${-R * 0.62})`}>
                <text textAnchor="middle" y="6" className="drunk-wheel-name">{name.length > 10 ? `${name.slice(0, 9)}…` : name}</text>
              </g>
            </g>
          );
        })}
      </g>
      <circle r={24} className="wheel-hub" />
      <path d="M-14 -182 14 -182 0 -152Z" className="wheel-pointer" />
    </svg>
  );
}

// ===== På TV:n =====

/** Röst på/av på den här skärmen (bubblan syns ändå). */
export function useDrunkVoice(): [boolean, () => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem("kronan.kenta") !== "tyst"; } catch { return true; } });
  return [on, () => setOn((v) => {
    try { localStorage.setItem("kronan.kenta", v ? "tyst" : "prat"); } catch { /* */ }
    if (v) try { window.speechSynthesis?.cancel(); } catch { /* */ }
    return !v;
  })];
}

/**
 * Kenta på TV:n. Syns medan en replik pågår och pratar bara om repliken är färsk
 * (laddar man om sidan mitt i säger han inte om samma sak).
 */
export function DrunkOverlay({ drunk, players, serverNow, voice }: {
  drunk: DrunkPublic | null | undefined; players: PlayerPublic[]; serverNow: () => number; voice: boolean;
}) {
  const cue = drunk?.cue ?? null;
  const [visible, setVisible] = useState(false);
  const [talking, setTalking] = useState(false);
  const [landed, setLanded] = useState(false);
  const spoken = useRef<string | null>(null);
  const name = (id?: string) => players.find((p) => p.id === id)?.name ?? "någon";
  const names: Names = { b: name(cue?.buddyId), h: cue?.hooker ? name(cue.hooker) : undefined, o: cue?.opponent ? name(cue.opponent) : undefined };
  const level = drunkLevel(cue?.sips ?? 0);
  const line = cue ? drunkLine(cue, names) : "";
  const landLine = cue?.kind === "hookoff" ? drunkLine(cue, names, true) : "";

  // Synlig medan repliken pågår.
  useEffect(() => {
    if (!cue) { setVisible(false); return; }
    const left = cue.at + drunkCueMs(cue.kind) - serverNow();
    setLanded(cue.kind === "hookoff" && serverNow() > cue.at + DRUNK_HOOK_TALK_MS + DRUNK_HOOK_SPIN_MS);
    if (left <= 0) { setVisible(false); return; }
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), left);
    return () => clearTimeout(t);
  }, [cue?.id, cue?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prata (en gång per replik, bara om den är färsk).
  useEffect(() => {
    if (!cue || spoken.current === `${cue.id}:${cue.at}`) return;
    spoken.current = `${cue.id}:${cue.at}`;
    if (serverNow() - cue.at > 1500) return;
    return speak(line, level, voice, setTalking);
  }, [cue?.id, cue?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hooker-off: andra repliken när hjulet landat.
  const landSpoken = useRef<number | null>(null);
  useEffect(() => {
    if (!landed || !cue || cue.kind !== "hookoff" || landSpoken.current === cue.id) return;
    landSpoken.current = cue.id;
    if (serverNow() - (cue.at + DRUNK_HOOK_TALK_MS + DRUNK_HOOK_SPIN_MS) > 1500) return;
    return speak(landLine, level, voice, setTalking);
  }, [landed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cue || !visible) return null;
  const sway = { ["--sway" as string]: `${1.5 + level * 1.3}deg`, ["--sway-s" as string]: `${Math.max(1.1, 2.8 - level * 0.28)}s` };
  const label = `${DRUNK_NAME} säger: ${(landed && landLine ? landLine : line).replace(/\[[^\]]+\]/g, "")}`;

  const bubble = (text: string) => (
    <p className="drunk-bubble">
      {parts(text).map((p, i) => p.fx ? <em key={i} className="drunk-fx">*{p.fx}*</em> : <span key={i}>{p.say} </span>)}
    </p>
  );

  if (cue.kind === "hookoff") {
    const pool = (cue.pool ?? []).map((id) => players.find((p) => p.id === id)).filter((p): p is PlayerPublic => !!p);
    const target = Math.max(0, pool.findIndex((p) => p.id === cue.opponent));
    return (
      <div className="drunk-hook" role="status" aria-label={label}>
        <div className="drunk-hook-card">
          <div className="drunk-row" style={sway}>
            <div className="drunk-body"><DrunkFace level={level} talking={talking} size={110} /><Mug /></div>
            <div className="stack" style={{ gap: 6 }}>
              <span className="drunk-name">{DRUNK_NAME} <span className="muted small">· {"🍺".repeat(Math.min(6, cue.sips))}</span></span>
              {bubble(landed ? landLine : line)}
            </div>
          </div>
          {pool.length > 0 && (
            <PlayerWheel names={pool.map((p) => p.name)} colors={pool.map((p) => p.color)} target={target}
              startAt={cue.at + DRUNK_HOOK_TALK_MS} spinMs={DRUNK_HOOK_SPIN_MS} serverNow={serverNow}
              size={Math.min(320, Math.round(window.innerHeight * 0.42))} onLanded={() => setLanded(true)} />
          )}
          {landed && <p className="display drunk-versus">{names.h} <span className="muted">mot</span> {names.o}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`drunk drunk-${cue.kind}`} role="status" aria-label={label} style={sway}>
      <div className="drunk-body"><DrunkFace level={level} talking={talking} /><Mug /></div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="drunk-name">{DRUNK_NAME}{cue.kind !== "intro" && <span className="muted small"> · sup nr {cue.sips}</span>}</span>
        {bubble(line)}
      </div>
    </div>
  );
}
