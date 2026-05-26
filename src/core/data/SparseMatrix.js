/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { cellKey } from './CellKey.js';

/**
 * @fileoverview 稀疏矩阵存储实现
 * 只存储非空单元格，提供高效的行列访问和范围操作
 * 
 * 设计目标：
 * 1. 内存效率：只存储非空单元格
 * 2. 查找效率：O(1) 单元格访问
 * 3. 范围操作：高效的范围遍历和删除
 * 4. 迭代效率：快速迭代非空单元格
 */

/**
 * @typedef {Object} Cell - 单元格数据
 * @property {*} v - 单元格值
 * @property {string} [f] - 公式
 * @property {Object} [s] - 样式
 * @property {string} [m] - 显示文本
 * @property {boolean} [dirty] - 是否需要重算
 */

/**
 * @typedef {Object} CellEntry - 单元格条目
 * @property {number} r - 行索引
 * @property {number} c - 列索引
 * @property {Cell} cell - 单元格数据
 */

/**
 * @typedef {Object} SparseMatrixStats - 稀疏矩阵统计信息
 * @property {number} cellCount - 单元格总数
 * @property {number} rowCount - 非空行数
 * @property {number} colCount - 非空列数
 * @property {number} density - 密度（单元格数 / (行数 * 列数)）
 * @property {number} [memory] - 估算内存占用（字节）
 */

/**
 * Cell 紧凑编码器
 * 根据单元格实际内容选择最优存储格式，减少内存占用
 */
class CompactCellEncoder {
  constructor() {
    this.TYPE_VALUE = 0;      // 纯值
  }

  encode(cell) {
    if (!cell || typeof cell !== 'object') {
      return cell;
    }

    // 确保对象引用的稳定性，以兼容 Workbook 的对象池和依赖追踪
    return cell;
  }

  decode(encoded) {
    if (encoded === undefined) {
      return encoded;
    }

    // 原始值包装回 Cell 对象
    if (typeof encoded !== 'object' || encoded === null) {
      return { v: encoded };
    }

    // 如果存的是对象引用，直接返回
    return encoded;
  }

  getValue(encoded) {
    if (encoded === null || encoded === undefined) {
      return encoded;
    }

    if (typeof encoded !== 'object') {
      return encoded;
    }

    return encoded.v;
  }
}

/**
 * 稀疏矩阵存储类
 * 采用单层 Map 存储和列倒序索引结构
 */
