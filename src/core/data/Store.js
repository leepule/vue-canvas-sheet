/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { cellKey } from './CellKey.js';

/**
 * @fileoverview 简单的状态管理实现
 * 提供响应式状态、订阅机制和选择器支持
 * 优化版本：支持多种冻结策略，显著提升性能
 */
 
/**
 * @typedef {Function} Unsubscribe - 取消订阅函数
 */
 
/**
 * @typedef {Function} Selector - 状态选择器
 * @param {Object} state - 当前状态
 * @returns {*} 选择的结果
 */
 
/**
 * @typedef {Function} Updater - 状态更新器
 * @param {Object} state - 当前状态
 * @returns {Object} 新状态（部分）
 */
 
/**
 * 简单的状态管理 Store
 * 支持订阅、选择器和不可变更新
 * 性能优化：支持多种冻结策略
 */
export class Store {
  /**
   * 创建 Store 实例
   * @param {Object} initialState - 初始状态
   * @param {Object} [options] - 配置选项
   * @param {string} [options.freezeMode='deep'] - 冻结模式：'deep' | 'shallow' | 'incremental' | 'none'
   */
  constructor(initialState = {}, options = {}) {
    /** @type {Object} 当前状态 */
    this._state = initialState;
    /** @type {Set<Function>} 监听器集合 */
    this._listeners = new Set();

    // 冻结策略：'deep' | 'shallow' | 'incremental' | 'none'
    const defaultMode = typeof process !== 'undefined' && process.env.NODE_ENV === 'development' ? 'incremental' : 'none';
    this._freezeMode = options.freezeMode || defaultMode;
    
    /** @type {boolean} 是否在批量更新中 */
    this._batching = false;
    /** @type {Object|null} 批量更新期间累积的状态变更 */
    this._pendingState = null;
 
    // 冻结性能统计
    this._freezeStats = {
      deepFreezeCalls: 0,
      incrementalFreezeCalls: 0,
      avgFreezeTime: 0,
      totalTime: 0,
    };
 
    // 根据冻结策略初始化状态
    if (this._freezeMode !== 'none') {
      const start = performance.now();
      this._state = this._freezeState(this._state, null);
      this._recordFreezeStats(performance.now() - start);
    }
  }

  /**
   * 记录统计信息
   * @param {number} duration 
   * @private
   */
  _recordFreezeStats(duration) {
    this._freezeStats.totalTime += duration;
    if (this._freezeMode === 'deep') {
      this._freezeStats.deepFreezeCalls++;
    } else if (this._freezeMode === 'incremental') {
      this._freezeStats.incrementalFreezeCalls++;
    }
    const totalCalls = this._freezeStats.deepFreezeCalls + this._freezeStats.incrementalFreezeCalls;
    this._freezeStats.avgFreezeTime = totalCalls > 0 ? this._freezeStats.totalTime / totalCalls : 0;
  }
 
