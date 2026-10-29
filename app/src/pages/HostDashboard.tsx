import { useEffect, useMemo, useState } from "react";
import { Link, navigate, TopBar } from "../App";
import { api, repoSets } from "../lib/api";
import type { HubPublic, Question, QuestionSet } from "../../shared/types";
import { DEFAULT_SETTINGS, MAX_SHOWN, MIN_SHOWN, validChoices } from "../../shared/types";
import { validSkill } from "../../shared/skill";

/** Frågor som går att spela: svarsalternativ eller skill-utmaning. Andra hoppas över av servern. */
const playable = (q: Question) => (q.mode === "skill" ? !!validSkill(q.skill) : !!validChoices(q));
import PinGate from "./PinGate";

function Dashboard() {
  const [bank, setBank] = useState<QuestionSet[]>([]);
  const [hub, setHub] = useState<HubPublic | null>(null);
  const [selected, setSelected] = useState("");
  const [choiceCount, setChoiceCount] = useState(DEFAULT_SETTINGS.choiceCount);
  const [collectSeconds, setCollectSeconds] = useState(DEFAULT_SETTINGS.collectSeconds);
  const [hostPlays, setHostPlays] = useState(DEFAULT_SETTINGS.hostPlays);
  const [playMode, setPlayMode] = useState(DEFAULT_SETTINGS.playMode);
  const [buzzEvery, setBuzzEvery] = useState(DEFAULT_SETTINGS.buzzEvery);
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
      const { code } = await api.createRoom(set, { choiceCount, collectSeconds, hostPlays, playMode, buzzEvery }, shuffle);
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
                    <span className="muted small"> · {s.questions.filter(playable).length} frågor
                      {s.questions.some((q) => !playable(q)) && <span className="err"> · {s.questions.filter((q) => !playable(q)).length} saknar alternativ och hoppas över</span>}</span>
                  </span>
                  <span className={`tag ${s.source}`}>{s.source === "repo" ? "från rådet" : "egen"}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="panel stack">
            <h3>Regler</h3>
            <label>Spelform
              <select aria-label="Spelform" value={playMode} onChange={(e) => setPlayMode(e.target.value as typeof playMode)}>
                <option value="turns">Lagens tur (lagen turas om, snacka högt)</option>
                <option value="all">Alla svarar samtidigt</option>
              </select>
            </label>
            <label>Buzzerfråga
              <select aria-label="Buzzerfråga" value={buzzEvery} onChange={(e) => setBuzzEvery(+e.target.value)}>
                <option value={0}>Aldrig</option>
                {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Var {n}:{n === 2 ? "a" : "e"} fråga</option>)}
              </select>
            </label>
            <p className="muted small">Lagens tur: varje fråga går till ett lag (eller en spelare i alla mot alla) och lagen turas om. Buzzerfråga: först att buzza svarar, fel kostar poäng. Skill-utmaningar spelar alla samtidigt. Svårigheten styr du med ett reglage under kvällen.</p>
            <label>Antal svarsalternativ per fråga
              <select aria-label="Antal svarsalternativ" value={choiceCount} onChange={(e) => setChoiceCount(+e.target.value)}>
                {Array.from({ length: MAX_SHOWN - MIN_SHOWN + 1 }, (_, i) => i + MIN_SHOWN).map((n) => <option key={n} value={n}>{n} alternativ</option>)}
              </select>
            </label>
            <p className="muted small">Fler alternativ gör det svårare. Rätt svar plus slumpade felalternativ ur frågan; har en fråga färre blir det så många den har. Går att ändra under kvällen.</p>
            <label>Sekunder att svara
              <input type="number" aria-label="Sekunder att svara" min={5} max={180} value={collectSeconds} onChange={(e) => setCollectSeconds(+e.target.value)} />
            </label>
            <label style={{ flexDirection: "row", alignItems: "center" }}>
              <input type="checkbox" checked={hostPlays} onChange={(e) => setHostPlays(e.target.checked)} style={{ width: "auto" }} />
              Jag spelar själv (dölj facit för mig)
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
