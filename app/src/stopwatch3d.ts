// Stoppa klockan i 3D: bara grafik. Tidtagningen ligger kvar i Stopwatch i skill.tsx.
// Ett blankt tidtagarur på en sammetskudde i strålkastarljus. Efter de synliga sekunderna slocknar
// ljuset och visaren försvinner. Vid stopp tänds allt igen och visaren står där du stoppade,
// med en guldvisare vid målet och en båge mellan dem.
// Laddas med dynamisk import. Saknas WebGL returnerar createStopwatchScene null.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface SwFrame {
  /** Millisekunder sedan start (null innan start). */
  ms: number | null;
  hidden: boolean;
  /** Mål i sekunder. */
  target: number;
}
export type SwEvent = { type: "stop"; ms: number; diff: number } | { type: "late" };
export interface StopwatchScene {
  /** Sant när scenen har ritats några gånger (shaders kompilerade), så att klockan kan starta rättvist. */
  ready(): boolean;
  event(e: SwEvent): void;
  dispose(): void;
}

const SIGNAL = 0xffd23f;
const now = () => performance.now();
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (k: number) => 1 - (1 - clamp(k, 0, 1)) ** 3;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Hur många sekunder ett varv på tavlan är, så att målet hamnar en bit in på varvet. */
export function dialSeconds(target: number) {
  for (const s of [5, 10, 15, 20, 30, 45, 60]) if (target <= s * 0.8) return s;
  return 60;
}

function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function dialTexture(sec: number, target: number): THREE.Texture {
  const S = 1024, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  const cx = S / 2;
  const g = x.createRadialGradient(cx, cx * 0.8, 0, cx, cx, cx);
  g.addColorStop(0, "#fffdf4"); g.addColorStop(0.75, "#f1ecdc"); g.addColorStop(1, "#d9d1b8");
  x.fillStyle = g; x.beginPath(); x.arc(cx, cx, cx, 0, Math.PI * 2); x.fill();
  // Guilloché-ringar
  x.strokeStyle = "rgba(120,110,80,0.10)"; x.lineWidth = 2;
  for (let r = 60; r < cx * 0.62; r += 9) { x.beginPath(); x.arc(cx, cx, r, 0, Math.PI * 2); x.stroke(); }
  const ang = (s: number) => (s / sec) * Math.PI * 2 - Math.PI / 2;
  // Målkil
  const a0 = ang(target);
  x.fillStyle = "rgba(255,210,63,0.55)";
  x.beginPath(); x.moveTo(cx, cx); x.arc(cx, cx, cx * 0.9, a0 - 0.035, a0 + 0.035); x.closePath(); x.fill();
  // Streck
  const fine = sec <= 15 ? 0.1 : sec <= 30 ? 0.2 : 0.5;
  const major = sec <= 15 ? 1 : 5;
  const steps = Math.round(sec / fine);
  for (let i = 0; i < steps; i++) {
    const s = i * fine;
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
    const isMid = !isMajor && Math.abs((s * 2) / major - Math.round((s * 2) / major)) < 1e-6;
    const a = ang(s);
    const r1 = cx * 0.93, r0 = cx * (isMajor ? 0.8 : isMid ? 0.86 : 0.89);
    x.strokeStyle = isMajor ? "#141838" : "#4a4f70";
    x.lineWidth = isMajor ? 9 : isMid ? 5 : 3;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1); x.stroke();
  }
  // Siffror
  x.fillStyle = "#141838"; x.textAlign = "center"; x.textBaseline = "middle";
  x.font = "800 64px 'Bricolage Grotesque', system-ui, sans-serif";
  for (let s = major; s <= sec; s += major) {
    if (sec <= 15 && sec > 10 && s % 3 !== 0 && s !== sec) continue;
    const a = ang(s);
    x.fillText(String(s === sec ? sec : s), cx + Math.cos(a) * cx * 0.66, cx + Math.sin(a) * cx * 0.66);
  }
  // Märkning
  x.fillStyle = "#1b28a8";
  x.font = "800 46px 'Bricolage Grotesque', system-ui, sans-serif";
  x.fillText("KRONAN", cx, cx * 0.68);
  x.fillStyle = "#6b6f8a";
  x.font = "600 26px system-ui, sans-serif";
  x.fillText("CHRONOGRAPH", cx, cx * 0.78);
  // Krona
  x.save(); x.translate(cx, cx * 0.55); x.scale(0.42, 0.42);
  x.fillStyle = "#c9971a";
  x.beginPath(); x.moveTo(-90, 50); x.lineTo(-100, -40); x.lineTo(-50, 5); x.lineTo(0, -60); x.lineTo(50, 5); x.lineTo(100, -40); x.lineTo(90, 50); x.closePath(); x.fill();
  x.restore();
  // Mål i text
  x.fillStyle = "#8a6400";
  x.font = "800 34px 'Bricolage Grotesque', system-ui, sans-serif";
  x.fillText(`MÅL ${target.toLocaleString("sv-SE", { minimumFractionDigits: 2 })} s`, cx, cx * 1.38);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function velvetTexture(): THREE.Texture {
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  x.fillStyle = "#1b28a8"; x.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    x.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,30,0.12)";
    x.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

