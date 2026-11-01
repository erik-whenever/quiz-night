// Skill-utmaningar i mobilen: delade definitioner för klient och server.
// Alla spelare får samma slumpfrö, så banan (creeps, mål, glas) blir identisk för alla.
// Telefonen mäter tiden lokalt, så pingen i Discord spelar ingen roll. Klienten rapporterar
// ett värde; servern validerar intervallet och rankar. (Fusk via devtools accepteras i ett kompisquiz.)

export type SkillKind = "lasthit" | "aim" | "stopwatch" | "order" | "pour";

export interface OrderItem {
  label: string;
  /** Värdet som ordningen bygger på (t.ex. årtal). Visas först vid reveal. */
  value: number;
  /** Valfri text för värdet vid reveal, t.ex. "sept 2005". */
  show?: string;
}

export interface SkillSpec {
  kind: SkillKind;
  /** Sekunder som insamlingen är öppen (standard per typ, se SKILLS). */
  seconds?: number;
  /** Stoppa klockan: målet i sekunder (standard 10). */
  target?: number;
  /** Ordna rätt: 3–6 saker och hur de ska ordnas ("Äldst först"). Lägst värde först. */
  items?: OrderItem[];
  prompt?: string;
}

export const SKILLS: Record<SkillKind, { name: string; info: string; seconds: number; lowerBetter: boolean; byAbs?: boolean }> = {
  lasthit: { name: "Last hit", info: "Skjut så att pilen träffar när creepen är under ditt gula streck. Bågen spänns och pilen flyger en halv sekund, så du måste skjuta i förväg. För tidigt: du skadar bara. För sent: denied. Tre creeps.", seconds: 50, lowerBetter: true },
  aim: { name: "Flick", info: "Tio mål, ett i taget. De blir mindre och börjar röra sig. Träffa dem snabbt men rör inte de röda lockbetena (+1 s). Miss +0,5 s, och ett mål som hinner försvinna kostar +1 s.", seconds: 40, lowerBetter: true },
  stopwatch: { name: "Stoppa klockan", info: "Klockan blir svart efter 3 sekunder. Stoppa den så nära målet du kan.", seconds: 35, lowerBetter: true, byAbs: true },
  order: { name: "Ordna rätt", info: "Tryck i rätt ordning. Ångra om du ångrar dig.", seconds: 45, lowerBetter: true },
  pour: { name: "Häll upp", info: "Håll inne för att hälla och släpp vid strecket. Skummet stiger lite efter. Spill inte!", seconds: 35, lowerBetter: true, byAbs: true },
};
export const SKILL_KINDS = Object.keys(SKILLS) as SkillKind[];
/** Poäng efter placering bland godkända resultat. Delad placering ger samma poäng. */
export const SKILL_POINTS = [3, 2, 1];
export const LASTHIT_CREEPS = 3;
/** Last hit: tid att spänna bågen, pilens flygtid och tid innan nästa pil (ms). */
export const BOW_DRAW_MS = 150;
export const ARROW_FLIGHT_MS = 500;
export const BOW_COOLDOWN_MS = 900;
export const AIM_TARGETS = 10;
/** Flick: straff för miss, för att träffa ett lockbete och för ett mål som hinner försvinna (ms). */
export const AIM_MISS_MS = 500;
export const AIM_DECOY_MS = 1000;
export const AIM_ESCAPE_MS = 1000;
/** Så länge ett mål står kvar innan det försvinner (ms). */
export const AIM_LIFE_MS = 2400;

/** Litet deterministiskt slumptal (mulberry32), samma frö ger samma bana hos alla. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), range: (lo: number, hi: number) => lo + next() * (hi - lo) };
}

// ===== Banor (genereras från fröet, likadant i alla telefoner) =====

export interface Creep {
  /** Din skada i HP-procent: under den kan du ta last hit. */
  dmg: number;
  /** HP efter varje träff från de andra creepsen, och ms innan träffen kommer. Sista träffen dödar creepen (denied). */
  hits: { at: number; hp: number }[];
}

export function lasthitCourse(seed: number): Creep[] {
  const r = rng(seed);
  return Array.from({ length: LASTHIT_CREEPS }, () => {
    const dmg = r.int(14, 22);
    const hits: { at: number; hp: number }[] = [];
    let hp = 100, at = 0;
    while (hp > dmg) {
      at += r.int(320, 850);
      hp = Math.max(1, hp - Math.min(r.int(6, 17), hp - 1));
      hits.push({ at, hp });
    }
    at += r.int(450, 800); // fönstret: från sista träffen över strecket till dödande träffen
    hits.push({ at, hp: 0 });
    return { dmg, hits };
  });
}

