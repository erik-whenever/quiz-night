import { useEffect, useState } from "react";
import { checkPin, getPin, setPin } from "../lib/api";
import { TopBar } from "../App";

/** Skyddar host-sidor. PIN:en sätts som secret (HOST_PIN) i Cloudflare. */
export default function PinGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [pin, setP] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const saved = getPin();
    if (!saved) { setOk(false); return; }
    checkPin(saved).then(setOk).catch(() => setOk(false));
  }, []);

  if (ok === null) return null;
  if (ok) return <>{children}</>;
  return (
    <>
      <TopBar />
      <main className="narrow stack" style={{ paddingTop: 40 }}>
        <h2>Host-läge</h2>
        <form className="panel stack" onSubmit={async (e) => {
          e.preventDefault();
          if (await checkPin(pin)) { setPin(pin); setOk(true); } else setErr("Fel PIN. Försök igen.");
        }}>
          <label htmlFor="pin">Host-PIN</label>
          <input id="pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setP(e.target.value)} autoFocus />
          {err && <p className="err">{err}</p>}
          <button className="btn primary">Lås upp</button>
        </form>
      </main>
    </>
  );
}
