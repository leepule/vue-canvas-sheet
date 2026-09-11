/**
 * Vitest 测试环境设置文件
 * 在每个测试文件运行前执行
 */

import { vi } from 'vitest'

// Mock WorkerManager 模块（因为它使用了 import.meta.url）
vi.mock('@/core/worker/WorkerManager.js', () => {
  class MockWorkerManager {
    constructor(options = {}) {
      this.workerPath = options.workerPath || '';
      this.timeout = options.timeout || 30000;
      this.fallbackEnabled = options.fallbackEnabled !== false;
      this.fallbackExecutor = options.fallbackExecutor || null;
      this.useTransferable = false;
      this.worker = null;
      this.pendingTasks = new Map();
      this.taskIdCounter = 0;
      this.isReady = true;
      this.readyCallbacks = [];
      this.useFallback = true;
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

    ready() {
      return Promise.resolve();
    }

    execute(type, data, options = {}) {
      return new Promise((resolve, reject) => {
        if (this.fallbackExecutor) {
          try {
            const result = this.fallbackExecutor(type, data);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        } else {
          resolve(null);
        }
      });
    }

    async executeBatch(tasks) {
      const results = await Promise.all(
        tasks.map(({ type, data }) => this.execute(type, data))
      );
      return results;
    }

    terminate() {
      this.worker = null;
      this.pendingTasks.clear();
      this.isReady = false;
    }

    restart() {
      this.terminate();
      this.isReady = true;
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
      this.terminate();
      this.readyCallbacks = [];
      this.fallbackExecutor = null;
    }
  }

  return {
    WorkerManager: MockWorkerManager,
    createFormulaWorkerManager: vi.fn((options = {}) => {
      return new MockWorkerManager(options);
    }),
    isWorkerSupported: false
  };
});

// Mock TransferableSerializer 模块
vi.mock('@/core/worker/TransferableSerializer.js', () => ({
  serializeFormulaBatch: vi.fn((formulas, data) => ({
    buffer: new ArrayBuffer(0),
    transferables: []
  })),
  deserializeFormulaBatch: vi.fn(() => ({ formulas: [], data: {} })),
  serializeFormulaResults: vi.fn(() => ({
    buffer: new ArrayBuffer(0),
    transferables: []
  })),
  deserializeFormulaResults: vi.fn((buffer) => []),
  serializeRenderData: vi.fn((data) => ({
    buffer: new ArrayBuffer(0),
    transferables: []
  })),
  deserializeRenderData: vi.fn(() => ({})),
  isTransferableSupported: vi.fn(() => false)
}));

// 模拟 localStorage
const localStorageMock = {
  store: {},
  getItem(key) {
    return this.store[key] || null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  }
};
Object.defineProperty(global, 'localStorage', {
  value: localStorageMock
});

// 模拟 Canvas 和 WebGL 上下文
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(function(contextId) {
    if (contextId === '2d') {
      return {
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn(() => ({ width: 100 })),
        createLinearGradient: vi.fn(() => ({
          addColorStop: vi.fn()
        })),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        setTransform: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        rect: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        setLineDash: vi.fn(),
        clip: vi.fn(),
        font: '14px Arial',
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        textAlign: 'left',
        textBaseline: 'middle'
      };
    }
    if (contextId === 'webgl' || contextId === 'experimental-webgl') {
      return null;
    }
    return null;
  });
}

// 模拟 OffscreenCanvas
global.OffscreenCanvas = vi.fn().mockImplementation((width, height) => ({
  width,
  height,
  getContext: vi.fn(() => ({
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    font: '14px Arial',
    fillStyle: '#000000'
  })),
  transferToImageBitmap: vi.fn()
}));

// 模拟 requestAnimationFrame
global.requestAnimationFrame = vi.fn((callback) => {
  return setTimeout(callback, 16);
});
global.cancelAnimationFrame = vi.fn((id) => {
  clearTimeout(id);
});

// 模拟 requestIdleCallback
global.requestIdleCallback = vi.fn((callback) => {
  return setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
});
global.cancelIdleCallback = vi.fn((id) => {
  clearTimeout(id);
});

// 模拟 performance.now()
global.performance = {
  now: vi.fn(() => Date.now()),
  mark: vi.fn(),
  measure: vi.fn(),
  getEntriesByName: vi.fn(() => []),
  getEntriesByType: vi.fn(() => [])
};

// 模拟 Worker
class MockWorker {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = {};
  }
  
  postMessage(data) {
    setTimeout(() => {
      if (this.onmessage && data.type === 'evaluate') {
        this.onmessage({ data: { type: 'result', result: 42 } });
      }
    }, 0);
  }
  
  addEventListener(type, listener) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(listener);
  }
  
  removeEventListener(type, listener) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(l => l !== listener);
    }
  }
  
  terminate() {}
}
global.Worker = MockWorker;

// 模拟 URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// 模拟 IndexedDB
const indexedDBMock = {
  open: vi.fn(() => ({
    result: {
      createObjectStore: vi.fn(),
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => ({
          get: vi.fn(),
          put: vi.fn(),
          delete: vi.fn(),
          add: vi.fn()
        }))
      }))
    },
    onsuccess: null,
    onerror: null
  })),
  deleteDatabase: vi.fn()
};
Object.defineProperty(global, 'indexedDB', {
  value: indexedDBMock
});

// 全局测试工具函数
global.testUtils = {
  createTestData(rows = 10, cols = 10) {
    const data = {};
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        data[`${r}-${c}`] = { v: `R${r}C${c}` };
      }
    }
    return data;
  },
  
  createLargeDataset(count = 1000) {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      value: Math.random() * 1000,
      date: new Date().toISOString()
    }));
  },
  
  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  
  async measurePerformance(fn, iterations = 100) {
    const times = [];
    let result;
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      result = await fn();
      const end = performance.now();
      times.push(end - start);
    }
    
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const sorted = times.slice().sort((a, b) => a - b);
    const p50 = sorted[Math.floor(times.length * 0.5)];
    const p95 = sorted[Math.floor(times.length * 0.95)];
    const p99 = sorted[Math.floor(times.length * 0.99)];
    
    return {
      iterations,
      avg,
      min,
      max,
      p50,
      p95,
      p99,
      result
    };
  },
  
  getMemoryUsage() {
    if (global.gc) {
      global.gc();
    }
    const usage = process.memoryUsage ? process.memoryUsage() : { heapUsed: 0, heapTotal: 0 };
    return {
      heapUsedMB: (usage.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (usage.heapTotal / 1024 / 1024).toFixed(2)
    };
  }
};

// 清理函数
afterEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});

if (process.env.VITEST_SETUP_SILENT !== '1') {
  process.stdout.write('✅ Vitest 测试环境已初始化\n');
}