  /**
   * 根据策略冻结状态
   * @param {Object} obj - 要冻结的对象
   * @param {Object} [partialState] - 本次更新的部分状态（用于增量冻结）
   * @returns {Object} 冻结后的对象
   * @private
   */
  _freezeState(obj, partialState = null) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    switch (this._freezeMode) {
      case 'none':
        return obj;
        
      case 'shallow':
        return Object.freeze(obj);
        
      case 'incremental':
        if (partialState) {
          // 增量冻结：只冻结顶层和本次更新的属性
          return this._incrementalFreeze(obj, partialState);
        } else {
          // 初始化时回退到深度冻结
          return this._deepFreeze(obj);
        }
        
      case 'deep':
      default:
        return this._deepFreeze(obj);
    }
  }
 
  /**
   * 深度冻结对象（保留用于完整冻结场景）
   * @param {Object} obj - 要冻结的对象
   * @returns {Object} 冻结后的对象
   * @private
   */
  _deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    // 已经冻结则跳过
    if (Object.isFrozen(obj)) {
      return obj;
    }
    
    // 数组或对象，递归冻结
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (obj[i] !== null && typeof obj[i] === 'object') {
          this._deepFreeze(obj[i]);
        }
      }
    } else {
      Object.keys(obj).forEach(key => {
        const val = obj[key];
        if (val !== null && typeof val === 'object') {
          this._deepFreeze(val);
        }
      });
    }
    
    return Object.freeze(obj);
  }
 
  /**
   * 增量冻结：只冻结顶层和本次更新的属性
   * @param {Object} newState - 新状态
   * @param {Object} partialState - 本次更新的部分状态
   * @returns {Object} 冻结后的新状态
   * @private
   */
  _incrementalFreeze(newState, partialState) {
    // 冻结顶层对象
    if (!Object.isFrozen(newState)) {
      Object.freeze(newState);
    }
    
    // 只冻结本次更新的属性
    Object.keys(partialState).forEach(key => {
      const val = newState[key];
      if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
        // 对本次更新的属性进行深度冻结
        this._deepFreeze(val);
      }
    });
    
    return newState;
  }
 
  /**
   * 获取当前状态（只读）
   * @returns {Object} 当前状态的只读引用
   */
  getState() {
    return this._state;
  }
 
  /**
   * 判断 partial 中每个键的值是否都与当前 state 引用相等。
   * 用于短路完全无变更的 setState / endBatch，避免：
   *   (1) `{ ...prevState, ...partialState }` 的对象分配；
   *   (2) `_freezeState` 在 deep/incremental 模式下的递归冻结开销；
   *   (3) 所有订阅者的 notify 级联（即便订阅者自己会浅比较，函数调用本身仍有代价）。
   * @param {Object} partial - 待应用的部分状态
   * @returns {boolean} 是否存在任一值发生变化
   * @private
   */
  _hasShallowDiff(partial) {
    const state = this._state;
    for (const key in partial) {
      if (partial[key] !== state[key]) return true;
    }
    return false;
  }

  /**
   * 更新状态
   * @param {Updater|Object} updater - 更新器函数或部分状态对象
   */
  setState(updater) {
    const prevState = this._state;

    // 计算新状态
    let partialState;
    if (typeof updater === 'function') {
      partialState = updater(prevState);
    } else {
      partialState = updater;
    }

    if (partialState == null) return;

    // 浅比较短路：所有键都与现状一致则直接返回
    if (!this._batching && !this._hasShallowDiff(partialState)) {
      return;
    }

    // 如果在批量更新中，累积变更
    if (this._batching) {
      this._pendingState = { ...this._pendingState, ...partialState };
      return;
    }

    // 合并状态
    const newState = { ...prevState, ...partialState };

    // 根据冻结策略处理新状态
    if (this._freezeMode !== 'none') {
      const start = performance.now();
      this._state = this._freezeState(newState, partialState);
      this._recordFreezeStats(performance.now() - start);
    } else {
      this._state = newState;
    }

    // 通知监听器
    this._notify(prevState);
  }
 
  /**
   * 开始批量更新
   * 在 endBatch 之前，所有状态更新将被累积
   */
  beginBatch() {
    this._batchDepth = (this._batchDepth || 0) + 1;
    if (this._batchDepth === 1) {
      this._batching = true;
      this._pendingState = {};
    }
  }

  /**
   * 结束批量更新并通知监听器
   */
  endBatch() {
    if (!this._batching) return;

    this._batchDepth = Math.max(0, (this._batchDepth || 1) - 1);
    if (this._batchDepth > 0) return;

    this._batching = false;

    const pending = this._pendingState;
    this._pendingState = null;
    if (!pending || Object.keys(pending).length === 0 || !this._hasShallowDiff(pending)) {
      return;
    }

    const prevState = this._state;
    const newState = { ...prevState, ...pending };

    // 根据冻结策略处理新状态
    if (this._freezeMode !== 'none') {
      const start = performance.now();
      this._state = this._freezeState(newState, pending);

      // 记录性能统计
      const duration = performance.now() - start;
      this._freezeStats.totalTime += duration;
      if (this._freezeMode === 'deep') {
        this._freezeStats.deepFreezeCalls++;
      } else if (this._freezeMode === 'incremental') {
        this._freezeStats.incrementalFreezeCalls++;
      }
      const totalCalls = this._freezeStats.deepFreezeCalls + this._freezeStats.incrementalFreezeCalls;
      this._freezeStats.avgFreezeTime = totalCalls > 0 ? this._freezeStats.totalTime / totalCalls : 0;
    } else {
      this._state = newState;
    }

    this._notify(prevState);
  }
 
  /**
   * 订阅状态变化
   * @param {Function} listener - 监听器函数 (newState, prevState) => void
   * @returns {Unsubscribe} 取消订阅函数
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
 
  /**
   * 使用选择器订阅特定状态变化
   * @param {Selector} selector - 选择器函数
   * @param {Function} listener - 监听器函数 (selectedValue) => void
   * @returns {Unsubscribe} 取消订阅函数
   */
  select(selector, listener) {
    let prevValue = selector(this._state);
    
    const wrappedListener = (newState) => {
      const newValue = selector(newState);
      
      // 浅比较，只有当选择结果变化时才通知
      if (newValue !== prevValue) {
        prevValue = newValue;
        listener(newValue);
      }
    };
    
    // 立即调用一次监听器
    listener(prevValue);
    
    return this.subscribe(wrappedListener);
  }
 
  /**
   * 通知所有监听器
   * @param {Object} prevState - 之前的状态
   * @private
   */
  _notify(prevState) {
    this._listeners.forEach(listener => {
      try {
        listener(this._state, prevState);
      } catch (e) {
        console.error('[Store] Listener error:', e);
      }
    });
  }
 
  /**
   * 清除所有监听器
   */
  clear() {
    this._listeners.clear();
  }
 
  /**
   * 获取冻结性能统计（开发调试用）
   * @returns {Object} 性能统计数据
   */
  getFreezeStats() {
    return {
      ...this._freezeStats,
      freezeMode: this._freezeMode,
      totalCalls: this._freezeStats.deepFreezeCalls + this._freezeStats.incrementalFreezeCalls,
    };
  }
 
  /**
   * 重置冻结性能统计
   */
  resetFreezeStats() {
    this._freezeStats = {
      deepFreezeCalls: 0,
      incrementalFreezeCalls: 0,
      avgFreezeTime: 0,
      totalTime: 0,
    };
  }
 
  /**
   * 获取监听器数量
   * @returns {number}
   */
  get listenerCount() {
    return this._listeners.size;
  }
}
 
