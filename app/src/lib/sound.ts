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
  // Kenta, fyllot. Medvetet fula ljud, men genom samma varma kedja.
  /** Rap: sågtand runt 80 Hz med skrovlig vibrato genom ett mörkt formantfilter. len 0–1 = kort–långt. */
  burp: (len = 0.5) => {
    safe((c) => {
      const t = c.currentTime;
      const dur = 0.35 + len * 0.7;
      const o = c.createOscillator(); o.type = "sawtooth";
      const f0 = 70 + Math.random() * 30;
      o.frequency.setValueAtTime(f0 * 1.3, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.08);
      o.frequency.linearRampToValueAtTime(f0 * 0.82, t + dur);
      const rasp = c.createOscillator(); rasp.frequency.value = 22 + Math.random() * 10;
      const raspAmt = c.createGain(); raspAmt.gain.value = f0 * 0.35;
      rasp.connect(raspAmt).connect(o.frequency);
      const form = c.createBiquadFilter(); form.type = "bandpass"; form.Q.value = 2.5;
      form.frequency.setValueAtTime(520, t); form.frequency.linearRampToValueAtTime(380, t + dur);
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1100;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
      g.gain.setValueAtTime(0.45, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(form).connect(lp).connect(g); route(g, 0.15);
      o.start(t); rasp.start(t); o.stop(t + dur + 0.05); rasp.stop(t + dur + 0.05);
    });
    breath(0, 0.3 + len * 0.5, 300, 200, 0.05, 1.5, 0.1, "lowpass");
  },
  /** Hick: snabb glidning uppåt med ett litet klick. */
  hiccup: () => {
    safe((c) => {
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = "triangle";
      o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(820, t + 0.07);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); route(g, 0.3); o.start(t); o.stop(t + 0.16);
    });
    breath(0, 0.06, 2500, 1200, 0.06, 1.5, 0.2);
  },
  /** Skål: två glas som klirrar (oharmoniska sinustoner som klingar ut). */
  clink: () => {
    safe((c) => {
      for (const [when, base] of [[0, 2350], [0.09, 2610]] as const) {
        const t = c.currentTime + when;
        for (const [mul, v] of [[1, 0.06], [1.51, 0.035], [2.37, 0.02]] as const) {
          const o = c.createOscillator(); o.type = "sine"; o.frequency.value = base * mul;
          const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
          o.connect(g); route(g, 0.7); o.start(t); o.stop(t + 0.95);
        }
      }
    });
  },
  /** Klunk: två dova "glugg". */
  gulp: () => {
    safe((c) => {
      for (const when of [0, 0.32]) {
        const t = c.currentTime + when;
        const o = c.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.12);
        const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g); route(g, 0.2); o.start(t); o.stop(t + 0.2);
      }
    });
  },
};

// ===== Hookertime (anime-intro) =====
// Medvetet bryter de här mot den mjuka ljudprofilen: det ska kännas som att något går sönder.

/** Kort fyrkantsstöt (digitalt fel). */
function blip(when: number, f: number, dur: number, vel: number) {
  safe((c) => {
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = "square"; o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f * (Math.random() < 0.5 ? 0.25 : 3)), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vel, t); g.gain.setValueAtTime(0.0001, t + dur);
    o.connect(g); route(g, 0); o.start(t); o.stop(t + dur + 0.01);
  });
}

