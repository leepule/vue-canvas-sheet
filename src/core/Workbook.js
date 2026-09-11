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

import { cloneCell, cloneRange } from './utils/Clipboard.js';
import { Events } from './events/EventEmitter.js';
import { SheetError, ErrorCodes } from './data/SheetError.js';
import { MetricTypes } from './utils/PerformanceMonitor.js';
import { cellKey, parseCellKey } from './data/CellKey.js';
import { prepareWorkbookJSON } from './data/WorkbookJSONImport.js';
import { WorkbookBuilder } from './builder/WorkbookBuilder.js';
import { parseColumns } from './builder/ColumnParser.js';

/**
 * 工作簿核心数据模型
 * 管理单元格数据、样式、合并、选区、冻结等状态
 */
export class Workbook {
  /**
   * 创建工作簿实例
   * @param {Object} [options={}] - 配置选项
   * @param {boolean} [options.enablePersistence=false] - 是否启用持久化存储
   * @param {boolean|'auto'} [options.enableWasm='auto'] - WASM 初始化模式：
   *        true 立即初始化；false 关闭自动初始化；auto 首次遇到公式时懒加载
   * @param {boolean} [options.debug=false] - 是否输出调试日志
   * @param {boolean} [options.verbose=false] - debug 的别名
   * @param {string} [options.sheetId='default'] - 工作表唯一标识（用于指纹识别与秒开）
   */
  constructor(options = {}) {
    this._wasmInitMode = options.enableWasm === undefined ? 'auto' : options.enableWasm;
    this._wasmInitPromise = null;

    // Phase 6: 委托给 WorkbookBuilder 工厂构造所有子系统
    WorkbookBuilder.build(this, options);

    // Post-init: 异步初始化
    if (this._wasmInitMode === true) {
      this._startWasmInitialization();
    }
    this.plugins.init();
    this._setupPerformanceThresholds();

    // 异步加载持久化数据
    if (this._enablePersistence) {
      this.loadFromStorage(this._sheetId).catch(err => {
        this.errorHandler.handle(
          new SheetError(ErrorCodes.DATA_LOAD_ERROR, 'Failed to auto-load from storage', { originalError: err.message }),
          { sheetId: this._sheetId }
        );
      });
    }
  }

  _startWasmInitialization() {
    if (this._wasmInitPromise) return this._wasmInitPromise;

    this._wasmInitPromise = this._formulaEngine.initWasm().catch(err => {
      this.errorHandler.handle(
        new SheetError(ErrorCodes.OPERATION_FAILED, 'WASM initialization failed', { originalError: err.message }),
        { phase: 'init' }
      );
    });
    return this._wasmInitPromise;
  }

  _maybeStartWasmInitialization() {
    if (this._wasmInitMode === 'auto') {
      this._startWasmInitialization();
    }
  }

  // ================================================================
  //  Phase 1 公共 API 正规化
  //  关闭外部对私有成员的后门访问，为渐进式架构解耦建立正式公共接口
  // ================================================================

  /**
   * 设置渲染调度器回调
   * 由渲染层（CanvasTable）注入，供插件调用以触发重绘
   * @param {Function} scheduler - 渲染回调函数
   */
  setRenderScheduler(scheduler) {
    this._renderScheduler = scheduler;
  }

  /**
   * 请求重新渲染
   * 插件（如协同光标、实时协作）通过此方法触发视图更新
   */
  requestRender() {
    if (typeof this._renderScheduler === 'function') {
      this._renderScheduler();
    }
  }

  /**
   * 获取数据矩阵实例
   * @returns {SparseMatrix} 稀疏矩阵实例
   */
  getDataMatrix() {
    return this._dataMatrix;
  }

  /**
   * 获取脏单元格映射（持久化追踪用）
   * @returns {Map|null} 脏单元格 Map
   */
  getDirtyCells() {
    return this._dirtyCells || null;
  }

