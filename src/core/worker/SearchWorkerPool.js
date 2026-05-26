/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { WorkerClient, getDefaultWorkerPoolSize } from './WorkerClient.js';
import { HeadPointerQueue } from '../utils/Queues.js';


const DEFAULT_TIMEOUT = 10000;

/**
 * 搜索 Worker 线程池
 * 管理多个常驻 Web Worker，用于并行搜索大数据集
 */
export class SearchWorkerPool {
  constructor(size = getDefaultWorkerPoolSize(), options = {}) {
    this.size = Math.max(1, Math.min(size || getDefaultWorkerPoolSize(), getDefaultWorkerPoolSize()));
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.clients = [];
    this.idleClients = [];
    this.queue = new HeadPointerQueue();
    this.destroyed = false;
    this._init();
  }

  _init() {
    for (let i = 0; i < this.size; i++) {
      const client = this._createClient(i);
      this.clients.push(client);
      this.idleClients.push(client);
    }
  }

  _createClient(index) {
    return new WorkerClient({
      name: `SearchWorker${index}`,
      timeout: this.timeout,
      requestIdField: 'taskId',
      createWorker: () => new Worker(new URL('../../workers/search.worker.js', import.meta.url), { type: 'module' })

    });
  }

  /**
   * 执行搜索任务
   * @param {Object} data - { chunk, query, options }
   * @returns {Promise<Array>}
   */
  execute(data) {
    if (this.destroyed) {
      return Promise.reject(new Error('SearchWorkerPool is destroyed'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      this._next();
    });
  }

  _next() {
    if (this.queue.length === 0 || this.idleClients.length === 0 || this.destroyed) return;

    const client = this.idleClients.pop();
    const task = this.queue.shift();

    client.request(task.data)
      .then((response) => {
        if (!response || response.success === false) {
          throw new Error(response?.error || 'Search worker task failed');
        }
        task.resolve(response?.result || []);
      })
      .catch(task.reject)
      .finally(() => {
        if (!this.destroyed && this.clients.includes(client)) {
          this.idleClients.push(client);
          this._next();
        }
      });
  }

  /**
   * 销毁线程池
   */
  destroy() {
    this.destroyed = true;

    const error = new Error('SearchWorkerPool destroyed');
    this.queue.forEach((task) => task.reject(error));
    this.queue.clear();

    this.clients.forEach((client) => client.destroy('Search worker pool destroyed'));
    this.clients = [];
    this.idleClients = [];

    if (instance === this) {
      instance = null;
    }
  }

  getStats() {
    return {
      size: this.size,
      idle: this.idleClients.length,
      queued: this.queue.length,
      pending: this.clients.reduce((sum, client) => sum + client.pendingTasks.size, 0),
      destroyed: this.destroyed
    };
  }
}

let instance = null;

export function getSearchWorkerPool(size) {
  if (!instance || instance.destroyed) {
    instance = new SearchWorkerPool(size);
  }
  return instance;
}