export interface AimTarget {
  /** Mittpunkt som andel av spelytan (0–1). */
  x: number;
  y: number;
  /** Radie som andel av spelytans kortaste sida. Krymper ju längre in i banan. */
  r: number;
  /** Rörelse: amplitud (andel av ytan) och period i ms. Saknas = står still. */
  move?: { ax: number; ay: number; ms: number; ph: number };
  /** Ett rött lockbete som syns samtidigt. Träff kostar AIM_DECOY_MS. */
  decoy?: { x: number; y: number };
}

/** Banan: samma för alla. Mål 1–3 står still och är stora, sedan krymper de, börjar röra sig och får lockbeten. */
export function aimCourse(seed: number): AimTarget[] {
  const r = rng(seed ^ 0xa11);
  const out: AimTarget[] = [];
  const far = (a: { x: number; y: number }, b: { x: number; y: number }, d: number) => Math.hypot(a.x - b.x, a.y - b.y) >= d;
  for (let i = 0; i < AIM_TARGETS; i++) {
    let p = { x: r.range(0.15, 0.85), y: r.range(0.18, 0.82) };
    for (let k = 0; k < 6 && out.length && !far(p, out[out.length - 1], 0.32); k++) p = { x: r.range(0.15, 0.85), y: r.range(0.18, 0.82) };
    const t: AimTarget = { ...p, r: 0.085 - (0.03 * i) / (AIM_TARGETS - 1) };
    if (i >= 3) t.move = { ax: r.range(0.06, 0.13), ay: i >= 6 ? r.range(0.03, 0.08) : 0, ms: r.range(1100, 1700), ph: r.range(0, Math.PI * 2) };
    if (i >= 2 && r.next() < 0.6) {
      let d = { x: r.range(0.15, 0.85), y: r.range(0.18, 0.82) };
      for (let k = 0; k < 8 && !far(d, p, 0.3); k++) d = { x: r.range(0.15, 0.85), y: r.range(0.18, 0.82) };
      t.decoy = d;
    }
    out.push(t);
  }
  return out;
}

/** Målets position ms efter att det dök upp (rörliga mål pendlar i sidled och lite i höjdled). */
export function aimPos(t: AimTarget, ms: number): { x: number; y: number } {
  if (!t.move) return { x: t.x, y: t.y };
  const a = (ms / t.move.ms) * Math.PI * 2 + t.move.ph;
  const x = t.x + Math.sin(a) * t.move.ax, y = t.y + Math.sin(a * 2) * t.move.ay;
  return { x: Math.max(0.08, Math.min(0.92, x)), y: Math.max(0.1, Math.min(0.9, y)) };
}

export interface PourCourse { target: number; rate: number; accel: number; foam: number }
/** Strecket (procent), hällhastighet (procent/s), acceleration (procent/s²) och skum efter släpp (procent). */
export function pourCourse(seed: number): PourCourse {
  const r = rng(seed ^ 0xbee2);
  return { target: r.int(62, 84), rate: r.range(14, 20), accel: r.range(6, 12), foam: r.range(2, 6) };
}

/** Saker att ordna, blandade i samma ordning för alla. */
export function orderShuffle(items: OrderItem[], seed: number): OrderItem[] {
  const r = rng(seed ^ 0x0de5);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export const correctOrder = (items: OrderItem[]) => [...items].sort((a, b) => a.value - b.value);

// ===== Resultat =====

/**
 * Ett rapporterat resultat. value tolkas per typ:
 * lasthit: (missade creeps)·100000 + antal pilar·100 (färre pilar vinner vid lika många last hits)
 * aim: total tid ms inkl. straff · stopwatch: stopptid − mål i ms (med tecken)
 * order: antal par i fel ordning (servern räknar själv) · pour: slutnivå − streck i tiondels procent (med tecken)
 * ok = false: diskad (spill, alla creeps missade, klockan aldrig stoppad).
 */
export interface SkillResult { value: number; ok: boolean }

/** Kontrollera att ett rapporterat värde är rimligt för typen. Returnerar felmeddelande eller null. */
export function validateSkill(kind: SkillKind, value: unknown, ok: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof ok !== "boolean") return "Ogiltigt resultat";
  const v = value;
  const within = (lo: number, hi: number) => v >= lo && v <= hi && Number.isInteger(v);
  const good =
    kind === "lasthit" ? within(0, LASTHIT_CREEPS * 100000 + 99999) :
    kind === "aim" ? within(AIM_TARGETS * 80, 120000) :
    kind === "stopwatch" ? within(-60000, 60000) :
    kind === "pour" ? within(-1000, 1000) : false;
  return good ? null : "Ogiltigt resultat";
}

