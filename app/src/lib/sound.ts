// Kronans ljud: syntetiserat i WebAudio, inga ljudfiler.
//
// Ljudprofil (Eriks önskemål 2026-10-29: "vår egen härliga vibe", inte plingigt): varm neo-soul/lo-fi.
// Allt går genom en gemensam kedja med mjuk lågpass, lätt kompressor och rumsklang, och bygger på tre
// "instrument": el-piano (sinus + svag överton + tremolo), kalimba (snabbt avklingande pluck) och
// mjukt brus (andning, whoosh, trumljud). Ackorden är maj9/min9 så att även fel låter snällt.
//
// Ljud och vibration måste tåla webbläsare som saknar stödet (iOS Safari har ingen vibrate).

let ctx: AudioContext | null = null;
let out: GainNode | null = null;   // allt ljud
let wet: GainNode | null = null;   // skickas till rumsklangen

function ac(): AudioContext {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error("ingen WebAudio");
  const c = new AC();
  ctx = c;
  // Huvudkedja: varm lågpass → mjuk kompressor → högtalare
  const warm = c.createBiquadFilter(); warm.type = "lowpass"; warm.frequency.value = 5200; warm.Q.value = 0.4;
  const comp = c.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
  const master = c.createGain(); master.gain.value = 0.8;
  out = c.createGain(); out.gain.value = 1;
  out.connect(warm).connect(comp).connect(master).connect(c.destination);
  // Rumsklang: genererat impulssvar (avklingande brus), ~1,8 s
  const len = Math.floor(c.sampleRate * 1.8);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  const verb = c.createConvolver(); verb.buffer = ir;
  wet = c.createGain(); wet.gain.value = 0.32;
  wet.connect(verb).connect(warm);
  return c;
}

const safe = (fn: (c: AudioContext) => void) => { try { fn(ac()); } catch { /* ljud ej tillgängligt */ } };
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Koppla en källa till huvudkedjan och (lite) till rumsklangen. */
function route(node: AudioNode, reverb = 0.5) {
  node.connect(out!);
  if (reverb > 0) { const s = ctx!.createGain(); s.gain.value = reverb; node.connect(s).connect(wet!); }
}

/** El-piano: sinus + svag oktav + mjuk tremolo, snabb attack och lång, varm avklingning. */
function epiano(note: number, when = 0, dur = 1.4, vel = 0.12, reverb = 0.6) {
  safe((c) => {
    const t = c.currentTime + when;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const trem = c.createGain(); trem.gain.value = 1;
    const lfo = c.createOscillator(); lfo.frequency.value = 4.6;
    const lfoAmt = c.createGain(); lfoAmt.gain.value = 0.12;
    lfo.connect(lfoAmt).connect(trem.gain);
    const f = midi(note);
    const o1 = c.createOscillator(); o1.type = "sine"; o1.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2; o2.detune.value = 4;
    const o2g = c.createGain(); o2g.gain.value = 0.18;
    const o3 = c.createOscillator(); o3.type = "triangle"; o3.frequency.value = f * 4.01;
    const o3g = c.createGain(); o3g.gain.setValueAtTime(0.06, t); o3g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); // anslaget
    o1.connect(trem); o2.connect(o2g).connect(trem); o3.connect(o3g).connect(trem);
    trem.connect(g); route(g, reverb);
    for (const o of [o1, o2, o3, lfo]) { o.start(t); o.stop(t + dur + 0.05); }
  });
}

/** Kalimba/marimba: kort, rund pluck med en snabbt döende överton. */
function kalimba(note: number, when = 0, vel = 0.1, reverb = 0.7) {
  safe((c) => {
    const t = c.currentTime + when;
    const f = midi(note);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    const o1 = c.createOscillator(); o1.type = "sine"; o1.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 5.4;
    const o2g = c.createGain(); o2g.gain.setValueAtTime(0.25, t); o2g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o1.connect(g); o2.connect(o2g).connect(g); route(g, reverb);
    o1.start(t); o2.start(t); o1.stop(t + 0.75); o2.stop(t + 0.1);
  });
}

