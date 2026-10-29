// Delade typer mellan klient (src/) och server (worker/).
//
// Sedan 2026-10-29 är varje fråga antingen svarsalternativ i mobilen ("choice", standard) eller en
// skill-utmaning ("skill"). Muntliga buzz-svar och fritextsvar är borttagna (Eriks beslut), så att
// allt rättas automatiskt och värden kan spela med utan att se facit.
import type { OrderItem, SkillSpec } from "./skill";
export type { SkillSpec, SkillKind, OrderItem } from "./skill";
import type { CoinNote, Effects, ShopItem, Team, TeamMode, TokenItem, Wallet } from "./teams";
export type { CoinNote, Effects, ShopItem, Team, TeamMode, TokenItem, Wallet } from "./teams";

export interface Question {
  id: string;
  text: string;
  /** Rätt svar. Måste stå exakt som ett av `choices` (inte för skill). */
  answer: string;
  points?: number; // standard 1
  category?: string;
  imageUrl?: string;
  /** "choice" (standard om utelämnad) eller "skill". */
  mode?: QuestionMode;
  /**
   * Alla alternativ inklusive rätt svar: rätt svar + felalternativ, 2–12 st. Värden väljer i rummet hur
   * många som visas per fråga (`Settings.choiceCount`); servern slumpar då rätt svar plus så många fel.
   * Ge gärna 7 felalternativ så att det går att köra upp till 8 alternativ.
   */
  choices?: string[];
  /** Skill-utmaning i mobilen för "skill", se shared/skill.ts. `answer` behövs inte. */
  skill?: SkillSpec;
}

export type QuestionMode = "choice" | "skill";
export const QUESTION_MODES: { value: QuestionMode; label: string }[] = [
  { value: "choice", label: "Svarsalternativ" },
  { value: "skill", label: "Skill-utmaning" },
];
export const MODE_LABEL: Record<QuestionMode, string> = { choice: "Svarsalternativ", skill: "Skill-utmaning" };
/** Bokstäver för de alternativ som visas (A–H). */
export const CHOICE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];
/** Flest alternativ som visas på en fråga, och flest som en fråga får ha totalt. */
export const MAX_SHOWN = CHOICE_LETTERS.length;
export const MAX_POOL = 12;
export const MIN_SHOWN = 2;

