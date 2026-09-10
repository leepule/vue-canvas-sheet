/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 数据加载器 — 将 _setDataInternal 的 5 条数据加载路径从 Workbook 解耦
 *
 * @typedef {Object} DataLoaderDeps
 * @property {() => import('../data/Store').DataStore}        getDataStore
 * @property {() => import('../../sparse-matrix/SparseMatrix').default} getDataMatrix
 * @property {() => import('../utils/ObjectPool').CellPool}    getCellPool
 * @property {() => import('../data/FormulaEvaluator').FormulaEvaluator} getFormulaEvaluator
 * @property {() => import('../data/IncrementalCalculation').IncrementalCalculationEngine} getCalcEngine
 * @property {() => import('../data/FormulaEngineService').FormulaEngineService} getFormulaEngine
 * @property {() => import('../LayoutEngine').LayoutEngine}    getLayoutEngine
 * @property {() => Map<string, any>|undefined}                getDirtyCells
 * @property {() => number}                                    getDataVersion
 * @property {(v: number) => void}                             setDataVersion
 * @property {() => number}                                    getRowCount
 * @property {(v: number) => void}                             setRowCount
 * @property {() => number}                                    getHeaderDepth
 * @property {() => Object}                                    getFieldMap
 * @property {(r: number, c: number) => string}                cellKey
 * @property {(k: string|number) => {r: number, c: number}}    parseKey
 * @property {(r: number, c: number, v: any) => void}          syncSharedValue
 * @property {(event: string, payload?: Object) => void}       emit
 * @property {(data?: Object) => void}                         notify
 * @property {(r: number, c: number) => void}                  markCellChanged
 * @property {() => void}                                      recalcAll
 * @property {() => void}                                      rebuildContext
 */

import { cloneCell } from '../utils/Clipboard.js';
import { HistoryManager } from '../history/History.js';
import { Events } from '../events/EventEmitter.js';

export class DataLoader {
  /**
   * @param {DataLoaderDeps} deps
   */
  constructor(deps) {
    /** @type {DataLoaderDeps} */
    this.d = deps;
  }

  /**
   * 加载数据（替代 Workbook._setDataInternal）
   * @param {Array|Object} data
   */
  load(data) {
    const startRow = this.d.getHeaderDepth() > 0
      ? this.d.getHeaderDepth()
      : (Array.isArray(data) ? 1 : 0);

    if (Array.isArray(data)) {
      if (data.length === 0) {
        this._loadEmptyClear(startRow);
        return;
      }

      if (this.d.getHeaderDepth() === 0) {
        // 无表头模式：完全重建
        this.d.getDataMatrix().clear();
        this.d.rebuildContext();

        if (Array.isArray(data[0])) {
          this._loadArrayMatrix(data);
        } else {
          this._loadArrayObject(data);
        }

        // 触发全局版本更新，迫使 UI 丢弃位图缓存
        this.d.setDataVersion(this.d.getDataVersion() + 1);
        this.d.notify({ type: 'all' });
      } else {
        // 有表头模式：增量更新
        this._loadHeaderIncremental(data, startRow);
      }
    } else {
      // 对象形式更新
      this._loadObjectForm(data);
    }

    // 共享后处理
    this.d.setDataVersion(this.d.getDataVersion() + 1);
    this.d.recalcAll();
    this.d.getLayoutEngine().markDirty();
    this.d.emit(Events.DATA_LOAD, {
      action: 'setData',
      count: Array.isArray(data) ? data.length : Object.keys(data).length
    });
    this.d.notify();
  }

  // ═══════════════════════════════════════════════════════════
  //  Path 1: 空数组清除
  // ═══════════════════════════════════════════════════════════
  /** @private */
  _loadEmptyClear(startRow) {
    this.d.getLayoutEngine()._clearRowRange(startRow);
    this.d.setRowCount(Math.max(startRow, 1000));
    this.d.getLayoutEngine().markDirty();
    this.d.setDataVersion(this.d.getDataVersion() + 1);
    this.d.emit(Events.DATA_LOAD, { action: 'clear' });
    this.d.notify();
  }

