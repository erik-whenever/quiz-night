import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { Crown } from "../App";
import { useCountdown, useRoom } from "../lib/useRoom";
import { sfx } from "../lib/sound";
import { Countdown, Podium, Scorebar } from "../components";

/** Skärmen hosten delar i Discord. Visar aldrig svaret innan det avslöjas. */
export default function Tv({ code }: { code: string }) {
  const { state, error, serverNow } = useRoom(code, "tv");
  const left = useCountdown(state?.buzz?.deadline, serverNow);

  const lastAt = useRef(0);
  useEffect(() => {
    const ev = state?.lastEvent;
    if (!ev || ev.at === lastAt.current) return;
    lastAt.current = ev.at;
    if (ev.kind === "buzz") sfx.buzz();
    if (ev.kind === "correct") { sfx.correct(); confetti({ particleCount: 60, spread: 70, origin: { y: 0.7 } }); }
    if (ev.kind === "wrong" || ev.kind === "timeout") sfx.wrong();
    if (ev.kind === "finished") {
      sfx.crown();
      const end = Date.now() + 2500;
      (function frame() {
        confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0 }, colors: ["#FFD23F", "#FF3B47", "#F4F5FF"] });
        confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1 }, colors: ["#FFD23F", "#FF3B47", "#F4F5FF"] });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    }
  }, [state?.lastEvent]);

  if (!state) return <main className="tv"><p className="muted">{error || `Ansluter till ${code}…`}</p></main>;

  const buzzer = state.players.find((p) => p.id === state.buzz?.playerId);
  const joinUrl = `${location.host}/play/${code}`;

  return (
    <main className="tv" onClick={sfx.unlock}>
      <div className="tv-head">
        <div className="row"><div style={{ width: 44 }}><Crown /></div><h2>{state.title}</h2></div>
        <div style={{ textAlign: "right" }}>
          <div className="joincode" aria-label="Rumskod">{code}</div>
          <div className="muted small">{joinUrl}</div>
        </div>
      </div>

      {state.phase === "lobby" && (
        <div className="question-card">
          <p className="question-text">Gå in på {location.host} och skriv koden</p>
          <p className="qmeta">{state.players.length} spelare inne, {state.qCount} frågor väntar</p>
        </div>
      )}

      {(state.phase === "question" || state.phase === "buzzed" || state.phase === "reveal") && state.question && (
        <div className="question-card">
          <p className="qmeta">Fråga {state.qIndex + 1} av {state.qCount}{state.question.category ? ` · ${state.question.category}` : ""}{state.question.points !== 1 ? ` · ${state.question.points} p` : ""}</p>
          {state.question.imageUrl && <img src={state.question.imageUrl} alt="" style={{ maxHeight: "35vh", borderRadius: 16 }} />}
          <p className="question-text">{state.question.text}</p>
          {state.phase === "buzzed" && buzzer && (
            <div className="buzz-banner" style={{ "--player": buzzer.color } as React.CSSProperties}>
              <span>{buzzer.name}</span>
              <Countdown ms={left} total={state.settings.answerSeconds * 1000} size={90} />
            </div>
          )}
          {state.phase === "buzzed" && state.buzz?.typedAnswer && <p className="qmeta">”{state.buzz.typedAnswer}”</p>}
          {state.revealedAnswer && <div className="answer-reveal">{state.revealedAnswer}</div>}
        </div>
      )}

      {state.phase === "finished" && (
        <div className="question-card">
          <h1>Kvällens kung</h1>
          <Podium players={state.players} />
        </div>
      )}

      <Scorebar state={state} />
    </main>
  );
}
