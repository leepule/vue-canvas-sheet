/**
 * ObjectPool 单元测试
 * 测试对象池的获取、释放、统计等功能
 */

import { ObjectPool, CellPool, RangePool, PoolManager, getCellPool, getRangePool, resetDefaultPools } from '@/core/utils/ObjectPool';


describe('ObjectPool', () => {
  let pool;

  beforeEach(() => {
    pool = new ObjectPool(
      () => ({ value: 0, data: null }),
      (obj) => {
        obj.value = 0;
        obj.data = null;
      },
      100 // max size
    );
  });

  describe('acquire', () => {
    test('应该从池中获取对象', () => {
      // 预热池
      pool.warmup(5);
      
      const obj = pool.acquire();
      expect(obj).toBeDefined();
      expect(obj.value).toBe(0);
      expect(pool.size).toBe(4);
    });

    test('池为空时应该创建新对象', () => {
      const obj = pool.acquire();
      expect(obj).toBeDefined();
      expect(pool.size).toBe(0);
      expect(pool._missCount).toBe(1);
    });

    test('应该正确统计获取次数', () => {
      pool.warmup(3);
      pool.acquire();
      pool.acquire();
      pool.acquire();
      pool.acquire(); // 池空，需要创建
      
      expect(pool._acquireCount).toBe(4);
      expect(pool._missCount).toBe(1);
    });
  });

  describe('release', () => {
    test('应该将对象释放回池中', () => {
      const obj = pool.acquire();
      obj.value = 42;
      obj.data = 'test';
      
      pool.release(obj);
      
      expect(pool.size).toBe(1);
      // 对象应该被重置
      expect(obj.value).toBe(0);
      expect(obj.data).toBeNull();
    });

    test('池满时应该丢弃对象', () => {
      const smallPool = new ObjectPool(
        () => ({ v: 0 }),
        (o) => { o.v = 0; },
        2
      );
      
      const obj1 = smallPool.acquire();
      const obj2 = smallPool.acquire();
      const obj3 = smallPool.acquire();
      
      smallPool.release(obj1);
      smallPool.release(obj2);
      smallPool.release(obj3); // 应该被丢弃
      
      expect(smallPool.size).toBe(2);
      expect(smallPool._dropCount).toBe(1);
    });

    test('批量释放', () => {
      const objs = [pool.acquire(), pool.acquire(), pool.acquire()];
      pool.releaseBatch(objs);
      
      expect(pool.size).toBe(3);
    });
  });

  describe('warmup', () => {
    test('应该预创建指定数量的对象', () => {
      pool.warmup(10);
      expect(pool.size).toBe(10);
    });

    test('不应超过最大容量', () => {
      pool.warmup(200); // 超过 maxSize 100
      expect(pool.size).toBe(100);
    });
  });

  describe('getStats', () => {
    test('应该返回正确的统计信息', () => {
      pool.warmup(10);
      pool.acquire();
      pool.acquire();
      const obj = pool.acquire();
      pool.release(obj);
      
      const stats = pool.getStats();
      
      expect(stats.poolSize).toBe(8);
      expect(stats.maxSize).toBe(100);
      expect(stats.acquireCount).toBe(3);
      expect(stats.missCount).toBe(0);
      expect(stats.releaseCount).toBe(1);
      expect(stats.hitRate).toBe('100.00%');
    });

    test('命中率计算', () => {
      pool.warmup(2);
      pool.acquire(); // 命中
      pool.acquire(); // 命中
      pool.acquire(); // 未命中
      
      const stats = pool.getStats();
      expect(stats.hitRate).toBe('66.67%');
    });
  });

  describe('clear', () => {
    test('应该清空池', () => {
      pool.warmup(10);
      pool.clear();
      expect(pool.size).toBe(0);
    });
  });

  describe('resetStats', () => {
    test('应该重置统计信息', () => {
      pool.warmup(5);
      pool.acquire();
      pool.acquire();
      
      pool.resetStats();
      
      expect(pool._acquireCount).toBe(0);
      expect(pool._missCount).toBe(0);
      expect(pool._releaseCount).toBe(0);
      expect(pool._dropCount).toBe(0);
    });
  });
});

