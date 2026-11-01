// Hookertime: glitch → anime-intro (titel, hookern, hjulet, VS + instruktioner) → riktig 1v1-match →
// resultat. Servern äger tidslinjen (shared/types.ts HOOKERTIME) och kör matchen; här ritas allt.
// Samma komponent används på TV:n (åskådare, ljud), i mobilen/datorn (de två spelar, övriga tittar)
// och i hostkontrollen (status och avbryt).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ClientMsg, HostState, HookertimePublic, PlayerPublic } from "../shared/types";
import { HOOKERTIME, hookStage, type HookStage } from "../shared/types";
import type { HsSnap } from "../shared/hooksim";
import type { HookEvent, HookInput, HookOff as Game } from "./hookoff3d";
import { PlayerWheel } from "./drunk";
import { hookSfx } from "./lib/sound";

type Role = "tv" | "player" | "host";

/** Rendera om när introts skede byts (servertid). */
function useStage(h: HookertimePublic | null | undefined, serverNow: () => number): HookStage | null {
  const [stage, setStage] = useState<HookStage | null>(() => (h ? hookStage(h, serverNow()) : null));
  useEffect(() => {
    if (!h) { setStage(null); return; }
    const tick = () => setStage(hookStage(h, serverNow()));
    tick();
    const id = window.setInterval(tick, 100);
    return () => clearInterval(id);
  }, [h, serverNow]);
  return stage;
}

const nameOf = (players: PlayerPublic[], id?: string) => players.find((p) => p.id === id)?.name ?? "?";
const colorOf = (players: PlayerPublic[], id?: string) => players.find((p) => p.id === id)?.color ?? "#4CC9F0";

/** Helskärm för Hookertime (portal till <body>, så att inget på sidan kan klippa eller flytta den). */
export function Hookertime(props: Parameters<typeof HookertimeInner>[0]) {
  const node: ReactNode = <HookertimeInner {...props} />;
  return createPortal(node, document.body);
}

