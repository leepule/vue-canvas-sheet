/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * Workbook 工厂构造器 — 将 343 行构造函数拆分为 8 个拓扑阶段的静态方法。
 * 所有状态写入 ctx（Workbook 实例），Builder 本身无状态。
 */

import { PluginRegistry } from '../plugin/PluginRegistry.js';
import { HistoryManager } from '../history/History.js';
import { CommandExecutor } from '../history/CommandExecutor.js';
import { SearchEngine } from '../search/Search.js';
import { ClipboardManager } from '../utils/Clipboard.js';
import { SelectionManager } from '../SelectionManager.js';
import { EventEmitter, Events } from '../events/EventEmitter.js';
import { SheetError, ErrorCodes, ErrorHandler } from '../data/SheetError.js';
import { Store, DataStore, SelectionStore, UIStore, StoreManager } from '../data/Store.js';
import { PerformanceMonitor, MetricTypes } from '../utils/PerformanceMonitor.js';
import { PoolManager, CellPool } from '../utils/ObjectPool.js';
import { createSparseMatrix } from '../data/SparseMatrix.js';
import { IncrementalCalculationEngine } from '../data/IncrementalCalculation.js';
import { PersistenceManager } from '../PersistenceManager.js';
import { LayoutEngine } from '../LayoutEngine.js';
import { MergeManager } from '../MergeManager.js';
import { StyleManager } from '../StyleManager.js';
import { SheetStructure } from '../SheetStructure.js';
import { StyleCache } from '../render/StyleCache.js';
import { RangeDependencyIndex } from '../data/RangeDependencyIndex.js';
import { IndexedDBStorage } from '../utils/IndexedDBStorage.js';
import { FormulaEngineService } from '../data/FormulaEngineService.js';
import { FormulaEvaluator } from '../data/FormulaEvaluator.js';
import { DataLoader } from './DataLoader.js';

