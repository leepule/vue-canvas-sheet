/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 公式引擎服务 — 封装 Worker/WASM 初始化、共享内存管理和跨线程重算
 *
 * 从 Workbook.js 解耦，遵循与 MergeManager/StyleManager 等一致的 deps 注入模式。
 */
import { WasmBridge } from '../worker/WasmBridge.js';
import {
  WorkerManager,
  createFormulaWorkerManager,
  isWorkerSupported
} from '../worker/WorkerManager.js';
import { SheetError, ErrorCodes } from './SheetError.js';
import { SharedValueStore } from './SharedValueStore.js';
import { HeadPointerQueue } from '../utils/Queues.js';
import { Events } from '../events/EventEmitter.js';

// Worker 载荷中范围内联快照的单元格数上限
const MAX_INLINE_RANGE_SNAPSHOT_CELLS = 5000;

/**
 * 公式引擎服务 — 封装 Worker/WASM 初始化、共享内存管理和跨线程重算。
 *
 * 从 Workbook.js 解耦，遵循与 MergeManager/StyleManager 等一致的 deps 注入模式。
 *
 * @typedef {Object} FormulaEngineDeps
 * @property {() => SparseMatrix}             getDataMatrix          — 数据矩阵引用
 * @property {(r: number, c: number) => string} cellKey              — 行列 → 单元格键
 * @property {(k: string) => {r:number,c:number}} parseKey           — 键解析器
 * @property {() => Map}                      getDependencyMap       — 获取公式依赖图
 * @property {() => Map}                      getReverseDependencyMap — 获取反向依赖图
 * @property {(f: string) => Object}          getDependencies        — 解析公式依赖
 * @property {(id: string, f: string) => void} updateDependencyMap   — 更新依赖图
 * @property {() => SharedValueStore|null}    getSharedValueStore    — 获取共享数值存储
 * @property {(s: SharedValueStore) => void}  setSharedValueStore    — 设置共享数值存储
 * @property {(r: number, c: number, v: number) => void} syncSharedValue — 同步到共享内存
 * @property {() => IncrementalCalculationEngine} getCalcEngine      — 获取增量计算引擎
 * @property {(f: string, r: number, c: number, stack?: Array) => any} evaluateFormula — 执行公式求值
 * @property {() => number}                   getRowCount            — 总行数
 * @property {() => number}                   getColCount            — 总列数
 * @property {() => PerformanceMonitor}       getPerformanceMonitor  — 性能监控器
 * @property {ErrorHandler}                   errorHandler           — 错误处理器
 * @property {(...args: any[]) => void}       emit                   — 事件发射
 * @property {(...args: any[]) => void}       notify                 — UI 通知
 */
export class FormulaEngineService {
  /**
   * @param {FormulaEngineDeps} deps — 具名依赖注入，详见 FormulaEngineDeps typedef
   */
  constructor(deps) {
    /** @type {FormulaEngineDeps} */
    this.d = deps;

    // ========== Web Worker 支持 ==========
    /** @type {WorkerManager|null} */
    this._workerManager = null;
    /** @type {boolean} */
    this._useWorker = false;
    /** @type {boolean} */
    this._workerCalculating = false;
    /** @type {HeadPointerQueue} */
    this._workerQueue = new HeadPointerQueue();

    // ========== WASM 共享内存 ==========
    /** @type {SharedValueStore|null} */
    this.sharedValueStore = null;
    this._sharedRows = 100000;
    this._sharedCols = 256;

    // ========== WASM 桥接 ==========
    this.wasmBridge = new WasmBridge();
  }

  // ───────── Worker 生命周期 ─────────

  enableWorker(options = {}) {
    if (!isWorkerSupported) {
      console.warn('[FormulaEngine] Web Worker not supported in this environment');
      return false;
    }

    if (this._workerManager) {
      console.warn('[FormulaEngine] Worker already enabled');
      return false;
    }

    try {
      this._workerManager = createFormulaWorkerManager({
        timeout: options.timeout || 60000,
        fallbackEnabled: true,
        fallbackExecutor: (type, data) => this._fallbackExecutor(type, data)
      });
      this._useWorker = true;
      return true;
    } catch (error) {
      this.d.errorHandler.handle(
        new SheetError(ErrorCodes.OPERATION_FAILED, 'Failed to enable Worker', {
          originalError: error.message
        }),
        { phase: 'worker-init' }
      );
      return false;
    }
  }

