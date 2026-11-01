// Häll upp i 3D: bara grafik. All spellogik (nivå, skum, spill) ligger kvar i Pour i skill.tsx.
// Scenen ritar det den får via getFrame() och spelar ett intro där en iskall burk plockas ur frysen,
// öppnas och hålls över glaset. Pour väntar med Häll-knappen tills introDone() är sant.
// Laddas med dynamisk import. Saknas WebGL returnerar createPourScene null och Pour visar 2D-glaset.
//
// Allt är byggt av enkla former i kod (inga modellfiler). Burken har en egen Kronan-etikett.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface PourFrame {
  phase: "idle" | "pour" | "foam" | "done";
  /** Nivå i procent av glaset (0–100), inklusive skum. */
  level: number;
  /** Strecket i procent. */
  target: number;
}
export type PourEvent = { type: "spill" } | { type: "done"; diff: number };
export interface PourScene {
  introDone(): boolean;
  event(e: PourEvent): void;
  dispose(): void;
}

const INTRO_MS = 2300;
const GLASS_H = 2.5;
const BASE_T = 0.14;          // glasets botten
const INNER_H = GLASS_H - BASE_T - 0.04;
const R_BOT = 0.56, R_TOP = 0.7;
const WALL = 0.045;
const LIQ = 0xe2ff3d;         // citrusgul energidryck
const LIQ_DEEP = 0x8fd11a;
const FOAM = 0xfaf8e0;
const SIGNAL = 0xffd23f;

const now = () => performance.now();
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const easeOut = (k: number) => 1 - (1 - clamp(k, 0, 1)) ** 3;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const innerR = (y: number) => lerp(R_BOT, R_TOP, clamp(y / GLASS_H, 0, 1)) - WALL;
const levelY = (pct: number) => BASE_T + (clamp(pct, 0, 100) / 100) * INNER_H;

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
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function bgTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#070b3a"); g.addColorStop(0.6, "#141a5e"); g.addColorStop(1, "#1b1446");
  x.fillStyle = g; x.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Etiketten runt burken: ultramarin, signalgul krona, frost. */
function labelTexture(): THREE.Texture {
  const W = 1024, H = 512;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#2433c9"); g.addColorStop(0.5, "#1b28a8"); g.addColorStop(1, "#0b1150");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // Diagonala ränder
  x.save();
  x.globalAlpha = 0.12; x.fillStyle = "#aab3ff";
  for (let i = -H; i < W; i += 70) { x.beginPath(); x.moveTo(i, H); x.lineTo(i + 30, H); x.lineTo(i + 30 + H, 0); x.lineTo(i + H, 0); x.fill(); }
  x.restore();
  // Gult band
  x.fillStyle = "#ffd23f"; x.fillRect(0, H * 0.74, W, 26);
  x.fillStyle = "#070b3a"; x.fillRect(0, H * 0.74 + 26, W, 6);
  // Två varv krona + text så att något alltid syns framifrån
  for (const cx of [W * 0.25, W * 0.75]) {
    x.save();
    x.translate(cx, H * 0.3);
    x.fillStyle = "#ffd23f";
    x.shadowColor = "rgba(255,210,63,0.6)"; x.shadowBlur = 18;
    x.beginPath();
    x.moveTo(-90, 50); x.lineTo(-100, -40); x.lineTo(-50, 5); x.lineTo(0, -60); x.lineTo(50, 5); x.lineTo(100, -40); x.lineTo(90, 50); x.closePath();
    x.fill();
    x.shadowBlur = 0;
    x.fillStyle = "#070b3a";
    for (const px of [-45, 0, 45]) { x.beginPath(); x.arc(px, 28, 9, 0, Math.PI * 2); x.fill(); }
    x.restore();
    x.fillStyle = "#f4f5ff";
    x.font = "900 92px 'Bricolage Grotesque', system-ui, sans-serif";
    x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("KRONAN", cx, H * 0.55);
    x.fillStyle = "#ffd23f";
    x.font = "800 30px 'Bricolage Grotesque', system-ui, sans-serif";
    x.fillText("E N E R G Y", cx, H * 0.67);
    x.fillStyle = "#070b3a";
    x.font = "800 22px system-ui, sans-serif";
    x.fillText("ISKALL · 500 ML", cx, H * 0.74 + 14);
  }
  // Frost och kondens
  for (let i = 0; i < 2600; i++) {
    const px = Math.random() * W, py = Math.random() * H;
    x.fillStyle = `rgba(230,245,255,${Math.random() * 0.22})`;
    x.fillRect(px, py, rand(1, 3), rand(1, 3));
  }
  for (let i = 0; i < 160; i++) {
    const px = Math.random() * W, py = Math.random() * H, r = rand(2, 7);
    const d = x.createRadialGradient(px - r * 0.3, py - r * 0.3, 0, px, py, r);
    d.addColorStop(0, "rgba(255,255,255,0.85)"); d.addColorStop(0.5, "rgba(210,235,255,0.35)"); d.addColorStop(1, "rgba(200,230,255,0)");
    x.fillStyle = d; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
  }
  // Frostkant upptill och nertill
  for (const [y0, y1] of [[0, 40], [H - 30, H]]) {
    const f = x.createLinearGradient(0, y0, 0, y1);
    f.addColorStop(y0 === 0 ? 0 : 1, "rgba(235,248,255,0.55)"); f.addColorStop(y0 === 0 ? 1 : 0, "rgba(235,248,255,0)");
    x.fillStyle = f; x.fillRect(0, y0, W, y1 - y0);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeParticles(count: number, size: number, tex: THREE.Texture, blending: THREE.Blending = THREE.AdditiveBlending) {
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
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending, toneMapped: false }));
  points.frustumCulled = false;
  let cursor = 0;
  const c = new THREE.Color();
  return {
    points,
    /** Valfri gräns: partikeln dör när den passerar y (för bubblor som når ytan). */
    ceil: new Float32Array(count).fill(99),
    spawn(p: THREE.Vector3, v: THREE.Vector3, l: number, color: number, g = 0, d = 0, ceil = 99) {
      const i = cursor; cursor = (cursor + 1) % count;
      pos.set([p.x, p.y, p.z], i * 3); vel.set([v.x, v.y, v.z], i * 3);
      life[i] = max[i] = l; c.set(color); base.set([c.r, c.g, c.b], i * 3); grav[i] = g; drag[i] = d;
      this.ceil[i] = ceil;
    },
    update(dt: number, ceilNow?: number) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const j = i * 3;
        const top = this.ceil[i] < 98 && ceilNow !== undefined ? ceilNow : this.ceil[i];
        if (life[i] <= 0 || pos[j + 1] > top) { life[i] = 0; pos[j + 1] = -999; col[j] = col[j + 1] = col[j + 2] = 0; continue; }
        const k = 1 - drag[i] * dt;
        vel[j] *= k; vel[j + 1] = vel[j + 1] * k - grav[i] * dt; vel[j + 2] *= k;
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        const f = life[i] / max[i];
        const a = Math.min(1, f * 3) * Math.min(1, (max[i] - life[i]) * 8);
        col[j] = base[j] * a; col[j + 1] = base[j + 1] * a; col[j + 2] = base[j + 2] * a;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}

