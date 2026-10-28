import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, HostState, ServerMsg } from "../../shared/types";

type Role = "host" | "tv" | "player";

/** WebSocket mot ett rum, med automatisk återanslutning och klockkorrigering mot servern. */
export function useRoom(code: string, role: Role, opts: { hostKey?: string; onJoined?: (id: string) => void } = {}) {
  const [state, setState] = useState<HostState | null>(null);
  const [error, setError] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const offset = useRef(0); // serverTid - lokalTid
  const queue = useRef<ClientMsg[]>([]);
  const onJoined = useRef(opts.onJoined);
  onJoined.current = opts.onJoined;

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    let pinger: ReturnType<typeof setInterval>;
    let attempts = 0;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const q = new URLSearchParams({ role, ...(opts.hostKey ? { key: opts.hostKey } : {}) });
      const sock = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
      ws.current = sock;
      sock.onopen = () => {
        attempts = 0; setConnected(true); setError("");
        for (const m of queue.current.splice(0)) sock.send(JSON.stringify(m));
        const ping = () => sock.readyState === 1 && sock.send(JSON.stringify({ t: "ping", c: Date.now() }));
        ping(); pinger = setInterval(ping, 5000);
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ServerMsg;
        if (m.t === "state") setState(m.state as HostState);
        else if (m.t === "error") setError(m.message);
        else if (m.t === "joined") onJoined.current?.(m.playerId);
        else if (m.t === "pong") { const now = Date.now(); offset.current = m.s - (m.c + now) / 2; }
        else if (m.t === "sping") sock.send(JSON.stringify({ t: "spong", s: m.s }));
      };
      sock.onclose = (ev) => {
        clearInterval(pinger); setConnected(false);
        if (!alive) return;
        if (ev.code === 4000) { setError("Du togs bort från rummet av hosten."); return; }
        attempts++;
        if (attempts > 3 && !state) setError("Hittar inte rummet. Kolla koden.");
        retry = setTimeout(open, Math.min(4000, 400 * attempts));
      };
    };
    open();
    return () => { alive = false; clearTimeout(retry); clearInterval(pinger); ws.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, role, opts.hostKey]);

  const send = useCallback((m: ClientMsg) => {
    // Rättvis buzz: stämpla trycket med uppskattad servertid så servern kan kompensera för ping.
    if (m.t === "buzz" && m.at === undefined) m = { ...m, at: Date.now() + offset.current };
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(m));
    else queue.current.push(m);
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);
  return { state, error, connected, send, serverNow };
}

/** Sekunder kvar till en deadline (servertid), uppdateras ofta. */
export function useCountdown(deadline: number | undefined, serverNow: () => number) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!deadline) { setLeft(0); return; }
    let raf = 0;
    const tick = () => { setLeft(Math.max(0, deadline - serverNow())); raf = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deadline, serverNow]);
  return left;
}
