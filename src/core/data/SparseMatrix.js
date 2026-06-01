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
 * 稀疏矩阵存储类
 * 采用单层 Map 存储和列倒序索引结构
 */
export class SparseMatrix {
  constructor(options = {}) {
    this._rows = new Map();
    this._colIndex = new Map();
    // 列脏标记：乱序插入时延迟排序，避免每次 splice O(N)。
    // 仅在 _updateColIndex 删除路径需要二分查找时才触发 _ensureColSorted。
    this._dirtyCols = new Set();
    this._size = 0;
    this._version = 0;
    this._bounds = { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 };
    this._boundsDirty = false;
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
    return rowMap.get(col);
  }

  getValue(row, col) {
    const rowMap = this._rows.get(row);
    if (!rowMap) return undefined;
    const cell = rowMap.get(col);
    if (cell === undefined) return undefined;
    return (cell && typeof cell === 'object') ? cell.v : cell;
  }

  set(row, col, value, skipOnDelete = false) {
    if (value === undefined || value === null) {
      this.delete(row, col, skipOnDelete);
      return;
    }

    if (value && typeof value === 'object') {
      this._stats.fullCount++;
    } else {
      this._stats.compactCount++;
    }

    let rowMap = this._rows.get(row);
    const isExisting = rowMap && rowMap.has(col);

    if (!rowMap) {
      rowMap = new Map();
      this._rows.set(row, rowMap);
    }

    if (isExisting && !skipOnDelete && this.onDeleteCell) {
      const oldCell = rowMap.get(col);
      if (oldCell) {
        this.onDeleteCell(oldCell, row, col);
      }
    }

    rowMap.set(col, value);
    
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

      // 调用方 set() 已通过 isExisting 守住重复（同一 (row,col) 不会二次进入），
      // 因此这里不再需要二分去重，关注点仅是维持 _colIndex 有序。
      if (indexList.length === 0 || row > indexList[indexList.length - 1]) {
        // 顺序加载快路径
        indexList.push(row);
      } else {
        // 乱序插入：仅 push 并标记列脏，把 O(N) splice 推迟到删除路径需要二分时执行
        indexList.push(row);
        this._dirtyCols.add(col);
      }
    } else {
      if (indexList) {
        this._ensureColSorted(col);
        const pos = this._binarySearch(indexList, row);
        if (pos !== -1) {
          indexList.splice(pos, 1);
          if (indexList.length === 0) {
            this._colIndex.delete(col);
            this._dirtyCols.delete(col);
          }
        }
      }
    }
  }

  /**
   * 若 col 在乱序插入后被标记为脏，则一次性排序，复杂度 O(N log N)，
   * 摊还到大量乱序插入上比每次 splice O(N) 显著更优。
   */
  _ensureColSorted(col) {
    if (!this._dirtyCols.has(col)) return;
    const list = this._colIndex.get(col);
    if (list && list.length > 1) {
      list.sort((a, b) => a - b);
    }
    this._dirtyCols.delete(col);
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
      const cell = encoded;
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
      result.set(col, encoded);
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
          result.set(row, encoded);
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
        this.onDeleteCell(encoded, row, col);
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
            this.onDeleteCell(encoded, row, col);
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
    this._dirtyCols.delete(col);
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
    const colRangeWidth = endCol - startCol + 1;

    // 列范围窄时利用 _colIndex 跳过无关列，避免遍历所有行
    if (colRangeWidth < this._colIndex.size) {
      for (let c = startCol; c <= endCol; c++) {
        const rowList = this._colIndex.get(c);
        if (!rowList) continue;
        for (let i = 0, len = rowList.length; i < len; i++) {
          const r = rowList[i];
          if (r < startRow) continue;
          if (r > endRow) break; // 行列表有序，后续都超出范围
          const rowMap = this._rows.get(r);
          if (rowMap) {
            const encoded = rowMap.get(c);
            if (encoded !== undefined) callback(r, c, encoded);
          }
        }
      }
      return;
    }

    // 列范围宽时遍历行，跳过不匹配的行
    for (const [row, rowMap] of this._rows) {
      if (row < startRow || row > endRow) continue;
      for (const [col, encoded] of rowMap) {
        if (col >= startCol && col <= endCol) {
          callback(row, col, encoded);
        }
      }
    }
  }

  forEach(callback) {
    for (const [row, rowMap] of this._rows) {
      for (const [col, encoded] of rowMap) {
        callback(row, col, encoded);
      }
    }
  }

  *entries() {
    for (const [row, rowMap] of this._rows) {
      for (const [col, cell] of rowMap) {
        yield { r: row, c: col, cell };
      }
    }
  }

  *keys() {
    for (const [row, rowMap] of this._rows) {
      for (const col of rowMap.keys()) {
        yield { r: row, c: col };
      }
    }
  }

  *values() {
    for (const [row, rowMap] of this._rows) {
      for (const cell of rowMap.values()) {
        yield cell;
      }
    }
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
    this._dirtyCols.clear();
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
    if (cells.length === 0) return;

    let sizeDelta = 0;

    // 第一遍：写入数据 + 统计新增单元格 + 更新 bounds
    for (const { r, c, cell } of cells) {
      let rowMap = this._rows.get(r);
      const isExisting = rowMap && rowMap.has(c);

      if (!rowMap) {
        rowMap = new Map();
        this._rows.set(r, rowMap);
      }

      if (!isExisting) {
        sizeDelta++;
        // 累积 bounds（延迟一次性更新）
        if (this._size + sizeDelta === 1) {
          this._bounds = { minRow: r, maxRow: r, minCol: c, maxCol: c };
        } else {
          if (r < this._bounds.minRow) this._bounds.minRow = r;
          if (r > this._bounds.maxRow) this._bounds.maxRow = r;
          if (c < this._bounds.minCol) this._bounds.minCol = c;
          if (c > this._bounds.maxCol) this._bounds.maxCol = c;
        }
      }

      if (isExisting && this.onDeleteCell) {
        const oldCell = rowMap.get(c);
        if (oldCell) this.onDeleteCell(oldCell, r, c);
      }

      rowMap.set(c, cell);
    }

    // 第二遍：重建 _colIndex（比逐个 _updateColIndex + splice 高效）
    const newColIndex = new Map();
    for (const [row, rowMap] of this._rows) {
      for (const col of rowMap.keys()) {
        let list = newColIndex.get(col);
        if (!list) {
          list = [];
          newColIndex.set(col, list);
        }
        list.push(row);
      }
    }
    // 排序每个列的行列表
    for (const list of newColIndex.values()) {
      if (list.length > 1) list.sort((a, b) => a - b);
    }
    this._colIndex = newColIndex;
    this._dirtyCols.clear();

    // 批量更新 size 和 version
    this._size += sizeDelta;
    this._version++;
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
