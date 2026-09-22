import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
}

// 主构建和 worker 子构建都不打包这些依赖，交给使用方的打包器解析。
// worker 子构建默认不继承 rollupOptions.external，缺了会把 xlsx-js-style 整包
// 和 base64 的 WASM 内联进 dist/assets，使用方要下载两份 WASM。
const externalDependencies = [
  'vue',
  '@lucide/vue',
  'es-toolkit',
  'xlsx-js-style',
  'vue-canvas-sheet/wasm'
]

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: [
      ...(command === 'serve' ? [
        {
          find: /^vue-canvas-sheet\/wasm$/,
          replacement: import.meta.dirname + '/src/wasm/pkg/table_wasm_engine.js'
        },
        {
          find: /^vue-canvas-sheet\/plugins$/,
          replacement: import.meta.dirname + '/src/plugins/index.js'
        }
      ] : []),
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
    format: 'es',
    rollupOptions: {
      external: externalDependencies
    }
  },
  build: {
    lib: {
      entry: {
        'core': import.meta.dirname + '/src/core/index.js',
        'render': import.meta.dirname + '/src/core/render/index.js',
        'designer': import.meta.dirname + '/src/index.js',
        'icons': import.meta.dirname + '/src/icons/index.js',
        'plugins': import.meta.dirname + '/src/plugins/index.js'
      },
      name: 'VueCanvasSheet',
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.${format}.js`
    },
    rollupOptions: {
      external: externalDependencies,
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
      // 2026-09-21 实测：statements 77.3 / branches 77.6 / functions 75.3 / lines 77.3
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 72,
        lines: 75,
      },
    },
  },
}))
