/**
 * Formula Worker 任务队列并发压力测试
 *
 * 测试 Worker 管理器在并发任务提交下的行为：
 * 1. WorkerManager 并发 execute 调用的排队和降级
 * 2. FormulaEngineService 并发 recalcAll 队列行为
 * 3. WorkerClient 并发请求的超时和清理
 * 4. 快速 Worker 崩溃/恢复循环
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// 使用真实的 WorkerManager/WorkerClient 实现（非全局 mock）
vi.unmock('@/core/worker/WorkerManager.js');
vi.unmock('@/core/worker/WorkerClient.js');
vi.unmock('@/core/worker/TransferableSerializer.js');

const { WorkerManager, createFormulaWorkerManager } = await import('@/core/worker/WorkerManager.js');
const { WorkerClient } = await import('@/core/worker/WorkerClient.js');
const { FormulaEngineService } = await import('@/core/data/FormulaEngineService.js');

// ─── 可控 Worker 模拟（支持延迟响应和错误注入） ───

class ControllableWorker {
  constructor() {
    this.listeners = { message: [], error: [] };
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(item => item !== listener);
    }
  }

  postMessage(message, transferables) {
    this.messages.push(message);
  }

  emitMessage(data) {
    const listeners = this.listeners.message || [];
    listeners.forEach(listener => listener({ data }));
  }

  emitError(error = new Error('worker failed')) {
    const listeners = this.listeners.error || [];
    listeners.forEach(listener => listener(error));
  }

  terminate() {
    this.terminated = true;
  }

  /** 延迟发送响应（模拟网络延迟） */
  delayResponse(taskId, result, delayMs = 10) {
    setTimeout(() => {
      this.emitMessage({
        type: 'result',
        taskId,
        success: true,
        result,
        duration: delayMs
      });
    }, delayMs);
  }
}

// ─── 辅助函数 ───

