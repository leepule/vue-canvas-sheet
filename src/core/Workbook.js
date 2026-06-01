/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @typedef {Object} CellRef - 单元格引用
 * @property {number} r - 行索引（从 0 开始）
 * @property {number} c - 列索引（从 0 开始）
 */

/**
 * @typedef {Object} Range - 范围对象
 * @property {CellRef} s - 起始位置
 * @property {CellRef} e - 结束位置
 */

/**
 * @typedef {Object} CellStyle - 单元格样式
 * @property {string} [fontWeight] - 字体粗细
 * @property {string} [fontStyle] - 字体样式
 * @property {number} [fontSize] - 字体大小
 * @property {string} [color] - 文字颜色
 * @property {string} [bg] - 背景色
 * @property {string} [align] - 水平对齐
 * @property {string} [valign] - 垂直对齐
 * @property {Object} [border] - 边框设置
 * @property {string} [fmt] - 数字格式
 * @property {number} [decimals] - 小数位数
 */

/**
 * @typedef {Object} Cell - 单元格数据
 * @property {*} v - 单元格值
 * @property {string} [f] - 公式
 * @property {CellStyle} [s] - 样式
 * @property {string} [m] - 显示文本
 * @property {boolean} [dirty] - 是否需要重算
 */

/**
 * @typedef {Object} CellChange - 单元格变更记录
 * @property {number} r - 行索引
 * @property {number} c - 列索引
 * @property {Cell|null} oldValue - 旧值
 * @property {Cell|null} newValue - 新值
 */

/**
 * @typedef {Object} FreezeConfig - 冻结配置
 * @property {number} r - 冻结行数
 * @property {number} c - 冻结列数
 */

/**
 * @typedef {Object} FrozenSize - 冻结区域尺寸
 * @property {number} w - 宽度
 * @property {number} h - 高度
 */

import { PluginRegistry, HookTypes } from './plugin/PluginRegistry.js';
import { cloneCell, cloneRange } from './utils/Clipboard.js';
import { wasmBridge } from './worker/WasmBridge.js';
import { HistoryManager } from './history/History.js';
import { SearchEngine } from './search/Search.js';
import { ClipboardManager } from './utils/Clipboard.js';
import { EventEmitter, Events } from './events/EventEmitter.js';
import { SheetError, ErrorCodes, ErrorHandler } from './data/SheetError.js';
import { Store, DataStore, SelectionStore, UIStore, StoreManager } from './data/Store.js';
import { PerformanceMonitor, MetricTypes } from './utils/PerformanceMonitor.js';
import { WorkerManager, createFormulaWorkerManager, isWorkerSupported } from './worker/WorkerManager.js';
import { PoolManager, CellPool } from './utils/ObjectPool.js';
import { createSparseMatrix } from './data/SparseMatrix.js';

import { IncrementalCalculationEngine } from './data/IncrementalCalculation.js';
import { PersistenceManager } from './PersistenceManager.js';
import { LayoutEngine } from './LayoutEngine.js';
import { MergeManager } from './MergeManager.js';
import { StyleManager } from './StyleManager.js';
import { colStrToIndex } from './utils/CellUtils.js';
import { SheetStructure } from './SheetStructure.js';
import { StyleCache } from './render/StyleCache.js';
import { RangeDependencyIndex } from './data/RangeDependencyIndex.js';
import { IndexedDBStorage } from './utils/IndexedDBStorage.js';
import { SharedValueStore } from './data/SharedValueStore.js';
import { cellKey, cellKeyNumeric, parseCellKey } from './data/CellKey.js';
import { HeadPointerQueue } from './utils/Queues.js';

import { formulaCompiler } from './data/FormulaCompiler.js';

const MAX_FORMULA_ROWS = 1048576;
const MAX_FORMULA_COLS = 16384;
const MAX_INLINE_RANGE_SNAPSHOT_CELLS = 5000;

// 公式依赖提取正则（模块级常量，避免每次调用 getDependencies 时重新编译）
const DEP_RANGE_REGEX = /\$?(?:[A-Z]+\$?[0-9]+|[A-Z]+|[0-9]+):\$?(?:[A-Z]+\$?[0-9]+|[A-Z]+|[0-9]+)/g;
const DEP_CELL_REGEX = /\$?[A-Z]+\$?[0-9]+/g;

/**
 * 工作簿核心数据模型
 * 管理单元格数据、样式、合并、选区、冻结等状态
 */
export class Workbook {
  /**
   * 创建工作簿实例
   * @param {Object} [options={}] - 配置选项
   * @param {boolean} [options.enablePersistence=false] - 是否启用持久化存储
   * @param {string} [options.sheetId='default'] - 工作表唯一标识（用于指纹识别与秒开）
   */
  constructor(options = {}) {
    const { enablePersistence = false, sheetId = 'default' } = options;
    this._enablePersistence = enablePersistence;
    this._sheetId = sheetId;

    /** @type {PluginRegistry} 插件注册中心 */
    this.plugins = new PluginRegistry(this);
    
    // ========== 状态管理 Store ==========
    // 注意：禁用 freeze 选项，因为 Workbook 中的代码直接修改状态对象
    // 如果启用 freeze，会导致 "object is not extensible" 错误
    /** @type {DataStore} 数据状态 */
    this._dataStore = new DataStore({}, { freezeMode: 'none', useCompactKey: true });
    /** @type {SelectionStore} 选区状态 */
    this._selectionStore = new SelectionStore({}, { freezeMode: 'none' });
    /** @type {UIStore} UI状态 */
    this._uiStore = new UIStore({}, { freezeMode: 'none' });
    /** @type {StoreManager} Store管理器 */
    this._storeManager = new StoreManager({
      data: this._dataStore,
      selection: this._selectionStore,
      ui: this._uiStore
    });
    
    // ========== 向后兼容属性（代理到 Store）==========
    // 这些属性通过 getter/setter 代理到对应的 Store
    
    /** @type {HistoryManager} 历史记录管理器 */
    this.history = new HistoryManager(this);
    /** @type {SearchEngine} 搜索引擎 */
    this.searchEngine = new SearchEngine(this);
    /** @type {ClipboardManager} 剪贴板管理器 */
    this.clipboard = new ClipboardManager(this);
    /** @type {Array<Function>} 旧版监听器列表（向后兼容） */
    this.listeners = [];
    /** @type {EventEmitter} 新版事件发射器 */
    this._events = new EventEmitter();
    /** @type {ErrorHandler} 错误处理器 */
    this.errorHandler = new ErrorHandler({ eventEmitter: this._events });
    
    // ========== 性能监控 ==========
    /** @type {PerformanceMonitor} 性能监控器 */
    this._performanceMonitor = new PerformanceMonitor({ enabled: false });
    
    // ========== 对象池 ==========
    /** @type {PoolManager} 对象池管理器 */
    this._poolManager = new PoolManager();
    /** @type {CellPool} 单元格对象池 */
    this._cellPool = this._poolManager.getCellPool();
    
    // ========== Web Worker 支持 ==========
    /** @type {WorkerManager|null} Worker 管理器 */
    this._workerManager = null;
    /** @type {boolean} 是否使用 Worker */
    this._useWorker = false;
    /** @type {boolean} Worker 计算是否进行中 */
    this._workerCalculating = false;
    /** @type {HeadPointerQueue<Function>} Worker 回调队列 */
    this._workerQueue = new HeadPointerQueue();
    
    // ========== 布局引擎 ==========
    this._layoutEngine = new LayoutEngine({
      getRowCount: () => this.rowCount,
      getColCount: () => this.colCount,
      getDefaultRowHeight: () => this.defaultRowHeight,
      getDefaultColWidth: () => this.defaultColWidth,
      getRowHeights: () => this.rowHeights,
      getColWidths: () => this.colWidths,
      getFreeze: () => this.freeze,
      getColWidth: (c) => this.getColWidth(c),
      getRowHeight: (r) => this.getRowHeight(r),
      getDataMatrix: () => this._dataMatrix,
    });

    // ========== WASM 共享内存支持 ==========
    
    // ========== 增量计算引擎 ==========
    /** @type {IncrementalCalculationEngine} 增量计算引擎 */
    this.calcEngine = new IncrementalCalculationEngine(this);
    
    // ========== 样式管理 ==========
    /** @type {StyleCache} 样式缓存管理器 */
    this.styleCache = new StyleCache();

    this._dataMatrix = createSparseMatrix({
      onDeleteCell: (cell) => {
        this._cellPool.releaseCell(cell);
      }
    });

    // ========== 合并单元格管理器 ==========
    this._mergeManager = new MergeManager({
      getMerges: () => this.merges,
      setMerges: (v) => { this.merges = v; },
      getMergeMap: () => this.mergeMap,
      getCellKey: (r, c) => this._cellKey(r, c),
      iterateRange: (range, cb) => this.iterateRange(range, cb),
      getDataMatrix: () => this._dataMatrix,
      getHistory: () => this.history,
      emit: (...a) => this._emit(...a),
      notify: (...a) => this.notify(...a),
    });

    // ========== 样式管理器 ==========
    this._styleManager = new StyleManager({
      iterateRange: (range, cb) => this.iterateRange(range, cb),
      setCellData: (r, c, v) => this._setCellData(r, c, v),
      getCell: (r, c) => this.getCell(r, c),
      getCellKey: (r, c) => this._cellKey(r, c),
      getDataMatrix: () => this._dataMatrix,
      getHistory: () => this.history,
      emit: (...a) => this._emit(...a),
      notify: (...a) => this.notify(...a),
      syncSharedValue: (r, c, v) => this._syncSharedValue(r, c, v),
      updateDependencyMap: (id, f) => this._updateDependencyMap(id, f),
      markCellChanged: (r, c) => this._markCellChanged(r, c),
    });

    // ========== 表格结构管理器 ==========
    this._sheetStructure = new SheetStructure({
      getDataMatrix: () => this._dataMatrix,
      getRowCount: () => this.rowCount,
      setRowCount: (v) => { this.rowCount = v; },
      getColCount: () => this.colCount,
      setColCount: (v) => { this.colCount = v; },
      getDataVersion: () => this.dataVersion,
      setDataVersion: (v) => { this.dataVersion = v; },
      markDirty: () => this._layoutEngine.markDirty(),
      markFrozenDirty: () => this._layoutEngine.markFrozenDirty(),
      getHistory: () => this.history,
      getCell: (r, c) => this.getCell(r, c),
      bulkSetCells: (updates) => this.bulkSetCells(updates),
      notify: (...a) => this.notify(...a),
    });

    // ========== 共享数值存储 ==========
    /** @type {SharedValueStore|null} 共享数值存储 */
    this.sharedValueStore = null;
    this._sharedRows = 100000;
    this._sharedCols = 256;
    
    // ========== 单元格键格式 ==========
    /** @type {boolean} 是否使用统一字符串键，避免 32 位位运算上限 */
    this._useCompactKey = false;
    
    // 初始化公式引擎 (异步加载 WASM，不阻塞主线程)
    this.wasmBridge = wasmBridge;
    this.initWasm().catch(err => {
      this.errorHandler.handle(
        new SheetError(ErrorCodes.OPERATION_FAILED, 'WASM initialization failed', { originalError: err.message }),
        { phase: 'init' }
      );
    });
    
    // 初始化插件系统
    this.plugins.init();
    
    // 设置性能监控的默认阈值警告
    this._setupPerformanceThresholds();

    /** @type {boolean} 是否为只读模式 */
    this._readOnly = false;

    // ========== 范围依赖索引 ==========
    /** @type {RangeDependencyIndex} 范围依赖索引 */
    this.rangeDependencyIndex = new RangeDependencyIndex();

    // ========== Numeric 依赖索引（增量维护，热路径只读） ==========
    // 镜像 dependencyMap 的 cells 部分，键值均为 (r<<16)|c 数字键。
    // 在 _updateDependencyMap / _clearDependencyGraph / compactDependencyGraph
    // 写入点同步增删，避免增量重算 BFS 中每次全量重建 + 字符串解析。
    /** @type {Map<number, Set<number>>} numericKey -> Set<dependentNumericKey> */
    this._numericDepIndex = new Map();

    // ========== 持久化存储 ==========
    if (this._enablePersistence) {
      this._storage = new IndexedDBStorage();
      this._dirtyCells = new Map();
      this._persistTimer = null;
    } else {
      this._storage = null;
    }

    // ========== 持久化管理器 ==========
    this._persistenceManager = new PersistenceManager({
      getStorage: () => this._storage,
      setStorage: (s) => { this._storage = s; },
      getDirtyCells: () => this._dirtyCells,
      setDirtyCells: (m) => { this._dirtyCells = m; },
      getSheetId: () => this._sheetId,
      setSheetId: (id) => { this._sheetId = id; },
      getEnablePersistence: () => this._enablePersistence,
      setEnablePersistence: (v) => { this._enablePersistence = v; },
      getRowCount: () => this.rowCount,
      setRowCount: (v) => { this.rowCount = v; },
      getColCount: () => this.colCount,
      setColCount: (v) => { this.colCount = v; },
      getColWidths: () => this.colWidths,
      setColWidths: (v) => { this.colWidths = v; },
      getRowHeights: () => this.rowHeights,
      setRowHeights: (v) => { this.rowHeights = v; },
      getMerges: () => this.merges,
      setMerges: (v) => { this.merges = v; },
      getMergeMap: () => this.mergeMap,
      setMergeMap: (v) => { this.mergeMap = v; },
      getDefaultColWidth: () => this.defaultColWidth,
      setDefaultColWidth: (v) => { this.defaultColWidth = v; },
      getDefaultRowHeight: () => this.defaultRowHeight,
      setDefaultRowHeight: (v) => { this.defaultRowHeight = v; },
      getDataMatrix: () => this._dataMatrix,
      parseKey: (k) => this._parseKey(k),
      setCell: (r, c, v) => this.setCell(r, c, v),
      markOffsetsDirty: () => { this._layoutEngine.markDirty(); },
      notify: (...a) => this.notify(...a),
      getPersistTimer: () => this._persistTimer,
      setPersistTimer: (t) => { this._persistTimer = t; },
    });

    // 异步加载历史数据，实现秒开
    if (this._enablePersistence) {
      this.loadFromStorage(this._sheetId).catch(err => {
        this.errorHandler.handle(
          new SheetError(ErrorCodes.DATA_LOAD_ERROR, 'Failed to auto-load from storage', { originalError: err.message }),
          { sheetId: this._sheetId }
        );
      });
    }

    // ========== 销毁标记 ==========
    this._destroyed = false;
    
    this._autoPersist = false;
    this._persistTimer = null;
   }

