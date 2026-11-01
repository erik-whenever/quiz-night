// Flick i 3D: bara grafik. Spellogiken (vilket mål, träff, miss, lockbete, tid) ligger i Aim i skill.tsx.
// Kameran tittar rakt fram mot planet z = 0, som exakt fyller spelytan. Därför hamnar ett mål på (u, v)
// i spelytan exakt där det ritas, och träffytan (en osynlig knapp) ligger rätt ovanpå.
// Bakom planet går en neonupplyst tunnel; det är den som ger djupet.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { AIM_LIFE_MS, aimPos, type AimTarget } from "../shared/skill";

export interface FlickFrame {
  course: AimTarget[];
  /** Index för målet som syns nu (-1 = inte startat, ≥ längd = klart). */
  i: number;
  /** performance.now() när målet dök upp. */
  spawnAt: number;
}
export type FlickEvent =
  | { type: "hit"; u: number; v: number; split: number }
  | { type: "miss"; u: number; v: number }
  | { type: "decoy"; u: number; v: number }
  | { type: "escape"; u: number; v: number }
  | { type: "shot" };

export interface FlickScene { event(e: FlickEvent): void; dispose(): void }

const now = () => performance.now();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOutBack = (k: number) => { const c = 1.9; const x = clamp01(k) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
const DIST = 10;
const FOV = 50;
const DEPTH = 16;

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Rutnät med glödande linjer för tunnelns väggar. */
function gridTex(line: string) {
  const t = canvasTex(256, 256, (x) => {
    x.fillStyle = "#0a0f3d"; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = line; x.lineWidth = 3; x.shadowColor = line; x.shadowBlur = 10;
    x.strokeRect(1.5, 1.5, 253, 253);
    x.lineWidth = 1; x.globalAlpha = 0.35; x.shadowBlur = 0;
    x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 256); x.moveTo(0, 128); x.lineTo(256, 128); x.stroke();
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Måltavlan: vita och röda ringar med gul mitt. */
function bullseyeTex() {
  return canvasTex(256, 256, (x) => {
    const rings = ["#f4f5ff", "#ff3b47", "#f4f5ff", "#ff3b47", "#ffd23f"];
    rings.forEach((c, i) => { x.fillStyle = c; x.beginPath(); x.arc(128, 128, 126 - i * 25, 0, Math.PI * 2); x.fill(); });
    x.strokeStyle = "rgba(7,11,58,0.5)"; x.lineWidth = 2;
    for (let i = 0; i < 5; i++) { x.beginPath(); x.arc(128, 128, 126 - i * 25, 0, Math.PI * 2); x.stroke(); }
  });
}

/** Lockbetet: rött och svart varningsmönster med ett vitt kryss. */
function decoyTex() {
  return canvasTex(256, 256, (x) => {
    x.save(); x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.clip();
    x.fillStyle = "#1a0006"; x.fillRect(0, 0, 256, 256);
    x.fillStyle = "#ff2a3d";
    for (let i = -256; i < 512; i += 44) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 22, 0); x.lineTo(i + 22 - 256, 256); x.lineTo(i - 256, 256); x.fill(); }
    x.restore();
    x.fillStyle = "#1a0006"; x.beginPath(); x.arc(128, 128, 70, 0, Math.PI * 2); x.fill();
    x.strokeStyle = "#ffffff"; x.lineWidth = 18; x.lineCap = "round";
    x.beginPath(); x.moveTo(98, 98); x.lineTo(158, 158); x.moveTo(158, 98); x.lineTo(98, 158); x.stroke();
  });
}

function dotTex() {
  return canvasTex(64, 64, (x) => {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  }, false);
}

/** En måltavla med hologramring och en båge som visar tiden som är kvar. */
function makeTarget(face: THREE.Texture, ring: number) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.16, 48), [
    new THREE.MeshStandardMaterial({ color: 0x8890b8, metalness: 0.85, roughness: 0.3 }),
    new THREE.MeshStandardMaterial({ map: face, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 0.22, roughness: 0.55 }),
    new THREE.MeshStandardMaterial({ color: 0x222844 }),
  ]);
  disc.rotation.x = Math.PI / 2;
  g.add(disc);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.035, 8, 64), new THREE.MeshBasicMaterial({ color: ring, toneMapped: false }));
  g.add(halo);
  const ticks = new THREE.Group();
  for (let k = 0; k < 4; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.05), new THREE.MeshBasicMaterial({ color: ring, toneMapped: false }));
    const a = (k / 4) * Math.PI * 2;
    m.position.set(Math.cos(a) * 1.42, Math.sin(a) * 1.42, 0); m.rotation.z = a + Math.PI / 2;
    ticks.add(m);
  }
  g.add(ticks);
  const timerMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const timer = new THREE.Mesh(new THREE.RingGeometry(1.08, 1.14, 64, 1, Math.PI / 2, Math.PI * 2), timerMat);
  timer.position.z = 0.09;
  g.add(timer);
  const glow = new THREE.PointLight(ring, 1.1, 5, 2);
  glow.position.z = 1.2;
  g.add(glow);
  g.visible = false;
  return { g, disc, halo, ticks, timer, timerMat };
}

