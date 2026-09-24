/**
 * 使用方冒烟测试：在空 Vue + Vite 项目里安装 npm 包 tarball，类型检查、构建，
 * 再用无头 Chromium 打开构建产物，确认 formula / export Worker 在使用方项目里真正可用。
 *
 * 用法：node scripts/consumer-smoke.mjs <tarball> [工作目录]
 * 不传 tarball 时先在临时目录 npm pack。
 */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = resolve(import.meta.dirname, '..');
const PORT = 4179;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function packTarball() {
  const dir = await mkdtemp(join(tmpdir(), 'vcs-pack-'));
  const name = execFileSync(npm, ['pack', '--pack-destination', dir], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();
  return join(dir, name);
}

// 页面在任何库代码执行前包装 Worker，记录每个 Worker 的 URL、错误事件和消息类型。
const indexHtml = `<!doctype html>
<div id="app"></div>
<script>
  window.__workers = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const entry = { url: String(url).slice(0, 120), errors: [], messages: [] };
      window.__workers.push(entry);
      this.addEventListener('error', (event) => entry.errors.push(event.message || 'worker error'));
      this.addEventListener('message', (event) => {
        if (event.data && event.data.type) entry.messages.push(event.data.type);
      });
    }
  };
</script>
<script type="module" src="/src/main.js"></script>
`;

const mainJs = `import { createApp, h } from 'vue'
import { TableDesigner, Workbook, SvgIcon } from 'vue-canvas-sheet'
import { Workbook as CoreWorkbook } from 'vue-canvas-sheet/core'
import { OffscreenRenderer } from 'vue-canvas-sheet/render'
import { createExportPlugin } from 'vue-canvas-sheet/plugins'
import 'vue-canvas-sheet/style.css'

if (typeof Workbook !== 'function' || !SvgIcon || typeof OffscreenRenderer !== 'function') {
  throw new TypeError('A documented package export is unavailable')
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function formulaScenario() {
  const wb = new CoreWorkbook({ enableWasm: true })
  wb.enableWorker()
  wb.setData([[1, 2, { f: '=A1+B1' }], [3, 4, { f: '=SUM(A1:B2)' }]])
  await wb.recalcAll()
  // Worker 内的 WASM 在首条带共享内存的消息后异步加载，失败会发 init-failed 并整体降级。
  // 等它给出结论，再算一次确认后续任务仍走 Worker。
  const manager = wb._formulaEngine.workerManager
  for (let i = 0; i < 50 && !manager.getStats().useFallback && !manager.getStats().workerWasmLoaded; i++) {
    await wait(100)
  }
  await wb.recalcAll()
  const result = {
    stats: manager.getStats(),
    values: [wb.getCell(0, 2)?.v, wb.getCell(1, 2)?.v]
  }
  wb.destroy()
  return result
}

async function exportScenario() {
  const wb = new CoreWorkbook({ enableWasm: false })
  const plugin = createExportPlugin({ defaultFileName: 'smoke' })
  wb.usePlugin(plugin)
  wb.setData([['Name', 'Total'], ['A', 1], ['B', 2]])
  const result = await plugin.exportExcel()
  wb.destroy()
  return { worker: result.worker, bytes: result.bytes }
}

async function main() {
  createApp({
    render: () => h(TableDesigner, {
      initialData: [['Name', 'Total'], ['Product A', { f: '=1+1' }]]
    })
  }).mount('#app')

  const formula = await formulaScenario()
  const exported = await exportScenario()
  window.__smoke = {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    formula,
    exported,
    workers: window.__workers
  }
}

main().catch((error) => {
  window.__smoke = { fatal: String(error && error.stack || error) }
})
`;

const viteConfig = `import { defineConfig } from 'vite'

// 与 README 推荐的部署方式一致：开启跨源隔离，formula Worker 才会走 SharedArrayBuffer + WASM。
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
}

export default defineConfig({
  server: { headers },
  preview: { headers }
})
`;

async function setupConsumer(tarball, dir) {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'package-consumer', private: true, type: 'module' }, null, 2));
  run(npm, ['install', '--no-audit', '--no-fund', tarball, 'vue@^3.5.0', 'vite@^6.2.0', 'typescript@^5.8.0'], dir);

  await cp(join(repoRoot, 'tests/types/entrypoints.ts'), join(dir, 'entrypoints.ts'));
  await cp(join(repoRoot, 'tests/types/tsconfig.json'), join(dir, 'tsconfig.json'));
  run(npx, ['tsc', '-p', 'tsconfig.json'], dir);

  await writeFile(join(dir, 'index.html'), indexHtml);
  await writeFile(join(dir, 'src/main.js'), mainJs);
  await writeFile(join(dir, 'vite.config.js'), viteConfig);
  run(npx, ['vite', 'build'], dir);
}

async function startPreview(dir) {
  const server = spawn(npx, ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start within 30s')), 30_000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`:${PORT}`)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    server.on('exit', (code) => reject(new Error(`vite preview exited with code ${code}`)));
  });
  return server;
}

async function inspectPage() {
  // 与 e2e 配置一致：本地复用系统 Chrome，CI 用 Playwright 管理的 Chromium。
  const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const consoleLines = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') consoleLines.push(message.text());
    });
    page.on('pageerror', (error) => consoleLines.push(String(error)));
    const failedRequests = [];
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 30_000 });
    return { smoke: await page.evaluate(() => window.__smoke), consoleLines, failedRequests };
  } finally {
    await browser.close();
  }
}

function assertSmoke({ smoke, consoleLines, failedRequests }) {
  const failures = failedRequests.map((request) => `request failed: ${request}`);
  if (smoke.fatal) {
    failures.push(`page script threw: ${smoke.fatal}`);
  } else {
    if (!smoke.crossOriginIsolated) failures.push('page is not cross-origin isolated; the WASM worker path was not exercised');

    const { stats, values } = smoke.formula;
    if (stats.useFallback) failures.push('formula worker fell back to the main thread');
    if (!stats.workerWasmLoaded) failures.push('formula worker did not load the WASM engine');
    if (stats.fallbackTime > 0) failures.push(`formula tasks ran on the main thread (${stats.fallbackTime} ms)`);
    if (values[0] !== 3 || values[1] !== 10) failures.push(`formula results are wrong: ${JSON.stringify(values)}`);

    if (smoke.exported.worker !== true) failures.push('xlsx export fell back to the main thread');
    if (!(smoke.exported.bytes > 0)) failures.push('xlsx export produced no bytes');

    for (const worker of smoke.workers) {
      if (worker.errors.length > 0) failures.push(`worker ${worker.url} raised: ${worker.errors.join('; ')}`);
      if (worker.messages.includes('init-failed')) failures.push(`worker ${worker.url} reported init-failed`);
    }
  }

  console.log('[consumer-smoke] result:', JSON.stringify(smoke, null, 2));
  if (consoleLines.length > 0) console.log('[consumer-smoke] console warnings/errors:\n  ' + consoleLines.join('\n  '));
  if (failures.length > 0) {
    throw new Error('consumer smoke failed:\n  - ' + failures.join('\n  - '));
  }
  console.log('[consumer-smoke] ok');
}

const tarball = process.argv[2] ? resolve(process.argv[2]) : await packTarball();
const consumerDir = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'vcs-consumer-'));
console.log(`[consumer-smoke] tarball ${tarball}\n[consumer-smoke] consumer ${consumerDir}`);

await setupConsumer(tarball, consumerDir);
const server = await startPreview(consumerDir);
try {
  assertSmoke(await inspectPage());
} finally {
  server.kill();
}
