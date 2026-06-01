import { VirtualScrollManager } from '@/core/render/VirtualScrollManager';


describe('VirtualScrollManager 增强版验证', () => {
  let workbook;
  let manager;

  beforeEach(() => {
    // 模拟 Workbook 对象
    workbook = {
      rowCount: 1000,
      colCount: 100,
      getRowHeight: () => 20,
      getColWidth: () => 80,
      getRowPos: (r) => r * 20,
      getColPos: (c) => c * 80,
      getRowIndexAt: (y) => Math.floor(y / 20),
      getColIndexAt: (x) => Math.floor(x / 80),
      getFrozenSize: () => ({ w: 0, h: 0 }),
      freeze: { r: 0, c: 0 }
    };
    manager = new VirtualScrollManager(workbook);
    // 模拟滚动位置
    manager.scrollX = 0;
    manager.scrollY = 0;
  });

  test('初始渲染范围计算正确', () => {
    const range = manager.getVisibleRange(800, 600, 40, 30);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
    expect(range.endRow).toBeGreaterThan(0);
    expect(range.endCol).toBeGreaterThan(0);
  });

  test('入口短路：入参未变时返回同一缓存对象', () => {
    const range1 = manager.getVisibleRange(800, 600, 40, 30);
    const range2 = manager.getVisibleRange(800, 600, 40, 30);
    // 同帧多次调用应复用同一引用，且只完整重算一次
    expect(range2).toBe(range1);
    expect(manager.getIncrementalUpdateStats().fullUpdates).toBe(1);
  });

  test('滚动变化触发重算并更新可见范围', () => {
    const range1 = manager.getVisibleRange(800, 600, 40, 30);

    // 模拟向下滚动
    manager.scrollY = 100;
    const range2 = manager.getVisibleRange(800, 600, 40, 30);

    // 短路不命中 → 重新计算出新的范围引用，起始行随滚动下移
    expect(range2).not.toBe(range1);
    expect(range2.startRow).toBeGreaterThanOrEqual(range1.startRow);
    expect(range2.exactStartRow).toBe(5); // floor(100 / 20)
    expect(manager.getIncrementalUpdateStats().fullUpdates).toBe(2);
  });

  test('脏标记系统正常工作', () => {
    // 标记行为脏后，可通过脏区查询接口取回
    manager.markDirtyRow(5);
    const regions = manager.getDirtyRegions({ startRow: 0, endRow: 10, startCol: 0, endCol: 10 });
    expect(regions.rows.some(r => r.index === 5)).toBe(true);

    // 完整重算（autoCleanAfterRender）后，落在可见范围内的脏行被清理
    manager.getVisibleRange(800, 600, 40, 30);
    expect(manager.dirtyState.rows.has(5)).toBe(false);
  });

  test('大步长滚动不应出现预测跳跃导致的空隙', () => {
    // 模拟从 0 快速跳转到 5000 像素
    manager.scrollY = 5000;
    // 模拟一个很高的速度速度
    manager.scrollState.velocityY = 1000;
    
    const range = manager.getVisibleRange(800, 600, 40, 30);
    
    // 精确起始行应该是 getRowIndexAt(5000) = floor(5000/20) = 250
    expect(range.exactStartRow).toBe(250);
    // startRow (带 buffer) 应该小于等于 exactStartRow
    expect(range.startRow).toBeLessThanOrEqual(range.exactStartRow);
    // 关键：startRow 不应该因为预测而大于 exactStartRow
    expect(range.startRow).toBeLessThanOrEqual(250); 
  });
});
