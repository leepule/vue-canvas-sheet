import { Workbook } from '../src/core/Workbook.js';
import { formulaCompiler } from '../src/core/data/FormulaCompiler.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runBenchmark() {
  const ROWS = 50000;
  const COLS = 10;
  
  // 预加载 WASM 二进制文件 (Node.js 环境下需要手动注入)
  const wasmPath = path.resolve(__dirname, '../src/wasm/pkg/table_wasm_engine_bg.wasm');
  let wasmBinary = null;
  try {
    wasmBinary = fs.readFileSync(wasmPath);
  } catch (e) {
    console.warn(`\x1b[33m⚠️  Warning: Could not find WASM binary at ${wasmPath}. Run "npm run build:wasm" first.\x1b[0m`);
  }

  console.log(`\x1b[36m=== Vue-Canvas-Sheet Performance Benchmark ===\x1b[0m`);
  console.log(`Testing with ${ROWS.toLocaleString()} rows and ${COLS} columns...`);
  console.log(`Total formulas: ${ROWS.toLocaleString()}\n`);

  // --- 准备数据 ---
  const wb = new Workbook({ enablePersistence: false });
  
  // 注入 WASM 二进制
  if (wasmBinary) {
    wb.wasmBridge.wasmBinary = wasmBinary;
  }
  const data = [];
  for (let i = 0; i < ROWS; i++) {
    data.push([i, i * 2, i * 3]);
  }
  wb.setData(data);

  // 插入 5 万个公式: =SUM(A1:C1)
  for (let i = 0; i < ROWS; i++) {
    wb.setCell(i, 3, { v: `=SUM(A${i+1}:C${i+1})` });
  }
  formulaCompiler.clearCache();

  // --- 1. JS 引擎测试 (强制禁用 WASM) ---
  console.log('Running JS Engine Calculation...');
  const originalIsLoaded = wb.wasmBridge.isLoaded;
  wb.wasmBridge.isLoaded = false; // 强制禁用
  
  const startJs = performance.now();
  await wb.recalcAll({ useWorker: false });
  const endJs = performance.now();
  const jsTime = endJs - startJs;
  
  console.log(`✅ JS Engine Finished in: ${jsTime.toFixed(2)}ms`);
  
  // 恢复状态以准备 WASM 测试
  wb.wasmBridge.isLoaded = originalIsLoaded;

  // --- 2. WASM 引擎测试 (如果可用) ---
  console.log('\nRunning WASM Engine Calculation...');
  let wasmTime = null;
  
  // 在 Node.js 环境下加载 WASM
  const wasmReady = await wb.wasmBridge.init();
  
  if (wasmReady && wb.wasmBridge.isLoaded) {
    const startWasm = performance.now();
    await wb.recalcAll({ useWorker: false });
    const endWasm = performance.now();
    wasmTime = endWasm - startWasm;
    console.log(`✅ WASM Engine Finished in: ${wasmTime.toFixed(2)}ms`);
  } else {
    const status = wb.wasmBridge.getStatus();
    console.log(`\x1b[33m⚠️  WASM Engine skipped: ${status.fallbackReason}\x1b[0m`);
  }

  // --- 总结报告 ---
  console.log(`\n\x1b[32m--- Final Report ---\x1b[0m`);
  const report = [
    { Engine: 'JS Fallback', 'Time (ms)': jsTime.toFixed(2), Status: 'Stable' },
  ];
  if (wasmTime) {
    report.push({ Engine: 'WASM (Rust)', 'Time (ms)': wasmTime.toFixed(2), Status: 'Accelerated' });
  }
  

  if (wasmTime) {
    console.log('\nRunning WASM Engine (Cached R1C1)...');
    const startWasm2 = performance.now();
    await wb.recalcAll({ useWorker: false });
    const endWasm2 = performance.now();
    const wasmTime2 = endWasm2 - startWasm2;
    console.log(`✅ WASM Engine (Cached) Finished in: ${wasmTime2.toFixed(2)}ms`);
    
    report.push({ Engine: 'WASM (Cached)', 'Time (ms)': wasmTime2.toFixed(2), Status: 'Blazing Fast' });
  }

  console.table(report);

  if (wasmTime) {
    const speedup = jsTime / wasmTime;
    console.log(`\n🚀 WASM is \x1b[1m${speedup.toFixed(1)}x\x1b[0m faster than JS!`);
  }
}

runBenchmark().catch(console.error);
