// Syntetiserade ljud via WebAudio, inga ljudfiler behövs.
let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new AudioContext());

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
  unlock: () => { try { ac().resume(); } catch { /* */ } },
  buzz: () => { tone(220, 0.35, "sawtooth", 0.16); tone(110, 0.35, "square", 0.08); },
  correct: () => { tone(660, 0.12, "triangle", 0.18); tone(880, 0.12, "triangle", 0.18, 0.1); tone(1320, 0.25, "triangle", 0.16, 0.2); },
  wrong: () => { tone(300, 0.5, "sawtooth", 0.14, 0, 90); },
  tick: () => tone(1200, 0.04, "square", 0.05),
  next: () => { tone(523, 0.08, "triangle", 0.12); tone(784, 0.14, "triangle", 0.12, 0.07); },
  crown: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, "triangle", 0.14, i * 0.11)),
};
