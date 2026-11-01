// Hooker-off: spelreglerna, utan grafik. Körs på servern (Room, riktig 1v1 över nätet) och lokalt
// i demoläget mot en bot. Grafiken i src/hookoff3d.ts ritar bara det här tillståndet.
//
// Koordinater i arenans plan (x, z). Riktningen för en vinkel `face` är (cos(-face), sin(-face)).

// ===== Regler =====
export const HS = {
  R0: 9.2,            // arenans radie
  R_MIN: 3.8,         // minsta radie när den krympt klart
  SHRINK_AT: 18,      // sekunder in i ronden
  SHRINK_DUR: 16,
  MOVE: 4.3,          // enheter/s
  UNIT_R: 0.6,
  HOOK_SPEED: 18,
  HOOK_RANGE: 10.5,
  HOOK_BACK: 30,
  PULL_SPEED: 13,
  HOOK_CD: 2.6,
  WINDUP: 0.15,
  HIT_R: 0.75,
  WINS: 2,
  STEP: 1 / 60,
  /** Nedräkning före varje rond, och paus efter. */
  COUNT_S: 2.4,
  ROUND_END_S: 2.2,
} as const;

export const HS_START: [number, number][] = [[-6.4, 0.3], [6.4, -0.3]];
export const HS_PILLARS: { x: number; z: number; r: number }[] = [
  { x: 0, z: 2.5, r: 0.62 }, { x: 0, z: -2.5, r: 0.62 },
  { x: -3.4, z: -4.0, r: 0.5 }, { x: 3.4, z: 4.0, r: 0.5 },
  { x: -4.6, z: 4.4, r: 0.45 }, { x: 4.6, z: -4.4, r: 0.45 },
];

export type HsPhase = "idle" | "intro" | "fight" | "roundEnd" | "over";
export type HsHookState = "idle" | "out" | "back" | "pull";
export interface P2 { x: number; z: number }

export interface HsUnit {
  x: number; z: number; px: number; pz: number; vx: number; vz: number;
  target: P2 | null;
  face: number;
  cdUntil: number;
  windup: { until: number; dx: number; dz: number } | null;
  hooked: boolean;
  down: boolean;
}
export interface HsHook { state: HsHookState; x: number; z: number; dx: number; dz: number; dist: number; victim: -1 | 0 | 1 }

export type HsEvent =
  | { k: "count"; n: number | null }
  | { k: "throw"; u: 0 | 1 }
  | { k: "hit"; u: 0 | 1; x: number; z: number }
  | { k: "block"; x: number; z: number }
  | { k: "shrink" }
  | { k: "round"; w: 0 | 1; x: number; z: number }
  | { k: "over"; w: 0 | 1 }
  | { k: "phase"; p: HsPhase };

