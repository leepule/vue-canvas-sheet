/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 公式求值器 — 从 Workbook.js 提取出的 JS 公式求值、依赖管理和全量/增量重算逻辑。
 *
 * 通过 deps 注入模式解耦，使 Workbook 不再承载 ~700 行的公式求值实现。
 *
 * @typedef {Object} FormulaEvaluatorDeps
 * @property {() => SparseMatrix}     getDataMatrix
 * @property {(r:number,c:number) => string} cellKey
 * @property {(k:string) => {r:number,c:number}} parseKey
 * @property {() => Map}              getDependencyMap
 * @property {() => Map}              getReverseDependencyMap
 * @property {() => RangeDependencyIndex} getRangeDependencyIndex
 * @property {() => Map<number, Set<number>>} getNumericDepIndex
 * @property {() => Object}           getWasmBridge
 * @property {() => SharedValueStore} getSharedValueStore
 * @property {(r:number,c:number,v:number) => void} syncSharedValue
 * @property {() => IncrementalCalculationEngine} getCalcEngine
 * @property {(e:string, p:Object) => void} emit
 * @property {(d:*) => void}         notify
 * @property {ErrorHandler}           errorHandler
 * @property {() => PerformanceMonitor} getPerformanceMonitor
 * @property {() => number}           getRowCount
 * @property {() => number}           getColCount
 * @property {(r:number,c:number) => Cell} getCell
 * @property {(r:number,c:number,cell:*) => void} setCellData
 * @property {(r:number,c:number) => void} markCellChanged
 */

import { SheetError, ErrorCodes } from './SheetError.js';
import { formulaCompiler } from './FormulaCompiler.js';
import { FormulaRPNEvaluator } from './FormulaRPNEvaluator.js';
import { isWasmFormulaSupported } from './WasmFormulaSupport.js';
import { cellKeyNumeric, parseCellKey } from './CellKey.js';
import { colStrToIndex } from '../utils/CellUtils.js';
import { MetricTypes } from '../utils/PerformanceMonitor.js';

const MAX_FORMULA_ROWS = 1048576;
const MAX_FORMULA_COLS = 16384;
const MAX_INLINE_RANGE_SNAPSHOT_CELLS = 5000;

// 公式依赖提取正则
const DEP_RANGE_REGEX = /\$?(?:[A-Z]+\$?[0-9]+|[A-Z]+|[0-9]+):\$?(?:[A-Z]+\$?[0-9]+|[A-Z]+|[0-9]+)/g;
const DEP_CELL_REGEX = /\$?[A-Z]+\$?[0-9]+/g;

export class FormulaEvaluator {
  /**
   * @param {FormulaEvaluatorDeps} deps
   */
  constructor(deps) {
    this.d = deps;
    /** @type {Array} 当前公式求值栈 */
    this._currentStack = null;
    /** @type {FormulaRPNEvaluator|null} 共享 RPN 求值器（延迟初始化） */
    this._rpnEvaluator = null;
  }

  // ═══════════════════════════════════════════════════════════
  // 辅助方法：引用解析
  // ═══════════════════════════════════════════════════════════

  _colStrToIndex(str) { return colStrToIndex(str); }

  _rcToA1(r, c) {
    return this._indexToColStr(c) + (r + 1);
  }

  _indexToColStr(index) {
    let str = '';
    while (index >= 0) {
      str = String.fromCharCode((index % 26) + 65) + str;
      index = Math.floor(index / 26) - 1;
    }
    return str;
  }

  _cellKey(r, c) { return this.d.cellKey(r, c); }
  _parseKey(key) { return this.d.parseKey(key); }

  _refToRC(ref) {
    let letter = '';
    let numStr = '';
    for (let i = 0; i < ref.length; i++) {
      const char = ref[i];
      if (char >= 'A' && char <= 'Z') letter += char;
      else if (char >= '0' && char <= '9') numStr += char;
    }
    const c = this._colStrToIndex(letter);
    const r = parseInt(numStr, 10) - 1;
    return { r, c };
  }

