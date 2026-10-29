import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { Crown } from "../App";
import { useCountdown, useRoom } from "../lib/useRoom";
import { sfx } from "../lib/sound";
import { Countdown, Podium, Scorebar } from "../components";
import { CollectTv } from "../collect";
import { answerSecondsFor } from "../../shared/types";
import { StealNote, TwistBadge, WheelPanel, pendingWheel } from "../wheel";

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
    if (ev.kind === "judged") {
      if (ev.correct.length) { sfx.correct(); confetti({ particleCount: 60, spread: 70, origin: { y: 0.7 } }); } else sfx.wrong();
    }
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
  const wheel = pendingWheel(state);

  return (
    <main className="tv" onClick={sfx.unlock}>
      <div className="tv-head">
        <div className="row"><div style={{ width: 44 }}><Crown /></div><h2>{state.title}</h2></div>
        <div style={{ textAlign: "right" }}>
          <div className="joincode" aria-label="Rumskod">{code}</div>
          <div className="muted small">{joinUrl}</div>
        </div>
      </div>

      <div className={`tv-stage${wheel ? " with-wheel" : ""}`}>
      {state.phase === "lobby" && (
        <div className="question-card">
          <p className="question-text">Gå in på {location.host} och skriv koden</p>
          <p className="qmeta">{state.players.length} spelare inne, {state.qCount} frågor väntar</p>
        </div>
      )}

      {(state.phase === "question" || state.phase === "buzzed" || state.phase === "collect" || state.phase === "judge" || state.phase === "reveal") && state.question && (
        <div className="question-card">
          <TwistBadge state={state} />
          <p className="qmeta">Fråga {state.qIndex + 1} av {state.qCount}{state.question.category ? ` · ${state.question.category}` : ""}{state.question.points !== 1 ? ` · ${state.question.points} p` : ""}</p>
          {state.question.imageUrl && <img src={state.question.imageUrl} alt="" style={{ maxHeight: "35vh", borderRadius: 16 }} />}
          <p className="question-text">{state.question.text}</p>
          {state.phase === "buzzed" && buzzer && (
            <div className="buzz-banner" style={{ "--player": buzzer.color } as React.CSSProperties}>
              <span>{buzzer.name}</span>
              <Countdown ms={left} total={answerSecondsFor(state) * 1000} size={90} />
            </div>
          )}
          {state.phase === "buzzed" && <p className="qmeta">{left > 0 ? "har ordet, svara i Discord" : "Tiden är ute, hosten avgör"}</p>}
          {state.revealedAnswer && state.question.mode !== "skill" && <div className="answer-reveal">{state.revealedAnswer}</div>}
          {state.collect && <CollectTv state={state} serverNow={serverNow} />}
          <StealNote state={state} />
        </div>
      )}
      {wheel && <WheelPanel wheel={wheel} serverNow={serverNow} size={Math.min(420, Math.round(window.innerHeight * 0.5), window.innerWidth - 64)} onLanded={sfx.next} />}
      </div>

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