// ===== Burken =====
interface Can { root: THREE.Group; tab: THREE.Mesh; mouth: THREE.Object3D }
function makeCan(label: THREE.Material, high: boolean): Can {
  const root = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xcfd6e2, metalness: 0.9, roughness: 0.28 });
  const H = 1.3, R = 0.33;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 48, 1, true), label);
  body.castShadow = high; root.add(body);
  const neck = mesh(new THREE.CylinderGeometry(R * 0.82, R, 0.14, 48, 1, true), metal);
  neck.position.y = H / 2 + 0.07; root.add(neck);
  const rim = mesh(new THREE.TorusGeometry(R * 0.82, 0.025, 6, 48), metal);
  rim.rotation.x = Math.PI / 2; rim.position.y = H / 2 + 0.15; root.add(rim);
  const lid = mesh(new THREE.CircleGeometry(R * 0.8, 48), metal);
  lid.rotation.x = -Math.PI / 2; lid.position.y = H / 2 + 0.13; root.add(lid);
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), new THREE.MeshBasicMaterial({ color: 0x0a0a12 }));
  hole.rotation.x = -Math.PI / 2; hole.scale.set(1.4, 1, 1); hole.position.set(-0.15, H / 2 + 0.135, 0); root.add(hole);
  const tab = mesh(new THREE.BoxGeometry(0.22, 0.02, 0.12), metal);
  tab.position.set(0.03, H / 2 + 0.15, 0); root.add(tab);
  const foot = mesh(new THREE.CylinderGeometry(R, R * 0.8, 0.1, 48, 1, true), metal);
  foot.position.y = -H / 2 - 0.05; root.add(foot);
  const bottom = mesh(new THREE.CircleGeometry(R * 0.8, 32), metal);
  bottom.rotation.x = Math.PI / 2; bottom.position.y = -H / 2 - 0.1; root.add(bottom);
  const mouth = new THREE.Object3D();
  mouth.position.set(-0.2, H / 2 + 0.15, 0); root.add(mouth);
  return { root, tab, mouth };
}

