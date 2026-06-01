/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * Web Worker 管理器
 *
 * 管理公式 Worker 的生命周期、通信、超时和降级执行。
 */

import {
  serializeFormulaBatch,
  deserializeFormulaResults,
  isTransferableSupported
} from './TransferableSerializer.js';
import { WorkerClient, isWorkerRuntimeSupported } from './WorkerClient.js';

export const isWorkerSupported = isWorkerRuntimeSupported;
export const isTransferableEnabled = isTransferableSupported();

export class WorkerManager {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || options.workerPath || null;
    this.timeout = options.timeout || 30000;
    this.fallbackEnabled = options.fallbackEnabled !== false;
    this.fallbackExecutor = options.fallbackExecutor || null;
    this.useTransferable = options.useTransferable !== false && isTransferableEnabled;
    this.createWorker = options.createWorker || null;

    this.client = null;
    this.isReady = false;
    this.useFallback = false;
    this.taskIdCounter = 0;
    this.readyCallbacks = [];

    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalDuration: 0,
      avgDuration: 0,
      workerTime: 0,
      fallbackTime: 0,
      transferableBytes: 0,
      savedCopyBytes: 0
    };

    // 延迟到第一次 execute() 时再初始化 Worker，避免不必要的启动成本
  }

  get worker() {
    return this.client ? this.client.worker : null;
  }

  get pendingTasks() {
    return this.client ? this.client.pendingTasks : new Map();
  }

  _initWorker() {
    if (!isWorkerSupported && !this.createWorker) {
      this._enableFallback('Worker not supported');
      return;
    }

    try {
      this.client = new WorkerClient({
        name: 'FormulaWorker',
        timeout: this.timeout,
        requestIdField: 'taskId',
        waitForReady: true,
        createWorker: this.createWorker || (() => {
          if (this.workerUrl) {
            return new Worker(this.workerUrl, { type: 'module' });
          }
          return new Worker(new URL('../../workers/formula.worker.js', import.meta.url), { type: 'module' });

        }),
        onError: (error) => {
          this._enableFallback(`Worker error: ${error.message || error.type || 'unknown'}`);
        }
      });

      this.client.ready()
        .then(() => {
          this.isReady = true;
          this._triggerReadyCallbacks();
        })
        .catch(() => {});
    } catch (error) {
      this._enableFallback(`Failed to create worker: ${error.message}`);
    }
  }

  _enableFallback(reason) {
    if (this.useFallback) return;
    if (!this.fallbackEnabled) {
      throw new Error(reason);
    }

    console.warn(`[WorkerManager] Enabling fallback mode: ${reason}`);
    if (this.client) {
      const client = this.client;
      this.client = null;
      client.destroy(reason);
    }
    this.useFallback = true;
    this.isReady = true;
    this._triggerReadyCallbacks();
  }

  _triggerReadyCallbacks() {
    const callbacks = this.readyCallbacks;
    this.readyCallbacks = [];
    callbacks.forEach((resolve) => resolve());
  }

  ready() {
    if (this.isReady) return Promise.resolve();

    // 惰性初始化：首次 ready/execute 时才创建 Worker
    if (!this.client && !this._initialized) {
      this._initialized = true;
      this._initWorker();
    }

    if (this.client) return this.client.ready();
    return new Promise((resolve) => {
      this.readyCallbacks.push(resolve);
    });
  }

  _recordWorkerSuccess(duration = 0) {
    this.stats.tasksCompleted++;
    this.stats.totalDuration += duration;
    this.stats.avgDuration = this.stats.totalDuration / this.stats.tasksCompleted;
    this.stats.workerTime += duration;
  }

  _recordFallbackSuccess(duration = 0) {
    this.stats.tasksCompleted++;
    this.stats.totalDuration += duration;
    this.stats.avgDuration = this.stats.totalDuration / this.stats.tasksCompleted;
    this.stats.fallbackTime += duration;
  }

  _executeWithFallback(type, data) {
    const startTime = performance.now();

    if (!this.fallbackExecutor) {
      this.stats.tasksFailed++;
      return Promise.reject(new Error('No fallback executor provided'));
    }

    try {
      const result = this.fallbackExecutor(type, data);
      this._recordFallbackSuccess(performance.now() - startTime);
      return Promise.resolve(result);
    } catch (error) {
      this.stats.tasksFailed++;
      return Promise.reject(error);
    }
  }

  async execute(type, data = {}, options = {}) {
    if (this.useFallback) {
      return this._executeWithFallback(type, data);
    }

    // 惰性初始化：首次 execute 时才创建 Worker
    if (!this.client && !this._initialized) {
      this._initialized = true;
      this._initWorker();
    }

    if (!this.client) {
      this._enableFallback('Worker not available');
      return this._executeWithFallback(type, data);
    }

    const useTransferable = options.useTransferable !== false && this.useTransferable;
    let payload = {
      type,
      sharedChunks: data.sharedChunks,
      ...data
    };
    let transferables = [];

    if (useTransferable && type === 'evaluateBatch' && data.formulas && data.data) {
      const serialized = serializeFormulaBatch(data.formulas, data.data);
      this.stats.transferableBytes += serialized.buffer.byteLength;
      this.stats.savedCopyBytes += serialized.buffer.byteLength;
      payload = {
        type,
        useTransferable: true,
        buffer: serialized.buffer,
        sharedChunks: data.sharedChunks
      };
      transferables = serialized.transferables;
    }

    try {
      const response = await this.client.request(payload, transferables);

      if (!response || response.success === false) {
        const error = new Error(response?.error || 'Unknown worker error');
        error.code = 'WORKER_TASK_ERROR';
        throw error;
      }

      this._recordWorkerSuccess(response.duration || 0);

      if (response.useTransferable && response.buffer && useTransferable) {
        const results = deserializeFormulaResults(response.buffer);
        this.stats.transferableBytes += response.buffer.byteLength;
        this.stats.savedCopyBytes += response.buffer.byteLength;
        return results;
      }

      return response.result;
    } catch (error) {
      this.stats.tasksFailed++;
      if (error.code === 'WORKER_TIMEOUT') {
        throw error;
      }
      if (error.code === 'WORKER_TASK_ERROR') {
        throw error;
      }
      if (this.useFallback) {
        return this._executeWithFallback(type, data);
      }
      if (this.fallbackEnabled) {
        this._enableFallback(error.message || 'Worker request failed');
        return this._executeWithFallback(type, data);
      }
      throw error;
    }
  }

  async executeBatch(tasks) {
    return Promise.all(tasks.map(({ type, data }) => this.execute(type, data)));
  }

  terminate() {
    if (this.client) {
      this.client.destroy('Worker terminated');
      this.client = null;
    }
    this.isReady = false;
    this.useFallback = true;
  }

  restart() {
    if (this.client) {
      this.client.destroy('Worker restarted');
      this.client = null;
    }
    this.isReady = false;
    this.useFallback = false;
    this._initWorker();
  }

  getStats() {
    return {
      ...this.stats,
      pendingTasks: this.pendingTasks.size,
      isReady: this.isReady,
      useFallback: this.useFallback,
      useTransferable: this.useTransferable
    };
  }

  resetStats() {
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalDuration: 0,
      avgDuration: 0,
      workerTime: 0,
      fallbackTime: 0,
      transferableBytes: 0,
      savedCopyBytes: 0
    };
  }

  destroy() {
    if (this.client) {
      this.client.destroy('Worker manager destroyed');
      this.client = null;
    }
    this.readyCallbacks = [];
    this.fallbackExecutor = null;
    this.isReady = false;
    this.useFallback = true;
  }
}

export function createFormulaWorkerManager(options = {}) {
  return new WorkerManager({
    timeout: 60000,
    fallbackEnabled: true,
    ...options
  });
}


export default WorkerManager;
