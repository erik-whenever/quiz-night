import type { HubPublic, LeagueEntry, QuestionSet } from "../shared/types";

/**
 * En global instans ("global"): frågebanken som skapas i appen, säsongstabellen och nästa quizdatum.
 * Frågeset som agenterna checkar in ligger i stället i repot under quizzes/ och byggs in i appen.
 */
export class Hub implements DurableObject {
  constructor(private ctx: DurableObjectState, private env: unknown) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/hub/, "");
    const st = this.ctx.storage;

    if (path === "/public" && req.method === "GET") {
      const out: HubPublic = {
        nextQuiz: await st.get("nextQuiz"),
        league: (await st.get<LeagueEntry[]>("league")) ?? [],
      };
      return Response.json(out);
    }
    if (path === "/next" && req.method === "PUT") {
      const body = await req.json<{ date: string; theme?: string } | null>();
      if (body?.date) await st.put("nextQuiz", body); else await st.delete("nextQuiz");
      return Response.json({ ok: true });
    }
    if (path === "/sets" && req.method === "GET") {
      const sets = (await st.get<QuestionSet[]>("sets")) ?? [];
      return Response.json(sets);
    }
    if (path === "/sets" && req.method === "PUT") {
      const set = await req.json<QuestionSet>();
      const sets = (await st.get<QuestionSet[]>("sets")) ?? [];
      const next = { ...set, source: "bank" as const, updatedAt: new Date().toISOString() };
      const i = sets.findIndex((x) => x.id === set.id);
      if (i >= 0) sets[i] = next; else sets.unshift(next);
      await st.put("sets", sets);
      return Response.json(next);
    }
    if (path.startsWith("/sets/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice(6));
      const sets = ((await st.get<QuestionSet[]>("sets")) ?? []).filter((x) => x.id !== id);
      await st.put("sets", sets);
      return Response.json({ ok: true });
    }
    if (path === "/league" && req.method === "POST") {
      const e = await req.json<LeagueEntry>();
      const league = (await st.get<LeagueEntry[]>("league")) ?? [];
      if (!league.some((x) => x.id === e.id)) league.unshift(e);
      await st.put("league", league);
      return Response.json({ ok: true });
    }
    if (path.startsWith("/league/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice(8));
      await st.put("league", ((await st.get<LeagueEntry[]>("league")) ?? []).filter((x) => x.id !== id));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}