  disableWorker() {
    if (this._workerManager) {
      this._workerManager.destroy();
      this._workerManager = null;
    }
    this._useWorker = false;
  }

  isWorkerEnabled() {
    return this._useWorker && this._workerManager !== null;
  }

  get isUsingWorker() {
    return this._useWorker;
  }

  get workerManager() {
    return this._workerManager;
  }

  getWorkerStats() {
    return this._workerManager ? this._workerManager.getStats() : null;
  }

  // ───────── Worker 重算 ─────────

  /**
   * 使用 Worker 异步计算所有公式
   */
  async recalcAllWithWorker() {
    if (this._workerCalculating) {
      return new Promise((resolve, reject) => {
        this._workerQueue.push({ resolve, reject });
      });
    }

    this._workerCalculating = true;
    const startTime =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    try {
      const formulas = [];
      const nonNumericData = {};

      this.d.getDataMatrix().forEach((r, c, cell) => {
        if (cell && cell.f) {
          formulas.push({ cellId: this.d.cellKey(r, c), formula: cell.f });
        } else if (
          cell &&
          (typeof cell.v === 'string' || typeof cell.v === 'boolean')
        ) {
          nonNumericData[this.d.cellKey(r, c)] = { v: cell.v };
        }
      });

      if (formulas.length === 0) {
        this._workerCalculating = false;
        this._processWorkerQueue();
        return;
      }

      const sharedChunks = this.sharedValueStore
        ? this.sharedValueStore.serialize()
        : null;

      const results = await this._workerManager.execute('recalcAll', {
        formulas,
        data: nonNumericData,
        sharedChunks,
        sharedRows: this.sharedValueStore
          ? this.sharedValueStore.maxRows
          : undefined,
        sharedCols: this.sharedValueStore
          ? this.sharedValueStore.maxCols
          : undefined
      });

      // 应用 Worker 返回的结果（含降级环境下的数字结果）
      for (const [cellId, result] of Object.entries(results || {})) {
        const { r, c } = this.d.parseKey(cellId);
        const cell = this.d.getDataMatrix().get(r, c);
        if (cell) {
          cell.v = result;
          cell.dirty = false;
          // 无论是否为数字，均同步至共享内存（非数字类型在底层会自动转换为 EMPTY_VALUE 即 -Infinity）
          this.d.syncSharedValue?.(r, c, result);
        }
      }

      this._workerCalculating = false;
      this._processWorkerQueue();

      const calcEngine = this.d.getCalcEngine();
      if (calcEngine) {
        this._recordCalcStats(calcEngine, formulas.length, startTime);
        calcEngine.recordWorkerPayloadStats({
          formulaCount: formulas.length,
          cellCount: Object.keys(nonNumericData).length,
          estimatedBytes: this._estimateWorkerPayloadBytes(formulas, nonNumericData)
        });
      }

      // 触发公式计算完成事件
      const resultList = Object.entries(results || {}).map(
        ([cellId, value]) => ({ cellId, value })
      );
      this.d.emit('FORMULAS_CALCULATED', {
        results: resultList,
        count: resultList.length,
        worker: true
      });

      this.d.notify();
    } catch (error) {
      this.d.errorHandler.handle(
        new SheetError(
          ErrorCodes.OPERATION_FAILED,
          'Worker recalc failed, falling back to main thread',
          { originalError: error.message }
        ),
        { phase: 'recalc' }
      );
      this._workerCalculating = false;
      this._processWorkerQueue();
      // 返回 null 通知调用方降级
      return null;
    }
  }

  /**
   * 使用 Worker 增量计算脏公式
   */
  async recalcDirtyWithWorker(cellIds) {
    const payload = this._buildFormulaWorkerPayload(cellIds);
    if (payload.formulas.length === 0) {
      return {};
    }

    const calcEngine = this.d.getCalcEngine();
    if (calcEngine) {
      calcEngine.recordWorkerPayloadStats(payload.stats);
    }

    const results = await this._workerManager.execute(
      'evaluateBatch',
      payload.task
    );
    for (const [cellId, result] of Object.entries(results || {})) {
      const { r, c } = this.d.parseKey(cellId);
      const cell = this.d.getDataMatrix().get(r, c);
      if (cell) {
        cell.v = result;
        cell.dirty = false;
        this.d.syncSharedValue(r, c, result);
      }
    }
    this.d.notify();
    return results || {};
  }

