// Hemlig svarsinsamling: alla spelare lämnar ett svar var, servern äger tiden.
// Används av "Alla svarar" och är tänkt att återanvändas av kommande rundtyper
// ("Vem sa det?", Kungasatsningen, Bluffrundan): de lägger till eget innehåll i svaret
// och en egen poängfunktion, men insamling, sekretess och nedräkning är desamma.
import type {
  CollectAnswer, CollectHost, CollectPublic, CollectResult, QuestionMode, Settings,
} from "../shared/types";
import { COLLECT_GRACE_MS, COLLECT_MAX_LEN } from "../shared/types";

/** Serverns fulla tillstånd för en insamling (sparas i Durable Object-lagringen). */
export interface CollectServer {
  mode: Exclude<QuestionMode, "buzz">;
  startedAt: number;
  deadline: number;
  answers: CollectAnswer[]; // i inlämningsordning
  correct: string[]; // playerIds som hosten markerat som rätt
  results?: CollectResult[]; // sätts vid rättning
}

export function startCollect(mode: CollectServer["mode"], seconds: number, now = Date.now()): CollectServer {
  return { mode, startedAt: now, deadline: now + seconds * 1000, answers: [], correct: [] };
}

/** Lämna ett svar. Returnerar felmeddelande, eller null om svaret togs emot. Ett svar per spelare (låst). */
export function submitAnswer(c: CollectServer, playerId: string, raw: unknown, now = Date.now()): string | null {
  if (now > c.deadline + COLLECT_GRACE_MS) return "Tiden är ute";
  if (c.answers.some((a) => a.playerId === playerId)) return "Du har redan låst ditt svar";
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, COLLECT_MAX_LEN) : "";
  if (!text) return "Skriv ett svar först";
  c.answers.push({ playerId, text, at: now, ms: now - c.startedAt });
  return null;
}

export function markAnswer(c: CollectServer, playerId: string, correct: boolean) {
  if (c.results || !c.answers.some((a) => a.playerId === playerId)) return;
  c.correct = c.correct.filter((x) => x !== playerId);
  if (correct) c.correct.push(playerId);
}

/**
 * Poäng för "Alla svarar": frågans poäng till alla rätt, bonus till den som lämnade rätt svar först
 * (servertid vid inlämning). Fel svar och utebliven inlämning kostar ingenting.
 */
export function scoreAll(c: CollectServer, points: number, settings: Settings): CollectResult[] {
  const firstRight = c.answers.find((a) => c.correct.includes(a.playerId))?.playerId;
  return c.answers.map((a) => {
    const correct = c.correct.includes(a.playerId);
    const fastest = a.playerId === firstRight;
    return { ...a, correct, fastest, delta: correct ? points + (fastest ? settings.fastestBonus : 0) : 0 };
  });
}

/** Det spelare och TV får se. Svarstexter skickas aldrig före rättningen. */
export function collectPublic(c: CollectServer, revealed: boolean): CollectPublic {
  return {
    mode: c.mode, startedAt: c.startedAt, deadline: c.deadline,
    answered: c.answers.map((a) => a.playerId),
    results: revealed ? c.results : undefined,
  };
}

export function collectHost(c: CollectServer): CollectHost {
  return { answers: c.answers, correct: c.correct };
}
