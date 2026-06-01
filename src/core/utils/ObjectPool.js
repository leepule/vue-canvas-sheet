/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @fileoverview 对象池实现
 * 用于复用单元格对象，减少 GC 压力，提升大数据操作性能
 */

// dev 模式标志在模块加载时捕获一次，避免 release 热路径反复读 process.env
const IS_DEV = (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'development');
let __nextPoolId = 0;

/**
 * 通用对象池基类
 * @template T
 */
export class ObjectPool {
  /**
   * 创建对象池
   * @param {Function} factory - 创建新对象的工厂函数
   * @param {Function} reset - 重置对象的函数
   * @param {number} [maxSize=10000] - 池最大容量
   */
  constructor(factory, reset, maxSize = 10000) {
    /** @type {Function} */
    this._factory = factory;
    /** @type {Function} */
    this._reset = reset;
    /** @type {number} */
    this._maxSize = maxSize;
    /** @type {T[]} */
    this._pool = [];
    /** 池实例 ID，仅 dev 模式下用于校验 release 来源 */
    this._poolId = IS_DEV ? ++__nextPoolId : 0;

    // 统计信息
    /** @type {number} 从池中获取对象的次数 */
    this._acquireCount = 0;
    /** @type {number} 池为空需要新建的次数 */
    this._missCount = 0;
    /** @type {number} 释放对象到池的次数 */
    this._releaseCount = 0;
    /** @type {number} 因池满而丢弃的次数 */
    this._dropCount = 0;
  }

  /**
   * 从池中获取一个对象
   * @returns {T} 对象实例
   */
  acquire() {
    this._acquireCount++;

    let obj;
    if (this._pool.length > 0) {
      obj = this._pool.pop();
    } else {
      this._missCount++;
      obj = this._factory();
    }
    if (IS_DEV) obj.__pool_id = this._poolId;
    return obj;
  }

  /**
   * 将对象释放回池中
   * @param {T} obj - 要释放的对象
   */
  release(obj) {
    this._releaseCount++;

    if (IS_DEV && obj != null && obj.__pool_id !== this._poolId) {
      // dev 模式断言：释放的对象必须由本池分配，否则提示对象错配（不同池或外部对象）
      console.warn('[ObjectPool] release() received object from a different pool', {
        expected: this._poolId,
        actual: obj.__pool_id
      });
    }

    if (this._pool.length < this._maxSize) {
      this._reset(obj);
      this._pool.push(obj);
    } else {
      this._dropCount++;
    }
  }

  /**
   * 批量释放对象
   * @param {T[]} objects - 要释放的对象数组
   */
  releaseBatch(objects) {
    for (let i = 0; i < objects.length; i++) {
      this.release(objects[i]);
    }
  }

  /**
   * 预热池，预先创建一定数量的对象
   * @param {number} count - 预创建数量
   */
  warmup(count) {
    const toCreate = Math.min(count, this._maxSize - this._pool.length);
    for (let i = 0; i < toCreate; i++) {
      this._pool.push(this._factory());
    }
  }

  /**
   * 清空池
   */
  clear() {
    this._pool = [];
  }

  /**
   * 获取池统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      poolSize: this._pool.length,
      maxSize: this._maxSize,
      acquireCount: this._acquireCount,
      missCount: this._missCount,
      releaseCount: this._releaseCount,
      dropCount: this._dropCount,
      hitRate: this._acquireCount > 0 
        ? ((this._acquireCount - this._missCount) / this._acquireCount * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this._acquireCount = 0;
    this._missCount = 0;
    this._releaseCount = 0;
    this._dropCount = 0;
  }

  /**
   * 获取当前池大小
   * @returns {number}
   */
  get size() {
    return this._pool.length;
  }
}

/**
 * 单元格对象结构
 * @typedef {Object} CellObject
 * @property {*} [v] - 单元格值
 * @property {string} [f] - 公式
 * @property {Object} [s] - 样式
 * @property {string} [m] - 显示文本
 * @property {boolean} [dirty] - 是否需要重算
 */

/**
 * 创建空单元格对象
 * @returns {CellObject}
 */
function createCell() {
  return { v: undefined, s: null, f: null, m: undefined, dirty: false };
}

/**
 * 重置单元格对象
 * @param {CellObject} cell - 要重置的单元格
 */
function resetCell(cell) {
  cell.v = undefined;
  cell.s = null;
  cell.f = null;
  cell.m = undefined;
  cell.dirty = false;
}

/**
 * 单元格对象池
 * 专门用于复用单元格对象
 */
