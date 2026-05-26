import { SearchWorkerPool } from '@/core/worker/SearchWorkerPool';



describe('SearchWorkerPool', () => {
  let originalWorker;

  beforeEach(() => {
    originalWorker = global.Worker;
  });

  afterEach(() => {
    global.Worker = originalWorker;
  });

  test('应该发送 taskId 并只接受同 id 的结果', async () => {
    class SearchWorker {
      constructor() {
        this.listeners = { message: [], error: [] };
        this.messages = [];
      }

      addEventListener(type, listener) {
        this.listeners[type].push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners[type] = this.listeners[type].filter(item => item !== listener);
      }

      postMessage(message) {
        this.messages.push(message);
        setTimeout(() => {
          this.listeners.message.forEach(listener => listener({
            data: {
              taskId: message.taskId,
              success: true,
              result: [{ r: 1, c: 2 }]
            }
          }));
        }, 0);
      }

      terminate() {}
    }

    global.Worker = SearchWorker;

    const pool = new SearchWorkerPool(1, { timeout: 100 });
    const result = await pool.execute({ chunk: [{ r: 1, c: 2, v: 'hello' }], query: 'hello', options: {} });

    expect(result).toEqual([{ r: 1, c: 2 }]);
    expect(pool.clients[0].worker.messages[0].taskId).toMatch(/^SearchWorker0_/);

    pool.destroy();
    expect(pool.getStats()).toEqual({
      size: 1,
      idle: 0,
      queued: 0,
      pending: 0,
      destroyed: true
    });
  });

  test('destroy 应该拒绝排队任务并清理 worker', async () => {
    class HangingWorker {
      constructor() {
        this.listeners = { message: [], error: [] };
        this.terminated = false;
      }

      addEventListener(type, listener) {
        this.listeners[type].push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners[type] = this.listeners[type].filter(item => item !== listener);
      }

      postMessage() {}

      terminate() {
        this.terminated = true;
      }
    }

    global.Worker = HangingWorker;

    const pool = new SearchWorkerPool(1, { timeout: 100 });
    const running = pool.execute({ chunk: [{ r: 0, c: 0, v: 'a' }], query: 'a', options: {} });
    const queued = pool.execute({ chunk: [{ r: 1, c: 0, v: 'b' }], query: 'b', options: {} });

    pool.destroy();

    await expect(running).rejects.toThrow(/destroyed|terminated/i);
    await expect(queued).rejects.toThrow(/destroyed/i);
    expect(pool.clients).toHaveLength(0);
    expect(pool.idleClients).toHaveLength(0);
  });
});
