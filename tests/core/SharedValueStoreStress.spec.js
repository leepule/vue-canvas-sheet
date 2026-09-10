/**
 * SharedValueStore 并发读写压力测试
 *
 * 测试共享数值存储引擎在模拟并发访问下的数据一致性和健壮性。
 * 重点验证：
 * 1. 分块与连续缓冲区的数据一致性
 * 2. 缓冲区扩容期间的数据完整性
 * 3. 高频读写的正确性
 * 4. 边界条件和异常路径
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SharedValueStore } from '../../src/core/data/SharedValueStore.js';

const EMPTY = SharedValueStore.EMPTY_VALUE;

// ─── 辅助函数 ───

/** 创建预填充了数据的 Store */
function createPopulatedStore(rows, cols) {
  const store = new SharedValueStore(rows, cols);
  for (let r = 0; r < Math.min(rows, 100); r++) {
    for (let c = 0; c < Math.min(cols, 50); c++) {
      store.set(r, c, r * 1000 + c);
    }
  }
  return store;
}

/** 生成随机行列索引 */
function randInt(max) {
  return Math.floor(Math.random() * max);
}

// ─── 测试套件 ───

describe('SharedValueStore 并发读写压力测试', () => {
  describe('高频 set/get 操作', () => {
    it('应在 10000 次连续 set/get 后保持数据一致', () => {
      const store = new SharedValueStore(1000, 100);
      const written = new Map();

      for (let i = 0; i < 10000; i++) {
        const r = randInt(1000);
        const c = randInt(100);
        const val = Math.random() * 10000;
        store.set(r, c, val);
        written.set(`${r}-${c}`, val);
      }

      // 验证所有写入值
      let mismatches = 0;
      for (const [key, expected] of written) {
        const [r, c] = key.split('-').map(Number);
        const actual = store.get(r, c);
        if (actual !== expected) {
          mismatches++;
        }
      }

      expect(mismatches).toBe(0);
    });

    it('应在启用连续缓冲区后保持分块与连续视图一致', () => {
      const store = createPopulatedStore(500, 64);
      store.getBuffer(); // 分配连续缓冲区并同步分块

      // 验证预填充数据在两种视图中一致
      let inconsistencies = 0;
      for (let r = 0; r < 100; r++) {
        for (let c = 0; c < 50; c++) {
          const expected = r * 1000 + c;

          // 从连续缓冲区读取
          const contIdx = r * store._continuousCols + c;
          const contVal = contIdx < store.continuousView.length
            ? store.continuousView[contIdx]
            : null;

          // 从分块读取
          const chunkIdx = Math.floor(r / 1024);
          const chunk = store.chunks.get(chunkIdx);
          const chunkVal = chunk
            ? chunk[(r % 1024) * store.maxCols + c]
            : null;

          if (contVal !== chunkVal || contVal !== expected) {
            inconsistencies++;
          }
        }
      }

      expect(inconsistencies).toBe(0);
    });

    it('应在 set 后立即 get 返回正确值（读写一致性）', () => {
      const store = new SharedValueStore(10000, 256);
      store.getBuffer();

      const testData = [
        [0, 0, 42],
        [0, 255, 3.14],
        [9999, 0, -100],
        [5000, 128, 0],
        [1, 1, Number.MAX_SAFE_INTEGER],
        [2, 2, Number.MIN_VALUE]
      ];

      for (const [r, c, val] of testData) {
        store.set(r, c, val);
        expect(store.get(r, c)).toBe(val);
      }
    });
  });

  describe('缓冲区扩容一致性', () => {
    it('扩容后旧数据应完整保留', () => {
      const store = new SharedValueStore(100000, 4);
      store.set(0, 0, 10);
      store.set(0, 1, 20);
      store.set(100, 0, 30);
      store.getBuffer();

      const initialCols = store._continuousCols;
      const initialLen = store.continuousView.length;

      // 写入超出当前容量的行 — 触发扩容
      store.set(5000, 0, 999);

      // 扩容后旧数据必须保留
      expect(store.get(0, 0)).toBe(10);
      expect(store.get(0, 1)).toBe(20);
      expect(store.get(100, 0)).toBe(30);
      expect(store.get(5000, 0)).toBe(999);

      // 验证扩容确实发生了
      expect(store.continuousView.length).toBeGreaterThan(initialLen);
    });

    it('多次扩容后数据应完整', () => {
      const store = new SharedValueStore(100000, 8);
      store.getBuffer();

      // 写入一系列递增行的数据，每次写入可能触发扩容
      const checkpoints = [];
      for (const row of [10, 100, 500, 2000, 5000, 15000]) {
        store.set(row, 0, row * 10);
        checkpoints.push(row);
      }

      // 验证所有数据
      for (const row of checkpoints) {
        expect(store.get(row, 0)).toBe(row * 10);
      }

      // 验证未写入的位置仍是空值
      expect(store.get(7, 7)).toBe(EMPTY);
    });

    it('扩容触发 onGrow 回调且参数正确', () => {
      const store = new SharedValueStore(100000, 8);
      store.set(0, 0, 42);
      store.getBuffer();

      const growEvents = [];
      store.onGrow = (newRows, newBuffer, newCols) => {
        growEvents.push({
          newRows,
          newCols,
          bufferSize: newBuffer.byteLength,
          isSAB: newBuffer instanceof SharedArrayBuffer
        });
      };

      // 触发多次扩容
      store.set(3000, 0, 1);
      store.set(12000, 0, 2);
      store.set(50000, 0, 3);

      expect(growEvents.length).toBeGreaterThanOrEqual(1);

      // 验证回调参数
      for (const event of growEvents) {
        expect(event.newRows).toBeGreaterThan(0);
        expect(event.newCols).toBeGreaterThan(0);
        expect(event.bufferSize).toBeGreaterThan(0);
        expect(event.isSAB).toBe(true);
        // 缓冲区大小应与行列数匹配
        expect(event.bufferSize).toBe(event.newRows * event.newCols * 8);
      }
    });
  });

  describe('并发 set + getBuffer 竞态模拟', () => {
    it('set 和 getBuffer 交错调用不应破坏数据', () => {
      const store = new SharedValueStore(50000, 16);

      // 模拟：一边持续写入数据，一边间歇性调用 getBuffer
      for (let wave = 0; wave < 10; wave++) {
        // 写入一波数据
        for (let r = wave * 100; r < (wave + 1) * 100; r++) {
          for (let c = 0; c < 10; c++) {
            store.set(r, c, r * 100 + c);
          }
        }

        // 间歇性获取/刷新缓冲区（模拟 WASM 绑定）
        const buf = store.getBuffer();
        expect(buf).toBeInstanceOf(SharedArrayBuffer);

        // 验证之前写入的数据仍在
        for (let r = 0; r < (wave + 1) * 100; r++) {
          for (let c = 0; c < 10; c++) {
            expect(store.get(r, c)).toBe(r * 100 + c);
          }
        }
      }
    });

    it('快速连续 set → getBuffer → set 循环不应丢失数据', () => {
      const store = new SharedValueStore(10000, 32);

      for (let cycle = 0; cycle < 50; cycle++) {
        store.set(cycle, 0, cycle);
        store.set(cycle, 1, cycle * 2);
        store.getBuffer(); // 确保连续缓冲区存在
        store.set(cycle, 2, cycle * 3);
      }

      // 验证所有数据
      for (let cycle = 0; cycle < 50; cycle++) {
        expect(store.get(cycle, 0)).toBe(cycle);
        expect(store.get(cycle, 1)).toBe(cycle * 2);
        expect(store.get(cycle, 2)).toBe(cycle * 3);
      }
    });
  });

  describe('边界条件', () => {
    it('超出 maxRows/maxCols 的写入应被忽略且不崩溃', () => {
      const store = new SharedValueStore(10, 10);

      // 不应抛出异常
      expect(() => store.set(-1, 0, 1)).not.toThrow();
      expect(() => store.set(0, -1, 1)).not.toThrow();
      expect(() => store.set(10, 0, 1)).not.toThrow();
      expect(() => store.set(0, 10, 1)).not.toThrow();
      expect(() => store.set(99999, 99999, 1)).not.toThrow();

      // 越界读取应返回空值
      expect(store.get(-1, 0)).toBe(EMPTY);
      expect(store.get(0, -1)).toBe(EMPTY);
      expect(store.get(10, 0)).toBe(EMPTY);
    });

    it('特殊值的正确处理', () => {
      const store = new SharedValueStore(100, 100);

      // null/undefined/空字符串 → EMPTY
      store.set(0, 0, null);
      expect(store.get(0, 0)).toBe(EMPTY);

      store.set(0, 1, undefined);
      expect(store.get(0, 1)).toBe(EMPTY);

      store.set(0, 2, '');
      expect(store.get(0, 2)).toBe(EMPTY);

      // 公式字符串 → EMPTY（共享内存不存公式）
      store.set(0, 3, '=SUM(A1:A10)');
      expect(store.get(0, 3)).toBe(EMPTY);

      store.set(0, 4, '#REF!');
      expect(store.get(0, 4)).toBe(EMPTY);

      // Infinity → Infinity
      store.set(0, 5, Infinity);
      expect(store.get(0, 5)).toBe(Infinity);

      // 数字字符串 → 解析为数字
      store.set(0, 6, '3.14');
      expect(store.get(0, 6)).toBe(3.14);

      // 布尔值不应被写入（typeof !== 'number'）
      store.set(0, 7, true);
      expect(store.get(0, 7)).toBe(EMPTY);
    });

    it('clear() 后所有值应为空', () => {
      const store = createPopulatedStore(500, 64);
      store.getBuffer();

      // 验证有数据
      expect(store.get(0, 0)).toBe(0);
      expect(store.get(50, 30)).toBe(50030);

      store.clear();

      // 验证清空
      expect(store.get(0, 0)).toBe(EMPTY);
      expect(store.get(50, 30)).toBe(EMPTY);

      // 连续缓冲区也应被清空
      if (store.continuousView) {
        for (let i = 0; i < Math.min(store.continuousView.length, 1000); i++) {
          expect(store.continuousView[i]).toBe(EMPTY);
        }
      }
    });
  });

  describe('内存压力测试', () => {
    it('大批量数据写入不应导致内存泄漏或崩溃', () => {
      const store = new SharedValueStore(50000, 64);

      // 写入 5000 个单元格数据
      for (let r = 0; r < 100; r++) {
        for (let c = 0; c < 50; c++) {
          store.set(r, c, Math.random() * 1000);
        }
      }

      store.getBuffer();

      // 追加写入更多数据，可能触发扩容
      for (let r = 200; r < 300; r++) {
        for (let c = 0; c < 64; c++) {
          store.set(r, c, r * c);
          // 立即验证
          expect(store.get(r, c)).toBe(r * c);
        }
      }

      // 验证分块数量合理
      const maxRow = 299; // 写入的最高行
      const expectedChunks = Math.ceil((maxRow + 1) / 1024);
      expect(store.chunks.size).toBeLessThanOrEqual(expectedChunks);
    });

    it('跨多个分块的数据一致性', () => {
      // CHUNK_SIZE = 1024，测试跨分块边界的数据
      const store = new SharedValueStore(5000, 32);
      store.getBuffer();

      // 在第 0 分块边界写入
      store.set(0, 0, 1);
      store.set(1023, 0, 2); // 第 0 分块最后一行

      // 在第 1 分块写入
      store.set(1024, 0, 3); // 第 1 分块第一行
      store.set(2047, 0, 4); // 第 1 分块最后一行

      // 跨分块验证
      expect(store.get(0, 0)).toBe(1);
      expect(store.get(1023, 0)).toBe(2);
      expect(store.get(1024, 0)).toBe(3);
      expect(store.get(2047, 0)).toBe(4);

      // 验证分块数量
      expect(store.chunks.size).toBe(2); // chunk 0 和 chunk 1
    });
  });

  describe('serialize/updateFromSerialized 往返', () => {
    it('序列化后反序列化应保持数据一致', () => {
      const store = createPopulatedStore(500, 64);
      const serialized = store.serialize();

      expect(serialized).not.toBeNull();
      expect(serialized.chunks).toBeDefined();
      expect(serialized.maxRows).toBe(500);
      expect(serialized.maxCols).toBe(64);

      // 创建新 Store 并恢复
      const store2 = new SharedValueStore(500, 64);
      store2.updateFromSerialized(serialized);

      // 验证数据
      for (let r = 0; r < Math.min(100, 500); r++) {
        for (let c = 0; c < Math.min(50, 64); c++) {
          expect(store2.get(r, c)).toBe(r * 1000 + c);
        }
      }
    });

    it('updateFromSerialized 应处理旧格式（直接 SharedArrayBuffer）', () => {
      const store = new SharedValueStore(100, 10);
      store.set(0, 0, 42);
      const buf = store.getBuffer();

      // 旧格式：直接传递 SharedArrayBuffer
      const store2 = new SharedValueStore(100, 10);
      store2.updateFromSerialized(buf);

      // 连续缓冲区应被设置
      expect(store2.continuousBuffer).toBe(buf);
    });
  });

  describe('getValue 别名', () => {
    it('getValue 应与 get 行为一致', () => {
      const store = new SharedValueStore(100, 100);
      store.set(5, 5, 42);
      store.set(10, 10, EMPTY);

      expect(store.getValue(5, 5)).toBe(store.get(5, 5));
      expect(store.getValue(10, 10)).toBe(store.get(10, 10));
      expect(store.getValue(99, 99)).toBe(store.get(99, 99));
    });
  });
});
