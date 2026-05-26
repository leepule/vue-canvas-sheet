import { vi } from 'vitest';

vi.unmock('@/core/worker/WorkerManager.js');
vi.unmock('@/core/worker/TransferableSerializer.js');

const { WorkerManager } = await import('@/core/worker/WorkerManager.js');

class ControllableWorker {
  constructor() {
    this.listeners = { message: [], error: [] };
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = this.listeners[type].filter(item => item !== listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  emitMessage(data) {
    this.listeners.message.forEach(listener => listener({ data }));
  }

  emitError(error = new Error('worker failed')) {
    this.listeners.error.forEach(listener => listener(error));
  }

  terminate() {
    this.terminated = true;
  }
}

describe('WorkerManager', () => {
  test('应该等待 ready 消息，并为任务写入 taskId', async () => {
    const worker = new ControllableWorker();
    const manager = new WorkerManager({
      createWorker: () => worker,
      timeout: 100,
      useTransferable: false
    });

    const readyPromise = manager.ready();
    worker.emitMessage({ type: 'ready' });
    await expect(readyPromise).resolves.toBeUndefined();

    const promise = manager.execute('evaluate', { formula: '=1+1', r: 0, c: 0 });
    expect(worker.messages[0].taskId).toMatch(/^FormulaWorker_/);

    worker.emitMessage({
      type: 'result',
      taskId: worker.messages[0].taskId,
      success: true,
      result: 2,
      duration: 3
    });

    await expect(promise).resolves.toBe(2);
    expect(manager.getStats()).toMatchObject({
      pendingTasks: 0,
      tasksCompleted: 1,
      workerTime: 3
    });

    manager.destroy();
  });

  test('超时任务应该 reject 且不触发 fallback', async () => {
    const worker = new ControllableWorker();
    const fallbackExecutor = vi.fn(() => 'fallback');
    const manager = new WorkerManager({
      createWorker: () => worker,
      timeout: 5,
      fallbackExecutor,
      useTransferable: false
    });

    worker.emitMessage({ type: 'ready' });
    const promise = manager.execute('evaluate', { formula: '=slow' });

    await expect(promise).rejects.toThrow(/timeout/);
    expect(fallbackExecutor).not.toHaveBeenCalled();
    expect(manager.pendingTasks.size).toBe(0);

    manager.destroy();
  });

  test('Worker 业务错误应该 reject 当前任务，不切换全局 fallback', async () => {
    const worker = new ControllableWorker();
    const fallbackExecutor = vi.fn(() => 'fallback');
    const manager = new WorkerManager({
      createWorker: () => worker,
      timeout: 100,
      fallbackExecutor,
      useTransferable: false
    });

    worker.emitMessage({ type: 'ready' });
    const promise = manager.execute('evaluate', { formula: '=BAD' });
    worker.emitMessage({
      type: 'result',
      taskId: worker.messages[0].taskId,
      success: false,
      error: 'bad formula'
    });

    await expect(promise).rejects.toThrow('bad formula');
    expect(fallbackExecutor).not.toHaveBeenCalled();
    expect(manager.useFallback).toBe(false);

    manager.destroy();
  });

  test('Worker runtime error 应该清理 pending 并用 fallback 接住当前任务', async () => {
    const worker = new ControllableWorker();
    const fallbackExecutor = vi.fn(() => 'fallback-result');
    const manager = new WorkerManager({
      createWorker: () => worker,
      timeout: 100,
      fallbackExecutor,
      useTransferable: false
    });

    worker.emitMessage({ type: 'ready' });
    const running = manager.execute('evaluate', { formula: '=1' });
    worker.emitError(new Error('runtime'));

    await expect(running).resolves.toBe('fallback-result');
    expect(worker.terminated).toBe(true);
    expect(manager.pendingTasks.size).toBe(0);
    expect(manager.useFallback).toBe(true);

    await expect(manager.execute('evaluate', { formula: '=2' })).resolves.toBe('fallback-result');
    expect(fallbackExecutor).toHaveBeenCalledWith('evaluate', { formula: '=2' });

    manager.destroy();
  });
});
