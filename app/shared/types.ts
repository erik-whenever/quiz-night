// Delade typer mellan klient (src/) och server (worker/).

export interface Question {
  id: string;
  text: string;
  answer: string;
  points?: number; // standard 1
  category?: string;
  imageUrl?: string;
  /** Rundtyp. "buzz" (standard): först att buzza svarar. "all": alla svarar i hemlighet, se Collect*. */
  mode?: QuestionMode;
}

export type QuestionMode = "buzz" | "all";
export const QUESTION_MODES: { value: QuestionMode; label: string }[] = [
  { value: "buzz", label: "Buzz" },
  { value: "all", label: "Alla svarar" },
];
/** Rundtyper som samlar in hemliga svar från alla spelare (fas "collect"). */
export const isCollectMode = (m: QuestionMode | undefined): m is Exclude<QuestionMode, "buzz"> => m === "all";

export interface QuestionSet {
  id: string;
  title: string;
  theme?: string;
  source: "bank" | "repo"; // bank = skapad i appen, repo = incheckad av agenter i quizzes/
  updatedAt: string;
  questions: Question[];
}

export interface Settings {
  answerSeconds: number; // tid att svara efter buzz
  penalty: number; // poäng som dras vid fel/timeout
  collectSeconds: number; // tid att lämna svar i insamlingsrundor ("Alla svarar")
  fastestBonus: number; // extra poäng till snabbaste rätt svar i "Alla svarar"
}

/**
 * collect = alla lämnar hemliga svar (servern äger nedräkningen), judge = insamlingen stängd, hosten rättar.
 * Efter judge kommer reveal som vanligt.
 */
export type Phase = "lobby" | "question" | "buzzed" | "collect" | "judge" | "reveal" | "finished";

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
  score: number;
  connected: boolean;
}

export interface BuzzState {
  playerId: string;
  deadline: number; // epoch ms
  typedAnswer?: string;
}

/** Ett inlämnat svar i en insamlingsrunda. at = servertid vid inlämning, ms = tid sedan insamlingen öppnade. */
export interface CollectAnswer {
  playerId: string;
  text: string;
  at: number;
  ms: number;
}

/** Rättat svar, visas för alla först vid reveal. */
export interface CollectResult extends CollectAnswer {
  correct: boolean;
  delta: number;
  fastest: boolean;
}

/**
 * Publik del av en insamlingsrunda. Före reveal syns bara VILKA som svarat, aldrig vad.
 * results sätts först när phase är "reveal" (eller "finished").
 */
export interface CollectPublic {
  mode: Exclude<QuestionMode, "buzz">;
  startedAt: number;
  deadline: number;
  answered: string[];
  results?: CollectResult[];
}

/** Hostens del: alla svar i inlämningsordning och vilka som hittills är markerade som rätt. */
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
  question?: { text: string; points: number; category?: string; imageUrl?: string; mode: QuestionMode };
  revealedAnswer?: string;
  buzz: BuzzState | null;
  lockedOut: string[];
  lastEvent?: GameEvent;
  settings: Settings;
  serverNow: number;
  collect?: CollectPublic;
  /** Lyckohjulet: senaste snurret och twisten det gav (null = ingen). */
  wheel?: WheelState | null;
}

/** Hosten ser dessutom rätt svar. */
export interface HostState extends PublicState {
  answer?: string;
  collectHost?: CollectHost;
}

export type GameEvent =
  | { kind: "buzz"; playerId: string; at: number }
  | { kind: "correct"; playerId: string; delta: number; at: number; stolenFrom?: string; stolen?: number }
  | { kind: "wrong"; playerId: string; delta: number; at: number }
  | { kind: "timeout"; playerId: string; delta: number; at: number }
  | { kind: "reveal"; at: number }
  /** En insamlingsrunda är rättad: poäng utdelade, svaren visas. */
  | { kind: "judged"; correct: string[]; fastestId?: string; at: number }
  | { kind: "finished"; at: number };