// ===== Frysen =====
function makeFreezer(label: THREE.Material, high: boolean) {
  const root = new THREE.Group();
  const shell = mat(0xdfe4ee, { roughness: 0.45, metalness: 0.2, flatShading: false });
  const W = 2.2, H = 3.6, D = 1.5, T = 0.12;
  const parts: [number, number, number, number, number, number][] = [
    [W, T, D, 0, H - T / 2, 0], [W, T, D, 0, T / 2, 0],
    [T, H, D, -W / 2 + T / 2, H / 2, 0], [T, H, D, W / 2 - T / 2, H / 2, 0],
  ];
  for (const [w, h, d, x, y, z] of parts) { const m = mesh(new THREE.BoxGeometry(w, h, d), shell); m.position.set(x, y, z); root.add(m); }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W - T * 2, H - T * 2), new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x4f9fd8, emissiveIntensity: 0.32, roughness: 1 }));
  back.position.set(0, H / 2, -D / 2 + 0.02); root.add(back);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0xe8f6ff, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.1 });
  const shelves = [0.95, 1.85, 2.75];
  for (const y of shelves) { const s = mesh(new THREE.BoxGeometry(W - T * 2, 0.05, D - 0.1), shelfMat, false); s.position.set(0, y, 0.02); root.add(s); }
  // Burkar och isbitar på hyllorna
  const canG = new THREE.CylinderGeometry(0.2, 0.2, 0.78, 20);
  const cans = new THREE.InstancedMesh(canG, label, 12);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  let n = 0;
  for (const [si, y] of shelves.entries()) for (let i = 0; i < 4; i++) {
    if (si === 1 && i === 1) continue; // den som plockas
    const x = -0.68 + i * 0.45, z = (i % 2) * 0.18 - 0.2;
    q.setFromAxisAngle(V(0, 1, 0), rand(0, 6));
    m4.compose(V(x, y + 0.42, z), q, V(1, 1, 1));
    cans.setMatrixAt(n++, m4);
  }
  cans.count = n; cans.castShadow = high; root.add(cans);
  const ice = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.12, 0), new THREE.MeshStandardMaterial({ color: 0xd8f3ff, emissive: 0x4aa8d8, emissiveIntensity: 0.4, transparent: true, opacity: 0.85, roughness: 0.15, flatShading: true }), 30);
  for (let i = 0; i < 30; i++) {
    const y = shelves[i % 3] + 0.06;
    m4.compose(V(rand(-0.9, 0.9), y, rand(-0.5, 0.6)), q.setFromEuler(new THREE.Euler(rand(0, 3), rand(0, 3), 0)), V(1, rand(0.5, 1), 1).multiplyScalar(rand(0.6, 1.2)));
    ice.setMatrixAt(i, m4);
  }
  root.add(ice);
  // Frost längs kanterna
  const frost = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 4, 4), glow(0xcdeeff, 0.35));
  frost.rotation.z = Math.PI / 4; frost.scale.set(W * 0.68, H * 0.68, 1); frost.position.set(0, H / 2, D / 2 - 0.05);
  root.add(frost);
  // Dörren, gångjärn på vänster sida
  const hinge = new THREE.Group();
  hinge.position.set(-W / 2, 0, D / 2);
  const door = mesh(new THREE.BoxGeometry(W, H, 0.14), shell);
  door.position.set(W / 2, H / 2, 0.07); hinge.add(door);
  const handle = mesh(new THREE.BoxGeometry(0.08, 1.1, 0.1), mat(0x8a93a8, { metalness: 0.7, roughness: 0.3 }));
  handle.position.set(W - 0.2, H * 0.55, 0.2); hinge.add(handle);
  const inner = mesh(new THREE.BoxGeometry(W - 0.3, H - 0.3, 0.05), mat(0xc8d6e6, { roughness: 0.6 }));
  inner.position.set(W / 2, H / 2, -0.03); hinge.add(inner);
  root.add(hinge);
  const light = new THREE.PointLight(0x9fdcff, 0, 7, 1.4);
  light.position.set(0, H * 0.6, D / 2 + 0.4); root.add(light);
  return { root, hinge, light, pickAt: V(-0.68 + 0.45, shelves[1] + 0.42, 0) };
}