export interface HookSim {
  t: number; phase: HsPhase; phaseT: number; fightT: number; radius: number;
  score: [number, number]; round: number; lastCount: number;
  timeScale: number; slowUntil: number; shrinkAnnounced: boolean;
  units: [HsUnit, HsUnit]; hooks: [HsHook, HsHook];
  acc: number;
  /** Händelser sedan förra gången de hämtades (drain). */
  events: HsEvent[];
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const newUnit = (i: number): HsUnit => ({
  x: HS_START[i][0], z: HS_START[i][1], px: HS_START[i][0], pz: HS_START[i][1], vx: 0, vz: 0,
  target: null, face: i === 0 ? 0 : Math.PI, cdUntil: 0, windup: null, hooked: false, down: false,
});
const newHook = (): HsHook => ({ state: "idle", x: 0, z: 0, dx: 1, dz: 0, dist: 0, victim: -1 });

export function createSim(): HookSim {
  return {
    t: 0, phase: "idle", phaseT: 0, fightT: 0, radius: HS.R0, score: [0, 0], round: 0, lastCount: -1,
    timeScale: 1, slowUntil: 0, shrinkAnnounced: false,
    units: [newUnit(0), newUnit(1)], hooks: [newHook(), newHook()], acc: 0, events: [],
  };
}

function setPhase(s: HookSim, p: HsPhase) { s.phase = p; s.phaseT = 0; s.events.push({ k: "phase", p }); }

function resetRound(s: HookSim) {
  s.radius = HS.R0; s.fightT = 0; s.shrinkAnnounced = false; s.lastCount = -1;
  s.units = [newUnit(0), newUnit(1)];
  s.hooks = [newHook(), newHook()];
}

/** Starta matchen (rond 1, nedräkning). */
export function startSim(s: HookSim) {
  s.score = [0, 0]; s.round = 1;
  resetRound(s);
  setPhase(s, "intro");
}

/** Var handen (krokens fäste) sitter: lite framför och till höger om gubben. */
export function handOf(u: HsUnit): P2 {
  const fx = Math.cos(-u.face), fz = Math.sin(-u.face);
  return { x: u.x + fx * 0.35 - fz * 0.45, z: u.z + fz * 0.35 + fx * 0.45 };
}

// ===== Input =====

/** Gå hit (klick/tryck). Går även under nedräkningen (då vänder gubben sig bara). */
export function simMove(s: HookSim, i: 0 | 1, to: P2) {
  if (s.phase !== "fight" && s.phase !== "intro") return;
  const u = s.units[i];
  if (u.hooked || u.down) return;
  const L = Math.hypot(to.x, to.z), lim = s.radius - HS.UNIT_R;
  u.target = L > lim ? { x: (to.x / L) * lim, z: (to.z / L) * lim } : { x: to.x, z: to.z };
}

export function simStop(s: HookSim, i: 0 | 1) { s.units[i].target = null; }

/** Kasta kroken mot en punkt. false om det inte gick (cooldown, redan ute, hookad). */
export function simThrow(s: HookSim, i: 0 | 1, at: P2): boolean {
  const u = s.units[i];
  if (s.phase !== "fight" || u.hooked || u.windup || s.t < u.cdUntil || s.hooks[i].state !== "idle") return false;
  let dx = at.x - u.x, dz = at.z - u.z;
  if (dx * dx + dz * dz < 0.01) { dx = Math.cos(-u.face); dz = Math.sin(-u.face); }
  const L = Math.hypot(dx, dz); dx /= L; dz /= L;
  u.windup = { until: s.t + HS.WINDUP, dx, dz };
  u.cdUntil = s.t + HS.HOOK_CD;
  u.face = Math.atan2(-dz, dx);
  u.target = null;
  s.events.push({ k: "throw", u: i });
  return true;
}

// ===== Simulering =====

export function segBlocked(ax: number, az: number, bx: number, bz: number, pad = 0.15) {
  let dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz); if (L < 1e-4) return false;
  dx /= L; dz /= L;
  for (const p of HS_PILLARS) {
    const t = clamp((p.x - ax) * dx + (p.z - az) * dz, 0, L);
    if (Math.hypot(ax + dx * t - p.x, az + dz * t - p.z) < p.r + pad) return true;
  }
  return false;
}

function endRound(s: HookSim, w: 0 | 1) {
  const l = s.units[1 - w];
  s.score[w]++;
  l.down = true;
  s.hooks[w].state = "idle"; s.hooks[w].victim = -1;
  s.events.push({ k: "round", w, x: l.x, z: l.z });
  setPhase(s, "roundEnd");
}

