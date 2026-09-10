import { describe, test, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';

// 必须显式 unmock，否则会受到 tests/setup.js 全局 mock 的干扰
vi.unmock('../../src/core/worker/TransferableSerializer.js');

import {
  serializeFormulaBatch,
  deserializeFormulaBatch,
  serializeFormulaResults,
  deserializeFormulaResults
} from '../../src/core/worker/TransferableSerializer.js';

describe('TransferableSerializer & Multithreading Real Integration Test', () => {
  test('应该在真实多线程环境下，无损完成公式请求的序列化、跨线程传输、反序列化计算及结果传回', async () => {
    // 1. 准备待计算的公式和单元格数据
    const formulas = [
      { cellId: 'A1', formula: '=10+20' },
      { cellId: 'B1', formula: '=A1*2' }
    ];
    const data = {
      'A1': { v: 30, f: '=10+20', dirty: false }
    };

    // 2. 将数据序列化为二进制 Buffer
    const { buffer } = serializeFormulaBatch(formulas, data);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // 3. 启动一个真实的 Node.js Worker 线程
    // 该线程充当公式 Worker 服务，加载真实的序列化器代码，执行计算并返回二进制流
    const workerCode = `
      const { parentPort } = require('node:worker_threads');

      parentPort.on('message', async ({ buffer }) => {
        try {
          // 由于是 ESM 模块，在 Node 子线程中必须使用动态 import 载入
          const {
            deserializeFormulaBatch,
            serializeFormulaResults
          } = await import('./src/core/worker/TransferableSerializer.js');

          // 在子线程反序列化主线程传来的 Buffer
          const { formulas, data } = deserializeFormulaBatch(buffer);

          // 执行求值逻辑
          const results = {};
          for (const f of formulas) {
            if (f.cellId === 'A1') results['A1'] = 30;
            if (f.cellId === 'B1') results['B1'] = 60;
          }

          // 将结果重新序列化为二进制
          const serialized = serializeFormulaResults(results);
          parentPort.postMessage({ type: 'result', buffer: serialized.buffer }, [serialized.buffer]);
        } catch (e) {
          parentPort.postMessage({ error: e.message });
        }
      });
    `;

    const worker = new Worker(workerCode, { eval: true });

    // 4. 发送序列化后的二进制 Buffer 给子线程（零拷贝传输）
    const responsePromise = new Promise((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg.type === 'result') {
          resolve(msg.buffer);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      });
      worker.on('error', reject);
    });

    worker.postMessage({ buffer }, [buffer]);

    const resBuffer = await responsePromise;
    expect(Object.prototype.toString.call(resBuffer)).toBe('[object ArrayBuffer]');
    expect(resBuffer.byteLength).toBeGreaterThan(0);

    // 5. 主线程反序列化接收到的结果
    const results = deserializeFormulaResults(resBuffer);
    expect(results).toEqual({
      'A1': 30,
      'B1': 60
    });

    // 销毁线程
    await worker.terminate();
  });
});