  /**
   * 将列索引转换为列字母标识（A, B, ..., Z, AA, AB, ...）
   * @param {number} colIndex - 列索引（从 0 开始）
   * @returns {string} 列字母标识
   */
  indexToColStr(colIndex) {
    return this._indexToColStr(colIndex);
  }

  /**
   * 解析单元格键
   * @param {string} key - 单元格键（如 "r-c"）
   * @returns {{ r: number, c: number }} 行列索引
   */
  parseKey(key) {
    return this._parseKey(key);
  }

  /**
   * 公开的事件触发方法（替代直接访问 _emit）
   * @param {string} event - 事件类型（使用 Events 常量）
   * @param {Object} [payload] - 事件数据
   */
  emitEvent(event, payload) {
    this._emit(event, payload);
  }

  /**
   * 标记布局为脏（触发偏移量重算）
   * 替代直接设置 _offsetsDirty = true
   */
  markLayoutDirty() {
    this._layoutEngine.markDirty();
  }

  // ================================================================
  //  Phase 2: Manager 实例公开化
  //  允许外部直接访问子管理器，减少 Workbook Facade 代理负担
  //  长期推荐使用这些 getter 替代旧的代理方法
  // ================================================================

  /** @returns {import('./LayoutEngine').LayoutEngine} 布局引擎 */
  get layoutEngine() { return this._layoutEngine; }
  /** @returns {import('./MergeManager').MergeManager} 合并单元格管理器 */
  get mergeManager() { return this._mergeManager; }
  /** @returns {import('./StyleManager').StyleManager} 样式管理器 */
  get styleManager() { return this._styleManager; }
  /** @returns {import('./SheetStructure').SheetStructure} 表格结构管理器 */
  get sheetStructure() { return this._sheetStructure; }
  /** @returns {import('./PersistenceManager').PersistenceManager} 持久化管理器 */
  get persistence() { return this._persistenceManager; }
  /** @returns {import('./data/FormulaEngineService').FormulaEngineService} 公式引擎服务 */
  get formulaEngine() { return this._formulaEngine; }
  /** @returns {import('./data/FormulaEvaluator').FormulaEvaluator} 公式求值器 */
  get formulaEvaluator() { return this._formulaEvaluator; }
  /** @returns {import('./SelectionManager.js').SelectionManager} 选区管理器 */
  get selectionManager() { return this._selectionManager; }
  /** @returns {import('./utils/Clipboard.js').ClipboardManager} 剪贴板管理器 */
  get clipboardManager() { return this._clipboardManager || this.clipboard; }

  /**
   * 生成 Store 简单属性代理与 search 别名。
   * 在管理器构造之前调用（后续配置依赖这些访问器）。
   * 注：LayoutEngine/MergeManager 的属性代理与各管理器方法委托已改为显式的类访问器/方法。
   * @private
   */
  _setupStoreAndLayoutAccessors() {
    // ── Store 简单属性代理 ──
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
      const store = this[storeKey];
      Object.defineProperty(this, prop, {
        get: () => store.getState()[prop],
        set: (v) => {
          store.setState({ [prop]: v });
          if (persistedConfigProps.has(prop)) {
            this._persistenceManager?.markConfigDirty();
          }
        },
        enumerable: true, configurable: true,
      });
    }
    // ── search 别名 ──
    Object.defineProperty(this, 'search', {
      get: () => this.searchEngine, enumerable: true, configurable: true,
    });
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
  // 简单 Store 属性通过 _createStoreAccessors() 自动生成
  // 复杂访问器（data, rowCount, colCount, readOnly）保留显式定义

