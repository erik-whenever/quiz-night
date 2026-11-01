// Hooker-off i 3D: två slaktare i en arena, den som hookar den andra först tar ronden. Bäst av 3.
// Spelreglerna ligger i shared/hooksim.ts: lokalt mot en bot i demoläget, eller på servern som riktig
// 1v1 över nätet (då ritar den här filen bara servern ögonblicksbilder och skickar spelarens input).
//
// Allt är byggt av enkla låg-poly-former i kod (inga modellfiler), i samma stil som Last hit.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import {
  HS, HS_PILLARS, advanceSim, applySnap, botThink, createSim, drainEvents, handOf, newBot, simMove, simStop, simThrow, startSim,
  type HookSim, type HsEvent, type HsSnap, type P2,
} from "../shared/hooksim";

export type HookEvent =
  | { type: "countdown"; n: number | null }
  /** you = gubbe 0 (blå), bot = gubbe 1 (röd). */
  | { type: "score"; you: number; bot: number; round: number }
  | { type: "banner"; text: string; sub?: string; tone: "win" | "lose" | "info" }
  /** youWon gäller gubbe 0 i demoläget, annars "jag" (åskådare: gubbe 0). winner = 0/1. */
  | { type: "over"; youWon: boolean; winner: 0 | 1 }
  | { type: "phase"; phase: Phase };
export type Phase = "idle" | "intro" | "fight" | "roundEnd" | "over";

export interface HookOff {
  start(): void;
  /** Nätläge: en ny ögonblicksbild från servern. */
  push(snap: HsSnap): void;
  dispose(): void;
}

/** Input från spelaren i nätläge (skickas till servern). */
export type HookInput = { move: P2 } | { hook: P2 } | { stop: true };

export interface HookOffOpts {
  low?: boolean;
  botSkill?: number;
  /** "bot" (standard): du mot boten, allt lokalt. "net": servern kör matchen, vi ritar och skickar input. */
  mode?: "bot" | "net";
  /** Nätläge: vilken gubbe jag styr (0/1), null = åskådare (TV:n). */
  me?: 0 | 1 | null;
  /** Namn på gubbarna (för banderoller). */
  names?: [string, string];
  onInput?: (m: HookInput) => void;
  /** Servertid (ms), för att interpolera ögonblicksbilderna. */
  serverNow?: () => number;
}

// ===== Regler (se shared/hooksim.ts) =====
const R0 = HS.R0;
const HOOK_RANGE = HS.HOOK_RANGE;
const HOOK_CD = HS.HOOK_CD;
const PILLARS = HS_PILLARS;
/** Hur långt efter servern vi ritar, så att det finns två bilder att interpolera mellan. */
const NET_DELAY_MS = 110;

const COL = {
  skyTop: "#0b1250", skyMid: "#3b2a7a", skyLow: "#e0795a",
  fog: 0x2a2563,
  grass: [0x2f5a3a, 0x3a6b42, 0x29503a, 0x44754a],
  stone: [0x58526e, 0x4f4a64, 0x615a77, 0x544e69, 0x5c5670],
  edge: [0x3a3549, 0x413b52, 0x36324a],
  rune: 0x7ff6ff,
  fire: 0xff8a3d,
};

interface Team {
  cloth: number; dark: number; trim: number; skin: number; eye: number; glow: number;
}
const TEAMS: Team[] = [
  { cloth: 0x2b3ad0, dark: 0x18207a, trim: 0xffd23f, skin: 0xe2b28c, eye: 0xfff3c0, glow: 0xffd23f },
  { cloth: 0xa52c3c, dark: 0x5a1422, trim: 0xff8a3d, skin: 0x9aa886, eye: 0xffa040, glow: 0xff5a3a },
];

// ===== Hjälpare =====
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
function seeded(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, range: (a: number, b: number) => a + next() * (b - a) };
}

function mat(color: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, metalness: 0.05, ...extra });
}
function glow(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}
function mesh(g: THREE.BufferGeometry, m: THREE.Material, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = shadow;
  o.receiveShadow = shadow;
  return o;
}
function skyTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, COL.skyTop); g.addColorStop(0.55, COL.skyMid); g.addColorStop(0.9, COL.skyLow); g.addColorStop(1, COL.skyLow);
  x.fillStyle = g; x.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ===== Partiklar (additiva punkter som tonar mot svart) =====
