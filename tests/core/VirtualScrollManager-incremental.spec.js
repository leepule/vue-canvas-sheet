import { VirtualScrollManager } from '../../src/core/render/VirtualScrollManager';


describe('VirtualScrollManager 增量更新速度测试', () => {
  let manager;
  let workbook;
  
  // 模拟工作簿
  const createMockWorkbook = () => ({
    freeze: { r: 0, c: 0 },
    rowCount: 1000,
    colCount: 100,
    getFrozenSize: () => ({ w: 0, h: 0 }),
    getRowIndexAt: (y) => Math.floor(y / 20),
    getColIndexAt: (x) => Math.floor(x / 50),
    getRowHeight: () => 20,
    getColWidth: () => 50,
    getCell: () => null,
    evaluateFormula: () => {}
  });

  beforeEach(() => {
    workbook = createMockWorkbook();
    manager = new VirtualScrollManager(workbook);
    manager.scrollX = 0;
    manager.scrollY = 0;
  });
  
  test('初始调用应触发全量更新', () => {
    const range = manager.getVisibleRange(800, 600, 0, 0);
    expect(range.needsIncrementalRender).toBeUndefined();
    const stats = manager.getIncrementalUpdateStats();
    expect(stats.fullUpdates).toBe(1);
    expect(stats.incrementalUpdates).toBe(0);
  });
  
  test('小范围滚动应触发增量更新', () => {
    manager.getVisibleRange(800, 600, 0, 0);
    manager.scrollY = 40;
    const range = manager.getVisibleRange(800, 600, 0, 0);
    
    expect(range.needsIncrementalRender).toBe(true);
    expect(range.renderChanges).toBeDefined();
    
    const stats = manager.getIncrementalUpdateStats();
    expect(stats.incrementalUpdates).toBe(1);
  });
  
  test('大范围滚动应触发全量更新', () => {
    manager.getVisibleRange(800, 600, 0, 0);
    manager.scrollY = 1000;
    const range = manager.getVisibleRange(800, 600, 0, 0);
    
    expect(range.needsIncrementalRender).toBeUndefined();
    
    const stats = manager.getIncrementalUpdateStats();
    expect(stats.fullUpdates).toBe(2);
  });
  
  test('性能统计正确记录行变化', () => {
    manager.getVisibleRange(800, 600, 0, 0);
    manager.scrollY = 100; // 滚动 5 行
    manager.getVisibleRange(800, 600, 0, 0);
    
    const stats = manager.getIncrementalUpdateStats();
    expect(stats.totalAddedRows).toBeGreaterThan(0);
    // 只有在缓冲区之外的行被“滑出”视野时才会触发移除统计。
    // 在这个简单的模拟中，我们主要关注增加了行。
  });

  test('重置统计信息功能', () => {
    manager.getVisibleRange(800, 600, 0, 0);
    manager.scrollY = 40;
    manager.getVisibleRange(800, 600, 0, 0);
    
    manager.resetIncrementalUpdateStats();
    const stats = manager.getIncrementalUpdateStats();
    expect(stats.totalUpdates).toBe(0);
    expect(stats.incrementalUpdates).toBe(0);
  });
});