interface Part { alive: boolean; p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; size: number; color: THREE.Color; grav: number; rot: THREE.Euler; spin: THREE.Vector3 }

class Burst {
  readonly mesh: THREE.InstancedMesh;
  private list: Part[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private fadeColor: boolean;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, fadeColor: boolean) {
    this.fadeColor = fadeColor;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.list = Array.from({ length: n }, () => ({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 1, color: new THREE.Color(), grav: 0, rot: new THREE.Euler(), spin: new THREE.Vector3() }));
    this.mesh.setColorAt(0, this.c.set(0));
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.m);
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: number, grav = 0) {
    const x = this.list.find((k) => !k.alive);
    if (!x) return;
    x.alive = true; x.p.copy(p); x.v.copy(v); x.life = 0; x.max = life; x.size = size; x.color.set(color); x.grav = grav;
    x.rot.set(Math.random() * 6, Math.random() * 6, 0); x.spin.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
  }
  update(dt: number) {
    this.list.forEach((x, i) => {
      if (!x.alive) return;
      x.life += dt;
      if (x.life >= x.max) { x.alive = false; this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); return; }
      x.v.y -= x.grav * dt;
      x.v.multiplyScalar(1 - dt * 1.2);
      x.p.addScaledVector(x.v, dt);
      x.rot.x += x.spin.x * dt; x.rot.y += x.spin.y * dt; x.rot.z += x.spin.z * dt;
      const k = x.life / x.max;
      this.q.setFromEuler(x.rot);
      this.m.compose(x.p, this.q, this.s.setScalar(x.size * (this.fadeColor ? 1 - k * 0.6 : k > 0.75 ? (1 - k) / 0.25 : 1)));
      this.mesh.setMatrixAt(i, this.m);
      this.c.copy(x.color);
      if (this.fadeColor) this.c.multiplyScalar(1 - k);
      this.mesh.setColorAt(i, this.c);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export function createFlickScene(host: HTMLElement, getFrame: () => FlickFrame, low = false): FlickScene | null {
  const test = document.createElement("canvas");
  if (!test.getContext("webgl2") && !test.getContext("webgl")) return null;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let high = !coarse && !low;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }); } catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.className = "fl3d-canvas";
  host.appendChild(renderer.domElement);

  const overlay = document.createElement("div");
  overlay.className = "fl3d-overlay";
  overlay.innerHTML = `<div class="fl3d-flash"></div>`;
  host.appendChild(overlay);
  const flashEl = overlay.querySelector<HTMLDivElement>(".fl3d-flash")!;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050826);
  scene.fog = new THREE.Fog(0x050826, DIST + 4, DIST + DEPTH + 2);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(0, 0, DIST);

  scene.add(new THREE.HemisphereLight(0x8fa0ff, 0x1a1040, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 10);
  scene.add(key);

  // ===== Tunneln (byggs om när storleken ändras) =====
  const tunnel = new THREE.Group();
  scene.add(tunnel);
  const wallTex = gridTex("#3b5bff");
  const floorTex = gridTex("#7a4dff");
  const stripTex = canvasTex(256, 8, (x) => {
    const g = x.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, "rgba(255,210,63,0)"); g.addColorStop(0.45, "rgba(255,210,63,1)"); g.addColorStop(0.55, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,210,63,0)");
    x.fillStyle = g; x.fillRect(0, 0, 256, 8);
  });
  stripTex.wrapS = THREE.RepeatWrapping;
  const strips: THREE.Mesh[] = [];
  let W = 1, H = 1, vw = 1, vh = 1;
  const buildTunnel = () => {
    tunnel.clear();
    strips.length = 0;
    const mk = (w: number, h: number, tex: THREE.Texture, rx: number, ry: number) => {
      const t = tex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
      return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.9, roughness: 0.9 }));
    };
    const cell = 1.6;
    const floor = mk(vw, DEPTH, floorTex, vw / cell, DEPTH / cell); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -vh / 2, -DEPTH / 2);
    const ceil = mk(vw, DEPTH, wallTex, vw / cell, DEPTH / cell); ceil.rotation.x = Math.PI / 2; ceil.position.set(0, vh / 2, -DEPTH / 2);
    const left = mk(DEPTH, vh, wallTex, DEPTH / cell, vh / cell); left.rotation.y = Math.PI / 2; left.position.set(-vw / 2, 0, -DEPTH / 2);
    const right = mk(DEPTH, vh, wallTex, DEPTH / cell, vh / cell); right.rotation.y = -Math.PI / 2; right.position.set(vw / 2, 0, -DEPTH / 2);
    // Bakväggen: en stor glödande krona i ringar
    const back = new THREE.Mesh(new THREE.PlaneGeometry(vw, vh), new THREE.MeshBasicMaterial({ map: canvasTex(512, 512, (x) => {
      x.fillStyle = "#070b3a"; x.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 6; i++) { x.strokeStyle = `rgba(59,91,255,${0.15 + i * 0.08})`; x.lineWidth = 3; x.beginPath(); x.arc(256, 256, 60 + i * 34, 0, Math.PI * 2); x.stroke(); }
      x.fillStyle = "#ffd23f"; x.shadowColor = "#ffd23f"; x.shadowBlur = 30;
      x.beginPath(); x.moveTo(176, 300); x.lineTo(166, 210); x.lineTo(211, 246); x.lineTo(256, 186); x.lineTo(301, 246); x.lineTo(346, 210); x.lineTo(336, 300); x.closePath(); x.fill();
      x.fillRect(176, 306, 160, 22);
    }), toneMapped: false }));
    back.position.z = -DEPTH;
    tunnel.add(floor, ceil, left, right, back);
    // Ljuslister som rusar inåt längs hörnen
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const t = stripTex.clone(); t.needsUpdate = true; t.repeat.set(3, 1);
      const s = new THREE.Mesh(new THREE.PlaneGeometry(DEPTH, 0.12), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.rotation.y = Math.PI / 2;
      s.position.set(sx * (vw / 2 - 0.02), sy * (vh / 2 - 0.08), -DEPTH / 2);
      tunnel.add(s); strips.push(s);
    }
  };

  // ===== Mål, lockbete, effekter =====
  const target = makeTarget(bullseyeTex(), 0x46d9ff);
  const decoy = makeTarget(decoyTex(), 0xff3b47);
  decoy.timer.visible = false;
  scene.add(target.g, decoy.g);
  const shockMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false, side: THREE.DoubleSide, depthWrite: false });
  const shock = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), shockMat);
  scene.add(shock);
  const shards = new Burst(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3, flatShading: true }), 120, false);
  const sparks = new Burst(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 300, true);
  scene.add(shards.mesh, sparks.mesh);
  // Damm i luften
  const MOTES = 90;
  const mpos = new Float32Array(MOTES * 3);
  const mseed = Array.from({ length: MOTES }, () => [Math.random() - 0.5, Math.random() - 0.5, -Math.random() * DEPTH, Math.random() * 6]);
  const mgeo = new THREE.BufferGeometry(); mgeo.setAttribute("position", new THREE.BufferAttribute(mpos, 3));
  scene.add(new THREE.Points(mgeo, new THREE.PointsMaterial({ size: 0.09, map: dotTex(), color: 0xaab3ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));

  let composer: EffectComposer | null = null;
  const setupComposer = () => {
    composer?.dispose(); composer = null;
    if (!high) return;
    composer = new EffectComposer(renderer);
    composer.renderTarget1.samples = composer.renderTarget2.samples = 4;
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.5, 0.86));
    composer.addPass(new OutputPass());
  };
  setupComposer();

  const resize = () => {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setSize(W, H, false);
    composer?.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    vh = 2 * DIST * Math.tan((FOV * Math.PI) / 360);
    vw = vh * camera.aspect;
    buildTunnel();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  /** Spelytans (u, v) till en punkt på planet z = 0. */
  const world = (u: number, v: number, z = 0) => new THREE.Vector3((u - 0.5) * vw, (0.5 - v) * vh, z);
  /** Radie som andel av kortaste sidan → världsenheter. */
  const worldR = (r: number) => (r * Math.min(W, H)) * (vw / W);

  // ===== Händelser =====
  let shake = 0, kick = 0;
  let lastI = -2;
  let hitAnim: { at: number; p: THREE.Vector3; r: number } | null = null;
  let escape: { at: number } | null = null;
  const floats: { el: HTMLSpanElement; u: number; v: number; at: number }[] = [];
  const float = (text: string, cls: string, u: number, v: number) => {
    const el = document.createElement("span");
    el.className = `fl3d-float ${cls}`; el.textContent = text;
    overlay.appendChild(el);
    floats.push({ el, u, v, at: now() });
  };
  const flash = (cls: string) => { flashEl.className = "fl3d-flash"; void flashEl.offsetWidth; flashEl.className = `fl3d-flash on ${cls}`; };
  const burst = (p: THREE.Vector3, n: number, color: number, speed: number, size: number) => {
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.8).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      sparks.emit(p, v, 0.3 + Math.random() * 0.4, size * (0.5 + Math.random()), color);
    }
  };

  const event = (e: FlickEvent) => {
    if (e.type === "shot") { kick = 1; return; }
    const p = world(e.u, e.v, 0.1);
    if (e.type === "hit") {
      const f = getFrame();
      const t = f.course[f.i - 1] ?? f.course[f.i];
      const r = worldR(t?.r ?? 0.06);
      hitAnim = { at: now(), p, r };
      for (let k = 0; k < 26; k++) {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, 0.4 + Math.random()).normalize().multiplyScalar(4 + Math.random() * 6);
        shards.emit(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * r, (Math.random() - 0.5) * r, 0)), v, 0.9 + Math.random() * 0.4, r * (0.08 + Math.random() * 0.12), [0xf4f5ff, 0xff3b47, 0xffd23f][k % 3], 9);
      }
      burst(p, 40, 0xffd23f, 7, r * 0.06);
      burst(p, 20, 0x46d9ff, 5, r * 0.05);
      const cls = e.split < 550 ? "fast" : e.split < 900 ? "ok" : "slow";
      float(`${(e.split / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`, cls, e.u, e.v);
      if (!reduced) shake = Math.max(shake, 0.05);
    } else if (e.type === "miss") {
      burst(p, 10, 0x8fa0ff, 2.5, 0.035);
      float("+0,5 s", "pen", e.u, e.v);
    } else if (e.type === "decoy") {
      burst(p, 50, 0xff3b47, 7, 0.07);
      float("LOCKBETE +1 s", "bad", e.u, e.v);
      flash("bad");
      if (!reduced) shake = 0.25;
    } else if (e.type === "escape") {
      escape = { at: now() };
      float("FÖR SENT +1 s", "bad", e.u, e.v);
      flash("bad");
    }
  };

  // ===== Bildrutor =====
  let raf = 0, last = now(), frames = 0, slow = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    frames++;
    if (high && frames > 20 && frames < 140) {
      if (dt > 0.026) slow++;
      if (slow > 30) { high = false; renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); setupComposer(); resize(); }
    }
    const f = getFrame();
    if (f.i !== lastI) { lastI = f.i; escape = null; }
    const cur = f.i >= 0 ? f.course[f.i] : undefined;
    const age = t - f.spawnAt;

    // Målet: fälls upp (snurrar in från kanten), följer banan, bågen visar tiden kvar
    if (cur) {
      const pos = aimPos(cur, Math.max(0, age));
      const r = worldR(cur.r);
      const k = easeOutBack(age / 260);
      target.g.visible = true;
      target.g.position.copy(world(pos.x, pos.y));
      target.g.scale.setScalar(r * Math.max(0.001, k));
      target.g.rotation.set(0, (1 - clamp01(age / 260)) * Math.PI * 0.5, 0);
      target.halo.rotation.z = t / 600;
      target.ticks.rotation.z = -t / 900;
      const left = clamp01(1 - age / AIM_LIFE_MS);
      target.timer.geometry.dispose();
      target.timer.geometry = new THREE.RingGeometry(1.08, 1.16, 64, 1, Math.PI / 2, Math.PI * 2 * left);
      target.timerMat.color.set(left < 0.3 ? 0xff3b47 : 0xffd23f);
      if (escape) { const ek = clamp01((t - escape.at) / 300); target.g.scale.setScalar(r * (1 - ek)); target.g.position.z = ek * -6; }
      if (cur.decoy) {
        const dk = easeOutBack(age / 260);
        decoy.g.visible = true;
        decoy.g.position.copy(world(cur.decoy.x, cur.decoy.y));
        const pulse = 1 + Math.sin(t / 90) * 0.04;
        decoy.g.scale.setScalar(worldR(cur.r * 1.05) * Math.max(0.001, dk) * pulse);
        decoy.g.rotation.set(0, (1 - clamp01(age / 260)) * -Math.PI * 0.5, 0);
        decoy.halo.rotation.z = -t / 500;
      } else decoy.g.visible = false;
    } else { target.g.visible = false; decoy.g.visible = false; }

    // Chockvåg vid träff
    if (hitAnim) {
      const k = (t - hitAnim.at) / 420;
      if (k >= 1) { hitAnim = null; shockMat.opacity = 0; }
      else { shock.position.copy(hitAnim.p); shock.scale.setScalar(hitAnim.r * (1 + k * 2.4)); shockMat.opacity = (1 - k) * 0.9; }
    }

    // Tunneln lever
    strips.forEach((s, k) => { ((s.material as THREE.MeshBasicMaterial).map as THREE.Texture).offset.x = -(t / 1400 + k * 0.25); });
    for (let k = 0; k < MOTES; k++) {
      const [x, y, z, ph] = mseed[k];
      mpos[k * 3] = x * vw + Math.sin(t / 2000 + ph) * 0.3;
      mpos[k * 3 + 1] = y * vh + Math.sin(t / 1600 + ph * 2) * 0.2;
      mpos[k * 3 + 2] = z;
    }
    mgeo.attributes.position.needsUpdate = true;
    shards.update(dt); sparks.update(dt);

    // Kamera: liten rekyl och skak
    kick *= Math.pow(0.0005, dt);
    camera.position.set(0, 0, DIST + kick * 0.12);
    if (shake > 0.002) { camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake; shake *= Math.pow(0.003, dt); }
    camera.lookAt(camera.position.x, camera.position.y, 0);

    for (let k = floats.length - 1; k >= 0; k--) {
      const fl = floats[k];
      const a = (t - fl.at) / 1000;
      if (a > 0.9) { fl.el.remove(); floats.splice(k, 1); continue; }
      fl.el.style.transform = `translate(${Math.min(0.82, Math.max(0.18, fl.u)) * W}px, ${fl.v * H - a * 40}px) translate(-50%, -50%) scale(${a < 0.1 ? 0.6 + a * 4 : 1})`;
      fl.el.style.opacity = String(a > 0.6 ? 1 - (a - 0.6) / 0.3 : 1);
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
        mats.forEach((x) => { (x as THREE.MeshStandardMaterial).map?.dispose(); (x as THREE.MeshStandardMaterial).emissiveMap?.dispose(); x.dispose(); });
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      overlay.remove();
    },
  };
}
