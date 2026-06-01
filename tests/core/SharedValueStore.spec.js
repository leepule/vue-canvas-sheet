import { describe, it, expect } from 'vitest';
import { SharedValueStore } from '../../src/core/data/SharedValueStore.js';

const EMPTY = SharedValueStore.EMPTY_VALUE;

describe('SharedValueStore TypedArray 批量拷贝', () => {
  describe('_syncToContinuous', () => {
    it('快路径：列数相同时整块同步分块到连续缓冲区', () => {
      // maxCols=4，getBuffer 按 (_actualMaxCol+1)*2 分配列，写满 4 列使 cols===maxCols
      const store = new SharedValueStore(10000, 4);
      // 写两行，覆盖 0..3 列，使 _actualMaxCol=3 → cols = min(max(8,1),4) = 4
      store.set(0, 0, 10); store.set(0, 1, 11); store.set(0, 2, 12); store.set(0, 3, 13);
      store.set(1, 0, 20); store.set(1, 3, 23);

      store.getBuffer(); // 触发连续缓冲区分配 + _syncToContinuous

      expect(store._continuousCols).toBe(4); // 确认走快路径条件
      expect(store.get(0, 0)).toBe(10);
      expect(store.get(0, 3)).toBe(13);
      expect(store.get(1, 0)).toBe(20);
      expect(store.get(1, 3)).toBe(23);
      expect(store.get(1, 1)).toBe(EMPTY);
    });

    it('兜底：连续缓冲区列数小于分块列数时只同步重叠列', () => {
      const store = new SharedValueStore(10000, 8);
      // 只写第 0 列 → _actualMaxCol=0 → cols = min(max(2,1),8) = 2 < maxCols(8)
      store.set(0, 0, 100);
      store.set(1, 0, 200);
      store.set(5, 0, 500);

      store.getBuffer();

      expect(store._continuousCols).toBe(2);
      expect(store.maxCols).toBe(8);
      expect(store.get(0, 0)).toBe(100);
      expect(store.get(1, 0)).toBe(200);
      expect(store.get(5, 0)).toBe(500);
    });

    it('getBuffer 后新建分块仍能正确同步到连续缓冲区', () => {
      const store = new SharedValueStore(10000, 4);
      store.set(0, 0, 1); store.set(0, 1, 2); store.set(0, 2, 3); store.set(0, 3, 4);
      store.getBuffer();

      // 写入跨越新分块（行 > CHUNK_SIZE=1024）触发新分块分配 + _syncToContinuous
      // 但连续缓冲区可能已被扩容；这里写一个仍在范围内的高行
      store.set(2000, 0, 999);
      expect(store.get(2000, 0)).toBe(999);
    });
  });

  describe('_growContinuousBuffer', () => {
    it('快路径：列数不变仅行增长时整块迁移旧数据', () => {
      const store = new SharedValueStore(100000, 4);
      store.set(0, 0, 1); store.set(0, 3, 4);
      store.getBuffer();
      const colsBefore = store._continuousCols;

      // 写一个超出当前行容量但列数不变的单元格 → 触发行扩容，列数维持
      store.set(5000, 0, 50000);

      expect(store._continuousCols).toBe(colsBefore); // 列数未变 → 走快路径
      // 旧数据完整保留
      expect(store.get(0, 0)).toBe(1);
      expect(store.get(0, 3)).toBe(4);
      expect(store.get(5000, 0)).toBe(50000);
    });

    it('兜底：列数增长时逐行迁移并保留旧数据', () => {
      const store = new SharedValueStore(100000, 16);
      // 初始只用第 0 列 → cols=2
      store.set(0, 0, 7);
      store.set(1, 0, 8);
      store.getBuffer();
      expect(store._continuousCols).toBe(2);

      // 写入高行+高列：线性索引溢出缓冲区末尾且需要更多列 → 触发列扩容兜底分支
      store.set(2000, 10, 700);

      expect(store._continuousCols).toBeGreaterThan(2);
      expect(store.get(0, 0)).toBe(7);   // 旧数据迁移正确
      expect(store.get(1, 0)).toBe(8);
      expect(store.get(2000, 10)).toBe(700);
    });

    it('扩容触发 onGrow 回调', () => {
      const store = new SharedValueStore(100000, 4);
      store.set(0, 0, 1);
      store.getBuffer();

      let grown = null;
      store.onGrow = (rows, buffer, cols) => { grown = { rows, cols }; };
      store.set(9000, 0, 1);

      expect(grown).not.toBeNull();
      expect(grown.rows).toBeGreaterThan(0);
    });
  });
});
