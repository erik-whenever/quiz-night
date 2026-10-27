import { useEffect, useMemo, useState } from "react";
import { Link, navigate, TopBar } from "../App";
import { api, repoSets } from "../lib/api";
import type { HubPublic, QuestionSet } from "../../shared/types";
import PinGate from "./PinGate";

function Dashboard() {
  const [bank, setBank] = useState<QuestionSet[]>([]);
  const [hub, setHub] = useState<HubPublic | null>(null);
  const [selected, setSelected] = useState("");
  const [answerSeconds, setAnswerSeconds] = useState(10);
  const [penalty, setPenalty] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextDate, setNextDate] = useState("");
  const [nextTheme, setNextTheme] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api.bankSets().then(setBank).catch((e) => setErr(e.message));
    api.hub().then((h) => {
      setHub(h);
      if (h.nextQuiz) { setNextDate(h.nextQuiz.date.slice(0, 16)); setNextTheme(h.nextQuiz.theme ?? ""); }
    }).catch(() => {});
  }, []);

  const all = useMemo(() => [...bank, ...repoSets], [bank]);
  useEffect(() => { if (!selected && all[0]) setSelected(all[0].id); }, [all, selected]);
  const set = all.find((s) => s.id === selected);

  async function start() {
    if (!set) return;
    setBusy(true); setErr("");
    try {
      const { code } = await api.createRoom(set, { answerSeconds, penalty }, shuffle);
      navigate("/host/" + code);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <>
      <TopBar host />
      <main className="wrap stack" style={{ gap: 24 }}>
        <h1>Starta kvällens quiz</h1>
        <div className="host-grid">
          <section className="panel stack">
            <h3>Välj frågeset</h3>
            {all.length === 0 && <p className="muted">Inga frågeset än. <Link to="/bank">Skapa ett i frågebanken.</Link></p>}
            <div className="stack" style={{ gap: 8 }} role="radiogroup">
              {all.map((s) => (
                <label key={s.id} className="panel flat" style={{ flexDirection: "row", alignItems: "center", gap: 12, cursor: "pointer", padding: 12, borderColor: s.id === selected ? "var(--signal)" : undefined }}>
                  <input type="radio" name="set" checked={s.id === selected} onChange={() => setSelected(s.id)} style={{ width: "auto" }} />
                  <span style={{ flex: 1 }}>
                    <strong>{s.title}</strong>
                    <span className="muted small"> · {s.questions.length} frågor</span>
                  </span>
                  <span className={`tag ${s.source}`}>{s.source === "repo" ? "från rådet" : "egen"}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="panel stack">
            <h3>Regler</h3>
            <label>Sekunder att svara efter buzz
              <input type="number" min={3} max={60} value={answerSeconds} onChange={(e) => setAnswerSeconds(+e.target.value)} />
            </label>
            <label>Straff vid fel eller timeout (poäng)
              <input type="number" min={0} max={10} value={penalty} onChange={(e) => setPenalty(+e.target.value)} />
            </label>
            <label style={{ flexDirection: "row", alignItems: "center" }}>
              <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} style={{ width: "auto" }} />
              Blanda frågorna
            </label>
            {err && <p className="err">{err}</p>}
            <button className="btn primary big" onClick={start} disabled={!set || busy}>Öppna rum</button>
          </section>
        </div>

        <section className="panel stack">
          <h3>Nästa quizkväll</h3>
          <p className="muted small">Syns på startsidan. AI-rådet läser datumet och planerar så att allt är klart dagen innan.</p>
          <div className="row">
            <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} style={{ maxWidth: 260 }} />
            <input placeholder="Tema (valfritt)" value={nextTheme} onChange={(e) => setNextTheme(e.target.value)} style={{ maxWidth: 320 }} />
            <button className="btn" onClick={async () => {
              await api.setNext(nextDate ? new Date(nextDate).toISOString() : "", nextTheme || undefined);
              setSaved(nextDate ? "Sparat" : "Rensat");
            }}>Spara datum</button>
            {saved && <span className="muted small" role="status">{saved}</span>}
          </div>
        </section>
        {hub && hub.league.length > 0 && <p className="muted small">{hub.league.length} kvällar spelade hittills. <Link to="/tabell">Se tabellen</Link></p>}
      </main>
    </>
  );
}

export default function HostDashboard() {
  return <PinGate><Dashboard /></PinGate>;
}
