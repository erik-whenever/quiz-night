// Lyckohjulet: servern slumpar utfallet, klienterna animerar bara fram till det.
import type { PlayerPublic, WheelState } from "../shared/types";
import { WHEEL_SEGMENTS, WHEEL_SPIN_MS } from "../shared/types";

/** Likformigt slumptal i [0, n) med crypto (förkastar värden som skulle ge modulo-skevhet). */
export function secureIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Nytt snurr för frågan med index forQ. */
export function spinWheel(prev: WheelState | null | undefined, forQ: number, now = Date.now()): WheelState {
  const segment = secureIndex(WHEEL_SEGMENTS.length);
  return { spinId: (prev?.spinId ?? 0) + 1, segment, result: WHEEL_SEGMENTS[segment], startedAt: now, spinMs: WHEEL_SPIN_MS, forQ };
}

/**
 * Stjäl: den som svarar rätt tar poängen från ledaren bland de andra, men bara om ledaren
 * ligger lika eller före och bara så mycket ledaren har (ingen hamnar på minus av en stöld).
 */
export function stealTarget(players: PlayerPublic[], winnerId: string, points: number): { from: PlayerPublic; amount: number } | null {
  const winner = players.find((p) => p.id === winnerId);
  if (!winner) return null;
  let leader: PlayerPublic | null = null;
  for (const p of players) if (p.id !== winnerId && (!leader || p.score > leader.score)) leader = p;
  if (!leader || leader.score < winner.score) return null;
  const amount = Math.min(points, Math.max(0, leader.score));
  return amount > 0 ? { from: leader, amount } : null;
}
