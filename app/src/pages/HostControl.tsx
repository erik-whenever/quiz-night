import { useEffect, useRef, useState } from "react";
import { Link, TopBar } from "../App";
import { api, hostKeyFor } from "../lib/api";
import { useCountdown, useRoom } from "../lib/useRoom";
import { Countdown, Podium } from "../components";
import { CollectHost } from "../collect";
import { answerSecondsFor } from "../../shared/types";
import { HostWheel } from "../wheel";
import PinGate from "./PinGate";

function Control({ code }: { code: string }) {
  const hostKey = hostKeyFor(code);
  const { state, error, send, serverNow, connected } = useRoom(code, "host", { hostKey });
  const left = useCountdown(state?.buzz?.deadline, serverNow);
  const [crowned, setCrowned] = useState("");
  const [copied, setCopied] = useState("");

  // Under insamling/rättning skulle N kasta allas svar och V stänga insamlingen i förtid: bara knapparna gäller då.
  const collecting = state?.phase === "collect" || state?.phase === "judge";
  const collectingRef = useRef(collecting);
  collectingRef.current = collecting;

  // Tangentbord: R = rätt, F = fel, T = för långsam, N = nästa, V = visa svar
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (collectingRef.current) return;
      const k = e.key.toLowerCase();
      if (k === "r") send({ t: "host:correct" });
      if (k === "f") send({ t: "host:wrong" });
      if (k === "t") send({ t: "host:slow" });
      if (k === "n") send({ t: "host:next" });
      if (k === "v") send({ t: "host:reveal" });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [send]);

  if (!hostKey) return <main className="narrow stack"><p className="err">Det här rummet startades från en annan enhet. Öppna det därifrån eller starta ett nytt.</p><Link to="/host">Till start</Link></main>;
  if (!state) return <main className="narrow"><p className="muted">{error || "Ansluter…"}</p></main>;

  const tvUrl = `${location.origin}/tv/${code}`;
  const buzzer = state.players.find((p) => p.id === state.buzz?.playerId);
  const copy = (txt: string, label: string) => { navigator.clipboard?.writeText(txt); setCopied(label); setTimeout(() => setCopied(""), 1500); };
  const sorted = [...state.players].sort((a, b) => b.score - a.score);

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
        <p className="muted small">Skärmdela TV-vyn i Discord. Den här sidan visar svaren, så dela inte den.</p>

        <div className="host-grid">
          <section className="panel stack">
            {state.phase === "lobby" && (
              <>
                <h3>Väntar på spelare</h3>
                <p className="muted">{state.players.length} inne. Starta när alla är med.</p>
                <button className="btn primary big" onClick={() => send({ t: "host:start" })} disabled={!state.players.length}>Starta första frågan</button>
                <HostWheel state={state} send={send} serverNow={serverNow} />
              </>
            )}

            {(state.phase === "question" || state.phase === "buzzed" || state.phase === "collect" || state.phase === "judge" || state.phase === "reveal") && state.question && (
              <>
                <p style={{ fontSize: "1.3rem", fontWeight: 600 }}>{state.question.text}</p>
                {state.answer && <div className="answer-box">Svar: {state.answer}</div>}
                {state.collect && <CollectHost state={state} send={send} serverNow={serverNow} />}
                <HostWheel state={state} send={send} serverNow={serverNow} />

                {state.phase === "question" && <p className="muted" aria-live="polite">Fritt fram att buzza… {state.lockedOut.length > 0 && `(${state.lockedOut.length} utlåsta)`}</p>}

                {state.phase === "buzzed" && buzzer && (
                  <div className="stack" style={{ alignItems: "center" }}>
                    <div className="row" style={{ justifyContent: "center" }}>
                      <Countdown ms={left} total={answerSecondsFor(state) * 1000} size={96} />
                      <div>
                        <p className="display" style={{ fontSize: "1.8rem", color: buzzer.color }}>{buzzer.name}</p>
                        <p className="muted small" aria-live="polite">{left > 0 ? "har ordet och svarar i Discord" : "Riktmärket har gått ut, du avgör"}</p>
                      </div>
                    </div>
                    <div className="judge" style={{ width: "100%" }}>
                      <button className="btn go big" onClick={() => send({ t: "host:correct" })}>Rätt (R)</button>
                      <button className="btn bad big" onClick={() => send({ t: "host:wrong" })}>Fel (F)</button>
                      <button className={`btn big ${left > 0 ? "ghost" : "bad"}`} onClick={() => send({ t: "host:slow" })}>För långsam (T)</button>
                    </div>
                  </div>
                )}

                <div className="row">
                  {(state.phase === "question" || state.phase === "buzzed") && <button className="btn ghost" onClick={() => send({ t: "host:reveal" })}>Visa svaret (V)</button>}
                  {!collecting && (
                    <button className={`btn ${state.phase === "reveal" ? "primary big" : "ghost"}`} onClick={() => send({ t: "host:next" })}>
                      {state.qIndex + 1 >= state.qCount ? "Avsluta och visa pallen (N)" : "Nästa fråga (N)"}
                    </button>
                  )}
                </div>
              </>
            )}

            {state.phase === "finished" && (
              <>
                <h3>Klart!</h3>
                <Podium players={state.players} />
                {crowned ? <p role="status">Sparat i tabellen. Grattis {crowned}!</p> : (
                  <button className="btn primary big" onClick={async () => {
                    await api.crown(code); setCrowned(sorted[0]?.name ?? "");
                  }}>Kröna vinnaren och spara i tabellen</button>
                )}
              </>
            )}
          </section>

          <section className="panel stack">
            <h3>Spelare</h3>
            {sorted.length === 0 && <p className="muted">Ingen här än. Dela koden {code}.</p>}
            <table>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} style={{ opacity: p.connected ? 1 : 0.5 }}>
                    <td><span style={{ color: p.color }}>●</span> {p.name}{state.lockedOut.includes(p.id) && <span className="tag" style={{ marginLeft: 6 }}>utlåst</span>}</td>
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
            <details>
              <summary className="muted">Regler just nu</summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <label>Sekunder att svara (riktmärke, du dömer)
                  <input type="number" min={3} max={60} defaultValue={state.settings.answerSeconds}
                    onBlur={(e) => send({ t: "host:settings", settings: { answerSeconds: +e.target.value } })} />
                </label>
                <label>Straff
                  <input type="number" min={0} max={10} defaultValue={state.settings.penalty}
                    onBlur={(e) => send({ t: "host:settings", settings: { penalty: +e.target.value } })} />
                </label>
                <label>Sekunder för Alla svarar och alternativ
                  <input type="number" min={5} max={180} defaultValue={state.settings.collectSeconds}
                    onBlur={(e) => send({ t: "host:settings", settings: { collectSeconds: +e.target.value } })} />
                </label>
                <label>Bonus till snabbaste rätt
                  <input type="number" min={0} max={5} defaultValue={state.settings.fastestBonus}
                    onBlur={(e) => send({ t: "host:settings", settings: { fastestBonus: +e.target.value } })} />
                </label>
              </div>
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