  /**
   * @note 使用 SparseMatrix.version 做版本化脏缓存：仅在矩阵数据发生变更时重建快照，
   * 避免高频读取时反复触发 O(N) 全量拷贝与 GC 压力。
   * 内部代码应优先使用 `getCell(r, c)` 或 `_dataMatrix.forEach`。
   * @type {Object} 单元格数据
   */
  get data() {
    const currentVersion = this._dataMatrix.version;
    if (this._dataCache && this._dataCacheVersion === currentVersion) {
      return this._dataCache;
    }
    this._dataCache = this._dataMatrix.toObject(true);
    this._dataCacheVersion = currentVersion;
    return this._dataCache;
  }
  set data(val) {
    this._dataMatrix.fromObject(val, key => this._parseKey(key));
  }

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
    this._persistenceManager?.markConfigDirty();
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
    this._persistenceManager?.markConfigDirty();
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

  // ── 保留在 Workbook 上的核心快捷 API ──
  getCellValue(r, c, stack = []) { return this._formulaEvaluator.getCellValue(r, c, stack); }

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
    this._dataLoader.load(data);
  }
  setColumns(columns) {
    // Optimization: Do NOT wipe this.data to preserve manual styles.

    // Clear merges that intersect with the header area, as headers are about to be rebuilt.
    // Data range merges (if any) should probably be preserved, but for safety in this refactor,
    // we might need to be careful. History behavior implies merges are mostly for headers or manually added.
    // For now, let's reset merges to be safe as columns structure fundamentally changes.
    this.merges = [];
    this.mergeMap = {};

    if (!columns || columns.length === 0) {
      this.colWidths = {};
      this.fieldMap = {};
      this.headerDepth = 0;
      return;
    }

    const parsedColumns = parseColumns(columns);
    const newHeaderDepth = parsedColumns.headerDepth;

    // Clear old header cells to avoid ghosts if new header is shallower
    // We assume any cell with row < newHeaderDepth is a header cell we are about to overwrite.
    // But if old header was deeper, we should clear those too.
    const maxClearDepth = Math.max(this.headerDepth || 0, newHeaderDepth);
    for (let r = 0; r < maxClearDepth; r++) {
      this._dataMatrix.deleteRow(r);
    }

    this.headerDepth = newHeaderDepth;
    for (const { r, c, val } of parsedColumns.headerCells) {
      this._dataMatrix.set(r, c, val);
    }
    for (const merge of parsedColumns.merges) {
      this._mergeManager.addMerge(merge);
    }

    this.colWidths = parsedColumns.colWidths;
    this.fieldMap = parsedColumns.fieldMap;

    // 根据实际列数更新 colCount
    this.colCount = Math.max(parsedColumns.totalCols, 1);
    this.dataVersion++;
    this._layoutEngine.markDirty();
    this._emit(Events.STRUCTURE_CHANGE, { action: 'setColumns', count: columns.length });
    this.notify();
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

    if (this._storage) {
      this._dirtyCells.set(this._cellKey(r, c), cell);
    }
    this.dataVersion++;
    this._schedulePersistence();
  }

  _syncSharedValue(r, c, value) {
    const store = this._formulaEngine.sharedValueStore;
    if (store) {
      store.set(r, c, value);
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
          this._formulaEvaluator._updateDependencyMap(cellId, null);
       } else {
          this._dataMatrix.set(rIndex, c, newVal);
           if (newVal.f) {
             this._syncSharedValue(rIndex, c, -Infinity);
           } else {
             this._syncSharedValue(rIndex, c, newVal.v);
           }
          if (this._storage) this._dirtyCells.set(cellId, newVal);
          if (newVal.f) {
            this._maybeStartWasmInitialization();
            this._formulaEvaluator._updateDependencyMap(cellId, newVal.f);
             newVal.dirty = true;
          } else {
             this._formulaEvaluator._updateDependencyMap(cellId, null);
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
   * @param {{skipEvent?: boolean, skipHistory?: boolean}} [options] - 选项：
   *   skipEvent 跳过 CELL_CHANGE 事件（协同远程应用防回环广播）；
   *   skipHistory 跳过历史记录（远程变更不应进本地 undo 栈——撤销远程变更不会重广播，
   *   会导致本地与远端永久分叉）。
   */
  setCell(r, c, val, optOldValue = null, options = {}) {
    const { skipEvent = false, skipHistory = false } = options;
    const oldVal = optOldValue || cloneCell(this.getCell(r, c));
    if (val === null || val === undefined) {
      this._updateCellContent(r, c, null);
      if (!skipEvent) this._emit(Events.CELL_CHANGE, { r, c, oldValue: oldVal, newValue: null });
      this.notify({ r, c });
      if (!skipHistory) this.history.execute({ type: 'set-cell', r, c, oldValue: oldVal, newValue: null });
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
    if (!skipEvent) this._emit(Events.CELL_CHANGE, { r, c, oldValue: oldVal, newValue: newVal });
    this.notify({ r, c });
    if (!skipHistory) {
      const cmd = {
        type: 'set-cell',
        r, c,
        oldValue: oldVal,
        newValue: newVal
      };
      this.history.execute(cmd);
    }

    // 增量计算逻辑由 calcEngine (IncrementalCalculationEngine) 自动处理
    // 避免在每次单元格修改时触发 recalcAll (全量拓扑排序+分组)，以提升大数据下的交互性能
  }
  _updateCellContent(r, c, val) {
    const cellId = this._cellKey(r, c);
    if (val === null || val === undefined) {
      this._dataMatrix.delete(r, c);
      this._syncSharedValue(r, c, null);
      if (this._storage) this._dirtyCells.set(cellId, null);
      this._formulaEvaluator._updateDependencyMap(cellId, null);
    } else {
      this._dataMatrix.set(r, c, val);
      this._syncSharedValue(r, c, val.v);
      if (this._storage) this._dirtyCells.set(cellId, val);

      if (val.f) {
        this._maybeStartWasmInitialization();
        this._formulaEvaluator._updateDependencyMap(cellId, val.f);
        val.dirty = true;
      } else {
        this._formulaEvaluator._updateDependencyMap(cellId, null);
        val.dirty = false;
      }
    }

    this._markCellChanged(r, c);

    // dataVersion++ 是 setCell(skipEvent) 下 Search 索引兜底全量重建的唯一依据：
    // skipEvent 会跳过 CELL_CHANGE（Search 增量 patch 收不到），但此处递增使
    // Search 下次 _ensureIndex 检测到版本落后而全量重建。勿移动、勿置于 skipEvent 分支内。
    this.dataVersion++;
    this._schedulePersistence();
  }
  recalcAll(options = {}) {
    if (options.useWorker !== false && this._formulaEngine.isUsingWorker && this._formulaEngine.workerManager) {
      return this._formulaEngine.recalcAllWithWorker().then(result => {
        if (result === null) {
          return this._performanceMonitor.measure(MetricTypes.FORMULA_RECALC_ALL, () => {
            this._formulaEvaluator.recalcAllJS();
          });
        }
      });
    }
    return this._performanceMonitor.measure(MetricTypes.FORMULA_RECALC_ALL, () => {
      this._formulaEvaluator.recalcAllJS();
    });
  }

  getSystemReport() {
    return {
      version: '0.1.0',
      environment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
        wasmSupported: this._formulaEngine.wasmBridge.isLoaded,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        crossOriginIsolated: typeof globalThis.crossOriginIsolated !== 'undefined' ? globalThis.crossOriginIsolated : false
      },
      performance: this._performanceMonitor.getStats(),
      calculation: this.calcEngine.getCacheStats(),
      storage: this._storage ? 'IndexedDB' : 'Memory'
    };
  }

  // setStyle, setBorder, setFormat, setDecimals, clearContent 由 _setupDynamicAccessors() 生成
  copy(range) {
    this.clipboardManager.copy(range);
  }
  paste(range) {
    this.clipboardManager.paste(range);
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
  _captureJSONImportState() {
    const cells = [];
    this._dataMatrix.forEach((r, c, cell) => cells.push({ r, c, cell: cloneCell(cell) }));
    return {
      rowCount: this.rowCount,
      colCount: this.colCount,
      rowHeights: { ...this.rowHeights },
      colWidths: { ...this.colWidths },
      cells,
      merges: [...this.merges],
      mergeMap: { ...this.mergeMap },
      freeze: { ...this.freeze },
      selection: cloneRange(this.selection),
      activeCell: { ...this.activeCell },
      dataVersion: this.dataVersion
    };
  }
  _replaceJSONImportCells(cells) {
    this._dataMatrix.clear();
    const sharedStore = this._formulaEngine._ensureSharedStore();
    if (sharedStore) sharedStore.clear();
    for (const { r, c, cell } of cells) {
      this._dataMatrix.set(r, c, cloneCell(cell));
      this._syncSharedValue(r, c, cell.v);
    }
  }
  _applyJSONImportState(importState) {
    this.rowCount = importState.rowCount;
    this.colCount = importState.colCount;
    this.rowHeights = { ...importState.rowHeights };
    this.colWidths = { ...importState.colWidths };
    this._replaceJSONImportCells(importState.cells);
    this.merges = [...importState.merges];
    this.mergeMap = { ...importState.mergeMap };
    this.freeze = { ...importState.freeze };
    this.selection = importState.selection
      ? cloneRange(importState.selection)
      : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    this.activeCell = importState.activeCell
      ? { ...importState.activeCell }
      : { r: 0, c: 0 };
    this.dataVersion = importState.dataVersion ?? this.dataVersion + 1;
    this._mergeManager._mergeIndexDirty = true;
    this.rebuildDependencyMap();
  }
  _restoreJSONImportState(previousState) {
    this._applyJSONImportState(previousState);
    for (const { r, c, cell } of previousState.cells) {
      const restoredCell = this._dataMatrix.get(r, c);
      if (restoredCell) restoredCell.dirty = cell.dirty;
    }
  }
  fromJSON(json) {
    let previousState;
    try {
      const importState = prepareWorkbookJSON(json);
      previousState = this._captureJSONImportState();
      this._applyJSONImportState(importState);
      this.history.clear();
      this._layoutEngine.markDirty();
      this.notify();
    } catch (e) {
      if (previousState) this._restoreJSONImportState(previousState);
      const err = this.errorHandler.handle(
        new SheetError(ErrorCodes.DATA_LOAD_ERROR, '从 JSON 加载数据失败', { originalError: e.message }),
        { json }
      );
      throw err;
    }
  }
  rebuildDependencyMap() {
    this._formulaEvaluator._clearDependencyGraph();
    let hasFormula = false;
    this._dataMatrix.forEach((r, c, cell) => {
      if (cell && cell.f) {
        if (!hasFormula) {
          this._maybeStartWasmInitialization();
          hasFormula = true;
        }
        const key = this._cellKey(r, c);
        this._formulaEvaluator._updateDependencyMap(key, cell.f);
        cell.dirty = true;
      }
    });
  }
  applyCommand(cmd, isUndo) {
    this._commandExecutor.execute(cmd, isUndo);
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
    const colWidths = { ...this.colWidths };
    colWidths[c] = w;
    this.colWidths = colWidths;
    // 优化：使用增量更新替代全量重算
    this._layoutEngine._updateColOffsetsFrom(c);
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
    const rowHeights = { ...this.rowHeights };
    rowHeights[r] = h;
    this.rowHeights = rowHeights;
    // 优化：使用增量更新替代全量重算
    this._layoutEngine._updateRowOffsetsFrom(r);
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
    const colWidths = { ...this.colWidths };
    if (wB) colWidths[fromC] = wB;
    else delete colWidths[fromC];
    if (wA) colWidths[toC] = wA;
    else delete colWidths[toC];
    this.colWidths = colWidths;

    this._layoutEngine.markDirty();
  }
  // MergeManager 委托方法由 _setupDynamicAccessors() 动态生成

  setSelection(startR, startC, endR, endC) {
    return this._selectionManager.setSelection(startR, startC, endR, endC);
  }
  setCopyRange(range) {
    return this._selectionManager.setCopyRange(range);
  }
  clearCopyRange() {
    return this._selectionManager.clearCopyRange();
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

  // mergeCells 由 _setupDynamicAccessors 动态生成
  clearCells(range) {
    if (!range) return;
    this._applyBatchRange(() => {
      const occupiedCells = [];
      this._dataMatrix.iterateRange(
        range.s.r,
        range.s.c,
        range.e.r,
        range.e.c,
        (r, c) => occupiedCells.push({ r, c })
      );
      const changes = [];
      for (const { r, c } of occupiedCells) {
        const cell = this.getCell(r, c);
        const oldVal = cell ? cloneCell(cell) : null;
        if (oldVal) {
          this._updateCellContent(r, c, null);
          changes.push({ r, c, oldValue: oldVal, newValue: null });
        }
      }
      return changes;
    });
  }
  // unmergeCells, allowsMerge, allowsUnmerge, fillAuto, insertRow, deleteRow,
  // insertColumn, deleteColumn, _shiftDimension, _insertRow, _deleteRow,
  // _insertColumn, _deleteColumn 由 _setupDynamicAccessors() 动态生成

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
   * 通知所有监听器
   */
  notify(data = null) {
    this._events.emit(Events.CHANGE, { type: Events.CHANGE, ...data });
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
   * 安全执行操作，错误时返回默认值（async）
   * @param {Function} fn - 要执行的函数（支持同步或返回 Promise）
   * @param {*} defaultValue - 错误时的默认值
   * @param {Object} [context] - 错误上下文
   * @returns {Promise<*>} 函数结果或默认值（总是 Promise，需 await）
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

  // ========== 性能监控 / Worker / WASM ==========

  _setupPerformanceThresholds() {
    const pm = this._performanceMonitor;
    pm.setThreshold(MetricTypes.RENDER_FULL, 100, (_, v) => console.warn(`[Performance] 渲染耗时过长: ${v.toFixed(2)}ms`));
    pm.setThreshold(MetricTypes.DATA_SET, 500, (_, v) => console.warn(`[Performance] 数据加载耗时过长: ${v.toFixed(2)}ms`));
    pm.setThreshold(MetricTypes.FORMULA_RECALC_ALL, 200, (_, v) => console.warn(`[Performance] 公式重算耗时过长: ${v.toFixed(2)}ms`));
  }

  enableWorker(o = {}) { this._formulaEngine.enableWorker(o); return this; }
  disableWorker() { this._formulaEngine.disableWorker(); }
  isWorkerEnabled() { return this._formulaEngine.isWorkerEnabled(); }
  getWorkerStats() { return this._formulaEngine.getWorkerStats(); }
  getCalculationStats() { return this.calcEngine?.getCacheStats() || null; }
  resetCalculationStats() { if (this.calcEngine) this.calcEngine.resetStats(); }
  _fallbackExecutor(type, data) { return this._formulaEngine._fallbackExecutor(type, data); }
  _ensureSharedStore() { return this._formulaEngine._ensureSharedStore(); }
  async initWasm() {
    this._startWasmInitialization();
    await this._wasmInitPromise;
  }

  getPerformanceMonitor() { return this._performanceMonitor; }
  getPerformanceReport() { return this._performanceMonitor.generateReport(); }
  enablePerformanceMonitoring(o = {}) { this._performanceMonitor.enable(); if (o.thresholds) Object.entries(o.thresholds).forEach(([m, t]) => this._performanceMonitor.setThreshold(m, t, (k, v) => console.warn(`[Performance] ${k}: ${v.toFixed(2)}ms`))); }
  disablePerformanceMonitoring() { this._performanceMonitor.disable(); }
  exportPerformanceJSON() { return this._performanceMonitor.exportJSON(); }
  exportPerformanceCSV() { return this._performanceMonitor.exportCSV(); }
  printPerformanceSummary() { this._performanceMonitor.printSummary(); }


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
    if (this._destroyed) return;
    if (this._persistenceManager.hasPendingChanges()) {
      console.warn(
        '[Workbook] destroy() will discard pending persistence changes. Use await workbook.close() to save before disposal.'
      );
    }
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

    // 清理 Store 订阅
    this._storeManager.destroy();

    // 清理性能监控器
    this._performanceMonitor.clear();

    // 清理公式引擎服务（Worker + WASM + 共享内存）
    this._formulaEngine.destroy();

    // 清理增量计算引擎
    if (this.calcEngine) {
      this.calcEngine.destroy();
    }

    // 清理搜索引擎（解除事件订阅，避免内存泄漏）
    if (this.searchEngine && typeof this.searchEngine.destroy === 'function') {
      this.searchEngine.destroy();
    }

    if (this._selectionManager && typeof this._selectionManager.destroy === 'function') {
      this._selectionManager.destroy();
    }

    if (this._clipboardManager && typeof this._clipboardManager.destroy === 'function') {
      this._clipboardManager.destroy();
    }

    // 释放单元格到对象池
    this._releaseAllCells();

    // 清理数据
    this._dataMatrix.clear();
    this.merges = [];
    this.mergeMap = {};

    // 清理合并单元格索引
    this._mergeManager._mergeRowIndex.clear();
    this._mergeManager._mergeIndexDirty = true;

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

  close() {
    if (this._closePromise) return this._closePromise;
    if (this._destroyed) return Promise.resolve();

    this._closing = true;
    const closePromise = this._persistenceManager.close()
      .then(() => this.destroy())
      .catch(error => {
        this._closing = false;
        this._closePromise = null;
        throw error;
      });
    this._closePromise = closePromise;
    return closePromise;
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

const WORKBOOK_LEGACY_MANAGER_METHODS = {
  layoutEngine: {
    getFrozenSize: 'getFrozenSize',
    getRowPos: 'getRowPos',
    getColPos: 'getColPos',
    getRowIndexAt: 'getRowIndexAt',
    getColIndexAt: 'getColIndexAt',
    getLayoutVersion: 'getLayoutVersion'
  },
  mergeManager: {
    addMerge: 'addMerge',
    removeMerge: 'removeMerge',
    getMerge: 'getMerge',
    mergeCells: 'mergeCells',
    unmergeCells: 'unmergeCells',
    allowsMerge: 'allowsMerge',
    allowsUnmerge: 'allowsUnmerge',
    getIntersectingMerges: 'getIntersectingMerges'
  },
  styleManager: {
    setStyle: 'setStyle',
    setBorder: 'setBorder',
    setFormat: 'setFormat',
    setDecimals: 'setDecimals',
    clearContent: 'clearContent'
  },
  sheetStructure: {
    fillAuto: 'fillAuto',
    insertRow: 'insertRow',
    deleteRow: 'deleteRow',
    insertColumn: 'insertColumn',
    deleteColumn: 'deleteColumn',
    _shiftDimension: '_shiftDimension',
    _insertRow: '_insertRow',
    _deleteRow: '_deleteRow',
    _insertColumn: '_insertColumn',
    _deleteColumn: '_deleteColumn'
  }
};

function installWorkbookLegacyManagerFacade() {
  for (const [managerName, methods] of Object.entries(WORKBOOK_LEGACY_MANAGER_METHODS)) {
    for (const [workbookMethod, managerMethod] of Object.entries(methods)) {
      if (Object.prototype.hasOwnProperty.call(Workbook.prototype, workbookMethod)) continue;
      Object.defineProperty(Workbook.prototype, workbookMethod, {
        value(...args) {
          return this[managerName][managerMethod](...args);
        },
        writable: true,
        configurable: true
      });
    }
  }

  Object.defineProperties(Workbook.prototype, {
    totalWidth: {
      get() { return this.layoutEngine.totalWidth; },
      configurable: true
    },
    totalHeight: {
      get() { return this.layoutEngine.totalHeight; },
      configurable: true
    }
  });
}

installWorkbookLegacyManagerFacade();
