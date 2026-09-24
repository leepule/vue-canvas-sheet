import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PACKAGE_SIZE = 10 * 1024 * 1024;
const MAX_ENTRY_COUNT = 200;
const FORBIDDEN_PREFIXES = ['src/wasm/target/'];
// xlsx-js-style 与 WASM 只允许内联在 worker 单文件里，不应作为独立资源出现在 dist/assets。
const FORBIDDEN_PATTERNS = [/^dist\/assets\/xlsx/, /^dist\/assets\/table_wasm_engine/];
// 使用方打包器把 worker 当静态资源原样拷贝，worker 里任何 import 都无法解析。见 vite.config.js 的 workerBundlePlugin。
const WORKER_FILE = /^dist\/assets\/[\w-]+\.worker-[\w-]+\.js$/;
const WORKER_IMPORT = /\bimport\s*\(|\bimport\s*["'{*]|\bfrom\s*["']/;
// wasm 二进制头 \0asm 的 base64，出现即说明 .wasm 被整个内联进了 worker。
const INLINED_WASM = 'AGFzbQ';
const REQUIRED_FILES = [
  'dist/core.es.js',
  'dist/designer.es.js',
  'dist/icons.es.js',
  'dist/plugins.es.js',
  'dist/render.es.js',
  'dist/vue-canvas-sheet.css',
  'types/icons.d.ts',
  'types/core.d.ts',
  'types/index.d.ts',
  'types/plugins.d.ts',
  'types/render.d.ts'
];

const npmCache = await mkdtemp(join(tmpdir(), 'vue-canvas-sheet-npm-cache-'));
let stdout;
try {
  ({ stdout } = await execFileAsync(
    'npm',
    ['pack', '--dry-run', '--json'],
    {
      env: { ...process.env, npm_config_cache: npmCache },
      maxBuffer: 10 * 1024 * 1024
    }
  ));
} finally {
  await rm(npmCache, { recursive: true, force: true });
}
const [packageReport] = JSON.parse(stdout);
const packagedFiles = packageReport.files || [];
const forbiddenFiles = packagedFiles.filter(({ path }) =>
  FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix)) ||
  FORBIDDEN_PATTERNS.some(pattern => pattern.test(path))
);
const packagedPaths = new Set(packagedFiles.map(({ path }) => path));
const missingFiles = REQUIRED_FILES.filter(path => !packagedPaths.has(path));
const failures = [];

if (forbiddenFiles.length > 0) {
  failures.push(`contains forbidden entries: ${forbiddenFiles.map(({ path }) => path).join(', ')}`);
}
if (missingFiles.length > 0) {
  failures.push(`missing required runtime files: ${missingFiles.join(', ')}`);
}
if (packageReport.size > MAX_PACKAGE_SIZE) {
  failures.push(`package size ${packageReport.size} exceeds ${MAX_PACKAGE_SIZE} bytes`);
}
if (packagedFiles.length > MAX_ENTRY_COUNT) {
  failures.push(`entry count ${packagedFiles.length} exceeds ${MAX_ENTRY_COUNT}`);
}

const workerFiles = packagedFiles.map(({ path }) => path).filter(path => WORKER_FILE.test(path));
if (workerFiles.length === 0) {
  failures.push('no worker bundles found in dist/assets');
}
for (const path of workerFiles) {
  const code = await readFile(path, 'utf8');
  if (WORKER_IMPORT.test(code)) {
    failures.push(`${path} contains an import; worker bundles must be self-contained`);
  }
  if (code.includes(INLINED_WASM)) {
    failures.push(`${path} inlines the WASM binary; the worker should receive wasmUrl from the main thread`);
  }
}

if (failures.length > 0) {
  console.error('[package] Release artifact validation failed:');
  failures.forEach(failure => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log(
  `[package] ${packageReport.filename}: ${packageReport.size} bytes, ` +
  `${packageReport.unpackedSize} unpacked bytes, ${packagedFiles.length} entries`
);
