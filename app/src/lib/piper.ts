// Piper: neural talsyntes som körs helt i webbläsaren (gratis, MIT). Används för Kentas röst.
//
// - Rösten sv_SE-nst-medium (~63 MB) hämtas från Hugging Face första gången och sparas i webbläsarens
//   Cache Storage, så nästa quizkväll laddas den direkt.
// - Fonemiseringen (espeak-ng i WASM, @diffusionstudio/piper-wasm) ligger hos oss under /piper/ (kopieras
//   från node_modules vid bygget, se vite.config.ts). ONNX Runtimes wasm buntar Vite i assets/.
// - Fyllan styrs i själva modellen: längre length_scale = långsammare, högre noise = vingligare.
//
// Allt laddas med dynamisk import så att quizet i övrigt inte blir tyngre.

const BASE = "/piper/";
const VOICE = "sv_SE-nst-medium";
const MODEL_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx";
const CACHE = "kronan-piper-v1";

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;
interface ModelConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
}
interface PhonemizeModule { callMain(args: string[]): void }
type CreatePhonemize = (m: Record<string, unknown>) => Promise<PhonemizeModule>;

export type PiperStatus = "idle" | "loading" | "ready" | "failed";
export interface SynthOpts {
  /** Talhastighet: 1 = normal, högre = långsammare. */
  lengthScale?: number;
  /** Variation i uttalet (modellens standard ~0,667). */
  noiseScale?: number;
  /** Variation i rytmen (standard ~0,8). */
  noiseW?: number;
}

let status: PiperStatus = "idle";
let progress = 0;
let loading: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

let ort: Ort | null = null;
let session: Session | null = null;
let config: ModelConfig | null = null;
let createPhonemize: CreatePhonemize | null = null;
let phonemizeWasm: ArrayBuffer | null = null;
let phonemizeData: ArrayBuffer | null = null;

/** Hämta en fil via Cache Storage (sparas mellan besök). Rapporterar förlopp för stora filer. */
async function cached(url: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch { /* ingen Cache Storage */ }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const total = +(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total && onProgress) onProgress(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { await cache?.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })); } catch { /* full disk e.d. */ }
  return buf.buffer;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error(`kunde inte ladda ${src}`));
    document.head.appendChild(s);
  });
}

export const piper = {
  get status() { return status; },
  /** 0–1 under nedladdningen av rösten. */
  get progress() { return progress; },
  subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },

  /** Ladda rösten (en gång). Resolvar true när den är redo, false om det inte gick. */
  load(): Promise<boolean> {
    if (loading) return loading;
    status = "loading"; progress = 0; emit();
    loading = (async () => {
      try {
        const [o, cfgBuf] = await Promise.all([
          import("onnxruntime-web/wasm"),
          cached(`${MODEL_URL}.json`),
        ]);
        ort = o;
        ort.env.wasm.numThreads = 1; // trådar kräver cross-origin isolation, och en mening tar ändå bara bråkdelen av en sekund
        config = JSON.parse(new TextDecoder().decode(cfgBuf));
        const [model, wasm, data] = await Promise.all([
          cached(MODEL_URL, (p) => { progress = p; emit(); }),
          cached(`${BASE}piper_phonemize.wasm`),
          cached(`${BASE}piper_phonemize.data`),
          (window as unknown as { createPiperPhonemize?: CreatePhonemize }).createPiperPhonemize ? Promise.resolve() : loadScript(`${BASE}piper_phonemize.js`),
        ]);
        phonemizeWasm = wasm; phonemizeData = data;
        createPhonemize = (window as unknown as { createPiperPhonemize: CreatePhonemize }).createPiperPhonemize;
        session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
        status = "ready"; progress = 1; emit();
        return true;
      } catch (e) {
        console.warn("Piper kunde inte laddas, Kenta använder webbläsarens röst", e);
        status = "failed"; emit();
        loading = null; // går att försöka igen senare
        return false;
      }
    })();
    return loading;
  },

  /** Text → fonem-id:n med espeak-ng (en ny liten modulinstans per anrop; wasm och data återanvänds). */
  async phonemeIds(text: string): Promise<number[]> {
    if (!createPhonemize || !config) throw new Error("Piper är inte laddad");
    return new Promise<number[]>((resolve, reject) => {
      let done = false;
      createPhonemize!({
        print: (line: string) => {
          if (done) return;
          try { done = true; resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); }
        },
        printErr: () => { /* espeak pratar på stderr, ignorera */ },
        locateFile: (u: string) => BASE + u,
        wasmBinary: phonemizeWasm,
        getPreloadedPackage: () => phonemizeData,
      }).then((m) => {
        m.callMain(["-l", config!.espeak.voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
        if (!done) setTimeout(() => !done && reject(new Error("ingen fonemisering")), 3000);
      }, reject);
    });
  },

  /** Syntetisera en mening. Returnerar mono-PCM (−1..1) och samplingsfrekvens. */
  async synth(text: string, opts: SynthOpts = {}): Promise<{ pcm: Float32Array; sampleRate: number }> {
    if (status !== "ready" || !ort || !session || !config) throw new Error("Piper är inte redo");
    const ids = await this.phonemeIds(text.trim());
    const inf = config.inference;
    const feeds: Record<string, import("onnxruntime-web/wasm").Tensor> = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor("float32", Float32Array.from([
        opts.noiseScale ?? inf.noise_scale, opts.lengthScale ?? inf.length_scale, opts.noiseW ?? inf.noise_w,
      ]), [3]),
    };
    if ((config.num_speakers ?? 1) > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
    const out = await session.run(feeds);
    const pcm = out.output.data as Float32Array;
    return { pcm, sampleRate: config.audio.sample_rate };
  },

  voice: VOICE,
};

// Testkrok för CI (laddar rösten och säger en mening, returnerar antal samplar och ljudnivå).
(window as unknown as { kentaPiperTest?: unknown }).kentaPiperTest = async (text = "Hörrni! Det är jag, Kenta.") => {
  if (!(await piper.load())) return { ok: false, status: piper.status };
  const t0 = performance.now();
  const { pcm, sampleRate } = await piper.synth(text, { lengthScale: 1.3 });
  let sum = 0; for (const v of pcm) sum += v * v;
  return { ok: true, samples: pcm.length, seconds: pcm.length / sampleRate, rms: Math.sqrt(sum / pcm.length), ms: Math.round(performance.now() - t0) };
};
