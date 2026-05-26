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

  test('差量更新逻辑识别滚动变化', () => {
    // 第一次计算获取缓存
    const range1 = manager.getVisibleRange(800, 600, 40, 30);
    
    // 模拟小幅向下滚动
    manager.scrollY = 100;
    const range2 = manager.getVisibleRange(800, 600, 40, 30);
    
    expect(range2.needsIncrementalRender).toBe(true);
    expect(range2.renderChanges).toBeDefined();
    expect(range2.renderChanges.addedRows.length).toBeGreaterThan(0);
  });

  test('脏标记系统正常工作', () => {
    manager.getVisibleRange(800, 600, 40, 30);
    
    // 标记行为脏
    manager.markDirtyRow(5);
    
    // 发生小幅滚动触发差量计算
    manager.scrollY = 20;
    const range = manager.getVisibleRange(800, 600, 40, 30);
    
    expect(range.renderChanges.dirtyRows.some(r => r.rowIndex === 5)).toBe(true);
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