function HookertimeInner({ state, role, me, send, serverNow, subscribeHo }: {
  state: HostState; role: Role; me?: string; send: (m: ClientMsg) => void; serverNow: () => number;
  subscribeHo: (f: (s: HsSnap) => void) => () => void;
}) {
  const h = state.hookertime;
  const stage = useStage(h, serverNow);
  const sound = role === "tv";

  // Ljud och glitch på hela sidan när skedet byts
  const prev = useRef<HookStage | null>(null);
  useEffect(() => {
    if (!stage || stage === prev.current) return;
    const fresh = !h || serverNow() - h.startedAt < 60_000;
    prev.current = stage;
    if (!sound || !fresh) return;
    if (stage === "glitch") hookSfx.glitch();
    if (stage === "title") { hookSfx.impact(); window.setTimeout(hookSfx.slash, 350); }
    if (stage === "pick") hookSfx.slash();
    if (stage === "vs") { hookSfx.stab(); window.setTimeout(() => hookSfx.riser(HOOKERTIME.VS_MS / 1000 - 1), 900); }
    if (stage === "match") hookSfx.impact();
    if (stage === "result") hookSfx.roundWin();
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.body.classList.toggle("hk-glitching", stage === "glitch");
    return () => document.body.classList.remove("hk-glitching");
  }, [stage]);

  if (!h || !stage) return null;
  const P = state.players;
  const hooker = { id: h.hooker, name: nameOf(P, h.hooker), color: colorOf(P, h.hooker) };
  const opp = { id: h.opponent, name: nameOf(P, h.opponent), color: colorOf(P, h.opponent) };
  const fighting = me === h.hooker ? 0 : me === h.opponent ? 1 : null;

  if (stage === "glitch") return <div className="hk hk-glitch" aria-hidden="true"><div className="hk-noise" /><div className="hk-bars" /></div>;

  if (stage === "match") {
    // De två spelar; TV:n visar matchen för alla; övriga spelare och hosten får status.
    if (role === "tv" || fighting !== null) {
      return (
        <div className="hk hk-match" role="region" aria-label="Hookertime-match">
          <HookMatch key={h.startedAt} me={role === "tv" ? null : fighting} names={[hooker.name, opp.name]} send={send}
            serverNow={serverNow} subscribeHo={subscribeHo} sound={sound} />
        </div>
      );
    }
    return (
      <div className="hk hk-watch" role="status">
        <p className="hk-kicker">HOOKERTIME #{h.n}</p>
        <p className="hk-versus"><span style={{ color: hooker.color }}>{hooker.name}</span> <em>vs</em> <span style={{ color: opp.color }}>{opp.name}</span></p>
        <LiveScore subscribeHo={subscribeHo} />
        <p className="hk-sub">{role === "host" ? "Matchen pågår på TV:n." : "Matchen pågår! Titta på TV:n och heja."}</p>
        {role === "host" && <button className="btn ghost" onClick={() => send({ t: "host:hookertime:stop" })}>Avbryt Hookertime</button>}
      </div>
    );
  }

  if (stage === "result") {
    const won = h.winner === h.hooker ? hooker : opp, lost = h.winner === h.hooker ? opp : hooker;
    return (
      <div className="hk hk-result" role="status" aria-label={`${won.name} vann Hookertime`}>
        <div className="hk-lines" aria-hidden="true" />
        <p className="hk-kicker">勝者 · VINNARE</p>
        <h1 className="hk-winner" style={{ color: won.color }}>{won.name}</h1>
        <p className="hk-rounds">{h.rounds ? `${Math.max(...h.rounds)}–${Math.min(...h.rounds)} i ronder` : ""}</p>
        <div className="hk-stakes">
          <span className="hk-plus">{won.name} +{HOOKERTIME.STAKE} p</span>
          <span className="hk-minus">{lost.name} −{HOOKERTIME.STAKE} p</span>
        </div>
        {me === won.id && <p className="hk-sub">Snyggt hookat!</p>}
        {me === lost.id && <p className="hk-sub">Du blev hookad. Det svider.</p>}
      </div>
    );
  }

  // Introt: titel, hookern, hjulet, VS
  const H = HOOKERTIME;
  const wheelAt = h.startedAt + H.GLITCH_MS + H.TITLE_MS + H.PICK_MS;
  const wheelLanded = serverNow() >= wheelAt + H.SPIN_MS;
  const leftMs = Math.max(0, h.matchAt - serverNow());
  return (
    <div className={`hk hk-intro hk-s-${stage}`} role="dialog" aria-label="Hookertime">
      <div className="hk-lines" aria-hidden="true" />
      {stage === "title" && (
        <div className="hk-title-wrap">
          <div className="hk-flash" aria-hidden="true" />
          <p className="hk-jp" aria-hidden="true">フッカータイム！</p>
          <h1 className="hk-title" data-text="HOOKERTIME">HOOKERTIME</h1>
          <p className="hk-kicker">{h.n === 1 ? "Kvällens första duell" : h.n === 2 ? "Andra ronden. Ingen kommer undan." : `Duell nr ${h.n}`}</p>
        </div>
      )}
      {stage === "pick" && (
        <div className="hk-pick" style={{ ["--c" as string]: hooker.color }}>
          <p className="hk-kicker">選ばれし者 · Den utvalde</p>
          <p className="hk-label">Hookern är</p>
          <h1 className="hk-name">{hooker.name}</h1>
        </div>
      )}
      {stage === "wheel" && (
        <div className="hk-wheel">
          <p className="hk-label"><strong style={{ color: hooker.color }}>{hooker.name}</strong> ska möta…</p>
          {h.pool.length > 1 ? (
            <PlayerWheel names={h.pool.map((id) => nameOf(P, id))} colors={h.pool.map((id) => colorOf(P, id))}
              target={Math.max(0, h.pool.indexOf(h.opponent))} startAt={wheelAt} spinMs={H.SPIN_MS} serverNow={serverNow}
              size={Math.min(360, Math.round(window.innerHeight * 0.5), window.innerWidth - 40)} onLanded={() => sound && hookSfx.slash()} />
          ) : <p className="hk-name small">Bara en kvar att välja på…</p>}
          {(wheelLanded || h.pool.length < 2) && <h1 className="hk-name" style={{ color: opp.color }}>{opp.name}!</h1>}
        </div>
      )}
      {stage === "vs" && (
        <div className="hk-vs">
          <div className="hk-side left" style={{ ["--c" as string]: "#2b3ad0" }}>
            <span className="hk-role">Hooker · blå</span>
            <strong style={{ color: hooker.color }}>{hooker.name}</strong>
          </div>
          <div className="hk-vs-mark">VS</div>
          <div className="hk-side right" style={{ ["--c" as string]: "#a52c3c" }}>
            <span className="hk-role">Utmanad · röd</span>
            <strong style={{ color: opp.color }}>{opp.name}</strong>
          </div>
          <div className="hk-howto">
            <h2>Så funkar det</h2>
            <ul>
              <li><b>Dator:</b> högerklicka för att gå, <kbd>Q</kbd> eller <kbd>mellanslag</kbd> kastar kroken mot muspekaren</li>
              <li><b>Mobil:</b> tryck för att gå, tryck <b>KROK</b> och sedan dit kroken ska</li>
              <li>Hooka den andra först och dra in hen. Pelarna stoppar kroken, arenan krymper efter en stund</li>
              <li>Bäst av 3. Vinnaren tar <b>{H.STAKE} p</b> från förloraren</li>
            </ul>
            {fighting !== null ? <p className="hk-you">Du är {fighting === 0 ? "blå" : "röd"}. Gör dig redo!</p>
              : <p className="hk-sub">Ni andra: titta på TV:n och heja (eller bua).</p>}
            <p className="hk-count">Matchen börjar om {Math.ceil(leftMs / 1000)}</p>
          </div>
        </div>
      )}
      {role === "host" && <button className="btn sm ghost hk-abort" onClick={() => send({ t: "host:hookertime:stop" })}>Avbryt Hookertime</button>}
    </div>
  );
}