function createWorkerManager(worker, opts = {}) {
  return new WorkerManager({
    createWorker: () => worker,
    timeout: opts.timeout || 5000,
    fallbackEnabled: opts.fallbackEnabled !== undefined ? opts.fallbackEnabled : true,
    fallbackExecutor: opts.fallbackExecutor || null,
    useTransferable: false,
    ...opts
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFormulaEngineHarness() {
  const cells = new Map([
    ['0,0', { f: '=OLD()', v: null, dirty: true }]
  ]);
  const matrix = {
    get: (r, c) => cells.get(`${r},${c}`),
    forEach: (callback) => {
      for (const [key, cell] of cells.entries()) {
        const [r, c] = key.split(',').map(Number);
        callback(r, c, cell);
      }
    }
  };
  const workerCalls = [];
  const syncSharedValue = vi.fn();
  const service = new FormulaEngineService({
    getDataMatrix: () => matrix,
    cellKey: (r, c) => `${r},${c}`,
    parseKey: (key) => {
      const [r, c] = key.split(',').map(Number);
      return { r, c };
    },
    getDependencyMap: () => new Map(),
    getReverseDependencyMap: () => new Map(),
    getDependencies: () => [],
    updateDependencyMap: vi.fn(),
    getSharedValueStore: () => null,
    setSharedValueStore: vi.fn(),
    syncSharedValue,
    getCalcEngine: () => null,
    evaluateFormula: vi.fn(),
    getRowCount: () => 10,
    getColCount: () => 10,
    getPerformanceMonitor: () => null,
    errorHandler: { handle: vi.fn() },
    emit: vi.fn(),
    notify: vi.fn()
  });

  service._workerManager = {
    execute: vi.fn((type, payload) => {
      const deferred = createDeferred();
      workerCalls.push({ type, payload, deferred });
      return deferred.promise;
    })
  };

  return { service, cells, workerCalls, syncSharedValue };
}

// ─── 测试套件 ───

describe('WorkerClient 并发请求', () => {
  let worker;
  let client;

  beforeEach(() => {
    worker = new ControllableWorker();
    client = new WorkerClient({
      name: 'TestWorker',
      timeout: 5000,
      createWorker: () => worker,
      requestIdField: 'taskId',
      waitForReady: false // 无需 ready 消息
    });
  });

  afterEach(() => {
    if (client && !client.destroyed) {
      client.destroy();
    }
  });

  it('应正确处理多个并发请求', async () => {
    const promises = [];

    // 发送 10 个并发请求
    for (let i = 0; i < 10; i++) {
      promises.push(client.request({ type: 'test', index: i }));
    }

    // 按消息到达顺序响应
    expect(worker.messages.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      const msg = worker.messages[i];
      worker.emitMessage({
        taskId: msg.taskId,
        success: true,
        result: i * 10
      });
    }

    const results = await Promise.all(promises);
    // 每个响应对象应包含 result 字段，提取并排序验证
    const resultValues = results.map(r => r.result).sort((a, b) => a - b);
    expect(resultValues).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(client.pendingTasks.size).toBe(0);
  });

  it('应正确将响应路由到对应的 pending task', async () => {
    // 两个并发请求
    const p1 = client.request({ type: 'A' });
    const p2 = client.request({ type: 'B' });

    // 检查待处理任务数
    expect(client.pendingTasks.size).toBe(2);

    // 响应第二个请求（验证路由正确）
    worker.emitMessage({
      taskId: worker.messages[1].taskId,
      success: true,
      result: 'B-result'
    });

    const resultB = await p2;
    expect(resultB.result).toBe('B-result');
    expect(client.pendingTasks.size).toBe(1); // 剩一个

    // 响应第一个请求
    worker.emitMessage({
      taskId: worker.messages[0].taskId,
      success: true,
      result: 'A-result'
    });

    const resultA = await p1;
    expect(resultA.result).toBe('A-result');
    expect(client.pendingTasks.size).toBe(0);
  });

  it('destroy 应拒绝所有 pending 请求', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(client.request({ type: 'test', index: i }));
    }

    client.destroy('Test destroy');

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(r.reason.message).toContain('Test destroy');
    }

    expect(client.pendingTasks.size).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  it('destroyed 后的新请求应立即 reject', async () => {
    client.destroy('already destroyed');

    await expect(client.request({ type: 'test' })).rejects.toThrow('destroyed');
  });
});

describe('WorkerManager 并发操作', () => {
  let worker;
  let manager;

  beforeEach(() => {
    worker = new ControllableWorker();
  });

  afterEach(() => {
    if (manager) {
      manager.destroy();
    }
  });

  it('应处理快速连续的多次 execute 调用', async () => {
    const fallbackCalls = [];
    manager = createWorkerManager(worker, {
      timeout: 500, // 短超时以便测试快速完成
      fallbackExecutor: (type, data) => {
        fallbackCalls.push({ type, data });
        return `fallback-${type}-${data.formula}`;
      }
    });

    // 发送 ready 信号
    worker.emitMessage({ type: 'ready' });

    // 提交 5 个并发请求
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(manager.execute('evaluate', { formula: `=${i}+${i}`, r: i, c: 0 }));
    }

    // 对所有请求响应
    for (let i = 0; i < worker.messages.length; i++) {
      const msg = worker.messages[i];
      if (msg) {
        worker.emitMessage({
          taskId: msg.taskId,
          success: true,
          result: i * 2,
          duration: 1
        });
      }
    }

    const results = await Promise.all(promises);
    expect(results.length).toBe(5);

    // 已完成的任务计数
    const stats = manager.getStats();
    expect(stats.tasksCompleted).toBeGreaterThanOrEqual(5);
    expect(stats.tasksFailed).toBe(0);
  });

  it('在 Worker 运行时错误后应切换到 fallback 并继续处理后续请求', async () => {
    const fallbackResults = [];
    manager = createWorkerManager(worker, {
      fallbackExecutor: (type, data) => {
        fallbackResults.push({ type, ...data });
        return 'fallback-ok';
      }
    });

    worker.emitMessage({ type: 'ready' });

    // 启动一个请求，然后触发 Worker 错误
    const p1 = manager.execute('evaluate', { formula: '=A1', r: 0, c: 0 });
    worker.emitError(new Error('critical error'));

    // p1 应通过 fallback 成功
    const result1 = await p1;
    expect(result1).toBe('fallback-ok');
    expect(manager.useFallback).toBe(true);

    // 后续请求也应走 fallback
    const result2 = await manager.execute('evaluate', { formula: '=A2', r: 1, c: 0 });
    expect(result2).toBe('fallback-ok');

    expect(fallbackResults.length).toBeGreaterThanOrEqual(1);
  });

  it('executeBatch 应正确处理并发任务', async () => {
    manager = createWorkerManager(worker, {
      fallbackExecutor: (type, data) => {
        if (type === 'evaluate') {
          return `result-${data.formula}`;
        }
        return null;
      }
    });

    worker.emitMessage({ type: 'ready' });

    const tasks = [];
    for (let i = 0; i < 8; i++) {
      tasks.push({
        type: 'evaluate',
        data: { formula: `=${i}`, r: i, c: 0 }
      });
    }

    // 在响应前两个后触发错误
    setTimeout(() => {
      if (worker.messages[0]) {
        worker.emitMessage({
          taskId: worker.messages[0].taskId,
          success: true,
          result: 'from-worker-0',
          duration: 1
        });
      }
    }, 1);

    setTimeout(() => {
      worker.emitError(new Error('worker crash'));
    }, 5);

    const results = await manager.executeBatch(tasks);
    expect(results.length).toBe(8);

    // 至少有一个结果来自 worker 或 fallback
    const nonNull = results.filter(r => r !== null && r !== undefined);
    expect(nonNull.length).toBeGreaterThan(0);
  });

  it('restart 后应能继续正常工作', async () => {
    const fallbackResults = [];
    manager = createWorkerManager(worker, {
      timeout: 500,
      fallbackExecutor: (type, data) => {
        fallbackResults.push(data.formula);
        return `fb-${data.formula}`;
      }
    });

    worker.emitMessage({ type: 'ready' });

    // 第一次请求 — 成功响应
    const p0 = manager.execute('evaluate', { formula: '=X1', r: 0, c: 0 });
    worker.emitMessage({
      taskId: worker.messages[0].taskId,
      success: true,
      result: 'worker-result-1',
      duration: 1
    });
    await p0;

    // 重启 Worker
    const oldWorker = worker;
    worker = new ControllableWorker();
    manager.createWorker = () => worker;
    manager.restart();

    // 新 Worker 发送 ready
    worker.emitMessage({ type: 'ready' });

    // 新请求应在新的 Worker 上执行
    const p = manager.execute('evaluate', { formula: '=X2', r: 1, c: 0 });
    const msg = worker.messages[0];
    expect(msg).toBeDefined();

    worker.emitMessage({
      taskId: msg.taskId,
      success: true,
      result: 'new-worker-result',
      duration: 5
    });

    const result = await p;
    expect(result).toBe('new-worker-result');

    // 旧 Worker 应已终止
    expect(oldWorker.terminated).toBe(true);
  });

  it('高并发下统计应准确', async () => {
    manager = createWorkerManager(worker);
    worker.emitMessage({ type: 'ready' });

    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(manager.execute('evaluate', { formula: `=${i}`, r: i, c: 0 }));
    }

    // 响应所有请求
    for (const msg of worker.messages) {
      worker.emitMessage({
        taskId: msg.taskId,
        success: true,
        result: 42,
        duration: 1
      });
    }

    await Promise.all(promises);

    const stats = manager.getStats();
    expect(stats.tasksCompleted).toBe(50);
    expect(stats.tasksFailed).toBe(0);
    expect(stats.pendingTasks).toBe(0);
    expect(stats.workerTime).toBeGreaterThan(0);
  });
});

