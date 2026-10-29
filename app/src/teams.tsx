// Lag, mynt och butik i gränssnittet: lagtavla (TV/spelare), hostens lagval, spelarens butik och varor.
import { useEffect, useState } from "react";
import type { ClientMsg, HostState, PlayerPublic, TeamMode } from "../shared/types";
import { SHOP, SHOP_ITEMS, TOKEN_ITEMS, teamStandings, unitOf } from "../shared/teams";
import { initials } from "./components";

type Send = (m: ClientMsg) => void;

/** Lagens ställning (snitt) med medlemmarnas egna poäng. */
export function TeamBoard({ state, highlight, compact }: { state: HostState; highlight?: string; compact?: boolean }) {
  const rows = teamStandings(state.teams, state.players);
  if (!rows.length) return null;
  return (
    <ol className={`team-board${compact ? " compact" : ""}`} aria-label="Lagställning">
      {rows.map(({ team, members, score }) => (
        <li key={team.id} className={`team-row${highlight && team.members.includes(highlight) ? " mine" : ""}`} style={{ "--c": team.color } as React.CSSProperties}>
          <span className="team-name">{team.name}</span>
          <span className="team-members">
            {members.map((m) => (
              <span key={m.id} className={`mini${m.connected ? "" : " off"}${state.collect?.answered.includes(m.id) && state.phase === "collect" ? " active" : ""}`} style={{ "--p": m.color } as React.CSSProperties}>
                <span className="dot">{initials(m.name)}</span>{m.name} <b className="bump" key={m.score}>{m.score}</b>
              </span>
            ))}
          </span>
          <span className="team-score bump" key={score} aria-label="Lagets snitt">{score.toLocaleString("sv-SE")}</span>
        </li>
      ))}
    </ol>
  );
}

/** Pall för lag: lagnamn och snitt, kronan till vinnarlaget. */
export function TeamPodium({ state }: { state: HostState }) {
  const top = teamStandings(state.teams, state.players).slice(0, 3);
  const order = [top[1], top[0], top[2]];
  const cls = ["p2", "p1", "p3"];
  return (
    <div className="podium">
      {order.map((x, i) => x ? (
        <div key={x.team.id} className={`step ${cls[i]}`}>
          {i === 1 && <div style={{ fontSize: "2.4rem" }} aria-hidden>👑</div>}
          <div className="name">{x.team.name}</div>
          <div className="small">{x.members.map((m) => m.name).join(" & ")}</div>
          <div className="score">{x.score.toLocaleString("sv-SE")} p</div>
        </div>
      ) : <div key={i} />)}
    </div>
  );
}

/** Butikseffekter som gäller frågan, som korta etiketter (TV och spelare). */
export function EffectTags({ state }: { state: HostState }) {
  const e = state.effects;
  if (!e) return null;
  const label = (u: string) => state.teams.find((t) => t.id === u)?.name ?? state.players.find((p) => p.id === u)?.name ?? "?";
  const tags = [
    ...e.double.map((u) => ({ k: "double", t: `Dubbla poäng: ${label(u)}` })),
    ...e.sabotage.map((u) => ({ k: "sabotage", t: `Saboterade: ${label(u)}` })),
    ...e.extra.map((u) => ({ k: "extra", t: `Extra tid: ${label(u)}` })),
  ];
  if (!tags.length) return null;
  const next = state.phase === "lobby" || state.phase === "reveal";
  return (
    <div className="effect-tags" aria-label={next ? "Butikseffekter nästa fråga" : "Butikseffekter"}>
      {next && (e.double.length || e.sabotage.length) ? <span className="muted small">Nästa fråga:</span> : null}
      {tags.map((x, i) => <span key={i} className={`effect-tag ${x.k}`}>{x.t}</span>)}
    </div>
  );
}

/** Hosten: lagläge och slumpa lag (i lobbyn). */
export function HostTeams({ state, send }: { state: HostState; send: Send }) {
  const [mode, setMode] = useState<TeamMode>(state.teamMode);
  useEffect(() => setMode(state.teamMode), [state.teamMode]);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: "0 0 auto" }}>Lag i kväll
          <select aria-label="Lagläge" value={mode} onChange={(e) => setMode(+e.target.value as TeamMode)}>
            <option value={0}>Alla mot alla</option>
            <option value={2}>Lag om 2</option>
            <option value={3}>Lag om 3</option>
          </select>
        </label>
        <button className="btn" onClick={() => send({ t: "host:teams", mode })} disabled={mode !== 0 && state.players.length < 2}>
          {mode === 0 ? "Kör alla mot alla" : state.teams.length ? "Slumpa om lagen" : "Slumpa lag"}
        </button>
      </div>
      {state.teams.length > 0 && <TeamBoard state={state} compact />}
      {mode !== 0 && <p className="muted small">Var och en samlar egna poäng, men kvällens resultat blir lagets snitt. Nya lag nästa gång.</p>}
    </div>
  );
}

