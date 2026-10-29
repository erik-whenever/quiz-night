// Vyer för insamlingsrundor ("Alla svarar"): TV, spelare och host.
// Samma byggstenar ska återanvändas av kommande rundtyper med hemliga svar.
import { useEffect, useState } from "react";
import type { ClientMsg, CollectResult, HostState, PlayerPublic } from "../shared/types";
import { COLLECT_MAX_LEN } from "../shared/types";
import { useCountdown } from "./lib/useRoom";
import { Countdown, initials } from "./components";

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
            <span className="txt">”{r.text}”</span>
            <span className="meta">
              {r.fastest && <span className="fastest">Snabbast</span>}
              <span className="time">{secs(r.ms)}</span>
              <span className="verdict">{r.correct ? `Rätt ${plus(r.delta)}` : "Fel"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** TV: nedräkning och vilka som svarat, sedan allas svar vid reveal. */
export function CollectTv({ state, serverNow }: { state: HostState; serverNow: () => number }) {
  const c = state.collect;
  if (!c) return null;
  if (state.phase === "reveal" && c.results) return <ResultList state={state} results={c.results} />;
  return (
    <div className="stack" style={{ alignItems: "center" }}>
      <div className="collect-banner">
        <span className="mode-tag">Alla svarar</span>
        {state.phase === "collect"
          ? <><span>Skriv ditt svar i mobilen</span><CollectClock state={state} serverNow={serverNow} size={90} /></>
          : <span>Hosten rättar…</span>}
      </div>
      <AnsweredGrid state={state} />
    </div>
  );
}

const draftKey = (code: string, q: number) => `kronan.svar.${code}.${q}`;
const readDraft = (k: string) => { try { return sessionStorage.getItem(k) ?? ""; } catch { return ""; } };
const writeDraft = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* */ } };

/** Spelare: textfält + "Lås svar" under insamlingen, sedan låst bekräftelse och till sist eget resultat. */
export function CollectPlay({ state, me, send, serverNow }: { state: HostState; me: PlayerPublic; send: Send; serverNow: () => number }) {
  const key = draftKey(state.code, state.qIndex);
  const [text, setText] = useState(() => readDraft(key));
  const [sentKey, setSentKey] = useState("");
  const c = state.collect;
  if (!c) return null;
  const locked = c.answered.includes(me.id);
  const pending = sentKey === key && !locked;
  const mine = c.results?.find((r) => r.playerId === me.id);

  if (state.phase === "collect" && !locked) {
    return (
      <form className="stack collect-form" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || pending) return;
        writeDraft(key, text.trim()); setSentKey(key); send({ t: "answer", text: text.trim() });
      }}>
        <div className="row" style={{ justifyContent: "center" }}><CollectClock state={state} serverNow={serverNow} size={110} /></div>
        <label htmlFor="collect-answer">Ditt svar</label>
        <input id="collect-answer" value={text} maxLength={COLLECT_MAX_LEN} autoFocus autoComplete="off" enterKeyHint="done"
          onChange={(e) => { setText(e.target.value); writeDraft(key, e.target.value); }} placeholder="Skriv här, ingen annan ser det" />
        <button className="btn primary big" disabled={!text.trim() || pending}>{pending ? "Låser…" : "Lås svar"}</button>
      </form>
    );
  }

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
          <p className="display big-verdict"><span aria-hidden>🔒</span> Ditt svar är låst</p>
          {draft && <p className="locked-text">”{draft}”</p>}
          <p className="muted">{state.phase === "collect"
            ? `${c.answered.length} av ${state.players.length} har svarat`
            : "Hosten rättar…"}</p>
        </>
      ) : <p className="display big-verdict">Tiden är ute</p>}
    </div>
  );
}

/** Host: alla svar i inlämningsordning, bocka för rätt, bekräfta. */
export function CollectHost({ state, send, serverNow }: { state: HostState; send: Send; serverNow: () => number }) {
  const c = state.collect;
  const h = state.collectHost;
  // Bocken slår om direkt; serverns nästa state är facit och nollställer de lokala ändringarna.
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const serverMarks = h?.correct.join(",");
  useEffect(() => setLocal({}), [serverMarks]);
  if (!c || !h) return null;
  const judging = state.phase === "collect" || state.phase === "judge";
  const missing = state.players.filter((p) => !h.answers.some((a) => a.playerId === p.id));
  const right = new Set(h.answers.map((a) => a.playerId).filter((id) => local[id] ?? h.correct.includes(id)));
  const firstRight = h.answers.find((a) => right.has(a.playerId))?.playerId;

  if (!judging) {
    return c.results ? <ResultList state={state} results={c.results} /> : null;
  }
  return (
    <div className="stack">
      <div className="row">
        <CollectClock state={state} serverNow={serverNow} size={72} />
        <p className="muted" aria-live="polite">
          {state.phase === "collect" ? `Alla svarar: ${h.answers.length} av ${state.players.length} har låst sitt svar.` : "Insamlingen är stängd. Bocka för rätt svar."}
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
      <div className="row">
        {state.phase === "collect" && <button className="btn ghost" onClick={() => send({ t: "host:close" })}>Stäng insamlingen</button>}
        <button className="btn primary big" onClick={() => send({ t: "host:judge" })}>Bekräfta och visa svaren</button>
      </div>
    </div>
  );
}
