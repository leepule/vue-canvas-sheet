import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeHelper } from '../../src/components/designer/ThemeHelper.js';

function mockWorkbook(mergeMap = {}) {
  const styles = [];
  const wb = {
    history: { startBatch: vi.fn(), endBatch: vi.fn() },
    mergeManager: { getMerge: vi.fn((r, c) => mergeMap[`${r},${c}`] || null) },
    styleManager: { setStyle: vi.fn((range, style) => styles.push({ range, style })) },
    _styles: styles
  };
  return wb;
}

const sampleTheme = {
  header: { bg: '#000', color: '#fff', fw: 'bold' },
  bodyEven: { bg: '#f0f0f0' },
  bodyOdd: { bg: '#ffffff' }
};

describe('ThemeHelper', () => {
  let wb;
  beforeEach(() => { wb = mockWorkbook(); });

  it('applyTheme 空白工作簿应直接返回', () => {
    ThemeHelper.applyTheme(null, null, sampleTheme);
    ThemeHelper.applyTheme(wb, null, sampleTheme);
    ThemeHelper.applyTheme(wb, { s: { r: 0, c: 0 }, e: { r: 5, c: 5 } }, null);
    expect(wb.styleManager.setStyle).not.toHaveBeenCalled();
  });

  it('applyTheme 应设置表头样式', () => {
    ThemeHelper.applyTheme(wb, { s: { r: 0, c: 0 }, e: { r: 5, c: 3 } }, sampleTheme);
    expect(wb.history.startBatch).toHaveBeenCalled();
    expect(wb.history.endBatch).toHaveBeenCalled();
    const headerCall = wb._styles.find(s =>
      s.range.s.r === 0 && s.range.e.r === 0
    );
    expect(headerCall).toBeDefined();
    expect(headerCall.style).toEqual(sampleTheme.header);
  });

  it('applyTheme 应为表头后各行交替应用奇偶样式', () => {
    ThemeHelper.applyTheme(wb, { s: { r: 0, c: 0 }, e: { r: 4, c: 2 } }, sampleTheme);
    // 第1行(body row 0) 偶数 → bodyEven
    const bodyEven = wb._styles.find(s => s.range.s.r === 1);
    const bodyOdd = wb._styles.find(s => s.range.s.r === 2);
    expect(bodyEven).toBeDefined();
    expect(bodyOdd).toBeDefined();
    expect(bodyEven.style).toEqual(sampleTheme.bodyEven);
    expect(bodyOdd.style).toEqual(sampleTheme.bodyOdd);
  });

  it('applyTheme 当存在合并单元格时应扩展表头行范围', () => {
    const mergeWb = mockWorkbook({ '0,1': { s: { r: 0, c: 1 }, e: { r: 2, c: 1 } } });
    ThemeHelper.applyTheme(mergeWb, { s: { r: 0, c: 0 }, e: { r: 5, c: 3 } }, sampleTheme);
    const headerCall = mergeWb._styles.find(s =>
      s.range.s.r === 0 && s.range.e.r === 2
    );
    expect(headerCall).toBeDefined();
  });
});