/**
 * 数据状态 Store
 * 管理单元格数据、行列尺寸、合并等
 */
export class DataStore extends Store {
  /**
   * 创建 DataStore 实例
   * @param {Object} [initialState] - 初始状态
   * @param {Object} [options] - 配置选项
   * @param {boolean} [options.useCompactKey=true] - 是否使用统一安全键格式
   * @param {string} [options.freezeMode] - 冻结模式
   */
  constructor(initialState = {}, options = {}) {
    super({
      // 单元格数据 { number: Cell } 或 { "r-c": Cell }
      data: {},
      // 列宽 { c: width }
      colWidths: {},
      // 行高 { r: height }
      rowHeights: {},
      // 合并单元格
      merges: [],
      // 合并单元格映射
      mergeMap: {},
      // 行数
      rowCount: 1000,
      // 列数
      colCount: 200,
      // 默认列宽
      defaultColWidth: 100,
      // 默认行高
      defaultRowHeight: 25,
      // 数据版本（用于缓存失效）
      dataVersion: 1,
      // 字段映射
      fieldMap: {},
      // 表头深度
      headerDepth: 0,
      // 公式依赖映射
      dependencyMap: new Map(),
      reverseDependencyMap: new Map(),
      ...initialState
    }, options);
    
    /** @type {boolean} 是否使用统一安全键格式 */
    this._useCompactKey = options.useCompactKey !== false;
  }
 
  /**
   * 生成单元格键
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {number|string} 单元格键
   * @private
   */
  _cellKey(r, c) {
    return this._useCompactKey ? cellKey(r, c) : `${r}-${c}`;
  }
 
  /**
   * 获取单元格
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {Object|null} 单元格数据
   */
  getCell(r, c) {
    const state = this.getState();
    const key = this._cellKey(r, c);
    return state.data[key] || null;
  }
 
  /**
   * 获取列宽
   * @param {number} c - 列索引
   * @returns {number} 列宽
   */
  getColWidth(c) {
    const state = this.getState();
    return state.colWidths[c] || state.defaultColWidth;
  }
 
