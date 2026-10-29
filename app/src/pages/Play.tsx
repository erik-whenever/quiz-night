import { useEffect, useRef, useState } from "react";
import { Crown, Link } from "../App";
import { useRoom } from "../lib/useRoom";
import { haptic, sfx } from "../lib/sound";
import { Podium, Scorebar } from "../components";
import { CollectPlay, rememberAnswer } from "../collect";
import { CHOICE_LETTERS } from "../../shared/types";
import { unitOf } from "../../shared/teams";
import { StealNote, TwistBadge, WheelPanel, pendingWheel } from "../wheel";
import { CoinToast, EffectTags, FiftyButton, PlayerShop, TeamBoard, TeamPodium } from "../teams";

const idKey = (code: string) => "kronan.player." + code;
const NAME_KEY = "kronan.name";
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

/** Nedräkningen för just mig: Extra tid eller Sabotage flyttar min deadline. */
function withMyDeadline<S extends { collect?: { deadline: number; extra?: Record<string, number> } }>(state: S, me: string): S {
  const ms = state.collect?.extra?.[me];
  return ms && state.collect ? { ...state, collect: { ...state.collect, deadline: state.collect.deadline + ms } } : state;
}

export default function Play({ code }: { code: string }) {
  const [playerId, setPlayerId] = useState(read(idKey(code)));
  const [name, setName] = useState(read(NAME_KEY));
  const [joining, setJoining] = useState(false);
  const { state, error, send, serverNow, connected } = useRoom(code, "player", {
    onJoined: (id) => { setPlayerId(id); write(idKey(code), id); setJoining(false); },
  });

  // Återanslut automatiskt som samma spelare
  const rejoined = useRef(false);
  useEffect(() => {
    if (connected && playerId && name && !rejoined.current) { rejoined.current = true; send({ t: "join", name, playerId }); }
    if (!connected) rejoined.current = false;
  }, [connected, playerId, name, send]);

  const me = state?.players.find((p) => p.id === playerId);

  // Lås upp ljud på första trycket var som helst (iOS kräver en gest)
  useEffect(() => {
    const on = () => sfx.unlock();
    window.addEventListener("pointerdown", on, { once: true });
    window.addEventListener("keydown", on, { once: true });
    return () => { window.removeEventListener("pointerdown", on); window.removeEventListener("keydown", on); };
  }, []);

  // Ljud och vibration när en fråga rättas
  const lastAt = useRef(0);
  useEffect(() => {
    const ev = state?.lastEvent;
    if (!state || ev?.at === lastAt.current) return;
    // Första tillståndet efter (om)laddning är gammalt: spara bara, ingen feedback.
    const first = lastAt.current === 0;
    lastAt.current = ev?.at ?? -1;
    if (!ev || first) return;
    if (ev.kind === "finished") sfx.crown();
    if (ev.kind === "buzzed" && unitOf(state.teams, playerId) === ev.unit) { sfx.buzz(); haptic.buzz(); }
    if (ev.kind === "judged") {
      const answered = state.collect?.answered.includes(playerId);
      if (ev.correct.includes(playerId)) { sfx.correct(); haptic.correct(); }
      else { sfx.wrong(); if (answered) haptic.wrong(); }
    }
  }, [!!state, state?.lastEvent, playerId]);

  // Datorn: tangenterna A–H (eller 1–8) väljer alternativ
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if ((e.target as HTMLElement).tagName === "INPUT" || !st || st.phase !== "collect" || st.collect?.mode !== "choice") return;
      if (st.collect.answered.includes(playerId)) return;
      const k = e.key.toUpperCase();
      const i = /^[1-8]$/.test(k) ? +k - 1 : CHOICE_LETTERS.indexOf(k);
      const ch = st.question?.choices?.[i];
      if (ch && !st.myRemoved?.includes(ch)) { e.preventDefault(); rememberAnswer(st.code, st.qIndex, ch); send({ t: "answer", text: ch }); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [send, playerId]);

  if (error && !state) {
    return <main className="narrow stack"><p className="err">{error}</p><Link to="/">Tillbaka</Link></main>;
  }
  if (!state) return <main className="narrow"><p className="muted">Ansluter till {code}…</p></main>;

  if (!me) {
    return (
      <main className="narrow stack" style={{ paddingTop: 48 }}>
        <div className="row"><div style={{ width: 40 }}><Crown /></div><h2>{state.title}</h2></div>
        <form className="panel stack" onSubmit={(e) => {
          e.preventDefault(); sfx.unlock(); write(NAME_KEY, name.trim()); setJoining(true); send({ t: "join", name: name.trim() });
        }}>
          <label htmlFor="name">Ditt namn</label>
          <input id="name" value={name} maxLength={20} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Samma namn varje vecka" />
          {error && <p className="err">{error}</p>}
          <button className="btn primary big" disabled={!name.trim() || joining}>Hoppa in</button>
        </form>
      </main>
    );
  }

  const ev = state.lastEvent;
  const flash = ev?.kind === "judged" ? (ev.correct.includes(me.id) ? "flash-good" : state.collect?.answered.includes(me.id) ? "flash-bad" : "") : "";
  const skill = state.question?.mode === "skill";

  let status = "";
  if (state.phase === "lobby") status = "Väntar på att hosten startar…";
  else if (state.phase === "collect") {
    const c = state.collect;
    const mine = c?.turn === unitOf(state.teams, me.id);
    status = skill ? "Skill-utmaning!"
      : c?.format === "turn" ? (mine ? "Er tur!" : "Lyssna och vänta")
      : c?.format === "buzz" ? (c.turn ? (mine ? "Ni buzzade först!" : "Någon buzzade!") : "Buzzerfråga!")
      : "Välj rätt alternativ!";
  }
  else if (state.phase === "judge") status = "Tiden är ute";
  else if (state.phase === "reveal") status = "Svaret visas";

  return (
    <main className={`narrow stack ${flash}`} key={ev?.at} style={{ minHeight: "100dvh" }}>
      <div className="spread">
        <span className="chip" style={{ "--c": me.color } as React.CSSProperties}>
          <span className="dot">{me.name.slice(0, 2).toUpperCase()}</span>{me.name}<span className="pts">{me.score}</span>
        </span>
        <span className="muted small">{state.qIndex >= 0 && state.phase !== "finished" ? `Fråga ${state.qIndex + 1}/${state.qCount}` : code}</span>
      </div>

      {state.phase === "finished" ? (
        <div className="stack" style={{ textAlign: "center", paddingTop: 24 }}>
          <h2>Kvällen är slut</h2>
          {state.teams.length ? <TeamPodium state={state} /> : <Podium players={state.players} />}
        </div>
      ) : (
        <>
          <p className="display" style={{ fontSize: "1.5rem", textAlign: "center", minHeight: "2em" }} aria-live="polite">{status}</p>
          {state.phase !== "lobby" && <div style={{ textAlign: "center" }}><TwistBadge state={state} /></div>}
          <EffectTags state={state} />
          {state.question && state.phase !== "lobby" && (
            <p style={{ textAlign: "center", fontSize: "1.15rem" }}>{state.question.text}</p>
          )}
          {state.revealedAnswer && !skill && <p className="answer-reveal" style={{ textAlign: "center", fontSize: "1.6rem" }}>{state.revealedAnswer}</p>}
          <StealNote state={state} />
          {pendingWheel(state) && <div className="panel"><WheelPanel wheel={pendingWheel(state)!} serverNow={serverNow} size={140} compact /></div>}

          {state.collect && state.phase !== "lobby" && (
            <CollectPlay key={state.qIndex} state={withMyDeadline(state, me.id)} me={me} send={send} serverNow={serverNow} />
          )}
          <FiftyButton state={state} me={me} send={send} />
          {state.phase !== "lobby" && (
            <p className="muted small" style={{ textAlign: "center" }}>
              {skill ? "Skill-utmaning: bäst får 3 p, tvåa 2 p, trea 1 p."
                : state.collect?.format === "turn" ? "Lagens tur: rätt ger hela laget poäng, fel går bara vidare. På datorn funkar tangenterna A–H."
                : state.collect?.format === "buzz" ? `Buzzerfråga: rätt ger hela laget poäng, fel kostar ${state.settings.penalty} p och laget låses ute.`
                : `Rätt ger poäng och snabbaste rätt får +${state.settings.fastestBonus}. Fel kostar inget. På datorn funkar tangenterna A–H.`}
            </p>
          )}
        </>
      )}
      <CoinToast state={state} me={me} />
      {state.phase !== "finished" && (state.phase === "lobby" || state.phase === "reveal") && <PlayerShop state={state} me={me} send={send} />}
      {state.teams.length ? <TeamBoard state={state} highlight={me.id} compact /> : <Scorebar state={state} highlight={me.id} />}
      {!connected && <p className="err small">Tappade anslutningen, försöker igen…</p>}
    </main>
  );
}
