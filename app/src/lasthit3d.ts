// Last hit i 3D: bara grafik. All spellogik (HP, pilar, träff, denied) ligger kvar i LastHit i skill.tsx,
// som läser av sin egen klocka. Scenen ritar det den får via getFrame() och reagerar på händelser.
// Laddas med dynamisk import så att quizet i övrigt inte blir tyngre. Om WebGL saknas returnerar
// createLastHitScene null och LastHit visar bara en enkel HP-mätare.
//
// Allt är byggt av enkla låg-poly-former i kod (inga modellfiler), med egna figurer i HoN-anda.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ARROW_FLIGHT_MS, BOW_COOLDOWN_MS, BOW_DRAW_MS, rng, type Creep } from "../shared/skill";

export interface LhFrame {
  t0: number;
  idx: number;
  creep: Creep | undefined;
  /** Creepens HP i procent just nu enligt spellogiken. */
  hp: number;
  arrows: { firedAt: number; landsAt: number }[];
  flash: "hit" | "denied" | null;
}
export type LhEvent =
  | { type: "ally"; text: string }
  | { type: "mine"; text: string }
  | { type: "hit" }
  | { type: "denied" };

export interface LastHitScene {
  event(e: LhEvent): void;
  dispose(): void;
}

const now = () => performance.now();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (k: number) => 1 - (1 - k) ** 3;
/** HP-procent till "riktiga" HP som i SVG-versionen. */
const HP_SCALE = 5.5;

// Scenens platser (lanen går längs x)
const ARCHER = new THREE.Vector3(-3.5, 0, 1.0);
const TARGET = new THREE.Vector3(2.5, 0, 0);
const ALLIES = [new THREE.Vector3(1.15, 0, 0.75), new THREE.Vector3(1.25, 0, -0.7)];
const CAM_POS = new THREE.Vector3(-0.5, 2.8, 7.6);
const CAM_LOOK = new THREE.Vector3(-0.5, 1.15, 0);
const CAM_PUNCH_POS = new THREE.Vector3(1.2, 1.9, 4.6);
const CAM_PUNCH_LOOK = new THREE.Vector3(2.2, 1.0, 0);
const SPAWN_MS = 700;

const COL = {
  skyTop: "#0b1250", skyMid: "#3b2a7a", skyLow: "#e0795a",
  fog: 0x2a2563,
  grass: [0x2f5a3a, 0x3a6b42, 0x29503a, 0x44754a],
  dirt: [0x7a5a3c, 0x6b4e34, 0x85643f],
  hero: 0x2b3ad0, heroDark: 0x18207a, skin: 0xf1c59a, gold: 0xffd23f,
  legion: 0x3f8f6a, legionEye: 0x7ff6ff,
  hell: 0x8a2f55, hellEye: 0xffa040,
};

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
/** Lägg en cylinder (höjd 1 längs y) mellan två punkter. */
function stretch(o: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = new THREE.Vector3().subVectors(b, a);
  o.position.copy(a).addScaledVector(d, 0.5);
  o.scale.set(1, d.length(), 1);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
}

// ===== Figurer =====

function makeArrow(): THREE.Group {
  // Pekar längs +z, svansen vid z = 0
  const g = new THREE.Group();
  const shaft = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 5), mat(0xe9d7b0), false);
  shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.5;
  const tip = mesh(new THREE.ConeGeometry(0.07, 0.2, 5), new THREE.MeshStandardMaterial({ color: COL.gold, emissive: COL.gold, emissiveIntensity: 1.6, flatShading: true }), false);
  tip.rotation.x = Math.PI / 2; tip.position.z = 1.08;
  const fl = new THREE.MeshStandardMaterial({ color: 0xff7a3d, side: THREE.DoubleSide, flatShading: true });
  for (let i = 0; i < 2; i++) {
    const f = mesh(new THREE.PlaneGeometry(0.16, 0.22), fl, false);
    f.position.z = 0.1; f.rotation.y = Math.PI / 2; f.rotation.z = i * Math.PI / 2;
    g.add(f);
  }
  g.add(shaft, tip);
  return g;
}

interface Archer {
  root: THREE.Group;
  bow: THREE.Group;
  string: THREE.Line;
  nocked: THREE.Group;
  drawArm: THREE.Mesh;
  shoulder: THREE.Vector3;
  cape: THREE.Mesh;
}

