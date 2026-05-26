import { execSync } from 'node:child_process';
import { access, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const PKG_PATH = 'src/wasm/pkg';
const WASM_SRC_PATH = 'src/wasm';

const requiredFiles = [
  'table_wasm_engine.js',
  'table_wasm_engine_bg.wasm',
  'package.json'
];

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

async function checkWasmPack() {
  try {
    execSync('wasm-pack --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

async function verifyBuild() {
  console.log('[wasm] Verifying build output...');
  const missing = [];
  
  for (const file of requiredFiles) {
    const abs = resolve(PKG_PATH, file);
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
    throw new Error(`Build output is incomplete:\n  - ${missing.join('\n  - ')}`);
  }

  // Generate .gitignore to avoid tracking large binary blobs if not desired
  await writeFile(resolve(PKG_PATH, '.gitignore'), pkgIgnore);
  console.log('[wasm] Build verified successfully.');
}

async function main() {
  console.log('=== Spreadsheet Engine WASM Builder ===');
  
  const hasWasmPack = await checkWasmPack();
  if (!hasWasmPack) {
    console.error('\x1b[31m[Error] wasm-pack is not installed.\x1b[0m');
    console.log('To install wasm-pack, please visit: \x1b[34mhttps://rustwasm.github.io/wasm-pack/installer/\x1b[0m');
    console.log('Or run: \x1b[32mcurl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh\x1b[0m');
    process.exit(1);
  }

  try {
    console.log(`[wasm] Compiling Rust source in ${WASM_SRC_PATH}...`);
    
    // Run wasm-pack build
    // --target web: Essential for standard browser/vite imports
    // --release: For high-performance binaries
    execSync(`wasm-pack build ${WASM_SRC_PATH} --target web --release`, { stdio: 'inherit' });
    
    await verifyBuild();
    
    console.log('\x1b[32m[Success] WASM engine is ready for use!\x1b[0m');
  } catch (error) {
    console.error('\x1b[31m[Build Failed]\x1b[0m');
    console.error(error.message);
    process.exit(1);
  }
}

main();