function makeParticles(count: number, size: number, tex: THREE.Texture) {
  const pos = new Float32Array(count * 3).fill(-999);
  const col = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const max = new Float32Array(count);
  const base = new Float32Array(count * 3);
  const grav = new Float32Array(count);
  const drag = new Float32Array(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  points.frustumCulled = false;
  let cursor = 0;
  const c = new THREE.Color();
  return {
    points,
    spawn(p: THREE.Vector3, v: THREE.Vector3, l: number, color: number, g = 0, d = 0) {
      const i = cursor; cursor = (cursor + 1) % count;
      pos.set([p.x, p.y, p.z], i * 3); vel.set([v.x, v.y, v.z], i * 3);
      life[i] = max[i] = l; c.set(color); base.set([c.r, c.g, c.b], i * 3); grav[i] = g; drag[i] = d;
    },
    update(dt: number) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const j = i * 3;
        if (life[i] <= 0) { pos[j + 1] = -999; col[j] = col[j + 1] = col[j + 2] = 0; continue; }
        const k = 1 - drag[i] * dt;
        vel[j] *= k; vel[j + 1] = vel[j + 1] * k - grav[i] * dt; vel[j + 2] *= k;
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        const f = life[i] / max[i];
        const a = f * f * (3 - 2 * f);
        col[j] = base[j] * a; col[j + 1] = base[j + 1] * a; col[j + 2] = base[j + 2] * a;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}

// ===== Slaktaren (egen figur) =====
interface Butcher {
  root: THREE.Group;
  body: THREE.Group;
  legs: THREE.Group[];
  hookArm: THREE.Group;
  otherArm: THREE.Group;
  head: THREE.Group;
  hand: THREE.Object3D;
  blob: THREE.Mesh;
}

function makeButcher(t: Team): Butcher {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const cloth = mat(t.cloth), dark = mat(t.dark), skin = mat(t.skin);
  const trim = mat(t.trim, { metalness: 0.6, roughness: 0.35 });
  const metal = mat(0xa3a9b8, { metalness: 0.8, roughness: 0.3 });
  const leather = mat(0x5a3b26), bone = mat(0xe9dcc0);

  const legs: THREE.Group[] = [];
  for (const z of [-0.3, 0.3]) {
    const hip = new THREE.Group();
    hip.position.set(0, 0.66, z);
    const leg = mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.62, 6), dark);
    leg.position.y = -0.3; hip.add(leg);
    const boot = mesh(new THREE.BoxGeometry(0.4, 0.17, 0.27), leather);
    boot.position.set(0.07, -0.6, 0); hip.add(boot);
    body.add(hip); legs.push(hip);
  }
  const torso = mesh(new THREE.IcosahedronGeometry(0.82, 1), cloth);
  torso.scale.set(1, 0.92, 1.08); torso.position.y = 1.32; body.add(torso);
  const belly = mesh(new THREE.IcosahedronGeometry(0.6, 1), skin);
  belly.scale.set(0.85, 0.82, 1.1); belly.position.set(0.36, 1.14, 0); body.add(belly);
  // Förkläde runt framsidan (framåt = +x)
  const apron = mesh(new THREE.CylinderGeometry(0.86, 0.98, 0.9, 12, 1, true, Math.PI / 2 - 0.95, 1.9), new THREE.MeshStandardMaterial({ color: 0x6e4a2e, flatShading: true, roughness: 0.9, side: THREE.DoubleSide }));
  apron.position.y = 0.9; body.add(apron);
  const belt = mesh(new THREE.TorusGeometry(0.86, 0.06, 4, 14), trim);
  belt.rotation.x = Math.PI / 2; belt.position.y = 1.08; belt.scale.set(1, 1.08, 1); body.add(belt);
  const buckle = mesh(new THREE.BoxGeometry(0.08, 0.2, 0.24), trim);
  buckle.position.set(0.9, 1.08, 0); body.add(buckle);
  // Kedja över bröstet
  const sash = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const l = mesh(new THREE.TorusGeometry(0.075, 0.025, 4, 8), metal, false);
    const a = -0.9 + i * 0.22;
    l.position.set(Math.cos(a) * 0.82 * 0.95 + 0.02, 1.25 + a * 0.35, Math.sin(a) * 0.86);
    l.rotation.set(i % 2 ? Math.PI / 2 : 0, a, 0.6);
    sash.add(l);
  }
  body.add(sash);

  for (const z of [-0.66, 0.66]) {
    const p = mesh(new THREE.DodecahedronGeometry(0.34, 0), metal);
    p.position.set(-0.02, 1.88, z); p.scale.set(1, 0.75, 1); body.add(p);
    for (let i = 0; i < 2; i++) {
      const s = mesh(new THREE.ConeGeometry(0.07, 0.34, 4), trim);
      s.position.set(-0.12 + i * 0.2, 2.1, z * 1.05); s.rotation.x = z > 0 ? -0.35 : 0.35; body.add(s);
    }
  }

  const head = new THREE.Group();
  head.position.set(0.22, 2.08, 0);
  const skull = mesh(new THREE.IcosahedronGeometry(0.3, 1), skin);
  head.add(skull);
  const helm = mesh(new THREE.IcosahedronGeometry(0.34, 0), dark);
  helm.scale.set(1.02, 0.72, 1.02); helm.position.y = 0.11; head.add(helm);
  const jaw = mesh(new THREE.BoxGeometry(0.28, 0.14, 0.4), skin);
  jaw.position.set(0.13, -0.2, 0); head.add(jaw);
  for (let i = 0; i < 4; i++) {
    const tooth = mesh(new THREE.ConeGeometry(0.03, 0.09, 3), bone, false);
    tooth.position.set(0.27, -0.12, -0.12 + i * 0.08); head.add(tooth);
  }
  for (const z of [-0.1, 0.1]) {
    const e = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), glow(t.eye));
    e.position.set(0.28, 0.02, z); head.add(e);
  }
  for (const z of [-1, 1]) {
    const horn = mesh(new THREE.ConeGeometry(0.08, 0.42, 5), bone);
    horn.position.set(-0.02, 0.28, z * 0.27); horn.rotation.set(z * -0.7, 0, -0.35); head.add(horn);
  }
  body.add(head);

  const arm = (z: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.04, 1.78, z);
    const upper = mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.85, 6), skin);
    upper.position.y = -0.42; pivot.add(upper);
    const bracer = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.22, 6), trim);
    bracer.position.y = -0.72; pivot.add(bracer);
    const fist = mesh(new THREE.IcosahedronGeometry(0.15, 0), skin);
    fist.position.y = -0.92; pivot.add(fist);
    body.add(pivot);
    return pivot;
  };
  const hookArm = arm(0.84), otherArm = arm(-0.84);
  const hand = new THREE.Object3D();
  hand.position.y = -0.98; hookArm.add(hand);
  // Köttyxa i andra handen
  const cleaver = new THREE.Group();
  const blade = mesh(new THREE.BoxGeometry(0.46, 0.34, 0.04), metal);
  blade.position.set(0.22, -0.08, 0); cleaver.add(blade);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.03, 0.05), glow(t.glow, 0.5));
  edge.position.set(0.22, -0.25, 0); cleaver.add(edge);
  const handle = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.32, 5), leather);
  handle.rotation.z = Math.PI / 2; handle.position.set(-0.12, 0, 0); cleaver.add(handle);
  cleaver.position.y = -1.0; cleaver.rotation.z = -0.25; otherArm.add(cleaver);

  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.85, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02;
  root.add(blob);
  root.scale.setScalar(0.92);
  return { root, body, legs, hookArm, otherArm, head, hand, blob };
}

