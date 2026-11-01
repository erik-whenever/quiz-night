// Hostkontrollens del för Kenta: vem som är buddy, hur full han är och en knapp för hooker-off nu.
import type { ClientMsg, HostState } from "../shared/types";
import { DRUNK_NAME } from "../shared/types";

export function HostDrunk({ state, send }: { state: HostState; send: (m: ClientMsg) => void }) {
  if (!state.settings.drunk || state.phase === "finished") return null;
  const d = state.drunk;
  const buddy = d ? state.players.find((p) => p.id === d.buddyId)?.name : undefined;
  const canHook = state.phase === "reveal" && state.players.length >= 2;
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <p className="small muted" aria-live="polite">
        {d && buddy ? <>{DRUNK_NAME} hejar på <strong style={{ color: "var(--chalk)" }}>{buddy}</strong> · {d.sips} {d.sips === 1 ? "sup" : "supar"}</> : `${DRUNK_NAME} kliver in när kvällen startar.`}
      </p>
      {canHook && <button className="btn ghost" onClick={() => send({ t: "host:hookoff" })}>Hooker-off nu</button>}
    </div>
  );
}