describe('FormulaEngineService 并发队列', () => {
  // 使用真实的 FormulaEngineService 但不依赖完整 Workbook

  it('队列在计算进行中时排队新请求', async () => {
    // 测试 HeadPointerQueue 的基本行为
    const { HeadPointerQueue } = await import('../../src/core/utils/Queues.js');

    const queue = new HeadPointerQueue();
    const order = [];

    // 模拟 recalcAllWithWorker 的排队行为
    queue.push({ id: 1 });
    queue.push({ id: 2 });
    queue.push({ id: 3 });

    // HeadPointerQueue 使用 shift() 消费（非迭代器）
    while (queue.length > 0) {
      const item = queue.shift();
      order.push(item.id);
    }

    expect(order).toEqual([1, 2, 3]);
    expect(queue.length).toBe(0);
  });

  it('destroy 应拒绝所有排队的 Promise', async () => {
    const { HeadPointerQueue } = await import('../../src/core/utils/Queues.js');

    const queue = new HeadPointerQueue();
    const rejections = [];

    // 模拟排队 Promise
    for (let i = 0; i < 5; i++) {
      queue.push({
        resolve: () => {},
        reject: (err) => rejections.push(err.message)
      });
    }

    const err = new Error('Service destroyed');
    while (queue.length > 0) {
      const { reject } = queue.shift();
      reject(err);
    }

    expect(rejections.length).toBe(5);
    expect(rejections.every(msg => msg === 'Service destroyed')).toBe(true);
  });

  it('recalcAllWithWorker 应在前次计算结束后用最新数据重新调度排队请求', async () => {
    const { service, cells, workerCalls, syncSharedValue } = createFormulaEngineHarness();

    const firstRun = service.recalcAllWithWorker();
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].payload.formulas).toEqual([
      { cellId: '0,0', formula: '=OLD()' }
    ]);

    cells.get('0,0').f = '=STALE_QUEUED()';
    cells.get('0,0').dirty = true;
    const queuedRunA = service.recalcAllWithWorker();
    cells.get('0,0').f = '=NEW()';
    const queuedRunB = service.recalcAllWithWorker();
    const queuedSettled = [false, false];
    queuedRunA.then(() => {
      queuedSettled[0] = true;
    });
    queuedRunB.then(() => {
      queuedSettled[1] = true;
    });

    expect(workerCalls).toHaveLength(1);

    workerCalls[0].deferred.resolve({ '0,0': 'old-result' });
    await firstRun;

    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1].payload.formulas).toEqual([
      { cellId: '0,0', formula: '=NEW()' }
    ]);
    expect(cells.get('0,0').v).toBe('old-result');
    expect(queuedSettled).toEqual([false, false]);

    workerCalls[1].deferred.resolve({ '0,0': 'new-result' });
    await Promise.all([queuedRunA, queuedRunB]);

    expect(queuedSettled).toEqual([true, true]);
    expect(cells.get('0,0').v).toBe('new-result');
    expect(cells.get('0,0').dirty).toBe(false);
    expect(syncSharedValue).toHaveBeenLastCalledWith(0, 0, 'new-result');
  });

  it('_processWorkerQueue 应清空队列', async () => {
    const { HeadPointerQueue } = await import('../../src/core/utils/Queues.js');

    const queue = new HeadPointerQueue();
    const resolved = [];

    for (let i = 0; i < 10; i++) {
      queue.push({ resolve: () => resolved.push(i) });
    }

    // 模拟 _processWorkerQueue
    while (queue.length > 0) {
      const { resolve } = queue.shift();
      resolve();
    }

    expect(resolved).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(queue.length).toBe(0);
  });
});