  // ========== 单元格键辅助方法 ==========

  /**
   * 生成单元格键
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {string} 单元格键
   */
  _cellKey(r, c) {
    return cellKey(r, c);
  }

  /**
   * 解析单元格键（支持当前字符串格式和旧压缩数字格式）
   * @param {number|string} key - 单元格键
   * @returns {{r: number, c: number}} 行列索引
   */
  _parseKey(key) {
    return parseCellKey(key);
  }

  // ========== 向后兼容属性访问器 ==========
  
  /**
   * @deprecated 每次访问都会调用 `_dataMatrix.toObject(true)` 构造完整 O(N) 副本，
   * 产生大量临时对象。内部代码应直接使用 `getCell(r, c)` 或 `_dataMatrix.forEach`；
   * 此 getter 仅保留供旧版外部调用方读取整表快照。
   * @type {Object} 单元格数据
   */
  get data() {
    return this._dataMatrix.toObject(true);
  }
  set data(val) {
    // 从对象格式导入到稀疏矩阵
    this._dataMatrix.fromObject(val, key => this._parseKey(key));
  }
  
  /** @type {Object} 列宽 */
  get colWidths() { return this._dataStore.getState().colWidths; }
  set colWidths(val) { this._dataStore.setState({ colWidths: val }); }
  
  /** @type {Object} 行高 */
  get rowHeights() { return this._dataStore.getState().rowHeights; }
  set rowHeights(val) { this._dataStore.setState({ rowHeights: val }); }
  
  /** @type {Array} 合并单元格 */
  get merges() { return this._dataStore.getState().merges; }
  set merges(val) { this._dataStore.setState({ merges: val }); }
  
  /** @type {Object} 合并单元格映射 */
  get mergeMap() { return this._dataStore.getState().mergeMap; }
  set mergeMap(val) { this._dataStore.setState({ mergeMap: val }); }
  
  /** @type {Object|null} 选区 */
  get selection() { return this._selectionStore.getState().selection; }
  set selection(val) { this._selectionStore.setState({ selection: val }); }
  
  /** @type {{r: number, c: number}} 活动单元格 */
  get activeCell() { return this._selectionStore.getState().activeCell; }
  set activeCell(val) { this._selectionStore.setState({ activeCell: val }); }
  
  /** @type {{r: number, c: number}} 冻结配置 */
  get freeze() { return this._uiStore.getState().freeze; }
  set freeze(val) { this._uiStore.setState({ freeze: val }); }
  
  /** @type {number} 行数 */
  /**
   * 获取行数
   * @returns {number}
   */
  get rowCount() { 
    if (this._readOnly) {
      const bounds = this._dataMatrix.getBounds();
      return Math.max(1, bounds.maxRow + 1);
    }
    return this._dataStore.getState().rowCount; 
  }
  
  set rowCount(val) { 
    this._dataStore.setState({ rowCount: val });
    this._layoutEngine.markDirty();
  }

  /**
   * 获取列数
   * @returns {number}
   */
  get colCount() { 
    if (this._readOnly) {
      const bounds = this._dataMatrix.getBounds();
      return Math.max(1, bounds.maxCol + 1);
    }
    return this._dataStore.getState().colCount; 
  }
  set colCount(val) { 
    this._dataStore.setState({ colCount: val });
    this._layoutEngine.markDirty();
  }

  /**
   * 获取/设置只读模式
   */
  get readOnly() { return this._readOnly; }
  set readOnly(val) {
    if (this._readOnly !== val) {
      this._readOnly = val;
      this._layoutEngine.markDirty();
      this.notify();
    }
  }
  
  /** @type {number} 默认列宽 */
  get defaultColWidth() { return this._dataStore.getState().defaultColWidth; }
  set defaultColWidth(val) { this._dataStore.setState({ defaultColWidth: val }); }
  
  /** @type {number} 默认行高 */
  get defaultRowHeight() { return this._dataStore.getState().defaultRowHeight; }
  set defaultRowHeight(val) { this._dataStore.setState({ defaultRowHeight: val }); }
  
  /** @type {number} 数据版本 */
  get dataVersion() { return this._dataStore.getState().dataVersion; }
  set dataVersion(val) { this._dataStore.setState({ dataVersion: val }); }
  
  /** @type {Object} 字段映射 */
  get fieldMap() { return this._dataStore.getState().fieldMap; }
  set fieldMap(val) { this._dataStore.setState({ fieldMap: val }); }
  
  /** @type {number} 表头深度 */
  get headerDepth() { return this._dataStore.getState().headerDepth; }
  set headerDepth(val) { this._dataStore.setState({ headerDepth: val }); }
  
  /** @type {Map} 公式依赖映射 */
  get dependencyMap() { return this._dataStore.getState().dependencyMap; }
  set dependencyMap(val) { this._dataStore.setState({ dependencyMap: val }); }
  
  /** @type {Map} 反向依赖映射 */
  get reverseDependencyMap() { return this._dataStore.getState().reverseDependencyMap; }
  set reverseDependencyMap(val) { this._dataStore.setState({ reverseDependencyMap: val }); }
  
  /** @type {Object|null} 复制范围 */
  get copyRange() { return this._selectionStore.getState().copyRange; }
  set copyRange(val) { this._selectionStore.setState({ copyRange: val }); }
  
  /** @type {SearchEngine} 搜索引擎（别名） */
  get search() { return this.searchEngine; }

  /** @type {boolean} 偏移量是否需要重建（代理到 LayoutEngine） */
  get _offsetsDirty() { return this._layoutEngine._offsetsDirty; }
  set _offsetsDirty(val) { if (!val) this._layoutEngine._offsetsDirty = false; else this._layoutEngine.markDirty(); }

  /** @type {Array} 行偏移量数组（代理到 LayoutEngine） */
  get _rowOffsets() { return this._layoutEngine._rowOffsets; }
  set _rowOffsets(val) { this._layoutEngine._rowOffsets = val; }

  /** @type {Array} 列偏移量数组（代理到 LayoutEngine） */
  get _colOffsets() { return this._layoutEngine._colOffsets; }
  set _colOffsets(val) { this._layoutEngine._colOffsets = val; }

  /** @type {boolean} 冻结尺寸是否需要重建（代理到 LayoutEngine） */
  get _frozenSizeDirty() { return this._layoutEngine._frozenSizeDirty; }
  set _frozenSizeDirty(val) { if (!val) this._layoutEngine._frozenSizeDirty = false; else this._layoutEngine.markFrozenDirty(); }

  /** @type {Object|null} 冻结尺寸缓存（代理到 LayoutEngine） */
  get _frozenSize() { return this._layoutEngine._frozenSize; }
  set _frozenSize(val) { this._layoutEngine._frozenSize = val; }

  /** @type {Map} 合并索引（代理到 MergeManager） */
  get _mergeRowIndex() { return this._mergeManager._mergeRowIndex; }

  /** @type {boolean} 合并索引是否需要重建（代理到 MergeManager） */
  get _mergeIndexDirty() { return this._mergeManager._mergeIndexDirty; }
  set _mergeIndexDirty(val) { this._mergeManager._mergeIndexDirty = val; }

  _ensureOffsets() { this._layoutEngine._ensureOffsets(); }

  _updateRowOffsetsFrom(startIndex) { this._layoutEngine._updateRowOffsetsFrom(startIndex); }

  _updateColOffsetsFrom(startIndex) { this._layoutEngine._updateColOffsetsFrom(startIndex); }

  getFrozenSize() { return this._layoutEngine.getFrozenSize(); }

  _clearRowRange(startRow, endRow = -1) { this._layoutEngine._clearRowRange(startRow, endRow); }

  getRowPos(r) { return this._layoutEngine.getRowPos(r); }

  getColPos(c) { return this._layoutEngine.getColPos(c); }

  getRowIndexAt(y) { return this._layoutEngine.getRowIndexAt(y); }

  getColIndexAt(x) { return this._layoutEngine.getColIndexAt(x); }

  get totalWidth() { return this._layoutEngine.totalWidth; }

  get totalHeight() { return this._layoutEngine.totalHeight; }

  getLayoutVersion() { return this._layoutEngine.getLayoutVersion(); }

  setData(data) {
    return this._performanceMonitor.measure(MetricTypes.DATA_SET, () => {
      this._setDataInternal(data);
    }, { dataSize: Array.isArray(data) ? data.length : Object.keys(data).length });
  }
  