export class WorkbookBuilder {
  /**
   * 单一入口：按拓扑顺序构建所有对象并写入 ctx
   * @param {Object} ctx — Workbook 实例 (this)
   * @param {Object} [options={}]
   */
  static build(ctx, options = {}) {
    const {
      enablePersistence = false,
      sheetId = 'default',
      debug = false,
      verbose = false
    } = options;
    ctx._enablePersistence = enablePersistence;
    ctx._sheetId = sheetId;
    ctx._debug = debug === true || verbose === true;

    this._phase0_infrastructure(ctx);
    this._phase1_storeAccessors(ctx);
    this._phase2_simpleUtils(ctx);
    this._phase3_deferredManagers(ctx);
    this._phase4_formulaLayer(ctx);
    this._phase5_calcEngine(ctx);
    this._phase6_dependentManagers(ctx);
    this._phase7_optionalStorage(ctx, options);
    this._phase8_finalAssembly(ctx);
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 0: 独立基础设施（零交叉依赖）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase0_infrastructure(ctx) {
    // PluginRegistry — 需要 Workbook 引用本身
    ctx.plugins = new PluginRegistry(ctx);

    // Store
    ctx._dataStore = new DataStore({}, { freezeMode: 'deep', useCompactKey: true });
    ctx._selectionStore = new SelectionStore({}, { freezeMode: 'deep' });
    ctx._uiStore = new UIStore({}, { freezeMode: 'deep' });
    ctx._storeManager = new StoreManager({
      data: ctx._dataStore,
      selection: ctx._selectionStore,
      ui: ctx._uiStore
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 1: Store 访问器代理（必须在任何 Manager 之前）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase1_storeAccessors(ctx) {
    // 此方法直接调用 Workbook 原型上的 _setupStoreAndLayoutAccessors
    // 或者内联 Object.defineProperty 代理
    const storeProps = [
      ['colWidths', '_dataStore'], ['rowHeights', '_dataStore'], ['merges', '_dataStore'],
      ['mergeMap', '_dataStore'], ['defaultColWidth', '_dataStore'], ['defaultRowHeight', '_dataStore'],
      ['dataVersion', '_dataStore'], ['fieldMap', '_dataStore'], ['headerDepth', '_dataStore'],
      ['dependencyMap', '_dataStore'], ['reverseDependencyMap', '_dataStore'],
      ['selection', '_selectionStore'], ['activeCell', '_selectionStore'], ['copyRange', '_selectionStore'],
      ['freeze', '_uiStore'],
    ];
    const persistedConfigProps = new Set([
      'colWidths', 'rowHeights', 'merges', 'mergeMap',
      'defaultColWidth', 'defaultRowHeight', 'freeze'
    ]);
    for (const [prop, storeKey] of storeProps) {
      const store = ctx[storeKey];
      Object.defineProperty(ctx, prop, {
        get: () => store.getState()[prop],
        set: (v) => {
          store.setState({ [prop]: v });
          if (persistedConfigProps.has(prop)) {
            ctx._persistenceManager?.markConfigDirty();
          }
        },
        enumerable: true, configurable: true,
      });
    }
    // search 别名
    Object.defineProperty(ctx, 'search', {
      get: () => ctx.searchEngine, enumerable: true, configurable: true,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 2: 简单工具层
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase2_simpleUtils(ctx) {
    // EventEmitter
    ctx._events = new EventEmitter();
    // ErrorHandler — 依赖 EventEmitter
    ctx.errorHandler = new ErrorHandler({ eventEmitter: ctx._events });
    // PerformanceMonitor
    ctx._performanceMonitor = new PerformanceMonitor({ enabled: false });
    // PoolManager + CellPool
    ctx._poolManager = new PoolManager();
    ctx._cellPool = ctx._poolManager.getCellPool();
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 3: 延迟引用管理器（所有 deps 都是闭包）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase3_deferredManagers(ctx) {
    // HistoryManager — 闭包延迟引用 _commandExecutor
    ctx.history = new HistoryManager({
      applyCommand: (cmd, isUndo) => ctx._commandExecutor.execute(cmd, isUndo),
    });

    // SearchEngine
    ctx.searchEngine = new SearchEngine({
      getDataVersion: () => ctx.dataVersion,
      getDataMatrix: () => ctx._dataMatrix,
      cellKey: (r, c) => ctx._cellKey(r, c),
      getCell: (r, c) => ctx.getCell(r, c),
      bulkSetCells: (updates) => ctx.bulkSetCells(updates),
      setCell: (r, c, val) => ctx.setCell(r, c, val),
      onEvent: (event, cb) => ctx.on(event, cb),
      offEvent: (event, cb) => ctx.off(event, cb),
    });

    // ClipboardManager
    ctx._clipboardManager = new ClipboardManager({
      getCell: (r, c) => ctx.getCell(r, c),
      getRowCount: () => ctx.rowCount,
      getColCount: () => ctx.colCount,
      setCellData: (r, c, val) => ctx._setCellData(r, c, val),
      recordHistory: (cmd) => ctx.history.execute(cmd),
      notify: (data) => ctx.notify(data),
    });
    ctx.clipboard = ctx._clipboardManager;

    // LayoutEngine
    ctx._layoutEngine = new LayoutEngine({
      getRowCount: () => ctx.rowCount,
      getColCount: () => ctx.colCount,
      getDefaultRowHeight: () => ctx.defaultRowHeight,
      getDefaultColWidth: () => ctx.defaultColWidth,
      getRowHeights: () => ctx.rowHeights,
      getColWidths: () => ctx.colWidths,
      getFreeze: () => ctx.freeze,
      getColWidth: (c) => ctx.getColWidth(c),
      getRowHeight: (r) => ctx.getRowHeight(r),
      getDataMatrix: () => ctx._dataMatrix,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 4: 公式层（FormulaEvaluator → _dataMatrix → FormulaEngineService）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase4_formulaLayer(ctx) {
    // FormulaEvaluator
    ctx._formulaEvaluator = new FormulaEvaluator({
      getDataMatrix: () => ctx._dataMatrix,
      cellKey: (r, c) => ctx._cellKey(r, c),
      parseKey: (k) => ctx._parseKey(k),
      getDependencyMap: () => ctx.dependencyMap,
      getReverseDependencyMap: () => ctx.reverseDependencyMap,
      getRangeDependencyIndex: () => ctx.rangeDependencyIndex,
      getNumericDepIndex: () => ctx._numericDepIndex,
      getWasmBridge: () => ctx._formulaEngine?.wasmBridge,
      getSharedValueStore: () => ctx._formulaEngine?.sharedValueStore,
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      getCalcEngine: () => ctx.calcEngine,
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
      errorHandler: ctx.errorHandler,
      getPerformanceMonitor: () => ctx._performanceMonitor,
      getRowCount: () => ctx.rowCount,
      getColCount: () => ctx.colCount,
      getCell: (r, c) => ctx._dataMatrix.get(r, c),
      setCellData: (r, c, val) => ctx._setCellData(r, c, val),
      markCellChanged: (r, c) => ctx._markCellChanged(r, c),
    });

    // FormulaEngineService
    ctx._formulaEngine = new FormulaEngineService({
      debug: ctx._debug,
      getDataMatrix: () => ctx._dataMatrix,
      cellKey: (r, c) => ctx._cellKey(r, c),
      parseKey: (k) => ctx._parseKey(k),
      getDependencyMap: () => ctx.dependencyMap,
      getReverseDependencyMap: () => ctx.reverseDependencyMap,
      getDependencies: (f) => ctx._formulaEvaluator.getDependencies(f),
      updateDependencyMap: (id, f) => ctx._formulaEvaluator._updateDependencyMap(id, f),
      getSharedValueStore: () => ctx._formulaEngine.sharedValueStore,
      setSharedValueStore: (s) => { ctx._formulaEngine.sharedValueStore = s; },
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      getCalcEngine: () => ctx.calcEngine,
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
      errorHandler: ctx.errorHandler,
      evaluateFormula: (f, r, c, stack) => ctx._formulaEvaluator._evaluateFormulaInternal(f, r, c, stack),
      getRowCount: () => ctx.rowCount,
      getColCount: () => ctx.colCount,
      getPerformanceMonitor: () => ctx._performanceMonitor,
    });

    // StyleCache
    ctx.styleCache = new StyleCache();

    // SparseMatrix — 延迟引用 _cellPool
    ctx._dataMatrix = createSparseMatrix({
      onDeleteCell: (cell) => { ctx._cellPool.releaseCell(cell); }
    });
    ctx._dataCache = null;
    ctx._dataCacheVersion = -1;
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 5: 增量计算引擎
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase5_calcEngine(ctx) {
    ctx.calcEngine = new IncrementalCalculationEngine({
      getColCount: () => ctx.colCount,
      getDataMatrix: () => ctx._dataMatrix,
      parseKey: (k) => ctx._parseKey(k),
      cellKey: (r, c) => ctx._cellKey(r, c),
      getNumericDepIndex: () => ctx._numericDepIndex,
      getDependencyMap: () => ctx.dependencyMap,
      getReverseDependencyMap: () => ctx.reverseDependencyMap,
      getRangeDependencyIndex: () => ctx.rangeDependencyIndex,
      getDependencies: (f) => ctx._formulaEvaluator.getDependencies(f),
      dropNumericDepSource: (src) => ctx._formulaEvaluator._dropNumericDepSource(src),
      evaluateFormula: (f, r, c, stack) => ctx._formulaEvaluator.evaluateFormula(f, r, c, stack),
      checkCycle: (r, c, cache) => ctx._formulaEvaluator.checkCycle(r, c, cache),
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      emit: (...args) => ctx._emit(...args),
      isWorkerEnabled: () => !!ctx._useWorker,
      getWorkerManager: () => ctx._workerManager,
      recalcDirtyWithWorker: (ids) => ctx._formulaEngine.recalcDirtyWithWorker(ids),
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 6: 依赖管理器（MergeManager, StyleManager, SheetStructure）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase6_dependentManagers(ctx) {
    ctx._mergeManager = new MergeManager({
      getMerges: () => ctx.merges,
      setMerges: (v) => { ctx.merges = v; },
      getMergeMap: () => ctx.mergeMap,
      setMergeMap: (v) => { ctx.mergeMap = v; },
      getCellKey: (r, c) => ctx._cellKey(r, c),
      iterateRange: (range, cb) => ctx.iterateRange(range, cb),
      getDataMatrix: () => ctx._dataMatrix,
      getHistory: () => ctx.history,
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
    });

    ctx._selectionManager = new SelectionManager({
      getSelection: () => ctx.selection,
      setSelectionState: (selection) => { ctx.selection = selection; },
      getActiveCell: () => ctx.activeCell,
      setActiveCell: (cell) => { ctx.activeCell = cell; },
      setCopyRangeState: (range) => { ctx.copyRange = range; },
      mergeManager: ctx._mergeManager,
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
    });

    ctx._styleManager = new StyleManager({
      iterateRange: (range, cb) => ctx.iterateRange(range, cb),
      setCellData: (r, c, v) => ctx._setCellData(r, c, v),
      getCell: (r, c) => ctx.getCell(r, c),
      getCellKey: (r, c) => ctx._cellKey(r, c),
      getDataMatrix: () => ctx._dataMatrix,
      getHistory: () => ctx.history,
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      updateDependencyMap: (id, f) => ctx._formulaEvaluator._updateDependencyMap(id, f),
      markCellChanged: (r, c) => ctx._markCellChanged(r, c),
    });

    ctx._sheetStructure = new SheetStructure({
      getDataMatrix: () => ctx._dataMatrix,
      getRowCount: () => ctx.rowCount,
      setRowCount: (v) => { ctx.rowCount = v; },
      getColCount: () => ctx.colCount,
      setColCount: (v) => { ctx.colCount = v; },
      getDataVersion: () => ctx.dataVersion,
      setDataVersion: (v) => { ctx.dataVersion = v; },
      markDirty: () => ctx._layoutEngine.markDirty(),
      markFrozenDirty: () => ctx._layoutEngine.markFrozenDirty(),
      getHistory: () => ctx.history,
      getCell: (r, c) => ctx.getCell(r, c),
      bulkSetCells: (updates) => ctx.bulkSetCells(updates),
      notify: (...a) => ctx.notify(...a),
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 7: 可选存储层（持久化 + 依赖索引）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase7_optionalStorage(ctx, options) {
    const { enablePersistence = false } = options;

    ctx._useCompactKey = false;
    ctx._readOnly = false;

    ctx.rangeDependencyIndex = new RangeDependencyIndex();
    ctx._numericDepIndex = new Map();

    // 持久化存储
    if (enablePersistence) {
      ctx._storage = new IndexedDBStorage();
      ctx._dirtyCells = new Map();
      ctx._persistTimer = null;
    } else {
      ctx._storage = null;
    }

    ctx._persistenceManager = new PersistenceManager({
      getStorage: () => ctx._storage,
      setStorage: (s) => { ctx._storage = s; },
      getDirtyCells: () => ctx._dirtyCells,
      setDirtyCells: (m) => { ctx._dirtyCells = m; },
      getSheetId: () => ctx._sheetId,
      setSheetId: (id) => { ctx._sheetId = id; },
      getEnablePersistence: () => ctx._enablePersistence,
      setEnablePersistence: (v) => { ctx._enablePersistence = v; },
      snapshotConfig: () => ({
        rowCount: ctx.rowCount,
        colCount: ctx.colCount,
        colWidths: ctx.colWidths,
        rowHeights: ctx.rowHeights,
        merges: ctx.merges,
        mergeMap: ctx.mergeMap,
        defaultColWidth: ctx.defaultColWidth,
        defaultRowHeight: ctx.defaultRowHeight,
        freeze: ctx.freeze,
      }),
      applyConfig: (cfg) => {
        ctx._dataStore.setState({
          rowCount: cfg.rowCount,
          colCount: cfg.colCount,
          colWidths: cfg.colWidths || {},
          rowHeights: cfg.rowHeights || {},
          merges: cfg.merges || [],
          mergeMap: cfg.mergeMap || {},
          defaultColWidth: cfg.defaultColWidth || 80,
          defaultRowHeight: cfg.defaultRowHeight || 25,
        });
        ctx._uiStore.setState({ freeze: cfg.freeze || { r: 0, c: 0 } });
      },
      getDataMatrix: () => ctx._dataMatrix,
      parseKey: (k) => ctx._parseKey(k),
      setCell: (r, c, v) => ctx.setCell(r, c, v),
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      rebuildDependencyMap: () => ctx.rebuildDependencyMap(),
      markOffsetsDirty: () => { ctx._layoutEngine.markDirty(); },
      notify: (...a) => ctx.notify(...a),
      getPersistTimer: () => ctx._persistTimer,
      setPersistTimer: (t) => { ctx._persistTimer = t; },
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 8: 最终组装（CommandExecutor + DataLoader + 标记）
  // ═══════════════════════════════════════════════════════════
  /** @private */
  static _phase8_finalAssembly(ctx) {
    // CommandExecutor — 硬依赖 MergeManager, SheetStructure, LayoutEngine, _dataMatrix
    ctx._commandExecutor = new CommandExecutor({
      updateCellContent: (r, c, val) => ctx._updateCellContent(r, c, val),
      moveColumnData: (from, to) => ctx._moveColumnData(from, to),
      mergeManager: ctx._mergeManager,
      sheetStructure: ctx._sheetStructure,
      layoutEngine: ctx._layoutEngine,
      dataMatrix: ctx._dataMatrix,
      getFreezeR: () => (ctx.freeze || {}).r || 0,
      getFreezeC: () => (ctx.freeze || {}).c || 0,
      getRowHeights: () => ctx.rowHeights,
      setRowHeights: (v) => { ctx.rowHeights = v; },
      getColWidths: () => ctx.colWidths,
      setColWidths: (v) => { ctx.colWidths = v; },
      notify: () => ctx.notify(),
    });

    // DataLoader — 数据加载器
    ctx._dataLoader = new DataLoader({
      getDataMatrix: () => ctx._dataMatrix,
      getCellPool: () => ctx._cellPool,
      getFormulaEvaluator: () => ctx._formulaEvaluator,
      getCalcEngine: () => ctx.calcEngine,
      getFormulaEngine: () => ctx._formulaEngine,
      getLayoutEngine: () => ctx._layoutEngine,
      getDirtyCells: () => ctx._dirtyCells,
      getDataVersion: () => ctx.dataVersion,
      setDataVersion: (v) => { ctx.dataVersion = v; },
      getRowCount: () => ctx.rowCount,
      setRowCount: (v) => { ctx.rowCount = v; },
      getHeaderDepth: () => ctx.headerDepth,
      getFieldMap: () => ctx.fieldMap,
      cellKey: (r, c) => ctx._cellKey(r, c),
      parseKey: (k) => ctx._parseKey(k),
      syncSharedValue: (r, c, v) => ctx._syncSharedValue(r, c, v),
      emit: (...a) => ctx._emit(...a),
      notify: (...a) => ctx.notify(...a),
      markCellChanged: (r, c) => ctx._markCellChanged(r, c),
      maybeInitWasm: () => ctx._maybeStartWasmInitialization(),
      recalcAll: () => ctx.recalcAll(),
      rebuildContext: () => {
        ctx.history = new HistoryManager({
          applyCommand: (cmd, isUndo) => ctx.applyCommand(cmd, isUndo),
        });
        if (ctx.calcEngine) ctx.calcEngine.reset();
        ctx._formulaEvaluator._clearDependencyGraph();
        if (ctx._dirtyCells) ctx._dirtyCells.clear();
        const sharedStore = ctx._formulaEngine._ensureSharedStore();
        if (sharedStore) sharedStore.clear();
      },
    });

    // 销毁标记
    ctx._destroyed = false;
    ctx._autoPersist = false;
    ctx._persistTimer = null;
    ctx._renderScheduler = null;
  }
}