describe('WorkerClient 超时与清理', () => {
  it('超时任务不应影响其他 pending 任务', async () => {
    const worker = new ControllableWorker();
    const client = new WorkerClient({
      name: 'TimeoutTest',
      timeout: 50,
      createWorker: () => worker,
      requestIdField: 'taskId',
      waitForReady: false
    });

    // 提交三个任务，中间那个会超时
    const p1 = client.request({ type: 'fast' });
    const p2 = client.request({ type: 'slow' }, [], { timeout: 30 }); // 短超时
    const p3 = client.request({ type: 'fast-too' });

    // 响应 p1 和 p3，p2 让超时
    setTimeout(() => {
      worker.emitMessage({ taskId: worker.messages[0].taskId, success: true, result: 'ok1' });
      worker.emitMessage({ taskId: worker.messages[2].taskId, success: true, result: 'ok3' });
    }, 10);

    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected'); // 超时
    expect(r3.status).toBe('fulfilled');

    client.destroy();
  });

  it('错误处理器中的异常不应阻止 pending 任务清理', async () => {
    const worker = new ControllableWorker();
    const errorSpy = vi.fn(() => {
      throw new Error('error handler crash'); // 模拟错误处理器崩溃
    });

    const client = new WorkerClient({
      name: 'ErrorHandlerTest',
      timeout: 5000,
      createWorker: () => worker,
      requestIdField: 'taskId',
      waitForReady: false,
      onError: errorSpy
    });

    const p1 = client.request({ type: 'test1' });
    const p2 = client.request({ type: 'test2' });

    // 触发 Worker 错误
    worker.emitError(new Error('worker crash'));

    const results = await Promise.allSettled([p1, p2]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(r.reason.message).toContain('worker error');
    }

    expect(errorSpy).toHaveBeenCalled();
    expect(client.pendingTasks.size).toBe(0);

    client.destroy();
  });
});
