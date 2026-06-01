import { LayoutEngine } from '@/core/LayoutEngine';

describe('LayoutEngine 布局版本号', () => {
  const createEngine = (rowCount = 100, colCount = 26) => {
    const rowHeights = {};
    const colWidths = {};
    const engine = new LayoutEngine({
      getRowCount: () => rowCount,
      getColCount: () => colCount,
      getDefaultRowHeight: () => 20,
      getDefaultColWidth: () => 80,
      getRowHeights: () => rowHeights,
      getColWidths: () => colWidths,
      getRowHeight: (r) => rowHeights[r] ?? 20,
      getColWidth: (c) => colWidths[c] ?? 80,
      getFreeze: () => ({ r: 0, c: 0 })
    });
    return { engine, rowHeights, colWidths };
  };

  test('初始版本号为 0', () => {
    const { engine } = createEngine();
    expect(engine.getLayoutVersion()).toBe(0);
  });

  test('markDirty 单调递增版本号', () => {
    const { engine } = createEngine();
    engine.markDirty();
    expect(engine.getLayoutVersion()).toBe(1);
    engine.markDirty();
    expect(engine.getLayoutVersion()).toBe(2);
  });

  test('仅读取偏移量（_ensureOffsets）不改变版本号', () => {
    const { engine } = createEngine();
    engine.markDirty();
    const v = engine.getLayoutVersion();
    engine.getRowPos(10);
    engine.getColPos(5);
    engine.getRowIndexAt(200);
    expect(engine.getLayoutVersion()).toBe(v);
  });

  test('行高变更经 markDirty 后版本号变化（网格签名据此失效）', () => {
    const { engine, rowHeights } = createEngine();
    const before = engine.getLayoutVersion();
    rowHeights[3] = 50;
    engine.markDirty();
    expect(engine.getLayoutVersion()).not.toBe(before);
    // 偏移量随之重算
    expect(engine.getRowPos(4)).toBe(engine.getRowPos(3) + 50);
  });
});
