// Syntetiserade ljud via WebAudio, inga ljudfiler behövs.
// Ljud och vibration måste tåla webbläsare som saknar stödet (iOS Safari har ingen vibrate).
let ctx: AudioContext | null = null;
const ac = () => {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error("ingen WebAudio");
    ctx = new AC();
  }
  return ctx;
};

function tone(freq: number, dur: number, type: OscillatorType = "square", gain = 0.12, when = 0, slideTo?: number) {
  try {
    const c = ac();
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* ljud ej tillgängligt */ }
}

export const sfx = {
  // Måste anropas i en användargest (iOS-krav): återuppta och spela en tyst buffert.
  unlock: () => {
    try {
      const c = ac();
      if (c.state !== "running") void c.resume().catch(() => { /* */ });
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    } catch { /* */ }
  },
  buzz: () => { tone(220, 0.35, "sawtooth", 0.16); tone(110, 0.35, "square", 0.08); },
  correct: () => { tone(660, 0.12, "triangle", 0.18); tone(880, 0.12, "triangle", 0.18, 0.1); tone(1320, 0.25, "triangle", 0.16, 0.2); },
  wrong: () => { tone(300, 0.5, "sawtooth", 0.14, 0, 90); },
  tick: () => tone(1200, 0.04, "square", 0.05),
  next: () => { tone(523, 0.08, "triangle", 0.12); tone(784, 0.14, "triangle", 0.12, 0.07); },
  crown: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, "triangle", 0.14, i * 0.11)),
};

// Vibrationsmönster (ms). Olika känsla för buzz, rätt och fel.
export const HAPTIC = {
  buzz: [60],
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
