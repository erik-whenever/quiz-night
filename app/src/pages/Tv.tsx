import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { Crown } from "../App";
import { useRoom } from "../lib/useRoom";
import { music, sfx } from "../lib/sound";
import { NextBar, Podium, QuestionIntro, Scorebar } from "../components";
import { CollectTv } from "../collect";
import { StealNote, TwistBadge, WheelPanel, pendingWheel } from "../wheel";
import { EffectTags, TeamBoard, TeamPodium } from "../teams";

/** Skärmen hosten delar i Discord. Visar aldrig svaret innan det avslöjas. */
export default function Tv({ code }: { code: string }) {
  const { state, error, serverNow } = useRoom(code, "tv");
  // Bakgrundsmusik: på som standard, kommer ihåg valet. Ljud kräver ett klick på sidan först (webbläsarregel).
  const [musicOn, setMusicOn] = useState(() => { try { return localStorage.getItem("kronan.musik") !== "av"; } catch { return true; } });
  const [unlocked, setUnlocked] = useState(false);
  const phase = state?.phase;
  useEffect(() => {
    if (!musicOn || !unlocked || !phase || phase === "finished") { music.stop(); return; }
    music.start(phase === "collect" ? "think" : "chill");
    music.mood(phase === "collect" ? "think" : "chill");
  }, [musicOn, unlocked, phase]);
  useEffect(() => () => music.stop(), []);
  const toggleMusic = () => {
    const on = !musicOn;
    setMusicOn(on);
    try { localStorage.setItem("kronan.musik", on ? "på" : "av"); } catch { /* */ }
  };

  const lastAt = useRef(0);
  useEffect(() => {
    const ev = state?.lastEvent;
    if (!ev || ev.at === lastAt.current) return;
    lastAt.current = ev.at;
    if (ev.kind === "buzzed") sfx.buzz();
    if (ev.kind === "buzzWrong") sfx.wrong();
    if (ev.kind === "judged") {
      if (ev.correct.length) { sfx.correct(); confetti({ particleCount: 60, spread: 70, origin: { y: 0.7 } }); } else sfx.wrong();
    }
    if (ev.kind === "finished") {
      music.stop();
      sfx.crown();
      const end = Date.now() + 2500;
      (function frame() {
        confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0 }, colors: ["#FFD23F", "#FF3B47", "#F4F5FF"] });
        confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1 }, colors: ["#FFD23F", "#FF3B47", "#F4F5FF"] });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    }
  }, [state?.lastEvent]);
  const qRef = useRef(-1);
  useEffect(() => {
    if (state?.phase === "collect" && state.qIndex !== qRef.current) { qRef.current = state.qIndex; sfx.question(); }
  }, [state?.phase, state?.qIndex]);

  if (!state) return <main className="tv"><p className="muted">{error || `Ansluter till ${code}…`}</p></main>;

  const joinUrl = `${location.host}/play/${code}`;
  const wheel = pendingWheel(state);

  return (
    <main className="tv" onClick={() => { sfx.unlock(); setUnlocked(true); }}>
      <button className="btn sm ghost music-toggle" aria-pressed={musicOn} onClick={(e) => { e.stopPropagation(); sfx.unlock(); setUnlocked(true); toggleMusic(); }}>
        {musicOn ? (unlocked ? "♪ Musik på" : "♪ Klicka för ljud") : "♪ Musik av"}
      </button>
      <QuestionIntro state={state} serverNow={serverNow} big />
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
          {state.teams.length > 0 && <TeamBoard state={state} />}
          <EffectTags state={state} />
        </div>
      )}

      {(state.phase === "collect" || state.phase === "judge" || state.phase === "reveal") && state.question && (
        <div className="question-card" key={state.qIndex}
          style={{ animationDelay: `${Math.max(0, (state.phase === "collect" && state.collect?.introUntil ? state.collect.introUntil - serverNow() : 0) - 250)}ms` }}>
          <TwistBadge state={state} />
          <EffectTags state={state} />
          <p className="qmeta">Fråga {state.qIndex + 1} av {state.qCount}{state.question.category ? ` · ${state.question.category}` : ""}{state.question.points !== 1 ? ` · ${state.question.points} p` : ""}
            {state.question.difficulty ? <span className="diff-pips" aria-label={`Svårighet ${state.question.difficulty} av 5`}> · {"●".repeat(state.question.difficulty)}{"○".repeat(5 - state.question.difficulty)}</span> : null}</p>
          {state.question.imageUrl && <img src={state.question.imageUrl} alt="" style={{ maxHeight: "35vh", borderRadius: 16 }} />}
          <p className="question-text">{state.question.text}</p>
          {state.revealedAnswer && state.question.mode !== "skill" && <div className="answer-reveal">{state.revealedAnswer}</div>}
          {state.collect && <CollectTv state={state} serverNow={serverNow} />}
          <StealNote state={state} />
          <NextBar state={state} serverNow={serverNow} />
        </div>
      )}
      {wheel && <WheelPanel wheel={wheel} serverNow={serverNow} size={Math.min(420, Math.round(window.innerHeight * 0.5), window.innerWidth - 64)} onLanded={sfx.next} />}
      </div>

      {state.phase === "finished" && (
        <div className="question-card">
          <h1>{state.teams.length ? "Kvällens kungar" : "Kvällens kung"}</h1>
          {state.teams.length ? <TeamPodium state={state} /> : <Podium players={state.players} />}
        </div>
      )}

      {state.teams.length ? (state.phase !== "lobby" && <TeamBoard state={state} compact />) : <Scorebar state={state} />}
    </main>
  );
}
