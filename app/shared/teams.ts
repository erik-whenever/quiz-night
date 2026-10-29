// Lag (americano-stil) och valutan "mynt" med butik. Delas av klient och server.
//
// Lag: hosten slumpar nya lag varje kväll. Var och en samlar egna poäng under kvällen, men
// kvällens resultat för varje spelare är lagets SNITT (rättvist även när ett lag blir en trea).
// Säsongstabellen summerar sedan varje spelares kvällsresultat, och nästa kväll blir det nya lag.
//
// Mynt: tjänas under kvällen och betalas ut till plånboken (per spelarnamn, i Hub) när hosten kröner.
// Butiken är öppen i lobbyn. Engångsvaror (50/50, dubbelt, sabotage) ligger kvar i plånboken tills de används.

export interface Team { id: string; name: string; color: string; members: string[] }

/** 0 = alla mot alla, annars önskad lagstorlek (udda spelare hamnar i ett lag med en extra). */
export type TeamMode = 0 | 2 | 3;

export type TokenItem = "fifty" | "double" | "sabotage";
export type ShopItem = TokenItem | "extra" | "veto";

export interface Wallet { name: string; coins: number; items: Partial<Record<TokenItem, number>> }

export const SHOP: Record<ShopItem, { name: string; price: number; info: string; token: boolean }> = {
  extra: { name: "Extra tid", price: 6, token: false, info: "+5 s på varje fråga för ditt lag i kväll." },
  fifty: { name: "50/50", price: 3, token: true, info: "Under en fråga: hälften av felalternativen försvinner för dig." },
  double: { name: "Dubbla poäng", price: 4, token: true, info: "Aktivera mellan frågorna: ditt lag får dubbla poäng på nästa fråga." },
  sabotage: { name: "Sabotage", price: 4, token: true, info: "Aktivera mellan frågorna: ett annat lag får halverad tid på nästa fråga." },
  veto: { name: "Veto", price: 5, token: false, info: "I lobbyn: slumpa om lagen, och du hamnar inte med samma lagkamrat igen." },
};
export const SHOP_ITEMS = Object.keys(SHOP) as ShopItem[];
export const TOKEN_ITEMS: TokenItem[] = ["fifty", "double", "sabotage"];

/** Mynt man tjänar. Välkomstbonusen ges när en plånbok skapas, så alla kan handla direkt. */
export const COINS = { correct: 1, skillWin: 2, streak: 2, streakLen: 3, winner: 3, welcome: 10 };
export const EXTRA_TIME_MS = 5000;

export const TEAM_NAMES = [
  "Lag Saffran", "Lag Kongor", "Lag Dust II", "Lag Pollos Hermanos", "Lag MacLaren's", "Lag Lannister",
  "Lag Sous vide", "Lag Legion", "Lag Hellbourne", "Lag Kimchi", "Lag AWP", "Lag Suit Up",
];
export const TEAM_COLORS = ["#FFD23F", "#4CC9F0", "#FF5D73", "#3DDC97", "#B388FF", "#FF9F45", "#F15BB5", "#9EF01A"];

export const nameKey = (name: string) => name.trim().toLowerCase();

/** Lagets enhet för effekter: lag-id i lagläge, annars spelarens eget id. */
export function unitOf(teams: Team[], playerId: string): string {
  return teams.find((t) => t.members.includes(playerId))?.id ?? playerId;
}

/**
 * Dela upp spelare i lag om ungefär `size`, så jämnt som möjligt.
 * Lag om 2: udda antal ger en trea (5 → 3+2). Lag om 3: hellre tvåor än en fyra (4 → 2+2, 7 → 3+2+2).
 * Alltid minst två lag (3 spelare → 2+1; snittet gör det rättvist).
 */
export function splitTeams(ids: string[], size: number): string[][] {
  if (ids.length === 0) return [];
  // Minst två lag när det finns minst två spelare (3 spelare i lag om 2 → 2+1).
  const n = Math.max(Math.min(2, ids.length), size >= 3 ? Math.ceil(ids.length / size) : Math.floor(ids.length / size));
  const out: string[][] = Array.from({ length: n }, () => []);
  ids.forEach((id, i) => out[i % n].push(id));
  return out;
}

/** Snitt med en decimal. */
export const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

/** Lagens ställning: snittet av medlemmarnas egna poäng, bäst först. */
export function teamStandings<P extends { id: string; score: number }>(teams: Team[], players: P[]) {
  return teams
    .map((t) => ({ team: t, members: players.filter((p) => t.members.includes(p.id)) }))
    .filter((x) => x.members.length > 0)
    .map((x) => ({ ...x, score: avg(x.members.map((m) => m.score)) }))
    .sort((a, b) => b.score - a.score);
}

/** Kvällens resultat per spelare: lagets snitt i lagläge, annars egna poäng. */
export function nightScore<P extends { id: string; score: number }>(teams: Team[], players: P[], p: P): number {
  const t = teams.find((x) => x.members.includes(p.id));
  if (!t) return p.score;
  return avg(players.filter((x) => t.members.includes(x.id)).map((x) => x.score));
}

/** Effekter som gäller en viss fråga (eller nästa, mellan frågorna). Nycklarna är enheter (lag eller spelare). */
export interface Effects { forQ: number; extra: string[]; double: string[]; sabotage: string[] }

export interface CoinNote { playerId: string; n: number; why: string; at: number }
