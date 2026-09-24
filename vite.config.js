import { defineConfig, transformWithEsbuild } from 'vite'
import vue from '@vitejs/plugin-vue'
import { configDefaults } from 'vitest/config'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
}

// 主构建不打包这些依赖，交给使用方的打包器解析。
const externalDependencies = [
  'vue',
  '@lucide/vue',
  'es-toolkit',
  'xlsx-js-style',
  'vue-canvas-sheet/wasm',
  'vue-canvas-sheet/wasm/url'
]

const wasmGluePath = import.meta.dirname + '/src/wasm/pkg/table_wasm_engine.js'
const wasmGlueDefaultUrl = "new URL('table_wasm_engine_bg.wasm', import.meta.url)"
const xlsxCodepageRequire = 'require("./cpexcel.js")'

// worker 子构建必须产出不含任何 import 的单文件：使用方打包器把 dist/assets 下的 worker
// 当静态资源原样拷贝（小于 4 KB 的还会内联成 data: URL），worker 里的相对导入和裸说明符都无法解析。
// 因此 wasm-bindgen 胶水和 xlsx-js-style 都打进 worker，且产物要自己压缩，使用方不会再处理。
function workerBundlePlugin() {
  return {
    name: 'vue-canvas-sheet:worker-bundle',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'vue-canvas-sheet/wasm') return wasmGluePath
      return null
    },
    transform(code, id) {
      // 胶水里默认的 .wasm 地址在 lib 模式下会被整个以 base64 内联；worker 实际用主线程传入的 wasmUrl。
      if (id === wasmGluePath) {
        if (!code.includes(wasmGlueDefaultUrl)) {
          this.error(`wasm-bindgen glue no longer contains ${wasmGlueDefaultUrl}; update workerBundlePlugin`)
        }
        return code.replace(
          wasmGlueDefaultUrl,
          "(() => { throw new Error('WASM URL was not provided to the worker') })()"
        )
      }
      // cpexcel 是约 470 KB 的旧编码代码页表，只在读写 XLS/CSV 旧编码时用到，生成 xlsx 不需要。
      // xlsx 对缺失的代码页表有 `void 0 !== cptable` 守卫，与浏览器直接 <script> 加载时的行为一致。
      if (id.includes('/xlsx-js-style/dist/')) {
        if (!code.includes(xlsxCodepageRequire)) return null
        return code.replace(xlsxCodepageRequire, 'void 0')
      }
      return null
    },
    // 放在 generateBundle：lib 模式的 ES 输出会在 renderChunk 阶段被 Vite 重新格式化空白。
    async generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        const result = await transformWithEsbuild(chunk.code, chunk.fileName, { minify: true, format: 'esm' })
        chunk.code = result.code
      }
    }
  }
}

// tests/performance 只由 `npm run test:perf`（scripts/run-performance-tests.mjs）串行执行，
// 该脚本会设置 PERF_ARTIFACT_DIR。普通 `npm test` 排除它们，避免性能预算受并行负载影响而抖动。
const isPerfRun = Boolean(process.env.PERF_ARTIFACT_DIR)

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: [
      ...(command === 'serve' ? [
        {
          find: /^vue-canvas-sheet\/wasm$/,
          replacement: wasmGluePath
        },
        {
          find: /^vue-canvas-sheet\/wasm\/url$/,
          replacement: import.meta.dirname + '/src/wasm/url.js'
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
    plugins: () => [workerBundlePlugin()],
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
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
    // 默认 node 环境；需要 DOM 的测试文件在顶部声明 `// @vitest-environment jsdom`。
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: isPerfRun
      ? ['tests/performance/**/*.test.js']
      : ['tests/**/*.spec.js', 'tests/**/*.test.js'],
    exclude: [...configDefaults.exclude, ...(isPerfRun ? [] : ['tests/performance/**'])],
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
