import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const componentSource = resolve(import.meta.dirname, '../../src')
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: /^vue-canvas-sheet$/,
        replacement: resolve(componentSource, 'index.js')
      },
      {
        find: /^vue-canvas-sheet\/core$/,
        replacement: resolve(componentSource, 'core/index.js')
      },
      {
        find: /^vue-canvas-sheet\/plugins$/,
        replacement: resolve(componentSource, 'plugins/index.js')
      },
      {
        find: /^vue-canvas-sheet\/wasm$/,
        replacement: resolve(componentSource, 'wasm/pkg/table_wasm_engine.js')
      },
      {
        find: /^@\//,
        replacement: `${componentSource}/`
      }
    ],
    dedupe: ['vue']
  },
  worker: {
    format: 'es'
  },
  server: {
    host: '127.0.0.1',
    port: 8890,
    headers: crossOriginIsolationHeaders,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8891',
        changeOrigin: true,
        headers: {
          Origin: 'http://127.0.0.1:8890'
        }
      }
    }
  },
  preview: {
    headers: crossOriginIsolationHeaders
  }
})
