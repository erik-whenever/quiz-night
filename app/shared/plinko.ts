// Plinko-runda (gänget ville ha det, Erik valde 2026-11-01: en runda med mynt).
//
// Ett par gånger per kväll, när alla väntar på nästa fråga: PLINKO! Alla väljer insats (mynt) och risk och
// släpper sin kula när de vill under en kort stund. Servern slumpar kulans väg (8 rader, vänster/höger vid
// varje pinne) och räknar ut facket direkt; klienterna animerar samma väg, så TV:n och alla mobiler ser
// samma kulor studsa ner samtidigt. Facken ger 0×–10× insatsen.
//
// Insatsen dras från kvällens mynt (som betalas ut vid kröningen) och får ta av plånboken: man kan
// satsa upp till plånbok + kvällens mynt. Vinsten läggs på kvällens mynt.

export const PLINKO = {
  ROWS: 8,
  INTRO_MS: 3500,
  /** Hur länge man kan släppa sin kula. */
  DROP_MS: 16000,
  /** En kulas färd från släpp till fack. */
  BALL_MS: 3400,
  /** Sammanfattningen när alla kulor landat. */
  SUMMARY_MS: 6500,
  /** Insatser att välja på (0 = gratis kula, bara för skojs skull). "all" = allt man har. */
  BETS: [0, 1, 2, 5, 10] as const,
} as const;

export type PlinkoRisk = "low" | "mid" | "high";
export const RISKS: PlinkoRisk[] = ["low", "mid", "high"];
export const RISK_NAME: Record<PlinkoRisk, string> = { low: "Låg", mid: "Medel", high: "Hög" };

/**
 * Multiplikatorer per fack (9 fack för 8 rader), symmetriska. Väntevärdet är strax under 1 för alla
 * risknivåer (0,98–0,99), så det lönar sig inte i längden men det kan smälla rejält.
 * Sannolikhet per fack: C(8,k)/256 = 1, 8, 28, 56, 70, 56, 28, 8, 1 av 256.
 */
const half: Record<PlinkoRisk, number[]> = {
  low: [5.6, 2.1, 1.1, 1, 0.5],
  mid: [10, 3, 1.4, 0.7, 0.4],
  high: [10, 5, 2, 0.3, 0.1],
};
export const MULTS: Record<PlinkoRisk, number[]> = Object.fromEntries(
  RISKS.map((r) => [r, [...half[r], ...half[r].slice(0, 4).reverse()]]),
) as Record<PlinkoRisk, number[]>;

export interface PlinkoDrop {
  playerId: string;
  bet: number;
  risk: PlinkoRisk;
  /** 0 = vänster, 1 = höger, en per rad. */
  path: number[];
  /** Servertid när kulan släpptes. */
  at: number;
  bin: number;
  mult: number;
  /** Mynt tillbaka (insatsen × multiplikatorn, avrundat nedåt). */
  win: number;
}

export interface PlinkoPublic {
  n: number;
  startedAt: number;
  /** Släpp går fram till hit (servertid). */
  dropUntil: number;
  drops: PlinkoDrop[];
  /** När sammanfattningen börjar (sätts när fönstret stängt och sista kulan landat). */
  summaryAt?: number;
  endsAt?: number;
}

export type PlinkoStage = "intro" | "drop" | "landing" | "summary";

export function plinkoStage(p: PlinkoPublic, now: number): PlinkoStage {
  if (p.summaryAt && now >= p.summaryAt) return "summary";
  if (now < p.startedAt + PLINKO.INTRO_MS) return "intro";
  if (now < p.dropUntil) return "drop";
  return "landing";
}

/** Facket = antal högerstudsar. */
export const binOf = (path: number[]) => path.reduce((a, b) => a + b, 0);

export const multOf = (risk: PlinkoRisk, bin: number) => MULTS[risk][bin] ?? 0;
export const winOf = (bet: number, mult: number) => Math.floor(bet * mult + 1e-9);

/** Hur mycket man kan satsa: plånboken plus kvällens mynt (kan vara negativa efter en tidigare förlust). */
export const bankroll = (wallet: number, tonight: number) => Math.max(0, Math.floor(wallet + tonight));

/** Insats ur ett val (siffra eller "all"), begränsad till vad man har. */
export function betFor(choice: number | "all", bank: number): number {
  const want = choice === "all" ? bank : Math.max(0, Math.floor(choice));
  return Math.min(want, bank);
}

/** Före vilka frågor Plinko kommer (två gånger per kväll, aldrig samma som Hookertime eller precis efter). */
export function plinkoSlots(qCount: number, avoid: number[], rnd: (n: number) => number): number[] {
  if (qCount < 4) return [];
  const ok = (x: number) => x >= 1 && x <= qCount - 1 && !avoid.some((a) => Math.abs(a - x) <= 1);
  const pickIn = (lo: number, hi: number) => {
    const xs: number[] = [];
    for (let x = lo; x <= hi; x++) if (ok(x)) xs.push(x);
    return xs.length ? xs[rnd(xs.length)] : null;
  };
  const half = Math.floor(qCount / 2);
  const a = pickIn(2, half);
  const b = pickIn(half + 1, qCount - 1);
  return [a, b].filter((x): x is number => x !== null && (a === null || x === a || x - a >= 2));
}

// ===== Animation (samma för alla) =====
//
// Brädet i egna enheter: pinnarna har avstånd 1. Rad r (0..ROWS-1) ligger på y = r + 1 och har r + 3 pinnar
// centrerade kring x = 0. Kulan startar ovanför mitten, studsar på en pinne per rad och landar i fack k,
// vars mitt ligger på x = k - ROWS/2, y = ROWS + 1.

const ease = (k: number) => k * k;

/** Kulans position `ms` efter släpp. landed = har nått facket. */
export function ballAt(d: Pick<PlinkoDrop, "path" | "at">, ms: number): { x: number; y: number; row: number; landed: boolean } {
  const R = d.path.length;
  const T = PLINKO.BALL_MS;
  const fall = 0.12; // första fallet till översta pinnen, andel av tiden
  const k = Math.max(0, ms) / T;
  if (k >= 1) return { x: binOf(d.path) - R / 2, y: R + 1, row: R, landed: true };
  // Lite olika vinkel per kula så att de inte ser kloner ut (bestäms av vägen och tiden)
  const wob = (((d.at % 997) / 997) - 0.5) * 0.12;
  if (k < fall) { const f = k / fall; return { x: wob * (1 - f), y: ease(f) * 1 - 0.2 * (1 - f), row: -1, landed: false }; }
  const per = (1 - fall) / R;
  const step = Math.min(R - 1, Math.floor((k - fall) / per));
  const f = (k - fall - step * per) / per;
  let x0 = 0;
  for (let i = 0; i < step; i++) x0 += d.path[i] ? 0.5 : -0.5;
  const x1 = x0 + (d.path[step] ? 0.5 : -0.5);
  // En liten båge: upp en bit från pinnen och ner till nästa rad
  const y = step + 1 + f - Math.sin(f * Math.PI) * 0.42;
  return { x: x0 + (x1 - x0) * f, y, row: step, landed: false };
}

/** När en kula träffar pinnarna (ms efter släpp), för ljud. */
export function pegTimes(rows = PLINKO.ROWS): number[] {
  const fall = 0.12, per = (1 - fall) / rows;
  return Array.from({ length: rows }, (_, i) => (fall + i * per) * PLINKO.BALL_MS);
}