  // ───────── Worker 降级执行器 ─────────

  _fallbackExecutor(type, data) {
    switch (type) {
      case 'evaluate':
        return this.d.evaluateFormula(data.formula, data.r, data.c);
      case 'evaluateBatch': {
        const results = {};
        for (const { cellId, formula, r, c } of data.formulas) {
          results[cellId] = this.d.evaluateFormula(formula, r, c);
        }
        return results;
      }
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  }

  // ───────── Worker 载荷构建 ─────────

  _buildFormulaWorkerPayload(cellIds) {
    const formulas = [];
    const data = {};

    const sab = this.sharedValueStore;
    const sabReady = !!(sab && sab.supported);

    const includeCell = (r, c) => {
      if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0)
        return;
      const key = this.d.cellKey(r, c);
      if (data[key]) return;
      const cell = this.d.getDataMatrix().get(r, c);

      if (sabReady && cell && !cell.f) {
        const v = cell.v;
        if (typeof v === 'number' && Number.isFinite(v) && sab.get(r, c) === v) {
          return;
        }
      }

      data[key] = cell
        ? { v: cell.v, f: cell.f, dirty: cell.dirty }
        : { v: null };
    };

    const includeRangeValues = (range) => {
      const rowSpan = range.endR - range.startR + 1;
      const colSpan = range.endC - range.startC + 1;
      const size = rowSpan * colSpan;
      if (size > MAX_INLINE_RANGE_SNAPSHOT_CELLS) {
        this.d
          .getDataMatrix()
          .iterateRange(
            range.startR,
            range.startC,
            range.endR,
            range.endC,
            (r, c) => includeCell(r, c)
          );
        return;
      }

      for (let r = range.startR; r <= range.endR; r++) {
        for (let c = range.startC; c <= range.endC; c++) {
          includeCell(r, c);
        }
      }
    };

    for (const cellId of cellIds) {
      const { r, c } = this.d.parseKey(cellId);
      const cell = this.d.getDataMatrix().get(r, c);
      if (!cell || !cell.f) continue;

      formulas.push({ cellId, formula: cell.f, r, c });
      includeCell(r, c);

      const reverseMap = this.d.getReverseDependencyMap();
      const deps =
        reverseMap.get(cellId) || this.d.getDependencies(cell.f);
      if (deps.cells) {
        for (const depId of deps.cells) {
          const dep = this.d.parseKey(depId);
          includeCell(dep.r, dep.c);
        }
      }
      if (deps.ranges) {
        for (const range of deps.ranges) {
          includeRangeValues(range);
        }
      }
    }

    const sharedChunks = this.sharedValueStore
      ? this.sharedValueStore.serialize()
      : undefined;

    const stats = {
      formulaCount: formulas.length,
      cellCount: Object.keys(data).length,
      estimatedBytes: this._estimateWorkerPayloadBytes(formulas, data)
    };

    return {
      formulas,
      task: { formulas, data, sharedChunks },
      stats
    };
  }

  _estimateWorkerPayloadBytes(formulas, data) {
    const formulaBytes = formulas.length * 64;
    const dataKeys = data ? Object.keys(data).length : 0;
    const dataBytes = dataKeys * 48;
    return formulaBytes + dataBytes;
  }

  // ───────── 内部辅助 ─────────

  _recordCalcStats(calcEngine, count, startTime) {
    calcEngine.stats.formulasEvaluated += count;
    calcEngine.stats.lastResultCount = count;
    calcEngine.stats.batches++;
    calcEngine.stats.lastDuration =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
      startTime;
  }

  _processWorkerQueue() {
    if (this._workerQueue.length === 0) return;

    const queued = [];
    while (this._workerQueue.length > 0) {
      queued.push(this._workerQueue.shift());
    }

    this.recalcAllWithWorker()
      .then((result) => {
        for (const { resolve } of queued) {
          resolve(result);
        }
      })
      .catch((error) => {
        for (const { reject } of queued) {
          reject(error);
        }
      });
  }