function makeArcher(): Archer {
  const root = new THREE.Group();
  const cloth = mat(COL.hero), dark = mat(COL.heroDark), skin = mat(COL.skin), trim = mat(COL.gold, { metalness: 0.6, roughness: 0.35 });
  for (const z of [-0.14, 0.14]) {
    const leg = mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.6, 6), dark);
    leg.position.set(0, 0.3, z); root.add(leg);
  }
  const cape = mesh(new THREE.ConeGeometry(0.5, 1.25, 7), cloth);
  cape.position.y = 0.95; root.add(cape);
  const belt = mesh(new THREE.TorusGeometry(0.29, 0.04, 4, 10), trim);
  belt.rotation.x = Math.PI / 2; belt.position.y = 0.95; root.add(belt);
  const head = mesh(new THREE.IcosahedronGeometry(0.21, 1), skin);
  head.position.y = 1.72; root.add(head);
  const hood = mesh(new THREE.ConeGeometry(0.3, 0.62, 7), dark);
  hood.position.set(-0.05, 1.86, 0); hood.rotation.z = 0.25; root.add(hood);
  // Ögon som lyser svagt under huvan
  for (const z of [-0.07, 0.07]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), glow(0xfff3c0));
    eye.position.set(0.19, 1.74, z); root.add(eye);
  }
  // Koger på ryggen
  const quiver = mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.55, 6), mat(0x6b3f22));
  quiver.position.set(-0.3, 1.35, 0.12); quiver.rotation.z = -0.5; root.add(quiver);
  for (let i = 0; i < 3; i++) {
    const f = mesh(new THREE.ConeGeometry(0.04, 0.14, 4), mat(0xff7a3d), false);
    f.position.set(-0.43 - i * 0.02, 1.62 + i * 0.01, 0.06 + i * 0.05); f.rotation.z = -0.5; root.add(f);
  }

  // Bågen: en båge av en torus med fören mot +x. Greppet ligger på (0.6, 0) i bågens system.
  const bow = new THREE.Group();
  bow.position.set(-0.05, 1.35, 0);
  const arc = 2.2;
  const limb = mesh(new THREE.TorusGeometry(0.6, 0.04, 5, 18, arc), mat(0x9a5a2a, { roughness: 0.6 }));
  limb.rotation.z = -arc / 2; bow.add(limb);
  const grip = mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 6), trim);
  grip.position.set(0.6, 0, 0); bow.add(grip);
  const sg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
  const string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xfff6dd, toneMapped: false }));
  bow.add(string);
  const nocked = makeArrow();
  nocked.rotation.y = Math.PI / 2; // +z → +x
  nocked.scale.setScalar(0.85);
  bow.add(nocked);
  root.add(bow);

  const armMat = cloth;
  const front = mesh(new THREE.CylinderGeometry(0.06, 0.05, 1, 5), armMat);
  const shoulder = new THREE.Vector3(0.02, 1.47, 0);
  stretch(front, shoulder, new THREE.Vector3(0.55, 1.35, 0));
  root.add(front);
  const drawArm = mesh(new THREE.CylinderGeometry(0.06, 0.05, 1, 5), armMat);
  root.add(drawArm);

  root.position.copy(ARCHER);
  root.rotation.y = -0.12; // lite vänd mot kameran
  return { root, bow, string, nocked, drawArm, shoulder, cape };
}

interface CreepFig {
  root: THREE.Group;
  body: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  skin: THREE.MeshStandardMaterial;
  base: THREE.Color;
}

function makeCreep(color: number, eye: number, size = 1): CreepFig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = mat(color);
  const darker = mat(new THREE.Color(color).multiplyScalar(0.55).getHex());
  for (const z of [-0.2, 0.2]) {
    const leg = mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.4, 5), darker);
    leg.position.set(0, 0.2, z); body.add(leg);
  }
  const torso = mesh(new THREE.IcosahedronGeometry(0.55, 0), skin);
  torso.scale.set(1, 0.85, 0.9); torso.position.y = 0.78; body.add(torso);
  // Taggar på ryggen
  for (let i = 0; i < 4; i++) {
    const s = mesh(new THREE.ConeGeometry(0.1, 0.38, 4), darker);
    s.position.set(-0.25 + i * 0.05 - 0.1, 1.15 - i * 0.08, (i % 2 ? 1 : -1) * 0.12);
    s.rotation.z = 0.7 + i * 0.15;
    body.add(s);
  }
  // Ögon och käke (framåt = +x)
  for (const z of [-0.17, 0.17]) {
    const e = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 0), glow(eye));
    e.position.set(0.47, 0.9, z); body.add(e);
  }
  const jaw = mesh(new THREE.BoxGeometry(0.22, 0.12, 0.42), darker);
  jaw.position.set(0.42, 0.58, 0); body.add(jaw);
  for (const z of [-0.12, 0, 0.12]) {
    const tooth = mesh(new THREE.ConeGeometry(0.035, 0.1, 4), mat(0xf4eedd), false);
    tooth.position.set(0.53, 0.66, z); body.add(tooth);
  }
  const arm = (z: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.05, 0.95, z);
    const a = mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), skin);
    a.position.y = -0.25; pivot.add(a);
    const claw = mesh(new THREE.ConeGeometry(0.09, 0.22, 4), mat(0xf4eedd));
    claw.position.set(0.05, -0.58, 0); claw.rotation.z = Math.PI + 0.4; pivot.add(claw);
    body.add(pivot);
    return pivot;
  };
  const armL = arm(0.52), armR = arm(-0.52);
  root.scale.setScalar(size);
  return { root, body, armL, armR, skin, base: new THREE.Color(color) };
}