function hookStep(s: HookSim, i: 0 | 1, dt: number) {
  const h = s.hooks[i], u = s.units[i];
  if (h.state === "out") {
    const step = HS.HOOK_SPEED * dt;
    const px = h.x, pz = h.z;
    h.x += h.dx * step; h.z += h.dz * step; h.dist += step;
    const e = s.units[1 - i];
    if (!e.hooked && s.phase === "fight" && Math.hypot(h.x - e.x, h.z - e.z) < HS.HIT_R) {
      h.state = "pull"; h.victim = (1 - i) as 0 | 1;
      e.hooked = true; e.target = null; e.windup = null;
      const eh = s.hooks[1 - i];
      if (eh.state === "out") eh.state = "back";
      s.slowUntil = s.t + 0.18; s.timeScale = 0.25;
      s.events.push({ k: "hit", u: i, x: h.x, z: h.z });
      return;
    }
    if (segBlocked(px, pz, h.x, h.z, 0.12)) { h.state = "back"; s.events.push({ k: "block", x: h.x, z: h.z }); return; }
    if (h.dist >= HS.HOOK_RANGE) h.state = "back";
  } else if (h.state === "back") {
    const hp = handOf(u);
    const dx = hp.x - h.x, dz = hp.z - h.z, L = Math.hypot(dx, dz);
    if (L < 0.35) { h.state = "idle"; return; }
    const m = Math.min(L, HS.HOOK_BACK * dt) / L;
    h.x += dx * m; h.z += dz * m; h.dx = -dx / L; h.dz = -dz / L;
  } else if (h.state === "pull") {
    const v = s.units[h.victim as 0 | 1];
    const gx = u.x + Math.cos(-u.face) * 1.25, gz = u.z + Math.sin(-u.face) * 1.25;
    const dx = gx - h.x, dz = gz - h.z, L = Math.hypot(dx, dz);
    if (L < 0.12) { if (s.phase === "fight") endRound(s, i); return; }
    const m = Math.min(L, HS.PULL_SPEED * dt) / L;
    h.x += dx * m; h.z += dz * m; h.dx = -dx / L; h.dz = -dz / L;
    v.x = h.x; v.z = h.z;
  }
}

function step(s: HookSim, dt: number) {
  s.t += dt; s.phaseT += dt;
  if (s.phase === "intro") {
    const n = 3 - Math.floor(s.phaseT / (HS.COUNT_S / 3));
    if (n !== s.lastCount) { s.lastCount = n; s.events.push({ k: "count", n: n > 0 ? n : 0 }); }
    if (s.phaseT >= HS.COUNT_S) { s.events.push({ k: "count", n: null }); setPhase(s, "fight"); }
  } else if (s.phase === "fight") {
    s.fightT += dt;
    const k = clamp((s.fightT - HS.SHRINK_AT) / HS.SHRINK_DUR, 0, 1);
    s.radius = lerp(HS.R0, HS.R_MIN, k * k * (3 - 2 * k));
    if (k > 0 && !s.shrinkAnnounced) { s.shrinkAnnounced = true; s.events.push({ k: "shrink" }); }
  } else if (s.phase === "roundEnd") {
    if (s.phaseT >= HS.ROUND_END_S) {
      if (s.score[0] >= HS.WINS || s.score[1] >= HS.WINS) {
        setPhase(s, "over");
        s.events.push({ k: "over", w: s.score[0] > s.score[1] ? 0 : 1 });
      } else {
        s.round++;
        resetRound(s);
        setPhase(s, "intro");
      }
    }
  }

  for (const i of [0, 1] as const) {
    const u = s.units[i], h = s.hooks[i];
    u.px = u.x; u.pz = u.z;
    if (u.windup && s.t >= u.windup.until) {
      h.state = "out"; h.dx = u.windup.dx; h.dz = u.windup.dz; h.dist = 0;
      const hp = handOf(u); h.x = hp.x; h.z = hp.z;
      u.windup = null;
    }
    const canMove = (s.phase === "fight" || s.phase === "intro") && !u.hooked && !u.windup && h.state === "idle" && !u.down;
    if (canMove && u.target) {
      const dx = u.target.x - u.x, dz = u.target.z - u.z, L = Math.hypot(dx, dz);
      const want = Math.atan2(-dz, dx);
      let da = want - u.face; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (s.phase === "fight") {
        if (L < 0.08) u.target = null;
        else {
          const m = Math.min(L, HS.MOVE * dt) / L;
          u.x += dx * m; u.z += dz * m;
          u.face += da * Math.min(1, dt * 14);
        }
      } else if (L > 0.08) u.face += da * Math.min(1, dt * 10);
    }
  }
  hookStep(s, 0, dt); hookStep(s, 1, dt);

  // Kollisioner: pelare, arenans kant, varandra
  for (const u of s.units) {
    if (u.hooked) continue;
    for (const p of HS_PILLARS) {
      const dx = u.x - p.x, dz = u.z - p.z, d = Math.hypot(dx, dz), min = p.r + HS.UNIT_R;
      if (d < min && d > 1e-4) { u.x = p.x + (dx / d) * min; u.z = p.z + (dz / d) * min; }
    }
    const lim = s.radius - HS.UNIT_R, d = Math.hypot(u.x, u.z);
    if (d > lim) { u.x *= lim / d; u.z *= lim / d; }
  }
  const [a, b] = s.units;
  if (!a.hooked && !b.hooked) {
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d < HS.UNIT_R * 2 && d > 1e-4) {
      const push = (HS.UNIT_R * 2 - d) / 2;
      a.x -= (dx / d) * push; a.z -= (dz / d) * push; b.x += (dx / d) * push; b.z += (dz / d) * push;
    }
  }
  for (const u of s.units) { u.vx = (u.x - u.px) / dt; u.vz = (u.z - u.pz) / dt; }
}