  _rangeToRC(range) {
    const parts = range.split(':');
    return {
      start: this._refToRC(parts[0]),
      end: this._refToRC(parts[1])
    };
  }

  _normalizeFormulaRef(ref) {
    return String(ref || '').replace(/\$/g, '').toUpperCase();
  }

  _rangeRefToBounds(ref) {
    const clean = this._normalizeFormulaRef(ref);
    const parts = clean.split(':');
    if (parts.length !== 2) return null;

    const left = parts[0];
    const right = parts[1];
    const cellPattern = /^[A-Z]+[0-9]+$/;
    const colPattern = /^[A-Z]+$/;
    const rowPattern = /^[0-9]+$/;

    if (cellPattern.test(left) && cellPattern.test(right)) {
      const start = this._refToRC(left);
      const end = this._refToRC(right);
      return {
        startR: Math.min(start.r, end.r),
        endR: Math.max(start.r, end.r),
        startC: Math.min(start.c, end.c),
        endC: Math.max(start.c, end.c)
      };
    }
    if (colPattern.test(left) && colPattern.test(right)) {
      const startC = this._colStrToIndex(left);
      const endC = this._colStrToIndex(right);
      return {
        startR: 0, endR: MAX_FORMULA_ROWS - 1,
        startC: Math.min(startC, endC),
        endC: Math.max(startC, endC)
      };
    }
    if (rowPattern.test(left) && rowPattern.test(right)) {
      const startR = parseInt(left, 10) - 1;
      const endR = parseInt(right, 10) - 1;
      return {
        startR: Math.min(startR, endR),
        endR: Math.max(startR, endR),
        startC: 0, endC: MAX_FORMULA_COLS - 1
      };
    }
    return null;
  }

  _isCellInsideRange(r, c, range) {
    return r >= range.startR && r <= range.endR && c >= range.startC && c <= range.endC;
  }

  // ═══════════════════════════════════════════════════════════
  // 依赖图管理
  // ═══════════════════════════════════════════════════════════

  getDependencies(formula) {
    if (!formula || !formula.startsWith('=')) return { cells: new Set(), ranges: [] };
    const expression = formula.substring(1).toUpperCase();

    const cells = new Set();
    const ranges = [];
    const coveredRanges = [];

    DEP_RANGE_REGEX.lastIndex = 0;
    DEP_CELL_REGEX.lastIndex = 0;

    let match;
    while ((match = DEP_RANGE_REGEX.exec(expression)) !== null) {
      const range = this._rangeRefToBounds(match[0]);
      if (range) { ranges.push(range); coveredRanges.push(range); }
    }
    while ((match = DEP_CELL_REGEX.exec(expression)) !== null) {
      const { r, c } = this._refToRC(match[0]);
      if (coveredRanges.some(range => this._isCellInsideRange(r, c, range))) continue;
      cells.add(this._cellKey(r, c));
    }
    const result = { cells, ranges };
    Object.defineProperty(result, 'size', {
      enumerable: false,
      get() {
        return cells.size + ranges.reduce((total, range) =>
          total + ((range.endR - range.startR + 1) * (range.endC - range.startC + 1)), 0);
      }
    });
    return result;
  }

  _updateDependencyMap(cellId, formula) {
    const revMap = this.d.getReverseDependencyMap();
    const depMap = this.d.getDependencyMap();
    const rangeIdx = this.d.getRangeDependencyIndex();

    const oldDeps = revMap.get(cellId);
    if (oldDeps) {
      if (oldDeps.cells) {
        oldDeps.cells.forEach(srcId => {
          const deps = depMap.get(srcId);
          if (deps) deps.delete(cellId);
          this._removeNumericDep(srcId, cellId);
        });
      }
      if (oldDeps.ranges && oldDeps.ranges.length > 0 && rangeIdx) {
        rangeIdx.remove(cellId);
      }
      revMap.delete(cellId);
    }
    if (!formula) return;

    const { cells, ranges } = this.getDependencies(formula);
    cells.forEach(srcId => {
      if (!depMap.has(srcId)) depMap.set(srcId, new Set());
      depMap.get(srcId).add(cellId);
      this._addNumericDep(srcId, cellId);
    });
    if (rangeIdx) {
      ranges.forEach(range => rangeIdx.add(range, cellId));
    }
    revMap.set(cellId, { cells, ranges });
  }

