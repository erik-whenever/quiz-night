import type { LeagueEntry, Question } from "../../shared/types";
import register from "../../quizzes/spelat/register.json";

/**
 * Nyligen spelade frågor vilar i `karens` quizkvällar och hoppas över när rummet skapas.
 * Registret fylls med `python3 scripts/spelat.py ÅÅÅÅ-MM-DD set-id`. Frågor känns igen på texten,
 * så en kopia i ett annat set (eller i frågebanken) vilar också. Skill-utmaningar vilar aldrig.
 */
interface Kvall { datum: string; set: string; titel: string; fragor: string[] }
const reg = register as { karens: number; kvallar: Kvall[] };

export const KARENS = reg.karens;

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** Kvällens datum i Stockholm. En kröning strax efter midnatt räknas till kvällen innan. */
export function nightOf(iso: string): string {
  const t = new Date(new Date(iso).getTime() - 6 * 3600_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm" }).format(t);
}

export interface Resting { datum: string; titel: string; kvarKvallar: number }

/** Frågetext (normaliserad) → när den spelades och hur många kvällar till den vilar. */
export function restingQuestions(league: LeagueEntry[]): Map<string, Resting> {
  const nights = new Set<string>(reg.kvallar.map((k) => k.datum));
  for (const e of league) if (!/^demo/i.test(e.title)) nights.add(nightOf(e.date));
  const out = new Map<string, Resting>();
  for (const k of reg.kvallar) {
    const since = [...nights].filter((n) => n > k.datum).length;
    const kvar = KARENS - since;
    if (kvar <= 0) continue;
    for (const f of k.fragor) {
      const key = norm(f);
      const prev = out.get(key);
      if (!prev || prev.datum < k.datum) out.set(key, { datum: k.datum, titel: k.titel, kvarKvallar: kvar });
    }
  }
  return out;
}

export const restingOf = (q: Question, resting: Map<string, Resting>) =>
  q.mode === "skill" ? undefined : resting.get(norm(q.text));

export const shortDate = (d: string) =>
  new Date(d + "T12:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "short" }).replace(/\.$/, "");