/** Kör fram simuleringen `realDt` sekunder (med slow motion efter en träff). */
export function advanceSim(s: HookSim, realDt: number, beforeStep?: (s: HookSim) => void) {
  if (s.t >= s.slowUntil) s.timeScale = lerp(s.timeScale, 1, Math.min(1, realDt * 6));
  s.acc += Math.min(0.25, realDt) * s.timeScale;
  while (s.acc >= HS.STEP) { beforeStep?.(s); step(s, HS.STEP); s.acc -= HS.STEP; }
}

export function drainEvents(s: HookSim): HsEvent[] { const e = s.events; s.events = []; return e; }

// ===== Ögonblicksbild över nätet =====

/** Kompakt tillstånd som servern skickar ~20 ggr/s. Tider är relativa (sekunder kvar), inte simtid. */
export interface HsSnap {
  /** Servertid (ms) när bilden togs, för interpolering. */
  at: number;
  ph: HsPhase; pt: number; r: number; sc: [number, number]; rd: number; ts: number;
  /** Per gubbe: x, z, face, vx, vz, hooked(0/1), down(0/1), cooldown kvar (s), windup(0/1), mål x, mål z (NaN = inget). */
  u: number[][];
  /** Per krok: state(0 idle,1 out,2 back,3 pull), x, z, dx, dz, victim. */
  h: number[][];
  ev: HsEvent[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const HSTATES: HsHookState[] = ["idle", "out", "back", "pull"];

export function snapOf(s: HookSim, at: number, ev: HsEvent[]): HsSnap {
  return {
    at, ph: s.phase, pt: r3(s.phaseT), r: r3(s.radius), sc: [s.score[0], s.score[1]], rd: s.round, ts: r3(s.timeScale),
    u: s.units.map((u) => [r3(u.x), r3(u.z), r3(u.face), r3(u.vx), r3(u.vz), +u.hooked, +u.down, r3(Math.max(0, u.cdUntil - s.t)), u.windup ? 1 : 0,
      u.target ? r3(u.target.x) : NaN, u.target ? r3(u.target.z) : NaN]),
    h: s.hooks.map((h) => [HSTATES.indexOf(h.state), r3(h.x), r3(h.z), r3(h.dx), r3(h.dz), h.victim]),
    ev,
  };
}

/** Läs in en ögonblicksbild i ett lokalt sim-objekt (för att rita). */
export function applySnap(s: HookSim, n: HsSnap) {
  s.phase = n.ph; s.phaseT = n.pt; s.radius = n.r; s.score = [n.sc[0], n.sc[1]]; s.round = n.rd; s.timeScale = n.ts;
  n.u.forEach((a, i) => {
    const u = s.units[i];
    u.x = a[0]; u.z = a[1]; u.face = a[2]; u.vx = a[3]; u.vz = a[4]; u.hooked = !!a[5]; u.down = !!a[6];
    u.cdUntil = s.t + a[7]; u.windup = a[8] ? { until: s.t, dx: Math.cos(-u.face), dz: Math.sin(-u.face) } : null;
    u.target = Number.isFinite(a[9]) ? { x: a[9], z: a[10] } : null;
  });
  n.h.forEach((a, i) => {
    const h = s.hooks[i];
    h.state = HSTATES[a[0]] ?? "idle"; h.x = a[1]; h.z = a[2]; h.dx = a[3]; h.dz = a[4]; h.victim = a[5] as -1 | 0 | 1;
  });
}

// ===== Boten (demoläget) =====

export interface BotMind { nextMove: number; throwReadyAt: number; dodgeAt: number; ddx: number; ddz: number }
export const newBot = (skill: number): BotMind => ({ nextMove: 0, throwReadyAt: 1.2 - skill * 0.6, dodgeAt: -1, ddx: 0, ddz: 0 });

/** Botens tänkande för gubbe `me` (körs före varje steg). */
export function botThink(s: HookSim, me: 0 | 1, bot: BotMind, skill: number, rand = Math.random) {
  const r = (a: number, b: number) => a + rand() * (b - a);
  const u = s.units[me], you = s.units[1 - me], yh = s.hooks[1 - me];
  if (s.phase === "intro" && s.phaseT < 0.05) { bot.nextMove = 0; bot.throwReadyAt = s.t + 1.2 - skill * 0.6 + HS.COUNT_S; bot.dodgeAt = -1; }
  if (u.hooked || s.phase !== "fight") return;
  if (yh.state === "out" && bot.dodgeAt < 0) {
    const rx = u.x - yh.x, rz = u.z - yh.z;
    const along = rx * yh.dx + rz * yh.dz;
    if (along > 0 && along < HS.HOOK_RANGE - yh.dist + 0.5) {
      let px = rx - yh.dx * along, pz = rz - yh.dz * along;
      const pl = Math.hypot(px, pz);
      if (pl < 1.35 && rand() < 0.35 + skill * 0.6) {
        bot.dodgeAt = s.t + lerp(0.36, 0.14, skill) + r(0, 0.08);
        if (pl > 1e-2) { px /= pl; pz /= pl; } else { const sgn = rand() < 0.5 ? 1 : -1; px = -yh.dz * sgn; pz = yh.dx * sgn; }
        bot.ddx = px; bot.ddz = pz;
      }
    }
  }
  if (bot.dodgeAt > 0 && s.t >= bot.dodgeAt) {
    simMove(s, me, { x: u.x + bot.ddx * 2.6, z: u.z + bot.ddz * 2.6 });
    bot.dodgeAt = -1; bot.nextMove = s.t + 0.6;
  }
  if (yh.state !== "out") bot.dodgeAt = -1;
  if (s.t >= bot.nextMove && !u.windup && s.hooks[me].state === "idle") {
    const ang = Math.atan2(u.z - you.z, u.x - you.x) + r(-0.8, 0.8);
    const d = r(5.2, 8);
    simMove(s, me, { x: you.x + Math.cos(ang) * d, z: you.z + Math.sin(ang) * d });
    bot.nextMove = s.t + r(0.5, 1.3);
  }
  if (s.t >= bot.throwReadyAt && s.t >= u.cdUntil && s.hooks[me].state === "idle" && !u.windup) {
    const dist = Math.hypot(u.x - you.x, u.z - you.z);
    if (dist < HS.HOOK_RANGE * 0.93 && !segBlocked(u.x, u.z, you.x, you.z, 0.3)) {
      const lead = (dist / HS.HOOK_SPEED) * r(0.35, 1.05) * (0.6 + skill * 0.4);
      let ax = you.x + you.vx * lead - u.x, az = you.z + you.vz * lead - u.z;
      const err = (r(-1, 1) * (1 - skill) * 14 + r(-3, 3)) * (Math.PI / 180);
      const c = Math.cos(err), sn = Math.sin(err);
      [ax, az] = [ax * c - az * sn, ax * sn + az * c];
      simThrow(s, me, { x: u.x + ax, z: u.z + az });
      bot.throwReadyAt = s.t + HS.HOOK_CD + r(0.15, 1.1) * (1.3 - skill);
    } else if (rand() < 0.02) bot.nextMove = s.t;
  }
}