export const hookSfx = {
  /** Glitch: hackiga digitala stötar och brus i ~1,6 s. */
  glitch: () => {
    let t = 0;
    while (t < 1.6) {
      const d = 0.02 + Math.random() * 0.09;
      if (Math.random() < 0.6) blip(t, 80 + Math.random() * 2400, d, 0.05 + Math.random() * 0.05);
      else breath(t, d + 0.03, 200 + Math.random() * 6000, 100 + Math.random() * 8000, 0.12, 4, 0, "bandpass");
      t += d + Math.random() * 0.07;
    }
  },
  /** Stort anime-slag: djup kick, smäll och lång klang. */
  impact: () => {
    safe((c) => {
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.6);
      const g = c.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g); route(g, 0.4); o.start(t); o.stop(t + 1.2);
    });
    breath(0, 0.5, 4000, 300, 0.22, 0.6, 1.2, "lowpass");
    chord([38, 45, 50, 57], 0, 2.2, 0.05, 0);
  },
  /** Svisch som ett svärd: brus som sveper upp och en metallisk ton. */
  slash: () => {
    breath(0, 0.28, 900, 9000, 0.16, 1.4, 0.4, "bandpass");
    safe((c) => {
      const t = c.currentTime + 0.1;
      for (const f of [2960, 4410]) {
        const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f;
        const g = c.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g); route(g, 0.8); o.start(t); o.stop(t + 0.95);
      }
    });
  },
  /** Stigande spänning (brus + sågtand uppåt) under `dur` sekunder. */
  riser: (dur = 2) => {
    breath(0, dur, 300, 9000, 0.1, 1, 0.5, "highpass");
    safe((c) => {
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = "sawtooth";
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(880, t + dur);
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(5000, t + dur);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + dur * 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
      o.connect(f).connect(g); route(g, 0.3); o.start(t); o.stop(t + dur + 0.1);
    });
  },
  /** Mässingsstöt (VS-skärmen): mollackord i breda sågtänder. */
  stab: () => {
    safe((c) => {
      const t = c.currentTime;
      for (const n of [50, 57, 62, 65, 69]) for (const det of [-8, 8]) {
        const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = midi(n); o.detune.value = det;
        const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(3500, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.8);
        const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.025, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
        o.connect(f).connect(g); route(g, 0.5); o.start(t); o.stop(t + 1.4);
      }
    });
    kick(0, 0.3);
  },
  /** Matchljud */
  throw: () => breath(0, 0.22, 3000, 700, 0.07, 1.2, 0.2),
  hit: () => { kick(0, 0.3); breath(0, 0.3, 5000, 600, 0.14, 1, 0.5); blip(0, 1200, 0.05, 0.04); },
  clank: () => { kalimba(91, 0, 0.06, 0.3); breath(0, 0.08, 4000, 2000, 0.05, 3, 0.2); },
  roundWin: () => { hookSfx.impact(); [72, 76, 79].forEach((n, i) => kalimba(n, 0.1 + i * 0.08, 0.08)); },
};

// ===== Röst (Kenta) =====

/**
 * Spela upp syntetiserat tal genom samma varma kedja. Fyllan läggs på här: lite långsammare och
 * mörkare uppspelning, en sjösjuk vobbling i tonhöjden och dovare klang ju fullare han är (level 1–6).
 * Resolvar när repliken är slut (eller direkt om ljud saknas).
 */
export function playVoice(pcm: Float32Array, sampleRate: number, level: number): { done: Promise<void>; stop: () => void } {
  let stop = () => {};
  const done = new Promise<void>((resolve) => {
    let started = false;
    safe((c) => {
      const buf = c.createBuffer(1, pcm.length, sampleRate);
      buf.getChannelData(0).set(pcm);
      const src = c.createBufferSource(); src.buffer = buf;
      const t = c.currentTime + 0.02;
      const base = Math.max(0.86, 1.0 - level * 0.022);
      src.playbackRate.setValueAtTime(base, t);
      // Vobbling: långsam LFO på uppspelningshastigheten (= tonhöjd och tempo vinglar).
      const lfo = c.createOscillator(); lfo.frequency.value = 0.45 + level * 0.12;
      const amt = c.createGain(); amt.gain.value = 0.006 + level * 0.007;
      lfo.connect(amt).connect(src.playbackRate);
      const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.max(2600, 7000 - level * 650); lp.Q.value = 0.5;
      const g = c.createGain(); g.gain.value = 1.1;
      src.connect(lp).connect(g); route(g, 0.18 + level * 0.03);
      src.onended = () => { try { lfo.stop(); } catch { /* */ } resolve(); };
      lfo.start(t); src.start(t);
      stop = () => { try { src.stop(); } catch { /* */ } };
      started = true;
    });
    if (!started) resolve();
  });
  return { done, stop: () => stop() };
}