  /**
   * 内部方法：设置数据（实际实现）
   * @private
   */
  _setDataInternal(data) {
    const startRow = this.headerDepth > 0 ? this.headerDepth : (Array.isArray(data) ? 1 : 0);
    
    if (Array.isArray(data)) {
      if (data.length === 0) {
        // 优化：使用行范围批量删除，避免遍历所有键
        this._clearRowRange(startRow);
        this.rowCount = Math.max(startRow, 1000);
        this._layoutEngine.markDirty();
        this.dataVersion++;
        this._emit(Events.DATA_LOAD, { action: 'clear' });
        this.notify();
        return;
      }

      if (this.headerDepth === 0) {
        // 无表头模式：完全重建数据（SparseMatrix.clear 会自动触发 onDeleteCell 释放对象池）
        this._dataMatrix.clear();
        this.history = new HistoryManager(this);

        // 关键：在导入前确保依赖图、计算引擎、持久化缓存和物理内存全部清理干净
        if (this.calcEngine) this.calcEngine.reset();
        this._clearDependencyGraph();
        if (this._dirtyCells) this._dirtyCells.clear();
        
        const sharedStore = this._ensureSharedStore();
        if (sharedStore) {
          sharedStore.clear();
        }

        if (Array.isArray(data[0])) {
          // 性能优化：预先获取引用，减少查找开销
          const matrix = this._dataMatrix;
          const pool = this._cellPool;

          for (let r = 0; r < data.length; r++) {
            const row = data[r];
            for (let c = 0; c < row.length; c++) {
              const val = row[c];
              if (val === null || val === undefined) continue;

              // 统一走对象池：确保所有单元格 hidden class 一致，便于 V8 inline-cache
              // 并使删除时通过 onDeleteCell 回收复用；避免与公式/富文本路径产生两套对象形状
              if (typeof val === 'number') {
                matrix.set(r, c, pool.acquireCell(val));
                if (sharedStore) sharedStore.set(r, c, val);
              } else if (val && typeof val === 'object' && (val.f || val.v !== undefined || val.s)) {
                // 富文本/公式/样式单元格：需要拆解对象
                const cellId = this._cellKey(r, c);
                const cell = pool.acquireCell(val.v);
                if (val.f) cell.f = val.f;
                if (val.s) {
                  cell.s = pool._stylePool.acquire();
                  Object.assign(cell.s, val.s);
                }
                
                if (cell.f) {
                  cell.v = undefined; 
                  cell.dirty = true;
                  this._updateDependencyMap(cellId, cell.f);
                }
                matrix.set(r, c, cell);
              } else {
                // 兜底：处理可能的字符串或其他原始值
                matrix.set(r, c, pool.acquireCell(val));
              }
            }
          }
          this.rowCount = Math.max(data.length, 1000);
        } else {
          // 对象数组模式
          const keys = Object.keys(data[0]);
          keys.forEach((key, c) => {
            const cell = this._cellPool.acquireCell(key);
            cell.s = { fontWeight: 'bold' };
            this._dataMatrix.set(0, c, cell);
          });
          data.forEach((rowObj, rIndex) => {
            keys.forEach((key, c) => {
              const val = rowObj[key];
              this._dataMatrix.set(rIndex + 1, c, this._cellPool.acquireCell(val));
              this._syncSharedValue(rIndex + 1, c, val);
            });
          });
          this.rowCount = Math.max(data.length + 1, 1000);
        }
        
        // 关键：触发全局版本更新，迫使 UI 丢弃位图缓存
        this.dataVersion++;
        this.notify({ type: 'all' });
      } else {
        // 有表头模式：增量更新

        // 关键：清理旧依赖图，后续按需重建
        this._clearDependencyGraph();
        if (this._dirtyCells) this._dirtyCells.clear();
        if (this.calcEngine) this.calcEngine.reset();

        // 1. 批量更新数据行
        const fieldMapKeys = this.fieldMap ? Object.keys(this.fieldMap) : [];

        // 使用缓存减少 this.fieldMap 查找次数
        const fieldColMap = this.fieldMap || {};

        data.forEach((rowObj, rIndex) => {
          const tr = startRow + rIndex;
          // 只遍历实际存在的字段，而不是所有字段
          for (const field of fieldMapKeys) {
            const c = fieldColMap[field];
            const val = rowObj[field];

            const existingCell = this._dataMatrix.get(tr, c);
            if (!existingCell) {
              this._dataMatrix.set(tr, c, this._cellPool.acquireCell(val));
            } else {
              existingCell.v = val;
            }

            // 重建公式单元格的依赖
            const cellId = this._cellKey(tr, c);
            const cell = this._dataMatrix.get(tr, c);
            if (cell && cell.f) {
              cell.dirty = true;
              this._updateDependencyMap(cellId, cell.f);
            }

            this._syncSharedValue(tr, c, val);
          }
        });

        // 2. 清除超出新数据长度的行（使用优化的批量删除）
        const maxDataRow = startRow + data.length - 1;
        this._clearRowRange(maxDataRow + 1);

        this.rowCount = Math.max(startRow + data.length, 1000);
      }
    } else {
      // 对象形式更新
      const dataKeys = Object.keys(data);
      for (let i = 0; i < dataKeys.length; i++) {
        const key = dataKeys[i];
        const cellData = data[key];
        if (cellData) {
          const newVal = cloneCell(cellData);
          if (newVal.v && typeof newVal.v === 'string' && newVal.v.startsWith('=')) {
            newVal.f = newVal.v;
          }
          const { r, c } = this._parseKey(key);
          this._dataMatrix.set(r, c, newVal);
          this._syncSharedValue(r, c, newVal.v);
        }
      }
    }
    
    this.dataVersion++;
    this.recalcAll();
    this._layoutEngine.markDirty();
    this._emit(Events.DATA_LOAD, { action: 'setData', count: Array.isArray(data) ? data.length : Object.keys(data).length });
    this.notify();
  }
  setColumns(columns) {
    // Optimization: Do NOT wipe this.data to preserve manual styles.
    
    // Clear merges that intersect with the header area, as headers are about to be rebuilt.
    // Data range merges (if any) should probably be preserved, but for safety in this refactor, 
    // we might need to be careful. History behavior implies merges are mostly for headers or manually added.
    // For now, let's reset merges to be safe as columns structure fundamentally changes.
    this.merges = [];
    this.mergeMap = {};
    
    this.colWidths = {};
    this.fieldMap = {};
    
    if (!columns || columns.length === 0) {
      this.headerDepth = 0;
      return;
    }
    
    const newHeaderDepth = this._calcMaxDepth(columns);
    
    // Clear old header cells to avoid ghosts if new header is shallower
    // We assume any cell with row < newHeaderDepth is a header cell we are about to overwrite.
    // But if old header was deeper, we should clear those too.
    const maxClearDepth = Math.max(this.headerDepth || 0, newHeaderDepth);
    for (let r = 0; r < maxClearDepth; r++) {
      this._dataMatrix.deleteRow(r);
    }

    this.headerDepth = newHeaderDepth;
    let currentCol = 0;
    const totalCols = this._traverseColumns(columns, 0, currentCol);
    // 根据实际列数更新 colCount
    this.colCount = Math.max(totalCols, 1);
    this.dataVersion++;
    this._layoutEngine.markDirty();
    this._emit(Events.STRUCTURE_CHANGE, { action: 'setColumns', count: columns.length });
    this.notify();
  }
  _calcMaxDepth(cols) {
    let max = 1;
    cols.forEach(col => {
      if (col.children && col.children.length > 0) {
        max = Math.max(max, 1 + this._calcMaxDepth(col.children));
      }
    });
    return max;
  }
  _traverseColumns(cols, level, startCol) {
    let currentC = startCol;
    cols.forEach(col => {
      const isLeaf = !col.children || col.children.length === 0;
      if (isLeaf) {
        if (col.field) this.fieldMap[col.field] = currentC;
        if (col.width) this.colWidths[currentC] = col.width;
        const rowSpan = this.headerDepth - level;
        this._dataMatrix.set(level, currentC, {
          v: col.title || col.field,
          s: { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' }
        });
        if (rowSpan > 1) {
          this.addMerge({
            s: { r: level, c: currentC },
            e: { r: level + rowSpan - 1, c: currentC }
          });
        }
        currentC++;
      } else {
        const childrenStartC = currentC;
        const nextC = this._traverseColumns(col.children, level + 1, currentC);
        const colSpan = nextC - childrenStartC;
        this._dataMatrix.set(level, childrenStartC, {
          v: col.title,
          s: { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' }
        });
        if (colSpan > 1) {
          this.addMerge({
            s: { r: level, c: childrenStartC },
            e: { r: level, c: childrenStartC + colSpan - 1 }
          });
        }
        currentC = nextC;
      }
    });
    return currentC;
  }
  /**
   * 获取单元格数据
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {Cell|null} 单元格数据或 null
   */
  getCell(r, c) {
    return this._dataMatrix.get(r, c) || null;
  }
  /**
   * 获取单元格样式
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {CellStyle} 样式对象
   */
  getStyle(r, c) {
    const cell = this.getCell(r, c);
    return (cell && cell.s) ? cell.s : {};
  }

  /**
   * 遍历范围内的所有单元格
   * @param {Object} range - 范围对象 { s: {r, c}, e: {r, c} }
   * @param {Function} callback - 回调函数 (r, c, cell) => void
   */
  iterateRange(range, callback) {
    if (!range) return;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        callback(r, c, this.getCell(r, c));
      }
    }
  }

  /**
   * 遍历范围内的所有单元格并收集结果
   * @param {Object} range - 范围对象 { s: {r, c}, e: {r, c} }
   * @param {Function} callback - 回调函数 (r, c, cell) => any
   * @returns {Array} 收集的结果数组
   */
  collectRange(range, callback) {
    const results = [];
    this.iterateRange(range, (r, c, cell) => {
      results.push(callback(r, c, cell));
    });
    return results;
  }
  /**
   * 内部方法：设置单元格数据（不触发历史记录）
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @param {Partial<Cell>} val - 要设置的属性
   * @private
   */
  _setCellData(r, c, val) {
    let cell = this._dataMatrix.get(r, c);
    if (!cell) {
      // 使用对象池创建单元格
      cell = this._cellPool.acquireCell();
      this._dataMatrix.set(r, c, cell);
    }
    // 直接赋值而不是 Object.assign，避免创建临时对象
    if (val.v !== undefined) cell.v = val.v;
    if (val.f !== undefined) cell.f = val.f;
    if (val.m !== undefined) cell.m = val.m;
    if (val.dirty !== undefined) cell.dirty = val.dirty;
    if (val.s !== undefined) cell.s = val.s;
    
    if (val.v !== undefined) {
      this._syncSharedValue(r, c, val.v);
    }

    this.dataVersion++;
  }

  _syncSharedValue(r, c, value) {
    // 只有在已初始化或环境支持且可能需要（例如正在使用 WASM/Worker）时才同步
    // 这里我们保持按需：如果 store 已存在，则同步
    if (this.sharedValueStore) {
      this.sharedValueStore.set(r, c, value);
    }
  }

  _markCellChanged(r, c) {
    if (!this.calcEngine) return;
    this.calcEngine.markDirtyRC(r, c);
  }
  /**
   * 批量设置单元格
   * @param {Array<{r: number, c: number, val: Partial<Cell>}>} updates - 更新列表
   */
  bulkSetCells(updates) {
    const changes = [];
    
    
    updates.forEach(({r, c, val}) => {
       const rIndex = r;
       const oldVal = cloneCell(this.getCell(rIndex, c));
       let newVal = { ...oldVal, ...val };
       
       if (val.v && typeof val.v === 'string' && val.v.startsWith('=')) {
         newVal.f = val.v;
       } else if (val.v !== undefined) {
         delete newVal.f;
       }

       const cellId = this._cellKey(rIndex, c);
       if (newVal === null || newVal === undefined) {
          this._dataMatrix.delete(rIndex, c);
          this._syncSharedValue(rIndex, c, null);
          this._updateDependencyMap(cellId, null);
       } else {
          this._dataMatrix.set(rIndex, c, newVal);
           if (newVal.f) {
             this._syncSharedValue(rIndex, c, -Infinity);
           } else {
             this._syncSharedValue(rIndex, c, newVal.v);
           }
          if (this._storage) this._dirtyCells.set(cellId, newVal);
          if (newVal.f) {
             this._updateDependencyMap(cellId, newVal.f);
             newVal.dirty = true;
          } else {
             this._updateDependencyMap(cellId, null);
             newVal.dirty = false;
          }
       }
       
       changes.push({ r: rIndex, c, oldValue: oldVal, newValue: newVal });
    });

    updates.forEach(({r, c}) => {
        this._markCellChanged(r, c);
    });

    if (changes.length > 0) {
      this.dataVersion++;
      this.history.execute({
        type: 'batch-set-cell',
        changes
      });
      this._schedulePersistence();
    }
    
    this._layoutEngine.markDirty();
    this.notify();
  }

