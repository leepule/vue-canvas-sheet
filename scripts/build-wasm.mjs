import { execSync } from 'node:child_process';
import { access, stat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PKG_PATH = 'src/wasm/pkg';
const WASM_SRC_PATH = 'src/wasm';
const WASM_BINARY = 'table_wasm_engine_bg.wasm';

// 运行时用不到的自定义段。`name` 段是函数名调试信息，约占二进制的 20%。
// 不能改用 Cargo 的 strip = true：它会连 target_features 段一起删掉，
// wasm-bindgen 检测不到 reference-types 就会退回旧的 heap 表 ABI，胶水随之改变。
const STRIP_CUSTOM_SECTIONS = new Set(['name']);

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

/**
 * 按 wasm 二进制格式逐段扫描，丢弃指定名字的自定义段，其余字节原样保留。
 * 自定义段对引擎无意义，删除后导入/导出符号和代码段完全不变。
 */
function stripCustomSections(bytes, names) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) {
    throw new Error(`${WASM_BINARY} is not a wasm v1 binary`);
  }

  let offset = 8;
  const readLeb128 = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };

  const kept = [bytes.subarray(0, 8)];
  const removed = [];
  while (offset < bytes.length) {
    const sectionStart = offset;
    const id = bytes[offset++];
    const size = readLeb128();
    const sectionEnd = offset + size;
    if (sectionEnd > bytes.length) {
      throw new Error(`${WASM_BINARY} has a truncated section at byte ${sectionStart}`);
    }

    let keep = true;
    if (id === 0) {
      const nameLength = readLeb128();
      const name = bytes.toString('utf8', offset, offset + nameLength);
      if (names.has(name)) {
        keep = false;
        removed.push({ name, bytes: sectionEnd - sectionStart });
      }
    }

    if (keep) kept.push(bytes.subarray(sectionStart, sectionEnd));
    offset = sectionEnd;
  }

  return { bytes: Buffer.concat(kept), removed };
}

async function stripDebugSections() {
  const wasmPath = resolve(PKG_PATH, WASM_BINARY);
  const original = await readFile(wasmPath);
  const { bytes, removed } = stripCustomSections(original, STRIP_CUSTOM_SECTIONS);
  if (removed.length === 0) {
    console.log('[wasm] No debug custom sections to strip.');
    return;
  }
  await writeFile(wasmPath, bytes);
  const summary = removed.map(({ name, bytes: size }) => `${name} (${size} bytes)`).join(', ');
  console.log(`[wasm] Stripped ${summary}: ${original.length} -> ${bytes.length} bytes.`);
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

    await stripDebugSections();
    await verifyBuild();
    
    console.log('\x1b[32m[Success] WASM engine is ready for use!\x1b[0m');
  } catch (error) {
    console.error('\x1b[31m[Build Failed]\x1b[0m');
    console.error(error.message);
    process.exit(1);
  }
}

main();