// ===== Bakgrundsmusik (TV-vyn) =====
//
// En lugn, generativ lo-fi-slinga (82 bpm): Fmaj9 – Em7 – Dm9 – C13 i el-piano, mjuk kick/virvel/hihat
// och lite vinylbrus. "think" (under frågor) är samma groove men med hihats i sextondelar och lite mer driv.

type Mood = "chill" | "think" | "lift";
const BPM = 82;
const PROG = [Fmaj9, [52, 55, 59, 62], Dm9, C13];
const BASS = [41, 40, 38, 36];
let musicTimer: ReturnType<typeof setInterval> | null = null;
let nextBeat = 0;
let beat = 0;
let mood: Mood = "chill";
let liftBeat = 0;
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

// ===== Hissmusik (mellan frågorna) =====
//
// Eriks önskemål 2026-11-01: hissmusik mellan frågorna. Egen bossa-muzak i 116 bpm: vibrafon som spelar en
// egenskriven, lagom glättig melodi över maj7/ii–V, el-piano som kompar bossa, kontrabas på 1 och 3,
// kantslag i en mjuk clave, shaker i åttondelar. Var tredje varv spelar bara kompet (vibrafonen "vilar").

const LIFT_BPM = 116;
/** Ackord per takt (8 takter) och basens grundton. */
const LIFT_CHORDS: number[][] = [
  [53, 57, 60, 64], [50, 53, 57, 60], [55, 58, 62, 65], [48, 52, 55, 58],
  [57, 60, 64, 67], [50, 54, 57, 60], [55, 58, 62, 65], [48, 52, 58, 61],
];
const LIFT_ROOTS = [41, 38, 43, 36, 45, 38, 43, 36];
/** Melodin: [slag i takten, ton, längd i slag]. */
const LIFT_MELODY: [number, number, number][][] = [
  [[0, 72, 1], [1, 69, 0.5], [1.5, 72, 0.5], [2, 76, 1.5]],
  [[0, 74, 1], [1, 72, 0.5], [1.5, 69, 0.5], [2, 65, 1.5]],
  [[0, 70, 0.5], [0.5, 72, 0.5], [1, 74, 1], [2.5, 77, 1]],
  [[0, 76, 1.5], [2, 74, 0.5], [2.5, 72, 0.5], [3, 70, 1]],
  [[0, 72, 1], [1, 76, 1], [2, 79, 1.5]],
  [[0, 78, 0.5], [0.5, 76, 0.5], [1, 74, 1], [2, 72, 1.5]],
  [[0, 70, 1], [1, 74, 0.5], [1.5, 77, 0.5], [2, 76, 1]],
  [[0, 72, 2], [3, 67, 0.5], [3.5, 69, 0.5]],
];

