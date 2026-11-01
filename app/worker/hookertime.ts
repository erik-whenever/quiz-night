// Hookertime på servern: när det ska hända och vem som möts. Själva matchen: shared/hooksim.ts.
import { secureIndex } from "./wheel";

const pick = <T,>(xs: T[]): T => xs[secureIndex(xs.length)];

/**
 * Före vilka frågor (omgångsindex) Hookertime slår till: två gånger per kväll, en i första halvan och en i
 * andra, aldrig före första frågan och aldrig efter sista. Färre än 4 frågor: en gång (eller ingen).
 */
export function hookSlots(qCount: number): number[] {
  if (qCount < 3) return [];
  if (qCount < 4) return [1 + secureIndex(qCount - 1)];
  const half = Math.floor(qCount / 2);
  const range = (lo: number, hi: number) => lo + secureIndex(Math.max(1, hi - lo + 1));
  const a = range(Math.max(1, Math.floor(qCount * 0.25)), Math.max(1, half - 1));
  const b = range(Math.max(a + 2, Math.ceil(qCount * 0.6)), qCount - 1);
  return b > a && b <= qCount - 1 ? [a, b] : [a];
}

/**
 * Vem som möts (Eriks regler 2026-11-01). `players` = anslutna spelare, `prev` = tidigare dueller i kväll
 * som [hooker, motståndare]. Hookern slumpas; motståndaren väljs av hjulet bland `pool`.
 *  - Första gången: slumpad hooker, hjulet bland alla andra.
 *  - Andra gången, 2 spelare: samma två igen.
 *  - 3 spelare: den som inte var med blir hooker, hjulet bland de två som möttes.
 *  - 4 spelare: de två som inte var med möts.
 *  - Fler än 4: de två som redan möttes kan inte väljas alls, i övrigt som första gången.
 * Tredje gången och senare (värden kör extra): de som redan varit med flest gånger väljs sist.
 */
export function pickFighters(players: string[], prev: [string, string][]): { hooker: string; opponent: string; pool: string[] } | null {
  if (players.length < 2) return null;
  const without = (xs: string[], x: string) => xs.filter((p) => p !== x);
  let hookers: string[];
  let poolOf: (h: string) => string[];
  const last = prev[prev.length - 1];
  if (!last) {
    hookers = players; poolOf = (h) => without(players, h);
  } else if (prev.length === 1) {
    const fresh = players.filter((p) => !last.includes(p));
    const met = players.filter((p) => last.includes(p));
    if (players.length === 2 || fresh.length === 0) {
      hookers = players; poolOf = (h) => without(players, h);
    } else if (players.length === 3 || fresh.length === 1) {
      // Den som inte var med är hooker, hjulet bland de två som möttes
      hookers = fresh; poolOf = () => met.length ? met : without(players, fresh[0]);
    } else {
      // 4 spelare: de två som inte var med möts. Fler: de två som möttes kan inte väljas.
      hookers = fresh; poolOf = (h) => without(fresh, h);
    }
  } else {
    // Extra (värden körde fler): de som varit med minst gånger först
    const times = (p: string) => prev.flat().filter((x) => x === p).length;
    const order = [...players].sort((a, b) => times(a) - times(b));
    const min = times(order[0]);
    const least = order.filter((p) => times(p) === min);
    if (least.length >= 2) { hookers = least; poolOf = (h) => without(least, h); }
    else { hookers = least; const nxt = times(order[1]); poolOf = (h) => without(order, h).filter((p) => times(p) === nxt); }
  }
  const hooker = pick(hookers);
  const pool = poolOf(hooker);
  if (!pool.length) return null;
  return { hooker, opponent: pick(pool), pool };
}
