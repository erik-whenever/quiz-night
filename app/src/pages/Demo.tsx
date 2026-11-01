// Demoläge för värden: spela alla minispel direkt, utan rum, poäng eller server.
// Samma komponenter som i kvällens quiz, så det du ser här är det spelarna får.
import { useState } from "react";
import { TopBar } from "../App";
import { Aim, LastHit, Order, Pour, Stopwatch } from "../skill";
import { WheelPanel } from "../wheel";
import { HowTo } from "../howto";
import { correctOrder, orderErrors, orderShuffle, skillText, type OrderItem, type SkillKind, type SkillResult } from "../../shared/skill";
import { WHEEL_SEGMENTS, WHEEL_SPIN_MS, type WheelState } from "../../shared/types";
import { sfx } from "../lib/sound";

type GameId = "lasthit" | "aim" | "stopwatch" | "pour" | "order" | "wheel";

const GAMES: { id: GameId; name: string; kind?: SkillKind; note?: string }[] = [
  { id: "lasthit", name: "Last hit", kind: "lasthit" },
  { id: "aim", name: "Flick", kind: "aim" },
  { id: "stopwatch", name: "Stoppa klockan", kind: "stopwatch" },
  { id: "pour", name: "Häll upp", kind: "pour" },
  { id: "order", name: "Ordna rätt", kind: "order" },
  { id: "wheel", name: "Lyckohjulet" },
];

const ORDER_SETS: { name: string; prompt: string; items: OrderItem[] }[] = [
  { name: "Serier", prompt: "Äldst först", items: [
    { label: "How I Met Your Mother", value: 2005 }, { label: "Breaking Bad", value: 2008 },
    { label: "Game of Thrones", value: 2011 }, { label: "Lost", value: 2004 }, { label: "Better Call Saul", value: 2015 } ] },
  { name: "Mat", prompt: "Minst kalorier först (per 100 g)", items: [
    { label: "Gurka", value: 15 }, { label: "Kokt potatis", value: 77 }, { label: "Pasta (kokt)", value: 158 },
    { label: "Ost (hårdost)", value: 380 }, { label: "Jordnötssmör", value: 590 } ] },
];

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

export default function Demo() {
  const [game, setGame] = useState<GameId>("lasthit");
  const [seed, setSeed] = useState(newSeed);
  const [run, setRun] = useState(0); // ny nyckel = spelet startar om
  const [playing, setPlaying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [target, setTarget] = useState(5);
  const [orderSet, setOrderSet] = useState(0);
  const [wheel, setWheel] = useState<WheelState | null>(null);
  const g = GAMES.find((x) => x.id === game)!;

  const pick = (id: GameId) => { setGame(id); setPlaying(false); setResult(null); setWheel(null); };
  const start = (fresh: boolean) => {
    sfx.unlock();
    if (fresh) setSeed(newSeed());
    setResult(null); setRun((r) => r + 1); setPlaying(true);
  };
  const done = (r: SkillResult) => { setPlaying(false); setResult(g.kind ? skillText(g.kind, r) : ""); };
  const spin = () => {
    sfx.unlock();
    const segment = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
    setWheel((w) => ({ spinId: (w?.spinId ?? 0) + 1, segment, result: WHEEL_SEGMENTS[segment], startedAt: Date.now(), spinMs: WHEEL_SPIN_MS, forQ: 0 }));
  };

  const set = ORDER_SETS[orderSet];
  const shuffled = orderShuffle(set.items, seed);

  const play = () => {
    switch (game) {
      case "lasthit": return <LastHit key={run} seed={seed} onDone={done} />;
      case "aim": return <Aim key={run} seed={seed} onDone={done} />;
      case "stopwatch": return <Stopwatch key={run} target={target} onDone={done} />;
      case "pour": return <Pour key={run} seed={seed} onDone={done} />;
      case "order": return (
        <Order key={run} items={shuffled.map((i) => ({ label: i.label }))} prompt={set.prompt}
          onLock={(order) => { setPlaying(false); setResult(skillText("order", { value: orderErrors(set.items, order) ?? 0, ok: true }, set.items.length)); }} />
      );
      default: return null;
    }
  };

  return (
    <>
      <TopBar host />
      <main className="wrap stack demo" style={{ gap: 20 }}>
        <div>
          <h1>Minispel</h1>
          <p className="muted">Testa utmaningarna direkt, utan att starta något rum. Inga poäng, inget sparas.</p>
        </div>
        <div className="demo-picker" role="tablist" aria-label="Välj minispel">
          {GAMES.map((x) => (
            <button key={x.id} role="tab" aria-label={`${x.name}${x.note ? ` (${x.note})` : ""}`} aria-selected={x.id === game} className={`demo-pick${x.id === game ? " on" : ""}`} onClick={() => pick(x.id)}>
              <strong>{x.name}</strong>{x.note && <span className="small">{x.note}</span>}
            </button>
          ))}
        </div>

        <section className="panel stack demo-stage" aria-label={`${g.name}${g.note ? ` (${g.note})` : ""}`}>
          {game === "wheel" ? (
            <div className="stack" style={{ alignItems: "center" }}>
              {wheel ? <WheelPanel wheel={wheel} serverNow={Date.now} size={300} /> : <p className="muted">Lyckohjulet snurras mellan frågorna och ger nästa fråga en twist.</p>}
              <button className="btn primary big" onClick={spin}>{wheel ? "Snurra igen" : "Snurra"}</button>
            </div>
          ) : playing ? (
            play()
          ) : (
            <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
              <h2>{g.name}{g.note && <span className="muted small"> · {g.note}</span>}</h2>
              {result === null ? <HowTo kind={g.kind!} /> : null}
              {game === "stopwatch" && (
                <label style={{ maxWidth: 160 }}>Mål (s)
                  <input type="number" aria-label="Mål i sekunder" min={3} max={30} step={0.5} value={target} onChange={(e) => setTarget(Math.max(3, Math.min(30, +e.target.value || 5)))} />
                </label>
              )}
              {game === "order" && (
                <label style={{ maxWidth: 260 }}>Frågor
                  <select aria-label="Ordna rätt-set" value={orderSet} onChange={(e) => { setOrderSet(+e.target.value); setResult(null); }}>
                    {ORDER_SETS.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
                  </select>
                </label>
              )}
              {result !== null && (
                <div className="locked-card" role="status">
                  <p className="display big-verdict">Klart!</p>
                  <p className="locked-text">{result}</p>
                  {game === "order" && <p className="muted small">Rätt: {correctOrder(set.items).map((i) => `${i.label} (${i.show ?? i.value})`).join(" · ")}</p>}
                </div>
              )}
              <div className="row" style={{ justifyContent: "center" }}>
                {result !== null && game !== "stopwatch" && <button className="btn ghost" onClick={() => start(false)}>Samma bana igen</button>}
                <button className="btn primary big" onClick={() => start(true)}>{result !== null ? "Spela igen" : "Starta"}</button>
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
