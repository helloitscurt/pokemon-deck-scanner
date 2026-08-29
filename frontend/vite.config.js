import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

function readAppVersion() {
  try {
    return readFileSync(resolve(__dirname, '..', 'VERSION'), 'utf-8').trim()
  } catch {
    return packageJson.version
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    // Individual environment default stays 'node' (vitest's own default,
    // unchanged) — DOM-rendering tests opt in per-file via a leading
    // `// @vitest-environment jsdom` comment instead of switching this
    // globally, so the other ~35 existing logic-only test files keep
    // running exactly as before.
    setupFiles: ['./src/test-setup.js'],
  },
})
