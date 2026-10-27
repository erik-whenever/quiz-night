import { useEffect, useRef, useState } from "react";
import { Crown, Link } from "../App";
import { useCountdown, useRoom } from "../lib/useRoom";
import { sfx } from "../lib/sound";
import { Countdown, Podium, Scorebar } from "../components";

const idKey = (code: string) => "kronan.player." + code;
const NAME_KEY = "kronan.name";
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

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
  const myBuzz = state?.buzz?.playerId === playerId;
  const left = useCountdown(state?.buzz?.deadline, serverNow);
  const [typed, setTyped] = useState("");

  // Ljud på händelser
  const lastAt = useRef(0);
  useEffect(() => {
    const ev = state?.lastEvent;
    if (!ev || ev.at === lastAt.current) return;
    lastAt.current = ev.at;
    if (ev.kind === "buzz") sfx.buzz();
    if (ev.kind === "correct") sfx.correct();
    if (ev.kind === "wrong" || ev.kind === "timeout") sfx.wrong();
    if (ev.kind === "finished") sfx.crown();
    if (ev.kind !== "buzz") setTyped("");
  }, [state?.lastEvent]);

  // Mellanslag = buzz på dator
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.code === "Space" && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); send({ t: "buzz" }); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [send]);

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
          <input id="name" value={name} maxLength={20} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Smeknamn duger" />
          {error && <p className="err">{error}</p>}
          <button className="btn primary big" disabled={!name.trim() || joining}>Hoppa in</button>
        </form>
      </main>
    );
  }

  const locked = state.lockedOut.includes(me.id);
  const canBuzz = state.phase === "question" && !locked;
  const ev = state.lastEvent;
  const flash = ev && "playerId" in ev && ev.playerId === me.id
    ? (ev.kind === "correct" ? "flash-good" : ev.kind === "wrong" || ev.kind === "timeout" ? "flash-bad" : "") : "";

  let status = "";
  if (state.phase === "lobby") status = "Väntar på att hosten startar…";
  else if (state.phase === "question") status = locked ? "Du är utlåst på den här frågan" : "Buzza om du kan svaret!";
  else if (state.phase === "buzzed") {
    const who = state.players.find((p) => p.id === state.buzz?.playerId);
    status = myBuzz ? "Svara nu, säg det i Discord!" : `${who?.name ?? "Någon"} svarar…`;
  } else if (state.phase === "reveal") status = "Svaret visas";

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
          <Podium players={state.players} />
        </div>
      ) : (
        <>
          <p className="display" style={{ fontSize: "1.5rem", textAlign: "center", minHeight: "2em" }} aria-live="polite">{status}</p>
          {state.question && state.phase !== "lobby" && (
            <p style={{ textAlign: "center", fontSize: "1.15rem" }}>{state.question.text}</p>
          )}
          {state.revealedAnswer && <p className="answer-reveal" style={{ textAlign: "center", fontSize: "1.6rem" }}>{state.revealedAnswer}</p>}

          {myBuzz ? (
            <div className="stack" style={{ alignItems: "center" }}>
              <Countdown ms={left} total={state.settings.answerSeconds * 1000} size={160} />
              <input placeholder="…eller skriv svaret här" value={typed} maxLength={120} autoFocus
                onChange={(e) => { setTyped(e.target.value); send({ t: "type", text: e.target.value }); }} />
            </div>
          ) : (
            <div className="buzzer-zone">
              <div className="buzzer-ring"><button className="buzzer" disabled={!canBuzz} onPointerDown={(e) => { e.preventDefault(); sfx.unlock(); send({ t: "buzz" }); }}
                onKeyDown={(e) => { if (e.key === "Enter") send({ t: "buzz" }); }} aria-label="Buzza">
                BUZZ
              </button></div>
            </div>
          )}
          <p className="muted small" style={{ textAlign: "center" }}>
            Rätt ger poäng. Fel eller för långsam kostar {state.settings.penalty} p. Mellanslag funkar också.
          </p>
        </>
      )}
      <Scorebar state={state} highlight={me.id} />
      {!connected && <p className="err small">Tappade anslutningen, försöker igen…</p>}
    </main>
  );
}