  clearCalcEngineDirty() {
    const calcEngine = this.d.getCalcEngine();
    if (!calcEngine) return;
    if (calcEngine.dirtyBitset) {
      calcEngine.dirtyBitset.clear();
    }
    if (calcEngine.batchTimeout) {
      clearTimeout(calcEngine.batchTimeout);
      calcEngine.batchTimeout = null;
    }
  }

  // ───────── WASM / 共享内存 ─────────

  _ensureSharedStore() {
    if (!this.sharedValueStore) {
      if (typeof SharedArrayBuffer === 'undefined') return null;
      this.sharedValueStore = new SharedValueStore(
        this._sharedRows,
        this._sharedCols
      );
      this.sharedValueStore.onGrow = (newRows, newBuffer, newCols) => {
        this.wasmBridge.rebindSharedMemory(newBuffer, newRows, newCols);
      };
    }
    return this.sharedValueStore;
  }

  /**
   * 初始化 WASM 计算引擎并绑定内存
   */
  async initWasm() {
    const success = await this.wasmBridge.init();
    if (!success) {
      this._emitWasmDowngrade(
        'WASM 引擎加载失败',
        'WASM 公式引擎未能加载，已降级为纯 JavaScript 计算。请确保构建产物已正确部署，或执行 "npm run build:wasm" 重新构建。',
        this.wasmBridge.getStatus()
      );
      return;
    }

    if (typeof SharedArrayBuffer !== 'undefined') {
      const sharedStore = this._ensureSharedStore();
      const sharedBuffer = sharedStore?.getBuffer();

      if (sharedBuffer) {
        this._sharedCols =
          sharedStore._continuousCols || sharedStore.maxCols;
        this._sharedRows = Math.floor(
          sharedBuffer.byteLength / (this._sharedCols * 8)
        );
        const sharedMemoryBound = this.wasmBridge.bindSharedMemory(
          sharedBuffer,
          this._sharedRows,
          this._sharedCols
        );
        if (!sharedMemoryBound) {
          console.warn(
            '[FormulaEngine] WASM loaded but shared memory not enabled:',
            this.wasmBridge.getStatus().fallbackReason
          );
          this._emitWasmDowngrade(
            '零拷贝内存未启用',
            'WASM 引擎已加载，但 SharedArrayBuffer 绑定失败。请检查服务端是否配置了 COOP/COEP 跨域隔离响应头。',
            this.wasmBridge.getStatus()
          );
        }
      }
    } else {
      this.wasmBridge.markSharedMemoryUnavailable(
        'SharedArrayBuffer is unavailable. Configure COOP/COEP headers.'
      );
      this._emitWasmDowngrade(
        'SharedArrayBuffer 不可用',
        '浏览器不支持 SharedArrayBuffer，已降级为普通数组传输模式。配置 COOP="same-origin" 和 COEP="require-corp" 响应头可启用零拷贝计算，提升性能。',
        this.wasmBridge.getStatus()
      );
    }
  }

  /**
   * 发送 WASM 降级事件（通过 deps.emit 通知 UI 层）
   * @param {string} title - 降级标题
   * @param {string} message - 用户可见的降级原因与引导
   * @param {Object} status - wasmBridge.getStatus() 返回的详细状态
   * @private
   */
  _emitWasmDowngrade(title, message, status) {
    try {
      this.d.emit(Events.WASM_DOWNGRADE, {
        title,
        message,
        status,
        severity: 'warning'
      });
    } catch (e) {
      // emit 失败时不应中断初始化流程
      console.warn('[FormulaEngine] Failed to emit WASM downgrade event:', e);
    }
  }

  // ───────── 析构 ─────────

  destroy() {
    // 清理 Worker
    if (this._workerManager) {
      this._workerManager.terminate();
      this._workerManager = null;
    }
    // reject 所有等待中的 worker 队列 Promise
    const err = new Error('FormulaEngineService destroyed');
    while (this._workerQueue.length > 0) {
      const { reject } = this._workerQueue.shift();
      reject(err);
    }
    this._workerQueue.clear();
    this._useWorker = false;

    // 清理共享存储
    if (this.sharedValueStore) {
      this.sharedValueStore.destroy?.();
      this.sharedValueStore = null;
    }
    this.wasmBridge.destroy();
  }
}
