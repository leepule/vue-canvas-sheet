/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * Shared Web Worker request client.
 *
 * It centralizes module-worker creation, request ids, timeouts, ready signals,
 * and deterministic cleanup for the different worker users in the workbook.
 */

export const isWorkerRuntimeSupported = typeof Worker !== 'undefined';

export function getDefaultWorkerPoolSize(max = 4) {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 2;
  return Math.max(1, Math.min(max, Math.max(1, cores - 1)));
}

export class WorkerClient {
  constructor(options = {}) {
    this.name = options.name || 'WorkerClient';
    this.timeout = options.timeout || 30000;
    this.requestIdField = options.requestIdField || 'taskId';
    this.waitForReady = options.waitForReady === true;
    this.isReadyMessage = options.isReadyMessage || ((data) => data && data.type === 'ready');
    this.createWorker = options.createWorker;
    this.onError = options.onError || null;

    this.worker = null;
    this.pendingTasks = new Map();
    this.readyCallbacks = [];
    this.taskIdCounter = 0;
    this.isReady = !this.waitForReady;
    this.destroyed = false;

    this._handleMessage = this._handleMessage.bind(this);
    this._handleError = this._handleError.bind(this);
    this._init();
  }

  _init() {
    if (!this.createWorker && !isWorkerRuntimeSupported) {
      throw new Error('Worker is not supported');
    }
    if (!this.createWorker) {
      throw new Error('WorkerClient requires createWorker');
    }

    this.worker = this.createWorker();
    if (!this.worker) {
      throw new Error('createWorker returned no worker');
    }

    if (this.worker.addEventListener) {
      this.worker.addEventListener('message', this._handleMessage);
      this.worker.addEventListener('error', this._handleError);
    } else {
      this.worker.onmessage = this._handleMessage;
      this.worker.onerror = this._handleError;
    }
  }

  _generateTaskId() {
    return `${this.name}_${++this.taskIdCounter}_${Date.now()}`;
  }

  _getResponseId(data) {
    return data && (data[this.requestIdField] || data.taskId || data.id);
  }

  _resolveReady() {
    this.isReady = true;
    const callbacks = this.readyCallbacks;
    this.readyCallbacks = [];
    callbacks.forEach(({ resolve }) => resolve());
  }

  _handleMessage(event) {
    const data = event.data;
    if (this.waitForReady && this.isReadyMessage(data)) {
      this._resolveReady();
      return;
    }

    const taskId = this._getResponseId(data);
    if (!taskId) return;

    const task = this.pendingTasks.get(taskId);
    if (!task) return;

    clearTimeout(task.timeoutId);
    this.pendingTasks.delete(taskId);
    task.resolve(data);
  }

  _handleError(error) {
    if (this.onError) {
      // 用户回调抛错不应跳过 rejectAll —— 否则 pending tasks 只能等各自超时兜底
      try {
        this.onError(error);
      } catch (callbackError) {
        console.error(`[${this.name}] onError handler threw:`, callbackError);
      }
    }
    this.rejectAll(new Error(`${this.name} worker error`));
  }

  ready() {
    if (this.isReady) return Promise.resolve();
    if (this.destroyed) return Promise.reject(new Error(`${this.name} is destroyed`));
    return new Promise((resolve, reject) => {
      this.readyCallbacks.push({ resolve, reject });
    });
  }

  request(payload = {}, transferables = [], options = {}) {
    if (this.destroyed || !this.worker) {
      return Promise.reject(new Error(`${this.name} is destroyed`));
    }

    const requestIdField = options.requestIdField || this.requestIdField;
    const taskId = payload[requestIdField] || this._generateTaskId();
    const timeout = options.timeout || this.timeout;
    const message = {
      ...payload,
      [requestIdField]: taskId
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pendingTasks.has(taskId)) return;
        this.pendingTasks.delete(taskId);
        const error = new Error(`Worker task timeout: ${payload.type || taskId}`);
        error.code = 'WORKER_TIMEOUT';
        reject(error);
      }, timeout);

      this.pendingTasks.set(taskId, { resolve, reject, timeoutId });

      try {
        this.worker.postMessage(message, transferables);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingTasks.delete(taskId);
        reject(error);
      }
    });
  }

  rejectAll(error) {
    for (const task of this.pendingTasks.values()) {
      clearTimeout(task.timeoutId);
      task.reject(error);
    }
    this.pendingTasks.clear();
  }

  destroy(reason = 'Worker terminated') {
    this.destroyed = true;
    this.rejectAll(new Error(reason));
    const readyError = new Error(reason);
    this.readyCallbacks.forEach(({ reject }) => reject(readyError));
    this.readyCallbacks = [];

    if (this.worker) {
      if (this.worker.removeEventListener) {
        this.worker.removeEventListener('message', this._handleMessage);
        this.worker.removeEventListener('error', this._handleError);
      }
      this.worker.terminate();
      this.worker = null;
    }

    this.isReady = false;
  }
}

export default WorkerClient;
