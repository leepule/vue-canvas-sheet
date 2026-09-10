/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { DirtyBitset } from './DirtyBitset.js';
import { Events } from '../events/EventEmitter.js';
import { cellKey, cellKeyNumeric, decodeNumeric } from './CellKey.js';

export class IncrementalCalculationEngine {
  /**
   * @param {{
   *   getColCount: () => number,
   *   getDataMatrix: () => Object,
   *   parseKey: (k: string|number) => {r:number,c:number},
   *   cellKey: (r: number, c: number) => string,
   *   getNumericDepIndex: () => Map<number, Set<number>>,
   *   getDependencyMap: () => Map,
   *   getReverseDependencyMap: () => Map,
   *   getRangeDependencyIndex: () => Object,
   *   dropNumericDepSource: (src: string) => void,
   *   evaluateFormula: (formula: string, r: number, c: number, stack?: string[]) => any,
   *   checkCycle: (r: number, c: number, cache?: Set) => boolean,
   *   syncSharedValue: (r: number, c: number, v: any) => void,
   *   emit: (event: string, payload: object) => void,
   *   isWorkerEnabled: () => boolean,
   *   getWorkerManager: () => any,
   *   recalcDirtyWithWorker: (cellIds: string[]) => Promise<object>,
   * }} deps
   */
  constructor(deps) {
    /** @type {Object} */
    this.d = deps;

    // 计算缓存
    this.calcCache = new Map();
    this.cacheVersion = 0;
    this.maxCacheSize = 10000;

    // 依赖图优化
    // colHint 来自 workbook，用于让 DirtyBitset 行初始字数按实际列数预留，避免扩容
    this.dirtyBitset = new DirtyBitset({ colHint: deps && deps.getColCount() });

    // 依赖图压缩节流：每累计 N 个批次调度一次孤儿条目清理，避免长会话累积
    this._compactBatchInterval = 32;
    this._batchesSinceCompact = 0;
    this._compactIdleHandle = null;

    this.batchTimeout = null;
    this.batchDelay = 16;  // 16ms批量延迟
    this._workerBusy = false;

    // 可复用集合，避免频繁分配 GC 压力
    this._reusableQueue = [];
    this._reusableVisited = new Set();
    this._reusablePriorityMap = new Map();

    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      formulasEvaluated: 0,
      formulasSkipped: 0,
      batches: 0,
      lastDuration: 0,
      lastQueueSize: 0,
      lastDirtyCount: 0,
      lastResultCount: 0,
      lastWorkerFormulaCount: 0,
      lastWorkerPayloadCells: 0,
      lastWorkerPayloadBytes: 0
    };
  }

  /**
   * 标记单元格为脏（优化版本：使用位图）
   */
  markDirtyRC(r, c) {
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0) return;

    const newDirty = this._markDirtyGraphNumeric([cellKeyNumeric(r, c)]);
    if (newDirty) {
      this._scheduleBatchCalc();
    }
  }

  _markDirtyGraphNumeric(numericKeys) {
    const d = this.d;
    const queue = this._reusableQueue;
    const visited = this._reusableVisited;
    queue.length = 0;
    visited.clear();
    let newDirty = false;

    // 常驻 numeric 依赖索引（在 Workbook 写入点增量维护），无需每次重建
    const numericDepIndex = d.getNumericDepIndex();
    const dataMatrix = d.getDataMatrix();
    const rangeDependencyIndex = d.getRangeDependencyIndex();

    const enqueue = (nk) => {
      if (visited.has(nk)) return;
      visited.add(nk);
      queue.push(nk);
    };

    for (const nk of numericKeys) {
      enqueue(nk);
    }

    let head = 0;
    while (head < queue.length) {
      const nk = queue[head++];
      const { r, c } = decodeNumeric(nk);

      if (this.dirtyBitset.add(r, c)) {
        newDirty = true;
      }

      const cell = dataMatrix.get(r, c);
      if (cell && cell.f) {
        cell.dirty = true;
      }

      // O(1) 数字键查找，无字符串分配
      const directDependents = numericDepIndex.get(nk);
      if (directDependents) {
        for (const depNk of directDependents) {
          enqueue(depNk);
        }
      }

      if (rangeDependencyIndex) {
        const rangeDependents = rangeDependencyIndex.findDependents(r, c);
        for (const depId of rangeDependents) {
          const parsed = d.parseKey(depId);
          if (Number.isFinite(parsed.r) && Number.isFinite(parsed.c) && parsed.r >= 0 && parsed.c >= 0) {
            enqueue(cellKeyNumeric(parsed.r, parsed.c));
          }
        }
      }
    }

    return newDirty;
  }

  /**
   * 调度批量计算
   */
  _scheduleBatchCalc() {
    if (this.batchTimeout || this._workerBusy) return;

    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null;
      this._processDirtyCells();
    }, this.batchDelay);
  }

  /**
   * 处理脏单元格（优化版本：基于位图遍历）
   */
  _processDirtyCells() {
    if (this.dirtyBitset.size === 0) return;

    const dirtyCount = this.dirtyBitset.size;
    const { queue } = this._collectDirtyGraph();

    // 批量计算
    this._calculateBatch(queue);

    // 无论是否分发到 Worker，我们都直接清空位图。
    // 如果有并发编辑，新标记的脏单元格又会被加入位图，并在 Worker 完成后重新执行重算。
    this.dirtyBitset.clear();
    this.stats.lastDirtyCount = dirtyCount;

    // 累计批次到阈值后，调度依赖图压缩（清理公式删改产生的孤儿反向依赖）
    this._maybeScheduleCompact();
  }

  /**
   * 节流调度依赖图压缩：达到批次阈值且无未触发任务时，推迟到空闲时段执行
   */
  _maybeScheduleCompact() {
    this._batchesSinceCompact++;
    if (this._batchesSinceCompact < this._compactBatchInterval) return;
    if (this._compactIdleHandle !== null) return;

    const useIdle = typeof requestIdleCallback === 'function';
    const schedule = useIdle
      ? (cb) => requestIdleCallback(cb, { timeout: 1000 })
      : (cb) => setTimeout(cb, 0);

    this._compactIdleHandle = schedule(() => {
      this._compactIdleHandle = null;
      this._batchesSinceCompact = 0;
      this.compactDependencyGraph();
    });
  }

  _cancelScheduledCompact() {
    if (this._compactIdleHandle === null) return;
    const useIdle = typeof cancelIdleCallback === 'function';
    if (useIdle) {
      cancelIdleCallback(this._compactIdleHandle);
    } else {
      clearTimeout(this._compactIdleHandle);
    }
    this._compactIdleHandle = null;
  }

  _collectDirtyGraph() {
    const d = this.d;
    const queue = this._reusableQueue;
    const visited = this._reusableVisited;
    const priorityMap = this._reusablePriorityMap;
    queue.length = 0;
    visited.clear();
    priorityMap.clear();

    // 常驻 numeric 依赖索引（在 Workbook 写入点增量维护），无需每次重建
    const numericDepIndex = d.getNumericDepIndex();
    const rangeDependencyIndex = d.getRangeDependencyIndex();

    const enqueue = (nk, priority) => {
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push(nk);
        priorityMap.set(nk, priority);
        return;
      }

      const existingPriority = priorityMap.get(nk);
      if (priority < existingPriority) {
        priorityMap.set(nk, priority);
      }
    };

    this.dirtyBitset.forEach((r, c) => {
      enqueue(cellKeyNumeric(r, c), 0);
    });

    let head = 0;
    while (head < queue.length) {
      const nk = queue[head++];
      const currentPriority = priorityMap.get(nk);
      const { r, c } = decodeNumeric(nk);

      // O(1) 数字键查找，无字符串分配
      const directDependents = numericDepIndex.get(nk);
      if (directDependents) {
        for (const depNk of directDependents) {
          enqueue(depNk, currentPriority + 1);
        }
      }

      if (rangeDependencyIndex && r >= 0 && c >= 0) {
        const rangeDependents = rangeDependencyIndex.findDependents(r, c);
        for (const depId of rangeDependents) {
          const parsed = d.parseKey(depId);
          if (Number.isFinite(parsed.r) && Number.isFinite(parsed.c) && parsed.r >= 0 && parsed.c >= 0) {
            enqueue(cellKeyNumeric(parsed.r, parsed.c), currentPriority + 1);
          }
        }
      }
    }

    queue.sort((a, b) => priorityMap.get(a) - priorityMap.get(b));
    return { queue, priorityMap };
  }

  /**
   * 批量计算（带缓存）
   */
  _calculateBatch(numericKeys) {
    const startTime = this._now();
    const d = this.d;
    const dataMatrix = d.getDataMatrix();
    const results = [];
    this.stats.batches++;
    this.stats.lastQueueSize = numericKeys.length;

    const uncachedNumeric = [];
    for (const nk of numericKeys) {
      const { r, c } = decodeNumeric(nk);
      const cell = dataMatrix.get(r, c);
      if (!cell || !cell.f) {
        this.stats.formulasSkipped++;
        continue;
      }

      const cacheKey = this._getCacheKey(r, c);

      if (this.calcCache.has(cacheKey)) {
        const cached = this.calcCache.get(cacheKey);
        if (this._isCacheValid(cached, r, c)) {
          this.calcCache.delete(cacheKey);
          this.calcCache.set(cacheKey, cached);
          const cellId = cellKey(r, c);
          results.push({ cellId, value: cached.value });
          cell.v = cached.value;
          cell.dirty = false;
          this.stats.cacheHits++;
          continue;
        }
      }

      this.stats.cacheMisses++;
      uncachedNumeric.push(nk);
    }

    if (uncachedNumeric.length > 0 && d.isWorkerEnabled() && d.getWorkerManager() && typeof d.recalcDirtyWithWorker === 'function') {
      const uncachedIds = uncachedNumeric.map(nk => {
        const { r, c } = decodeNumeric(nk);
        return cellKey(r, c);
      });
      this._workerBusy = true;
      d.recalcDirtyWithWorker(uncachedIds)
        .then((workerResults) => {
          const workerResultList = Object.entries(workerResults || {}).map(([cellId, value]) => ({ cellId, value }));
          this.stats.formulasEvaluated += workerResultList.length;
          this.stats.lastResultCount = results.length + workerResultList.length;
          this.stats.lastDuration = this._now() - startTime;
          d.emit(Events.FORMULAS_CALCULATED, {
            results: results.concat(workerResultList),
            count: results.length + workerResultList.length,
            worker: true
          });
          this._workerBusy = false;
          // 检查是否有新增脏单元格需要处理
          if (this.dirtyBitset.size > 0) {
            this._scheduleBatchCalc();
          }
        })
        .catch(() => {
          this._calculateBatchOnMainThread(uncachedNumeric, results);
          this.stats.lastResultCount = results.length;
          this.stats.lastDuration = this._now() - startTime;
          d.emit(Events.FORMULAS_CALCULATED, { results, count: results.length, worker: false });
          this._workerBusy = false;
          if (this.dirtyBitset.size > 0) {
            this._scheduleBatchCalc();
          }
        });
      return true;
    }

    this._calculateBatchOnMainThread(uncachedNumeric, results);
    this.stats.lastResultCount = results.length;
    this.stats.lastDuration = this._now() - startTime;
    d.emit(Events.FORMULAS_CALCULATED, { results, count: results.length, worker: false });
    return false;
  }

  /**
   * 主线程批量计算（增量路径）。
   *
   * 关键修复：增量重算路径不再使用 WASM evaluateGroups()。
   * WASM 引擎只能读取 SharedArrayBuffer 中的 Float64 数值，对文本单元格
   * （如 CONCAT 引用的字符串值）或错误值（#CYCLE! 等），WASM 会将
   * EMPTY_VALUE (-Infinity) 转为 0.0，导致计算结果错误。
   *
   * 增量重算仅涉及少量脏单元格，主线程 JS 求值性能完全足够。
   * WASM 的 evaluateGroups() 仅在全量重算且整批公式均命中
   * WasmFormulaSupport 支持矩阵时使用。
   */
   _calculateBatchOnMainThread(numericKeys, results) {
    const d = this.d;
    const dataMatrix = d.getDataMatrix();
    // 批次级记忆化缓存：已确认无环的单元格集合。
    // 避免每个待重算单元格独立发起全向 DFS，将环检测总体复杂度从 O(N·(V+E)) 降至 O(V+E)。
    const cycleFreeCache = new Set();

    for (const nk of numericKeys) {
      const { r, c } = decodeNumeric(nk);
      const cell = dataMatrix.get(r, c);

      if (cell && cell.f) {
        // 环检测：防止自引用（E9=E9）或间接环引用，传入批次缓存以复用 DFS 结果
        if (d.checkCycle(r, c, cycleFreeCache)) {
          console.log('[DEBUG] Main thread cycle detected via IncrementalCalculation at:', r, c);
          cell.v = '#CYCLE!';
          cell.dirty = false;
          // 必须显式清空共享内存，否则 getCellValue 渲染热路径可能读取到残留数值
          d.syncSharedValue(r, c, '#CYCLE!');
          const cellId = cellKey(r, c);
          results.push({ cellId, value: '#CYCLE!' });
          this._cacheResult(r, c, '#CYCLE!', cell.f);
          continue;
        }

        try {
          // 统一使用 JS RPN 求值器：正确支持数值/文本/逻辑/日期函数及错误传播
          const value = d.evaluateFormula(cell.f, r, c);
          cell.v = value;
          cell.dirty = false;
          // 同步到共享内存（数值直接写入，非数值清空为 EMPTY_VALUE）
          d.syncSharedValue(r, c, value);
          this.stats.formulasEvaluated++;
          const cellId = cellKey(r, c);
          results.push({ cellId, value });
          this._cacheResult(r, c, value, cell.f);
        } catch (error) {
          const cellId = cellKey(r, c);
          results.push({ cellId, error });
        }
      }
    }
  }

  /**
   * 获取缓存键（数字键，避免字符串分配）
   * 使用 r * 1000000 + c 编码，支持最大 100 万列
   */
  _getCacheKey(r, c) {
    return r * 1000000 + c;
  }

  /**
   * 缓存计算结果
   */
  _cacheResult(r, c, value, formula) {
    if (this.calcCache.size >= this.maxCacheSize) {
      // LRU 淘汰：Map 按插入序迭代，命中时已在 _calculateBatch 中重新插入，
      // 所以 keys().next().value 就是最久未使用的 key
      const oldestKey = this.calcCache.keys().next().value;
      this.calcCache.delete(oldestKey);
    }

    const cacheKey = this._getCacheKey(r, c);

    this.calcCache.set(cacheKey, {
      value,
      formula,
      dependencies: this._resolveDependencies(r, c, formula),
      timestamp: Date.now(),
      // 记录创建时的 DirtyBitset 版本号，用于快速校验
      dirtyVersion: this.dirtyBitset.version
    });
  }

  /**
   * 解析公式依赖供缓存使用。
   */
  _resolveDependencies(r, c, formula) {
    const d = this.d;
    const cellId = d.cellKey(r, c);
    const reverseMap = d.getReverseDependencyMap();
    const reverse = reverseMap.get(cellId);
    if (reverse && (reverse.cells || reverse.ranges)) {
      return {
        cells: reverse.cells ? new Set(reverse.cells) : new Set(),
        ranges: reverse.ranges ? reverse.ranges.slice() : []
      };
    }
    // 反向依赖缺失时回退到公式解析
    if (d.getDependencies) {
      return d.getDependencies(formula);
    }
    return { cells: new Set(), ranges: [] };
  }

  /**
   * 检查缓存是否有效
   */
  _isCacheValid(cached, r, c) {
    const d = this.d;
    const dataMatrix = d.getDataMatrix();
    const cell = dataMatrix.get(r, c);
    if (!cell || cached.formula !== cell.f) {
      return false;
    }

    const currentVersion = this.dirtyBitset.version;
    if (cached.dirtyVersion === currentVersion) {
      return true;
    }

    if (this.dirtyBitset.has(r, c)) {
      return false;
    }

    if (cached.dependencies && cached.dependencies.cells) {
      for (const depId of cached.dependencies.cells) {
        const { r: depR, c: depC } = d.parseKey(depId);

        if (this.dirtyBitset.has(depR, depC)) {
          return false;
        }

        const depCell = dataMatrix.get(depR, depC);
        if (depCell && depCell.dirty) {
          return false;
        }
      }
    }

    if (cached.dependencies && cached.dependencies.ranges) {
      for (const range of cached.dependencies.ranges) {
        if (this.dirtyBitset.hasAnyInRange(range.startR, range.endR, range.startC, range.endC)) {
          return false;
        }
      }
    }

    cached.dirtyVersion = currentVersion;
    return true;
  }

  /**
   * 压缩依赖图（清理无效的依赖关系，可重入）
   */
  compactDependencyGraph() {
    const d = this.d;
    const depMap = d.getDependencyMap();
    const reverseDepMap = d.getReverseDependencyMap();
    if (!depMap) return;

    const dataMatrix = d.getDataMatrix();

    for (const [srcId, dependents] of depMap) {
      const { r, c } = d.parseKey(srcId);
      const cell = dataMatrix.get(r, c);

      if (!cell || !cell.f) {
        for (const depId of dependents) {
          const revDeps = reverseDepMap.get(depId);
          if (revDeps) {
            if (revDeps instanceof Set) {
              revDeps.delete(srcId);
              if (revDeps.size === 0) {
                reverseDepMap.delete(depId);
              }
            } else if (revDeps.cells) {
              revDeps.cells.delete(srcId);
              if (revDeps.cells.size === 0 && (!revDeps.ranges || revDeps.ranges.length === 0)) {
                reverseDepMap.delete(depId);
              }
            } else {
              reverseDepMap.delete(depId);
            }
          }
        }
        depMap.delete(srcId);
        if (d.dropNumericDepSource) {
          d.dropNumericDepSource(srcId);
        }
      }
    }
  }

  reset() {
    this.clearCache();
    this.dirtyBitset.clear();
    this.resetStats();
    this._batchesSinceCompact = 0;
    this._cancelScheduledCompact();
  }

  clearCache() {
    this.calcCache.clear();
    this.cacheVersion++;
  }

  getCacheStats() {
    return {
      size: this.calcCache.size,
      version: this.cacheVersion,
      hitRate: this._calculateHitRate(),
      ...this.stats
    };
  }

  _calculateHitRate() {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    return total === 0 ? 0 : this.stats.cacheHits / total;
  }

  resetStats() {
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.stats.formulasEvaluated = 0;
    this.stats.formulasSkipped = 0;
    this.stats.batches = 0;
    this.stats.lastDuration = 0;
    this.stats.lastQueueSize = 0;
    this.stats.lastDirtyCount = 0;
    this.stats.lastResultCount = 0;
    this.stats.lastWorkerFormulaCount = 0;
    this.stats.lastWorkerPayloadCells = 0;
    this.stats.lastWorkerPayloadBytes = 0;
  }

  recordWorkerPayloadStats(stats = {}) {
    this.stats.lastWorkerFormulaCount = stats.formulaCount || 0;
    this.stats.lastWorkerPayloadCells = stats.cellCount || 0;
    this.stats.lastWorkerPayloadBytes = stats.estimatedBytes || 0;
  }

  _now() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  destroy() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    this._cancelScheduledCompact();
    this.clearCache();
  }
}