export function createPourScene(host: HTMLElement, getFrame: () => PourFrame, low = false): PourScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  const high = !low;
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = high;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "lh3d-canvas";
  host.appendChild(renderer.domElement);

  // Överlägg för banner och blixt (samma klasser som Last hit)
  const overlay = document.createElement("div");
  overlay.className = "lh3d-overlay";
  const flashEl = document.createElement("div");
  flashEl.className = "lh3d-flash";
  const bannerEl = document.createElement("div");
  bannerEl.className = "lh3d-banner";
  overlay.append(flashEl, bannerEl);
  host.appendChild(overlay);
  const banner = (text: string, kind: "hit" | "denied") => {
    bannerEl.textContent = text;
    bannerEl.className = `lh3d-banner ${kind}`;
    void bannerEl.offsetWidth;
    bannerEl.className = `lh3d-banner ${kind} show`;
    flashEl.className = `lh3d-flash ${kind}`;
    void flashEl.offsetWidth;
    flashEl.className = `lh3d-flash ${kind} on`;
  };

  const scene = new THREE.Scene();
  scene.background = bgTexture();
  scene.fog = new THREE.Fog(0x0e1250, 9, 22);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);

  scene.add(new THREE.HemisphereLight(0x8a96ff, 0x1a1030, 0.9));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
  key.position.set(3, 7, 5);
  key.castShadow = high;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 6, bottom: -2, near: 1, far: 20 });
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7f9bff, 1.6);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  const neonLight = new THREE.PointLight(SIGNAL, 6, 9, 1.5);
  neonLight.position.set(-1.2, 4.0, -0.9);
  scene.add(neonLight);

  // Bänken och väggen
  const counter = new THREE.Group();
  const topGeo = new THREE.BoxGeometry(12, 0.24, 3.4, 24, 1, 8).toNonIndexed();
  const tc: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < topGeo.attributes.position.count; i += 3) {
    c.set([0x2a2440, 0x2f2848, 0x26203a, 0x332b4e][Math.floor(Math.random() * 4)]);
    for (let j = 0; j < 3; j++) tc.push(c.r, c.g, c.b);
  }
  topGeo.setAttribute("color", new THREE.Float32BufferAttribute(tc, 3));
  topGeo.computeVertexNormals();
  const top = mesh(topGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.15, flatShading: true }));
  top.position.set(0, -0.12, 0.4); counter.add(top);
  const front = mesh(new THREE.BoxGeometry(12, 3, 0.2), mat(0x151a52));
  front.position.set(0, -1.74, 2.0); counter.add(front);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(12, 0.03, 0.03), glow(0x6c7bff, 0.7));
  edge.position.set(0, -0.25, 2.11); counter.add(edge);
  scene.add(counter);

  const wall = new THREE.Group();
  const tileG = new THREE.BoxGeometry(0.56, 0.26, 0.06);
  const tiles = new THREE.InstancedMesh(tileG, mat(0xffffff, { roughness: 0.35, metalness: 0.1 }), 22 * 22);
  const m4 = new THREE.Matrix4();
  let n = 0;
  for (let row = 0; row < 22; row++) for (let col = 0; col < 22; col++) {
    m4.makeTranslation(-6 + col * 0.6 + (row % 2) * 0.3, row * 0.3 + 0.15, 0);
    tiles.setMatrixAt(n, m4);
    tiles.setColorAt(n, c.set([0x1d2470, 0x1a2066, 0x212a7a][(row * 7 + col * 3) % 3]));
    n++;
  }
  tiles.receiveShadow = true;
  wall.add(tiles);
  wall.position.set(0, 0, -1.4);
  scene.add(wall);

  // Neonkrona på väggen
  const crownPts = [[-0.9, -0.35], [-1.0, 0.45], [-0.5, 0.05], [0, 0.6], [0.5, 0.05], [1.0, 0.45], [0.9, -0.35]].map(([x, y]) => V(x, y, 0));
  crownPts.push(crownPts[0].clone());
  const crownCurve = new THREE.CatmullRomCurve3(crownPts, false, "catmullrom", 0.05);
  const neon = new THREE.Mesh(new THREE.TubeGeometry(crownCurve, 120, 0.035, 6, false), new THREE.MeshBasicMaterial({ color: 0xfff1a8, toneMapped: false }));
  const neonHalo = new THREE.Mesh(new THREE.TubeGeometry(crownCurve, 120, 0.11, 6, false), glow(SIGNAL, 0.25));
  const crown = new THREE.Group();
  crown.add(neon, neonHalo);
  crown.position.set(-1.25, 4.05, -1.3);
  crown.scale.setScalar(0.85);
  scene.add(crown);

  const tex = dotTexture();
  const label = new THREE.MeshStandardMaterial({ map: labelTexture(), metalness: 0.55, roughness: 0.35 });
  const freezer = makeFreezer(label, high);
  freezer.root.position.set(-3.5, 0, -0.5);
  freezer.root.rotation.y = 0.5;
  freezer.root.scale.setScalar(0.9);
  scene.add(freezer.root);

  // Glaset
  const glass = new THREE.Group();
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xd8e6ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
  const wallMesh = new THREE.Mesh(new THREE.CylinderGeometry(R_TOP, R_BOT, GLASS_H, 48, 1, true), glassMat);
  wallMesh.position.y = GLASS_H / 2; glass.add(wallMesh);
  const baseMesh = new THREE.Mesh(new THREE.CylinderGeometry(R_BOT, R_BOT, BASE_T, 48), new THREE.MeshStandardMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0.35, roughness: 0.05 }));
  baseMesh.position.y = BASE_T / 2; glass.add(baseMesh);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(R_TOP - 0.01, 0.022, 6, 64), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, roughness: 0.05 }));
  lip.rotation.x = Math.PI / 2; lip.position.y = GLASS_H; glass.add(lip);
  // Glansstrimma
  const shineG = new THREE.CylinderGeometry(R_TOP + 0.003, R_BOT + 0.003, GLASS_H * 0.9, 48, 1, true, -0.9, 0.22);
  const shine = new THREE.Mesh(shineG, glow(0xffffff, 0.16));
  shine.position.y = GLASS_H * 0.5; glass.add(shine);
  scene.add(glass);
  const glassShadow = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  glassShadow.rotation.x = -Math.PI / 2; glassShadow.position.y = 0.005; scene.add(glassShadow);

  // Strecket
  const markY0 = levelY(getFrame().target);
  const markR = lerp(R_BOT, R_TOP, markY0 / GLASS_H) + 0.012;
  const mark = new THREE.Group();
  const markRing = new THREE.Mesh(new THREE.TorusGeometry(markR, 0.016, 6, 64), new THREE.MeshBasicMaterial({ color: 0xfff1a8, toneMapped: false }));
  markRing.rotation.x = Math.PI / 2; mark.add(markRing);
  const markHalo = new THREE.Mesh(new THREE.TorusGeometry(markR, 0.06, 6, 64), glow(SIGNAL, 0.35));
  markHalo.rotation.x = Math.PI / 2; mark.add(markHalo);
  const tickG = new THREE.ConeGeometry(0.07, 0.16, 3);
  for (const s of [-1, 1]) {
    const tick = new THREE.Mesh(tickG, new THREE.MeshBasicMaterial({ color: SIGNAL, toneMapped: false }));
    tick.rotation.z = s * Math.PI / 2; tick.position.set(s * (markR + 0.16), 0, 0); mark.add(tick);
  }
  mark.position.y = markY0;
  scene.add(mark);

  // Drycken: kropp + skum (geometrin byggs om när nivån ändras)
  const liqMat = new THREE.MeshStandardMaterial({ color: LIQ, emissive: LIQ_DEEP, emissiveIntensity: 0.55, transparent: true, opacity: 0.9, roughness: 0.2 });
  const liquid = new THREE.Mesh(new THREE.BufferGeometry(), liqMat);
  glass.add(liquid);
  const foamMat = new THREE.MeshStandardMaterial({ color: FOAM, roughness: 1, emissive: 0x6a6a40, emissiveIntensity: 0.25 });
  const foam = new THREE.Mesh(new THREE.BufferGeometry(), foamMat);
  glass.add(foam);
  const BUBN = 26;
  const foamCap = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), foamMat, BUBN);
  const capSeeds = Array.from({ length: BUBN }, () => ({ a: rand(0, Math.PI * 2), r: Math.sqrt(Math.random()), s: rand(0.06, 0.13), p: rand(0, 6) }));
  glass.add(foamCap);
  let shownLiq = -1, shownFoam = -1;
  const setBodies = (liqTopY: number, foamTopY: number) => {
    if (Math.abs(liqTopY - shownLiq) > 0.002) {
      liquid.geometry.dispose();
      const h = Math.max(0.001, liqTopY - BASE_T);
      liquid.geometry = new THREE.CylinderGeometry(innerR(liqTopY), innerR(BASE_T), h, 40);
      liquid.position.y = BASE_T + h / 2;
      liquid.visible = liqTopY > BASE_T + 0.005;
      shownLiq = liqTopY;
    }
    if (Math.abs(foamTopY - shownFoam) > 0.002 || Math.abs(liqTopY - shownLiq) > 0.002) {
      foam.geometry.dispose();
      const h = Math.max(0.001, foamTopY - liqTopY);
      foam.geometry = new THREE.CylinderGeometry(innerR(foamTopY), innerR(liqTopY), h, 40);
      foam.position.y = liqTopY + h / 2;
      foam.visible = h > 0.01;
      shownFoam = foamTopY;
    }
  };
  setBodies(BASE_T, BASE_T);

  // Isbitar i glaset
  const iceMat = new THREE.MeshStandardMaterial({ color: 0xe6f7ff, emissive: 0x3d8fc0, emissiveIntensity: 0.25, transparent: true, opacity: 0.7, roughness: 0.1, flatShading: true });
  const cubes = [0, 1, 2].map((i) => {
    const m = mesh(new THREE.BoxGeometry(0.34, 0.3, 0.32, 1, 1, 1), iceMat, false);
    const rest = V([-0.18, 0.2, 0.0][i], BASE_T + 0.17 + i * 0.12, [0.12, -0.05, -0.2][i]);
    m.position.copy(rest);
    m.rotation.set(rand(-0.4, 0.4), rand(0, 3), rand(-0.4, 0.4));
    glass.add(m);
    return { m, rest, spin: rand(-1, 1), phase: rand(0, 6) };
  });

  // Burken
  const can = makeCan(label, high);
  scene.add(can.root);
  const canShadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
  canShadow.rotation.x = -Math.PI / 2; canShadow.position.y = 0.006; scene.add(canShadow);

  // Stråle från burken (TubeGeometry byggs om varje bild när den syns)
  const streamMat = new THREE.MeshStandardMaterial({ color: LIQ, emissive: LIQ_DEEP, emissiveIntensity: 0.5, transparent: true, opacity: 0.85, roughness: 0.15 });
  const stream = new THREE.Mesh(new THREE.BufferGeometry(), streamMat);
  scene.add(stream);
  const streamCore = new THREE.Mesh(new THREE.BufferGeometry(), glow(0xf6ffb0, 0.35));
  scene.add(streamCore);

  // Spill: vätska som rinner längs glasets utsida och en pöl
  const spillMat = new THREE.MeshStandardMaterial({ color: LIQ, emissive: LIQ_DEEP, emissiveIntensity: 0.35, transparent: true, opacity: 0, roughness: 0.15, side: THREE.DoubleSide, depthWrite: false });
  const spillSheet = new THREE.Mesh(new THREE.CylinderGeometry(R_TOP + 0.02, R_BOT + 0.03, GLASS_H, 48, 1, true), spillMat);
  spillSheet.position.y = GLASS_H / 2; scene.add(spillSheet);
  const puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshStandardMaterial({ color: LIQ, emissive: LIQ_DEEP, emissiveIntensity: 0.3, transparent: true, opacity: 0.8, roughness: 0.05 }));
  puddle.rotation.x = -Math.PI / 2; puddle.position.y = 0.01; puddle.scale.setScalar(0.001); scene.add(puddle);

  const bubbles = makeParticles(260, 0.06, tex);
  const fx = makeParticles(500, 0.12, tex);
  const vapor = makeParticles(220, 0.55, tex);
  (vapor.points.material as THREE.PointsMaterial).opacity = 0.35;
  scene.add(bubbles.points, fx.points, vapor.points);

  // Damm i ljuset
  const moteN = 70;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteN * 3);
  for (let i = 0; i < moteN; i++) motePos.set([rand(-5, 5), rand(0.2, 5), rand(-1.2, 2)], i * 3);
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  scene.add(new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.05, map: tex, color: 0xffe9a8, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));

  let composer: EffectComposer | null = null;
  if (high) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.55, 0.8));
    composer.addPass(new OutputPass());
  }
  let aspect = 1;
  const resize = () => {
    const W = host.clientWidth || 400, H = host.clientHeight || 400;
    renderer.setSize(W, H, false);
    composer?.setSize(W, H);
    aspect = W / H;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // ===== Tillstånd för animationer =====
  const t0 = now();
  let pourStart = -1, releaseAt = -1, endAt = -1;
  let lastPhase: PourFrame["phase"] = "idle";
  let spilled = false, result: number | null = null;
  let shake = 0, tilt = 0, shownLevel = 0;
  let openedAt = -1;
  let raf = 0, last = t0;
  let disposed = false;

  const tmp = V(), tmp2 = V();
  const HOLD = V(1.35, GLASS_H + 0.85, 0.25);           // burken upprätt, redo
  const MOUTH_AT = V(0.42, GLASS_H + 0.55, 0.08);       // där öppningen ska vara när den häller
  const camGame = { pos: V(0.1, 3.5, 8.7), look: V(-0.1, 2.05, 0) };
  const camIntro = { pos: V(-1.6, 2.6, 6.4), look: V(-3.3, 1.7, -0.6) };

  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const e = t - t0;
    const f = getFrame();

    if (f.phase !== lastPhase) {
      if (f.phase === "pour") pourStart = t;
      if (f.phase === "foam") releaseAt = t;
      if (f.phase === "done") endAt = t;
      lastPhase = f.phase;
    }

    // --- Frysdörren ---
    const doorK = e < 1500 ? easeOut(e / 450) : 1 - ease((e - 1500) / 600);
    freezer.hinge.rotation.y = -doorK * 1.75;
    freezer.light.intensity = doorK * 4;
    if (doorK > 0.3 && Math.random() < doorK * 0.8) {
      const fp = freezer.root.localToWorld(tmp.set(rand(-0.9, 0.9), rand(0.3, 3.2), 0.8));
      vapor.spawn(fp, V(rand(0.1, 0.5), rand(-0.15, 0.05), rand(0.2, 0.6)), rand(1.2, 2.2), 0x6f9cc8, -0.05, 0.6);
    }

    // --- Burken ---
    let canPos = V(), canRotZ = 0, canRotY = 0;
    const pick = freezer.root.localToWorld(freezer.pickAt.clone());
    if (e < 450) {
      canPos.copy(pick);
    } else if (e < 1700) {
      const k = ease((e - 450) / 1250);
      const mid = V((pick.x + HOLD.x) / 2, Math.max(pick.y, HOLD.y) + 0.9, 0.9);
      canPos.copy(pick).multiplyScalar((1 - k) ** 2).addScaledVector(mid, 2 * (1 - k) * k).addScaledVector(HOLD, k * k);
      canRotY = k * Math.PI * 2;
      canRotZ = Math.sin(k * Math.PI) * 0.5;
      if (Math.random() < 0.7) vapor.spawn(canPos, V(rand(-0.1, 0.1), rand(0.05, 0.2), rand(-0.1, 0.1)), rand(0.6, 1.1), 0x8fb6e0, -0.05, 1);
    } else {
      // Redo/häller: hålls över glaset, lutas när spelaren häller
      let want = 0;
      if (f.phase === "pour") want = 1.92 + Math.min(0.5, (t - pourStart) / 1000 * 0.12);
      else if (f.phase === "foam" || f.phase === "done") want = 0;
      tilt = lerp(tilt, want, Math.min(1, dt * (want > tilt ? 9 : 5)));
      const k = clamp(tilt / 1.92, 0, 1);
      canRotZ = tilt;
      // Placera burken så att öppningen hamnar vid MOUTH_AT när den lutar
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt));
      const mouthOff = can.mouth.position.clone().applyQuaternion(q);
      const pourPos = tmp2.copy(MOUTH_AT).sub(mouthOff);
      canPos.copy(HOLD).lerp(pourPos, ease(k));
      canPos.y += Math.sin(t / 600) * 0.03 * (1 - k);
    }
    can.root.position.copy(canPos);
    can.root.rotation.set(0, canRotY, canRotZ);
    canShadow.position.set(canPos.x, 0.006, canPos.z);
    (canShadow.material as THREE.MeshBasicMaterial).opacity = e > 1500 ? 0.22 : 0;
    canShadow.scale.setScalar(1 + canPos.y * 0.05);
    // Öppna burken: fliken knäpps upp och det pyser
    if (e > 1750 && openedAt < 0) {
      openedAt = t;
      can.root.updateMatrixWorld(true);
      const mp = can.mouth.getWorldPosition(tmp);
      for (let i = 0; i < 26; i++) fx.spawn(mp, V(rand(-0.6, 0.6), rand(0.8, 2.2), rand(-0.6, 0.6)), rand(0.3, 0.6), i % 3 ? 0xf6ffb0 : 0xffffff, 5, 1.5);
      for (let i = 0; i < 8; i++) vapor.spawn(mp, V(rand(-0.2, 0.2), rand(0.3, 0.6), rand(-0.2, 0.2)), rand(0.6, 1), 0xb8cce6, 0, 1.2);
    }
    can.tab.rotation.z = openedAt > 0 ? -easeOut((t - openedAt) / 180) * 1.1 : 0;
    can.tab.position.x = 0.03 + (openedAt > 0 ? 0.02 : 0);
    // Kall burk: lite ånga hela tiden
    if (e > 1700 && Math.random() < 0.25) vapor.spawn(tmp.copy(canPos).add(V(rand(-0.3, 0.3), rand(-0.5, 0.4), 0.2)), V(rand(-0.05, 0.05), rand(-0.12, -0.02), rand(0, 0.08)), rand(1, 1.6), 0x5d7ca8, 0, 0.5);

    // --- Nivå, skum och bubblor ---
    shownLevel = lerp(shownLevel, f.level, Math.min(1, dt * 20));
    let foamPct = 0;
    if (f.phase === "pour") foamPct = 2.5 + Math.min(3.5, (t - pourStart) / 1000 * 1.6);
    else if (f.phase !== "idle") foamPct = 6 - (endAt > 0 ? Math.min(2.5, (t - endAt) / 1000 * 0.6) : 0);
    if (shownLevel < 1) foamPct = 0;
    const foamTop = levelY(shownLevel);
    const liqTop = levelY(Math.max(0, shownLevel - foamPct));
    setBodies(liqTop, foamTop);
    const capR = innerR(foamTop);
    capSeeds.forEach((s, i) => {
      const r = s.r * capR * 0.92;
      const sc = foamPct > 0 ? s.s * (1 + Math.sin(t / 300 + s.p) * 0.12) : 0.0001;
      m4.compose(tmp.set(Math.cos(s.a) * r, foamTop + sc * 0.2, Math.sin(s.a) * r), new THREE.Quaternion(), V(sc, sc * 0.6, sc));
      foamCap.setMatrixAt(i, m4);
    });
    foamCap.instanceMatrix.needsUpdate = true;
    cubes.forEach((cb, i) => {
      const floatY = liqTop - 0.1 + Math.sin(t / 500 + cb.phase) * 0.02;
      cb.m.position.y = Math.max(cb.rest.y, floatY);
      if (floatY > cb.rest.y) cb.m.rotation.y += dt * 0.2 * cb.spin;
      cb.m.position.x = cb.rest.x * (1 + Math.min(0.3, i * 0.05));
    });
    const fizz = f.phase === "pour" ? 6 : f.phase === "foam" ? 4 : shownLevel > 2 ? 1.2 : 0;
    for (let i = 0; i < fizz; i++) {
      const y = rand(BASE_T + 0.05, Math.max(BASE_T + 0.06, liqTop - 0.05));
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * innerR(y) * 0.88;
      bubbles.spawn(V(Math.cos(a) * r, y, Math.sin(a) * r), V(0, rand(0.5, 1.1), 0), 3, 0xfdfff0, -0.4, 0, 0);
    }
    bubbles.update(dt, liqTop);

    // --- Strålen ---
    const pouring = f.phase === "pour" || (releaseAt > 0 && t - releaseAt < 180 && f.phase !== "idle");
    if (pouring && tilt > 1.2) {
      can.root.updateMatrixWorld(true);
      const m0 = can.mouth.getWorldPosition(V());
      const flow = f.phase === "pour" ? 1 : 1 - (t - releaseAt) / 180;
      const landY = Math.min(foamTop, GLASS_H + 0.2);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 14; i++) {
        const k = i / 14;
        const x = lerp(m0.x, 0.12, Math.sqrt(k)) + Math.sin(t / 60 + k * 9) * 0.008 * k;
        const y = lerp(m0.y, landY, k * k);
        const z = lerp(m0.z, 0.02, k);
        pts.push(V(x, y, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const w = (0.05 + Math.min(0.03, (t - pourStart) / 1000 * 0.01)) * Math.max(0.2, flow);
      stream.geometry.dispose();
      stream.geometry = new THREE.TubeGeometry(curve, 28, w, 8, false);
      streamCore.geometry.dispose();
      streamCore.geometry = new THREE.TubeGeometry(curve, 28, w * 0.45, 6, false);
      stream.visible = streamCore.visible = true;
      // Stänk vid ytan
      for (let i = 0; i < 3; i++) fx.spawn(V(0.12 + rand(-0.08, 0.08), landY + 0.02, rand(-0.08, 0.08)), V(rand(-0.9, 0.9), rand(0.6, 1.8), rand(-0.9, 0.9)), rand(0.2, 0.4), i ? 0xf6ffb0 : 0xffffff, 7, 1);
    } else {
      stream.visible = streamCore.visible = false;
    }

    // --- Strecket pulserar när man närmar sig ---
    const near = clamp(1 - Math.abs(f.target - shownLevel) / 15, 0, 1);
    (markHalo.material as THREE.MeshBasicMaterial).opacity = 0.25 + near * 0.55 + Math.sin(t / 140) * 0.1 * near;
    mark.scale.setScalar(1 + near * 0.04 * Math.sin(t / 90));

    // --- Spill ---
    if (spilled) {
      const k = clamp((t - endAt) / 700, 0, 1);
      spillMat.opacity = 0.55 * Math.min(1, k * 3);
      spillSheet.scale.y = Math.max(0.001, easeOut(k));
      spillSheet.position.y = GLASS_H - (GLASS_H * spillSheet.scale.y) / 2;
      puddle.scale.setScalar(0.4 + easeOut(clamp((t - endAt - 300) / 1200, 0, 1)) * 1.6);
      if (Math.random() < 0.5 && k < 1) {
        const a = rand(0, Math.PI * 2);
        fx.spawn(V(Math.cos(a) * R_TOP, GLASS_H, Math.sin(a) * R_TOP), V(Math.cos(a) * 0.5, rand(0.2, 0.8), Math.sin(a) * 0.5), 0.6, 0xf6ffb0, 5, 0.5);
      }
    }

    // --- Kameran ---
    const ck = ease((e - 700) / 1300);
    const camPos = camIntro.pos.clone().lerp(camGame.pos, ck);
    const camLook = camIntro.look.clone().lerp(camGame.look, ck);
    // Smala skärmar: backa så att glas och burk syns
    const back = aspect < 1 ? (1 / aspect - 1) * 4.2 : 0;
    camPos.add(V(0, back * 0.25, back));
    if (f.phase === "pour") { camPos.lerp(V(0.25, 3.1, 7.4 + back), 0.25 * ease((t - pourStart) / 800)); }
    camPos.x += Math.sin(t / 2600) * 0.08;
    camPos.y += Math.sin(t / 2100) * 0.04;
    shake = Math.max(0, shake - dt * 1.4);
    if (shake > 0) { camPos.x += (Math.random() - 0.5) * shake; camPos.y += (Math.random() - 0.5) * shake; }
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    // Neonflimmer och damm
    neonLight.intensity = 6 + (Math.random() < 0.01 ? -4 : 0) + Math.sin(t / 700) * 0.4;
    for (let i = 0; i < moteN; i++) {
      motePos[i * 3 + 1] += dt * 0.06;
      if (motePos[i * 3 + 1] > 5) motePos[i * 3 + 1] = 0.2;
    }
    moteGeo.attributes.position.needsUpdate = true;
    fx.update(dt);
    vapor.update(dt);

    if (composer) composer.render(); else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    introDone: () => now() - t0 >= INTRO_MS,
    event(ev) {
      if (ev.type === "spill") {
        spilled = true; endAt = now(); shake = 0.35;
        banner("SPILL!", "denied");
      } else {
        result = ev.diff;
        const a = Math.abs(ev.diff);
        const y = levelY(getFrame().level);
        if (a <= 1.5) {
          banner("PERFEKT!", "hit");
          for (let i = 0; i < 90; i++) {
            const ang = rand(0, Math.PI * 2);
            fx.spawn(V(Math.cos(ang) * 0.7, y, Math.sin(ang) * 0.7), V(Math.cos(ang) * rand(0.5, 2.5), rand(1, 3.5), Math.sin(ang) * rand(0.5, 2.5)), rand(0.6, 1.1), [SIGNAL, 0xffffff, 0xfff1a8][i % 3], 4, 1);
          }
        } else if (a <= 5) {
          banner("NÄRA!", "hit");
          for (let i = 0; i < 30; i++) fx.spawn(V(rand(-0.5, 0.5), y, rand(-0.5, 0.5)), V(rand(-1, 1), rand(1, 2.5), rand(-1, 1)), rand(0.4, 0.8), SIGNAL, 4, 1);
        }
        void result;
      }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
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
      overlay.remove();
    },
  };
}