/** Mjuk basnot (sinus, lite glid). */
function bass(note: number, when = 0, dur = 0.5, vel = 0.16) {
  safe((c) => {
    const t = c.currentTime + when;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = c.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(midi(note) * 1.02, t); o.frequency.exponentialRampToValueAtTime(midi(note), t + 0.05);
    o.connect(g); route(g, 0.1); o.start(t); o.stop(t + dur + 0.05);
  });
}

let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
}

/** Filtrerat brus: whoosh (svep), andning, trumljud. */
function breath(when = 0, dur = 0.5, from = 400, to = 2400, vel = 0.06, q = 0.8, reverb = 0.5, type: BiquadFilterType = "bandpass") {
  safe((c) => {
    const t = c.currentTime + when;
    const n = noise(c);
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g); route(g, reverb); n.start(t); n.stop(t + dur + 0.05);
  });
}

/** Mjuk kick: sinus som faller i tonhöjd. */
function kick(when = 0, vel = 0.22) {
  safe((c) => {
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = c.createGain(); g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); route(g, 0); o.start(t); o.stop(t + 0.32);
  });
}

/** Strumma ett ackord (lite utspritt i tid, som en hand). */
function chord(notes: number[], when = 0, dur = 1.6, vel = 0.07, spread = 0.025) {
  notes.forEach((n, i) => epiano(n, when + i * spread, dur, vel));
}

// Ackord (MIDI): varma färger
const Fmaj9 = [53, 57, 60, 64, 67];        // F A C E G
const Dm9 = [50, 53, 57, 60, 64];          // D F A C E
const Gm9 = [55, 58, 62, 65, 69];
const C13 = [48, 52, 58, 62, 69];          // C E Bb D A
const Bbmaj7 = [46, 50, 53, 57];

export const sfx = {
  // Måste anropas i en användargest (iOS-krav): återuppta och spela en tyst buffert.
  unlock: () => {
    safe((c) => {
      if (c.state !== "running") void c.resume().catch(() => { /* */ });
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    });
  },
  /** Rätt: varmt Fmaj9 med en liten kalimbatrappa upp. */
  correct: () => {
    chord(Fmaj9, 0, 1.8, 0.065);
    [72, 76, 79, 84].forEach((n, i) => kalimba(n, 0.06 + i * 0.075, 0.085));
  },
  /** Fel: mjukt, lite melankoliskt "ojdå", två fallande toner över ett dämpat ackord. Ingen sirén. */
  wrong: () => {
    chord(Bbmaj7.map((n) => n - 12), 0, 1.0, 0.05);
    epiano(62, 0.02, 0.6, 0.07); epiano(57, 0.22, 0.9, 0.07);
  },
  /** Buzz: ett varmt, tydligt "dong" (kick + kort ackordstöt), inte en sirén. */
  buzz: () => { kick(0, 0.2); chord(Dm9.map((n) => n + 12), 0, 0.5, 0.07, 0.008); kalimba(81, 0.02, 0.07); },
  /** Låst svar: en kort, rund "tock". */
  lock: () => { kalimba(67, 0, 0.07, 0.3); breath(0, 0.08, 1800, 900, 0.03, 2, 0); },
  /** Liten träklick (Flick-målen). */
  tick: () => { kalimba(84, 0, 0.05, 0.2); },
  /** Mellan frågor / hjulet landar: luftigt svep + en dyad. */
  next: () => { breath(0, 0.45, 300, 3000, 0.045, 0.7, 0.6); epiano(69, 0.12, 0.9, 0.06); epiano(76, 0.12, 0.9, 0.05); },
  /** Ny fråga: kort upptakt (bas + kalimba). */
  question: () => { bass(41, 0, 0.5, 0.14); kalimba(72, 0.0, 0.06); kalimba(77, 0.09, 0.06); },
  /** Krönt: liten neo-soul-kadens ii–V–I med skimmer. */
  crown: () => {
    chord(Gm9, 0, 0.9, 0.06); bass(43, 0, 0.5);
    chord(C13, 0.42, 0.9, 0.06); bass(36, 0.42, 0.5);
    chord(Fmaj9.map((n) => n + 12), 0.84, 2.6, 0.06); bass(41, 0.84, 1.4);
    [84, 88, 91, 96].forEach((n, i) => kalimba(n, 1.0 + i * 0.09, 0.06));
    breath(0.8, 1.6, 2000, 8000, 0.03, 0.4, 0.9, "highpass");
  },
  // Last hit
  bowDraw: () => breath(0, 0.15, 900, 2600, 0.035, 6, 0.1),
  bowRelease: () => { breath(0, 0.22, 3000, 700, 0.05, 1.2, 0.2); kalimba(55, 0, 0.05, 0.1); },
  arrowHit: () => { kick(0, 0.12); breath(0, 0.07, 2500, 1200, 0.04, 1, 0.1); },
  thud: () => { kick(0, 0.07); },
  lastHit: () => { kick(0, 0.16); [79, 84, 88].forEach((n, i) => kalimba(n, 0.04 + i * 0.06, 0.09)); epiano(72, 0.05, 1.2, 0.05); },
  denied: () => { epiano(55, 0, 0.5, 0.07); epiano(54, 0.14, 0.8, 0.07); },
};

