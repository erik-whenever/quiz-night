// Delade typer mellan klient (src/) och server (worker/).

export interface Question {
  id: string;
  text: string;
  answer: string;
  points?: number; // standard 1
  category?: string;
  imageUrl?: string;
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
  answerSeconds: number; // tid att svara efter buzz
  penalty: number; // poäng som dras vid fel/timeout
}

export type Phase = "lobby" | "question" | "buzzed" | "reveal" | "finished";

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

/** Det alla ser (TV + spelare). Svaret skickas bara när phase === "reveal". */
export interface PublicState {
  code: string;
  title: string;
  phase: Phase;
  players: PlayerPublic[];
  qIndex: number;
  qCount: number;
  question?: { text: string; points: number; category?: string; imageUrl?: string };
  revealedAnswer?: string;
  buzz: BuzzState | null;
  lockedOut: string[];
  lastEvent?: GameEvent;
  settings: Settings;
  serverNow: number;
}

/** Hosten ser dessutom rätt svar. */
export interface HostState extends PublicState {
  answer?: string;
}

export type GameEvent =
  | { kind: "buzz"; playerId: string; at: number }
  | { kind: "correct"; playerId: string; delta: number; at: number }
  | { kind: "wrong"; playerId: string; delta: number; at: number }
  | { kind: "timeout"; playerId: string; delta: number; at: number }
  | { kind: "reveal"; at: number }
  | { kind: "finished"; at: number };

// Klient -> server
export type ClientMsg =
  | { t: "join"; name: string; playerId?: string }
  /** at = klientens uppskattade servertid vid tryck (Date.now() + klockoffset). Servern klampar. */
  | { t: "buzz"; at?: number }
  | { t: "type"; text: string }
  | { t: "host:start" }
  | { t: "host:next" }
  | { t: "host:correct" }
  | { t: "host:wrong" }
  | { t: "host:reveal" }
  | { t: "host:adjust"; playerId: string; delta: number }
  | { t: "host:kick"; playerId: string }
  | { t: "host:settings"; settings: Partial<Settings> }
  | { t: "host:finish" }
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

export const DEFAULT_SETTINGS: Settings = { answerSeconds: 10, penalty: 1 };
