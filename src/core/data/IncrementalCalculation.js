/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { DirtyBitset } from './DirtyBitset.js';
import { Events } from '../events/EventEmitter.js';
import { formulaCompiler } from './FormulaCompiler.js';
import { cellKey, cellKeyNumeric, decodeNumeric } from './CellKey.js';
import { wasmBridge } from '../worker/WasmBridge.js';

export class IncrementalCalculationEngine {
  constructor(workbook) {
    this.workbook = workbook;
    
    // 计算缓存
    this.calcCache = new Map();
    this.cacheVersion = 0;
    this.maxCacheSize = 10000;

    // 依赖图优化
    // colHint 来自 workbook，用于让 DirtyBitset 行初始字数按实际列数预留，避免扩容
    this.dirtyBitset = new DirtyBitset({ colHint: workbook && workbook.colCount });

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
    const wb = this.workbook;
    const queue = this._reusableQueue;
    const visited = this._reusableVisited;
    queue.length = 0;
    visited.clear();
    let newDirty = false;

    // 常驻 numeric 依赖索引（在 Workbook 写入点增量维护），无需每次重建
    const numericDepIndex = wb._numericDepIndex;

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

      const cell = wb._dataMatrix.get(r, c);
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

      if (wb.rangeDependencyIndex) {
        const rangeDependents = wb.rangeDependencyIndex.findDependents(r, c);
        for (const depId of rangeDependents) {
          const parsed = wb._parseKey(depId);
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
    const dispatchedToWorker = this._calculateBatch(queue);

    // Worker 路径不立即清空位图，等 Worker 完成后再清；主线程路径直接清
    if (!dispatchedToWorker) {
      this.dirtyBitset.clear();
    }
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
    const wb = this.workbook;
    const queue = this._reusableQueue;
    const visited = this._reusableVisited;
    const priorityMap = this._reusablePriorityMap;
    queue.length = 0;
    visited.clear();
    priorityMap.clear();

    // 常驻 numeric 依赖索引（在 Workbook 写入点增量维护），无需每次重建
    const numericDepIndex = wb._numericDepIndex;

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

      if (wb.rangeDependencyIndex && r >= 0 && c >= 0) {
        const rangeDependents = wb.rangeDependencyIndex.findDependents(r, c);
        for (const depId of rangeDependents) {
          const parsed = wb._parseKey(depId);
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
    const wb = this.workbook;
    const results = [];
    this.stats.batches++;
    this.stats.lastQueueSize = numericKeys.length;
    
    const uncachedNumeric = [];
    for (const nk of numericKeys) {
      const { r, c } = decodeNumeric(nk);
      const cell = wb._dataMatrix.get(r, c);
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

    if (uncachedNumeric.length > 0 && wb._useWorker && wb._workerManager && typeof wb._recalcDirtyWithWorker === 'function') {
      const uncachedIds = uncachedNumeric.map(nk => {
        const { r, c } = decodeNumeric(nk);
        return cellKey(r, c);
      });
      // 保存当前脏位图快照，Worker 完成后再清除
      const dirtySnapshotSize = this.dirtyBitset.size;
      this._workerBusy = true;
      wb._recalcDirtyWithWorker(uncachedIds)
        .then((workerResults) => {
          const workerResultList = Object.entries(workerResults || {}).map(([cellId, value]) => ({ cellId, value }));
          this.stats.formulasEvaluated += workerResultList.length;
          this.stats.lastResultCount = results.length + workerResultList.length;
          this.stats.lastDuration = this._now() - startTime;
          wb._emit(Events.FORMULAS_CALCULATED, {
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
          wb._emit(Events.FORMULAS_CALCULATED, { results, count: results.length, worker: false });
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
    wb._emit(Events.FORMULAS_CALCULATED, { results, count: results.length, worker: false });
    return false;
  }

   _calculateBatchOnMainThread(numericKeys, results) {
    const wb = this.workbook;
    
    if (wasmBridge.isLoaded) {
      const groupedTasks = new Map();
      const formulaCellMap = new Map();

      for (const nk of numericKeys) {
        const { r, c } = decodeNumeric(nk);
        const cell = wb._dataMatrix.get(r, c);
        
        if (cell && cell.f) {
          if (!cell._r1c1) {
            cell._r1c1 = '=' + formulaCompiler.toR1C1(cell.f, wb, r, c);
          }
          const f = cell._r1c1;
          
          if (!groupedTasks.has(f)) {
            groupedTasks.set(f, { rows: [], cols: [], ids: [] });
          }
          const group = groupedTasks.get(f);
          group.rows.push(r);
          group.cols.push(c);
          const cellId = cellKey(r, c);
          group.ids.push(cellId);
          formulaCellMap.set(cellId, { r, c, cell });
        }
      }

      if (groupedTasks.size > 0) {
        const nonNumericResults = wasmBridge.evaluateGroups(groupedTasks);
        
        if (nonNumericResults) {
          for (const [id, value] of Object.entries(nonNumericResults)) {
            const info = formulaCellMap.get(id);
            if (info) info.cell.v = value;
          }
        }
        
        for (const [cellId, info] of formulaCellMap.entries()) {
          const { cell } = info;
          cell.dirty = false;
          this.stats.formulasEvaluated++;
          
          if (wb.sharedValueStore) {
            let val = wb.getCellValue(info.r, info.c);
            if (typeof val === 'number' && isNaN(val)) {
              val = cell.v;
            }
            results.push({ cellId, value: val });
          } else {
            results.push({ cellId, value: cell.v });
          }
          
          this._cacheResult(info.r, info.c, cell.v, cell.f);
        }
        return;
      }
    }

    for (const nk of numericKeys) {
      const { r, c } = decodeNumeric(nk);
      const cell = wb._dataMatrix.get(r, c);
      
      if (cell && cell.f) {
        try {
          const value = wb.evaluateFormula(cell.f, r, c);
          cell.v = value;
          cell.dirty = false;
          this.stats.formulasEvaluated++;
          
          this._cacheResult(r, c, value, cell.f);
          
          const cellId = cellKey(r, c);
          results.push({ cellId, value });
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
   *
   * 公式写入时 `_updateDependencyMap` 已对同一公式调用 `getDependencies` 并把
   * `{cells, ranges}` 存入 `reverseDependencyMap`；这里直接复用该结果，避免对每次
   * cache miss 重复跑两遍正则与 `_refToRC` 解析（热路径上的正则/字符串分配大头）。
   *
   * 注意：必须浅克隆而非共享引用——`compactDependencyGraph` 会原地 `cells.delete`
   * 修改 `reverseDependencyMap` 中的 Set，若共享会破坏缓存快照导致 `_isCacheValid`
   * 漏检脏依赖。ranges 元素对象不会被原地修改，`slice` 浅拷贝即可。
   *
   * 反向依赖缺失（理论上公式单元格不会发生）时回退到完整解析。
   */
  _resolveDependencies(r, c, formula) {
    const wb = this.workbook;
    const reverse = wb.reverseDependencyMap.get(wb._cellKey(r, c));
    if (reverse && (reverse.cells || reverse.ranges)) {
      return {
        cells: reverse.cells ? new Set(reverse.cells) : new Set(),
        ranges: reverse.ranges ? reverse.ranges.slice() : []
      };
    }
    return wb.getDependencies(formula);
  }

  /**
   * 检查缓存是否有效
   */
  _isCacheValid(cached, r, c) {
    const cell = this.workbook._dataMatrix.get(r, c);
    if (!cell || cached.formula !== cell.f) {
      return false;
    }

    // 版本号快路径：自缓存上次校验/创建以来 DirtyBitset 未变更，则无新脏位能影响校验结果
    const currentVersion = this.dirtyBitset.version;
    if (cached.dirtyVersion === currentVersion) {
      return true;
    }

    if (this.dirtyBitset.has(r, c)) {
      return false;
    }

    // 检查依赖的单元格是否发生变化
    if (cached.dependencies && cached.dependencies.cells) {
      for (const depId of cached.dependencies.cells) {
        const { r: depR, c: depC } = this.workbook._parseKey(depId);

        // 核心修复：如果依赖项本身就在本次变更名单中，或者它是脏的公式，则缓存失效
        if (this.dirtyBitset.has(depR, depC)) {
          return false;
        }

        const depCell = this.workbook._dataMatrix.get(depR, depC);
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

    // 完整校验通过，记录当前版本号供下次快路径使用
    cached.dirtyVersion = currentVersion;
    return true;
  }
  
  /**
   * 压缩依赖图（清理无效的依赖关系，可重入）
   *
   * 长会话中公式被反复增删时，workbook 的 dependencyMap / reverseDependencyMap
   * 会累积指向已不存在公式的孤儿条目。本方法按需扫描清理，
   * 由 _maybeScheduleCompact 节流触发，也可显式调用。
   */
  compactDependencyGraph() {
    const wb = this.workbook;
    const depMap = wb.dependencyMap;
    const reverseDepMap = wb.reverseDependencyMap;
    if (!depMap) return;

    // 移除不存在的单元格的依赖
    for (const [srcId, dependents] of depMap) {
      const { r, c } = wb._parseKey(srcId);
      const cell = wb._dataMatrix.get(r, c);

      if (!cell || !cell.f) {
        // 单元格不存在或不是公式，清理依赖
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
        // 同步清理常驻 numeric 索引中该源的整条出边
        if (typeof wb._dropNumericDepSource === 'function') {
          wb._dropNumericDepSource(srcId);
        }
      }
    }
  }

  /**
   * 重置计算引擎状态
   */
  reset() {
    this.clearCache();
    this.dirtyBitset.clear();
    this.resetStats();
    this._batchesSinceCompact = 0;
    this._cancelScheduledCompact();
  }
  
  /**
   * 清空缓存
   */
  clearCache() {
    this.calcCache.clear();
    this.cacheVersion++;
  }
  
  /**
   * 获取缓存统计
   */
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