// ===== Bakgrundsmusik (TV-vyn) =====
//
// En lugn, generativ lo-fi-slinga (82 bpm): Fmaj9 – Em7 – Dm9 – C13 i el-piano, mjuk kick/virvel/hihat
// och lite vinylbrus. "think" (under frågor) är samma groove men med hihats i sextondelar och lite mer driv.

type Mood = "chill" | "think";
const BPM = 82;
const PROG = [Fmaj9, [52, 55, 59, 62], Dm9, C13];
const BASS = [41, 40, 38, 36];
let musicTimer: ReturnType<typeof setInterval> | null = null;
let nextBeat = 0;
let beat = 0;
let mood: Mood = "chill";
let musicGain: GainNode | null = null;

function scheduleBeat(c: AudioContext, t: number, b: number) {
  const bar = Math.floor(b / 4) % PROG.length;
  const pos = b % 4;
  const when = t - c.currentTime;
  const spb = 60 / BPM;
  const swing = spb / 2 * 0.58;
  if (pos === 0) { chord(PROG[bar], when, spb * 3.6, 0.04, 0.03); bass(BASS[bar] - 12 + 12, when, spb * 1.6, 0.11); }
  if (pos === 2) bass(BASS[bar] + 7, when, spb * 0.9, 0.07);
  if (pos === 0 || pos === 2) kick(when, 0.13);
  if (pos === 1 || pos === 3) breath(when, 0.18, 1800, 1400, 0.04, 0.7, 0.4);          // mjuk virvel
  breath(when, 0.05, 7000, 9000, 0.012, 0.8, 0, "highpass");                            // hihat på slaget
  breath(when + swing, 0.04, 7000, 9000, 0.009, 0.8, 0, "highpass");                    // swingad åttondel
  if (mood === "think") { breath(when + spb * 0.25, 0.03, 8000, 9500, 0.006, 0.8, 0, "highpass"); }
  if (pos === 3 && Math.random() < 0.35) kalimba([72, 74, 76, 79, 81][Math.floor(Math.random() * 5)], when + swing, 0.03, 0.8);
}

export const music = {
  get playing() { return !!musicTimer; },
  start(m: Mood = "chill") {
    mood = m;
    if (musicTimer) return;
    safe((c) => {
      if (!musicGain) { musicGain = c.createGain(); musicGain.gain.value = 0.55; }
      nextBeat = c.currentTime + 0.1; beat = 0;
      const spb = 60 / BPM;
      musicTimer = setInterval(() => {
        const cc = ctx!;
        while (nextBeat < cc.currentTime + 0.25) { scheduleBeat(cc, nextBeat, beat); nextBeat += spb; beat += 1; }
      }, 60);
    });
  },
  mood(m: Mood) { mood = m; },
  stop() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } },
};

// ===== Vibration =====

// Vibrationsmönster (ms). Olika känsla för tryck, rätt och fel.
export const HAPTIC = {
  buzz: [40],
  correct: [40, 60, 40, 60, 120],
  wrong: [300, 80, 300],
} as const;

function vibrate(pattern: readonly number[]) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator && typeof navigator.vibrate === "function") {
      navigator.vibrate([...pattern]);
    }
  } catch { /* vibration ej tillgänglig */ }
}

export const haptic = {
  buzz: () => vibrate(HAPTIC.buzz),
  correct: () => vibrate(HAPTIC.correct),
  wrong: () => vibrate(HAPTIC.wrong),
};
