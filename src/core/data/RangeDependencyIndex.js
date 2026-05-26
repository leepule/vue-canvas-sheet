/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 层次化空间依赖索引 (Hierarchical Spatial Dependency Index)
 * 
 * 优化特性：
 * 1. 层次化网格：不同尺寸的范围进入不同粒度的索引层，避免大范围导致的网格膨胀。
 * 2. 特殊路径：针对整行 (A:A) 和整列 (1:1) 建立专门的线性索引。
 * 3. 内存优化：减少重复存储，提高查找效率。
 */
export class RangeDependencyIndex {
  constructor() {
    // L0: 细粒度网格 (100x100)，适用于普通单元格区域
    this.L0_SIZE = 100;
    this.l0_grid = new Map();

    // L1: 粗粒度网格 (2000x2000)，适用于中等跨度区域
    this.L1_SIZE = 2000;
    this.l1_grid = new Map();

    // L2: 全局索引，适用于超大范围（如 A1:Z999999）
    this.l2_global = new Set();

    // 特殊索引：整行和整列
    // Map<Index, Set<Entry>>
    this.fullRows = new Map(); 
    this.fullCols = new Map();

    // 反向索引：cellId -> Set<Entry>，用于快速删除
    this._cellIdToEntries = new Map();
  }

  /**
   * 添加范围依赖
   * @param {Object} range - {startR, startC, endR, endC}
   * @param {string} cellId - 依赖该范围的单元格 ID
   */
  add(range, cellId) {
    const entry = { range, cellId, key: this._getRangeKey(range) };
    
    // 1. 检查是否是特殊范围
    const isFullRow = range.startC === 0 && range.endC >= 16383; // 假设最大列 16384
    const isFullCol = range.startR === 0 && range.endR >= 1048575; // 假设最大行 1M

    if (isFullRow && isFullCol) {
      this.l2_global.add(entry);
    } else if (isFullRow) {
      this._addToLinearIndex(this.fullRows, range.startR, range.endR, entry);
    } else if (isFullCol) {
      this._addToLinearIndex(this.fullCols, range.startC, range.endC, entry);
    } else {
      // 2. 正常区域范围，决定进入哪一层网格
      const rowSpan = range.endR - range.startR + 1;
      const colSpan = range.endC - range.startC + 1;

      if (rowSpan > this.L1_SIZE || colSpan > this.L1_SIZE) {
        // 太大的范围直接进 L2，避免网格膨胀
        this.l2_global.add(entry);
      } else if (rowSpan > this.L0_SIZE || colSpan > this.L0_SIZE) {
        // 中等范围进 L1
        this._addToGrid(this.l1_grid, this.L1_SIZE, range, entry);
      } else {
        // 小范围进 L0
        this._addToGrid(this.l0_grid, this.L0_SIZE, range, entry);
      }
    }

    // 记录反向索引
    if (!this._cellIdToEntries.has(cellId)) {
      this._cellIdToEntries.set(cellId, new Set());
    }
    this._cellIdToEntries.get(cellId).add(entry);
  }

  /**
   * 查找包含指定单元格的所有依赖项
   * @param {number} r 
   * @param {number} c 
   * @returns {Set<string>}
   */
  findDependents(r, c) {
    const result = new Set();

    // 1. 检查 L2 全局
    if (this.l2_global.size > 0) this._querySet(this.l2_global, r, c, result);

    // 2. 检查线性索引 (整行/整列)
    if (this.fullRows.size > 0) this._queryLinearIndex(this.fullRows, r, r, c, result);
    if (this.fullCols.size > 0) this._queryLinearIndex(this.fullCols, c, r, c, result);

    // 3. 检查 L1 网格
    if (this.l1_grid.size > 0) this._queryGrid(this.l1_grid, this.L1_SIZE, r, c, result);

    // 4. 检查 L0 网格
    if (this.l0_grid.size > 0) this._queryGrid(this.l0_grid, this.L0_SIZE, r, c, result);

    return result;
  }