  // ═══════════════════════════════════════════════════════════
  //  Path 2: 2D 数组矩阵 — 无表头，完全重建
  // ═══════════════════════════════════════════════════════════
  /** @private */
  _loadArrayMatrix(data) {
    const matrix = this.d.getDataMatrix();
    const pool = this.d.getCellPool();
    const formulaEval = this.d.getFormulaEvaluator();
    const formulaEngine = this.d.getFormulaEngine();
    const sharedStore = formulaEngine._ensureSharedStore();

    if (sharedStore) {
      sharedStore.clear();
    }

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      for (let c = 0; c < row.length; c++) {
        const val = row[c];
        if (val === null || val === undefined) continue;

        if (typeof val === 'number') {
          matrix.set(r, c, pool.acquireCell(val));
          if (sharedStore) sharedStore.set(r, c, val);
        } else if (val && typeof val === 'object' && (val.f || val.v !== undefined || val.s)) {
          const cellId = this.d.cellKey(r, c);
          const cell = pool.acquireCell(val.v);
          if (val.f) cell.f = val.f;
          if (val.s) {
            cell.s = pool._stylePool.acquire();
            Object.assign(cell.s, val.s);
          }
          if (cell.f) {
            cell.v = undefined;
            cell.dirty = true;
            formulaEval._updateDependencyMap(cellId, cell.f);
          }
          matrix.set(r, c, cell);
        } else {
          matrix.set(r, c, pool.acquireCell(val));
        }
      }
    }
    this.d.setRowCount(Math.max(data.length, 1000));
  }

  // ═══════════════════════════════════════════════════════════
  //  Path 3: 对象数组 — 无表头，对象键作为列
  // ═══════════════════════════════════════════════════════════
  /** @private */
  _loadArrayObject(data) {
    const keys = Object.keys(data[0]);
    const pool = this.d.getCellPool();
    const matrix = this.d.getDataMatrix();

    keys.forEach((key, c) => {
      const cell = pool.acquireCell(key);
      cell.s = { fontWeight: 'bold' };
      matrix.set(0, c, cell);
    });
    data.forEach((rowObj, rIndex) => {
      keys.forEach((key, c) => {
        const val = rowObj[key];
        matrix.set(rIndex + 1, c, pool.acquireCell(val));
        this.d.syncSharedValue(rIndex + 1, c, val);
      });
    });
    this.d.setRowCount(Math.max(data.length + 1, 1000));
  }

  // ═══════════════════════════════════════════════════════════
  //  Path 4: 表头模式增量更新
  // ═══════════════════════════════════════════════════════════
  /** @private */
  _loadHeaderIncremental(data, startRow) {
    const formulaEval = this.d.getFormulaEvaluator();
    const calcEngine = this.d.getCalcEngine();
    const dirtyCells = this.d.getDirtyCells();
    const matrix = this.d.getDataMatrix();
    const pool = this.d.getCellPool();

    formulaEval._clearDependencyGraph();
    if (dirtyCells) dirtyCells.clear();
    if (calcEngine) calcEngine.reset();

    const fieldMapKeys = this.d.getFieldMap() ? Object.keys(this.d.getFieldMap()) : [];
    const fieldColMap = this.d.getFieldMap() || {};

    data.forEach((rowObj, rIndex) => {
      const tr = startRow + rIndex;
      for (const field of fieldMapKeys) {
        const c = fieldColMap[field];
        const val = rowObj[field];

        const existingCell = matrix.get(tr, c);
        if (!existingCell) {
          matrix.set(tr, c, pool.acquireCell(val));
        } else {
          existingCell.v = val;
        }

        const cellId = this.d.cellKey(tr, c);
        const cell = matrix.get(tr, c);
        if (cell && cell.f) {
          cell.dirty = true;
          formulaEval._updateDependencyMap(cellId, cell.f);
        }

        this.d.syncSharedValue(tr, c, val);
      }
    });

    // 清除超出新数据长度的行
    const maxDataRow = startRow + data.length - 1;
    this.d.getLayoutEngine()._clearRowRange(maxDataRow + 1);

    this.d.setRowCount(Math.max(startRow + data.length, 1000));
  }

  // ═══════════════════════════════════════════════════════════
  //  Path 5: 键值对象形式更新
  // ═══════════════════════════════════════════════════════════
  /** @private */
  _loadObjectForm(data) {
    const matrix = this.d.getDataMatrix();
    const dataKeys = Object.keys(data);
    for (let i = 0; i < dataKeys.length; i++) {
      const key = dataKeys[i];
      const cellData = data[key];
      if (cellData) {
        const newVal = cloneCell(cellData);
        if (newVal.v && typeof newVal.v === 'string' && newVal.v.startsWith('=')) {
          newVal.f = newVal.v;
        }
        const { r, c } = this.d.parseKey(key);
        matrix.set(r, c, newVal);
        this.d.syncSharedValue(r, c, newVal.v);
      }
    }
  }
}
