// Kenta, fyllot: serverns del. Här slumpas buddy, när han dyker upp och vem som möts i hooker-off.
// Repliker, röst och animation finns i src/drunk.tsx.
import type { CollectResult, DrunkCue, DrunkKind, PlayerPublic } from "../shared/types";
import { secureIndex } from "./wheel";

export interface DrunkServer {
  buddyId: string;
  sips: number;
  cue: DrunkCue | null;
  /** Frågeindex när han senast sa något efter en fråga, och senaste hooker-off. */
  lastQ: number;
  lastHookQ: number;
  hookoffs: number;
  /** Introt pågår: första frågan startar då. */
  startAt?: number;
}

/** Minst så här många frågor mellan två vinst/förlust-repliker, och chansen att han säger något när han får. */
const GAP = 2;
const CHANCE = 0.55;
/** Hooker-off av sig själv: tidigast efter fråga 4, minst 5 frågor emellan, högst 2 per kväll. */
const HOOK_FROM_Q = 3;
const HOOK_GAP = 5;
const HOOK_MAX = 2;
const HOOK_CHANCE = 0.3;

const rand = () => secureIndex(1_000_000) / 1_000_000;

function pickBuddy(players: PlayerPublic[]): string | null {
  const live = players.filter((p) => p.connected);
  const pool = live.length ? live : players;
  return pool.length ? pool[secureIndex(pool.length)].id : null;
}

/** Introt när kvällen startar: ny buddy och första repliken. null om ingen spelare finns. */
export function drunkIntro(players: PlayerPublic[], now: number, prevId = 0): DrunkServer | null {
  const buddyId = pickBuddy(players);
  if (!buddyId) return null;
  return {
    buddyId, sips: 0, lastQ: -1, lastHookQ: -1, hookoffs: 0,
    cue: { id: prevId + 1, kind: "intro", at: now, buddyId, sips: 0 },
  };
}

function say(d: DrunkServer, kind: DrunkKind, now: number, extra: Partial<DrunkCue> = {}) {
  d.sips += 1; // varje replik firas eller sörjs med en sup
  d.cue = { id: (d.cue?.id ?? 0) + 1, kind, at: now, buddyId: d.buddyId, sips: d.sips, ...extra };
}

/** Hooker-off: slumpa hookern och motståndaren (hjulet visar spelarna utom hookern). */
export function drunkHookoff(d: DrunkServer, players: PlayerPublic[], qIndex: number, now: number): boolean {
  const live = players.filter((p) => p.connected);
  const pool = live.length >= 2 ? live : players;
  if (pool.length < 2) return false;
  const hooker = pool[secureIndex(pool.length)].id;
  const rest = pool.filter((p) => p.id !== hooker).map((p) => p.id);
  const opponent = rest[secureIndex(rest.length)];
  say(d, "hookoff", now, { hooker, opponent, pool: rest });
  d.lastHookQ = qIndex;
  d.hookoffs += 1;
  return true;
}

/**
 * Efter en rättad fråga: hur gick det för buddyn? Ibland firar eller sörjer Kenta (med en sup), och ibland
 * ropar han in en hooker-off i stället. `mine` är buddyns resultat (eller lagets svar när laget hade turen),
 * `played` om buddyn alls var med på frågan. Returnerar true om han sa något.
 */
export function drunkAfterJudge(
  d: DrunkServer, o: { players: PlayerPublic[]; qIndex: number; hasNext: boolean; wheelPending: boolean; mine?: CollectResult; played: boolean; skill: boolean },
  now: number,
): boolean {
  if (!o.players.some((p) => p.id === d.buddyId)) {
    // Buddyn har gått (eller sparkats): Kenta hittar en ny utan att göra någon stor grej av det.
    const b = pickBuddy(o.players);
    if (!b) return false;
    d.buddyId = b;
  }
  const canHook = o.hasNext && !o.wheelPending && o.players.length >= 2 && d.hookoffs < HOOK_MAX
    && o.qIndex >= HOOK_FROM_Q && o.qIndex - d.lastHookQ >= HOOK_GAP && o.qIndex - d.lastQ >= 1;
  if (canHook && rand() < HOOK_CHANCE) { d.lastQ = o.qIndex; return drunkHookoff(d, o.players, o.qIndex, now); }

  if (!o.played || o.qIndex - d.lastQ < GAP || rand() >= CHANCE) return false;
  const r = o.mine;
  const won = !!r && (o.skill ? r.place === 1 : r.correct);
  const lost = !r || (o.skill ? !r.correct : !r.correct);
  if (!won && !lost) return false; // t.ex. tvåa i en utmaning: inget att säga
  say(d, won ? "win" : "lose", now);
  d.lastQ = o.qIndex;
  return true;
}
