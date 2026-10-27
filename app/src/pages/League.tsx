import { useEffect, useState } from "react";
import { TopBar } from "../App";
import { api } from "../lib/api";
import type { HubPublic } from "../../shared/types";

export default function League() {
  const [hub, setHub] = useState<HubPublic | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.hub().then(setHub).catch((e) => setErr(e.message)); }, []);

  const totals = new Map<string, { crowns: number; points: number; nights: number }>();
  for (const e of hub?.league ?? []) {
    e.results.forEach((r, i) => {
      const t = totals.get(r.name) ?? { crowns: 0, points: 0, nights: 0 };
      t.points += r.score; t.nights += 1; if (i === 0) t.crowns += 1;
      totals.set(r.name, t);
    });
  }
  const rows = [...totals.entries()].sort((a, b) => b[1].crowns - a[1].crowns || b[1].points - a[1].points);

  return (
    <>
      <TopBar />
      <main className="wrap stack" style={{ gap: 24 }}>
        <h1>Säsongen</h1>
        {err && <p className="err">{err}</p>}
        {hub && rows.length === 0 && <p className="muted">Inga kvällar spelade än. Första kronan väntar.</p>}
        {rows.length > 0 && (
          <section className="panel">
            <table>
              <thead><tr><th>Spelare</th><th className="num">Kronor</th><th className="num">Poäng</th><th className="num">Kvällar</th></tr></thead>
              <tbody>
                {rows.map(([name, t], i) => (
                  <tr key={name}>
                    <td><strong>{i === 0 ? "👑 " : ""}{name}</strong></td>
                    <td className="num display">{t.crowns}</td>
                    <td className="num">{t.points}</td>
                    <td className="num">{t.nights}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {(hub?.league.length ?? 0) > 0 && (
          <section className="stack">
            <h3>Tidigare kvällar</h3>
            {hub!.league.map((e) => (
              <div key={e.id} className="panel flat" style={{ padding: 14 }}>
                <div className="spread">
                  <strong>{e.title}</strong>
                  <span className="muted small">{new Date(e.date).toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" })}</span>
                </div>
                <p className="muted small">{e.results.map((r, i) => `${i + 1}. ${r.name} (${r.score})`).join("   ")}</p>
              </div>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
