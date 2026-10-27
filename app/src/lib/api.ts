import type { HubPublic, QuestionSet, Settings } from "../../shared/types";

const PIN_KEY = "kronan.pin";
export const getPin = () => { try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; } };
export const setPin = (p: string) => { try { localStorage.setItem(PIN_KEY, p); } catch { /* */ } };
export const clearPin = () => { try { localStorage.removeItem(PIN_KEY); } catch { /* */ } };

export const hostKeyFor = (code: string) => { try { return localStorage.getItem("kronan.host." + code) ?? ""; } catch { return ""; } };
const saveHostKey = (code: string, key: string) => { try { localStorage.setItem("kronan.host." + code, key); } catch { /* */ } };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-host-pin": getPin(), ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Fel ${res.status}`);
  return data as T;
}

export const checkPin = (pin: string) =>
  fetch("/api/auth", { method: "POST", headers: { "x-host-pin": pin } }).then((r) => r.ok);

/** Frågeset som agenterna (eller du) checkat in i repot under app/quizzes/*.json */
const repoModules = import.meta.glob<{ default: Omit<QuestionSet, "source" | "updatedAt"> & { updatedAt?: string } }>(
  "../../quizzes/*.json", { eager: true },
);
export const repoSets: QuestionSet[] = Object.values(repoModules)
  .map((m) => ({ updatedAt: "", ...m.default, source: "repo" as const }))
  .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

export const api = {
  hub: () => call<HubPublic>("/api/hub/public"),
  bankSets: () => call<QuestionSet[]>("/api/hub/sets"),
  saveSet: (s: QuestionSet) => call<QuestionSet>("/api/hub/sets", { method: "PUT", body: JSON.stringify(s) }),
  deleteSet: (id: string) => call("/api/hub/sets/" + encodeURIComponent(id), { method: "DELETE" }),
  setNext: (date: string, theme?: string) =>
    call("/api/hub/next", { method: "PUT", body: JSON.stringify(date ? { date, theme } : null) }),
  deleteLeague: (id: string) => call("/api/hub/league/" + encodeURIComponent(id), { method: "DELETE" }),
  async createRoom(set: QuestionSet, settings: Partial<Settings>, shuffle: boolean) {
    const qs = shuffle ? [...set.questions].sort(() => Math.random() - 0.5) : set.questions;
    const r = await call<{ code: string; hostKey: string }>("/api/rooms", {
      method: "POST", body: JSON.stringify({ title: set.title, questions: qs, settings }),
    });
    saveHostKey(r.code, r.hostKey);
    return r;
  },
  crown: (code: string) => call("/api/rooms/" + code + "/crown", { method: "POST" }),
};

export const uid = () => Math.random().toString(36).slice(2, 10);
