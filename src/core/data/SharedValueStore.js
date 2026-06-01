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
    /** @type {number} 连续缓冲区实际分配的列数（用于索引计算） */
    this._continuousCols = 0;
    /** @type {Function|null} 缓冲区扩容回调（通知 WASM 更新 grid_rows） */
    this.onGrow = null;

    // 实际使用量追踪（用于按需分配连续缓冲区）
    this._actualMaxRow = -1;
    this._actualMaxCol = -1;
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

    const offset = chunkIdx * CHUNK_SIZE * this._continuousCols;
    // chunk 的列数可能大于连续缓冲区的列数，只同步重叠部分
    const copyLen = Math.min(chunkView.length, this.continuousView.length - offset);
    if (copyLen <= 0) return;

    const srcCols = this.maxCols;
    const dstCols = this._continuousCols;

    // 快路径：源/目标列数相同（列数稳定的常见情况），行布局完全一致，
    // 整个重叠区域可用 TypedArray.set 一次 memcpy 拷贝。
    if (srcCols === dstCols) {
      this.continuousView.set(chunkView.subarray(0, copyLen), offset);
      return;
    }

    // 兜底：列数不同，逐行批量拷贝重叠列（仍用 set 避免逐元素标量写）
    const chunkRows = Math.min(CHUNK_SIZE, Math.floor(chunkView.length / srcCols));
    const rowCopy = Math.min(srcCols, dstCols);
    for (let r = 0; r < chunkRows; r++) {
      const srcOff = r * srcCols;
      const dstOff = offset + r * dstCols;
      if (dstOff + dstCols > this.continuousView.length) break;
      this.continuousView.set(chunkView.subarray(srcOff, srcOff + rowCopy), dstOff);
    }
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

    // 追踪实际使用量
    if (r > this._actualMaxRow) this._actualMaxRow = r;
    if (c > this._actualMaxCol) this._actualMaxCol = c;

    // 1. 更新分块（懒分配）
    const chunkView = this._getChunk(r);
    if (chunkView) {
      const rowInChunk = r % CHUNK_SIZE;
      chunkView[rowInChunk * this.maxCols + c] = numericVal;
    }

    // 2. 如果已存在连续缓冲区，同步更新（超出范围时扩容）
    if (this.continuousView) {
      const idx = r * this._continuousCols + c;
      if (idx < this.continuousView.length) {
        this.continuousView[idx] = numericVal;
      } else {
        this._growContinuousBuffer(r + 1, c + 1);
        this.continuousView[r * this._continuousCols + c] = numericVal;
      }
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
      const idx = r * this._continuousCols + c;
      return idx < this.continuousView.length ? this.continuousView[idx] : SharedValueStore.EMPTY_VALUE;
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
   * 按实际使用量分配，避免预分配 195MB
   * @returns {SharedArrayBuffer|null}
   */
  getBuffer() {
    if (!this.supported) return null;

    if (!this.continuousBuffer) {
      try {
        // 按实际使用量分配，带 2x 增长余量，最少 1024 行减少初期扩容次数，上限为 maxRows × maxCols
        const rows = Math.min(Math.max((this._actualMaxRow + 1) * 2, 1024), this.maxRows);
        const cols = Math.min(Math.max((this._actualMaxCol + 1) * 2, 1), this.maxCols);
        const size = rows * cols * BYTES_PER_CELL;

        console.log(`[SharedValueStore] 正在为 WASM 分配连续内存: ${(size / 1024 / 1024).toFixed(2)} MB (${rows} rows × ${cols} cols)`);
        this.continuousBuffer = new SharedArrayBuffer(size);
        this.continuousView = new Float64Array(this.continuousBuffer);
        this.continuousView.fill(SharedValueStore.EMPTY_VALUE);
        this._continuousCols = cols;

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
   * 扩容连续缓冲区（当写入超出当前分配时调用）
   * @private
   */
  _growContinuousBuffer(needRows, needCols) {
    // 列数：按需增长，不盲目翻倍（列数通常稳定）
    const newCols = Math.min(Math.max(needCols, this._continuousCols), this.maxCols);
    // 行数：当前 2 倍或按需，取较大值（避免频繁扩容）
    const currentRows = Math.floor(this.continuousView.length / this._continuousCols);
    const newRows = Math.min(Math.max(needRows, currentRows * 2), this.maxRows);
    const newSize = newRows * newCols * BYTES_PER_CELL;

    console.log(`[SharedValueStore] 扩容连续缓冲区: ${(newSize / 1024 / 1024).toFixed(2)} MB (${newRows} rows × ${newCols} cols)`);

    const newBuffer = new SharedArrayBuffer(newSize);
    const newView = new Float64Array(newBuffer);
    newView.fill(SharedValueStore.EMPTY_VALUE);

    // 迁移旧数据
    const oldRows = Math.floor(this.continuousView.length / this._continuousCols);
    const copyRows = Math.min(oldRows, newRows);
    const copyCols = Math.min(this._continuousCols, newCols);

    // 快路径：列数不变（仅行增长，最常见的扩容场景），旧数据行布局与新缓冲区
    // 前缀完全一致，整块用 TypedArray.set 一次 memcpy 迁移。
    if (this._continuousCols === newCols) {
      const copyLen = copyRows * newCols;
      newView.set(this.continuousView.subarray(0, copyLen), 0);
    } else {
      // 兜底：列数变化，逐行批量拷贝重叠列（仍用 set 避免逐元素标量写）
      for (let r = 0; r < copyRows; r++) {
        const srcOffset = r * this._continuousCols;
        const dstOffset = r * newCols;
        newView.set(this.continuousView.subarray(srcOffset, srcOffset + copyCols), dstOffset);
      }
    }

    this.continuousBuffer = newBuffer;
    this.continuousView = newView;
    this._continuousCols = newCols;

    // 通知外部（如 WASM 引擎）重新绑定共享内存
    if (this.onGrow) this.onGrow(newRows, newBuffer, newCols);
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