function makeHookHead(t: Team): THREE.Group {
  // Pekar längs +x, öglan vid origo
  const g = new THREE.Group();
  const metal = mat(0xc4c9d6, { metalness: 0.85, roughness: 0.25, emissive: t.glow, emissiveIntensity: 0.15 });
  const eye = mesh(new THREE.TorusGeometry(0.09, 0.03, 4, 8), metal, false);
  eye.rotation.y = Math.PI / 2; g.add(eye);
  const shank = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 5), metal, false);
  shank.rotation.z = Math.PI / 2; shank.position.x = 0.3; g.add(shank);
  const curve = mesh(new THREE.TorusGeometry(0.2, 0.05, 5, 12, Math.PI * 1.25), metal, false);
  curve.position.set(0.55, 0, 0.2); curve.rotation.z = 0; curve.rotation.x = Math.PI / 2; curve.rotation.y = 0;
  g.add(curve);
  const barb = mesh(new THREE.ConeGeometry(0.07, 0.24, 4), metal, false);
  barb.position.set(0.42, 0, 0.38); barb.rotation.z = Math.PI / 2; g.add(barb);
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), glow(t.glow, 0.55));
  core.position.set(0.55, 0, 0.2); g.add(core);
  g.scale.setScalar(1.15);
  return g;
}