export class CellPool extends ObjectPool {
  /**
   * 创建单元格对象池
   * @param {number} [maxSize=10000] - 池最大容量
   */
  constructor(maxSize = 10000) {
    super(createCell, resetCell, maxSize);
    
    // 样式对象池（嵌套在单元格中）
    /** @type {ObjectPool} */
    this._stylePool = new ObjectPool(
      () => ({}),
      (s) => {
        // 清空样式对象：delete 移除 key，防止 key 集合无限膨胀
        // border 保留空对象结构（清空其属性），避免下游访问 .border.xxx 报错
        const keys = Object.keys(s);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key === 'border') {
            const border = s.border;
            if (border) {
              const borderKeys = Object.keys(border);
              for (let j = 0; j < borderKeys.length; j++) {
                delete border[borderKeys[j]];
              }
            }
          } else {
            delete s[key];
          }
        }
      },
      maxSize
    );
  }

  /**
   * 获取一个单元格对象
   * @param {*} [value] - 初始值
   * @returns {CellObject}
   */
  acquireCell(value) {
    const cell = this.acquire();
    if (value !== undefined) {
      cell.v = value;
    }
    return cell;
  }

  /**
   * 获取一个带样式的单元格对象
   * @param {*} [value] - 初始值
   * @param {Object} [style] - 初始样式
   * @returns {CellObject}
   */
  acquireCellWithStyle(value, style) {
    const cell = this.acquire();
    if (value !== undefined) {
      cell.v = value;
    }
    if (style) {
      cell.s = this._stylePool.acquire();
      Object.assign(cell.s, style);
    }
    return cell;
  }

  /**
   * 释放单元格对象及其样式
   * @param {CellObject} cell - 要释放的单元格
   */
  releaseCell(cell) {
    // 先释放样式对象
    if (cell.s) {
      this._stylePool.release(cell.s);
    }
    // 再释放单元格对象
    this.release(cell);
  }

  /**
   * 批量释放单元格
   * @param {CellObject[]} cells - 要释放的单元格数组
   */
  releaseCells(cells) {
    for (let i = 0; i < cells.length; i++) {
      this.releaseCell(cells[i]);
    }
  }

  /**
   * 获取样式对象池
   * @returns {ObjectPool}
   */
  getStylePool() {
    return this._stylePool;
  }

  /**
   * 获取完整统计信息（包含样式池）
   * @returns {Object}
   */
  getFullStats() {
    return {
      cellPool: this.getStats(),
      stylePool: this._stylePool.getStats()
    };
  }

  /**
   * 清空所有池
   */
  clearAll() {
    this.clear();
    this._stylePool.clear();
  }
}

/**
 * 范围对象池
 * 用于复用范围对象 { s: { r, c }, e: { r, c } }
 */
export class RangePool extends ObjectPool {
  /**
   * 创建范围对象池
   * @param {number} [maxSize=1000] - 池最大容量
   */
  constructor(maxSize = 1000) {
    super(
      () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
      (range) => {
        range.s.r = 0;
        range.s.c = 0;
        range.e.r = 0;
        range.e.c = 0;
      },
      maxSize
    );
  }

  /**
   * 获取一个范围对象
   * @param {number} startR - 起始行
   * @param {number} startC - 起始列
   * @param {number} endR - 结束行
   * @param {number} endC - 结束列
   * @returns {Object} 范围对象
   */
  acquireRange(startR, startC, endR, endC) {
    const range = this.acquire();
    range.s.r = startR;
    range.s.c = startC;
    range.e.r = endR;
    range.e.c = endC;
    return range;
  }
}

// 创建全局默认实例
/** @type {CellPool} */
let defaultCellPool = null;

/** @type {RangePool} */
let defaultRangePool = null;

/**
 * 获取默认单元格对象池
 * @returns {CellPool}
 */
export function getCellPool() {
  if (!defaultCellPool) {
    defaultCellPool = new CellPool();
  }
  return defaultCellPool;
}

/**
 * 获取默认范围对象池
 * @returns {RangePool}
 */
export function getRangePool() {
  if (!defaultRangePool) {
    defaultRangePool = new RangePool();
  }
  return defaultRangePool;
}

/**
 * 重置所有默认池（用于测试或清理）
 */
export function resetDefaultPools() {
  if (defaultCellPool) {
    defaultCellPool.clearAll();
  }
  if (defaultRangePool) {
    defaultRangePool.clear();
  }
}

/**
 * 创建对象池管理器
 * 用于管理多个对象池的统一生命周期
 */
export class PoolManager {
  /**
   * 创建池管理器
   */
  constructor() {
    /** @type {Map<string, ObjectPool>} */
    this._pools = new Map();
    /** @type {CellPool} */
    this._cellPool = new CellPool();
    /** @type {RangePool} */
    this._rangePool = new RangePool();
    
    this._pools.set('cell', this._cellPool);
    this._pools.set('range', this._rangePool);
  }

  /**
   * 获取单元格池
   * @returns {CellPool}
   */
  getCellPool() {
    return this._cellPool;
  }

  /**
   * 获取范围池
   * @returns {RangePool}
   */
  getRangePool() {
    return this._rangePool;
  }

  /**
   * 获取指定池
   * @param {string} name - 池名称
   * @returns {ObjectPool|undefined}
   */
  getPool(name) {
    return this._pools.get(name);
  }

  /**
   * 获取所有池的统计信息
   * @returns {Object}
   */
  getAllStats() {
    const stats = {};
    for (const [name, pool] of this._pools) {
      stats[name] = pool.getStats();
    }
    return stats;
  }

  /**
   * 清空所有池
   */
  clearAll() {
    for (const pool of this._pools.values()) {
      if (pool instanceof CellPool) {
        pool.clearAll();
      } else {
        pool.clear();
      }
    }
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.clearAll();
    this._pools.clear();
  }
}