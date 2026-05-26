/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 共享数值存储引擎
 * 
 * 使用 SharedArrayBuffer 实现跨线程零拷贝数值共享。
 * 采用分块存储策略，平衡内存占用与分配性能。
 */

// 常量定义
const BYTES_PER_CELL = 8; // Float64
const CHUNK_SIZE = 1024;  // 每个分块包含的行数

export class SharedValueStore {
  static EMPTY_VALUE = -Infinity;
  static NON_NUMERIC_VALUE = NaN;

  constructor(maxRows = 100000, maxCols = 256) {
    this.maxRows = maxRows;
    this.maxCols = maxCols;
    this.supported = typeof SharedArrayBuffer !== 'undefined';
    
    /** @type {Map<number, Float64Array>} 分块存储：chunkIndex -> Float64Array */
    this.chunks = new Map();
    /** @type {SharedArrayBuffer|null} 连续缓冲区（仅在需要 WASM 绑定时按需分配） */
    this.continuousBuffer = null;
    /** @type {Float64Array|null} 连续缓冲区的视图 */
    this.continuousView = null;
  }

  /**
   * 清空所有数据
   */
  clear() {
    if (this.continuousView) {
      this.continuousView.fill(SharedValueStore.EMPTY_VALUE);
    }
    for (const view of this.chunks.values()) {
      view.fill(SharedValueStore.EMPTY_VALUE);
    }
    // 释放分块内存
    this.chunks.clear();
  }

  /**
   * 获取或创建一个分块
   * @private
   */
  _getChunk(r) {
    const chunkIdx = Math.floor(r / CHUNK_SIZE);
    let view = this.chunks.get(chunkIdx);
    
    if (!view) {
      if (!this.supported) return null;
      
      try {
        // 分配一个新的分块
        const buffer = new SharedArrayBuffer(CHUNK_SIZE * this.maxCols * BYTES_PER_CELL);
        view = new Float64Array(buffer);
        view.fill(SharedValueStore.EMPTY_VALUE);
        this.chunks.set(chunkIdx, view);
        
        // 如果连续缓冲区已存在，同步该分块的数据到连续缓冲区
        this._syncToContinuous(chunkIdx, view);
      } catch (err) {
        console.warn('[SharedValueStore] 无法分配分块内存:', err);
        return null;
      }
    }
    return view;
  }

  /**
   * 将分块同步到连续缓冲区
   * @private
   */
  _syncToContinuous(chunkIdx, chunkView) {
    if (!this.continuousView) return;
    
    const offset = chunkIdx * CHUNK_SIZE * this.maxCols;
    this.continuousView.set(chunkView, offset);
  }

  /**
   * 设置数值
   * @param {number} r 行
   * @param {number} c 列
   * @param {any} val 值
   */
  set(r, c, val) {
    if (!this.supported) return;
    if (r < 0 || r >= this.maxRows || c < 0 || c >= this.maxCols) return;

    let numericVal;
    if (val === null || val === undefined || val === '') {
      numericVal = SharedValueStore.EMPTY_VALUE;
    } else if (typeof val === 'number') {
      numericVal = val;
    } else if (typeof val === 'string' && (val.startsWith('=') || val.startsWith('#') || val === 'NaN')) {
      // 公式或错误字符串在共享内存中保持 EMPTY 状态，触发 getCellValue 回退到 cell.v
      numericVal = SharedValueStore.EMPTY_VALUE;
    } else {
      const n = parseFloat(val);
      numericVal = isNaN(n) ? SharedValueStore.EMPTY_VALUE : n;
    }

    // 1. 更新分块（懒分配）
    const chunkView = this._getChunk(r);
    if (chunkView) {
      const rowInChunk = r % CHUNK_SIZE;
      chunkView[rowInChunk * this.maxCols + c] = numericVal;
    }

    // 2. 如果已存在连续缓冲区，同步更新
    if (this.continuousView) {
      this.continuousView[r * this.maxCols + c] = numericVal;
    }
  }

  /**
   * 获取数值
   * @param {number} r 行
   * @param {number} c 列
   * @returns {number}
   */
  get(r, c) {
    if (!this.supported) return SharedValueStore.EMPTY_VALUE;
    if (r < 0 || r >= this.maxRows || c < 0 || c >= this.maxCols) return SharedValueStore.EMPTY_VALUE;
    
    // 优先从连续缓冲区获取
    if (this.continuousView) {
      return this.continuousView[r * this.maxCols + c];
    }

    // 否则从分块获取
    const chunkIdx = Math.floor(r / CHUNK_SIZE);
    const view = this.chunks.get(chunkIdx);
    if (!view) return SharedValueStore.EMPTY_VALUE;

    const rowInChunk = r % CHUNK_SIZE;
    return view[rowInChunk * this.maxCols + c];
  }
  
  getValue(r, c) {
    return this.get(r, c);
  }

  /**
   * 获取连续缓冲区（用于 WASM 绑定）
   * 调用此方法会导致一次性分配大块内存
   * @returns {SharedArrayBuffer|null}
   */
  getBuffer() {
    if (!this.supported) return null;
    
    if (!this.continuousBuffer) {
      try {
        console.log(`[SharedValueStore] 正在为 WASM 分配连续内存: ${(this.maxRows * this.maxCols * BYTES_PER_CELL / 1024 / 1024).toFixed(2)} MB`);
        this.continuousBuffer = new SharedArrayBuffer(this.maxRows * this.maxCols * BYTES_PER_CELL);
        this.continuousView = new Float64Array(this.continuousBuffer);
        this.continuousView.fill(SharedValueStore.EMPTY_VALUE);
        
        // 将现有分块同步到连续缓冲区
        for (const [chunkIdx, view] of this.chunks.entries()) {
          this._syncToContinuous(chunkIdx, view);
        }
      } catch (err) {
        console.error('[SharedValueStore] 无法分配连续的 SharedArrayBuffer:', err);
        return null;
      }
    }
    
    return this.continuousBuffer;
  }

  /**
   * 序列化数据（返回分块结构，用于 Worker 零拷贝）
   */
  serialize() {
    if (!this.supported) return null;
    
    const serializedChunks = {};
    for (const [idx, view] of this.chunks.entries()) {
      serializedChunks[idx] = view.buffer; // 传递 SharedArrayBuffer
    }
    
    return {
      chunks: serializedChunks,
      maxRows: this.maxRows,
      maxCols: this.maxCols,
      chunkSize: CHUNK_SIZE
    };
  }

  /**
   * 恢复序列化的数据
   */
  updateFromSerialized(data) {
    if (!this.supported || !data) return;

    if (data instanceof SharedArrayBuffer) {
      // 向后兼容旧格式
      this.continuousBuffer = data;
      this.continuousView = new Float64Array(data);
      return;
    }

    if (data.chunks) {
      this.maxRows = data.maxRows;
      this.maxCols = data.maxCols;
      const chunkSize = data.chunkSize || CHUNK_SIZE;

      for (const idx in data.chunks) {
        const buffer = data.chunks[idx];
        if (buffer instanceof SharedArrayBuffer) {
          this.chunks.set(parseInt(idx, 10), new Float64Array(buffer));
        }
      }
    }
  }

  isEmpty(val) {
    return val === SharedValueStore.EMPTY_VALUE;
  }

  isNonNumeric(val) {
    return isNaN(val) && val !== SharedValueStore.EMPTY_VALUE;
  }
}

export default SharedValueStore;