function makeTower(crystal: number): { root: THREE.Group; gem: THREE.Mesh } {
  const root = new THREE.Group();
  const stone = mat(0x5d6178), stoneD = mat(0x3f4257);
  const levels: [number, number, number][] = [[1.3, 1.5, 1.2], [1.0, 1.2, 1.8], [0.8, 0.9, 1.4]];
  let y = 0;
  levels.forEach(([top, bot, h], i) => {
    const c = mesh(new THREE.CylinderGeometry(top, bot, h, 6), i % 2 ? stoneD : stone);
    c.position.y = y + h / 2; root.add(c); y += h;
  });
  for (let i = 0; i < 6; i++) {
    const m = mesh(new THREE.BoxGeometry(0.3, 0.35, 0.3), stone);
    const a = (i / 6) * Math.PI * 2;
    m.position.set(Math.cos(a) * 0.8, y + 0.15, Math.sin(a) * 0.8); root.add(m);
  }
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), new THREE.MeshStandardMaterial({ color: crystal, emissive: crystal, emissiveIntensity: 2.2, flatShading: true }));
  gem.position.y = y + 1.1; root.add(gem);
  const light = new THREE.PointLight(crystal, 6, 9, 1.6);
  light.position.y = y + 1.1; root.add(light);
  return { root, gem };
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
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.3, "rgba(255,255,255,0.6)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Marken: låg-poly-gräs med en lane av jord, träd, stenar och två torn. */
function buildWorld(scene: THREE.Scene, high: boolean) {
  const r = rng(4242);
  const pick = (a: number[]) => a[Math.floor(r.next() * a.length)];
  const geo = new THREE.PlaneGeometry(70, 44, 56, 34).toNonIndexed();
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // Samma höjd för samma hörn (så att trianglarna sitter ihop)
  const hmap = new Map<string, number>();
  const height = (x: number, z: number) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (!hmap.has(k)) {
      const lane = Math.abs(z) < 2.2 && Math.abs(x) < 30;
      hmap.set(k, lane ? r.range(-0.03, 0.03) : r.range(0, 0.35) + Math.max(0, -z - 8) * 0.12);
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
    const lane = Math.abs(cz) < 1.9 + Math.sin(cx * 0.7) * 0.25;
    c.set(lane ? pick(COL.dirt) : pick(COL.grass));
    for (let j = 0; j < 3; j++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // Träd (instansierade för att hålla det billigt)
  const spots: { x: number; z: number; s: number }[] = [];
  for (let i = 0; i < 70; i++) {
    const x = r.range(-22, 22);
    const z = r.next() < 0.75 ? r.range(-18, -3.6) : r.range(3.4, 7);
    if (z > 0 && Math.abs(x + 0.4) < 8.5) continue; // inte framför kameran
    if (Math.abs(x + 6.8) < 2 && Math.abs(z + 7.5) < 2.2) continue; // tornen
    if (Math.abs(x - 6.6) < 2 && Math.abs(z + 8.5) < 2.2) continue;
    spots.push({ x, z, s: r.range(0.7, 1.4) });
  }
  const crownG = new THREE.ConeGeometry(0.9, 2.2, 6);
  const crownG2 = new THREE.ConeGeometry(0.7, 1.6, 6);
  const trunkG = new THREE.CylinderGeometry(0.14, 0.2, 0.8, 5);
  const crowns = new THREE.InstancedMesh(crownG, mat(0xffffff), spots.length);
  const crowns2 = new THREE.InstancedMesh(crownG2, mat(0xffffff), spots.length);
  const trunks = new THREE.InstancedMesh(trunkG, mat(0x5a3b26), spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const tc = [0x1f4a3a, 0x24563f, 0x2d5f3a, 0x1b3f40];
  spots.forEach((t, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(0, 6));
    s.setScalar(t.s);
    m4.compose(p.set(t.x, 0.4 * t.s, t.z), q, s); trunks.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, 1.7 * t.s, t.z), q, s); crowns.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, 2.6 * t.s, t.z), q, s); crowns2.setMatrixAt(i, m4);
    c.set(tc[i % tc.length]); crowns.setColorAt(i, c); crowns2.setColorAt(i, c.multiplyScalar(1.15));
  });
  for (const o of [crowns, crowns2, trunks]) { o.castShadow = high; o.receiveShadow = true; scene.add(o); }

  // Stenar längs lanen
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.35, 0), mat(0x6c6f86), 26);
  for (let i = 0; i < 26; i++) {
    const side = r.next() < 0.5 ? -1 : 1;
    q.setFromEuler(new THREE.Euler(r.range(0, 3), r.range(0, 3), 0));
    s.set(r.range(0.5, 1.4), r.range(0.4, 0.9), r.range(0.5, 1.3));
    m4.compose(p.set(r.range(-14, 14), 0.08, side * r.range(2.3, 3.4)), q, s);
    rocks.setMatrixAt(i, m4);
  }
  rocks.castShadow = high; rocks.receiveShadow = true;
  scene.add(rocks);

  const ally = makeTower(0x46d9ff);
  ally.root.position.set(-6.8, 0, -7.5); ally.root.scale.setScalar(0.75);
  const enemy = makeTower(0xff4a3d);
  enemy.root.position.set(6.6, 0, -8.5); enemy.root.scale.setScalar(0.75);
  scene.add(ally.root, enemy.root);
  return { gems: [ally.gem, enemy.gem] };
}

// ===== Partiklar =====

interface Particle { alive: boolean; p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; size: number; color: THREE.Color; grav: number; spin: number; rot: number; bounce: boolean }