// ===== Världen =====
function buildWorld(scene: THREE.Scene, high: boolean) {
  const r = seeded(777);
  const pick = (a: number[]) => a[Math.floor(r.next() * a.length)];
  const geo = new THREE.PlaneGeometry(90, 90, 80, 80).toNonIndexed();
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const hmap = new Map<string, number>();
  const height = (x: number, z: number) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (!hmap.has(k)) {
      const d = Math.hypot(x, z);
      hmap.set(k, d < R0 + 0.9 ? r.range(-0.02, 0.02) : r.range(0, 0.35) + Math.max(0, d - R0 - 3) * 0.09);
    }
    return hmap.get(k)!;
  };
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    let cx = 0, cz = 0;
    for (let j = 0; j < 3; j++) {
      const x = pos.getX(i + j), z = pos.getZ(i + j);
      pos.setY(i + j, height(x, z));
      cx += x / 3; cz += z / 3;
    }
    const d = Math.hypot(cx, cz);
    if (d < R0 + 1.1) c.set(0x221e2c);
    else c.set(pick(COL.grass));
    for (let j = 0; j < 3; j++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // Stenplattor i ringar
  const fp: number[] = [], fcol: number[] = [];
  const tile = (ra: number, rb: number, a0: number, a1: number, color: number, y: number) => {
    const sub = Math.max(1, Math.ceil(((a1 - a0) * rb) / 0.6));
    c.set(color).multiplyScalar(r.range(0.9, 1.1));
    const P = (rr: number, a: number) => [Math.cos(a) * rr, y + r.range(-0.012, 0.012), Math.sin(a) * rr];
    for (let k = 0; k < sub; k++) {
      const b0 = a0 + ((a1 - a0) * k) / sub, b1 = a0 + ((a1 - a0) * (k + 1)) / sub;
      const A = P(ra, b0), B = P(ra, b1), C = P(rb, b1), D = P(rb, b0);
      fp.push(...A, ...B, ...C, ...A, ...C, ...D);
      for (let j = 0; j < 6; j++) fcol.push(c.r, c.g, c.b);
    }
  };
  // Mittmedaljong
  const med = 1.15;
  for (let k = 0; k < 12; k++) {
    const a0 = (k / 12) * Math.PI * 2, a1 = ((k + 1) / 12) * Math.PI * 2;
    tile(0.0001, med - 0.05, a0, a1, k % 2 ? 0x6b5a7c : 0x5e4f70, 0.05);
  }
  const bands = [med, 2.25, 3.35, 4.45, 5.55, 6.65, 7.75, R0 - 0.35];
  for (let i = 0; i < bands.length - 1; i++) {
    const ra = bands[i], rb = bands[i + 1], mid = (ra + rb) / 2;
    const n = Math.max(8, Math.round((Math.PI * 2 * mid) / r.range(0.95, 1.25)));
    const off = r.range(0, 1);
    const gap = 0.045;
    for (let k = 0; k < n; k++) {
      const a0 = off + (k / n) * Math.PI * 2 + gap / mid, a1 = off + ((k + 1) / n) * Math.PI * 2 - gap / mid;
      const col = i === 3 ? pick([0x47415c, 0x4c4562]) : pick(COL.stone);
      tile(ra + gap, rb - gap, a0, a1, col, r.range(0.03, 0.06));
    }
  }
  {
    const n = 34, ra = R0 - 0.35, rb = R0 + 0.45;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2 + 0.008, a1 = ((k + 1) / n) * Math.PI * 2 - 0.008;
      tile(ra + 0.04, rb, a0, a1, pick(COL.edge), 0.09);
    }
  }
  const floorGeo = new THREE.BufferGeometry();
  floorGeo.setAttribute("position", new THREE.Float32BufferAttribute(fp, 3));
  floorGeo.setAttribute("color", new THREE.Float32BufferAttribute(fcol, 3));
  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 }));
  floor.receiveShadow = true;
  scene.add(floor);

  // Runcirkel i mitten
  const runes = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.03, 4, 96), glow(COL.rune, 0.35));
  runes.rotation.x = -Math.PI / 2; runes.position.y = 0.1; scene.add(runes);
  const runes2 = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.025, 4, 6), glow(COL.rune, 0.3));
  runes2.rotation.x = -Math.PI / 2; runes2.position.y = 0.1; scene.add(runes2);

  // Kantstenar runt arenan
  const nEdge = Math.round((2 * Math.PI * (R0 + 0.55)) / 0.72);
  const edgeStones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.42, 0), mat(0x6c6f86), nEdge);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V(), p = V();
  for (let i = 0; i < nEdge; i++) {
    const a = (i / nEdge) * Math.PI * 2;
    q.setFromEuler(new THREE.Euler(r.range(0, 3), r.range(0, 3), r.range(0, 3)));
    s.set(r.range(0.8, 1.2), r.range(0.55, 0.95), r.range(0.8, 1.2));
    m4.compose(p.set(Math.cos(a) * (R0 + 0.6), 0.12, Math.sin(a) * (R0 + 0.6)), q, s);
    edgeStones.setMatrixAt(i, m4);
    edgeStones.setColorAt(i, c.set(pick([0x6c6f86, 0x5d6178, 0x77728a])));
  }
  edgeStones.position.y = 0.05;
  edgeStones.castShadow = high; edgeStones.receiveShadow = true; scene.add(edgeStones);

  // Träd utanför arenan
  const spots: { x: number; z: number; s: number }[] = [];
  for (let i = 0; i < 260 && spots.length < 150; i++) {
    const a = r.range(0, Math.PI * 2), d = r.range(R0 + 3, 34);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (z > R0 - 3 && Math.abs(x) < 20) continue; // inte mellan kameran och arenan
    spots.push({ x, z, s: r.range(0.8, 1.6) });
  }
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(0.9, 2.2, 6), mat(0xffffff), spots.length);
  const crowns2 = new THREE.InstancedMesh(new THREE.ConeGeometry(0.7, 1.6, 6), mat(0xffffff), spots.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 0.8, 5), mat(0x5a3b26), spots.length);
  const tc = [0x1f4a3a, 0x24563f, 0x2d5f3a, 0x1b3f40];
  spots.forEach((t, i) => {
    const y0 = Math.max(0, Math.hypot(t.x, t.z) - R0 - 3) * 0.09;
    q.setFromAxisAngle(V(0, 1, 0), r.range(0, 6));
    s.setScalar(t.s);
    m4.compose(p.set(t.x, y0 + 0.4 * t.s, t.z), q, s); trunks.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, y0 + 1.7 * t.s, t.z), q, s); crowns.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, y0 + 2.6 * t.s, t.z), q, s); crowns2.setMatrixAt(i, m4);
    c.set(tc[i % tc.length]); crowns.setColorAt(i, c); crowns2.setColorAt(i, c.multiplyScalar(1.15));
  });
  for (const o of [crowns, crowns2, trunks]) { o.castShadow = high; o.receiveShadow = true; scene.add(o); }

  // Pelare med runor och svävande kristaller
  const stone = mat(0x5d6178), stoneD = mat(0x484b62);
  const gems: THREE.Mesh[] = [];
  PILLARS.forEach((pl, i) => {
    const g = new THREE.Group();
    let y = 0;
    const blocks = 3 + (i % 2);
    for (let b = 0; b < blocks; b++) {
      const h = r.range(0.5, 0.75);
      const rr = pl.r * (1 - b * 0.07);
      const blk = mesh(new THREE.CylinderGeometry(rr * 0.95, rr, h, 6), b % 2 ? stoneD : stone);
      blk.position.y = y + h / 2; blk.rotation.y = r.range(0, 1); blk.position.x = r.range(-0.04, 0.04);
      g.add(blk); y += h;
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(pl.r * 1.0, 0.035, 4, 6), glow(COL.rune, 0.8));
    band.rotation.x = Math.PI / 2; band.position.y = 0.75; g.add(band);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), new THREE.MeshStandardMaterial({ color: COL.rune, emissive: COL.rune, emissiveIntensity: 1.1, flatShading: true }));
    gem.position.y = y + 0.45; g.add(gem); gems.push(gem);
    g.position.set(pl.x, 0, pl.z);
    scene.add(g);
  });

  // Fyra eldskålar på kanten
  const braziers: { light: THREE.PointLight; at: THREE.Vector3; phase: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = [Math.PI, 0, -Math.PI / 3, (-2 * Math.PI) / 3][i];
    const at = V(Math.cos(a) * (R0 + 1.3), 0, Math.sin(a) * (R0 + 1.3));
    const g = new THREE.Group();
    const ped = mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.1, 6), stoneD);
    ped.position.y = 0.55; g.add(ped);
    const bowl = mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.32, 8), mat(0x3a2f2a, { metalness: 0.5, roughness: 0.5 }));
    bowl.position.y = 1.25; g.add(bowl);
    const coals = new THREE.Mesh(new THREE.CircleGeometry(0.48, 8), glow(0xff6a2a, 0.9));
    coals.rotation.x = -Math.PI / 2; coals.position.y = 1.4; g.add(coals);
    g.position.copy(at); scene.add(g);
    const light = new THREE.PointLight(COL.fire, 9, 13, 1.6);
    light.position.set(at.x, 2.1, at.z); scene.add(light);
    braziers.push({ light, at: V(at.x, 1.45, at.z), phase: i * 1.7 });
  }
  return { gems, braziers, runes };
}

// ===== Spelet =====
/** Det som bara behövs för att rita en gubbe (själva tillståndet finns i simuleringen). */
interface Vis {
  id: 0 | 1;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fig: Butcher;
  walk: number;
  armZ: number;
  down: number;
}
interface HookVis {
  head: THREE.Group;
  links: THREE.InstancedMesh;
  light: THREE.PointLight;
  tip: THREE.Vector3;
}

