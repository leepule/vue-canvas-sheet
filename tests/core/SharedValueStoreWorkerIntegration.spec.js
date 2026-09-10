import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { SharedValueStore } from '../../src/core/data/SharedValueStore.js';

function createFormulaWorker() {
  const workerUrl = pathToFileURL(
    path.resolve(process.cwd(), 'src/workers/formula.worker.js')
  );
  const source = `
    const { parentPort } = require('node:worker_threads');
    const port = parentPort;
    globalThis.self = {
      postMessage: (...args) => port.postMessage(...args)
    };
    (async () => {
      await import(${JSON.stringify(workerUrl.href)});
      port.on('message', data => self.onmessage({ data }));
    })().catch(error => {
      port.postMessage({ type: 'worker-load-error', error: error.message });
    });
  `;

  return new Worker(source, { eval: true });
}

function waitForReady(worker) {
  return new Promise((resolve, reject) => {
    worker.once('message', message => {
      if (message.type === 'ready') resolve();
      else reject(new Error(message.error || 'Unexpected worker startup message'));
    });
    worker.once('error', reject);
  });
}

function requestRecalc(worker, sharedChunks, formulas, data) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message.type !== 'result') return;
      worker.off('message', onMessage);
      worker.off('error', onError);
      if (message.success) resolve(message.result);
      else reject(new Error(message.error));
    };
    const onError = error => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      reject(error);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(
      {
        type: 'recalcAll',
        taskId: 'shared-value-store-worker-test',
        sharedChunks,
        formulas,
        data
      },
      []
    );
  });
}

describe('SharedValueStore 与公式 Worker 集成', () => {
  it('worker 应优先读写 compact continuous buffer', async () => {
    const store = new SharedValueStore(10000, 256);
    store.set(0, 0, 10);
    store.getBuffer();

    const serialized = store.serialize();
    expect(serialized.chunks).toEqual({});

    const worker = createFormulaWorker();
    try {
      await waitForReady(worker);
      const results = await requestRecalc(
        worker,
        serialized,
        [
          { cellId: '0-1', formula: '=A1*2' },
          { cellId: '1-1', formula: '=IF(A1>5,"ok","no")' }
        ],
        {
          '0-1': { f: '=A1*2', v: null, dirty: true },
          '1-1': { f: '=IF(A1>5,"ok","no")', v: null, dirty: true }
        }
      );

      expect(store.get(0, 1)).toBe(20);
      expect(store.get(1, 1)).toBe(SharedValueStore.EMPTY_VALUE);
      expect(results).toEqual({ '1-1': 'ok' });
    } finally {
      await worker.terminate();
    }
  });
});