  /**
   * 移除单元格的所有依赖
   */
  remove(cellId) {
    const entries = this._cellIdToEntries.get(cellId);
    if (!entries) return;

    for (const entry of entries) {
      // 从各个池中移除（虽然遍历有点多，但 entries 数量通常很少）
      this.l2_global.delete(entry);
      this._removeFromLinearIndex(this.fullRows, entry.range.startR, entry.range.endR, entry);
      this._removeFromLinearIndex(this.fullCols, entry.range.startC, entry.range.endC, entry);
      this._removeFromGrid(this.l0_grid, this.L0_SIZE, entry.range, entry);
      this._removeFromGrid(this.l1_grid, this.L1_SIZE, entry.range, entry);
    }
    this._cellIdToEntries.delete(cellId);
  }

  clear() {
    this.l0_grid.clear();
    this.l1_grid.clear();
    this.l2_global.clear();
    this.fullRows.clear();
    this.fullCols.clear();
    this._cellIdToEntries.clear();
  }

  // ===== 内部辅助方法 =====

  _getRangeKey(range) {
    return `${range.startR},${range.startC},${range.endR},${range.endC}`;
  }

  _addToGrid(grid, size, range, entry) {
    const rStart = Math.floor(range.startR / size);
    const rEnd = Math.floor(range.endR / size);
    const cStart = Math.floor(range.startC / size);
    const cEnd = Math.floor(range.endC / size);

    for (let gr = rStart; gr <= rEnd; gr++) {
      for (let gc = cStart; gc <= cEnd; gc++) {
        const key = `${gr}:${gc}`;
        if (!grid.has(key)) grid.set(key, new Set());
        grid.get(key).add(entry);
      }
    }
  }

  _removeFromGrid(grid, size, range, entry) {
    const rStart = Math.floor(range.startR / size);
    const rEnd = Math.floor(range.endR / size);
    const cStart = Math.floor(range.startC / size);
    const cEnd = Math.floor(range.endC / size);

    for (let gr = rStart; gr <= rEnd; gr++) {
      for (let gc = cStart; gc <= cEnd; gc++) {
        const key = `${gr}:${gc}`;
        const set = grid.get(key);
        if (set) {
          set.delete(entry);
          if (set.size === 0) grid.delete(key);
        }
      }
    }
  }

  _queryGrid(grid, size, r, c, result) {
    const gr = Math.floor(r / size);
    const gc = Math.floor(c / size);
    const set = grid.get(`${gr}:${gc}`);
    if (set) {
      this._querySet(set, r, c, result);
    }
  }

  // 线性索引允许的最大跨度，超出则提升到 l2_global，避免索引爆炸同时不丢依赖
  static LINEAR_INDEX_MAX_SPAN = 1000;

  _addToLinearIndex(map, start, end, entry) {
    // 简化：如果范围很大，我们不按点存，按块存或者直接存列表
    // 这里简单起见，使用 Map<Index, Set>，但对于整行/列，通常 start === end (如 A:A)
    // 如果是 A:C，则存 A, B, C
    if (end - start > RangeDependencyIndex.LINEAR_INDEX_MAX_SPAN) {
      // 跨度过大：整条提升到 L2 全局索引，避免线性索引爆炸；
      // 旧实现在此处 break 会截断索引，导致超出 1000 的部分依赖丢失。
      this.l2_global.add(entry);
      return;
    }
    for (let i = start; i <= end; i++) {
      if (!map.has(i)) map.set(i, new Set());
      map.get(i).add(entry);
    }
  }

  _removeFromLinearIndex(map, start, end, entry) {
    if (end - start > RangeDependencyIndex.LINEAR_INDEX_MAX_SPAN) {
      // 与 _addToLinearIndex 对称：此 entry 不在线性索引中，l2_global 由 remove() 统一清理
      return;
    }
    for (let i = start; i <= end; i++) {
      const set = map.get(i);
      if (set) {
        set.delete(entry);
        if (set.size === 0) map.delete(i);
      }
    }
  }

  _queryLinearIndex(map, index, r, c, result) {
    const set = map.get(index);
    if (set) {
      this._querySet(set, r, c, result);
    }
  }

  _querySet(set, r, c, result) {
    if (!set || set.size === 0) return;
    for (const entry of set) {
      const { range, cellId } = entry;
      if (r >= range.startR && r <= range.endR &&
          c >= range.startC && c <= range.endC) {
        result.add(cellId);
      }
    }
  }
}
