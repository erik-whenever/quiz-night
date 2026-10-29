import { Room } from "./room";
import { Hub } from "./hub";
import type { LeagueEntry, PlayerPublic, Question, Settings, Team } from "../shared/types";
import { COINS, nightScore } from "../shared/teams";

export { Room, Hub };

interface Env {
  ROOM: DurableObjectNamespace;
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  HOST_PIN: string;
}

// Inga förväxlingsbara tecken (0/O, 1/I)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = (n = 4) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");

const json = (data: unknown, status = 200) => Response.json(data, { status });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);

    const isHost = !!env.HOST_PIN && req.headers.get("x-host-pin") === env.HOST_PIN;
    const hub = env.HUB.get(env.HUB.idFromName("global"));

    if (p === "/api/auth" && req.method === "POST") {
      return isHost ? json({ ok: true }) : json({ ok: false, error: "Fel PIN" }, 401);
    }

    // Publik läsning av säsong + nästa quiz (används även av agenterna)
    if (p === "/api/hub/public") return hub.fetch(new Request("https://hub/hub/public"));

    if (p.startsWith("/api/hub/")) {
      if (!isHost) return json({ error: "Kräver host-PIN" }, 401);
      return hub.fetch(new Request("https://hub" + p.replace("/api", ""), req));
    }

    if (p === "/api/rooms" && req.method === "POST") {
      if (!isHost) return json({ error: "Kräver host-PIN" }, 401);
      const body = await req.json<{ title: string; questions: Question[]; settings?: Partial<Settings> }>();
      if (!body.questions?.length) return json({ error: "Frågesetet är tomt" }, 400);
      const code = randomCode();
      const hostKey = crypto.randomUUID();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      await stub.fetch(new Request("https://room/init", {
        method: "POST", body: JSON.stringify({ code, hostKey, title: body.title, questions: body.questions, settings: body.settings }),
      }));
      return json({ code, hostKey });
    }

    const m = p.match(/^\/api\/rooms\/([A-Z0-9]{4})\/(ws|crown)$/);
    if (m) {
      const [, code, action] = m;
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      if (action === "ws") return stub.fetch(req);
      if (action === "crown" && req.method === "POST") {
        if (!isHost) return json({ error: "Kräver host-PIN" }, 401);
        const r = await stub.fetch(new Request("https://room/results"));
        if (!r.ok) return json({ error: "Rummet finns inte" }, 404);
        const { title, players, teams, coins } = await r.json<{ title: string; players: PlayerPublic[]; teams?: Team[]; coins?: Record<string, number> }>();
        const ts = teams ?? [];
        const results = players
          .map((x) => ({ name: x.name, score: nightScore(ts, players, x), ...(ts.length ? { team: ts.find((t) => t.members.includes(x.id))?.name } : {}) }))
          .sort((a, b) => b.score - a.score);
        // Mynt: kvällens intjänade plus vinstbonus till alla med bästa resultatet (hela vinnarlaget).
        const top = results[0]?.score;
        const payout: Record<string, number> = {};
        for (const x of players) {
          const won = results.length > 0 && nightScore(ts, players, x) === top && top > 0;
          const n = (coins?.[x.id] ?? 0) + (won ? COINS.winner : 0);
          if (n > 0) payout[x.name] = n;
        }
        const entry: LeagueEntry = {
          id: code + "-" + new Date().toISOString().slice(0, 10),
          date: new Date().toISOString(),
          title,
          results,
          coins: payout,
        };
        await hub.fetch(new Request("https://hub/hub/league", { method: "POST", body: JSON.stringify(entry) }));
        await hub.fetch(new Request("https://hub/hub/payout", { method: "POST", body: JSON.stringify({ id: entry.id, coins: payout }) }));
        return json(entry);
      }
    }
    return json({ error: "Okänd väg" }, 404);
  },
} satisfies ExportedHandler<Env>;
