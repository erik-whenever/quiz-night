import { useEffect, useRef, useState } from "react";
import { Link, TopBar } from "../App";
import { api, hostKeyFor } from "../lib/api";
import { useRoom } from "../lib/useRoom";
import { Podium } from "../components";
import { CollectHost } from "../collect";
import type { ClientMsg, HostState } from "../../shared/types";
import { DIFFICULTY_LABELS, MAX_SHOWN, MIN_SHOWN, effectiveChoiceRules } from "../../shared/types";
import { HostWheel } from "../wheel";
import { EffectTags, HostTeams, TeamBoard, TeamPodium } from "../teams";
import PinGate from "./PinGate";

/**
 * Svårighetsreglaget: väljer nästa fråga närmast vald nivå och gör den svårare (fler alternativ, kortare tid).
 * Visar hur många frågor som finns kvar per nivå, så värden ser när setet tar slut på svåra frågor.
 */
export function DifficultySlider({ state, send }: { state: HostState; send: (m: ClientMsg) => void }) {
  const d = state.settings.difficulty;
  const rules = effectiveChoiceRules(state.settings);
  const left = state.diffLeft ?? [0, 0, 0, 0, 0];
  const nearest = d ? [0, 1, 2, 3, 4].filter((i) => left[i] > 0).sort((a, b) => Math.abs(a + 1 - d) - Math.abs(b + 1 - d))[0] : undefined;
  return (
    <div className="difficulty">
      <label className="stack" style={{ gap: 6 }}>
        <span className="spread"><span>Svårighet</span><strong aria-live="polite">{DIFFICULTY_LABELS[d]}</strong></span>
        <input type="range" aria-label="Svårighet" min={0} max={5} step={1} value={d}
          onChange={(e) => send({ t: "host:settings", settings: { difficulty: +e.target.value } })} />
        <span className="spread muted small"><span>Setets ordning</span><span>Lätt → Riktigt svår</span></span>
      </label>
      <p className="small diff-rules" aria-live="polite">
        Nästa fråga: <strong>{rules.choices} alternativ</strong> · <strong>{rules.seconds} s</strong>
        {nearest !== undefined && <> · svårighet <strong>{nearest + 1}</strong></>}
        {nearest !== undefined && nearest + 1 < d && <span className="err"> (setet har inga svårare kvar)</span>}
      </p>
      <ol className="diff-left" aria-label="Frågor kvar per svårighet">
        {left.map((n, i) => (
          <li key={i} className={`${n ? "" : "empty"}${d === i + 1 ? " on" : ""}`} title={`${n} frågor kvar på nivå ${i + 1}`}>
            <span className="pips">{"●".repeat(i + 1)}</span><span className="n">{n}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Kvällens regler. Kan ändras när som helst; antal alternativ och svarstid gäller från nästa fråga. */
export function RuleSettings({ state, send }: { state: HostState; send: (m: ClientMsg) => void }) {
  const s = state.settings;
  const started = state.phase !== "lobby";
  const set = (settings: Partial<HostState["settings"]>) => send({ t: "host:settings", settings });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label>Spelform
        <select aria-label="Spelform" value={s.playMode} onChange={(e) => set({ playMode: e.target.value as HostState["settings"]["playMode"] })}>
          <option value="turns">Lagens tur (lagen turas om)</option>
          <option value="all">Alla svarar samtidigt</option>
        </select>
      </label>
      <label>Buzzerfråga
        <select aria-label="Buzzerfråga" value={s.buzzEvery} onChange={(e) => set({ buzzEvery: +e.target.value })}>
          <option value={0}>Aldrig</option>
          {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Var {n}:{n === 2 ? "a" : "e"} fråga</option>)}
        </select>
      </label>
      <label>Straff för fel buzzersvar
        <input type="number" aria-label="Straff för fel buzzersvar" min={0} max={5} key={`pe${s.penalty}`} defaultValue={s.penalty}
          onBlur={(e) => +e.target.value !== s.penalty && set({ penalty: +e.target.value })} />
      </label>
      <label>Antal svarsalternativ
        <select aria-label="Antal svarsalternativ" value={s.choiceCount} onChange={(e) => set({ choiceCount: +e.target.value })}>
          {Array.from({ length: MAX_SHOWN - MIN_SHOWN + 1 }, (_, i) => i + MIN_SHOWN).map((n) => (
            <option key={n} value={n}>{n} alternativ{n === 4 ? " (standard)" : ""}</option>
          ))}
        </select>
      </label>
      <label>Sekunder att svara
        <input type="number" aria-label="Sekunder att svara" min={5} max={180} key={`cs${s.collectSeconds}`} defaultValue={s.collectSeconds}
          onBlur={(e) => +e.target.value !== s.collectSeconds && set({ collectSeconds: +e.target.value })} />
      </label>
      <label>Bonus till snabbaste rätt
        <input type="number" aria-label="Bonus till snabbaste rätt" min={0} max={5} key={`fb${s.fastestBonus}`} defaultValue={s.fastestBonus}
          onBlur={(e) => +e.target.value !== s.fastestBonus && set({ fastestBonus: +e.target.value })} />
      </label>
      <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={s.hostPlays} disabled={started && s.hostPlays}
          onChange={(e) => set({ hostPlays: e.target.checked })} />
        Jag spelar själv (dölj facit och andras svar för mig)
      </label>
      {s.difficulty > 0 && <p className="muted small">Svårighetsreglaget styr antal alternativ och tid just nu. Dra det till "Setets ordning" för att använda inställningarna här.</p>}
      {started && <p className="muted small">Ändringar av spelform, antal alternativ och tid gäller från nästa fråga.{s.hostPlays ? " Facit kan inte visas för dig förrän kvällen är slut." : ""}</p>}
    </div>
  );
}

function Control({ code }: { code: string }) {
  const hostKey = hostKeyFor(code);
  const { state, error, send, serverNow, connected } = useRoom(code, "host", { hostKey });
  const [crowned, setCrowned] = useState("");
  const [copied, setCopied] = useState("");

  // Tangentbord: V = visa svaret (under en fråga), N = nästa fråga (när svaret visas eller i lobbyn)
  const phaseRef = useRef(state?.phase);
  phaseRef.current = state?.phase;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      const ph = phaseRef.current;
      if (k === "v" && (ph === "collect" || ph === "judge")) send({ t: "host:judge" });
      if (k === "n" && ph === "reveal") send({ t: "host:next" });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [send]);

  if (!hostKey) return <main className="narrow stack"><p className="err">Det här rummet startades från en annan enhet. Öppna det därifrån eller starta ett nytt.</p><Link to="/host">Till start</Link></main>;
  if (!state) return <main className="narrow"><p className="muted">{error || "Ansluter…"}</p></main>;

  const tvUrl = `${location.origin}/tv/${code}`;
  const copy = (txt: string, label: string) => { navigator.clipboard?.writeText(txt); setCopied(label); setTimeout(() => setCopied(""), 1500); };
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const inQuestion = state.phase === "collect" || state.phase === "judge" || state.phase === "reveal";

  return (
    <>
      <TopBar host />
      <main className="wrap stack">
        <div className="spread">
          <div>
            <h2>{state.title}</h2>
            <p className="muted">Rum <strong style={{ color: "var(--signal)", letterSpacing: "0.1em" }}>{code}</strong>
              {state.qIndex >= 0 && state.phase !== "finished" && <> · fråga {state.qIndex + 1} av {state.qCount}</>}
              {!connected && <span className="err small" style={{ marginLeft: 8 }}>frånkopplad</span>}
            </p>
          </div>
          <div className="row">
            <a className="btn sm" href={tvUrl} target="_blank" rel="noreferrer">Öppna TV-vyn</a>
            <button className="btn sm ghost" onClick={() => copy(`${location.origin}/play/${code}`, "Spelarlänk kopierad")}>Kopiera spelarlänk</button>
            {copied && <span className="small muted" role="status">{copied}</span>}
          </div>
        </div>
        <p className="muted small">
          {state.settings.hostPlays
            ? <>Du spelar själv: den här sidan visar inget facit. Gå med som spelare i mobilen via <strong>{location.host}/play/{code}</strong>.</>
            : "Skärmdela TV-vyn i Discord. Den här sidan visar svaren, så dela inte den."}
        </p>

        <div className="host-grid">
          <section className="panel stack">
            {state.phase === "lobby" && (
              <>
                <h3>Väntar på spelare</h3>
                <p className="muted">{state.players.length} inne. Starta när alla är med.</p>
                <HostTeams state={state} send={send} />
                <DifficultySlider state={state} send={send} />
                <EffectTags state={state} />
                <button className="btn primary big" onClick={() => send({ t: "host:start" })} disabled={!state.players.length}>Starta första frågan</button>
                <HostWheel state={state} send={send} serverNow={serverNow} />
              </>
            )}

            {inQuestion && state.question && (
              <>
                <p style={{ fontSize: "1.3rem", fontWeight: 600 }}>{state.question.text}</p>
                {state.answer && <div className="answer-box">Svar: {state.answer}</div>}
                <EffectTags state={state} />
                <CollectHost state={state} send={send} serverNow={serverNow} />
                <HostWheel state={state} send={send} serverNow={serverNow} />
                <DifficultySlider state={state} send={send} />
                {state.phase === "reveal" && (
                  <button className="btn primary big" onClick={() => send({ t: "host:next" })}>
                    {state.qIndex + 1 >= state.qCount ? "Avsluta och visa pallen (N)" : "Nästa fråga (N)"}
                  </button>
                )}
              </>
            )}

            {state.phase === "finished" && (
              <>
                <h3>Klart!</h3>
                {state.teams.length ? <TeamPodium state={state} /> : <Podium players={state.players} />}
                {crowned ? <p role="status">Sparat i tabellen och mynten utbetalda. Grattis {crowned}!</p> : (
                  <button className="btn primary big" onClick={async () => {
                    await api.crown(code);
                    const lead = [...state.teams].map((t) => ({ t, s: t.members.map((id) => state.players.find((p) => p.id === id)?.score ?? 0) }))
                      .map((x) => ({ name: x.t.name, avg: x.s.reduce((a, b) => a + b, 0) / Math.max(1, x.s.length) })).sort((a, b) => b.avg - a.avg)[0];
                    setCrowned(lead?.name ?? sorted[0]?.name ?? "");
                  }}>Kröna vinnaren och spara i tabellen</button>
                )}
              </>
            )}
          </section>

          <section className="panel stack">
            <h3>Spelare</h3>
            {state.teams.length > 0 && state.phase !== "lobby" && <TeamBoard state={state} compact />}
            {sorted.length === 0 && <p className="muted">Ingen här än. Dela koden {code}.</p>}
            <table>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} style={{ opacity: p.connected ? 1 : 0.5 }}>
                    <td><span style={{ color: p.color }}>●</span> {p.name}
                      {state.wallets?.[p.id] && <span className="muted small"> · 🪙 {state.wallets[p.id].coins}{state.coinsTonight?.[p.id] ? ` +${state.coinsTonight[p.id]}` : ""}</span>}</td>
                    <td className="num display">{p.score}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                      <button className="btn sm ghost" aria-label={`Ge ${p.name} en poäng`} onClick={() => send({ t: "host:adjust", playerId: p.id, delta: 1 })}>+1</button>{" "}
                      <button className="btn sm ghost" aria-label={`Ta en poäng från ${p.name}`} onClick={() => send({ t: "host:adjust", playerId: p.id, delta: -1 })}>−1</button>{" "}
                      <button className="btn sm ghost" aria-label={`Ta bort ${p.name}`} onClick={() => confirm(`Ta bort ${p.name}?`) && send({ t: "host:kick", playerId: p.id })}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details open={state.phase === "lobby"}>
              <summary className="muted">Kvällens regler</summary>
              <div style={{ marginTop: 12 }}><RuleSettings state={state} send={send} /></div>
            </details>
            {state.phase !== "finished" && state.phase !== "lobby" && (
              <button className="btn sm ghost" onClick={() => confirm("Avsluta quizet nu?") && send({ t: "host:finish" })}>Avsluta i förtid</button>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

export default function HostControl({ code }: { code: string }) {
  return <PinGate><Control code={code} /></PinGate>;
}