  _numericKeyFromId(id) {
    const { r, c } = parseCellKey(id);
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r > 0xFFFF || c > 0xFFFF) return -1;
    return cellKeyNumeric(r, c);
  }

  _addNumericDep(srcId, dependentId) {
    const idx = this.d.getNumericDepIndex();
    const srcNk = this._numericKeyFromId(srcId);
    const depNk = this._numericKeyFromId(dependentId);
    if (srcNk < 0 || depNk < 0) return;
    let set = idx.get(srcNk);
    if (!set) { set = new Set(); idx.set(srcNk, set); }
    set.add(depNk);
  }

  _removeNumericDep(srcId, dependentId) {
    const idx = this.d.getNumericDepIndex();
    const srcNk = this._numericKeyFromId(srcId);
    if (srcNk < 0) return;
    const set = idx.get(srcNk);
    if (!set) return;
    set.delete(this._numericKeyFromId(dependentId));
    if (set.size === 0) idx.delete(srcNk);
  }

  _dropNumericDepSource(srcId) {
    const idx = this.d.getNumericDepIndex();
    const srcNk = this._numericKeyFromId(srcId);
    if (srcNk < 0) return;
    idx.delete(srcNk);
  }

  _clearDependencyGraph() {
    this.d.getDependencyMap().clear();
    this.d.getReverseDependencyMap().clear();
    this.d.getNumericDepIndex().clear();
    const rangeIdx = this.d.getRangeDependencyIndex();
    if (rangeIdx) rangeIdx.clear();
  }

  rebuildDependencyMap() {
    this._clearDependencyGraph();
    const dataMatrix = this.d.getDataMatrix();
    dataMatrix.forEach((r, c, cell) => {
      if (cell && cell.f) {
        this._updateDependencyMap(this._cellKey(r, c), cell.f);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 单元格值获取
  // ═══════════════════════════════════════════════════════════

  getCellValue(r, c, stack = []) {
    const cell = this.d.getCell(r, c);
    if (!cell) return null;

    const sharedStore = this.d.getSharedValueStore();
    if (cell.f && sharedStore) {
      const sharedVal = sharedStore.get(r, c);
      if (sharedVal !== -Infinity) return sharedVal;
    }
    if (cell.f && (cell.dirty || cell.v === undefined)) {
      return this.evaluateFormula(cell.f, r, c, stack);
    }
    return cell.v;
  }

  _getFormulaArgumentValue(arg, stack = []) {
    const cleaned = this._normalizeFormulaRef(arg);
    if (/^[A-Z]+[0-9]+$/.test(cleaned)) {
      const { r, c } = this._refToRC(cleaned);
      return this.getCellValue(r, c, stack);
    }
    const numeric = Number(cleaned);
    return Number.isNaN(numeric) ? 0 : numeric;
  }

  _getFormulaRangeValues(rangeRef, stack = []) {
    const range = this._rangeRefToBounds(rangeRef);
    if (!range) return [];

    const values = [];
    const size = (range.endR - range.startR + 1) * (range.endC - range.startC + 1);
    const dataMatrix = this.d.getDataMatrix();

    if (size > MAX_INLINE_RANGE_SNAPSHOT_CELLS) {
      dataMatrix.iterateRange(range.startR, range.startC, range.endR, range.endC, (r, c) => {
        values.push(this.getCellValue(r, c, stack));
      });
      return values;
    }
    for (let r = range.startR; r <= range.endR; r++) {
      for (let c = range.startC; c <= range.endC; c++) {
        values.push(this.getCellValue(r, c, stack));
      }
    }
    return values;
  }

  // ═══════════════════════════════════════════════════════════
  // 公式求值
  // ═══════════════════════════════════════════════════════════

  /**
   * 环引用检测（DFS）。
   *
   * @param {number} r 行号
   * @param {number} c 列号
   * @param {Set<string>} [cycleFreeCache] 批次级记忆化缓存 — 已确认无环的 cellKey 集合。
   *   在增量批量重算中传入共享的 Set，可避免每个单元格独立发起全向 DFS，
   *   将总体复杂度从 O(N·(V+E)) 降至 O(V+E)。
   * @returns {boolean} 是否存在环引用
   */
  checkCycle(r, c, cycleFreeCache = null) {
    const startId = this._cellKey(r, c);

    // 快路径：批次级缓存已确认该单元格无环
    if (cycleFreeCache && cycleFreeCache.has(startId)) {
      return false;
    }

    const stack = new Set(); // 当前 DFS 路径上的节点（用于检测回边）

    const dfs = (cellId) => {
      // 回边 → 检测到环
      if (stack.has(cellId)) return true;
      // 批次级缓存命中 → 该节点及其所有传递依赖已确认无环
      if (cycleFreeCache && cycleFreeCache.has(cellId)) return false;

      stack.add(cellId);

      const deps = this.d.getReverseDependencyMap().get(cellId);
      if (deps) {
        if (deps.cells) {
          for (const depId of deps.cells) {
            if (dfs(depId)) return true;
          }
        }
        if (deps.ranges) {
          for (const range of deps.ranges) {
            for (let i = range.startR; i <= range.endR; i++) {
              for (let j = range.startC; j <= range.endC; j++) {
                const key = this._cellKey(i, j);
                if (this.d.getReverseDependencyMap().has(key)) {
                  if (dfs(key)) return true;
                }
              }
            }
          }
        }
      }

      stack.delete(cellId);

      // 该节点及其所有传递依赖均无环 → 记入批次缓存，后续其他单元格可直接跳过
      if (cycleFreeCache) {
        cycleFreeCache.add(cellId);
      }

      return false;
    };

    const res = dfs(startId);
    return res;
  }

  evaluateFormula(formula, r, c, stack = []) {
    const perfMonitor = this.d.getPerformanceMonitor();
    return perfMonitor.measure(MetricTypes.FORMULA_EVAL, () => {
      const res = this._evaluateFormulaInternal(formula, r, c, stack);
      return (typeof res === 'number' && isNaN(res)) ? '#VALUE!' : res;
    }, { formula: formula.substring(0, 50) });
  }

  _evaluateFormulaInternal(formula, r, c, stack = []) {
    const cellId = this._cellKey(r, c);
    if (stack.includes(cellId)) {
      const error = SheetError.circularReference(this._rcToA1(r, c));
      this.d.errorHandler.handle(error, { formula, r, c });
      return error.toExcelValue();
    }
    if (!formula.startsWith('=')) return formula;

    try {
      const newStack = [...stack, cellId];

      // 单次求值必须遵循完整 JS 语义；WASM 批量路径由
      // WasmFormulaSupport 的保守支持矩阵单独控制。
      return this._evaluateFormulaJs(formula, r, c, newStack);
    } catch (e) {
      const error = e instanceof SheetError ? e : this.d.errorHandler.handle(e, { formula, r, c });
      return error.toExcelValue();
    }
  }

  /**
   * 延迟初始化共享 RPN 求值器，桥接主线程的 getCellValue 方法。
   * 替代原先 FormulaCompiler + new Function 的动态编译路径，
   * 与 Worker 端共享同一套 RPN 引擎，消除双轨实现导致的计算偏差。
   */
  _ensureRpnEvaluator() {
    if (this._rpnEvaluator) return;
    const self = this;
    this._rpnEvaluator = new FormulaRPNEvaluator({
      getCellValue: (r, c, stack) => self.getCellValue(r, c, stack)
    });
  }

  _evaluateFormulaJs(formula, r, c, stack = []) {
    this._ensureRpnEvaluator();
    this._currentStack = stack;
    return this._rpnEvaluator.evaluate(formula, { stack });
  }

  // ═══════════════════════════════════════════════════════════
  // 全量 / 增量重算
  // ═══════════════════════════════════════════════════════════

  triggerRecalc(r, c) {
    this.d.markCellChanged(r, c);
  }

  _recordCalcStats(count, startTime) {
    const calcEngine = this.d.getCalcEngine();
    if (!calcEngine) return;
    calcEngine.stats.formulasEvaluated += count;
    calcEngine.stats.lastResultCount = count;
    calcEngine.stats.batches++;
    calcEngine.stats.lastDuration =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
  }

  _clearCalcEngineDirty() {
    const calcEngine = this.d.getCalcEngine();
    if (!calcEngine) return;
    if (calcEngine.dirtyBitset) calcEngine.dirtyBitset.clear();
    if (calcEngine.batchTimeout) { clearTimeout(calcEngine.batchTimeout); calcEngine.batchTimeout = null; }
  }

  _recalcCellsWithJS(sortedCells) {
    for (const { cell, r, c, hasCycle } of sortedCells) {
      cell.v = hasCycle
        ? '#CYCLE!'
        : this._evaluateFormulaInternal(cell.f, r, c);
      cell.dirty = false;
      const sharedValue = typeof cell.v === 'number' && Number.isFinite(cell.v)
        ? cell.v
        : null;
      this.d.syncSharedValue(r, c, sharedValue);
    }
  }

  _recalcCellsWithWasm(sortedCells, dataMatrix, wasmBridge) {
    const groupedTasks = new Map();
    for (const sortedCell of sortedCells) {
      if (sortedCell.hasCycle) {
        sortedCell.cell.v = '#CYCLE!';
        this.d.syncSharedValue(sortedCell.r, sortedCell.c, '#CYCLE!');
        continue;
      }
      const normalizedFormula = '=' + formulaCompiler.toR1C1(
        sortedCell.cell.f,
        this,
        sortedCell.r,
        sortedCell.c
      );
      if (!groupedTasks.has(normalizedFormula)) {
        groupedTasks.set(normalizedFormula, { rows: [], cols: [], ids: [] });
      }
      const formulaGroup = groupedTasks.get(normalizedFormula);
      formulaGroup.rows.push(sortedCell.r);
      formulaGroup.cols.push(sortedCell.c);
      formulaGroup.ids.push(sortedCell.key);
    }

    const nonNumericResults = wasmBridge.evaluateGroups(groupedTasks);
    if (nonNumericResults === null) return false;

    for (const [id, formulaValue] of Object.entries(nonNumericResults)) {
      const { r, c } = this._parseKey(id);
      const cell = dataMatrix.get(r, c);
      if (cell) {
        cell.v = formulaValue;
        this.d.syncSharedValue(r, c, null);
      }
    }
    for (const sortedCell of sortedCells) sortedCell.cell.dirty = false;
    return true;
  }

  /**
   * 全量重算（JS 回退路径 + WASM 批量路径）
   */
  recalcAllJS() {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const formulaCells = [];
    const dataMatrix = this.d.getDataMatrix();

    dataMatrix.forEach((r, c, cell) => {
      if (cell && cell.f) {
        formulaCells.push({ key: this._cellKey(r, c), cell, r, c });
      }
    });
    if (formulaCells.length === 0) return;

    const sortedCells = this._topologicalSort(formulaCells);
    const wasmBridge = this.d.getWasmBridge();

    const canUseWasm = wasmBridge?.isLoaded && sortedCells.every(
      ({ cell, hasCycle }) => hasCycle || isWasmFormulaSupported(cell.f)
    );
    const wasmCompleted = canUseWasm && this._recalcCellsWithWasm(
      sortedCells,
      dataMatrix,
      wasmBridge
    );
    if (!wasmCompleted) this._recalcCellsWithJS(sortedCells);

    this._recordCalcStats(sortedCells.length, startTime);
    this._clearCalcEngineDirty();
  }

  /**
   * 拓扑排序（Kahn 算法 + 空间索引优化）
   */
  _topologicalSort(formulaCells) {
    const cellMap = new Map();
    const inDegree = new Map();
    const result = [];

    for (const fc of formulaCells) {
      cellMap.set(fc.key, fc);
      inDegree.set(fc.key, 0);
    }

    const formulaCoords = new Set();
    for (const fc of formulaCells) formulaCoords.add(fc.key);

    let spatial = null;
    const ensureSpatialIndex = () => {
      if (spatial) return spatial;
      const byRow = new Map();
      for (const fc of formulaCells) {
        let bucket = byRow.get(fc.r);
        if (!bucket) { bucket = []; byRow.set(fc.r, bucket); }
        bucket.push(fc);
      }
      for (const bucket of byRow.values()) bucket.sort((a, b) => a.c - b.c);
      const sortedRows = Array.from(byRow.keys()).sort((a, b) => a - b);
      spatial = { byRow, sortedRows };
      return spatial;
    };
    const lowerBound = (arr, target, keyFn) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (keyFn(arr[mid]) < target) lo = mid + 1; else hi = mid; }
      return lo;
    };

    const revMap = this.d.getReverseDependencyMap();
    const depMap = this.d.getDependencyMap();
    const rangeIdx = this.d.getRangeDependencyIndex();

    for (const fc of formulaCells) {
      const deps = revMap.get(fc.key);
      if (deps) {
        const upstreamFormulaKeys = new Set();
        for (const dep of deps.cells || []) { if (cellMap.has(dep)) upstreamFormulaKeys.add(dep); }
        for (const range of deps.ranges || []) {
          const area = (range.endR - range.startR + 1) * (range.endC - range.startC + 1);
          if (area < formulaCells.length) {
            for (let r = range.startR; r <= range.endR; r++)
              for (let c = range.startC; c <= range.endC; c++) {
                const key = `${r},${c}`;
                if (key !== fc.key && formulaCoords.has(key)) upstreamFormulaKeys.add(key);
              }
          } else {
            const { byRow, sortedRows } = ensureSpatialIndex();
            let rowIdx = lowerBound(sortedRows, range.startR, v => v);
            while (rowIdx < sortedRows.length && sortedRows[rowIdx] <= range.endR) {
              const row = sortedRows[rowIdx++];
              const bucket = byRow.get(row);
              let colIdx = lowerBound(bucket, range.startC, cell => cell.c);
              while (colIdx < bucket.length && bucket[colIdx].c <= range.endC) {
                const candidate = bucket[colIdx++];
                if (candidate.key !== fc.key) upstreamFormulaKeys.add(candidate.key);
              }
            }
          }
        }
        inDegree.set(fc.key, inDegree.get(fc.key) + upstreamFormulaKeys.size);
      }
    }

    const queue = [];
    for (const [key, degree] of inDegree) { if (degree === 0) queue.push(cellMap.get(key)); }
    let head = 0;
    const affected = new Set();
    while (head < queue.length) {
      const fc = queue[head++];
      result.push(fc);
      affected.clear();
      const dependents = depMap.get(fc.key);
      if (dependents) { for (const depKey of dependents) affected.add(depKey); }
      if (rangeIdx) {
        const rangeDependents = rangeIdx.findDependents(fc.r, fc.c);
        for (const depKey of rangeDependents) affected.add(depKey);
      }
      for (const depKey of affected) {
        if (inDegree.has(depKey)) {
          const newDegree = inDegree.get(depKey) - 1;
          inDegree.set(depKey, newDegree);
          if (newDegree === 0) queue.push(cellMap.get(depKey));
        }
      }
    }

    if (result.length < formulaCells.length) {
      const resultKeys = new Set(result.map(fc => fc.key));
      for (const fc of formulaCells) {
        if (!resultKeys.has(fc.key)) {
          fc.hasCycle = true;
          result.push(fc);
        }
      }
    }
    return result;
  }

  /**
   * 增量重算委托
   */
  recalcDirty() {
    const calcEngine = this.d.getCalcEngine();
    if (calcEngine) calcEngine._processDirtyCells();
  }

  // ═══════════════════════════════════════════════════════════
  // 清理
  // ═══════════════════════════════════════════════════════════
  destroy() {
    this._rpnEvaluator = null;
    this._currentStack = null;
  }
}

export default FormulaEvaluator;
