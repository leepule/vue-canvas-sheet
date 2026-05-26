import { WorkerClient, getDefaultWorkerPoolSize } from '@/core/worker/WorkerClient';


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

  terminate() {
    this.terminated = true;
  }
}

describe('WorkerClient', () => {
  test('应该为请求写入 taskId 并按相同 id resolve', async () => {
    const worker = new ControllableWorker();
    const client = new WorkerClient({
      name: 'TestWorker',
      createWorker: () => worker,
      timeout: 100
    });

    const promise = client.request({ type: 'doWork' });
    const taskId = worker.messages[0].taskId;

    expect(taskId).toMatch(/^TestWorker_/);
    worker.emitMessage({ taskId, success: true, result: ['ok'] });

    await expect(promise).resolves.toEqual({ taskId, success: true, result: ['ok'] });
    expect(client.pendingTasks.size).toBe(0);

    client.destroy();
  });

  test('长任务超时后应该 reject 并清理 pending task', async () => {
    const worker = new ControllableWorker();
    const client = new WorkerClient({
      name: 'SlowWorker',
      createWorker: () => worker,
      timeout: 5
    });

    const promise = client.request({ type: 'slow' });

    await expect(promise).rejects.toThrow(/timeout/);
    expect(client.pendingTasks.size).toBe(0);

    const taskId = worker.messages[0].taskId;
    worker.emitMessage({ taskId, success: true, result: ['late'] });
    expect(client.pendingTasks.size).toBe(0);

    client.destroy();
  });

  test('destroy 应该 reject pending task 并终止 worker', async () => {
    const worker = new ControllableWorker();
    const client = new WorkerClient({
      name: 'DestroyWorker',
      createWorker: () => worker,
      timeout: 100
    });

    const promise = client.request({ type: 'pending' });
    client.destroy('done');

    await expect(promise).rejects.toThrow('done');
    expect(worker.terminated).toBe(true);
    expect(client.pendingTasks.size).toBe(0);
  });

  test('默认 worker pool size 应该给主线程预留余量', () => {
    expect(getDefaultWorkerPoolSize()).toBeGreaterThanOrEqual(1);
    expect(getDefaultWorkerPoolSize()).toBeLessThanOrEqual(4);
  });
});
