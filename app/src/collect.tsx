// Vyer för frågorna (svarsalternativ och skill-utmaningar): TV, spelare och host.
// Samma byggstenar ska återanvändas av kommande rundtyper med hemliga svar.
import { useEffect, useState } from "react";
import type { ClientMsg, CollectResult, HostState, PlayerPublic } from "../shared/types";
import { CHOICE_LETTERS } from "../shared/types";
import { useCountdown } from "./lib/useRoom";
import { Countdown, initials } from "./components";
import { OrderReveal, SkillHost, SkillPlay, SkillTv } from "./skill";
import { SKILLS } from "../shared/skill";
import { unitOf } from "../shared/teams";
import { sfx } from "./lib/sound";

type Send = (m: ClientMsg) => void;
const secs = (ms: number) => (ms / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " s";
const byId = (players: PlayerPublic[], id: string) => players.find((p) => p.id === id);
const plus = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Nedräkningen för insamlingen (servern äger deadline). */
function CollectClock({ state, serverNow, size }: { state: HostState; serverNow: () => number; size: number }) {
  const c = state.collect;
  const left = useCountdown(state.phase === "collect" ? c?.deadline : undefined, serverNow);
  if (!c || state.phase !== "collect") return null;
  return <Countdown ms={left} total={c.deadline - c.startedAt} size={size} />;
}

/** Vilka har lämnat svar. Visar aldrig vad de svarat. */
function AnsweredGrid({ state }: { state: HostState }) {
  const answered = new Set(state.collect?.answered ?? []);
  return (
    <ul className="answered-grid" aria-label="Vilka har svarat">
      {state.players.map((p) => {
        const done = answered.has(p.id);
        return (
          <li key={p.id} className={`answered${done ? " done" : ""}`} style={{ "--c": p.color } as React.CSSProperties}>
            <span className="dot">{initials(p.name)}</span>
            <span>{p.name}</span>
            <span className="state">{done ? "Låst" : "Tänker…"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ResultList({ state, results, highlight }: { state: HostState; results: CollectResult[]; highlight?: string }) {
  if (!results.length) return <p className="qmeta">Ingen hann svara.</p>;
  return (
    <ol className="collect-results" aria-label="Allas svar">
      {results.map((r, i) => {
        const p = byId(state.players, r.playerId);
        return (
          <li key={r.playerId} className={`${r.correct ? "right" : "wrong"}${highlight === r.playerId ? " me" : ""}`}
            style={{ "--c": p?.color ?? "var(--mist)", animationDelay: `${i * 120}ms` } as React.CSSProperties}>
            <span className="who">{p?.name ?? "Okänd"}</span>
            <span className="txt">{r.place !== undefined ? r.text : `”${r.text}”`}</span>
            <span className="meta">
              {r.fastest && r.place === undefined && <span className="fastest">Snabbast</span>}
              {r.place === undefined && <span className="time">{secs(r.ms)}</span>}
              <span className="verdict">{r.place !== undefined
                ? (r.place > 0 ? `${r.place}:a ${r.delta ? plus(r.delta) : ""}`.trim() : "Diskad")
                : r.correct ? `Rätt ${plus(r.delta)}` : "Fel"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Svarsalternativen som rutnät. På TV:n syns de under hela frågan, men rätt alternativ markeras
 * först när state.revealedAnswer finns (dvs. vid reveal). picks = hur många som valde varje alternativ.
 */
export function ChoiceGrid({ state, picks }: { state: HostState; picks?: Record<string, number> }) {
  const choices = state.question?.choices ?? [];
  const right = state.revealedAnswer;
  return (
    <ol className="choice-grid" aria-label="Svarsalternativ">
      {choices.map((ch, i) => (
        <li key={ch} className={`choice-tile${right ? (ch === right ? " right" : " dim") : state.collect?.tried?.includes(ch) ? " tried" : ""}`} data-letter={CHOICE_LETTERS[i]}>
          <span className="letter">{CHOICE_LETTERS[i]}</span>
          <span className="txt">{ch}</span>
          {picks && <span className="picks">{picks[ch] ?? 0}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Namn och färg för en enhet (lag eller spelare). */
export function unitInfo(state: HostState, unit?: string) {
  const t = state.teams.find((x) => x.id === unit);
  if (t) return { name: t.name, color: t.color };
  const p = state.players.find((x) => x.id === unit);
  return { name: p?.name ?? "?", color: p?.color ?? "var(--mist)" };
}

/** Banner för lagens tur och buzzer (TV och host). */
export function FormatBanner({ state, serverNow, size = 90 }: { state: HostState; serverNow: () => number; size?: number }) {
  const c = state.collect;
  const answerLeft = useCountdown(state.phase === "collect" && c?.turn && c.answerDeadline ? c.answerDeadline : undefined, serverNow);
  if (!c || c.mode !== "choice" || state.phase !== "collect" || c.format === "all") return null;
  const who = unitInfo(state, c.turn);
  if (c.format === "turn") {
    return (
      <div className="collect-banner turn-banner" style={{ "--c": who.color } as React.CSSProperties}>
        <span className="mode-tag">Lagens tur</span><span><strong style={{ color: who.color }}>{who.name}</strong> har turen</span>
        <CollectClock state={state} serverNow={serverNow} size={size} />
      </div>
    );
  }
  if (c.turn) {
    return (
      <div className="collect-banner turn-banner buzzed" style={{ "--c": who.color } as React.CSSProperties}>
        <span className="mode-tag">Buzz!</span><span><strong style={{ color: who.color }}>{who.name}</strong> svarar</span>
        <Countdown ms={answerLeft} total={state.settings.buzzAnswerSeconds * 1000} size={size} />
      </div>
    );
  }
  return (
    <div className="collect-banner buzz-open">
      <span className="mode-tag">Buzzerfråga</span><span>Först att buzza får svara. Fel kostar {state.settings.penalty} p.</span>
      <CollectClock state={state} serverNow={serverNow} size={size} />
    </div>
  );
}

const countPicks = (results: CollectResult[]) =>
  results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.text]: (m[r.text] ?? 0) + 1 }), {});

/** TV: nedräkning och vilka som svarat, sedan allas svar vid reveal. */
export function CollectTv({ state, serverNow }: { state: HostState; serverNow: () => number }) {
  const c = state.collect;
  if (!c) return null;
  if (c.mode === "skill") {
    if (state.phase === "reveal" && c.results) {
      return <div className="stack" style={{ alignItems: "center", width: "100%" }}><OrderReveal state={state} /><ResultList state={state} results={c.results} /></div>;
    }
    return <SkillTv state={state} serverNow={serverNow} />;
  }
  if (state.phase === "reveal" && c.results) {
    return (
      <div className="stack" style={{ alignItems: "center", width: "100%" }}>
        <ChoiceGrid state={state} picks={countPicks(c.results)} />
        <ResultList state={state} results={c.results} />
      </div>
    );
  }
  return (
    <div className="stack" style={{ alignItems: "center", width: "100%" }}>
      <ChoiceGrid state={state} />
      {c.format !== "all" && state.phase === "collect" ? <FormatBanner state={state} serverNow={serverNow} /> : (
        <div className="collect-banner">
          {state.phase === "collect"
            ? <><span>Välj i mobilen</span><CollectClock state={state} serverNow={serverNow} size={90} /></>
            : <span>Tiden är ute</span>}
        </div>
      )}
      {c.format === "all" && <AnsweredGrid state={state} />}
    </div>
  );
}

const draftKey = (code: string, q: number) => `kronan.svar.${code}.${q}`;
const readDraft = (k: string) => { try { return sessionStorage.getItem(k) ?? ""; } catch { return ""; } };
const writeDraft = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* */ } };
/** Kom ihåg mitt val (visas som "låst" även efter omladdning), t.ex. när det valdes med tangentbordet. */
export const rememberAnswer = (code: string, q: number, text: string) => writeDraft(draftKey(code, q), text);

const shadowKey = (code: string, q: number) => `kronan.skugga.${code}.${q}`;

/** Medlemmarna i en enhet (lag eller spelare). */
function unitMembers(state: HostState, unit?: string) {
  const t = state.teams.find((x) => x.id === unit);
  return t ? state.players.filter((p) => t.members.includes(p.id)) : state.players.filter((p) => p.id === unit);
}

/**
 * Åskådarkortet när ett annat lag har turen (eller har buzzat): lagets färg, medlemmarna med en pratande
 * ljudvåg, stor nedräkning och alternativen. Ett tryck på ett alternativ är ett hemligt skuggtips som bara
 * den här telefonen ser och som avslöjas vid facit ("Du hade också rätt").
 */
function Spectator({ state, serverNow, title, sub, deadline, total }: {
  state: HostState; serverNow: () => number; title: React.ReactNode; sub: string; deadline?: number; total: number;
}) {
  const c = state.collect!;
  const who = unitInfo(state, c.turn);
  const members = unitMembers(state, c.turn);
  const left = useCountdown(deadline, serverNow);
  const key = shadowKey(state.code, state.qIndex);
  const [shadow, setShadow] = useState(() => readDraft(key));
  const choices = state.question?.choices ?? [];
  return (
    <div className="spectator" style={{ "--c": who.color } as React.CSSProperties} role="status">
      <div className="spectator-head">
        <div>
          <p className="spectator-title">{title}</p>
          <p className="muted small">{sub}</p>
        </div>
        {deadline ? <Countdown ms={left} total={total} size={84} /> : null}
      </div>
      {members.length > 0 && (
        <ul className="spectator-members" aria-label="Svarar nu">
          {members.map((p) => (
            <li key={p.id} style={{ "--p": p.color } as React.CSSProperties}>
              <span className="dot">{initials(p.name)}</span><span className="name">{p.name}</span>
              <span className="talk" aria-hidden="true"><i /><i /><i /><i /><i /></span>
            </li>
          ))}
        </ul>
      )}
      {choices.length > 0 && (
        <>
          <p className="muted small spectator-hint">{shadow ? "Ditt skuggtips är sparat, bara du ser det." : "Vad skulle du svarat? Tryck för ett hemligt skuggtips."}</p>
          <div className={`shadow-grid${choices.length > 4 ? " many" : ""}`} role="group" aria-label="Skuggtips">
            {choices.map((ch, i) => (
              <button key={ch} className={`shadow-btn${shadow === ch ? " on" : ""}${c.tried?.includes(ch) ? " gone" : ""}`}
                aria-pressed={shadow === ch} disabled={c.tried?.includes(ch)}
                onClick={() => { const v = shadow === ch ? "" : ch; setShadow(v); writeDraft(key, v); }}>
                <span className="letter">{CHOICE_LETTERS[i]}</span><span className="txt">{ch}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Facit för lagens tur och buzzer: lagets resultat i stället för "Du hann inte svara", plus ditt skuggtips. */
function TeamReveal({ state, me }: { state: HostState; me: PlayerPublic }) {
  const c = state.collect!;
  const res = c.results ?? [];
  const myUnit = unitOf(state.teams, me.id);
  const unitOfR = (pid: string) => unitOf(state.teams, pid);
  const winner = res.find((r) => r.correct);
  const mineWrong = res.filter((r) => !r.correct && unitOfR(r.playerId) === myUnit);
  const shadow = readDraft(shadowKey(state.code, state.qIndex));
  const right = state.revealedAnswer;
  const pts = winner ? (winner.delta || state.question?.points || 1) : 0;
  let verdict: React.ReactNode; let cls = "";
  if (winner && unitOfR(winner.playerId) === myUnit) { verdict = `Rätt! +${pts} p ${state.teams.length ? "till hela laget" : ""}`; cls = "right"; }
  else if (mineWrong.length) {
    verdict = c.format === "buzz" ? `Fel, −${state.settings.penalty} p` : "Fel den här gången";
    cls = "wrong";
  } else if (winner) {
    const w = unitInfo(state, unitOfR(winner.playerId));
    verdict = <><span style={{ color: w.color }}>{w.name}</span> tog den</>;
  } else if (c.format === "turn" && !res.length) {
    const t = unitInfo(state, c.turn);
    verdict = c.turn === myUnit ? `${state.teams.length ? "Ni" : "Du"} hann inte svara` : <><span style={{ color: t.color }}>{t.name}</span> hann inte svara</>;
  } else if (c.format === "turn") {
    const t = unitInfo(state, c.turn);
    verdict = <><span style={{ color: t.color }}>{t.name}</span> svarade fel</>;
  } else {
    verdict = "Ingen tog den";
  }
  const answered = res.map((r) => ({ r, u: unitInfo(state, unitOfR(r.playerId)) }));
  return (
    <div className={`locked-card ${cls}`} role="status">
      <p className="display big-verdict">{verdict}</p>
      {answered.length > 0 && <p className="muted">{answered.map(({ r, u }, i) => (
        <span key={i}>{i ? " · " : ""}<span style={{ color: u.color }}>{u.name}</span> svarade ”{r.text}”</span>
      ))}</p>}
      {shadow && unitOf(state.teams, me.id) !== c.turn && !answered.some(({ r }) => unitOfR(r.playerId) === myUnit) && (
        <p className="shadow-result">{shadow === right ? "Ditt skuggtips var rätt 😎" : `Ditt skuggtips: ”${shadow}”, inte rätt den här gången`}</p>
      )}
    </div>
  );
}

/** Spelare: alternativknappar (ett tryck låser), sedan låst bekräftelse och till sist eget resultat. */
export function CollectPlay({ state, me, send, serverNow }: { state: HostState; me: PlayerPublic; send: Send; serverNow: () => number }) {
  const key = draftKey(state.code, state.qIndex);
  const [sentKey, setSentKey] = useState("");
  const c = state.collect;
  if (!c) return null;
  if (c.mode === "skill") return <SkillPlay state={state} me={me} send={send} serverNow={serverNow} />;
  const locked = c.answered.includes(me.id);
  const pending = sentKey === key && !locked;
  const mine = c.results?.find((r) => r.playerId === me.id);
  const removed = new Set([...(state.myRemoved ?? []), ...(c.tried ?? [])]);
  const myUnit = unitOf(state.teams, me.id);
  const who = unitInfo(state, c.turn);
  const teamWord = state.teams.length ? "Ert lag" : "Du";

  if (state.phase === "collect" && c.format === "turn" && c.turn !== myUnit) {
    return <Spectator state={state} serverNow={serverNow}
      title={<><span style={{ color: who.color }}>{who.name}</span> har turen</>}
      sub="Lyssna på dem i Discord. Nästa fråga kan vara er." deadline={c.deadline} total={c.deadline - c.startedAt} />;
  }
  if (state.phase === "collect" && c.format === "buzz" && c.turn !== myUnit) {
    const lockedOut = c.lockedOut?.includes(myUnit);
    if (c.buzzOpen && !lockedOut) {
      return (
        <div className="buzzer-zone">
          <CollectClock state={state} serverNow={serverNow} size={80} />
          <div className="buzzer-ring"><button className="buzzer" aria-label="Buzza"
            onPointerDown={(e) => { e.preventDefault(); sfx.unlock(); send({ t: "buzz" }); }}
            onKeyDown={(e) => { if (e.key === "Enter") send({ t: "buzz" }); }}>BUZZ</button></div>
          <p className="muted small">Först att buzza får svara. Fel svar kostar {state.settings.penalty} p.</p>
        </div>
      );
    }
    if (lockedOut && !c.turn) {
      return <Spectator state={state} serverNow={serverNow} title={`${teamWord} är utlåst`}
        sub="Hoppas att ingen annan heller vet…" deadline={c.deadline} total={c.deadline - c.startedAt} />;
    }
    return <Spectator state={state} serverNow={serverNow}
      title={<><span style={{ color: who.color }}>{who.name}</span> buzzade!</>}
      sub={lockedOut ? `${teamWord} är utlåst på den här frågan.` : "Svarar de fel kan ni buzza igen."}
      deadline={c.answerDeadline} total={state.settings.buzzAnswerSeconds * 1000} />;
  }

  if (state.phase === "collect" && !locked) {
    const choices = state.question?.choices ?? [];
    return (
      <div className="stack collect-form">
        <div className="row" style={{ justifyContent: "center" }}><CollectClock state={state} serverNow={serverNow} size={110} /></div>
        <p className="muted small" style={{ textAlign: "center" }}>
          {c.format === "turn" ? `${teamWord} har turen! Snacka ihop er, ett tryck låser svaret för hela laget.`
            : c.format === "buzz" ? `${teamWord} buzzade först! Välj snabbt, fel kostar ${state.settings.penalty} p.` : "Ett tryck låser ditt val."}
        </p>
        <div className={`choice-buttons${choices.length > 4 ? " many" : ""}`} role="group" aria-label="Välj svar">
          {choices.map((ch, i) => (
            <button key={ch} className={`choice-btn${removed.has(ch) ? " gone" : ""}`} disabled={pending || removed.has(ch)} data-letter={CHOICE_LETTERS[i]}
              onClick={() => { if (pending) return; sfx.lock(); writeDraft(key, ch); setSentKey(key); send({ t: "answer", text: ch }); }}>
              <span className="letter">{CHOICE_LETTERS[i]}</span><span className="txt">{ch}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (state.phase === "reveal" && c.results && c.format !== "all") return <TeamReveal state={state} me={me} />;
  if (state.phase === "reveal" && c.results) {
    return (
      <div className={`locked-card ${mine ? (mine.correct ? "right" : "wrong") : ""}`} role="status">
        {mine ? (
          <>
            <p className="display big-verdict">{mine.correct ? `Rätt! ${plus(mine.delta)} p` : "Fel den här gången"}</p>
            {mine.fastest && <p>Du var snabbast och fick bonus.</p>}
            <p className="muted">Du svarade ”{mine.text}” på {secs(mine.ms)}</p>
          </>
        ) : <p className="display big-verdict">Du hann inte svara</p>}
      </div>
    );
  }

  const draft = readDraft(key);
  return (
    <div className="locked-card" role="status">
      {locked ? (
        <>
          <p className="display big-verdict"><span aria-hidden>🔒</span> Ditt val är låst</p>
          {draft && <p className="locked-text">”{draft}”</p>}
          <p className="muted">{state.phase === "collect" ? `${c.answered.length} av ${state.players.length} har svarat` : "Väntar på att svaret visas…"}</p>
        </>
      ) : <p className="display big-verdict">Tiden är ute</p>}
    </div>
  );
}

/** Spelande värd: bara hur många som svarat och nedräkningen, aldrig facit eller vad någon valt. */
function HostProgress({ state, send, serverNow }: { state: HostState; send: Send; serverNow: () => number }) {
  const c = state.collect!;
  const skill = c.mode === "skill" && state.question?.skill ? SKILLS[state.question.skill.kind].name : null;
  return (
    <div className="stack">
      <div className="row">
        <CollectClock state={state} serverNow={serverNow} size={72} />
        <p className="muted" aria-live="polite">
          {skill ? `${skill}: ` : ""}{c.answered.length} av {state.players.length} {skill ? "klara" : "har svarat"}.
          {state.phase === "judge" ? " Tiden är ute." : ""}
        </p>
      </div>
      {c.format === "all" ? <AnsweredGrid state={state} /> : <FormatBanner state={state} serverNow={serverNow} size={64} />}
      <p className="muted small">Du spelar själv, så du ser inte facit. Rättningen sker automatiskt.</p>
      <button className="btn primary big" onClick={() => send({ t: "host:judge" })}>{skill ? "Visa resultaten (V)" : "Visa svaret (V)"}</button>
    </div>
  );
}

/** Host: spelande värd ser bara framstegen. Annars alla svar i inlämningsordning, med möjlighet att ändra rättningen. */
export function CollectHost({ state, send, serverNow }: { state: HostState; send: Send; serverNow: () => number }) {
  const c = state.collect;
  const h = state.collectHost;
  // Bocken slår om direkt; serverns nästa state är facit och nollställer de lokala ändringarna.
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const serverMarks = h?.correct.join(",");
  useEffect(() => setLocal({}), [serverMarks]);
  if (!c) return null;
  const judging = state.phase === "collect" || state.phase === "judge";
  if (!judging) return c.results ? <ResultList state={state} results={c.results} /> : null;
  if (state.settings.hostPlays || !h) return <HostProgress state={state} send={send} serverNow={serverNow} />;
  if (c.mode === "skill") return <SkillHost state={state} send={send} />;
  const missing = state.players.filter((p) => !h.answers.some((a) => a.playerId === p.id));
  const right = new Set(h.answers.map((a) => a.playerId).filter((id) => local[id] ?? h.correct.includes(id)));
  const firstRight = h.answers.find((a) => right.has(a.playerId))?.playerId;
  return (
    <div className="stack">
      <div className="row">
        <CollectClock state={state} serverNow={serverNow} size={72} />
        <p className="muted" aria-live="polite">
          {state.phase === "collect" ? `${h.answers.length} av ${state.players.length} har svarat.` : "Tiden är ute. Rätt alternativ är förbockat, ändra om du vill."}
        </p>
      </div>
      {h.answers.length === 0 ? <p className="muted">Inga svar än.</p> : (
        <ul className="mark-list" aria-label="Inlämnade svar">
          {h.answers.map((a, i) => {
            const p = byId(state.players, a.playerId);
            const ok = right.has(a.playerId);
            return (
              <li key={a.playerId}>
                <label className={`mark${ok ? " on" : ""}`}>
                  <input type="checkbox" checked={ok} aria-label={`${p?.name ?? "Okänd"} svarade rätt`}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setLocal((l) => ({ ...l, [a.playerId]: on }));
                      send({ t: "host:mark", playerId: a.playerId, correct: on });
                    }} />
                  <span className="n">{i + 1}</span>
                  <span className="who" style={{ color: p?.color }}>{p?.name ?? "Okänd"}</span>
                  <span className="txt">”{a.text}”</span>
                  <span className="time">{secs(a.ms)}{firstRight === a.playerId && <span className="fastest">Bonus</span>}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && <p className="muted small">Inget svar från: {missing.map((p) => p.name).join(", ")}</p>}
      <p className="muted small">
        Rätt ger {state.question?.points ?? 1} p, snabbaste rätt får +{state.settings.fastestBonus} i bonus. Fel kostar inget.
      </p>
      <button className="btn primary big" onClick={() => send({ t: "host:judge" })}>Visa svaret (V)</button>
    </div>
  );
}