describe('CellPool', () => {
  let cellPool;

  beforeEach(() => {
    cellPool = new CellPool(50);
  });

  describe('acquireCell', () => {
    test('应该获取单元格对象', () => {
      const cell = cellPool.acquireCell(42);
      
      expect(cell.v).toBe(42);
      expect(cell.s).toBeNull();
      expect(cell.f).toBeNull();
      expect(cell.dirty).toBe(false);
    });

    test('无初始值时应该返回空单元格', () => {
      const cell = cellPool.acquireCell();
      
      expect(cell.v).toBeUndefined();
    });
  });

  describe('acquireCellWithStyle', () => {
    test('应该获取带样式的单元格', () => {
      const style = { bold: true, color: 'red' };
      const cell = cellPool.acquireCellWithStyle('test', style);
      
      expect(cell.v).toBe('test');
      expect(cell.s).toBeDefined();
      expect(cell.s.bold).toBe(true);
      expect(cell.s.color).toBe('red');
    });
  });

  describe('releaseCell', () => {
    test('应该释放单元格和样式对象', () => {
      const cell = cellPool.acquireCellWithStyle('test', { bold: true });
      
      cellPool.releaseCell(cell);
      
      const stats = cellPool.getFullStats();
      expect(stats.cellPool.poolSize).toBe(1);
      expect(stats.stylePool.poolSize).toBe(1);
    });
  });

  describe('样式对象池', () => {
    test('样式对象应该被复用', () => {
      // 获取带样式的单元格
      const cell1 = cellPool.acquireCellWithStyle('a', { color: 'red' });
      const style1 = cell1.s;
      
      // 释放
      cellPool.releaseCell(cell1);
      
      // 再次获取
      const cell2 = cellPool.acquireCellWithStyle('b', { color: 'blue' });
      
      // 应该是同一个样式对象被复用
      expect(cell2.s).toBe(style1);
    });

    test('border 样式应该正确重置', () => {
      const borderStyle = {
        border: {
          top: { style: 'thin' },
          bottom: { style: 'medium' }
        }
      };
      
      const cell = cellPool.acquireCellWithStyle('test', borderStyle);
      cellPool.releaseCell(cell);
      
      // 获取新的样式对象
      const cell2 = cellPool.acquireCellWithStyle('test2', {});
      
      // border 应该被清空
      expect(cell2.s.border.top).toBeUndefined();
      expect(cell2.s.border.bottom).toBeUndefined();
    });
  });

  describe('getFullStats', () => {
    test('应该返回包含样式池统计的完整信息', () => {
      const cell = cellPool.acquireCellWithStyle('test', { bold: true });
      cellPool.releaseCell(cell);
      
      const stats = cellPool.getFullStats();
      
      expect(stats.cellPool).toBeDefined();
      expect(stats.stylePool).toBeDefined();
    });
  });
});

describe('RangePool', () => {
  let rangePool;

  beforeEach(() => {
    rangePool = new RangePool(20);
  });

  test('应该获取范围对象', () => {
    const range = rangePool.acquireRange(0, 0, 10, 5);
    
    expect(range.s.r).toBe(0);
    expect(range.s.c).toBe(0);
    expect(range.e.r).toBe(10);
    expect(range.e.c).toBe(5);
  });

  test('范围对象应该被复用', () => {
    const range1 = rangePool.acquireRange(0, 0, 5, 5);
    rangePool.release(range1);
    
    const range2 = rangePool.acquireRange(10, 10, 20, 20);
    
    expect(range2).toBe(range1);
    expect(range2.s.r).toBe(10);
  });
});

describe('PoolManager', () => {
  let manager;

  beforeEach(() => {
    manager = new PoolManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  test('应该管理单元格池', () => {
    const cellPool = manager.getCellPool();
    expect(cellPool).toBeInstanceOf(CellPool);
  });

  test('应该管理范围池', () => {
    const rangePool = manager.getRangePool();
    expect(rangePool).toBeInstanceOf(RangePool);
  });

  test('getAllStats 应该返回所有池统计', () => {
    const cellPool = manager.getCellPool();
    cellPool.warmup(5);
    
    const stats = manager.getAllStats();
    
    expect(stats.cell).toBeDefined();
    expect(stats.range).toBeDefined();
  });

  test('clearAll 应该清空所有池', () => {
    const cellPool = manager.getCellPool();
    const rangePool = manager.getRangePool();
    
    cellPool.warmup(5);
    rangePool.warmup(3);
    
    manager.clearAll();
    
    expect(cellPool.size).toBe(0);
    expect(rangePool.size).toBe(0);
  });

  test('destroy 应该销毁管理器', () => {
    manager.getCellPool().warmup(5);
    manager.destroy();
    
    // 销毁后池应该被清空
    expect(manager._pools.size).toBe(0);
  });
});

describe('全局默认池', () => {
  beforeEach(() => {
    resetDefaultPools();
  });

  test('getCellPool 应该返回单例', () => {
    const pool1 = getCellPool();
    const pool2 = getCellPool();
    
    expect(pool1).toBe(pool2);
  });

  test('getRangePool 应该返回单例', () => {
    const pool1 = getRangePool();
    const pool2 = getRangePool();
    
    expect(pool1).toBe(pool2);
  });

  test('resetDefaultPools 应该清空所有默认池', () => {
    const pool = getCellPool();
    pool.warmup(10);
    
    resetDefaultPools();
    
    expect(pool.size).toBe(0);
  });
});