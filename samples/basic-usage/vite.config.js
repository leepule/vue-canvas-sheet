import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  base: '/vue-canvas-sheet/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      'vue-canvas-sheet': path.resolve(__dirname, '../../src/index.js')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 3000,
    // SharedArrayBuffer 仍需这些 Header
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    }
  }
})
