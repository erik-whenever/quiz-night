// Hooker-off: 1v1 med krok mot en bot (prototyp). Grafiken och spelet ligger i hookoff3d.ts,
// som laddas med dynamisk import så att quizet i övrigt inte blir tyngre.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HookEvent, HookOff as Game } from "./hookoff3d";

type Banner = { text: string; sub?: string; tone: "win" | "lose" | "info"; id: number };

const lowGfx = () => { try { return localStorage.getItem("kronan.gfx") === "low"; } catch { return false; } };

export function HookOff({ onDone }: { onDone: (youWon: boolean) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  useLayoutEffect(() => { done.current = onDone; });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [score, setScore] = useState({ you: 0, bot: 0, round: 1 });
  const [count, setCount] = useState<{ n: number; id: number } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    let game: Game | null = null;
    let cancelled = false;
    let bannerTimer = 0;
    const onEvent = (e: HookEvent) => {
      if (e.type === "countdown") setCount(e.n === null ? null : { n: e.n, id: Math.random() });
      else if (e.type === "score") setScore({ you: e.you, bot: e.bot, round: e.round });
      else if (e.type === "banner") {
        setBanner({ text: e.text, sub: e.sub, tone: e.tone, id: Math.random() });
        clearTimeout(bannerTimer);
        bannerTimer = window.setTimeout(() => setBanner(null), 1700);
      } else if (e.type === "over") window.setTimeout(() => done.current(e.youWon), 1400);
    };
    import("./hookoff3d").then((m) => {
      if (cancelled || !host.current) return;
      game = m.createHookOff(host.current, onEvent, { low: lowGfx() });
      if (!game) { setFailed(true); return; }
      setReady(true);
      game.start();
    }).catch(() => setFailed(true));
    return () => { cancelled = true; clearTimeout(bannerTimer); game?.dispose(); };
  }, []);

  const full = () => {
    const el = wrap.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  if (failed) return <p className="muted">Hooker-off behöver WebGL (3D i webbläsaren), och det saknas här.</p>;

  const pips = (n: number, who: string) => [0, 1].map((i) => <i key={i} className={`ho-pip ${who}${i < n ? " on" : ""}`} />);
  return (
    <div ref={wrap} className={`ho${ready ? " ready" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <div ref={host} className="ho-stage" />
      <div className="ho-hud" aria-live="polite">
        <div className="ho-score">
          <span className="ho-who you">Du</span>{pips(score.you, "you")}<span className="ho-vs">–</span>{pips(score.bot, "bot")}<span className="ho-who bot">Boten</span>
        </div>
        <div className="ho-round">Rond {score.round} · bäst av 3</div>
      </div>
      {count && <div key={count.id} className="ho-count">{count.n > 0 ? count.n : "KÖR!"}</div>}
      {banner && (
        <div key={banner.id}>
          <div className={`ho-banner ${banner.tone}`}>{banner.text}</div>
          {banner.sub && <div className="ho-sub">{banner.sub}</div>}
        </div>
      )}
      <div className="ho-help"><span><kbd>Högerklick</kbd>gå</span><span><kbd>Q</kbd>/<kbd>Space</kbd>kasta krok</span></div>
      <button className="ho-full" onClick={full} aria-label="Helskärm">⛶</button>
    </div>
  );
}