export class SparseMatrix {
  constructor(options = {}) {
    this._rows = new Map();
    this._colIndex = new Map();
    this._size = 0;
    this._version = 0;
    this._bounds = { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
    this._boundsDirty = false;
    this._encoder = new CompactCellEncoder();
    this.onDeleteCell = options.onDeleteCell || null;
    
    this._stats = {
      compactCount: 0,
      fullCount: 0,
      memorySaved: 0
    };
  }

  get size() {
    return this._size;
  }

  get version() {
    return this._version;
  }

  isEmpty() {
    return this._size === 0;
  }

  get(row, col) {
    const rowMap = this._rows.get(row);
    if (!rowMap) return undefined;
    
    const encoded = rowMap.get(col);
    if (encoded === undefined) return undefined;
    
    return this._encoder.decode(encoded);
  }

  getValue(row, col) {
    const rowMap = this._rows.get(row);
    if (!rowMap) return undefined;
    
    const encoded = rowMap.get(col);
    if (encoded === undefined) return undefined;
    
    return this._encoder.getValue(encoded);
  }

  set(row, col, value, skipOnDelete = false) {
    if (value === undefined || value === null) {
      this.delete(row, col, skipOnDelete);
      return;
    }

    const encoded = this._encoder.encode(value);
    
    if (encoded === null || encoded === undefined || typeof encoded !== 'object') {
      this._stats.compactCount++;
    } else {
      this._stats.fullCount++;
    }
    
    let rowMap = this._rows.get(row);
    const isExisting = rowMap && rowMap.has(col);
    
    if (!rowMap) {
      rowMap = new Map();
      this._rows.set(row, rowMap);
    }
    
    if (isExisting && !skipOnDelete && this.onDeleteCell) {
      const oldEncoded = rowMap.get(col);
      // 触发删除回调（用于对象池回收）
      const oldCell = this._encoder.decode(oldEncoded);
      if (oldCell) {
        this.onDeleteCell(oldCell, row, col);
      }
    }
    
    rowMap.set(col, encoded);
    
    if (!isExisting) {
      this._updateColIndex(col, row, true);
      this._size++;
      this._updateBounds(row, col, true);
    }
    
    this._version++;
  }

  _updateColIndex(col, row, isAdd) {
    let indexList = this._colIndex.get(col);
    
    if (isAdd) {
      if (!indexList) {
        indexList = [];
        this._colIndex.set(col, indexList);
      }
      
      // 性能优化：针对顺序加载（常见于全量导入）进行尾部探测，复杂度从 O(N) 降为 O(1)
      if (indexList.length === 0 || row > indexList[indexList.length - 1]) {
        indexList.push(row);
      } else {
        const pos = this._binarySearch(indexList, row);
        if (pos === -1) {
          // 使用二分查找定位插入位置，避免 linear scan
          let low = 0, high = indexList.length;
          while (low < high) {
            let mid = (low + high) >>> 1;
            if (indexList[mid] < row) low = mid + 1;
            else high = mid;
          }
          indexList.splice(low, 0, row);
        }
      }
    } else {
      if (indexList) {
        const pos = this._binarySearch(indexList, row);
        if (pos !== -1) {
          indexList.splice(pos, 1);
          if (indexList.length === 0) {
            this._colIndex.delete(col);
          }
        }
      }
    }
  }

  _binarySearch(arr, target) {
    let left = 0;
    let right = arr.length - 1;
    while (left <= right) {
      const mid = (left + right) >> 1;
      if (arr[mid] === target) return mid;
      else if (arr[mid] < target) left = mid + 1;
      else right = mid - 1;
    }
    return -1;
  }

  _updateBounds(row, col, isAdd) {
    if (isAdd) {
      if (this._size === 1) {
        this._bounds = { minRow: row, maxRow: row, minCol: col, maxCol: col };
      } else {
        if (row < this._bounds.minRow) this._bounds.minRow = row;
        if (row > this._bounds.maxRow) this._bounds.maxRow = row;
        if (col < this._bounds.minCol) this._bounds.minCol = col;
        if (col > this._bounds.maxCol) this._bounds.maxCol = col;
      }
    }
  }

  delete(row, col, skipOnDelete = false) {
    const rowMap = this._rows.get(row);
    if (!rowMap || !rowMap.has(col)) {
      return false;
    }

    if (!skipOnDelete && this.onDeleteCell) {
      const encoded = rowMap.get(col);
      const cell = this._encoder.decode(encoded);
      this.onDeleteCell(cell, row, col);
    }

    rowMap.delete(col);
    if (rowMap.size === 0) {
      this._rows.delete(row);
    }
    
    this._updateColIndex(col, row, false);
    this._size--;
    this._version++;
    
    if (this._size > 0) {
      if (row === this._bounds.minRow || row === this._bounds.maxRow ||
          col === this._bounds.minCol || col === this._bounds.maxCol) {
        this._boundsDirty = true;
      }
    } else {
      this._bounds = { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
      this._boundsDirty = false;
    }
    
    return true;
  }

  has(row, col) {
    const rowMap = this._rows.get(row);
    return rowMap ? rowMap.has(col) : false;
  }

  getRow(row) {
    const rowMap = this._rows.get(row);
    if (!rowMap) return new Map();
    
    const result = new Map();
    for (const [col, encoded] of rowMap) {
      result.set(col, this._encoder.decode(encoded));
    }
    return result;
  }

  getCol(col) {
    const rowIndexes = this._colIndex.get(col);
    if (!rowIndexes) return new Map();
    
    const result = new Map();
    for (const row of rowIndexes) {
      const rowMap = this._rows.get(row);
      if (rowMap) {
        const encoded = rowMap.get(col);
        if (encoded !== undefined) {
          result.set(row, this._encoder.decode(encoded));
        }
      }
    }
    return result;
  }

  deleteRow(row) {
    const rowMap = this._rows.get(row);
    if (!rowMap) return 0;

    const count = rowMap.size;
    if (this.onDeleteCell) {
      for (const [col, encoded] of rowMap) {
        this.onDeleteCell(this._encoder.decode(encoded), row, col);
      }
    }

    for (const col of rowMap.keys()) {
      this._updateColIndex(col, row, false);
    }

    this._rows.delete(row);
    this._size -= count;
    this._version++;
    this._boundsDirty = true;
    
    return count;
  }

  deleteCol(col) {
    const rowIndexes = this._colIndex.get(col);
    if (!rowIndexes) return 0;

    const count = rowIndexes.length;
    if (this.onDeleteCell) {
      for (const row of rowIndexes) {
        const rowMap = this._rows.get(row);
        if (rowMap) {
          const encoded = rowMap.get(col);
          if (encoded !== undefined) {
            this.onDeleteCell(this._encoder.decode(encoded), row, col);
          }
        }
      }
    }

    for (const row of rowIndexes) {
      const rowMap = this._rows.get(row);
      if (rowMap) {
        rowMap.delete(col);
        if (rowMap.size === 0) {
          this._rows.delete(row);
        }
      }
    }

    this._colIndex.delete(col);
    this._size -= count;
    this._version++;
    this._boundsDirty = true;
    
    return count;
  }

  deleteRowRange(startRow, endRow = -1) {
    let count = 0;
    const rowsToDelete = [];
    for (const row of this._rows.keys()) {
      if (row >= startRow && (endRow === -1 || row <= endRow)) {
        rowsToDelete.push(row);
      }
    }
    for (const row of rowsToDelete) {
      count += this.deleteRow(row);
    }
    return count;
  }

  deleteColRange(startCol, endCol = -1) {
    let count = 0;
    const colsToDelete = [];
    for (const col of this._colIndex.keys()) {
      if (col >= startCol && (endCol === -1 || col <= endCol)) {
        colsToDelete.push(col);
      }
    }
    for (const col of colsToDelete) {
      count += this.deleteCol(col);
    }
    return count;
  }

  iterateRange(startRow, startCol, endRow, endCol, callback) {
    for (const [row, rowMap] of this._rows) {
      if (row < startRow || row > endRow) continue;
      for (const [col, encoded] of rowMap) {
        if (col >= startCol && col <= endCol) {
          callback(row, col, this._encoder.decode(encoded));
        }
      }
    }
  }

  forEach(callback) {
    for (const [row, rowMap] of this._rows) {
      for (const [col, encoded] of rowMap) {
        callback(row, col, this._encoder.decode(encoded));
      }
    }
  }

  entries() {
    const result = [];
    this.forEach((r, c, cell) => {
      result.push({ r, c, cell });
    });
    return result;
  }

  keys() {
    const result = [];
    this.forEach((r, c) => {
      result.push({ r, c });
    });
    return result;
  }

  values() {
    const result = [];
    this.forEach((r, c, cell) => {
      result.push(cell);
    });
    return result;
  }

  rowIndices() {
    return Array.from(this._rows.keys()).sort((a, b) => a - b);
  }

  colIndices() {
    return Array.from(this._colIndex.keys()).sort((a, b) => a - b);
  }

  getBounds() {
    if (this._size === 0) {
      return { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
    }
    if (this._boundsDirty) {
      this._recalculateBounds();
    }
    return { ...this._bounds };
  }

  _recalculateBounds() {
    let minRow = Infinity, maxRow = -Infinity;
    let minCol = Infinity, maxCol = -Infinity;

    for (const [row, rowMap] of this._rows) {
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      for (const col of rowMap.keys()) {
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      }
    }

    if (minRow === Infinity) {
      this._bounds = { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
    } else {
      this._bounds = { minRow, maxRow, minCol, maxCol };
    }
    this._boundsDirty = false;
  }

  clear() {
    if (this.onDeleteCell) {
      this.forEach((r, c, cell) => {
        this.onDeleteCell(cell, r, c);
      });
    }
    this._rows.clear();
    this._colIndex.clear();
    this._size = 0;
    this._version++;
    this._bounds = { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
    this._boundsDirty = false;
    this._stats = { compactCount: 0, fullCount: 0, memorySaved: 0 };
  }

  getStats() {
    const bounds = this.getBounds();
    const rowCount = this._rows.size;
    const colCount = this._colIndex.size;
    let density = 0;
    if (rowCount > 0 && colCount > 0) {
      const totalCells = (bounds.maxRow - bounds.minRow + 1) * 
                         (bounds.maxCol - bounds.minCol + 1);
      density = totalCells > 0 ? this._size / totalCells : 0;
    }
    return {
      cellCount: this._size,
      rowCount,
      colCount,
      density,
      optimizationStats: {
        ...this._stats,
        compactRatio: this._size > 0 
          ? (this._stats.compactCount / this._size * 100).toFixed(2) + '%'
          : '0%'
      }
    };
  }

  setCells(cells) {
    for (const { r, c, cell } of cells) {
      this.set(r, c, cell);
    }
  }

  toObject(useCompactKey = true) {
    const result = {};
    this.forEach((r, c, cell) => {
      const key = useCompactKey ? cellKey(r, c) : `${r}-${c}`;
      result[key] = cell;
    });
    return result;
  }

  fromObject(data, keyParser) {
    this.clear();
    for (const key of Object.keys(data)) {
      const { r, c } = keyParser(key);
      this.set(r, c, data[key]);
    }
  }

  clone() {
    const cloned = new SparseMatrix();
    this.forEach((r, c, cell) => {
      cloned.set(r, c, { ...cell });
    });
    return cloned;
  }

  toJSON() {
    const cells = [];
    this.forEach((r, c, cell) => {
      cells.push({ r, c, ...cell });
    });
    return { size: this._size, version: this._version, cells };
  }

  fromJSON(json) {
    this.clear();
    if (json.cells && Array.isArray(json.cells)) {
      for (const item of json.cells) {
        const { r, c, ...cell } = item;
        this.set(r, c, cell);
      }
    }
  }
}

/**
 * 工厂函数：创建稀疏矩阵实例
 * 
 * @param {Object} options - 配置选项
 * @param {Function} options.onDeleteCell - 删除回调
 * @returns {SparseMatrix}
 */
export function createSparseMatrix(options = {}) {
  return new SparseMatrix(options);
}

export default SparseMatrix;
