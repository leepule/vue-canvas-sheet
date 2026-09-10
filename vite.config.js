import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
}

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  resolve: {
    alias: [
      ...(command === 'serve' ? [{
        find: /^vue-canvas-sheet\/wasm$/,
        replacement: import.meta.dirname + '/src/wasm/pkg/table_wasm_engine.js'
      }] : []),
      { find: '@', replacement: import.meta.dirname + '/src' },
      { find: /^vue-canvas-sheet$/, replacement: import.meta.dirname + '/src/index.js' }
    ],
  },
  server: {
    port: 8888,
    headers: crossOriginIsolationHeaders
  },
  preview: {
    headers: crossOriginIsolationHeaders
  },
  worker: {
    format: 'es'
  },
  build: {
    lib: {
      entry: {
        'core': import.meta.dirname + '/src/core/index.js',
        'render': import.meta.dirname + '/src/core/render/index.js',
        'designer': import.meta.dirname + '/src/index.js'
      },
      name: 'VueCanvasSheet',
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.${format}.js`
    },
    rollupOptions: {
      external: [
        'vue',
        'es-toolkit',
        'xlsx-js-style',
        'vue-canvas-sheet/wasm'
      ],
      output: {
        exports: 'named',
        globals: {
          vue: 'Vue'
        }
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.spec.js', 'tests/**/*.test.js'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.js', 'src/plugins/**/*.js'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 65,
        lines: 70,
      },
    },
  },
}))