function makeHand(len: number, tail: number, width: number, material: THREE.Material) {
  // Pekar längs +y i tavlans plan
  const shape = new THREE.Shape();
  shape.moveTo(-width, -tail); shape.lineTo(width, -tail); shape.lineTo(width * 0.45, len); shape.lineTo(0, len + width * 1.2); shape.lineTo(-width * 0.45, len); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

export function createStopwatchScene(host: HTMLElement, getFrame: () => SwFrame, low = false): StopwatchScene | null {
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
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = high;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "lh3d-canvas";
  host.appendChild(renderer.domElement);

  const overlay = document.createElement("div");
  overlay.className = "lh3d-overlay";
  const flashEl = document.createElement("div");
  flashEl.className = "lh3d-flash";
  const bannerEl = document.createElement("div");
  bannerEl.className = "lh3d-banner";
  overlay.append(flashEl, bannerEl);
  host.appendChild(overlay);
  const banner = (text: string, kind: "hit" | "denied" | "", flash = true) => {
    bannerEl.textContent = text;
    bannerEl.className = `lh3d-banner ${kind}`;
    void bannerEl.offsetWidth;
    bannerEl.className = `lh3d-banner ${kind} show`;
    if (flash) {
      flashEl.className = `lh3d-flash ${kind || "hit"}`;
      void flashEl.offsetWidth;
      flashEl.className = `lh3d-flash ${kind || "hit"} on`;
    }
  };

  const target = getFrame().target;
  const sec = dialSeconds(target);
  const angOf = (s: number) => -(s / sec) * Math.PI * 2; // medurs sett framifrån

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050826);
  scene.fog = new THREE.Fog(0x050826, 7, 16);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);

  const hemi = new THREE.HemisphereLight(0x5a66d8, 0x0a0c22, 0.5);
  scene.add(hemi);
  const spot = new THREE.SpotLight(0xfff1d8, 16, 14, 0.36, 0.6, 1.4);
  spot.position.set(0.5, 6, 2.4);
  spot.target.position.set(0, 1.0, 0);
  spot.castShadow = high;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0004;
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0x7f8cff, 1.2);
  rim.position.set(-3, 2, -3);
  scene.add(rim);
  const fill = new THREE.PointLight(SIGNAL, 0, 5, 1.6);
  fill.position.set(0, 1.2, 2.2);
  scene.add(fill);

  // Ljuskägla (falsk volym)
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xfff1d8, transparent: true, opacity: 0.03, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(2.3, 6.2, 40, 1, true), coneMat);
  {
    const base = V(0, 0.2, 0.15);
    cone.position.copy(spot.position).lerp(base, 0.5);
    cone.quaternion.setFromUnitVectors(V(0, 1, 0), V().subVectors(spot.position, base).normalize());
    cone.scale.set(1, spot.position.distanceTo(base) / 6.2, 1);
  }
  scene.add(cone);

  // Golv och kudde
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: 0x0b1040, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const velvet = new THREE.MeshStandardMaterial({ color: 0xffffff, map: velvetTexture(), roughness: 1 });
  const cushion = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), velvet);
  cushion.scale.set(1.75, 0.3, 1.35); cushion.position.y = 0.15;
  cushion.castShadow = cushion.receiveShadow = high;
  scene.add(cushion);
  const piping = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 64), new THREE.MeshStandardMaterial({ color: SIGNAL, metalness: 0.6, roughness: 0.35 }));
  piping.rotation.x = Math.PI / 2; piping.scale.set(1.73, 1.34, 1); piping.position.y = 0.16; scene.add(piping);
  for (const [px, pz] of [[-2.1, -1.55], [2.1, -1.55], [-2.1, 1.55], [2.1, 1.55]]) {
    const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 8), new THREE.MeshStandardMaterial({ color: SIGNAL, metalness: 0.5, roughness: 0.5 }));
    tassel.position.set(px * 0.56, 0.1, pz * 0.56); scene.add(tassel);
  }

  // Uret
  const watch = new THREE.Group();
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf4, metalness: 1, roughness: 0.18 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffcf5a, metalness: 1, roughness: 0.25 });
  // Miljökarta så att kromet har något att spegla
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0e3a);
  const envLight = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  envLight.position.set(2, 5, 3); envLight.scale.setScalar(1.6); envScene.add(envLight);
  const envLight2 = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0x6c7bff }));
  envLight2.position.set(0, 1, -5); envScene.add(envLight2);
  const env = pmrem.fromScene(envScene, 0.04).texture;
  chrome.envMap = env; gold.envMap = env; chrome.envMapIntensity = 1.2; gold.envMapIntensity = 1.2;

  const R = 1.0;
  const profile = [V(0, -0.16), V(R * 0.96, -0.16), V(R * 1.05, -0.1), V(R * 1.09, 0), V(R * 1.06, 0.1), V(R * 1.0, 0.14), V(R * 0.94, 0.14)].map((p) => new THREE.Vector2(p.x, p.y));
  const caseMesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), chrome);
  caseMesh.rotation.x = Math.PI / 2; caseMesh.castShadow = high;
  watch.add(caseMesh);
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(R * 0.97, 0.045, 16, 96), gold);
  bezel.position.z = 0.14; watch.add(bezel);
  const dialMat = new THREE.MeshStandardMaterial({ map: dialTexture(sec, target), roughness: 0.55, metalness: 0, emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0 });
  const dial = new THREE.Mesh(new THREE.CircleGeometry(R * 0.93, 96), dialMat);
  dial.position.z = 0.09; dial.receiveShadow = high; watch.add(dial);
  // Lysande målring (syns även i mörkret)
  const tgtA = angOf(target);
  const tgtGlow = new THREE.Mesh(new THREE.RingGeometry(R * 0.7, R * 0.92, 24, 1, Math.PI / 2 + tgtA - 0.05, 0.1), new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.25, toneMapped: false, depthWrite: false }));
  tgtGlow.position.z = 0.095; watch.add(tgtGlow);
  // Glödbåge mellan stopp och mål (byggs vid stopp)
  const arcMat = new THREE.MeshBasicMaterial({ color: 0x2fe08f, transparent: true, opacity: 0, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
  const arc = new THREE.Mesh(new THREE.BufferGeometry(), arcMat);
  arc.position.z = 0.097; watch.add(arc);

  // Visare
  const handMat = new THREE.MeshStandardMaterial({ color: 0xff3b47, metalness: 0.3, roughness: 0.35, emissive: 0xff3b47, emissiveIntensity: 0.15 });
  const hand = makeHand(R * 0.86, R * 0.22, 0.028, handMat);
  const handPivot = new THREE.Group();
  handPivot.position.z = 0.12; handPivot.add(hand); watch.add(handPivot);
  const ghostMat = new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
  const ghost = makeHand(R * 0.86, R * 0.12, 0.022, ghostMat);
  const ghostPivot = new THREE.Group();
  ghostPivot.position.z = 0.105; ghostPivot.add(ghost); ghostPivot.rotation.z = tgtA; watch.add(ghostPivot);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 24), gold);
  cap.rotation.x = Math.PI / 2; cap.position.z = 0.14; watch.add(cap);

  // Glas
  const crystal = new THREE.Mesh(new THREE.SphereGeometry(R * 3.2, 64, 16, 0, Math.PI * 2, 0, 0.3), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, roughness: 0, metalness: 0.2, envMap: env, depthWrite: false }));
  crystal.rotation.x = Math.PI / 2; crystal.position.z = 0.14 - R * 3.2 * Math.cos(0.3) + 0.04; watch.add(crystal);
  const glint = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.62, 48, 1, 0.4, 0.9), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  glint.position.z = 0.2; watch.add(glint);

  // Krona, knapp och ögla
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 16), chrome);
  stem.position.y = R * 1.12; watch.add(stem);
  const crownKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 24), gold);
  crownKnob.position.y = R * 1.28; watch.add(crownKnob);
  for (let i = 0; i < 24; i++) {
    const k = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.15, 0.03), gold);
    const a = (i / 24) * Math.PI * 2;
    k.position.set(Math.cos(a) * 0.165, R * 1.28, Math.sin(a) * 0.165); k.rotation.y = -a; watch.add(k);
  }
  const pusher = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 24), new THREE.MeshStandardMaterial({ color: 0xff3b47, metalness: 0.4, roughness: 0.3, emissive: 0xff3b47, emissiveIntensity: 0.2 }));
  const pusherBase = R * 1.4;
  pusher.position.y = pusherBase; watch.add(pusher);
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 12, 40), chrome);
  bow.position.y = R * 1.62; watch.add(bow);
  const sidePush = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 16), chrome);
  sidePush.position.set(Math.sin(0.7) * R * 1.12, Math.cos(0.7) * R * 1.12, 0); sidePush.rotation.z = -0.7; watch.add(sidePush);

  watch.position.set(0, 1.27, 0.1);
  watch.rotation.x = -0.75;
  watch.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = high; });
  scene.add(watch);

  // Kedja som ringlar ut från öglan
  watch.updateMatrixWorld(true);
  const bowW = watch.localToWorld(V(0.15, R * 1.62 + 0.2, 0));
  const chainCurve = new THREE.CatmullRomCurve3([bowW, V(bowW.x + 0.3, 1.4, bowW.z - 0.15), V(0.8, 0.5, -0.75), V(1.3, 0.38, -0.25), V(1.45, 0.3, 0.4), V(1.15, 0.36, 0.85)]);
  const links = new THREE.InstancedMesh(new THREE.TorusGeometry(0.045, 0.014, 6, 12), gold, 70);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qa = new THREE.Quaternion();
  for (let i = 0; i < 70; i++) {
    const k = i / 69;
    const p = chainCurve.getPointAt(k), tg = chainCurve.getTangentAt(k);
    q.setFromUnitVectors(V(1, 0, 0), tg).multiply(qa.setFromAxisAngle(V(1, 0, 0), i % 2 ? Math.PI / 2 : 0));
    m4.compose(p, q, V(1.4, 1, 1));
    links.setMatrixAt(i, m4);
  }
  links.castShadow = high;
  scene.add(links);

  // Damm i ljuskäglan
  const tex = dotTexture();
  const moteN = 90;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteN * 3);
  for (let i = 0; i < moteN; i++) motePos.set([rand(-1.6, 1.8), rand(0.3, 5), rand(-0.8, 2.2)], i * 3);
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({ size: 0.05, map: tex, color: 0xfff1d8, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  scene.add(new THREE.Points(moteGeo, moteMat));

  // Gnistor
  const sparkN = 160;
  const spGeo = new THREE.BufferGeometry();
  const spPos = new Float32Array(sparkN * 3).fill(-99), spVel = new Float32Array(sparkN * 3), spLife = new Float32Array(sparkN);
  spGeo.setAttribute("position", new THREE.BufferAttribute(spPos, 3));
  const spMat = new THREE.PointsMaterial({ size: 0.09, map: tex, color: SIGNAL, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const sparks = new THREE.Points(spGeo, spMat);
  sparks.frustumCulled = false;
  scene.add(sparks);
  const burst = (n: number) => {
    for (let i = 0; i < Math.min(n, sparkN); i++) {
      const a = rand(0, Math.PI * 2);
      spPos.set([watch.position.x + Math.cos(a) * 1.1, watch.position.y + 0.2 + Math.sin(a) * 0.5, watch.position.z + 0.3], i * 3);
      spVel.set([Math.cos(a) * rand(0.8, 2.4), rand(1.2, 3.2), rand(-0.3, 0.8)], i * 3);
      spLife[i] = rand(0.7, 1.2);
    }
  };

  let composer: EffectComposer | null = null;
  if (high) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.45, 0.9));
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

  // Tillstånd
  let stopAt = -1, stopMs = 0, stopDiff = 0, late = false;
  let dark = 0; // 0 = tänt, 1 = släckt
  let push = 0;
  let shownAngle = 0;
  let raf = 0, last = now(), disposed = false, drawn = 0;
  renderer.compile(scene, camera);

  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const f = getFrame();
    const stopped = stopAt > 0;

    // Ljuset: släcks när tiden döljs, tänds med en smäll vid stopp
    const wantDark = f.hidden && !stopped ? 1 : 0;
    dark = lerp(dark, wantDark, Math.min(1, dt * (wantDark ? 3.5 : 14)));
    const flick = wantDark && dark < 0.9 ? (Math.random() < 0.25 ? 0.5 : 1) : 1;
    spot.intensity = lerp(16, 0.2, dark) * flick;
    coneMat.opacity = lerp(0.03, 0.003, dark);
    hemi.intensity = lerp(0.5, 0.08, dark);
    rim.intensity = lerp(1.2, 0.35, dark);
    moteMat.opacity = lerp(0.8, 0.05, dark);
    (tgtGlow.material as THREE.MeshBasicMaterial).opacity = lerp(0.25, 0.7, dark) * (stopped ? 0.5 : 1);
    fill.intensity = stopped ? lerp(fill.intensity, 2.5, dt * 4) : 0;

    // Visaren
    const ms = stopped ? stopMs : f.ms ?? 0;
    const want = angOf(ms / 1000);
    shownAngle = stopped ? lerp(shownAngle, want, Math.min(1, dt * 20)) : want;
    handPivot.rotation.z = shownAngle;
    handPivot.visible = !(f.hidden && !stopped) || dark < 0.35;

    // Knappen trycks ner vid start och stopp
    push = Math.max(0, push - dt * 4);
    const startPush = f.ms === null ? 0 : clamp(1 - f.ms / 250, 0, 1);
    pusher.position.y = pusherBase - Math.max(push, startPush) * 0.06;

    if (stopped) {
      const k = easeOut((t - stopAt) / 600);
      ghostMat.opacity = 0.9 * k;
      arcMat.opacity = 0.55 * k;
    }

    // Kameran: långsam drift, trycker in vid stopp
    const back = aspect < 1 ? (1 / aspect - 1) * 3.2 : 0;
    const pin = stopped ? easeOut((t - stopAt) / 900) : 0;
    const camPos = V(Math.sin(t / 3100) * 0.2, 3.0 - pin * 0.35 + back * 0.3, 4.5 - pin * 0.6 + back);
    camera.position.copy(camPos);
    camera.lookAt(0, 1.2 + back * 0.05, 0);

    for (let i = 0; i < moteN; i++) {
      motePos[i * 3 + 1] -= dt * 0.05;
      motePos[i * 3] += Math.sin(t / 1800 + i) * dt * 0.03;
      if (motePos[i * 3 + 1] < 0.3) motePos[i * 3 + 1] = 5;
    }
    moteGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < sparkN; i++) {
      if (spLife[i] <= 0) continue;
      spLife[i] -= dt;
      if (spLife[i] <= 0) { spPos[i * 3 + 1] = -99; continue; }
      spVel[i * 3 + 1] -= 5 * dt;
      for (let j = 0; j < 3; j++) spPos[i * 3 + j] += spVel[i * 3 + j] * dt;
    }
    spGeo.attributes.position.needsUpdate = true;

    if (composer) composer.render(); else renderer.render(scene, camera);
    drawn++;
  };
  raf = requestAnimationFrame(frame);

  return {
    ready: () => drawn >= 2,
    event(e) {
      stopAt = now(); push = 1;
      if (e.type === "late") {
        late = true; stopMs = (target + 5) * 1000;
        banner("FÖR SENT", "denied");
        arcMat.color.set(0xff3b47);
      } else {
        stopMs = e.ms; stopDiff = e.diff;
        const a = Math.abs(stopDiff);
        const s = `${stopDiff >= 0 ? "+" : "−"}${(a / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
        if (a <= 50) { banner("PERFEKT!", "hit"); burst(160); arcMat.color.set(0x2fe08f); }
        else if (a <= 200) { banner(s, "hit"); burst(60); arcMat.color.set(0x2fe08f); }
        else { banner(s, a > 1000 ? "denied" : "", false); arcMat.color.set(a > 1000 ? 0xff3b47 : SIGNAL); }
      }
      void late;
      // Båge mellan stopp och mål
      const a1 = angOf(stopMs / 1000), a2 = tgtA;
      const from = Math.min(a1, a2), len = Math.max(0.01, Math.abs(a1 - a2));
      arc.geometry.dispose();
      arc.geometry = new THREE.RingGeometry(R * 0.55, R * 0.78, Math.max(4, Math.ceil(len * 30)), 1, Math.PI / 2 + from, len);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      composer?.dispose();
      env.dispose(); pmrem.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        mats.forEach((x) => { (x as THREE.MeshBasicMaterial).map?.dispose(); x.dispose(); });
      });
      renderer.dispose();
      renderer.domElement.remove();
      overlay.remove();
    },
  };
}
