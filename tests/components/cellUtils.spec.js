import { describe, it, expect, vi } from 'vitest';
import { calcMergeSize } from '../../src/components/designer/utils/cellUtils.js';

function mockWorkbook(colWidths, rowHeights) {
  return {
    getColWidth: vi.fn((c) => colWidths[c] || 100),
    getRowHeight: vi.fn((r) => rowHeights[r] || 25)
  };
}

describe('calcMergeSize', () => {
  it('单单元格合并应返回其自身宽高', () => {
    const wb = mockWorkbook([100], [25]);
    const merge = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    expect(calcMergeSize(wb, merge, 0, 0)).toEqual({ mw: 100, mh: 25 });
  });

  it('多列合并应累加各列宽度', () => {
    const wb = mockWorkbook([100, 150, 200], [25]);
    const merge = { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } };
    expect(calcMergeSize(wb, merge, 0, 0)).toEqual({ mw: 450, mh: 25 });
  });

  it('多行合并应累加各行高度', () => {
    const wb = mockWorkbook([100], [25, 30, 35]);
    const merge = { s: { r: 0, c: 0 }, e: { r: 2, c: 0 } };
    expect(calcMergeSize(wb, merge, 0, 0)).toEqual({ mw: 100, mh: 90 });
  });

  it('行列同时合并应正确累加', () => {
    const wb = mockWorkbook([100, 120], [25, 25, 30]);
    const merge = { s: { r: 1, c: 0 }, e: { r: 3, c: 1 } };
    // r: 1,2,3 = 3 rows (25+25+30=80), c: 0,1 = 2 cols (100+120=220)
    expect(calcMergeSize(wb, merge, 1, 0)).toEqual({ mw: 220, mh: 80 });
  });
});