/** Ställningen i ronder, från ögonblicksbilderna. */
function LiveScore({ subscribeHo }: { subscribeHo: (f: (s: HsSnap) => void) => () => void }) {
  const [sc, setSc] = useState<[number, number]>([0, 0]);
  useEffect(() => subscribeHo((s) => setSc((p) => (p[0] === s.sc[0] && p[1] === s.sc[1] ? p : [s.sc[0], s.sc[1]]))), [subscribeHo]);
  return <p className="hk-live" aria-label="Ställning i ronder">{sc[0]} – {sc[1]}</p>;
}

type Banner = { text: string; sub?: string; tone: "win" | "lose" | "info"; id: number };
const lowGfx = () => { try { return localStorage.getItem("kronan.gfx") === "low"; } catch { return false; } };

/** Matchen över nätet: samma 3D-arena som demon, men servern kör spelet. */
function HookMatch({ me, names, send, serverNow, subscribeHo, sound }: {
  me: 0 | 1 | null; names: [string, string]; send: (m: ClientMsg) => void; serverNow: () => number;
  subscribeHo: (f: (s: HsSnap) => void) => () => void; sound: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [score, setScore] = useState({ a: 0, b: 0, round: 1 });
  const [count, setCount] = useState<{ n: number; id: number } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const cb = useRef({ send, sound });
  useLayoutEffect(() => { cb.current = { send, sound }; });

  useEffect(() => {
    let game: Game | null = null;
    let cancelled = false;
    let bannerTimer = 0;
    const early: HsSnap[] = [];
    const unsub = subscribeHo((s) => {
      if (game) game.push(s); else early.push(s);
      if (cb.current.sound) for (const e of s.ev) {
        if (e.k === "throw") hookSfx.throw();
        if (e.k === "hit") hookSfx.hit();
        if (e.k === "block") hookSfx.clank();
        if (e.k === "round") hookSfx.roundWin();
      }
    });
    const onEvent = (e: HookEvent) => {
      if (e.type === "countdown") setCount(e.n === null ? null : { n: e.n, id: Math.random() });
      else if (e.type === "score") setScore({ a: e.you, b: e.bot, round: e.round });
      else if (e.type === "banner") {
        setBanner({ text: e.text, sub: e.sub, tone: e.tone, id: Math.random() });
        clearTimeout(bannerTimer);
        bannerTimer = window.setTimeout(() => setBanner(null), 1700);
      }
    };
    const onInput = (m: HookInput) => cb.current.send({ t: "hook", ...("move" in m ? { move: m.move } : "hook" in m ? { hook: m.hook } : { stop: true }) });
    import("./hookoff3d").then((mod) => {
      if (cancelled || !host.current) return;
      game = mod.createHookOff(host.current, onEvent, { mode: "net", me, names, onInput, serverNow, low: lowGfx() });
      if (!game) { setFailed(true); return; }
      for (const s of early.splice(0)) game.push(s);
      setReady(true);
    }).catch(() => setFailed(true));
    return () => { cancelled = true; unsub(); clearTimeout(bannerTimer); game?.dispose(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const aimHook = () => (host.current as (HTMLDivElement & { aimHook?: () => void }) | null)?.aimHook?.();
  const pips = (n: number, who: string) => [0, 1].map((i) => <i key={i} className={`ho-pip ${who}${i < n ? " on" : ""}`} />);
  if (failed) return <p className="hk-sub">Matchen behöver WebGL (3D i webbläsaren), och det saknas här. {me !== null ? "Du står still, sorry." : ""}</p>;
  return (
    <div className={`ho ho-net${ready ? " ready" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <div ref={host} className="ho-stage" />
      <div className="ho-hud" aria-live="polite">
        <div className="ho-score">
          <span className="ho-who you">{names[0]}</span>{pips(score.a, "you")}<span className="ho-vs">–</span>{pips(score.b, "bot")}<span className="ho-who bot">{names[1]}</span>
        </div>
        <div className="ho-round">HOOKERTIME · rond {score.round} · bäst av 3{me !== null ? ` · du är ${me === 0 ? "blå" : "röd"}` : ""}</div>
      </div>
      {count && <div key={count.id} className="ho-count">{count.n > 0 ? count.n : "KÖR!"}</div>}
      {banner && (
        <div key={banner.id}>
          <div className={`ho-banner ${banner.tone}`}>{banner.text}</div>
          {banner.sub && <div className="ho-sub">{banner.sub}</div>}
        </div>
      )}
      {me !== null && <div className="ho-help"><span><kbd>Högerklick</kbd>gå</span><span><kbd>Q</kbd>/<kbd>Space</kbd>kasta krok</span></div>}
      {me !== null && <button className="hk-hookbtn" onPointerDown={(e) => { e.stopPropagation(); aimHook(); }}>KROK</button>}
    </div>
  );
}
