import { useEffect, useState } from "react";
import { Crown, Link, navigate, TopBar } from "../App";
import { api } from "../lib/api";
import type { HubPublic } from "../../shared/types";

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

export default function Home() {
  const [code, setCode] = useState("");
  const [hub, setHub] = useState<HubPublic | null>(null);
  useEffect(() => { api.hub().then(setHub).catch(() => {}); }, []);

  const champ = hub?.league[0]?.results[0];

  return (
    <>
      <TopBar />
      <main className="narrow stack" style={{ gap: 28, paddingTop: 32 }}>
        <div className="stack" style={{ gap: 10, textAlign: "center", alignItems: "center" }}>
          <div style={{ width: 72 }}><Crown /></div>
          <h1>Vem tar kronan i veckan?</h1>
          {champ && <p className="muted">Regerande: <strong style={{ color: "var(--chalk)" }}>{champ.name}</strong></p>}
        </div>

        <form className="panel stack" onSubmit={(e) => { e.preventDefault(); if (code.length === 4) navigate("/play/" + code); }}>
          <label htmlFor="code">Rumskod från hosten</label>
          <input id="code" className="code-input" inputMode="text" autoComplete="off" maxLength={4} placeholder="ABCD"
            value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          <button className="btn primary big" disabled={code.length !== 4}>Gå med</button>
        </form>

        {hub?.nextQuiz && (
          <div className="panel flat" style={{ textAlign: "center" }}>
            <p className="muted small">Nästa quiz</p>
            <p className="display" style={{ fontSize: "1.4rem", textTransform: "capitalize" }}>{formatDate(hub.nextQuiz.date)}</p>
            {hub.nextQuiz.theme && <p>Tema: {hub.nextQuiz.theme}</p>}
          </div>
        )}

        <p className="muted small" style={{ textAlign: "center" }}>
          Är du host? <Link to="/host">Starta ett quiz</Link>
        </p>
      </main>
    </>
  );
}
