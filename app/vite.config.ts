import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)

/**
 * Kentas röst (Piper): lägg fonemiseraren (espeak-ng i WASM) under /piper/ så att den serveras från vår
 * egen domän. ONNX Runtimes wasm tar Vite hand om själv (assets/), röstmodellen hämtas från Hugging Face.
 */
function piperAssets(): Plugin {
  const phon = dirname(require.resolve('@diffusionstudio/piper-wasm/build/piper_phonemize.js'))
  const files: [string, string][] = [
    [join(phon, 'piper_phonemize.js'), 'piper/piper_phonemize.js'],
    [join(phon, 'piper_phonemize.wasm'), 'piper/piper_phonemize.wasm'],
    [join(phon, 'piper_phonemize.data'), 'piper/piper_phonemize.data'],
  ]
  return {
    name: 'piper-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = files.find(([, to]) => req.url === `/${to}`)
        if (!hit) return next()
        res.setHeader('content-type', hit[1].endsWith('.wasm') ? 'application/wasm' : hit[1].endsWith('js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(hit[0]))
      })
    },
    generateBundle() {
      for (const [from, to] of files) this.emitFile({ type: 'asset', fileName: to, source: readFileSync(from) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), piperAssets()],
})