// Klient -> server
export type ClientMsg =
  | { t: "join"; name: string; playerId?: string }
  /** at = klientens uppskattade servertid vid tryck (Date.now() + klockoffset). Servern klampar. */
  | { t: "buzz"; at?: number }
  | { t: "type"; text: string }
  /** Hemligt svar i en insamlingsrunda. Kan bara lämnas en gång (låses). */
  | { t: "answer"; text: string }
  | { t: "host:start" }
  | { t: "host:next" }
  | { t: "host:correct" }
  | { t: "host:wrong" }
  | { t: "host:reveal" }
  | { t: "host:adjust"; playerId: string; delta: number }
  | { t: "host:kick"; playerId: string }
  | { t: "host:settings"; settings: Partial<Settings> }
  | { t: "host:finish" }
  /** Markera ett inlämnat svar som rätt/fel (kan ändras tills host:judge). */
  | { t: "host:mark"; playerId: string; correct: boolean }
  /** Stäng insamlingen innan tiden gått ut. */
  | { t: "host:close" }
  /** Bekräfta rättningen: servern delar ut poäng och visar svaren. */
  | { t: "host:judge" }
  /** Snurra lyckohjulet (bara i lobbyn eller när svaret visas). Servern slumpar utfallet. */
  | { t: "host:spin" }
  | { t: "ping"; c: number }
  /** Svar på serverns sping, ekar s oförändrat så servern själv kan mäta RTT. */
  | { t: "spong"; s: number };

// Server -> klient
export type ServerMsg =
  | { t: "state"; state: PublicState | HostState }
  | { t: "joined"; playerId: string }
  | { t: "error"; message: string }
  | { t: "pong"; c: number; s: number }
  /** Servern mäter klientens RTT: klienten svarar direkt med { t: "spong", s }. */
  | { t: "sping"; s: number };

export interface LeagueEntry {
  id: string;
  date: string;
  title: string;
  results: { name: string; score: number }[];
}

export interface HubPublic {
  nextQuiz?: { date: string; theme?: string };
  league: LeagueEntry[];
}

/** Rättvis buzz: hur länge servern samlar buzzar efter den första innan vinnaren väljs. */
export const BUZZ_WINDOW_MS = 150;
/** Tak för hur mycket tidigare än ankomsten en buzz någonsin får räknas. */
export const BUZZ_MAX_COMP_MS = 70;
/** Tillåten mätbrus utöver uppmätt RTT/2 när en buzz-tidsstämpel klampas. */
export const BUZZ_JITTER_MS = 25;
/** Rate-limit per anslutning (token bucket): buzzar per sekund och hur många som får komma i en klump. */
export const BUZZ_RATE_PER_S = 5;
export const BUZZ_BURST = 5;
/** Generellt tak för alla meddelanden per anslutning (spong undantas, servern styr takten själv). */
export const MSG_RATE_PER_S = 30;
export const MSG_BURST = 60;

export const DEFAULT_SETTINGS: Settings = { answerSeconds: 10, penalty: 1, collectSeconds: 30, fastestBonus: 1 };
/** Max längd på ett svar i en insamlingsrunda. */
export const COLLECT_MAX_LEN = 80;
/** Nätfördröjning som tillåts efter deadline innan ett svar avvisas. */
export const COLLECT_GRACE_MS = 500;

// ===== Lyckohjulet =====

/** Twistar som hjulet kan ge nästa fråga. */
export type TwistId = "double" | "safe" | "steal" | "blitz" | "none";

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
  safe: { label: "Ingen straffavgift", short: "Inget straff", info: "Fel svar eller för långsam kostar inget." },
  steal: { label: "Stjäl", short: "Stjäl", info: "Den som svarar rätt tar poängen från ledaren." },
  blitz: { label: "Blixt", short: "Blixt", info: "Halverad svarstid efter buzz." },
  none: { label: "Nit", short: "Nit", info: "Ingen twist den här gången." },
};

/** Hjulets fält medsols från toppen. Varje twist två gånger, så alla utfall är lika troliga. */
export const WHEEL_SEGMENTS: TwistId[] = ["double", "safe", "steal", "blitz", "none", "double", "safe", "steal", "blitz", "none"];
export const WHEEL_SPIN_MS = 4500;

/** Twisten som gäller för den fråga som pågår just nu, annars null. */
export function activeTwist(st: { phase: Phase; qIndex: number; wheel?: WheelState | null }): TwistId | null {
  const w = st.wheel;
  if (!w || w.forQ !== st.qIndex || w.result === "none") return null;
  return ["question", "buzzed", "collect", "judge", "reveal"].includes(st.phase) ? w.result : null;
}

/** Svarstid i sekunder efter buzz, med hänsyn till Blixt. */
export function answerSecondsFor(st: { phase: Phase; qIndex: number; wheel?: WheelState | null; settings: Settings }): number {
  const s = st.settings.answerSeconds;
  return activeTwist(st) === "blitz" ? Math.max(2, Math.ceil(s / 2)) : s;
}