class Particles {
  readonly mesh: THREE.InstancedMesh;
  private list: Particle[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private e = new THREE.Euler();
  private fade: "color" | "scale";
  constructor(geo: THREE.BufferGeometry, material: THREE.Material, n: number, fade: "color" | "scale") {
    this.fade = fade;
    this.mesh = new THREE.InstancedMesh(geo, material, n);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.list = Array.from({ length: n }, () => ({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 0.1, color: new THREE.Color(), grav: 0, spin: 0, rot: 0, bounce: false }));
    this.mesh.setColorAt(0, this.c.set(0));
    this.hideAll();
  }
  private hideAll() {
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < this.list.length; i++) this.mesh.setMatrixAt(i, this.m);
  }
  emit(o: { p: THREE.Vector3; v: THREE.Vector3; life: number; size: number; color: number | THREE.Color; grav?: number; spin?: number; bounce?: boolean }) {
    const x = this.list.find((k) => !k.alive);
    if (!x) return;
    x.alive = true; x.p.copy(o.p); x.v.copy(o.v); x.life = 0; x.max = o.life; x.size = o.size;
    x.color.set(o.color); x.grav = o.grav ?? 0; x.spin = o.spin ?? 0; x.rot = Math.random() * 6; x.bounce = !!o.bounce;
  }
  update(dt: number) {
    this.list.forEach((x, i) => {
      if (!x.alive) return;
      x.life += dt;
      if (x.life >= x.max) { x.alive = false; this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); return; }
      x.v.y -= x.grav * dt;
      x.p.addScaledVector(x.v, dt);
      if (x.bounce && x.p.y < 0.04) { x.p.y = 0.04; x.v.y = Math.abs(x.v.y) * 0.45; x.v.x *= 0.6; x.v.z *= 0.6; x.spin *= 0.6; }
      x.rot += x.spin * dt;
      const k = x.life / x.max;
      const sc = this.fade === "scale" ? x.size * (k > 0.7 ? (1 - k) / 0.3 : 1) : x.size * (1 - k * 0.5);
      this.q.setFromEuler(this.e.set(x.rot * 0.7, x.rot, 0));
      this.m.compose(x.p, this.q, this.s.setScalar(sc));
      this.mesh.setMatrixAt(i, this.m);
      this.c.copy(x.color);
      if (this.fade === "color") this.c.multiplyScalar(1 - k);
      this.mesh.setColorAt(i, this.c);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ===== Scenen =====

export function createLastHitScene(host: HTMLElement, getFrame: () => LhFrame, low = false): LastHitScene | null {
  const test = document.createElement("canvas");
  if (!test.getContext("webgl2") && !test.getContext("webgl")) return null;

  const coarse = matchMedia("(pointer: coarse)").matches;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let high = !coarse && !low;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = high;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "lh3d-canvas";
  host.appendChild(renderer.domElement);

  // HTML-lager ovanpå: skadesiffror, HP-text, banderoller och blixt
  const overlay = document.createElement("div");
  overlay.className = "lh3d-overlay";
  overlay.innerHTML = `<div class="lh3d-flash"></div><div class="lh3d-hp"></div><div class="lh3d-banner"></div>`;
  host.appendChild(overlay);
  const flashEl = overlay.querySelector<HTMLDivElement>(".lh3d-flash")!;
  const hpEl = overlay.querySelector<HTMLDivElement>(".lh3d-hp")!;
  const bannerEl = overlay.querySelector<HTMLDivElement>(".lh3d-banner")!;

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(COL.fog, 12, 36);
  const camera = new THREE.PerspectiveCamera(42, 1.6, 0.1, 120);

  scene.add(new THREE.HemisphereLight(0xa9bcff, 0x3a4a2a, 1.6));
  const sun = new THREE.DirectionalLight(0xffc48e, 3.2);
  sun.position.set(-6, 10, 6);
  sun.castShadow = high;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 8, bottom: -8, near: 1, far: 30 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8a7bff, 1.2);
  rim.position.set(6, 4, -8);
  scene.add(rim);

  const world = buildWorld(scene, high);

  const archer = makeArcher();
  scene.add(archer.root);
  const target = makeCreep(COL.hell, COL.hellEye, 1.05);
  target.root.rotation.y = Math.PI; // vänd mot lanen/oss
  scene.add(target.root);
  const allies = ALLIES.map((p, i) => {
    const c = makeCreep(COL.legion, COL.legionEye, 0.85);
    c.root.position.copy(p);
    c.root.rotation.y = i ? 0.25 : -0.25;
    scene.add(c.root);
    return c;
  });
  const backliner = makeCreep(COL.hell, COL.hellEye, 0.9);
  backliner.root.position.set(5.1, 0, -1.3);
  backliner.root.rotation.y = Math.PI + 0.3;
  scene.add(backliner.root);

  // HP-mätaren som alltid vänder sig mot kameran
  const bar = new THREE.Group();
  const BAR_W = 1.7;
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(BAR_W + 0.08, 0.28), new THREE.MeshBasicMaterial({ color: 0x070b3a, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
  const fillGeo = new THREE.PlaneGeometry(1, 0.2); fillGeo.translate(0.5, 0, 0);
  const fillMat = new THREE.MeshBasicMaterial({ color: 0xff3b47, depthTest: false, toneMapped: false });
  const barFill = new THREE.Mesh(fillGeo, fillMat);
  barFill.position.x = -BAR_W / 2;
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, toneMapped: false });
  const barGhost = new THREE.Mesh(fillGeo, ghostMat); // skadan som just togs, krymper efter
  barGhost.position.x = -BAR_W / 2;
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.42), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, toneMapped: false }));
  [barBg, barGhost, barFill, marker].forEach((m, i) => { m.renderOrder = 10 + i; bar.add(m); });
  barGhost.position.z = barFill.position.z = 0.001; marker.position.z = 0.002;
  scene.add(bar);

  // Ringen under creepen som lyser när den går att ta
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1.0, 40), glow(0x2fe08f, 0));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  // Pilar i luften
  const flying = new Map<number, THREE.Group>();
  const stuck: THREE.Object3D[] = [];

  const sparks = new Particles(new THREE.IcosahedronGeometry(1, 0), glow(0xffffff), 420, "color");
  const coins = new Particles(new THREE.CylinderGeometry(1, 1, 0.22, 10), new THREE.MeshStandardMaterial({ color: COL.gold, metalness: 0.9, roughness: 0.25, emissive: 0x6a4a00, emissiveIntensity: 0.9 }), 60, "scale");
  const chunks = new Particles(new THREE.TetrahedronGeometry(1, 0), mat(0xffffff), 80, "scale");
  scene.add(sparks.mesh, coins.mesh, chunks.mesh);

  // Svävande ljusprickar i luften
  const MOTES = 70;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(MOTES * 3);
  const moteBase: number[] = [];
  const mr = rng(77);
  for (let i = 0; i < MOTES; i++) moteBase.push(mr.range(-12, 12), mr.range(0.3, 4), mr.range(-8, 4), mr.range(0, 6));
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.16, map: dotTexture(), color: 0xffe9a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  scene.add(motes);

  // Efterbehandling (glöd) bara på datorer
  let composer: EffectComposer | null = null;
  const setupComposer = () => {
    composer?.dispose();
    composer = null;
    if (!high) return;
    composer = new EffectComposer(renderer);
    composer.renderTarget1.samples = composer.renderTarget2.samples = 4;
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.82));
    composer.addPass(new OutputPass());
  };
  setupComposer();

  let W = 1, H = 1;
  const resize = () => {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setSize(W, H, false);
    composer?.setSize(W, H);
    camera.aspect = W / H;
    // Håll samma bredd i bild oavsett format
    camera.fov = Math.min(75, (2 * Math.atan(0.68 / camera.aspect) * 180) / Math.PI);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // ===== Tillstånd för effekterna =====
  let vt = 0; // visuell tid (sekunder), går långsammare i slow motion
  let lastReal = now();
  let slowUntil = 0;
  let shake = 0;
  let punchAt = -1e9;
  let curIdx = -1;
  let dead: { kind: "hit" | "denied"; at: number } | null = null;
  let flinch = -1e9;
  let ghostHp = 100;
  let shownHp = 100;
  const floats: { el: HTMLSpanElement; p: THREE.Vector3; at: number }[] = [];
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const look = new THREE.Vector3();

  const project = (p: THREE.Vector3) => {
    tmp.copy(p).project(camera);
    return { x: ((tmp.x + 1) / 2) * W, y: ((1 - tmp.y) / 2) * H };
  };
  const float = (text: string, kind: string, p: THREE.Vector3) => {
    const el = document.createElement("span");
    el.className = `lh3d-float ${kind}`;
    el.textContent = text;
    overlay.appendChild(el);
    floats.push({ el, p: p.clone(), at: now() });
  };
  const banner = (text: string, kind: string) => {
    bannerEl.textContent = text;
    bannerEl.className = "lh3d-banner";
    void bannerEl.offsetWidth; // starta om animationen
    bannerEl.className = `lh3d-banner show ${kind}`;
  };
  const flashScreen = (kind: string) => {
    flashEl.className = "lh3d-flash";
    void flashEl.offsetWidth;
    flashEl.className = `lh3d-flash on ${kind}`;
  };
  const chest = () => tmp2.copy(target.root.position).add(new THREE.Vector3(-0.15, 0.85, 0));
  const burst = (at: THREE.Vector3, n: number, color: number, speed: number, size = 0.05, grav = 4) => {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      sparks.emit({ p: at, v, life: 0.35 + Math.random() * 0.45, size: size * (0.6 + Math.random()), color, grav });
    }
  };

  const event = (e: LhEvent) => {
    const t = now();
    if (e.type === "ally") {
      flinch = t;
      float(e.text, "ally", chest().clone().add(new THREE.Vector3(-0.75 + Math.random() * 0.2, 0.35 + Math.random() * 0.2, 0.3)));
      burst(chest().clone().add(new THREE.Vector3(-0.35, 0, 0)), 8, 0xffb070, 2.2, 0.04);
      if (!reduced) shake = Math.max(shake, 0.03);
    } else if (e.type === "mine") {
      flinch = t;
      float(e.text, "mine", chest().clone().add(new THREE.Vector3(0.75, 0.45, 0.3)));
      burst(chest(), 22, 0xffd23f, 3.5, 0.06);
      if (!reduced) shake = Math.max(shake, 0.1);
      // Pilen fastnar i creepen
      const a = makeArrow();
      a.scale.setScalar(0.8);
      target.body.add(a);
      a.position.set(0.25 + Math.random() * 0.15, 0.7 + Math.random() * 0.3, (Math.random() - 0.5) * 0.4);
      a.rotation.set(0, -Math.PI / 2 + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.5);
      a.translateZ(-0.75);
      stuck.push(a);
    } else if (e.type === "hit") {
      dead = { kind: "hit", at: t };
      slowUntil = t + 520;
      punchAt = t;
      if (!reduced) shake = 0.28;
      flashScreen("hit");
      banner("LAST HIT!", "hit");
      float(`+${36 + Math.round((getFrame().creep?.dmg ?? 0) * 0.7)} guld`, "gold", chest().clone().add(new THREE.Vector3(0, 1.3, 0)));
      const c = chest().clone();
      burst(c, 70, 0xffd23f, 6, 0.07, 3);
      burst(c, 30, 0xffffff, 4, 0.05, 1);
      for (let i = 0; i < 18; i++) {
        coins.emit({ p: c, v: new THREE.Vector3((Math.random() - 0.3) * 3.5, 4 + Math.random() * 3.5, (Math.random() - 0.5) * 3), life: 1.8 + Math.random() * 0.6, size: 0.17, color: 0xffffff, grav: 11, spin: 10 + Math.random() * 10, bounce: true });
      }
      for (let i = 0; i < 14; i++) {
        chunks.emit({ p: c, v: new THREE.Vector3((Math.random() - 0.2) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 3), life: 1.2, size: 0.09, color: COL.hell, grav: 12, spin: 12, bounce: true });
      }
    } else {
      dead = { kind: "denied", at: t };
      if (!reduced) shake = 0.16;
      flashScreen("denied");
      banner("DENIED", "denied");
      burst(chest(), 40, 0xff3b47, 4, 0.06);
    }
  };

  const resetCreep = () => {
    dead = null;
    flinch = -1e9;
    ghostHp = shownHp = 100;
    stuck.forEach((s) => s.removeFromParent());
    stuck.length = 0;
    target.root.rotation.set(0, Math.PI, 0);
    target.root.position.copy(TARGET);
    target.body.position.set(0, 0, 0);
    target.body.rotation.set(0, 0, 0);
    target.skin.color.copy(target.base);
    target.skin.emissive.setRGB(0, 0, 0);
    target.root.visible = true;
  };

  // Mät bildfrekvensen och skala ner automatiskt om datorn inte orkar
  let frames = 0, slowFrames = 0;
  let raf = 0;
  const stringPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const S_TOP = new THREE.Vector3(0.6 * Math.cos(1.1), 0.6 * Math.sin(1.1), 0);
  const S_BOT = new THREE.Vector3(0.6 * Math.cos(1.1), -0.6 * Math.sin(1.1), 0);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t = now();
    const realDt = Math.min(0.05, (t - lastReal) / 1000);
    lastReal = t;
    frames++;
    if (high && frames > 20 && frames < 140) {
      if (realDt > 0.026) slowFrames++;
      if (slowFrames > 30) {
        high = false;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
        renderer.shadowMap.enabled = false;
        sun.castShadow = false;
        setupComposer();
        resize();
      }
    }
    const scale = t < slowUntil ? 0.28 : 1;
    const dt = realDt * scale;
    vt += dt;

    const f = getFrame();
    if (f.idx !== curIdx) { curIdx = f.idx; resetCreep(); }
    const e = t - f.t0;
    const creep = f.creep;
    const dmg = creep?.dmg ?? 0;

    // --- Målcreepen: går in, andas, rycker till vid träff, dör ---
    const spawnK = clamp01((e + SPAWN_MS) / SPAWN_MS);
    if (!dead) {
      target.root.position.x = lerp(TARGET.x + 4.5, TARGET.x, easeOut(spawnK));
      const walking = spawnK < 1;
      target.body.position.y = walking ? Math.abs(Math.sin(t / 90)) * 0.12 : Math.sin(t / 380) * 0.03;
      target.body.rotation.z = walking ? Math.sin(t / 90) * 0.08 : 0;
      const fk = clamp01((t - flinch) / 160);
      const squash = Math.sin(fk * Math.PI) * 0.18;
      target.body.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);
      target.body.position.x = Math.sin(fk * Math.PI) * 0.12; // knuffas bakåt (lokalt)
      target.skin.emissive.setRGB(squash * 4, squash * 3, squash * 3);
      const inRange = f.hp > 0 && f.hp <= dmg && e >= 0;
      target.skin.color.copy(target.base);
      if (inRange) target.skin.emissive.lerp(new THREE.Color(0x0f5a30), 0.5 + Math.sin(t / 70) * 0.25);
      // armarna vevar lite
      target.armL.rotation.z = Math.sin(t / 260) * 0.25;
      target.armR.rotation.z = -Math.sin(t / 260) * 0.25;
    } else {
      const k = clamp01((t - dead.at) / (dead.kind === "hit" ? 1100 : 700));
      target.skin.emissive.setRGB(0, 0, 0);
      if (dead.kind === "hit") {
        target.root.rotation.z = -easeOut(clamp01(k * 1.6)) * 1.45;
        target.root.position.x = TARGET.x + easeOut(clamp01(k * 1.6)) * 0.7;
        target.root.position.y = -clamp01((k - 0.55) / 0.45) * 1.4;
      } else {
        target.skin.color.copy(target.base).lerp(new THREE.Color(0x555566), clamp01(k * 2));
        target.root.rotation.x = easeOut(clamp01(k * 1.4)) * 1.3;
        target.root.position.y = -clamp01((k - 0.5) / 0.5) * 1.2;
      }
      target.body.scale.set(1, 1, 1);
      if (k >= 1) target.root.visible = false;
    }

    // --- Allierade creeps hugger exakt när banan säger att de träffar ---
    allies.forEach((a, i) => {
      // d = ms relativt närmaste egna träff: lyfter armen, slår ner exakt på träffen, drar sig tillbaka
      let d = Infinity;
      if (creep && !(dead && dead.kind === "hit")) {
        creep.hits.forEach((h, j) => { if (j % 2 === i && Math.abs(e - h.at) < Math.abs(d)) d = e - h.at; });
      }
      const idle = Math.sin(t / 350 + i) * 0.2;
      let arm = idle, off = 0;
      if (d > -300 && d <= -70) { const k = (d + 300) / 230; arm = lerp(idle, 2.7, easeOut(k)); off = -0.12 * k; }
      else if (d > -70 && d <= 0) { const k = (d + 70) / 70; arm = lerp(2.7, 0.3, k * k); off = lerp(-0.12, 0.5, k); }
      else if (d > 0 && d < 320) { const k = d / 320; arm = lerp(0.3, idle, easeOut(k)); off = lerp(0.5, 0, easeOut(k)); }
      a.body.position.x = off;
      a.body.position.y = Math.sin(t / 300 + i * 2) * 0.03;
      a.armL.rotation.z = arm;
      a.armR.rotation.z = arm * 0.6 + idle;
      // Jublar när de denyat
      if (dead?.kind === "denied") a.root.position.y = Math.abs(Math.sin((t - dead.at) / 120)) * 0.25 * clamp01(1 - (t - dead.at) / 1200);
      else a.root.position.y = 0;
    });
    backliner.body.position.y = Math.sin(t / 420) * 0.04;
    backliner.armL.rotation.z = Math.sin(t / 500) * 0.3;
    backliner.armR.rotation.z = Math.sin(t / 500 + 1) * 0.3;

    // --- Bågskytten ---
    const drawingArrow = f.arrows.find((a) => t - a.firedAt < BOW_DRAW_MS);
    const lastFired = f.arrows.length ? Math.max(...f.arrows.map((a) => a.firedAt)) : -1e9;
    const sinceFire = t - lastFired;
    let pull = 0;
    if (drawingArrow) pull = easeOut(clamp01((t - drawingArrow.firedAt) / BOW_DRAW_MS));
    const twang = sinceFire >= BOW_DRAW_MS && sinceFire < BOW_DRAW_MS + 260 ? Math.sin((sinceFire - BOW_DRAW_MS) / 18) * (1 - (sinceFire - BOW_DRAW_MS) / 260) * 0.06 : 0;
    const nockX = S_TOP.x - pull * 0.42 + twang;
    stringPts[0].copy(S_TOP); stringPts[1].set(nockX, 0, 0); stringPts[2].copy(S_BOT);
    archer.string.geometry.setFromPoints(stringPts);
    const ready = sinceFire > BOW_COOLDOWN_MS - 250 || drawingArrow;
    archer.nocked.visible = !!ready && !dead;
    archer.nocked.position.set(nockX, 0, 0);
    archer.nocked.scale.setScalar(drawingArrow ? 0.85 : clamp01((sinceFire - (BOW_COOLDOWN_MS - 250)) / 250) * 0.85 || 0.85);
    const recoil = sinceFire >= BOW_DRAW_MS && sinceFire < BOW_DRAW_MS + 200 ? Math.sin(((sinceFire - BOW_DRAW_MS) / 200) * Math.PI) * 0.08 : 0;
    archer.root.position.x = ARCHER.x - recoil;
    archer.root.position.y = Math.sin(t / 600) * 0.015;
    archer.cape.rotation.z = Math.sin(t / 700) * 0.03 + recoil * 0.8;
    // Draghanden följer strängen
    const hand = new THREE.Vector3(nockX - 0.05 + -0.05, 1.35, 0);
    stretch(archer.drawArm, archer.shoulder, hand);

    // --- Pilar i flykten ---
    const start = archer.root.localToWorld(new THREE.Vector3(0.2, 1.35, 0));
    const end = chest().clone();
    const live = new Set<number>();
    for (const a of f.arrows) {
      const k = (t - a.firedAt - BOW_DRAW_MS) / ARROW_FLIGHT_MS;
      if (k < 0 || k > 1.05) continue;
      live.add(a.firedAt);
      let g = flying.get(a.firedAt);
      if (!g) { g = makeArrow(); flying.set(a.firedAt, g); scene.add(g); }
      const kk = Math.min(1, k);
      const at = (q: number) => new THREE.Vector3().lerpVectors(start, end, q).add(new THREE.Vector3(0, Math.sin(Math.PI * q) * 1.15, 0));
      const p = at(kk);
      g.position.copy(p);
      g.lookAt(at(Math.min(1.02, kk + 0.02)));
      g.translateZ(-1.0); // spetsen ligger där pilen "är"
      // Ljusspår
      for (let i = 0; i < 2; i++) sparks.emit({ p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05, 0)), v: new THREE.Vector3(0, 0.15, 0), life: 0.28, size: 0.045, color: 0xffc040 });
    }
    for (const [k, g] of flying) if (!live.has(k)) { g.removeFromParent(); flying.delete(k); }

    // --- HP-mätare, ring och HP-text ---
    shownHp = dead ? 0 : e < 0 ? 100 : f.hp;
    ghostHp = Math.max(shownHp, ghostHp - realDt * 60);
    if (ghostHp < shownHp) ghostHp = shownHp;
    const alive = !dead && spawnK > 0.05;
    bar.visible = alive;
    bar.position.copy(target.root.position).add(new THREE.Vector3(0, 1.95, 0));
    bar.quaternion.copy(camera.quaternion);
    barFill.scale.x = Math.max(0.0001, (BAR_W * shownHp) / 100);
    barGhost.scale.x = Math.max(0.0001, (BAR_W * ghostHp) / 100);
    marker.position.x = -BAR_W / 2 + (BAR_W * dmg) / 100;
    const killable = alive && e >= 0 && shownHp > 0 && shownHp <= dmg;
    fillMat.color.set(killable ? 0x2fe08f : 0xff3b47);
    if (killable) fillMat.color.multiplyScalar(1.4 + Math.sin(t / 60) * 0.4);
    ring.position.set(target.root.position.x, 0.04, target.root.position.z);
    (ring.material as THREE.MeshBasicMaterial).opacity = killable ? 0.65 + Math.sin(t / 70) * 0.3 : alive && e >= 0 ? 0.12 : 0;
    ring.scale.setScalar(killable ? 1 + Math.sin(t / 90) * 0.06 : 1);
    if (alive) {
      const sp = project(tmp2.copy(bar.position).add(new THREE.Vector3(0, 0.32, 0)));
      hpEl.style.transform = `translate(${sp.x}px, ${sp.y}px) translate(-50%, -100%)`;
      hpEl.textContent = `${Math.round(shownHp * HP_SCALE)} HP`;
      hpEl.className = `lh3d-hp${killable ? " kill" : ""}`;
    } else hpEl.className = "lh3d-hp gone";

    // --- Värld ---
    world.gems.forEach((g, i) => { g.rotation.y = t / 900 + i; g.position.y += Math.sin(t / 500 + i) * 0.002; });
    for (let i = 0; i < MOTES; i++) {
      const [bx, by, bz, ph] = moteBase.slice(i * 4, i * 4 + 4);
      motePos[i * 3] = bx + Math.sin(vt * 0.3 + ph) * 0.6;
      motePos[i * 3 + 1] = by + Math.sin(vt * 0.5 + ph * 2) * 0.3;
      motePos[i * 3 + 2] = bz + Math.cos(vt * 0.25 + ph) * 0.6;
    }
    moteGeo.attributes.position.needsUpdate = true;
    sparks.update(dt); coins.update(dt); chunks.update(dt);

    // --- Kamera: lugn svajning, knyck in vid last hit, skak ---
    const pk = (t - punchAt) / 1000;
    const punch = pk < 0 ? 0 : pk < 0.25 ? easeOut(pk / 0.25) : pk < 1.0 ? 1 : pk < 1.6 ? 1 - easeOut((pk - 1.0) / 0.6) : 0;
    camera.position.lerpVectors(CAM_POS, CAM_PUNCH_POS, punch * (reduced ? 0.3 : 0.75));
    look.lerpVectors(CAM_LOOK, CAM_PUNCH_LOOK, punch * (reduced ? 0.3 : 0.75));
    camera.position.x += Math.sin(t / 3000) * 0.15;
    camera.position.y += Math.sin(t / 2300) * 0.06;
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      shake *= Math.pow(0.002, realDt);
    }
    camera.lookAt(look);

    // --- Skadesiffror ---
    for (let i = floats.length - 1; i >= 0; i--) {
      const fl = floats[i];
      const age = (t - fl.at) / 1000;
      if (age > 1.1) { fl.el.remove(); floats.splice(i, 1); continue; }
      const sp = project(tmp2.copy(fl.p).add(new THREE.Vector3(0, age * 0.9, 0)));
      fl.el.style.transform = `translate(${sp.x}px, ${sp.y}px) translate(-50%, -50%) scale(${age < 0.12 ? 0.6 + age * 4 : 1})`;
      fl.el.style.opacity = String(age > 0.7 ? 1 - (age - 0.7) / 0.4 : 1);
    }

    if (composer) composer.render(); else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  return {
    event,
    dispose() {
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
      renderer.forceContextLoss();
      renderer.domElement.remove();
      overlay.remove();
    },
  };
}