  /**
   * 获取行高
   * @param {number} r - 行索引
   * @returns {number} 行高
   */
  getRowHeight(r) {
    const state = this.getState();
    return state.rowHeights[r] || state.defaultRowHeight;
  }
 
  /**
   * 获取合并单元格信息
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   * @returns {Object|null} 合并范围
   */
  getMerge(r, c) {
    const state = this.getState();
    const key = this._cellKey(r, c);
    return state.mergeMap[key] || null;
  }
}
 
/**
 * 选区状态 Store
 * 管理选区、活动单元格、复制范围等
 */
export class SelectionStore extends Store {
  /**
   * 创建 SelectionStore 实例
   * @param {Object} [initialState] - 初始状态
   * @param {Object} [options] - 配置选项
   */
  constructor(initialState = {}, options = {}) {
    super({
      // 当前选区 { s: {r, c}, e: {r, c} }
      selection: null,
      // 活动单元格 { r, c }
      activeCell: { r: 0, c: 0 },
      // 复制范围
      copyRange: null,
      ...initialState
    }, options);
  }
 
  /**
   * 获取活动单元格
   * @returns {{r: number, c: number}}
   */
  getActiveCell() {
    return this.getState().activeCell;
  }
 
  /**
   * 获取选区
   * @returns {Object|null}
   */
  getSelection() {
    return this.getState().selection;
  }
}
 
/**
 * UI 状态 Store
 * 管理冻结窗格、滚动位置等 UI 相关状态
 */
export class UIStore extends Store {
  /**
   * 创建 UIStore 实例
   * @param {Object} [initialState] - 初始状态
   * @param {Object} [options] - 配置选项
   */
  constructor(initialState = {}, options = {}) {
    super({
      // 冻结配置 { r, c }
      freeze: { r: 0, c: 0 },
      // 滚动位置
      scrollX: 0,
      scrollY: 0,
      ...initialState
    }, options);
  }
 
  /**
   * 获取冻结配置
   * @returns {{r: number, c: number}}
   */
  getFreeze() {
    return this.getState().freeze;
  }
}
 
/**
 * 创建组合 Store 管理器
 * 将多个 Store 组合在一起，提供统一的访问接口
 */
export class StoreManager {
  /**
   * 创建 StoreManager 实例
   * @param {Object} stores - Store 实例映射
   */
  constructor(stores = {}) {
    /** @type {Map<string, Store>} Store 映射 */
    this._stores = new Map();
    /** @type {Set<Function>} 全局监听器 */
    this._globalListeners = new Set();
    
    Object.entries(stores).forEach(([name, store]) => {
      this.addStore(name, store);
    });
  }
 
  /**
   * 获取 Store
   * @param {string} name - Store 名称
   * @returns {Store|undefined}
   */
  getStore(name) {
    return this._stores.get(name);
  }
 
  /**
   * 添加 Store
   * @param {string} name - Store 名称
   * @param {Store} store - Store 实例
   */
  addStore(name, store) {
    this._stores.set(name, store);
    
    // 自动订阅 Store 变化并转发给全局监听器
    store.subscribe((newState, prevState) => {
      this._globalListeners.forEach(listener => {
        listener(name, newState, prevState);
      });
    });
  }
 
  /**
   * 订阅所有 Store 的变化
   * @param {Function} listener - 监听器 (storeName, newState, prevState) => void
   * @returns {Function} 取消订阅函数
   */
  subscribe(listener) {
    this._globalListeners.add(listener);
    return () => {
      this._globalListeners.delete(listener);
    };
  }
 
  /**
   * 开始批量更新所有 Store
   */
  beginBatch() {
    this._stores.forEach(store => store.beginBatch());
  }
 
  /**
   * 结束批量更新所有 Store
   */
  endBatch() {
    this._stores.forEach(store => store.endBatch());
  }
 
  /**
   * 清除所有 Store 和监听器
   */
  clear() {
    this._stores.forEach(store => store.clear());
    this._stores.clear();
    this._globalListeners.clear();
  }
 
  /**
   * 销毁 StoreManager（别名，与 clear 相同）
   */
  destroy() {
    this.clear();
  }
}
 
export default Store;