/** Spelaren: plånbok, butik (lobbyn), aktivera varor (mellan frågorna), pass (när man har ordet). */
export function PlayerShop({ state, me, send }: { state: HostState; me: PlayerPublic; send: Send }) {
  const w = state.wallets?.[me.id];
  const [target, setTarget] = useState("");
  if (!w) return null;
  const tonight = state.coinsTonight?.[me.id] ?? 0;
  const own = unitOf(state.teams, me.id);
  const between = state.phase === "lobby" || state.phase === "reveal";
  const hasNext = state.effects.forQ < state.qCount;
  const units = state.teams.length
    ? state.teams.filter((t) => t.id !== own).map((t) => ({ id: t.id, name: t.name }))
    : state.players.filter((p) => p.id !== me.id).map((p) => ({ id: p.id, name: p.name }));
  const myTeam = state.teams.find((t) => t.id === own);
  const extraOn = state.effects.extra.includes(own);
  const doubleOn = state.effects.double.includes(own);

  return (
    <section className="panel stack shop" aria-label="Butik" style={{ gap: 10 }}>
      <div className="spread">
        <strong>Butik</strong>
        <span className="coins" aria-label="Mynt">🪙 {w.coins}{tonight > 0 && <span className="muted small"> (+{tonight} i kväll)</span>}</span>
      </div>
      {myTeam && <p className="small">Du är i <strong style={{ color: myTeam.color }}>{myTeam.name}</strong>
        {myTeam.members.length > 1 && <> med {myTeam.members.filter((id) => id !== me.id).map((id) => state.players.find((p) => p.id === id)?.name).join(" & ")}</>}.</p>}

      {state.phase === "lobby" && (
        <ul className="shop-list">
          {SHOP_ITEMS.map((item) => {
            const it = SHOP[item];
            const blocked = (item === "veto" && !state.teams.length) || (item === "extra" && extraOn);
            return (
              <li key={item}>
                <div><strong>{it.name}</strong> <span className="muted small">{it.info}</span></div>
                <button className="btn sm" disabled={w.coins < it.price || blocked} onClick={() => send({ t: "buy", item })}
                  aria-label={`Köp ${it.name} för ${it.price} mynt`}>🪙 {it.price}</button>
              </li>
            );
          })}
        </ul>
      )}

      {TOKEN_ITEMS.some((t) => w.items[t]) && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted small">Dina varor: {TOKEN_ITEMS.filter((t) => w.items[t]).map((t) => `${SHOP[t].name} ×${w.items[t]}`).join(", ")}</p>
          {between && hasNext && (
            <div className="row">
              {!!w.items.double && (
                <button className="btn sm" disabled={doubleOn} onClick={() => send({ t: "use", item: "double" })}>
                  {doubleOn ? "Dubbla poäng aktiverat" : "Dubbla poäng nästa fråga"}
                </button>
              )}
              {!!w.items.sabotage && units.length > 0 && (
                <span className="row" style={{ gap: 6 }}>
                  <select aria-label="Sabotera vem" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: "auto" }}>
                    <option value="">Sabotera…</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <button className="btn sm" disabled={!target} onClick={() => { send({ t: "use", item: "sabotage", target }); setTarget(""); }}>Sabotera</button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 50/50 under en alternativfråga: hälften av felalternativen försvinner för mig. */
export function FiftyButton({ state, me, send }: { state: HostState; me: PlayerPublic; send: Send }) {
  const n = state.wallets?.[me.id]?.items.fifty ?? 0;
  const c = state.collect;
  if (!n || state.phase !== "collect" || c?.mode !== "choice" || c.answered.includes(me.id) || state.myRemoved?.length) return null;
  if (c.format !== "all" && c.turn !== unitOf(state.teams, me.id)) return null;
  if ((state.question?.choices?.length ?? 0) < 3) return null;
  return <button className="btn ghost" onClick={() => send({ t: "use", item: "fifty" })}>Använd 50/50 ({n} kvar)</button>;
}

/** Senast visade mynthändelse. Modulnivå: spelarvyn byter nyckel vid varje händelse (blinkeffekten), så komponenten monteras om. */
let toastSeen: number | null = null;

/** Kort notis när man tjänat mynt (inte för gamla händelser vid omladdning). */
export function CoinToast({ state, me }: { state: HostState; me: PlayerPublic }) {
  const last = [...(state.coinLog ?? [])].reverse().find((x) => x.playerId === me.id);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (toastSeen === null) { toastSeen = last?.at ?? 0; return; }
    if (!last || last.at <= toastSeen) return;
    toastSeen = last.at;
    setShown(last.at);
  }, [last?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(0), 3500);
    return () => clearTimeout(t);
  }, [shown]);
  if (!last || !shown || shown !== last.at) return null;
  return <div className="coin-toast" role="status">+{last.n} 🪙 {last.why}</div>;
}