  /**
   * 设置单元格值（带历史记录）
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @param {Partial<Cell>} val - 要设置的值
   * @param {Cell|null} [optOldValue] - 可选的旧值（用于优化）
   */
  setCell(r, c, val, optOldValue = null) {
    const oldVal = optOldValue || cloneCell(this.getCell(r, c));
    if (val === null || val === undefined) {
      this._updateCellContent(r, c, null);
      this._emit(Events.CELL_CHANGE, { r, c, oldValue: oldVal, newValue: null });
      this.notify({ r, c });
      this.history.execute({ type: 'set-cell', r, c, oldValue: oldVal, newValue: null });
      return;
    }
    let newVal = { ...oldVal, ...val };
    if (val.v && typeof val.v === 'string' && val.v.startsWith('=')) {
      newVal.f = val.v;
      newVal.v = undefined; // 初始化公式单元格值，等待计算引擎异步更新
    } else if (val.v !== undefined) {
      delete newVal.f;
    }
    this._updateCellContent(r, c, newVal);
    this._emit(Events.CELL_CHANGE, { r, c, oldValue: oldVal, newValue: newVal });
    this.notify({ r, c });
    const cmd = {
      type: 'set-cell',
      r, c,
      oldValue: oldVal,
      newValue: newVal
    };
    this.history.execute(cmd);
    
    // 增量计算逻辑由 calcEngine (IncrementalCalculationEngine) 自动处理
    // 避免在每次单元格修改时触发 recalcAll (全量拓扑排序+分组)，以提升大数据下的交互性能
  }
  _updateCellContent(r, c, val) {
    const cellId = this._cellKey(r, c);
    if (val === null || val === undefined) {
      this._dataMatrix.delete(r, c);
      this._syncSharedValue(r, c, null);
      if (this._storage) this._dirtyCells.set(cellId, null);
      this._updateDependencyMap(cellId, null);
    } else {
      this._dataMatrix.set(r, c, val);
      this._syncSharedValue(r, c, val.v);
      if (this._storage) this._dirtyCells.set(cellId, val);

      if (val.f) {
        this._updateDependencyMap(cellId, val.f);
        val.dirty = true;
      } else {
        this._updateDependencyMap(cellId, null);
        val.dirty = false;
      }
    }

    this._markCellChanged(r, c);

    this.dataVersion++;
  }
  /**
   * 重新计算所有公式单元格
   * 优化：使用拓扑排序确保依赖顺序正确，并标记已计算的单元格避免重复计算
   * @param {Object} options - 配置选项
   * @param {boolean} [options.useWorker] - 是否使用 Worker
   * @returns {Promise<void>|void}
   */
  recalcAll(options = {}) {
    // 如果启用 Worker 且支持，使用异步计算
    if (options.useWorker !== false && this._useWorker && this._workerManager) {
      return this._recalcAllWithWorker();
    }
    
    return this._performanceMonitor.measure(MetricTypes.FORMULA_RECALC_ALL, () => {
      this._recalcAllInternal();
    });
  }
  
  /**
   * 使用 Worker 异步计算所有公式
   * @returns {Promise<void>}
   * @private
   */
  async _recalcAllWithWorker() {
    // 如果正在计算，等待完成
    if (this._workerCalculating) {
      return new Promise((resolve, reject) => {
        this._workerQueue.push({ resolve, reject });
      });
    }
    
    this._workerCalculating = true;
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    
    try {
      const formulas = [];
      const nonNumericData = {};
      
      // 核心优化：利用共享内存，Worker 端可以直接读取数字，这里只传公式和非数字内容
      this._dataMatrix.forEach((r, c, cell) => {
        if (cell && cell.f) {
          formulas.push({ cellId: this._cellKey(r, c), formula: cell.f });
        } else if (cell && (typeof cell.v === 'string' || typeof cell.v === 'boolean')) {
          nonNumericData[this._cellKey(r, c)] = { v: cell.v };
        }
      });
      
      if (formulas.length === 0) {
        this._workerCalculating = false;
        this._processWorkerQueue();
        return;
      }

      // 获取当前所有的共享内存句柄
      const sharedChunks = this.sharedValueStore ? this.sharedValueStore.serialize() : null;

      // 发送到 Worker 执行 recalcAll 任务
      const results = await this._workerManager.execute('recalcAll', {
        formulas,
        data: nonNumericData,
        sharedChunks,
        sharedRows: this.sharedValueStore ? this.sharedValueStore.maxRows : undefined,
        sharedCols: this.sharedValueStore ? this.sharedValueStore.maxCols : undefined
      });
      
      // 应用非数字/错误结果 (数字结果已在 Worker 中通过 SharedArrayBuffer 直接写回)
      for (const [cellId, result] of Object.entries(results || {})) {
        const { r, c } = this._parseKey(cellId);
        const cell = this._dataMatrix.get(r, c);
        if (cell) {
          cell.v = result;
          cell.dirty = false;
        }
      }
      
      this._workerCalculating = false;
      this._processWorkerQueue();
      
      if (this.calcEngine) {
        this._recordCalcStats(formulas.length, startTime);
        this.calcEngine.recordWorkerPayloadStats({
          formulaCount: formulas.length,
          cellCount: Object.keys(nonNumericData).length,
          estimatedBytes: JSON.stringify({formulas, data: nonNumericData}).length
        });
      }
      
      // 触发公式计算完成事件，用于脏矩形渲染
      const resultList = Object.entries(results || {}).map(([cellId, value]) => ({ cellId, value }));
      this._emit(Events.FORMULAS_CALCULATED, { results: resultList, count: resultList.length, worker: true });
      
      this.notify();
    } catch (error) {
      this.errorHandler.handle(
        new SheetError(ErrorCodes.OPERATION_FAILED, 'Worker recalc failed, falling back to main thread', { originalError: error.message }),
        { phase: 'recalc' }
      );
      this._workerCalculating = false;
      this._processWorkerQueue();
      // 降级回主线程计算
      this._recalcAllInternal();
    }
  }

  async _recalcDirtyWithWorker(cellIds) {
    const payload = this._buildFormulaWorkerPayload(cellIds);
    if (payload.formulas.length === 0) {
      return {};
    }

    if (this.calcEngine) {
      this.calcEngine.recordWorkerPayloadStats(payload.stats);
    }

    const results = await this._workerManager.execute('evaluateBatch', payload.task);
    for (const [cellId, result] of Object.entries(results || {})) {
      const { r, c } = this._parseKey(cellId);
      const cell = this._dataMatrix.get(r, c);
      if (cell) {
        cell.v = result;
        cell.dirty = false;
        this._syncSharedValue(r, c, result);
      }
    }
    this.notify();
    return results || {};
  }

