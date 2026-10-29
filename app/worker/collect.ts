// Hemlig svarsinsamling: alla spelare lämnar ett svar var, servern äger tiden.
// Används av "Alla svarar" och är tänkt att återanvändas av kommande rundtyper
// ("Vem sa det?", Kungasatsningen, Bluffrundan): de lägger till eget innehåll i svaret
// och en egen poängfunktion, men insamling, sekretess och nedräkning är desamma.
import type {
  CollectAnswer, CollectHost, CollectPublic, CollectResult, QuestionMode, Settings,
} from "../shared/types";
import { COLLECT_GRACE_MS, COLLECT_MAX_LEN } from "../shared/types";
import type { SkillSpec } from "../shared/skill";
import { orderErrors, orderRight, rankSkill, skillText, validateSkill } from "../shared/skill";

/** Serverns fulla tillstånd för en insamling (sparas i Durable Object-lagringen). */
export interface CollectServer {
  mode: Exclude<QuestionMode, "buzz">;
  startedAt: number;
  deadline: number;
  answers: CollectAnswer[]; // i inlämningsordning
  correct: string[]; // playerIds som hosten markerat som rätt
  results?: CollectResult[]; // sätts vid rättning
  seed?: number; // skill-rundor
  /** Butikseffekter: ms till eller från deadline per spelare (Extra tid +, Sabotage −). */
  extra?: Record<string, number>;
}

/** Spelarens egen deadline med butikseffekter. */
export const deadlineFor = (c: CollectServer, playerId: string) => c.deadline + (c.extra?.[playerId] ?? 0);
/** När insamlingen senast ska stängas (den som har mest extra tid). */
export const collectEnd = (c: CollectServer) => c.deadline + Math.max(0, ...Object.values(c.extra ?? {}));

export function startCollect(mode: CollectServer["mode"], seconds: number, now = Date.now(), seed?: number): CollectServer {
  return { mode, startedAt: now, deadline: now + seconds * 1000, answers: [], correct: [], ...(seed !== undefined ? { seed } : {}) };
}

/** Lämna ett skill-resultat. Ordna rätt räknas av servern; övriga typer valideras. */
export function submitSkill(c: CollectServer, spec: SkillSpec, playerId: string,
  msg: { value?: unknown; ok?: unknown; order?: unknown }, now = Date.now()): string | null {
  if (now > deadlineFor(c, playerId) + COLLECT_GRACE_MS) return "Tiden är ute";
  if (c.answers.some((a) => a.playerId === playerId)) return "Du har redan lämnat ditt resultat";
  let value: number, ok: boolean;
  if (spec.kind === "order") {
    const order = Array.isArray(msg.order) ? msg.order.map(String) : [];
    const bad = orderErrors(spec.items!, order);
    if (bad === null) return "Ordna alla saker först";
    value = bad; ok = true;
    const text = `${skillText("order", { value, ok }, order.length)} · ${orderRight(spec.items!, order)} på rätt plats`;
    c.answers.push({ playerId, text, at: now, ms: now - c.startedAt, value, ok });
    return null;
  }
  const err = validateSkill(spec.kind, msg.value, msg.ok);
  if (err) return err;
  value = msg.value as number; ok = msg.ok as boolean;
  if (spec.kind === "lasthit" && value >= 300000) ok = false; // inga träffar
  c.answers.push({ playerId, text: skillText(spec.kind, { value, ok }), at: now, ms: now - c.startedAt, value, ok });
  return null;
}

/** Poäng för skill-rundor: 3/2/1 efter placering (· mult), sorterat efter placering. */
export function scoreSkill(c: CollectServer, spec: SkillSpec, mult: number): CollectResult[] {
  const ranked = rankSkill(spec.kind, c.answers.map((a) => ({ ...a, value: a.value ?? 0, ok: !!a.ok })), mult);
  return ranked.map(({ item, place, points }) => ({ ...item, correct: points > 0, fastest: place === 1, delta: points, place }));
}

/** Lämna ett svar. Returnerar felmeddelande, eller null om svaret togs emot. Ett svar per spelare (låst). */
export function submitAnswer(c: CollectServer, playerId: string, raw: unknown, now = Date.now()): string | null {
  if (now > deadlineFor(c, playerId) + COLLECT_GRACE_MS) return "Tiden är ute";
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
    ...(c.seed !== undefined ? { seed: c.seed } : {}),
    ...(c.extra && Object.keys(c.extra).length ? { extra: c.extra } : {}),
  };
}

export function collectHost(c: CollectServer): CollectHost {
  return { answers: c.answers, correct: c.correct };
}