/** Vibrafon: ren sinus med en svag hög delton och snabb tremolo (motorn i en riktig vibrafon). */
function vibes(note: number, when = 0, dur = 1, vel = 0.06) {
  safe((c) => {
    const t = c.currentTime + when;
    const len = Math.max(0.6, dur * 1.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(vel * 0.45, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const trem = c.createGain(); trem.gain.value = 0.8;
    const lfo = c.createOscillator(); lfo.frequency.value = 5.8;
    const la = c.createGain(); la.gain.value = 0.2; lfo.connect(la).connect(trem.gain);
    const f = midi(note);
    const o1 = c.createOscillator(); o1.type = "sine"; o1.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 4;
    const o2g = c.createGain(); o2g.gain.setValueAtTime(0.12, t); o2g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o1.connect(trem); o2.connect(o2g).connect(trem); trem.connect(g); route(g, 0.55);
    for (const o of [o1, o2, lfo]) { o.start(t); o.stop(t + len + 0.05); }
  });
}

/** Kantslag (rim click): kort, torrt "tick". */
function rim(when = 0, vel = 0.05) {
  breath(when, 0.035, 1900, 1700, vel, 9, 0.15);
  safe((c) => {
    const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = "triangle"; o.frequency.value = 820;
    const g = c.createGain(); g.gain.setValueAtTime(vel * 0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g); route(g, 0.1); o.start(t); o.stop(t + 0.04);
  });
}

function scheduleLift(c: AudioContext, t: number, b: number) {
  const bar = Math.floor(b / 4) % LIFT_CHORDS.length;
  const lap = Math.floor(b / (4 * LIFT_CHORDS.length));
  const pos = b % 4;
  const when = t - c.currentTime;
  const spb = 60 / LIFT_BPM;
  const ch = LIFT_CHORDS[bar], root = LIFT_ROOTS[bar];
  // Bas: grundton på 1, kvint på "och" före 3 och på 3, grundton på "och" efter 4 (bossa)
  if (pos === 0) bass(root, when, spb * 0.9, 0.12);
  if (pos === 1) bass(root + 7, when + spb * 0.5, spb * 0.45, 0.09);
  if (pos === 2) bass(root + 7, when, spb * 0.9, 0.11);
  if (pos === 3) bass(root, when + spb * 0.5, spb * 0.45, 0.09);
  // Komp: korta el-piano-ackord i bossarytm
  const comp = (off: number) => chord(ch.map((n) => n + 12), when + off, spb * 0.7, 0.026, 0.012);
  if (pos === 0) comp(0);
  if (pos === 1) comp(spb * 0.5);
  if (pos === 3) comp(0);
  // Kantslag i en mjuk clave (två takters mönster), shaker i åttondelar, mjuk kick på 1 och 3
  const clave = bar % 2 === 0 ? [[0, 0], [1, 0.5], [3, 0]] : [[1, 0], [2, 0.5]];
  for (const [p, off] of clave) if (p === pos) rim(when + spb * off, 0.035);
  breath(when, 0.05, 6500, 8000, 0.007, 0.8, 0, "highpass");
  breath(when + spb * 0.5, 0.06, 6500, 8000, 0.011, 0.8, 0, "highpass");
  if (pos === 0 || pos === 2) kick(when, 0.07);
  // Melodi på vibrafon, vilar var tredje varv (då bara ett och annat ackordtonsplingande)
  if (lap % 3 === 2) {
    if (pos === 2 && bar % 2 === 1) vibes(ch[3] + 12, when + spb * 0.5, 1, 0.035);
    return;
  }
  for (const [at, note, dur] of LIFT_MELODY[bar]) {
    if (Math.floor(at) === pos) vibes(note, when + (at - pos) * spb, dur, 0.055);
  }
}

export const music = {
  get playing() { return !!musicTimer; },
  start(m: Mood = "chill") {
    mood = m;
    if (musicTimer) return;
    safe((c) => {
      if (!musicGain) { musicGain = c.createGain(); musicGain.gain.value = 0.55; }
      nextBeat = c.currentTime + 0.1; beat = 0; liftBeat = 0;
      musicTimer = setInterval(() => {
        const cc = ctx!;
        while (nextBeat < cc.currentTime + 0.25) {
          if (mood === "lift") { scheduleLift(cc, nextBeat, liftBeat); liftBeat += 1; nextBeat += 60 / LIFT_BPM; }
          else { scheduleBeat(cc, nextBeat, beat); beat += 1; nextBeat += 60 / BPM; }
        }
      }, 60);
    });
  },
  mood(m: Mood) {
    // Hissmusiken börjar om från första takten varje gång den kommer tillbaka.
    if (m === "lift" && mood !== "lift") liftBeat = 0;
    mood = m;
  },
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