  /**
   * 生成系统健康与性能报告
   */
  getSystemReport() {
    return {
      version: '0.1.0',
      environment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
        wasmSupported: this.wasmBridge.isLoaded,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        crossOriginIsolated: typeof globalThis.crossOriginIsolated !== 'undefined' ? globalThis.crossOriginIsolated : false
      },
      performance: this._performanceMonitor.getStats(),
      calculation: this.calcEngine.getCacheStats(),
      storage: this._storage ? 'IndexedDB' : 'Memory'
    };
  }

  _buildFormulaWorkerPayload(cellIds) {
    const formulas = [];
    const data = {};
    const coordsByKey = new Map();

    // SAB 优化前提：共享内存可用时，worker 的 dataProvider 对纯数值依赖 SAB 优先读取，
    // 故这类单元格无需重复序列化进 buffer。用 get(r,c)===v 自校验（越界/未同步/不支持均落回保留）。
    const sab = this.sharedValueStore;
    const sabReady = !!(sab && sab.supported);

    const includeCell = (r, c) => {
      if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0) return;
      const key = this._cellKey(r, c);
      if (data[key]) return;
      const cell = this._dataMatrix.get(r, c);

      // 纯数值、无公式且 SAB 中已存同值的依赖单元格：worker 走共享内存读取，跳过序列化。
      // 公式单元格（worker 需递归求值）、字符串/布尔（SAB 存 EMPTY 会回退 data）、
      // 空单元格均不在此跳过（空单元格即便跳过 worker 也返回 null，但保留更直观）。
      if (sabReady && cell && !cell.f) {
        const v = cell.v;
        if (typeof v === 'number' && Number.isFinite(v) && sab.get(r, c) === v) {
          return;
        }
      }

      data[key] = cell
        ? { v: cell.v, f: cell.f, dirty: cell.dirty }
        : { v: null };
      coordsByKey.set(key, { r, c });
    };

    const includeRangeValues = (range) => {
      const rowSpan = range.endR - range.startR + 1;
      const colSpan = range.endC - range.startC + 1;
      const size = rowSpan * colSpan;
      if (size > MAX_INLINE_RANGE_SNAPSHOT_CELLS) {
        this._dataMatrix.iterateRange(
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
      const { r, c } = this._parseKey(cellId);
      const cell = this._dataMatrix.get(r, c);
      if (!cell || !cell.f) continue;

      formulas.push({ cellId, formula: cell.f, r, c });
      includeCell(r, c);

      const deps = this.reverseDependencyMap.get(cellId) || this.getDependencies(cell.f);
      if (deps.cells) {
        for (const depId of deps.cells) {
          const dep = this._parseKey(depId);
          includeCell(dep.r, dep.c);
        }
      }
      if (deps.ranges) {
        for (const range of deps.ranges) {
          includeRangeValues(range);
        }
      }
    }

    const sharedChunks = this.sharedValueStore ? this.sharedValueStore.serialize() : undefined;

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
    // 启发式估算：keys 数量 × 平均每条记录估算字节数
    const formulaBytes = formulas.length * 64;
    const dataKeys = data ? Object.keys(data).length : 0;
    const dataBytes = dataKeys * 48;
    return formulaBytes + dataBytes;
  }
  
  /**
   * 记录公式计算统计信息
   * @private
   */
  _recordCalcStats(count, startTime) {
    if (!this.calcEngine) return;
    this.calcEngine.stats.formulasEvaluated += count;
    this.calcEngine.stats.lastResultCount = count;
    this.calcEngine.stats.batches++;
    this.calcEngine.stats.lastDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
  }

  /**
   * 清空 calcEngine 脏标记队列，阻止增量引擎重复计算
   * @private
   */
  _clearCalcEngineDirty() {
    if (!this.calcEngine) return;
    if (this.calcEngine.dirtyBitset) {
      this.calcEngine.dirtyBitset.clear();
    }
    if (this.calcEngine.batchTimeout) {
      clearTimeout(this.calcEngine.batchTimeout);
      this.calcEngine.batchTimeout = null;
    }
  }

  /**
   * 处理 Worker 队列
   * @private
   */
  _processWorkerQueue() {
    while (this._workerQueue.length > 0) {
      const { resolve } = this._workerQueue.shift();
      resolve();
    }
  }
  
  /**
   * 内部方法：重新计算所有公式（实际实现）
   * @private
   */
  _recalcAllInternal() {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // 收集所有公式单元格
    const formulaCells = [];
    
    this._dataMatrix.forEach((r, c, cell) => {
      if (cell && cell.f) {
        formulaCells.push({
          key: this._cellKey(r, c),
          cell,
          r,
          c
        });
      }
    });
    
    if (formulaCells.length === 0) return;

    const sortedCells = this._topologicalSort(formulaCells);
    
    // 性能优化：优先使用 WASM 批量计算
    if (this.wasmBridge && this.wasmBridge.isLoaded) {
      // 性能优化：按公式结构分组，实现 WASM 的向量化执行 (Vectorized Execution)
      const groupedTasks = new Map();
      
      sortedCells.forEach(sc => {
        // 在单元格级别缓存归一化后的 R1C1 公式
        if (!sc.cell._r1c1) {
          sc.cell._r1c1 = '=' + formulaCompiler.toR1C1(sc.cell.f, this, sc.r, sc.c);
        }
        const f = sc.cell._r1c1;
        
        if (!groupedTasks.has(f)) {
          groupedTasks.set(f, { rows: [], cols: [], ids: [] });
        }
        const group = groupedTasks.get(f);
        group.rows.push(sc.r);
        group.cols.push(sc.c);
        group.ids.push(sc.key);
      });
      
      const nonNumericResults = this.wasmBridge.evaluateGroups(groupedTasks);
      
      // 仅应用非数字/错误结果 (占极少数)，数字结果已极速写回 SharedArrayBuffer 供直接渲染
      if (nonNumericResults) {
        for (const [id, value] of Object.entries(nonNumericResults)) {
          const { r, c } = this._parseKey(id);
          const cell = this._dataMatrix.get(r, c);
          if (cell) cell.v = value;
        }
      }
      
      // 统一标记为非脏
      for (let i = 0; i < sortedCells.length; i++) {
        sortedCells[i].cell.dirty = false;
      }
      
      if (this.calcEngine) {
        this._recordCalcStats(sortedCells.length, startTime);
        this._clearCalcEngineDirty();
      }
    } else {
      // JS 引擎回退
      for (let i = 0; i < sortedCells.length; i++) {
        const { cell, r, c } = sortedCells[i];
        cell.v = this._evaluateFormulaInternal(cell.f, r, c);
        cell.dirty = false;
      }

      if (this.calcEngine) {
        this._recordCalcStats(sortedCells.length, startTime);
        this._clearCalcEngineDirty();
      }
    }
  }

  /**
   * 对公式单元格进行拓扑排序
   * 确保被依赖的单元格先计算
   */
  _topologicalSort(formulaCells) {
    const cellMap = new Map();
    const inDegree = new Map();
    const result = [];
    
    // 初始化
    for (const fc of formulaCells) {
      cellMap.set(fc.key, fc);
      inDegree.set(fc.key, 0);
    }
    
    // 计算入度（只考虑在当前公式单元格集合中的依赖）
    // 性能优化：预先记录哪些位置有公式单元格，以便快速查询
    const formulaCoords = new Set();
    for (const fc of formulaCells) {
      formulaCoords.add(fc.key);
    }

    // 惰性构建的空间索引：按行分桶、桶内按列升序排序，并保留有序的行索引数组。
    // 大范围依赖（如整列 A:A）查询时不再线性扫描所有公式，而是按行范围 + 列二分定位。
    let spatial = null;
    const ensureSpatialIndex = () => {
      if (spatial) return spatial;
      const byRow = new Map();
      for (const fc of formulaCells) {
        let bucket = byRow.get(fc.r);
        if (!bucket) {
          bucket = [];
          byRow.set(fc.r, bucket);
        }
        bucket.push(fc);
      }
      for (const bucket of byRow.values()) {
        bucket.sort((a, b) => a.c - b.c);
      }
      const sortedRows = Array.from(byRow.keys()).sort((a, b) => a - b);
      spatial = { byRow, sortedRows };
      return spatial;
    };
    const lowerBound = (arr, target, keyFn) => {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keyFn(arr[mid]) < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    for (const fc of formulaCells) {
      const deps = this.reverseDependencyMap.get(fc.key);
      if (deps) {
        const upstreamFormulaKeys = new Set();

        // 1. 单元格依赖 (O(1) 查找)
        for (const dep of deps.cells || []) {
          if (cellMap.has(dep)) {
            upstreamFormulaKeys.add(dep);
          }
        }

        // 2. 范围依赖 (优化：通过范围面积与公式数量对比选择最优策略)
        for (const range of deps.ranges || []) {
          const area = (range.endR - range.startR + 1) * (range.endC - range.startC + 1);

          // 如果范围较小，遍历范围内的单元格更高效
          if (area < formulaCells.length) {
            for (let r = range.startR; r <= range.endR; r++) {
              for (let c = range.startC; c <= range.endC; c++) {
                const key = `${r},${c}`;
                // 如果该单元格有公式，且不是当前单元格本身，则添加依赖
                if (key !== fc.key && formulaCoords.has(key)) {
                  upstreamFormulaKeys.add(key);
                }
              }
            }
          } else {
            // 范围巨大（如整列）：使用空间索引按行段 + 列二分定位，
            // 复杂度从 O(公式数) 降至 O(范围内行数 × log(行内公式数) + 命中数)。
            const { byRow, sortedRows } = ensureSpatialIndex();
            let rowIdx = lowerBound(sortedRows, range.startR, v => v);
            while (rowIdx < sortedRows.length && sortedRows[rowIdx] <= range.endR) {
              const row = sortedRows[rowIdx++];
              const bucket = byRow.get(row);
              let colIdx = lowerBound(bucket, range.startC, cell => cell.c);
              while (colIdx < bucket.length && bucket[colIdx].c <= range.endC) {
                const candidate = bucket[colIdx++];
                if (candidate.key !== fc.key) {
                  upstreamFormulaKeys.add(candidate.key);
                }
              }
            }
          }
        }
        inDegree.set(fc.key, inDegree.get(fc.key) + upstreamFormulaKeys.size);
      }
    }
    
    // Kahn 算法
    const queue = [];
    for (const [key, degree] of inDegree) {
      if (degree === 0) {
        queue.push(cellMap.get(key));
      }
    }
    
    let head = 0;
    // 复用 Set，避免每步 new Set() 的 GC 压力
    const affected = new Set();
    while (head < queue.length) {
      const fc = queue[head++];
      result.push(fc);

      // 查找依赖于当前单元格的其他公式单元格
      affected.clear();
      const dependents = this.dependencyMap.get(fc.key);
      if (dependents) {
        for (const depKey of dependents) {
          affected.add(depKey);
        }
      }

      if (this.rangeDependencyIndex) {
        const rangeDependents = this.rangeDependencyIndex.findDependents(fc.r, fc.c);
        for (const depKey of rangeDependents) {
          affected.add(depKey);
        }
      }

      for (const depKey of affected) {
        if (inDegree.has(depKey)) {
          const newDegree = inDegree.get(depKey) - 1;
          inDegree.set(depKey, newDegree);
          if (newDegree === 0) {
            queue.push(cellMap.get(depKey));
          }
        }
      }
    }
    
    // 如果有环，将剩余的单元格加入结果（会检测到循环引用）
    if (result.length < formulaCells.length) {
      const resultKeys = new Set(result.map(fc => fc.key));
      for (const fc of formulaCells) {
        if (!resultKeys.has(fc.key)) {
          result.push(fc);
          resultKeys.add(fc.key);
        }
      }
    }
    
    return result;
  }

  /**
   * 增量重算：只重算脏单元格及其依赖
   */
  recalcDirty() {
    this.calcEngine._processDirtyCells();
  }
  _updateDependencyMap(cellId, formula) {
    const oldDeps = this.reverseDependencyMap.get(cellId);
    if (oldDeps) {
      // 处理旧的单元格依赖
      if (oldDeps.cells) {
        oldDeps.cells.forEach(srcId => {
          const deps = this.dependencyMap.get(srcId);
          if (deps) deps.delete(cellId);
          this._removeNumericDep(srcId, cellId);
        });
      }
      // 处理旧的范围依赖
      if (oldDeps.ranges && oldDeps.ranges.length > 0) {
        this.rangeDependencyIndex.remove(cellId);
      }
      this.reverseDependencyMap.delete(cellId);
    }

    if (!formula) return;

    const { cells, ranges } = this.getDependencies(formula);

    // 注册新的单元格依赖
    cells.forEach(srcId => {
      if (!this.dependencyMap.has(srcId)) {
        this.dependencyMap.set(srcId, new Set());
      }
      this.dependencyMap.get(srcId).add(cellId);
      this._addNumericDep(srcId, cellId);
    });

    // 注册新的范围依赖
    ranges.forEach(range => {
      this.rangeDependencyIndex.add(range, cellId);
    });

    this.reverseDependencyMap.set(cellId, { cells, ranges });
  }

  /**
   * 将字符串单元格键转为 numeric 键 (r<<16)|c；越界或非法返回 -1。
   * 与增量计算引擎使用的编码一致（仅支持 r,c < 65536）。
   * @param {string} id
   * @returns {number}
   */
  _numericKeyFromId(id) {
    const { r, c } = parseCellKey(id);
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r > 0xFFFF || c > 0xFFFF) {
      return -1;
    }
    return cellKeyNumeric(r, c);
  }

  /**
   * 增量索引：登记 srcId 的依赖者 dependentId（与 dependencyMap.add 同步）
   */
  _addNumericDep(srcId, dependentId) {
    const srcNk = this._numericKeyFromId(srcId);
    const depNk = this._numericKeyFromId(dependentId);
    if (srcNk < 0 || depNk < 0) return;
    let set = this._numericDepIndex.get(srcNk);
    if (!set) {
      set = new Set();
      this._numericDepIndex.set(srcNk, set);
    }
    set.add(depNk);
  }

  /**
   * 增量索引：移除 srcId 的依赖者 dependentId（与 dependencyMap.delete 同步）
   */
  _removeNumericDep(srcId, dependentId) {
    const srcNk = this._numericKeyFromId(srcId);
    if (srcNk < 0) return;
    const set = this._numericDepIndex.get(srcNk);
    if (!set) return;
    const depNk = this._numericKeyFromId(dependentId);
    set.delete(depNk);
    if (set.size === 0) {
      this._numericDepIndex.delete(srcNk);
    }
  }

  /**
   * 增量索引：删除某个源单元格的全部出边（与 dependencyMap.delete(srcId) 同步），
   * 供 compactDependencyGraph 清理孤儿条目时调用。
   */
  _dropNumericDepSource(srcId) {
    const srcNk = this._numericKeyFromId(srcId);
    if (srcNk < 0) return;
    this._numericDepIndex.delete(srcNk);
  }

  /**
   * 整体清空依赖图（含 numeric 索引），供导入等批量重置场景复用。
   */
  _clearDependencyGraph() {
    this.dependencyMap.clear();
    this.reverseDependencyMap.clear();
    this._numericDepIndex.clear();
    if (this.rangeDependencyIndex) this.rangeDependencyIndex.clear();
  }
  triggerRecalc(r, c, stack = []) {
    this._markCellChanged(r, c);
  }

  _refToRC(ref) {
    let letter = '';
    let numStr = '';
    for (let i = 0; i < ref.length; i++) {
      const char = ref[i];
      if (char >= 'A' && char <= 'Z') {
        letter += char;
      } else if (char >= '0' && char <= '9') {
        numStr += char;
      }
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
        startR: 0,
        endR: MAX_FORMULA_ROWS - 1,
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
        startC: 0,
        endC: MAX_FORMULA_COLS - 1
      };
    }

    return null;
  }

  _isCellInsideRange(r, c, range) {
    return r >= range.startR && r <= range.endR && c >= range.startC && c <= range.endC;
  }

  getDependencies(formula) {
       if (!formula || !formula.startsWith('=')) return { cells: new Set(), ranges: [] };
       const expression = formula.substring(1).toUpperCase();
       
       const cells = new Set();
       const ranges = [];
       const coveredRanges = [];
       
       // 使用正则简单提取引用（作为过渡方案，未来可由 WASM 提供 AST 分析）
       DEP_RANGE_REGEX.lastIndex = 0;
       DEP_CELL_REGEX.lastIndex = 0;
       const rangeRegex = DEP_RANGE_REGEX;
       const cellRegex = DEP_CELL_REGEX;
       
       let match;
       while ((match = rangeRegex.exec(expression)) !== null) {
           const range = this._rangeRefToBounds(match[0]);
           if (range) {
             ranges.push(range);
             coveredRanges.push(range);
           }
       }
       
       // 排除已包含在范围中的单元格
       while ((match = cellRegex.exec(expression)) !== null) {
           const { r, c } = this._refToRC(match[0]);
           if (coveredRanges.some(range => this._isCellInsideRange(r, c, range))) {
             continue;
           }
           cells.add(this._cellKey(r, c));
       }
       
       const result = { cells, ranges };
       Object.defineProperty(result, 'size', {
         enumerable: false,
         get() {
           return cells.size + ranges.reduce((total, range) => {
             return total + ((range.endR - range.startR + 1) * (range.endC - range.startC + 1));
           }, 0);
         }
       });
       return result;
   }

  evaluateFormula(formula, r, c, stack = []) {
    return this._performanceMonitor.measure(MetricTypes.FORMULA_EVAL, () => {
      const res = this._evaluateFormulaInternal(formula, r, c, stack);
      return (typeof res === 'number' && isNaN(res)) ? "#VALUE!" : res;
    }, { formula: formula.substring(0, 50) });
  }
  
  /**
   * 内部方法：计算公式（实际实现）
   * @private
   */
  _evaluateFormulaInternal(formula, r, c, stack = []) {
     const cellId = this._cellKey(r, c);
     if (stack.includes(cellId)) {
       const error = SheetError.circularReference(this._rcToA1(r, c));
       this.errorHandler.handle(error, { formula, r, c });
       return error.toExcelValue();
     }
     if (!formula.startsWith('=')) return formula;

     try {
          const newStack = [...stack, cellId];
          if (this.wasmBridge && this.wasmBridge.isLoaded) {
            const wasmResult = this.wasmBridge.evaluate(formula);
            if (wasmResult !== '#WAIT!') {
              return wasmResult;
            }
          }
          return this._evaluateFormulaJs(formula, r, c, newStack);
     } catch (e) {
         // 使用错误处理器处理
         const error = e instanceof SheetError ? e : this.errorHandler.handle(e, { formula, r, c });
         return error.toExcelValue();
     }
  }

  _evaluateFormulaJs(formula, r, c, stack = []) {
    // 传入 this 作为 context，开启编译时预解析优化
    const compiledFn = formulaCompiler.compile(formula, this, r, c);
    
    // 复用或初始化执行上下文 (Context)
    if (!this._execCtx) {
      this._execCtx = {
        v: (r, c) => {
          const val = this.getCellValue(r, c, this._currentStack);
          if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
          if (typeof val === 'number' && isNaN(val)) return 0;
          return typeof val === 'number' ? val : (Number(val) || 0);
        },
        r: (sr, sc, er, ec) => {
          const values = [];
          for (let r = sr; r <= er; r++) {
            for (let c = sc; c <= ec; c++) {
              const val = this.getCellValue(r, c, this._currentStack);
              if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
              let n = typeof val === 'number' ? val : (Number(val) || 0);
              values.push(isNaN(n) ? 0 : n);
            }
          }
          return values;
        },
        val: (ref) => {
          const val = this._getFormulaArgumentValue(ref, this._currentStack);
          if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
          if (typeof val === 'number' && isNaN(val)) return 0;
          return typeof val === 'number' ? val : (Number(val) || 0);
        },
        range: (ref) => {
          return this._getFormulaRangeValues(ref, this._currentStack).map(v => {
            if (typeof v === 'string' && v.startsWith('#')) throw new Error(v);
            let n = typeof v === 'number' ? v : (Number(v) || 0);
            return isNaN(n) ? 0 : n;
          });
        },
        // 高性能聚合函数，避免 flat(Infinity)
        sum: (...args) => {
          let s = 0;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) s += (arg[j] || 0);
            } else {
              s += (arg || 0);
            }
          }
          return s;
        },
        average: (...args) => {
          let s = 0, count = 0;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) { s += (arg[j] || 0); count++; }
            } else {
              s += (arg || 0); count++;
            }
          }
          return count === 0 ? 0 : s / count;
        },
        max: (...args) => {
          let m = -Infinity;
          let seen = false;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) {
                const n = arg[j];
                if (typeof n === 'number' && !isNaN(n)) { if (n > m) m = n; seen = true; }
              }
            } else if (typeof arg === 'number' && !isNaN(arg)) {
              if (arg > m) m = arg; seen = true;
            }
          }
          return seen ? m : 0;
        },
        min: (...args) => {
          let m = Infinity;
          let seen = false;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) {
                const n = arg[j];
                if (typeof n === 'number' && !isNaN(n)) { if (n < m) m = n; seen = true; }
              }
            } else if (typeof arg === 'number' && !isNaN(arg)) {
              if (arg < m) m = arg; seen = true;
            }
          }
          return seen ? m : 0;
        },
        count: (...args) => {
          // 仅计数数值（与 Excel 行为一致）
          let n = 0;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) {
                if (typeof arg[j] === 'number' && !isNaN(arg[j])) n++;
              }
            } else if (typeof arg === 'number' && !isNaN(arg)) {
              n++;
            }
          }
          return n;
        },
        counta: (...args) => {
          // 计数所有非空/非 0 值（Excel: COUNTA 计非空，这里近似为非 0/null/undefined）
          let n = 0;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (Array.isArray(arg)) {
              for (let j = 0; j < arg.length; j++) {
                if (arg[j] !== null && arg[j] !== undefined && arg[j] !== '') n++;
              }
            } else if (arg !== null && arg !== undefined && arg !== '') {
              n++;
            }
          }
          return n;
        },
        if: (cond, t, f) => cond ? t : f,
        and: (...args) => args.every(v => !!v),
        or: (...args) => args.some(v => !!v),
        not: (v) => !v,
        len: (v) => String(v || '').length,
        concat: (...args) => args.join('')
      };
    }

    // 设置当前执行上下文需要的变量
    this._currentStack = stack;
    return compiledFn(this._execCtx, r, c);
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
    if (size > MAX_INLINE_RANGE_SNAPSHOT_CELLS) {
      this._dataMatrix.iterateRange(range.startR, range.startC, range.endR, range.endC, (r, c) => {
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

  getCellValue(r, c, stack = []) {
    const cell = this._dataMatrix.get(r, c);
    if (!cell) return null;
    
    // 零拷贝优化：如果启用了共享内存且该单元格是公式，优先从 SharedArrayBuffer 读取最新数值结果
    if (cell.f && this.sharedValueStore) {
      const sharedVal = this.sharedValueStore.get(r, c);
      // 这里的 -Infinity 是 SharedValueStore.EMPTY_VALUE 的字面值
      if (sharedVal !== -Infinity) {
        return sharedVal;
      }
    }
    
    if (cell.f && (cell.dirty || cell.v === undefined)) {
      return this.evaluateFormula(cell.f, r, c, stack);
    }
    return cell.v;
  }
  _colStrToIndex(str) { return colStrToIndex(str); }
  setStyle(range, style) { this._styleManager.setStyle(range, style); }
  /**
   * 设置边框
   * @param {Range} range - 范围对象
   * @param {'all'|'outer'|'inner'|'none'|'left'|'right'|'top'|'bottom'|'color'} type - 边框类型
   * @param {string} [color='#000000'] - 边框颜色
   * @param {string} [style='solid'] - 边框样式
   */
  setBorder(range, type, color, style = 'solid') { this._styleManager.setBorder(range, type, color, style); }
  /**
   * 设置数字格式
   * @param {Range} range - 范围对象
   * @param {'comma'|'percent'|'normal'} fmt - 格式类型
   */
  setFormat(range, fmt) { this._styleManager.setFormat(range, fmt); }
  /**
   * 调整小数位数
   * @param {Range} range - 范围对象
   * @param {number} delta - 变化量（+1 或 -1）
   */
  setDecimals(range, delta) { this._styleManager.setDecimals(range, delta); }
  /**
   * 清除单元格内容（保留样式）
   * @param {Range} range - 范围对象
   */
  clearContent(range) { this._styleManager.clearContent(range); }
  copy(range) {
    this.clipboard.copy(range);
  }
  paste(range) {
    this.clipboard.paste(range);
  }
  toJSON() {
    // 单次遍历直接写出字符串键格式，避免先 toObject(true) 再 _exportDataToStringKeys
    // 造成的双倍 O(N) 临时对象分配。
    const data = {};
    this._dataMatrix.forEach((r, c, cell) => {
      data[cellKey(r, c)] = cell;
    });
    return {
      rowCount: this.rowCount,
      colCount: this.colCount,
      rowHeights: { ...this.rowHeights },
      colWidths: { ...this.colWidths },
      data,
      merges: [...this.merges],
      freeze: { ...this.freeze }
    };
  }
  find(query, startFrom = { r: 0, c: 0 }) {
    return this.searchEngine.find(query, startFrom);
  }
  replaceAll(query, replaceText) {
    return this.searchEngine.replaceAll(query, replaceText);
  }
  fromJSON(json) {
    if (!json) {
      this.errorHandler.handle(
        new SheetError(ErrorCodes.INVALID_ARGUMENT, 'fromJSON: 无效的 JSON 数据'),
        { json }
      );
      return;
    }
    
    try {
      this.history.startBatch();
      this.rowCount = json.rowCount || 1000;
      this.colCount = json.colCount || 200;
      this.rowHeights = json.rowHeights || {};
      this.colWidths = json.colWidths || {};
      
      // 直接导入数据到稀疏矩阵，避免 _migrateData 的键类型问题
      const data = json.data || {};
      this._dataMatrix.clear();
      for (const key of Object.keys(data)) {
        const cellData = data[key];
        if (cellData) {
          const { r, c } = this._parseKey(key);
          // 深拷贝单元格数据
          const cell = { ...cellData };
          // 处理公式
          if (cell.v && typeof cell.v === 'string' && cell.v.startsWith('=')) {
            cell.f = cell.v;
          }
          this._dataMatrix.set(r, c, cell);
        }
      }
      
      this.merges = json.merges || [];
      // 重建合并单元格索引
      this.mergeMap = {};
      this._mergeIndexDirty = true;
      for (const m of this.merges) {
        for (let r = m.s.r; r <= m.e.r; r++) {
          for (let c = m.s.c; c <= m.e.c; c++) {
            this.mergeMap[this._cellKey(r, c)] = m;
          }
        }
      }
      
      this.freeze = json.freeze || { r: 0, c: 0 };
      this.selection = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
      this.activeCell = { r: 0, c: 0 };
      this.rebuildDependencyMap();
      this.history.endBatch();
      // 清除历史记录
      this.history.clear();
      this._layoutEngine.markDirty();
      this.notify();
    } catch (e) {
      const err = this.errorHandler.handle(
        new SheetError(ErrorCodes.DATA_LOAD_ERROR, '从 JSON 加载数据失败', { originalError: e.message }),
        { json }
      );
      throw err;
    }
  }
  rebuildDependencyMap() {
    this._clearDependencyGraph();
    this._dataMatrix.forEach((r, c, cell) => {
      if (cell && cell.f) {
        const key = this._cellKey(r, c);
        this._updateDependencyMap(key, cell.f);
        cell.dirty = true;
      }
    });
  }
  applyCommand(cmd, isUndo) {
    if (cmd.type === 'set-cell') {
      const val = isUndo ? cmd.oldValue : cmd.newValue;
      this._updateCellContent(cmd.r, cmd.c, val);
    } else if (cmd.type === 'batch-set-cell') {
      cmd.changes.forEach(change => {
        const val = isUndo ? change.oldValue : change.newValue;
        this._updateCellContent(change.r, change.c, val);
      });
    } else if (cmd.type === 'move-column') {
      const from = isUndo ? cmd.to : cmd.from;
      const to = isUndo ? cmd.from : cmd.to;
      this._moveColumnData(from, to);
    } else if (cmd.type === 'batch') {
      const cmds = isUndo ? [...cmd.cmds].reverse() : cmd.cmds;
      cmds.forEach(subCmd => this.applyCommand(subCmd, isUndo));
    } else if (cmd.type === 'set-col-width') {
      if (isUndo) this.colWidths[cmd.c] = cmd.oldValue;
      else this.colWidths[cmd.c] = cmd.newValue;
      if (cmd.c < (this.freeze.c || 0)) {
        this._layoutEngine.markFrozenDirty();
      }
    } else if (cmd.type === 'set-row-height') {
      if (isUndo) this.rowHeights[cmd.r] = cmd.oldValue;
      else this.rowHeights[cmd.r] = cmd.newValue;
      if (cmd.r < (this.freeze.r || 0)) {
        this._layoutEngine.markFrozenDirty();
      }
    } else if (cmd.type === 'merge') {
      if (isUndo) this.removeMerge(cmd.range);
      else this.addMerge(cmd.range);
    } else if (cmd.type === 'unmerge') {
      if (isUndo) this.addMerge(cmd.range);
      else this.removeMerge(cmd.range);
    } else if (cmd.type === 'insert-row') {
      if (isUndo) this._deleteRow(cmd.r);
      else this._insertRow(cmd.r);
    } else if (cmd.type === 'delete-row') {
      if (isUndo) {
        // 撤销删除行：先插入空行，然后恢复被删除的数据
        this._insertRow(cmd.r);
        if (cmd.deletedCells) {
          for (const { c, cell } of cmd.deletedCells) {
            if (cell) {
              this._dataMatrix.set(cmd.r, c, cloneCell(cell));
            }
          }
        }
      } else {
        this._deleteRow(cmd.r);
      }
    } else if (cmd.type === 'insert-col') {
      if (isUndo) this._deleteColumn(cmd.c);
      else this._insertColumn(cmd.c);
    } else if (cmd.type === 'delete-col') {
      if (isUndo) {
        // 撤销删除列：先插入空列，然后恢复被删除的数据
        this._insertColumn(cmd.c);
        if (cmd.deletedCells) {
          for (const { r, cell } of cmd.deletedCells) {
            if (cell) {
              this._dataMatrix.set(r, cmd.c, cloneCell(cell));
            }
          }
        }
      } else {
        this._deleteColumn(cmd.c);
      }
    }
    this._layoutEngine.markDirty();
    this.notify();
  }
  undo() {
    this.history.undo();
  }
  redo() {
    this.history.redo();
  }
  /**
   * 获取列宽
   * @param {number} c - 列索引
   * @returns {number} 列宽（像素）
   */
  getColWidth(c) {
    return this.colWidths[c] || this.defaultColWidth;
  }
  /**
   * 设置列宽
   * @param {number} c - 列索引
   * @param {number} w - 宽度（像素）
   */
  setColWidth(c, w) {
    const oldW = this.getColWidth(c);
    this.history.execute({
      type: 'set-col-width',
      c,
      oldValue: oldW,
      newValue: w
    });
    this.colWidths[c] = w;
    // 优化：使用增量更新替代全量重算
    this._updateColOffsetsFrom(c);
    // 如果冻结区域受影响，标记冻结尺寸为脏
    if (c < (this.freeze.c || 0)) {
      this._layoutEngine.markFrozenDirty();
    }
    this.notify();
  }
  /**
   * 获取行高
   * @param {number} r - 行索引
   * @returns {number} 行高（像素）
   */
  getRowHeight(r) {
    return this.rowHeights[r] || this.defaultRowHeight;
  }
  /**
   * 设置行高
   * @param {number} r - 行索引
   * @param {number} h - 高度（像素）
   */
  setRowHeight(r, h) {
    const oldH = this.getRowHeight(r);
    this.history.execute({
      type: 'set-row-height',
      r,
      oldValue: oldH,
      newValue: h
    });
    this.rowHeights[r] = h;
    // 优化：使用增量更新替代全量重算
    this._updateRowOffsetsFrom(r);
    // 如果冻结区域受影响，标记冻结尺寸为脏
    if (r < (this.freeze.r || 0)) {
      this._layoutEngine.markFrozenDirty();
    }
    this.notify();
  }
  /**
   * 设置冻结窗格
   * @param {number} r - 冻结行数
   * @param {number} c - 冻结列数
   */
  setFreeze(r, c) {
    this.freeze = { r, c };
    // 冻结区域变化，标记缓存为脏
    this._layoutEngine.markFrozenDirty();
    this._emit(Events.FREEZE_CHANGE, { r, c });
    this.notify();
  }
  moveColumn(fromC, toC) {
    if (fromC === toC) return;
    const cmd = {
      type: 'move-column',
      from: fromC,
      to: toC
    };
    this._moveColumnData(fromC, toC);
    this.history.execute(cmd);
    this.notify();
  }
  _moveColumnData(fromC, toC) {
    if (fromC === toC) return;
    
    // 性能优化：仅遍历有数据的行进行列交换
    const fromColMap = this._dataMatrix.getCol(fromC);
    const toColMap = this._dataMatrix.getCol(toC);
    
    // 获取所有涉及到的行索引
    const affectedRows = new Set([...fromColMap.keys(), ...toColMap.keys()]);
    
    for (const r of affectedRows) {
      const cellA = fromColMap.get(r);
      const cellB = toColMap.get(r);
      
      // 使用 skipOnDelete = true 避免交换时对象进入回收池
      if (cellB) this._dataMatrix.set(r, fromC, cellB, true);
      else this._dataMatrix.delete(r, fromC, true);
      
      if (cellA) this._dataMatrix.set(r, toC, cellA, true);
      else this._dataMatrix.delete(r, toC, true);
    }
    
    const wA = this.colWidths[fromC];
    const wB = this.colWidths[toC];
    if (wB) this.colWidths[fromC] = wB;
    else delete this.colWidths[fromC];
    if (wA) this.colWidths[toC] = wA;
    else delete this.colWidths[toC];

    this._layoutEngine.markDirty();
  }
  _rebuildMergeIndex() { this._mergeManager._rebuildMergeIndex(); }

  getIntersectingMerges(range) { return this._mergeManager.getIntersectingMerges(range); }

  addMerge(range) { this._mergeManager.addMerge(range); }

  removeMerge(range) { this._mergeManager.removeMerge(range); }

  getMerge(r, c) { return this._mergeManager.getMerge(r, c); }

  setSelection(startR, startC, endR, endC) {
    let s = { r: Math.min(startR, endR), c: Math.min(startC, endC) };
    let e = { r: Math.max(startR, endR), c: Math.max(startC, endC) };
    let expanded = true;
    
    // 使用空间索引优化：只在需要时重建索引
    this._rebuildMergeIndex();
    
    while (expanded) {
      expanded = false;
      // 使用优化的相交查找，只检查与当前选区相交的合并单元格
      const currentRange = { s, e };
      const intersectingMerges = this.getIntersectingMerges(currentRange);
      
      for (let i = 0; i < intersectingMerges.length; i++) {
        const m = intersectingMerges[i];
        const newSR = Math.min(s.r, m.s.r);
        const newSC = Math.min(s.c, m.s.c);
        const newER = Math.max(e.r, m.e.r);
        const newEC = Math.max(e.c, m.e.c);
        if (newSR < s.r || newSC < s.c || newER > e.r || newEC > e.c) {
          s.r = newSR; s.c = newSC;
          e.r = newER; e.c = newEC;
          expanded = true;
          // 选区扩大后需要重新查找相交的合并单元格
          break;
        }
      }
    }
    this.selection = { s, e };
    const anchorMerge = this.getMerge(startR, startC);
    if (anchorMerge) {
      this.activeCell = { r: anchorMerge.s.r, c: anchorMerge.s.c };
    } else {
      this.activeCell = { r: startR, c: startC };
    }
    this._emit(Events.SELECTION_CHANGE, { selection: this.selection, activeCell: this.activeCell });
    // 选区/活动单元格变化用 type:'selection' 标记，让 UI 订阅方只刷新 selection overlay 层
    // 而非走 invalidate(null) 整表重绘。其他订阅者只是多看到一个 type 字段，行为不变。
    this.notify({ type: 'selection' });
  }
  setCopyRange(range) {
    this.copyRange = cloneRange(range);
    this.notify({ type: 'selection' });
  }
  clearCopyRange() {
    this.copyRange = null;
    this.notify({ type: 'selection' });
  }

  /**
   * 批量范围操作：startBatch → 执行变更 → 记录历史 → notify → endBatch
   * @param {Function} mutatorFn - 执行变更并返回 CellChange[] 的回调
   * @private
   */
  _applyBatchRange(mutatorFn) {
    this.history.startBatch();
    const changes = mutatorFn();
    if (changes.length > 0) {
      this.history.execute({ type: 'batch-set-cell', changes });
      this.notify();
    }
    this.history.endBatch();
  }

  mergeCells(range) { this._mergeManager.mergeCells(range); }
  clearCells(range) {
    if (!range) return;
    this._applyBatchRange(() => {
      const changes = [];
      this.iterateRange(range, (r, c, cell) => {
        const oldVal = cell ? cloneCell(cell) : null;
        if (oldVal) {
          this._updateCellContent(r, c, null);
          changes.push({ r, c, oldValue: oldVal, newValue: null });
        }
      });
      return changes;
    });
  }
  unmergeCells(range) { this._mergeManager.unmergeCells(range); }

  allowsMerge(range) { return this._mergeManager.allowsMerge(range); }

  allowsUnmerge(range) { return this._mergeManager.allowsUnmerge(range); }
  fillAuto(sourceRange, targetRange) { this._sheetStructure.fillAuto(sourceRange, targetRange); }

  insertRow(rowIndex) { this._sheetStructure.insertRow(rowIndex); }

  deleteRow(rowIndex) { this._sheetStructure.deleteRow(rowIndex); }

  insertColumn(colIndex) { this._sheetStructure.insertColumn(colIndex); }

  deleteColumn(colIndex) { this._sheetStructure.deleteColumn(colIndex); }

  _shiftDimension(isRow, index, delta) { this._sheetStructure._shiftDimension(isRow, index, delta); }

  _insertRow(r) { this._sheetStructure._insertRow(r); }
  _deleteRow(r) { this._sheetStructure._deleteRow(r); }
  _insertColumn(c) { this._sheetStructure._insertColumn(c); }
  _deleteColumn(c) { this._sheetStructure._deleteColumn(c); }

  getAddress(r, c) {
    const colStr = this._indexToColStr(c);
    return `${colStr}${r + 1}`;
  }
  _indexToColStr(index) {
    let str = '';
    let n = index + 1;
    while (n > 0) {
      let m = (n - 1) % 26;
      str = String.fromCharCode(65 + m) + str;
      n = Math.floor((n - m) / 26);
    }
    return str;
  }

  /**
   * 将行列索引转换为 A1 标记法
   * @private
   */
  _rcToA1(r, c) {
    return this._indexToColStr(c) + (r + 1);
  }
  /**
   * 订阅数据变化（旧版 API，向后兼容）
   * @param {Function} fn - 回调函数
   * @returns {Function} 取消订阅函数
   */
  subscribe(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  /**
   * 订阅特定类型的事件（新版 API）
   * @param {string} event - 事件类型（使用 Events 常量）
   * @param {Function} callback - 回调函数，接收事件数据
   * @returns {Function} 取消订阅函数
   */
  on(event, callback) {
    return this._events.on(event, callback);
  }

  /**
   * 取消订阅事件
   * @param {string} event - 事件类型
   * @param {Function} callback - 回调函数
   */
  off(event, callback) {
    this._events.off(event, callback);
  }

  /**
   * 一次性订阅事件
   * @param {string} event - 事件类型
   * @param {Function} callback - 回调函数
   * @returns {Function} 取消订阅函数
   */
  once(event, callback) {
    return this._events.once(event, callback);
  }

  /**
   * 内部方法：触发事件
   * @param {string} event - 事件类型
   * @param {Object} [payload] - 事件数据
   * @private
   */
  _emit(event, payload) {
    this._events.emit(event, { type: event, ...payload });
    // 同时触发插件钩子
    this.plugins.trigger(event, payload);
  }

  /**
   * 通知所有监听器（旧版 API，向后兼容）
   */
  notify(data = null) {
    // 触发新版通用事件
    this._events.emit(Events.CHANGE, { type: Events.CHANGE, ...data });
    // 触发旧版监听器
    this.listeners.forEach(fn => fn(data));
  }

  /**
   * 获取错误历史
   * @param {number} [limit] - 限制数量
   * @returns {Array} 错误历史
   */
  getErrorHistory(limit) {
    return this.errorHandler.getHistory(limit);
  }

  /**
   * 清空错误历史
   */
  clearErrorHistory() {
    this.errorHandler.clearHistory();
  }

  /**
   * 安全执行操作，错误时触发事件
   * @param {Function} fn - 要执行的函数
   * @param {*} defaultValue - 错误时的默认值
   * @param {Object} [context] - 错误上下文
   * @returns {*} 函数结果或默认值
   */
  safeExecute(fn, defaultValue, context = {}) {
    return this.errorHandler.safeExecute(fn, defaultValue, context);
  }

  /**
   * 注册插件
   * @param {PluginInterface} plugin - 插件实例
   * @param {Object} [options] - 注册选项
   * @returns {Workbook} 返回 this 以支持链式调用
   */
  usePlugin(plugin, options = {}) {
    this.plugins.register(plugin, options);
    return this;
  }

  /**
   * 注销插件
   * @param {string} name - 插件名称
   * @returns {boolean} 是否成功注销
   */
  unusePlugin(name) {
    return this.plugins.unregister(name);
  }

  /**
   * 获取插件实例
   * @param {string} name - 插件名称
   * @returns {PluginInterface|undefined}
   */
  getPlugin(name) {
    return this.plugins.get(name);
  }

  // ========== 性能监控方法 ==========

  /**
   * 设置性能监控阈值警告
   * @private
   */
  _setupPerformanceThresholds() {
    // 设置渲染阈值：超过 100ms 警告
    this._performanceMonitor.setThreshold(MetricTypes.RENDER_FULL, 100, (metric, value) => {
      console.warn(`[Performance] 渲染耗时过长: ${value.toFixed(2)}ms`);
    });
    
    // 设置数据加载阈值：超过 500ms 警告
    this._performanceMonitor.setThreshold(MetricTypes.DATA_SET, 500, (metric, value) => {
      console.warn(`[Performance] 数据加载耗时过长: ${value.toFixed(2)}ms`);
    });
    
    // 设置公式重算阈值：超过 200ms 警告
    this._performanceMonitor.setThreshold(MetricTypes.FORMULA_RECALC_ALL, 200, (metric, value) => {
      console.warn(`[Performance] 公式重算耗时过长: ${value.toFixed(2)}ms`);
    });
  }

  /**
   * 启用 Web Worker 计算
   * @param {Object} [options] - 配置选项
   * @returns {Workbook} 返回 this 以支持链式调用
   */
  enableWorker(options = {}) {
    if (!isWorkerSupported) {
      console.warn('[Workbook] Web Worker not supported in this environment');
      return this;
    }
    
    if (this._workerManager) {
      console.warn('[Workbook] Worker already enabled');
      return this;
    }
    
    try {
      // 创建 Worker 管理器
      this._workerManager = createFormulaWorkerManager({
        timeout: options.timeout || 60000,
        fallbackEnabled: true,
        fallbackExecutor: (type, data) => this._fallbackExecutor(type, data)
      });
      
      this._useWorker = true;
    } catch (error) {
      this.errorHandler.handle(
        new SheetError(ErrorCodes.OPERATION_FAILED, 'Failed to enable Worker', { originalError: error.message }),
        { phase: 'worker-init' }
      );
    }
    
    return this;
  }
  
  /**
   * 禁用 Web Worker 计算
   */
  disableWorker() {
    if (this._workerManager) {
      this._workerManager.destroy();
      this._workerManager = null;
    }
    this._useWorker = false;
  }
  
  /**
   * Worker 降级执行器
   * @param {string} type - 任务类型
   * @param {Object} data - 任务数据
   * @returns {*} 执行结果
   * @private
   */
  _fallbackExecutor(type, data) {
    switch (type) {
      case 'evaluate':
        return this.evaluateFormula(data.formula, data.r, data.c);
      case 'evaluateBatch':
        // 批量计算降级到同步
        const results = {};
        for (const { cellId, formula, r, c } of data.formulas) {
          results[cellId] = this.evaluateFormula(formula, r, c);
        }
        return results;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  }
  
  getWorkerStats() {
    return this._workerManager ? this._workerManager.getStats() : null;
  }

  getCalculationStats() {
    return this.calcEngine ? this.calcEngine.getCacheStats() : null;
  }

  resetCalculationStats() {
    if (this.calcEngine) this.calcEngine.resetStats();
  }

  enablePerformanceMonitoring(options = {}) {
    this._performanceMonitor.enable();
    if (options.thresholds) {
      Object.entries(options.thresholds).forEach(([metric, threshold]) => {
        this._performanceMonitor.setThreshold(metric, threshold, (m, value) => {
          console.warn(`[Performance] ${m} 耗时过长: ${value.toFixed(2)}ms`);
        });
      });
    }
  }

  disablePerformanceMonitoring() {
    this._performanceMonitor.disable();
  }

  isWorkerEnabled() {
    return this._useWorker && this._workerManager !== null;
  }

  getPerformanceReport() {
    return this._performanceMonitor.generateReport();
  }

  exportPerformanceJSON() {
    return this._performanceMonitor.exportJSON();
  }

  exportPerformanceCSV() {
    return this._performanceMonitor.exportCSV();
  }

  printPerformanceSummary() {
    this._performanceMonitor.printSummary();
  }

  /**
   * 获取性能监控器
   * @returns {PerformanceMonitor}
   */
  getPerformanceMonitor() {
    return this._performanceMonitor;
  }

  /**
   * 确保共享数值存储已初始化
   * @returns {SharedValueStore|null}
   * @private
   */
  _ensureSharedStore() {
    if (!this.sharedValueStore) {
      if (typeof SharedArrayBuffer === 'undefined') return null;
      this.sharedValueStore = new SharedValueStore(this._sharedRows, this._sharedCols);
      // 缓冲区扩容时同步更新 WASM 引擎的 grid_rows
      this.sharedValueStore.onGrow = (newRows, newBuffer, newCols) => {
        // 扩容后 SharedArrayBuffer 是新对象，必须重新绑定 WASM 引擎
        wasmBridge.rebindSharedMemory(newBuffer, newRows, newCols);
      };
    }
    return this.sharedValueStore;
  }

  /**
   * 初始化 WASM 计算引擎并绑定内存
   */
  async initWasm() {
    if (this._destroyed) return;
    const success = await wasmBridge.init();
    if (!success) return;

    // 只有在 WASM 加载成功，且环境支持 SharedArrayBuffer 时才尝试绑定内存
    if (typeof SharedArrayBuffer !== 'undefined') {
      const sharedStore = this._ensureSharedStore();
      const sharedBuffer = sharedStore?.getBuffer(); // 这里会触发连续内存分配
      
      if (sharedBuffer) {
        // 使用连续缓冲区的实际行数/列数，而非 maxRows/maxCols，确保 WASM 不会越界读取
        this._sharedCols = sharedStore._continuousCols || sharedStore.maxCols;
        this._sharedRows = Math.floor(sharedBuffer.byteLength / (this._sharedCols * 8));
        const sharedMemoryBound = wasmBridge.bindSharedMemory(sharedBuffer, this._sharedRows, this._sharedCols);
        if (sharedMemoryBound) {
          // WASM Engine & Shared Memory bound
        } else {
          console.warn('[Workbook] WASM Engine loaded, but shared memory was not enabled:', wasmBridge.getStatus().fallbackReason);
        }
      }
    } else {
      wasmBridge.markSharedMemoryUnavailable('SharedArrayBuffer is unavailable. Configure COOP/COEP headers to enable shared memory.');
    }
  }

  /**
   * 释放所有单元格到对象池
   * @private
   */
  _releaseAllCells() {
    this._dataMatrix.forEach((r, c, cell) => {
      if (cell) {
        this._cellPool.releaseCell(cell);
      }
    });
  }

  /**
   * 销毁工作簿，清理所有资源
   */
  destroy() {
    this._destroyed = true;

    // 清理持久化管理器（定时器等）
    this._persistenceManager.destroy();

    // 清理布局引擎
    this._layoutEngine.destroy();

    // 清理合并管理器
    this._mergeManager.destroy();

    // 销毁插件系统
    this.plugins.destroy();
    
    // 清理事件监听器
    this._events.clear();
    this.listeners = [];
    
    // 清理 Store 订阅
    this._storeManager.destroy();
    
    // 清理性能监控器
    this._performanceMonitor.clear();
    
    // 清理 Worker
    if (this._workerManager) {
      this._workerManager.terminate(); // Use terminate for the worker itself
      this._workerManager = null;
    }
    // reject 所有等待中的 worker 队列 Promise
    const err = new Error('Workbook destroyed');
    while (this._workerQueue.length > 0) {
      const { reject } = this._workerQueue.shift();
      reject(err);
    }
    this._workerQueue.clear();
    this._useWorker = false;
    
    // 清理增量计算引擎
    if (this.calcEngine) {
      this.calcEngine.destroy();
    }

    // 清理搜索引擎（解除事件订阅，避免内存泄漏）
    if (this.searchEngine && typeof this.searchEngine.destroy === 'function') {
      this.searchEngine.destroy();
    }
    
    // 释放单元格到对象池
    this._releaseAllCells();
    
    // 清理数据
    this._dataMatrix.clear();
    this.merges = [];
    this.mergeMap = {};
    
    // 清理合并单元格索引
    this._mergeRowIndex.clear();
    this._mergeIndexDirty = true;
    
    // 清理对象池
    if (this._poolManager) {
      this._poolManager.destroy();
    }

    // 清理样式缓存
    if (this.styleCache) {
      this.styleCache.styleMap.clear();
      this.styleCache.styleStore.clear();
    }

    // 关闭 IndexedDB 连接
    if (this._storage) {
      this._storage.close();
    }
  }

  // ========== Store 订阅方法 ==========

  /**
   * 订阅数据状态变化
   * @param {Function} listener - 监听器函数
   * @returns {Function} 取消订阅函数
   */
  subscribeData(listener) {
    return this._dataStore.subscribe(listener);
  }

  /**
   * 订阅选区状态变化
   * @param {Function} listener - 监听器函数
   * @returns {Function} 取消订阅函数
   */
  subscribeSelection(listener) {
    return this._selectionStore.subscribe(listener);
  }

  /**
   * 订阅 UI 状态变化
   * @param {Function} listener - 监听器函数
   * @returns {Function} 取消订阅函数
   */
  subscribeUI(listener) {
    return this._uiStore.subscribe(listener);
  }

  /**
   * 使用选择器订阅状态变化（仅当选择结果变化时触发）
   * @param {string} storeName - Store 名称 ('data', 'selection', 'ui')
   * @param {Function} selector - 选择器函数
   * @param {Function} listener - 监听器函数
   * @returns {Function} 取消订阅函数
   */
  select(storeName, selector, listener) {
    const store = this._storeManager.getStore(storeName);
    if (!store) {
      console.warn(`[Workbook] Store "${storeName}" not found`);
      return () => {};
    }
    return store.select(selector, listener);
  }

  /**
   * 开始批量更新（延迟通知）
   */
  beginBatchUpdate() {
    this._storeManager.beginBatch();
  }

  /**
   * 结束批量更新（触发通知）
   */
  endBatchUpdate() {
    this._storeManager.endBatch();
  }

  /**
   * 获取 Store 管理器
   * @returns {StoreManager}
   */
  getStoreManager() {
    return this._storeManager;
  }

  /**
   * 获取指定的 Store
   * @param {string} name - Store 名称
   * @returns {Store|undefined}
   */
  getStore(name) {
    return this._storeManager.getStore(name);
  }

  // ========== 对象池方法 ==========

  /**
   * 获取对象池统计信息
   * @returns {Object} 池统计信息
   */
  getPoolStats() {
    return this._poolManager.getAllStats();
  }

  /**
   * 预热对象池
   * @param {number} [cellCount=1000] - 预创建单元格数量
   */
  warmupPool(cellCount = 1000) {
    this._cellPool.warmup(cellCount);
  }

  /**
   * 获取对象池管理器
   * @returns {PoolManager}
   */
  getPoolManager() {
    return this._poolManager;
  }

  // ========== 持久化方法 ==========

  async persist(sheetId = 'default') {
    return this._persistenceManager.persist(sheetId);
  }

  enablePersistenceStorage(options = {}) {
    return this._persistenceManager.enablePersistenceStorage(options);
  }

  async loadFromStorage(sheetId = 'default') {
    return this._persistenceManager.loadFromStorage(sheetId);
  }

  _schedulePersistence() {
    this._persistenceManager._schedulePersistence();
  }

  async flushPersistence() {
    return this._persistenceManager.flushPersistence();
  }

  async savePendingChanges(sheetId) {
    return this._persistenceManager.savePendingChanges(sheetId);
  }
}
