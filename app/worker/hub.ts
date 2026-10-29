import type { HubPublic, LeagueEntry, QuestionSet } from "../shared/types";
import { COINS, SHOP, type ShopItem, type TokenItem, type Wallet, nameKey } from "../shared/teams";

type Wallets = Record<string, Wallet>;

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
        wallets: Object.values((await st.get<Wallets>("wallets")) ?? {}).sort((a, b) => b.coins - a.coins),
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
    // ===== Plånböcker (anropas av Room direkt, inte via den publika routern) =====
    const wallets = async () => (await st.get<Wallets>("wallets")) ?? {};
    const getOrCreate = (ws: Wallets, name: string) =>
      (ws[nameKey(name)] ??= { name: name.trim(), coins: COINS.welcome, items: {} });

    if (path === "/wallet/get" && req.method === "POST") {
      const { name } = await req.json<{ name: string }>();
      const ws = await wallets();
      const w = getOrCreate(ws, name);
      await st.put("wallets", ws);
      return Response.json(w);
    }
    if (path === "/wallet/buy" && req.method === "POST") {
      const { name, item } = await req.json<{ name: string; item: ShopItem }>();
      const ws = await wallets();
      const w = getOrCreate(ws, name);
      const it = SHOP[item];
      if (!it) return Response.json({ error: "Okänd vara" }, { status: 400 });
      if (w.coins < it.price) return Response.json({ error: `Du har ${w.coins} mynt, ${it.name} kostar ${it.price}` }, { status: 400 });
      w.coins -= it.price;
      if (it.token) w.items[item as TokenItem] = (w.items[item as TokenItem] ?? 0) + 1;
      await st.put("wallets", ws);
      return Response.json(w);
    }
    if (path === "/wallet/use" && req.method === "POST") {
      const { name, item } = await req.json<{ name: string; item: TokenItem }>();
      const ws = await wallets();
      const w = getOrCreate(ws, name);
      if (!w.items[item]) return Response.json({ error: `Du har inget ${SHOP[item]?.name ?? item}` }, { status: 400 });
      w.items[item]! -= 1;
      await st.put("wallets", ws);
      return Response.json(w);
    }
    /** Kvällens mynt, en gång per kväll (id = ligaraden). */
    if (path === "/payout" && req.method === "POST") {
      const { id, coins } = await req.json<{ id: string; coins: Record<string, number> }>();
      const paid = (await st.get<string[]>("paid")) ?? [];
      if (paid.includes(id)) return Response.json({ ok: true, already: true });
      const ws = await wallets();
      for (const [name, n] of Object.entries(coins)) getOrCreate(ws, name).coins += Math.max(0, Math.round(n));
      await st.put("wallets", ws);
      await st.put("paid", [...paid, id].slice(-200));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}
