/**
 * SharedArrayBuffer 并发压力测试
 *
 * 在 jsdom 环境中测试 SharedArrayBuffer 的数据完整性和并发安全性。
 * 验证在无 Atomics 同步原语的情况下：
 * 1. 写入的数据完整性（是否有撕裂写入）
 * 2. 并发读写的数据一致性
 * 3. 缓冲区扩容时的竞态条件（dangling reference）
 * 4. 高频读写下的正确性
 *
 * 注：真实多线程 Worker 并发测试请参见 SharedArrayBufferConcurrency.node.spec.js
 *     (需 Node 环境，跳过浏览器 setup mock)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── 测试常量 ───
const SAB_SIZE = 1024 * 64; // 64KB = 8192 Float64 values
const STRESS_ITERATIONS = 5000;

// ─── 测试辅助：模拟并发执行 ───

/**
 * 模拟多线程交错的并发操作。
 * 将多个任务拆分为微步骤，使用 Promise 交错执行。
 */
async function simulateConcurrent(tasks, interleaveCount = 10) {
  const results = new Array(tasks.length);
  const steps = [];

  // 将每个任务拆分为 interleaveCount 步
  for (let t = 0; t < tasks.length; t++) {
    for (let s = 0; s < interleaveCount; s++) {
      steps.push({ taskIdx: t, step: s, totalSteps: interleaveCount });
    }
  }

  // 随机打乱步骤顺序，模拟线程调度交错的不可预测性
  for (let i = steps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [steps[i], steps[j]] = [steps[j], steps[i]];
  }

  // 按打乱后的顺序执行步骤
  const taskState = tasks.map(() => ({}));
  for (const { taskIdx, step, totalSteps } of steps) {
    await tasks[taskIdx](taskState[taskIdx], step, totalSteps);
    // 每个步骤后 yield 控制权，模拟线程切换
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return taskState;
}

// ─── 测试套件 ───

describe('SharedArrayBuffer 数据完整性测试', () => {
  let sab;

  beforeEach(() => {
    sab = new SharedArrayBuffer(SAB_SIZE);
  });

  describe('基础 SAB 操作', () => {
    it('SharedArrayBuffer 应在此环境中可用', () => {
      expect(typeof SharedArrayBuffer).toBe('function');
      const testSab = new SharedArrayBuffer(64);
      expect(testSab).toBeInstanceOf(SharedArrayBuffer);
      expect(testSab.byteLength).toBe(64);
    });

    it('Float64Array 写入应是单元素原子的', () => {
      const view = new Float64Array(sab);

      // 写入各种边界值
      const testValues = [
        0, -0, 1, -1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        Infinity, -Infinity,
        Math.PI, Math.E
      ];

      for (let i = 0; i < testValues.length; i++) {
        view[i] = testValues[i];
      }

      // 逐个读取验证
      for (let i = 0; i < testValues.length; i++) {
        const val = view[i];
        if (Object.is(testValues[i], -0)) {
          expect(Object.is(val, -0)).toBe(true);
        } else {
          expect(val).toBe(testValues[i]);
        }
      }
    });

    it('空标记值 -Infinity 在 SAB 中应正确存储和读取', () => {
      const view = new Float64Array(sab);
      view.fill(-Infinity);

      for (let i = 0; i < 100; i++) {
        expect(view[i]).toBe(-Infinity);
      }

      view[10] = 42;
      view[50] = 3.14;

      expect(view[0]).toBe(-Infinity);
      expect(view[10]).toBe(42);
      expect(view[50]).toBe(3.14);
      expect(view[99]).toBe(-Infinity);
    });

    it('不同 TypedArray 视图应共享同一底层缓冲区', () => {
      const floatView = new Float64Array(sab);
      const byteView = new Uint8Array(sab);

      floatView[0] = 42.5;
      // 修改字节视图的第一个字节 → Float64 值应变化（平台字节序）
      const originalByte = byteView[0];
      byteView[0] = originalByte ^ 0xFF; // 翻转第一个字节
      // Float64 值应变为非原始值（证明共享缓冲区）
      expect(floatView[0]).not.toBe(42.5);
    });
  });

  describe('高频读写压力', () => {
    it('高频写入后读取应保持数据一致', () => {
      const view = new Float64Array(sab);
      const count = STRESS_ITERATIONS;
      const expected = new Map();

      for (let i = 0; i < count; i++) {
        const idx = i % 1000;
        const val = Math.random() * 100000;
        view[idx] = val;
        expected.set(idx, val);
      }

      // 验证最终状态
      for (const [idx, val] of expected) {
        expect(view[idx]).toBe(val);
      }
    });

    it('交错读写不应产生中间状态的撕裂值', () => {
      const view = new Float64Array(sab);
      let invalidCount = 0;

      // 模拟快速交替读写
      for (let i = 0; i < STRESS_ITERATIONS; i++) {
        const writeIdx = i % 512;
        const readIdx = (i + 256) % 512;

        // 写入一个有效数字
        view[writeIdx] = i;

        // 读取任意位置
        const val = view[readIdx];
        // 不应该读到 NaN（撕裂写入的产物）
        if (Number.isNaN(val)) {
          invalidCount++;
        }
      }

      // 不应有 NaN 撕裂值
      expect(invalidCount).toBe(0);
    });
  });

  describe('并发访问模拟', () => {
    it('模拟多线程交错写入不重叠区域应无数据丢失', async () => {
      const view = new Float64Array(sab);
      const NUM_WRITERS = 4;
      const regionSize = 2000; // 每个写入者 2000 个位置

      const tasks = [];
      for (let t = 0; t < NUM_WRITERS; t++) {
        const startOffset = t * regionSize;
        tasks.push(async (state, step, totalSteps) => {
          const chunkSize = Math.floor(regionSize / totalSteps);
          const chunkStart = startOffset + step * chunkSize;
          const chunkEnd = Math.min(chunkStart + chunkSize, startOffset + regionSize);
          for (let i = chunkStart; i < chunkEnd; i++) {
            view[i] = t * 1000000 + i;
          }
        });
      }

      await simulateConcurrent(tasks, 20);

      // 验证所有写入
      let errors = 0;
      for (let t = 0; t < NUM_WRITERS; t++) {
        const startOffset = t * regionSize;
        for (let i = startOffset; i < startOffset + regionSize; i++) {
          if (view[i] !== t * 1000000 + i) {
            errors++;
          }
        }
      }
      expect(errors).toBe(0);
    });

    it('模拟重叠区域并发写入后不应有撕裂值', async () => {
      const view = new Float64Array(sab);
      const overlapSize = 100;
      const NUM_WRITERS = 4;

      const tasks = [];
      for (let t = 0; t < NUM_WRITERS; t++) {
        tasks.push(async (state, step, totalSteps) => {
          for (let i = 0; i < overlapSize; i++) {
            view[i] = t * 1000 + i;
            // 每次写入后 yield，允许其他"线程"运行
            if (i % 10 === 0) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        });
      }

      await Promise.all(tasks);

      // 检查重叠区域无撕裂写入
      let tornCount = 0;
      for (let i = 0; i < overlapSize; i++) {
        const val = view[i];
        if (!Number.isFinite(val) && val !== -Infinity && val !== Infinity && val !== 0) {
          tornCount++;
        }
      }
      expect(tornCount).toBe(0);
    });
  });

  describe('缓冲区扩容安全', () => {
    it('旧 SAB 引用在新 SAB 分配后仍应有效', () => {
      const view1 = new Float64Array(sab);
      view1[0] = 42;
      view1[1] = 99;

      // 分配新 SAB（模拟扩容）
      const newSab = new SharedArrayBuffer(SAB_SIZE * 2);
      const view2 = new Float64Array(newSab);
      view2[0] = 100;
      view2[1] = 200;

      // 旧引用仍有效
      expect(view1[0]).toBe(42);
      expect(view1[1]).toBe(99);

      // 新引用独立
      expect(view2[0]).toBe(100);
      expect(view2[1]).toBe(200);

      // 旧引用不受新引用影响
      view2[0] = 999;
      expect(view1[0]).toBe(42); // 不变
    });

    it('扩容期间持续写入旧缓冲区不应崩溃', async () => {
      const view = new Float64Array(sab);
      for (let i = 0; i < 1000; i++) {
        view[i] = i;
      }

      // 模拟扩容：在读写交替中分配新 SAB 并复制数据
      let growCount = 0;
      const startTime = Date.now();

      while (Date.now() - startTime < 500) {
        // 持续读写旧缓冲区
        const idx = Math.floor(Math.random() * 1000);
        const oldVal = view[idx];
        view[idx] = Math.random() * 1000;

        // 间歇性"扩容"
        if (growCount < 10 && Math.random() < 0.1) {
          const newSab = new SharedArrayBuffer(SAB_SIZE * 2);
          const newView = new Float64Array(newSab);
          // 复制数据
          const copyLen = Math.min(view.length, newView.length);
          for (let i = 0; i < copyLen; i++) {
            newView[i] = view[i];
          }
          growCount++;
        }

        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // 旧缓冲区仍应可访问
      expect(() => view[0]).not.toThrow();
      expect(growCount).toBeGreaterThan(0);
    });
  });
});

describe('SharedArrayBuffer 与 SharedValueStore 标记值兼容性', () => {
  it('-Infinity 作为空标记与 SharedValueStore.EMPTY_VALUE 一致', () => {
    const { SharedValueStore } = require('../../src/core/data/SharedValueStore.js');
    expect(SharedValueStore.EMPTY_VALUE).toBe(-Infinity);
  });

  it('NaN 作为非数值标记与 SharedValueStore.NON_NUMERIC_VALUE 一致', () => {
    const { SharedValueStore } = require('../../src/core/data/SharedValueStore.js');
    expect(isNaN(SharedValueStore.NON_NUMERIC_VALUE)).toBe(true);
  });

  it('-Infinity 与 NaN 在 SAB 中应可靠区分', () => {
    const view = new Float64Array(new SharedArrayBuffer(32));
    view[0] = -Infinity;
    view[1] = NaN;
    view[2] = 0;
    view[3] = 42;

    // 使用 SharedValueStore 的静态方法验证
    const { SharedValueStore } = require('../../src/core/data/SharedValueStore.js');
    expect(SharedValueStore.prototype.isEmpty(view[0])).toBe(true);
    expect(SharedValueStore.prototype.isEmpty(view[1])).toBe(false);
    expect(SharedValueStore.prototype.isEmpty(view[2])).toBe(false);
    expect(SharedValueStore.prototype.isEmpty(view[3])).toBe(false);

    expect(SharedValueStore.prototype.isNonNumeric(view[0])).toBe(false);
    expect(SharedValueStore.prototype.isNonNumeric(view[1])).toBe(true);
    expect(SharedValueStore.prototype.isNonNumeric(view[2])).toBe(false);
    expect(SharedValueStore.prototype.isNonNumeric(view[3])).toBe(false);
  });
});
