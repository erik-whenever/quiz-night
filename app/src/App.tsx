import { useEffect, useState } from "react";
import Home from "./pages/Home";
import Play from "./pages/Play";
import Tv from "./pages/Tv";
import HostDashboard from "./pages/HostDashboard";
import HostControl from "./pages/HostControl";
import Bank from "./pages/Bank";
import League from "./pages/League";

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  const current = location.pathname === to;
  return (
    <a href={to} className={className} aria-current={current ? "page" : undefined}
      onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function Crown() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 24 2 9l8 6 6-10 6 10 8-6-2 15z" fill="#FFD23F" stroke="#070b3a" strokeWidth="2" strokeLinejoin="round" />
      <rect x="4" y="24" width="24" height="4" rx="1" fill="#FFD23F" stroke="#070b3a" strokeWidth="2" />
    </svg>
  );
}

export function TopBar({ host }: { host?: boolean }) {
  return (
    <header className="top">
      <Link to="/" className="brand"><Crown />Kronan</Link>
      <nav className="nav">
        {host && <Link to="/host">Starta</Link>}
        {host && <Link to="/bank">Frågebank</Link>}
        <Link to="/tabell">Tabell</Link>
      </nav>
    </header>
  );
}

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  const seg = path.split("/").filter(Boolean);
  const code = (seg[1] ?? "").toUpperCase();
  if (seg[0] === "play" && code) return <Play code={code} />;
  if (seg[0] === "tv" && code) return <Tv code={code} />;
  if (seg[0] === "host" && code) return <HostControl code={code} />;
  if (seg[0] === "host") return <HostDashboard />;
  if (seg[0] === "bank") return <Bank />;
  if (seg[0] === "tabell") return <League />;
  return <Home />;
}
