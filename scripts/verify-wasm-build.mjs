import { access, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkgIgnore = [
  '*',
  '!.gitignore',
  '!package.json',
  '!table_wasm_engine.js',
  '!table_wasm_engine.d.ts',
  '!table_wasm_engine_bg.wasm',
  '!table_wasm_engine_bg.wasm.d.ts',
  ''
].join('\n');

const requiredFiles = [
  'src/wasm/pkg/table_wasm_engine.js',
  'src/wasm/pkg/table_wasm_engine.d.ts',
  'src/wasm/pkg/table_wasm_engine_bg.wasm',
  'src/wasm/pkg/table_wasm_engine_bg.wasm.d.ts',
  'src/wasm/pkg/package.json'
];

const missing = [];

for (const file of requiredFiles) {
  const abs = resolve(file);
  try {
    await access(abs);
    const info = await stat(abs);
    if (!info.isFile() || info.size === 0) {
      missing.push(`${file} is empty or not a file`);
    }
  } catch {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error('[wasm] Build output is incomplete:');
  for (const file of missing) {
    console.error(`  - ${file}`);
  }
  console.error('Run `npm run build:wasm` before publishing.');
  process.exit(1);
}

await writeFile(resolve('src/wasm/pkg/.gitignore'), pkgIgnore);

console.log('[wasm] Build output verified.');
