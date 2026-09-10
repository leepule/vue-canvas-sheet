import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook } from '../../src/core/Workbook.js';

// 获取 WASM 模块路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = process.env.WASM_REAL_TEST_ARTIFACT
  ? path.resolve(process.env.WASM_REAL_TEST_ARTIFACT)
  : path.resolve(__dirname, '../../src/wasm/pkg/table_wasm_engine_bg.wasm');

describe('WASM Real Engine Integration', () => {
  let wasmModule;

  beforeAll(async () => {
    if (!fs.existsSync(wasmPath)) {
      throw new Error(
        `Real WASM integration test requires ${wasmPath}. Run "npm run build:wasm" before testing.`
      );
    }

    try {
      const wasmGlue = await import('../../src/wasm/pkg/table_wasm_engine.js');
      const wasmBinary = fs.readFileSync(wasmPath);
      await wasmGlue.default({ module_or_path: wasmBinary });
      wasmModule = wasmGlue;
    } catch (error) {
      throw new Error(
        'Real WASM integration test could not initialize the compiled artifact.',
        { cause: error }
      );
    }
  });

  it('WASM 引擎在 evaluate_group 计算非数值结果时，应清空共享内存中的旧数据为 NaN', () => {
    const { FormulaEngine } = wasmModule;
    const engine = new FormulaEngine();
    try {
      const sab = new SharedArrayBuffer(800);
      engine.init_shared_memory(sab, 10, 10);

      const sharedView = new Float64Array(sab);
      sharedView[0] = 10.0;

      const a1Res = engine.evaluate_group(
        new Uint32Array([0]),
        new Uint32Array([0]),
        '="abc"',
        ['0-0']
      );

      expect(a1Res.non_numeric_results['0-0']).toBe('abc');
      expect(Number.isNaN(sharedView[0])).toBe(true);

      const b1Res = engine.evaluate_group(
        new Uint32Array([0]),
        new Uint32Array([1]),
        '=A1+5',
        ['0-1']
      );

      expect(b1Res.non_numeric_results['0-1']).toBe('#VALUE!');
      expect(Number.isNaN(sharedView[1])).toBe(true);
    } finally {
      engine.free();
    }
  });

  it('多个 Workbook 交错重算时应保持 WASM 共享内存隔离', async () => {
    const firstWorkbook = new Workbook({ enableWasm: false });
    const secondWorkbook = new Workbook({ enableWasm: false });

    try {
      await Promise.all([firstWorkbook.initWasm(), secondWorkbook.initWasm()]);

      firstWorkbook.setCell(0, 0, { v: '=1+1' });
      secondWorkbook.setCell(0, 0, { v: '=10+10' });

      secondWorkbook.recalcAll({ useWorker: false });
      firstWorkbook.recalcAll({ useWorker: false });

      expect(firstWorkbook.formulaEvaluator.getCellValue(0, 0)).toBe(2);
      expect(secondWorkbook.formulaEvaluator.getCellValue(0, 0)).toBe(20);
    } finally {
      firstWorkbook.destroy();
      secondWorkbook.destroy();
    }
  });

  it('编辑公式后全量重算不应复用旧 R1C1 公式', async () => {
    const workbook = new Workbook({ enableWasm: false });

    try {
      await workbook.initWasm();
      workbook.setCell(0, 0, { v: '=1+1' });
      workbook.recalcAll({ useWorker: false });
      expect(workbook.formulaEvaluator.getCellValue(0, 0)).toBe(2);

      workbook.setCell(0, 0, { v: '=10+10' });
      workbook.recalcAll({ useWorker: false });
      expect(workbook.formulaEvaluator.getCellValue(0, 0)).toBe(20);
    } finally {
      workbook.destroy();
    }
  });

  it('公式撤销重做后全量重算应使用当前公式', async () => {
    const workbook = new Workbook({ enableWasm: false });

    try {
      await workbook.initWasm();
      workbook.setCell(0, 0, { v: '=1+1' });
      workbook.recalcAll({ useWorker: false });
      workbook.history.clear();
      workbook.setCell(0, 0, { v: '=10+10' });
      workbook.recalcAll({ useWorker: false });

      workbook.undo();
      workbook.recalcAll({ useWorker: false });
      expect(workbook.formulaEvaluator.getCellValue(0, 0)).toBe(2);

      workbook.redo();
      workbook.recalcAll({ useWorker: false });
      expect(workbook.formulaEvaluator.getCellValue(0, 0)).toBe(20);
    } finally {
      workbook.destroy();
    }
  });

  it.each([
    ['=MAX()', 0],
    ['=MIN()', 0],
    ['=ABS()', '#VALUE!'],
    ['=INT()', '#VALUE!'],
    ['=ROUND()', '#VALUE!'],
    ['=ROUND(1.25,1.9)', 1.3],
    ['=YEAR()', '#VALUE!'],
    ['=MOD(5,2)', 1],
    ['=POWER(2,3)', 8],
    ['=1/0', '#DIV/0!'],
    ['="5"', '5'],
    ['=TRUE', true]
  ])('WASM 已加载时全量重算仍应遵循 JS 语义：%s', async (formula, expected) => {
    const workbook = new Workbook({ enableWasm: false });

    try {
      await workbook.initWasm();
      workbook.setCell(0, 0, { v: formula });
      workbook.recalcAll({ useWorker: false });

      expect(workbook.formulaEvaluator.getCellValue(0, 0)).toBe(expected);
    } finally {
      workbook.destroy();
    }
  });
});