/** Giltiga alternativ (trimmade, unika, 2–12 st och innehåller svaret), annars null. */
export function validChoices(q: Pick<Question, "choices" | "answer">): string[] | null {
  if (!Array.isArray(q.choices)) return null;
  const c = [...new Set(q.choices.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (c.length < 2 || c.length > MAX_POOL || !c.includes(String(q.answer ?? "").trim())) return null;
  return c;
}

export interface QuestionSet {
  id: string;
  title: string;
  theme?: string;
  source: "bank" | "repo"; // bank = skapad i appen, repo = incheckad av agenter i quizzes/
  updatedAt: string;
  questions: Question[];
}

export interface Settings {
  /** Sekunder att svara på en alternativfråga. */
  collectSeconds: number;
  /** Extra poäng till snabbaste rätt svar. */
  fastestBonus: number;
  /** Hur många alternativ som visas per fråga (rätt + fel). Ändras i lobbyn eller under kvällen, gäller från nästa fråga. */
  choiceCount: number;
  /** Värden spelar själv: facit och andras svar skickas aldrig till hostkontrollen. Kan inte stängas av efter start. */
  hostPlays: boolean;
}

export const DEFAULT_SETTINGS: Settings = { collectSeconds: 20, fastestBonus: 1, choiceCount: 4, hostPlays: true };

/** collect = alla väljer (servern äger nedräkningen), judge = tiden ute, reveal = svaret visas. */
export type Phase = "lobby" | "collect" | "judge" | "reveal" | "finished";

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
  score: number;
  connected: boolean;
}

/** Ett inlämnat svar. at = servertid vid inlämning, ms = tid sedan frågan öppnade. */
export interface CollectAnswer {
  playerId: string;
  text: string;
  at: number;
  ms: number;
  /** Skill-rundor: rapporterat värde (se SkillResult) och om resultatet är godkänt. */
  value?: number;
  ok?: boolean;
}

/** Rättat svar, visas för alla först vid reveal. */
export interface CollectResult extends CollectAnswer {
  correct: boolean;
  delta: number;
  fastest: boolean;
  /** Skill-rundor: placering (1 = bäst, 0 = diskad). Resultaten är då sorterade efter placering. */
  place?: number;
}

/**
 * Publik del av en fråga. Före reveal syns bara VILKA som svarat, aldrig vad.
 * results sätts först när phase är "reveal".
 */
export interface CollectPublic {
  mode: QuestionMode;
  startedAt: number;
  deadline: number;
  answered: string[];
  results?: CollectResult[];
  /** Skill-rundor: slumpfrö så att alla får samma bana. */
  seed?: number;
  /** Butikseffekter: ms till (+) eller från (−) deadline per spelare. */
  extra?: Record<string, number>;
}

/** Hostens del (bara när värden inte spelar): alla svar i inlämningsordning och vilka som är rätt. */
export interface CollectHost {
  answers: CollectAnswer[];
  correct: string[];
}

/** Det alla ser (TV + spelare). Svaret skickas bara när phase === "reveal". */
export interface PublicState {
  code: string;
  title: string;
  phase: Phase;
  players: PlayerPublic[];
  qIndex: number;
  qCount: number;
  question?: { text: string; points: number; category?: string; imageUrl?: string; mode: QuestionMode;
    /** De alternativ som visas på den här frågan, i visningsordning. */
    choices?: string[];
    /** För "order" skickas sakerna blandade och utan värden fram till reveal. */
    skill?: Omit<SkillSpec, "items"> & { items?: (Pick<OrderItem, "label"> & Partial<OrderItem>)[] } };
  revealedAnswer?: string;
  lastEvent?: GameEvent;
  settings: Settings;
  serverNow: number;
  collect?: CollectPublic;
  /** Lyckohjulet: senaste snurret och twisten det gav (null = ingen). */
  wheel?: WheelState | null;
  /** Lag för kvällen (tomt = alla mot alla). */
  teamMode: TeamMode;
  teams: Team[];
  /** Spelarnas plånböcker (laddas från Hub när de går med) och mynt intjänade i kväll. */
  wallets: Record<string, Wallet>;
  coinsTonight: Record<string, number>;
  coinLog: CoinNote[];
  /** Butikseffekter för pågående fråga, eller nästa mellan frågorna. */
  effects: Effects;
  /** Bara till spelaren själv: alternativ som 50/50 har tagit bort för hen på pågående fråga. */
  myRemoved?: string[];
}

/** Hosten ser dessutom facit och svaren, men bara när värden inte spelar själv. */
export interface HostState extends PublicState {
  answer?: string;
  collectHost?: CollectHost;
}

export type GameEvent =
  /** En fråga är rättad: poäng utdelade, svaren visas. Stjäl-twisten fyller i stolenFrom/stolen. */
  | { kind: "judged"; correct: string[]; fastestId?: string; at: number; stolenFrom?: string; stolen?: number; stealer?: string }
  | { kind: "finished"; at: number };

// Klient -> server
export type ClientMsg =
  | { t: "join"; name: string; playerId?: string }
  /** Valt alternativ (eller fritext i gamla klienter). Kan bara lämnas en gång (låses). */
  | { t: "answer"; text: string }
  /** Resultat i en skill-runda (en gång per spelare). order = etiketterna i vald ordning för "Ordna rätt". */
  | { t: "skill"; value?: number; ok?: boolean; order?: string[] }
  | { t: "host:start" }
  | { t: "host:next" }
  | { t: "host:adjust"; playerId: string; delta: number }
  | { t: "host:kick"; playerId: string }
  | { t: "host:settings"; settings: Partial<Settings> }
  | { t: "host:finish" }
  /** Ändra rättningen av ett svar (bara när värden inte spelar). */
  | { t: "host:mark"; playerId: string; correct: boolean }
  /** Stäng frågan innan tiden gått ut. */
  | { t: "host:close" }
  /** Visa svaret: stänger frågan om den är öppen, delar ut poäng och visar facit. */
  | { t: "host:judge" }
  /** Snurra lyckohjulet (bara i lobbyn eller när svaret visas). Servern slumpar utfallet. */
  | { t: "host:spin" }
  /** Lagläge: 0 = alla mot alla, annars lagstorlek. Slumpar nya lag (bara i lobbyn). */
  | { t: "host:teams"; mode: TeamMode }
  /** Köp i butiken (lobbyn). */
  | { t: "buy"; item: ShopItem }
  /** Använd en vara. Dubbla poäng/Sabotage mellan frågorna (target = lag/spelare), 50/50 under en fråga. */
  | { t: "use"; item: TokenItem; target?: string }
  | { t: "ping"; c: number };

// Server -> klient
export type ServerMsg =
  | { t: "state"; state: PublicState | HostState }
  | { t: "joined"; playerId: string }
  | { t: "error"; message: string }
  | { t: "pong"; c: number; s: number };

export interface LeagueEntry {
  id: string;
  date: string;
  title: string;
  /** score = kvällens resultat (lagets snitt i lagläge). team = lagnamnet om det var lag. */
  results: { name: string; score: number; team?: string }[];
  /** Mynt som delades ut den kvällen. */
  coins?: Record<string, number>;
}

export interface HubPublic {
  nextQuiz?: { date: string; theme?: string };
  league: LeagueEntry[];
  /** Plånböcker (namn, mynt, varor) för tabellen. */
  wallets?: Wallet[];
}

/** Generellt tak för alla meddelanden per anslutning (token bucket). */
export const MSG_RATE_PER_S = 30;
export const MSG_BURST = 60;
/** Max längd på ett svar. */
export const COLLECT_MAX_LEN = 80;
/** Nätfördröjning som tillåts efter deadline innan ett svar avvisas. */
export const COLLECT_GRACE_MS = 500;

// ===== Lyckohjulet =====

/** Twistar som hjulet kan ge nästa fråga. */
export type TwistId = "double" | "fifty" | "steal" | "blitz" | "none";

export interface WheelState {
  /** Ökar för varje snurr, så klienterna vet när ett nytt snurr börjar. */
  spinId: number;
  /** Index i WHEEL_SEGMENTS som hjulet landar på (servern slumpar). */
  segment: number;
  result: TwistId;
  /** Servertid när snurret startade. */
  startedAt: number;
  spinMs: number;
  /** Frågeindex som twisten gäller för. */
  forQ: number;
}

export const TWISTS: Record<TwistId, { label: string; short: string; info: string }> = {
  double: { label: "Dubbla poäng", short: "Dubbelt", info: "Rätt svar ger dubbla poäng." },
  fifty: { label: "50/50 för alla", short: "50/50", info: "Hälften av felalternativen försvinner för alla." },
  steal: { label: "Stjäl", short: "Stjäl", info: "Snabbaste rätt svar tar poängen från ledaren." },
  blitz: { label: "Blixt", short: "Blixt", info: "Halverad svarstid." },
  none: { label: "Nit", short: "Nit", info: "Ingen twist den här gången." },
};

/** Hjulets fält medsols från toppen. Varje twist två gånger, så alla utfall är lika troliga. */
export const WHEEL_SEGMENTS: TwistId[] = ["double", "fifty", "steal", "blitz", "none", "double", "fifty", "steal", "blitz", "none"];
export const WHEEL_SPIN_MS = 4500;
/** Twistar som passar före en skill-utmaning (där finns inga alternativ och tiden är fast). */
export const SKILL_TWISTS: TwistId[] = ["double", "steal", "none"];

/** Twisten som gäller för den fråga som pågår just nu, annars null. */
export function activeTwist(st: { phase: Phase; qIndex: number; wheel?: WheelState | null }): TwistId | null {
  const w = st.wheel;
  if (!w || w.forQ !== st.qIndex || w.result === "none") return null;
  return ["collect", "judge", "reveal"].includes(st.phase) ? w.result : null;
}