export function createHookOff(host: HTMLElement, onEvent: (e: HookEvent) => void, opts: HookOffOpts = {}): HookOff | null {
  const skill = clamp(opts.botSkill ?? 0.6, 0, 1);
  const net = opts.mode === "net";
  const me: 0 | 1 | null = net ? (opts.me ?? null) : 0;
  const names = opts.names ?? ["Du", "Boten"];
  const serverNow = opts.serverNow ?? (() => Date.now());
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  const high = !opts.low && !matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = high;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(COL.fog, 20, 48);
  const camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 140);

  scene.add(new THREE.HemisphereLight(0xa9bcff, 0x3a4a2a, 1.4));
  const sun = new THREE.DirectionalLight(0xffc48e, 2.8);
  sun.position.set(-9, 16, 7);
  sun.castShadow = high;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8a7bff, 1.3);
  rim.position.set(8, 6, -10);
  scene.add(rim);

  const world = buildWorld(scene, high);
  const tex = dotTexture();
  const sparks = makeParticles(700, 0.16, tex);
  const fire = makeParticles(500, 0.42, tex);
  scene.add(sparks.points, fire.points);

  // Damm i luften
  const moteN = 140;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteN * 3);
  for (let i = 0; i < moteN; i++) motePos.set([rand(-16, 16), rand(0.3, 6), rand(-14, 12)], i * 3);
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.14, map: tex, color: 0xffe9a8, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  scene.add(motes);

  // Krympande arena: mörk ring utanför och glödande kant
  const voidRing = new THREE.Mesh(new THREE.RingGeometry(1, 5, 96), new THREE.MeshBasicMaterial({ color: 0x14061e, transparent: true, opacity: 0, depthWrite: false }));
  voidRing.rotation.x = -Math.PI / 2; voidRing.position.y = 0.05; scene.add(voidRing);
  const edgeGlow = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 4, 160), glow(0xff3b6a, 0));
  edgeGlow.rotation.x = -Math.PI / 2; edgeGlow.position.y = 0.08; scene.add(edgeGlow);

  // Sikte för den egna gubben
  const aim = new THREE.Group();
  const aimMat = glow(TEAMS[me ?? 0].glow, 0.16);
  const aimBar = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.42), aimMat);
  aimBar.rotation.x = -Math.PI / 2; aimBar.scale.x = HOOK_RANGE - 0.6;
  aimBar.position.x = (HOOK_RANGE - 0.6) / 2 + 0.3;
  const tri = new THREE.Shape([new THREE.Vector2(0, 0.42), new THREE.Vector2(0.6, 0), new THREE.Vector2(0, -0.42)]);
  const aimHead = new THREE.Mesh(new THREE.ShapeGeometry(tri), aimMat);
  aimHead.rotation.x = -Math.PI / 2; aimHead.position.x = HOOK_RANGE - 0.3;
  aim.add(aimBar, aimHead); aim.position.y = 0.06; scene.add(aim);

  const DASH = 36;
  const ringG = new THREE.BoxGeometry(0.11, 0.02, 0.05);
  const rings = [0, 1].map((i) => {
    const m = new THREE.InstancedMesh(ringG, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), DASH);
    const m4 = new THREE.Matrix4();
    for (let d = 0; d < DASH; d++) {
      const a = (d / DASH) * Math.PI * 2;
      m4.makeRotationY(-a + Math.PI / 2).setPosition(Math.cos(a) * 0.95, 0.06, Math.sin(a) * 0.95);
      m.setMatrixAt(d, m4);
      m.setColorAt(d, new THREE.Color(TEAMS[i].glow));
    }
    scene.add(m);
    return m;
  });

  // Klickmarkör
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.4, 24), glow(0x2fe08f, 0));
  marker.rotation.x = -Math.PI / 2; marker.position.y = 0.07; scene.add(marker);
  let markerT = -1;

  const vis: Vis[] = [0, 1].map((i) => {
    const fig = makeButcher(TEAMS[i]);
    scene.add(fig.root);
    return { id: i as 0 | 1, pos: V(), vel: V(), fig, walk: 0, armZ: 0.2, down: 0 };
  });
  const linkG = new THREE.TorusGeometry(0.075, 0.024, 4, 8);
  const linkMat = mat(0x9aa0ad, { metalness: 0.85, roughness: 0.3 });
  const MAXL = 90;
  const hookVis: HookVis[] = vis.map((u) => {
    const head = makeHookHead(TEAMS[u.id]);
    scene.add(head);
    const links = new THREE.InstancedMesh(linkG, linkMat, MAXL);
    links.castShadow = high; links.count = 0; links.frustumCulled = false;
    scene.add(links);
    const light = new THREE.PointLight(TEAMS[u.id].glow, 0, 4, 1.8);
    scene.add(light);
    return { head, links, light, tip: V() };
  });

  // ===== Tillstånd =====
  // Botläget: `sim` är sanningen. Nätläget: `sim` fylls från interpolerade ögonblicksbilder.
  const sim: HookSim = createSim();
  const bot = newBot(skill);
  const snaps: HsSnap[] = [];
  let lastEvAt = 0;
  let shake = 0;
  let punch = 0;
  const punchAt = V();
  const mouse = V(4, 0, 0);
  let lastScore = "";

  const sendInput = (m: HookInput) => {
    if (!net) {
      if ("move" in m) simMove(sim, 0, m.move);
      else if ("hook" in m) simThrow(sim, 0, m.hook);
      else simStop(sim, 0);
    } else if (me !== null) opts.onInput?.(m);
  };

  function start() {
    if (net) return; // servern startar
    startSim(sim);
    onEvent({ type: "score", you: 0, bot: 0, round: 1 });
  }

  // ===== Input =====
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(V(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const toGround = (ev: { clientX: number; clientY: number }, out: THREE.Vector3) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(plane, out);
  };
  let moving = false;
  let lastMoveSent = 0;
  /** Mobil: tryck på KROK-knappen och sedan där kroken ska. */
  let aimNext = false;
  const orderMove = (ev: PointerEvent, force = false) => {
    if (me === null) return;
    const p = V();
    if (!toGround(ev, p)) return;
    if (sim.phase !== "fight" && sim.phase !== "intro") return;
    const now = performance.now();
    if (!force && net && now - lastMoveSent < 90) return; // högst ~11 st/s över nätet
    lastMoveSent = now;
    sendInput({ move: { x: p.x, z: p.z } });
    marker.position.set(p.x, 0.07, p.z); markerT = 0;
  };
  const onDown = (ev: PointerEvent) => {
    toGround(ev, mouse);
    if (ev.pointerType === "touch") {
      if (aimNext) { aimNext = false; throwAtMouse(); return; }
      orderMove(ev, true);
      return;
    }
    if (ev.button === 2 || ev.button === 0) { moving = true; orderMove(ev, true); }
  };
  const onMove = (ev: PointerEvent) => {
    toGround(ev, mouse);
    if (moving && ev.buttons) orderMove(ev);
  };
  const onUp = () => { moving = false; };
  const throwAtMouse = () => { if (me !== null) sendInput({ hook: { x: mouse.x, z: mouse.z } }); };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.repeat || me === null) return;
    const k = ev.key.toLowerCase();
    if (k === "q" || k === " " || k === "w") { ev.preventDefault(); throwAtMouse(); }
    if (k === "s") sendInput({ stop: true });
  };
  const noMenu = (e: Event) => e.preventDefault();
  renderer.domElement.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
  renderer.domElement.addEventListener("contextmenu", noMenu);
  /** Mobilens KROK-knapp: nästa tryck i arenan kastar dit. */
  (host as HTMLElement & { aimHook?: () => void }).aimHook = () => { aimNext = true; };

  // ===== Effekter från händelser =====
  function burst(at: THREE.Vector3, n: number, colors: number[], speed: number, life = 0.7, g = 6) {
    for (let i = 0; i < n; i++) {
      const v = V(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      sparks.spawn(at, v, life * rand(0.6, 1.2), colors[i % colors.length], g, 1.5);
    }
  }
  function handle(e: HsEvent) {
    if (e.k === "count") onEvent({ type: "countdown", n: e.n });
    else if (e.k === "hit") {
      shake = 0.5; punch = 1; punchAt.set(sim.units[1 - e.u].x, 0, sim.units[1 - e.u].z);
      burst(V(e.x, 1.1, e.z), 70, [TEAMS[e.u].glow, 0xffffff, 0xffe9a8], 8, 0.8);
      const mine = me === null ? null : e.u === me;
      onEvent({ type: "banner", text: "HOOKAD!", sub: me === e.u ? `Du fick tag i ${names[1 - e.u]}` : me === 1 - e.u ? `${names[e.u]} fick tag i dig` : `${names[e.u]} fick tag i ${names[1 - e.u]}`,
        tone: mine === null ? "info" : mine ? "win" : "lose" });
    } else if (e.k === "block") {
      burst(V(e.x, 1.1, e.z), 22, [0xffe9a8, 0xffd23f], 5, 0.45);
      shake = Math.max(shake, 0.08);
    } else if (e.k === "shrink") onEvent({ type: "banner", text: "Arenan krymper!", tone: "info" });
    else if (e.k === "round") {
      vis[1 - e.w].down = 0.001;
      shake = 0.7; punch = 1; punchAt.set(sim.units[e.w].x, 0, sim.units[e.w].z);
      burst(V(e.x, 1.3, e.z), 110, [TEAMS[e.w].glow, 0xffffff, 0xff7a3d, 0xffe9a8], 10, 1.0, 9);
    } else if (e.k === "over") {
      onEvent({ type: "over", winner: e.w, youWon: (me ?? 0) === e.w });
    } else if (e.k === "phase") onEvent({ type: "phase", phase: e.p });
  }

  // ===== Nätläge: interpolera ögonblicksbilder =====
  const angLerp = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
  function netUpdate() {
    if (!snaps.length) return;
    const rt = serverNow() - NET_DELAY_MS;
    // Händelser när deras bild blir aktuell (så effekterna hamnar där gubbarna är)
    while (snaps.length > 2 && snaps[1].at <= rt) snaps.shift();
    let a = snaps[0], b = snaps[1] ?? snaps[0];
    if (rt < a.at) b = a;
    for (const s of snaps) if (s.at <= rt && s.at > lastEvAt) {
      lastEvAt = s.at;
      applySnap(sim, s);
      for (const e of s.ev) handle(e);
    }
    if (rt < a.at) a = b = snaps[0];
    const k = b.at > a.at ? clamp((rt - a.at) / (b.at - a.at), 0, 1) : 0;
    applySnap(sim, b);
    for (const i of [0, 1] as const) {
      const ua = a.u[i], u = sim.units[i];
      u.x = lerp(ua[0], b.u[i][0], k); u.z = lerp(ua[1], b.u[i][1], k); u.face = angLerp(ua[2], b.u[i][2], k);
      const ha = a.h[i], hb = b.h[i], h = sim.hooks[i];
      if (ha[0] === hb[0]) { h.x = lerp(ha[1], hb[1], k); h.z = lerp(ha[2], hb[2], k); }
    }
  }

  // ===== Grafik =====
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), sc = V(), tmp = V();
  const X = V(1, 0, 0);
  const handPos = (u: Vis, out = V()) => {
    u.fig.root.updateMatrixWorld(true);
    return u.fig.hand.getWorldPosition(out);
  };
  function drawChain(h: HookVis, out: boolean, from: THREE.Vector3, to: THREE.Vector3, sag: number, t: number) {
    const d = V().subVectors(to, from);
    const L = d.length();
    const n = Math.min(MAXL, Math.max(2, Math.floor(L / 0.15)));
    const dir = d.clone().normalize();
    q.setFromUnitVectors(X, dir);
    sc.set(1.35, 1, 1);
    for (let i = 0; i < n; i++) {
      const kk = (i + 0.5) / n;
      tmp.copy(from).addScaledVector(d, kk);
      tmp.y -= Math.sin(kk * Math.PI) * sag;
      tmp.y += Math.sin(kk * 14 - t * 0.03) * 0.02 * (out ? 1 : 0);
      q2.setFromAxisAngle(X, i % 2 ? Math.PI / 2 : 0);
      m4.compose(tmp, q.clone().multiply(q2), sc);
      h.links.setMatrixAt(i, m4);
    }
    h.links.count = n;
    h.links.instanceMatrix.needsUpdate = true;
  }

  let composer: EffectComposer | null = null;
  const setupComposer = () => {
    composer?.dispose();
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.82));
    composer.addPass(new OutputPass());
  };
  if (high) setupComposer();
  const resize = () => {
    const W = host.clientWidth || 800, H = host.clientHeight || 500;
    renderer.setSize(W, H, false);
    composer?.setSize(W, H);
    camera.aspect = W / H;
    camera.fov = clamp((2 * Math.atan(0.42 / Math.min(1, camera.aspect / 1.5)) * 180) / Math.PI, 38, 70);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const CAM_OFF = V(0, 14, 12.6);
  const camFocus = V();
  let last = performance.now();
  let raf = 0;
  let disposed = false;

  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const nowMs = performance.now();
    const rdt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    if (net) netUpdate();
    else {
      advanceSim(sim, rdt, (s) => botThink(s, 1, bot, skill));
      for (const e of drainEvents(sim)) handle(e);
    }
    const sc0 = `${sim.score[0]}-${sim.score[1]}-${sim.round}`;
    if (sc0 !== lastScore && sim.round > 0) { lastScore = sc0; onEvent({ type: "score", you: sim.score[0], bot: sim.score[1], round: sim.round }); }
    const t = nowMs;
    const phase = sim.phase;

    // Figurer
    for (const u of vis) {
      const su = sim.units[u.id];
      u.pos.set(su.x, 0, su.z); u.vel.set(su.vx, 0, su.vz);
      if (!su.down && u.down > 0) u.down = 0; // ny rond
      const f = u.fig;
      f.root.position.set(u.pos.x, 0, u.pos.z);
      f.root.rotation.y = su.face;
      const walking = u.vel.lengthSq() > 0.5 && !su.hooked;
      if (!walking) u.walk = lerp(u.walk, Math.round(u.walk / Math.PI) * Math.PI, Math.min(1, rdt * 10));
      else u.walk += rdt * 11;
      const sw = Math.sin(u.walk);
      f.legs[0].rotation.z = sw * 0.6; f.legs[1].rotation.z = -sw * 0.6;
      f.body.position.y = Math.abs(sw) * 0.07 + Math.sin(t / 420 + u.id) * 0.015;
      f.body.rotation.set(sw * 0.06, 0, 0);
      f.otherArm.rotation.z = -sw * 0.45 + 0.15; f.otherArm.rotation.x = 0.18;
      const h = sim.hooks[u.id];
      let wantArm = 0.2 + sw * 0.35;
      if (su.windup) wantArm = -1.1;
      else if (h.state === "out" || h.state === "pull") wantArm = 1.5;
      else if (h.state === "back") wantArm = 1.0;
      u.armZ = lerp(u.armZ, wantArm, Math.min(1, rdt * (su.windup ? 24 : 14)));
      f.hookArm.rotation.z = u.armZ; f.hookArm.rotation.x = -0.2;
      f.root.scale.setScalar(0.92);
      if (su.hooked && u.down === 0) {
        f.body.rotation.z = Math.sin(t / 50) * 0.25;
        f.hookArm.rotation.z = 2.6 + Math.sin(t / 70) * 0.3; f.otherArm.rotation.z = 2.4 + Math.cos(t / 60) * 0.3;
      }
      if (su.down && u.down === 0) u.down = 0.001;
      if (u.down > 0) {
        u.down = Math.min(1, u.down + rdt * 2.2);
        const k = 1 - (1 - u.down) ** 3;
        f.body.rotation.z = lerp(0, 1.45, k);
        f.body.position.y = lerp(0, -0.25, k);
        f.root.scale.set(0.92 * (1 + Math.sin(u.down * 12) * 0.08 * (1 - k)), 0.92, 0.92);
      }
      if (walking && Math.random() < rdt * 10) fire.spawn(V(u.pos.x + rand(-0.2, 0.2), 0.1, u.pos.z + rand(-0.2, 0.2)), V(rand(-0.3, 0.3), rand(0.3, 0.6), rand(-0.3, 0.3)), 0.6, 0x3a3044, -0.3, 1.5);
    }

    // Krokar och kedjor
    hookVis.forEach((hv, i) => {
      const h = sim.hooks[i];
      const owner = vis[i];
      const hp = handPos(owner);
      if (h.state === "idle") {
        const sway = Math.sin(t / 300 + i) * 0.06;
        const tip = V(hp.x + sway, hp.y - 0.5, hp.z);
        hv.head.position.copy(tip);
        hv.head.rotation.set(0, sim.units[i].face, -Math.PI / 2 + sway);
        drawChain(hv, false, hp, tip, 0, t);
        hv.light.intensity = lerp(hv.light.intensity, 0, Math.min(1, rdt * 10));
      } else {
        // Simuleringens krokspets ligger i planet; i bild utgår den från den riktiga handen.
        const sh = handOf(sim.units[i]);
        hv.tip.set(h.x + (hp.x - sh.x) * 0.15, 1.1, h.z + (hp.z - sh.z) * 0.15);
        hv.head.position.copy(hv.tip);
        hv.head.rotation.set(0, Math.atan2(-h.dz, h.dx), 0);
        if (h.state === "out") hv.head.rotation.x = t / 40;
        drawChain(hv, h.state === "out", hp, hv.tip, h.state === "back" ? 0.25 : 0.05, t);
        hv.light.position.copy(hv.tip);
        hv.light.intensity = lerp(hv.light.intensity, 8, Math.min(1, rdt * 12));
        if (h.state === "out" && Math.random() < 0.9) sparks.spawn(hv.tip, V(rand(-0.4, 0.4), rand(0, 0.5), rand(-0.4, 0.4)), 0.35, TEAMS[i].glow, 0, 2);
        if (h.state === "pull" && Math.random() < 0.6) { const v = sim.units[1 - i]; sparks.spawn(V(v.x, 0.15, v.z), V(rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)), 0.5, 0x9a8a78, 3, 2); }
      }
    });

    // Cooldownringar
    rings.forEach((ring, i) => {
      const su = sim.units[i];
      ring.position.set(su.x, 0, su.z);
      const ready = clamp(1 - (su.cdUntil - sim.t) / HOOK_CD, 0, 1);
      const lit = Math.round(ready * DASH);
      const c = new THREE.Color();
      for (let d = 0; d < DASH; d++) {
        c.set(TEAMS[i].glow).multiplyScalar(d < lit ? (ready >= 1 ? 1.6 : 0.9) : 0.12);
        ring.setColorAt(d, c);
      }
      ring.instanceColor!.needsUpdate = true;
      ring.visible = phase !== "idle" && vis[i].down === 0;
    });

    // Sikte (bara för den som spelar)
    if (me !== null) {
      const mu = sim.units[me];
      const ready = mu.cdUntil - sim.t <= 0 && sim.hooks[me].state === "idle" && !mu.hooked;
      aim.visible = (phase === "fight" || phase === "intro") && !mu.hooked;
      aim.position.set(mu.x, 0.06, mu.z);
      aim.rotation.y = Math.atan2(-(mouse.z - mu.z), mouse.x - mu.x);
      aimMat.opacity = lerp(aimMat.opacity, ready ? (aimNext ? 0.45 : 0.2) : 0.05, Math.min(1, rdt * 10));
    } else aim.visible = false;

    // Klickmarkör
    if (markerT >= 0) {
      markerT += rdt;
      const k = markerT / 0.45;
      (marker.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      marker.scale.setScalar(1.4 - k * 0.8);
      if (k >= 1) markerT = -1;
    }

    // Arenans kant
    const radius = sim.radius;
    const shrinking = radius < R0 - 0.01;
    voidRing.scale.set(radius, radius, 1);
    edgeGlow.scale.set(radius, radius, 1);
    (voidRing.material as THREE.MeshBasicMaterial).opacity = lerp((voidRing.material as THREE.MeshBasicMaterial).opacity, shrinking ? 0.72 : 0, Math.min(1, rdt * 3));
    (edgeGlow.material as THREE.MeshBasicMaterial).opacity = lerp((edgeGlow.material as THREE.MeshBasicMaterial).opacity, shrinking ? 0.9 : 0, Math.min(1, rdt * 3));
    if (shrinking) for (let i = 0; i < 3; i++) {
      const a = rand(0, Math.PI * 2);
      fire.spawn(V(Math.cos(a) * radius, 0.1, Math.sin(a) * radius), V(0, rand(0.6, 1.4), 0), rand(0.5, 1), 0xff3b6a, -0.5, 1);
    }

    // Eld, kristaller, damm
    for (const b of world.braziers) {
      b.light.intensity = 8 + Math.sin(t / 90 + b.phase) * 1.2 + Math.sin(t / 37 + b.phase * 2) * 0.8;
      for (let i = 0; i < 2; i++) fire.spawn(V(b.at.x + rand(-0.25, 0.25), b.at.y, b.at.z + rand(-0.25, 0.25)), V(rand(-0.15, 0.15), rand(1.2, 2.2), rand(-0.15, 0.15)), rand(0.4, 0.75), Math.random() < 0.3 ? 0xffd23f : 0xff6a2a, -0.8, 1.2);
    }
    world.gems.forEach((g, i) => { g.rotation.y = t / 700 + i; g.position.y += Math.sin(t / 500 + i) * 0.002; });
    world.runes.rotation.z = t / 9000;
    for (let i = 0; i < moteN; i++) {
      motePos[i * 3 + 1] += rdt * 0.12;
      motePos[i * 3] += Math.sin(t / 2000 + i) * rdt * 0.1;
      if (motePos[i * 3 + 1] > 6.5) motePos[i * 3 + 1] = 0.3;
    }
    moteGeo.attributes.position.needsUpdate = true;
    sparks.update(rdt * Math.max(sim.timeScale, 0.4));
    fire.update(rdt);

    // Kamera: följer lite mot den egna gubben (åskådare: mitt emellan), rycker in vid träff
    const focus = me !== null ? vis[me].pos : V().addVectors(vis[0].pos, vis[1].pos).multiplyScalar(0.5);
    const focusWant = phase === "idle" ? V(Math.sin(t / 4000) * 1.5, 0, 0) : V(focus.x * 0.3, 0, focus.z * 0.25 + 0.4);
    camFocus.lerp(focusWant, Math.min(1, rdt * 2.5));
    punch = Math.max(0, punch - rdt * 0.7);
    const pp = punch * punch;
    const look = camFocus.clone().lerp(punchAt, pp * 0.6);
    const pos = look.clone().add(CAM_OFF.clone().multiplyScalar(1 - pp * 0.35));
    if (phase === "idle") pos.x += Math.sin(t / 3000) * 2;
    camera.position.copy(pos);
    shake = Math.max(0, shake - rdt * 1.6);
    if (shake > 0) { camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake; }
    camera.lookAt(look);

    if (composer) composer.render(); else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    start,
    push(snap: HsSnap) {
      snaps.push(snap);
      if (snaps.length > 40) snaps.splice(0, snaps.length - 40);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      composer?.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        mats.forEach((x) => { (x as THREE.MeshBasicMaterial).map?.dispose(); x.dispose(); });
      });
      (scene.background as THREE.Texture | null)?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
