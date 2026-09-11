import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PACKAGE_SIZE = 10 * 1024 * 1024;
const MAX_ENTRY_COUNT = 200;
const FORBIDDEN_PREFIXES = ['src/wasm/target/'];
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
  FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))
);
const packagedPaths = new Set(packagedFiles.map(({ path }) => path));
const missingFiles = REQUIRED_FILES.filter(path => !packagedPaths.has(path));
const failures = [];

if (forbiddenFiles.length > 0) {
  failures.push(`contains ${forbiddenFiles.length} forbidden src/wasm/target entries`);
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

if (failures.length > 0) {
  console.error('[package] Release artifact validation failed:');
  failures.forEach(failure => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log(
  `[package] ${packageReport.filename}: ${packageReport.size} bytes, ` +
  `${packageReport.unpackedSize} unpacked bytes, ${packagedFiles.length} entries`
);
