import { describe, expect, it } from 'vitest';
import { isWasmFormulaSupported } from '@/core/data/WasmFormulaSupport.js';

describe('WASM 公式支持矩阵', () => {
  it.each([
    '=1+1',
    '=1+2*3',
    '=(1+2)*3',
    '=10-2-3',
    '=12/4'
  ])('纯数字二元算术允许进入 WASM：%s', (formula) => {
    expect(isWasmFormulaSupported(formula)).toBe(true);
  });

  it.each([
    '=A1+1',
    '=SUM(1,2)',
    '=MAX()',
    '=MOD(5,2)',
    '=ROUND(1.25,1.9)',
    '=YEAR()',
    '="1"+1',
    '=TRUE',
    '=1>0',
    '=-1',
    '=1/-2',
    '=1+',
    '=()'
  ])('未验证语义固定回退 JS：%s', (formula) => {
    expect(isWasmFormulaSupported(formula)).toBe(false);
  });
});