/** Par i fel ordning (0 = perfekt) för en inlämnad ordning av etiketter. */
export function orderErrors(items: OrderItem[], order: string[]): number | null {
  const want = correctOrder(items).map((i) => i.label);
  if (order.length !== want.length || new Set(order).size !== order.length || !order.every((l) => want.includes(l))) return null;
  const pos = new Map(want.map((l, i) => [l, i]));
  let bad = 0;
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) if (pos.get(order[i])! > pos.get(order[j])!) bad++;
  return bad;
}
export const orderRight = (items: OrderItem[], order: string[]) =>
  correctOrder(items).filter((it, i) => order[i] === it.label).length;

const s2 = (ms: number) => (ms / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Resultatet i text, t.ex. "2/3 last hits · 0,41 s". */
export function skillText(kind: SkillKind, r: SkillResult, itemsCount = 0): string {
  const v = r.value;
  switch (kind) {
    case "lasthit": {
      const hits = LASTHIT_CREEPS - Math.floor(v / 100000);
      const arrows = Math.round((v % 100000) / 100);
      return `${hits === 0 ? "Inga last hits" : `${hits}/${LASTHIT_CREEPS} last hits`} · ${arrows} ${arrows === 1 ? "pil" : "pilar"}`;
    }
    case "aim": return `${s2(v)} s`;
    case "stopwatch": return r.ok ? `${v >= 0 ? "+" : "−"}${s2(Math.abs(v))} s` : "Stoppade aldrig";
    case "pour": return r.ok ? (v === 0 ? "Pricks på strecket" : `${(Math.abs(v) / 10).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} % ${v > 0 ? "över" : "under"}`) : "Spillde!";
    case "order": {
      const pairs = itemsCount * (itemsCount - 1) / 2;
      return v === 0 ? "Helt rätt" : `${pairs - v} av ${pairs} par rätt`;
    }
  }
}

/** Sorteringsnyckel: godkända först, sedan bäst värde, sedan snabbast inlämning. */
export function skillKey(kind: SkillKind, r: SkillResult): number {
  return SKILLS[kind].byAbs ? Math.abs(r.value) : r.value;
}

export interface Ranked<T> { item: T; place: number; points: number }

/** Ranka resultat och dela ut placeringspoäng (3/2/1 · mult). Delad placering vid samma värde. */
export function rankSkill<T extends { value: number; ok: boolean; ms: number }>(kind: SkillKind, rs: T[], mult = 1): Ranked<T>[] {
  const sorted = [...rs].sort((a, b) => Number(b.ok) - Number(a.ok) || skillKey(kind, a) - skillKey(kind, b) || a.ms - b.ms);
  let place = 0, prev: number | null = null;
  return sorted.map((item, i) => {
    const key = skillKey(kind, item);
    if (!item.ok) return { item, place: 0, points: 0 };
    if (prev === null || key !== prev) place = i + 1;
    prev = key;
    return { item, place, points: (SKILL_POINTS[place - 1] ?? 0) * mult };
  });
}

/** Normalisera en skill-spec från JSON, eller null om den är ogiltig. */
export function validSkill(raw: unknown): SkillSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as SkillSpec;
  if (!SKILL_KINDS.includes(s.kind)) return null;
  const out: SkillSpec = { kind: s.kind };
  if (typeof s.seconds === "number" && s.seconds >= 10 && s.seconds <= 180) out.seconds = Math.round(s.seconds);
  if (s.kind === "stopwatch") out.target = typeof s.target === "number" && s.target >= 3 && s.target <= 30 ? Math.round(s.target * 10) / 10 : 10;
  if (s.kind === "order") {
    if (!Array.isArray(s.items)) return null;
    const items = s.items
      .map((i) => ({ label: String(i?.label ?? "").trim(), value: Number(i?.value), ...(i?.show ? { show: String(i.show) } : {}) }))
      .filter((i) => i.label && Number.isFinite(i.value));
    if (items.length < 3 || items.length > 6 || new Set(items.map((i) => i.label)).size !== items.length) return null;
    if (new Set(items.map((i) => i.value)).size !== items.length) return null;
    out.items = items;
    out.prompt = typeof s.prompt === "string" && s.prompt.trim() ? s.prompt.trim().slice(0, 60) : "Lägst först";
  }
  return out;
}
