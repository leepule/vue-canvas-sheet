/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 虚拟滚动管理器 - 增强版
 * 
 * 优化特性：
 * 1. 差量更新：只更新新增/移除的行列，避免全量重绘
 * 2. 冻结缓存：独立缓存冻结区域，避免重复计算
 * 3. 脏标记：精确跟踪变更区域，只渲染脏单元格
 */

export class VirtualScrollManager {
  constructor(workbook, options = {}) {
    this.workbook = workbook;
    
    // ===== 基础配置 =====
    this.bufferConfig = {
      minBuffer: 10,                // 增加最小缓冲区
      maxBuffer: 10,                // 最大缓冲区
      fastScrollBonus: 20,          // 增加快速滚动奖励
      velocityThreshold: 150,       // 降低速度阈值 (px/frame)
      preloadThreshold: 5           // 增加预加载阈值
    };
    
    // 合并用户配置
    if (options.bufferConfig) {
      this.bufferConfig = { ...this.bufferConfig, ...options.bufferConfig };
    }
    
    // ===== 滚动状态跟踪 =====
    this.scrollState = {
      lastScrollX: 0,
      lastScrollY: 0,
      lastTimestamp: 0,
      velocityX: 0,
      velocityY: 0,
      directionX: 0,  // -1 左, 0 无, 1 右
      directionY: 0   // -1 上, 0 无, 1 下
    };
    
    // ===== 主可见范围缓存 =====
    this.cachedRange = null;
    this.rangeValid = false;
    
    // ===== 冻结区域独立缓存 =====
    this.frozenCache = {
      rows: {  // 冻结行缓存
        cache: null,     // 缓存的冻结行范围对象
        valid: false,    // 缓存是否有效
        freezeR: -1,     // 当前冻结行数
        frozenSize: null // 冻结区域尺寸
      },
      cols: {  // 冻结列缓存
        cache: null,     // 缓存的冻结列范围对象
        valid: false,    // 缓存是否有效
        freezeC: -1,     // 当前冻结列数
        frozenSize: null // 冻结区域尺寸
      },
      stats: {  // 缓存统计
        hits: 0,
        misses: 0,
        rowUpdates: 0,
        colUpdates: 0
      }
    };
    
    // ===== 增量更新性能监控 =====
    this.updateStats = this._createUpdateStats();
    
    // ===== 脏区域标记系统 =====
    this.dirtyState = {
      rows: new Map(),      // 脏行集合 { rowIndex: { timestamp, reason } }
      cols: new Map(),      // 脏列集合 { colIndex: { timestamp, reason } }
      cells: new Map(),     // 脏单元格集合 Map<row, Map<col, { timestamp }>> — 按行分桶
      stats: {
        markedRows: 0,
        markedCols: 0,
        markedCells: 0,
        cleanedRows: 0,
        cleanedCols: 0,
        cleanedCells: 0
      }
    };
    this._dirtyCellCount = 0; // 维护计数器，避免遍历嵌套 Map 计数
    
    // 脏标记清理策略配置
    this.dirtyConfig = {
      autoCleanAfterRender: true,    // 渲染后自动清理
      maxDirtyRows: 1000,            // 最大脏行数
      maxDirtyCols: 1000,            // 最大脏列数
      maxDirtyCells: 10000,          // 最大脏单元格数
      expireAfter: 10000            // 脏标记过期时间（毫秒）
    };
    
    // 合并脏标记配置
    if (options.dirtyConfig) {
      this.dirtyConfig = { ...this.dirtyConfig, ...options.dirtyConfig };
    }
    
    // ===== 预加载队列 =====
    this.preloadQueue = [];
    this.isPreloading = false;
  }
  
  // ========================================
  // 核心方法
  // ========================================
  
  /**
   * 计算可见范围（优化版本）
   * @param {number} width Canvas 宽度
   * @param {number} height Canvas 高度
   * @param {number} rowHeaderWidth 行头宽度
   * @param {number} colHeaderHeight 列头高度
   * @returns {Object} 可见范围对象
   */
  getVisibleRange(width, height, rowHeaderWidth, colHeaderHeight) {
    const wb = this.workbook;
    const freezeC = wb.freeze?.c || 0;
    const freezeR = wb.freeze?.r || 0;
    
    // 更新滚动状态
    this._updateScrollState();
    
    // 根据滚动速度动态调整缓冲区
    const bufferRows = this._calculateBufferRows();
    const bufferCols = this._calculateBufferCols();
    
    // 计算冻结区域尺寸
    const frozenSize = wb.getFrozenSize ? wb.getFrozenSize() : { w: 0, h: 0 };
    const bodyStartX = rowHeaderWidth + frozenSize.w;
    const bodyStartY = colHeaderHeight + frozenSize.h;
    const bodyWidth = width - bodyStartX;
    const bodyHeight = height - bodyStartY;
    
    // 计算起始行列（带方向预测）
    let startRow = freezeR;
    let startCol = freezeC;
    
    // 计算当前视口顶部的起始行列（使用绝对 Workbook 坐标）
    if ((this.scrollY || 0) > 0 && freezeR < wb.rowCount) {
      const idx = wb.getRowIndexAt?.(this.scrollY);
      if (idx !== -1 && idx !== undefined && idx >= freezeR) {
        startRow = idx;
      }
    }
    
    if ((this.scrollX || 0) > 0 && freezeC < wb.colCount) {
      const idx = wb.getColIndexAt?.(this.scrollX);
      if (idx !== -1 && idx !== undefined && idx >= freezeC) {
        startCol = idx;
      }
    }

    // 记录精确起始位置
    const exactStartRow = startRow;
    const exactStartCol = startCol;
    
    // 计算结束行列
    let endRow = startRow;
    let endCol = startCol;
    
    let accumulatedH = 0;
    for (let r = startRow; r < wb.rowCount && accumulatedH < bodyHeight; r++) {
      accumulatedH += wb.getRowHeight(r);
      endRow = r;
    }
    
    let accumulatedW = 0;
    for (let c = startCol; c < wb.colCount && accumulatedW < bodyWidth; c++) {
      accumulatedW += wb.getColWidth(c);
      endCol = c;
    }
    
    // 应用动态缓冲区
    const bufferedStartRow = Math.max(freezeR, startRow - bufferRows);
    const bufferedEndRow = Math.min(wb.rowCount - 1, endRow + bufferRows);
    const bufferedStartCol = Math.max(freezeC, startCol - bufferCols);
    const bufferedEndCol = Math.min(wb.colCount - 1, endCol + bufferCols);
    
    // ===== 使用独立缓存获取冻结区域 =====
    const frozenRange = this._getCachedFrozenRange(
      freezeR, freezeC, frozenSize, rowHeaderWidth, colHeaderHeight, wb
    );
    
    // 构建完整范围对象
    const range = {
      // 冻结区域
      freezeStartRow: frozenRange.freezeStartRow,
      freezeEndRow: frozenRange.freezeEndRow,
      freezeStartCol: frozenRange.freezeStartCol,
      freezeEndCol: frozenRange.freezeEndCol,
      frozenRowRange: frozenRange.rowRange,
      frozenColRange: frozenRange.colRange,
      frozenIntersection: frozenRange.intersection,
      
      // 主体区域
      startRow: bufferedStartRow,
      endRow: bufferedEndRow,
      startCol: bufferedStartCol,
      endCol: bufferedEndCol,
      
      exactStartRow,
      exactEndRow: endRow,
      exactStartCol,
      exactEndCol: endCol,
      
      freezeR, freezeC,
      frozenWidth: frozenSize.w,
      frozenHeight: frozenSize.h,
      
      bodyStartX, bodyStartY,
      bodyWidth, bodyHeight
    };
    
    // ===== 检查主范围缓存 - 增量更新逻辑 =====
    if (this.rangeValid && this.cachedRange) {
      const oldRange = this.cachedRange;
      
      // 计算范围变化
      const changes = this._calculateRangeChanges(oldRange, range);
      
      // 判断是否可以增量更新
      const hasIntersection = 
        range.startRow <= oldRange.endRow && 
        range.endRow >= oldRange.startRow &&
        range.startCol <= oldRange.endCol && 
        range.endCol >= oldRange.startCol;
      
      const isSmallScroll = 
        changes.totalAddedRows + changes.totalRemovedRows <= 50 &&
        changes.totalAddedCols + changes.totalRemovedCols <= 50;
      
      if (hasIntersection && isSmallScroll) {
        // 使用增量更新
        const updatedRange = this._incrementallyUpdateRange(oldRange, range, changes);
        
        // 更新统计
        this._recordIncrementalUpdate(changes);
        
        return updatedRange;
      }
    }
    
    // 全量更新
    this._recordFullUpdate();
    
    // 自动清理脏标记
    if (this.dirtyConfig.autoCleanAfterRender) {
      this.cleanDirtyRange(range);
    }
    
    this.cachedRange = range;
    this.rangeValid = true;
    return range;
  }
  
  /**
   * 更新滚动状态
   * @private
   */
  _updateScrollState() {
    const now = performance.now();
    const dt = now - this.scrollState.lastTimestamp;
    
    if (dt > 16) {
      const dx = (this.scrollX || 0) - this.scrollState.lastScrollX;
      const dy = (this.scrollY || 0) - this.scrollState.lastScrollY;
      
      this.scrollState.velocityX = dx / dt * 16;
      this.scrollState.velocityY = dy / dt * 16;
      
      this.scrollState.directionX = dx > 5 ? 1 : (dx < -5 ? -1 : 0);
      this.scrollState.directionY = dy > 5 ? 1 : (dy < -5 ? -1 : 0);
      
      this.scrollState.lastScrollX = (this.scrollX || 0);
      this.scrollState.lastScrollY = (this.scrollY || 0);
      this.scrollState.lastTimestamp = now;
    }
  }
  
  /**
   * 根据滚动速度动态计算缓冲区大小
   * @private
   */
  _calculateBufferRows() {
    const base = this.bufferConfig.minBuffer;
    const bonus = Math.min(
      Math.abs(this.scrollState.velocityY) / this.bufferConfig.velocityThreshold,
      this.bufferConfig.fastScrollBonus
    );
    return Math.floor(base + bonus);
  }
  
  _calculateBufferCols() {
    const base = this.bufferConfig.minBuffer;
    const bonus = Math.min(
      Math.abs(this.scrollState.velocityX) / this.bufferConfig.velocityThreshold,
      this.bufferConfig.fastScrollBonus
    );
    return Math.floor(base + bonus);
  }
  
  // ========================================
  // 冻结区域缓存
  // ========================================
  
  /**
   * 获取缓存的冻结区域范围
   * @private
   */
  _getCachedFrozenRange(freezeR, freezeC, frozenSize, rowHeaderWidth, colHeaderHeight, workbook) {
    const result = {
      freezeStartRow: 0,
      freezeEndRow: 0,
      freezeStartCol: 0,
      freezeEndCol: 0,
      rowRange: null,
      colRange: null,
      intersection: null
    };
    
    // ===== 冻结行处理 =====
    if (freezeR > 0) {
      const rowCache = this.frozenCache.rows;
      
      if (rowCache.valid && rowCache.freezeR === freezeR) {
        // 缓存命中
        result.freezeStartRow = rowCache.cache.freezeStartRow;
        result.freezeEndRow = rowCache.cache.freezeEndRow;
        result.rowRange = rowCache.cache.rowRange;
        this.frozenCache.stats.hits++;
      } else {
        // 重新计算
        const freezeEndRow = Math.max(0, freezeR - 1);
        result.freezeStartRow = 0;
        result.freezeEndRow = freezeEndRow;
        
        let frozenHeight = colHeaderHeight;
        for (let r = 0; r < freezeR; r++) {
          frozenHeight += workbook.getRowHeight(r);
        }
        
        result.rowRange = {
          startRow: 0,
          endRow: freezeEndRow,
          startX: 0,
          endX: frozenSize.w + workbook.getColWidth(0),
          startY: 0,
          endY: frozenHeight
        };
        
        rowCache.cache = {
          freezeStartRow: result.freezeStartRow,
          freezeEndRow: result.freezeEndRow,
          rowRange: result.rowRange
        };
        rowCache.valid = true;
        rowCache.freezeR = freezeR;
        rowCache.frozenSize = { ...frozenSize };
        this.frozenCache.stats.misses++;
        this.frozenCache.stats.rowUpdates++;
      }
    } else {
      this.frozenCache.rows.valid = false;
      this.frozenCache.rows.cache = null;
    }
    
    // ===== 冻结列处理 =====
    if (freezeC > 0) {
      const colCache = this.frozenCache.cols;
      
      if (colCache.valid && colCache.freezeC === freezeC) {
        result.freezeStartCol = colCache.cache.freezeStartCol;
        result.freezeEndCol = colCache.cache.freezeEndCol;
        result.colRange = colCache.cache.colRange;
        this.frozenCache.stats.hits++;
      } else {
        const freezeEndCol = Math.max(0, freezeC - 1);
        result.freezeStartCol = 0;
        result.freezeEndCol = freezeEndCol;
        
        let frozenWidth = rowHeaderWidth;
        for (let c = 0; c < freezeC; c++) {
          frozenWidth += workbook.getColWidth(c);
        }
        
        result.colRange = {
          startCol: 0,
          endCol: freezeEndCol,
          startX: 0,
          endX: frozenWidth,
          startY: 0,
          endY: frozenSize.h + workbook.getRowHeight(0)
        };
        
        colCache.cache = {
          freezeStartCol: result.freezeStartCol,
          freezeEndCol: result.freezeEndCol,
          colRange: result.colRange
        };
        colCache.valid = true;
        colCache.freezeC = freezeC;
        colCache.frozenSize = { ...frozenSize };
        this.frozenCache.stats.misses++;
        this.frozenCache.stats.colUpdates++;
      }
    } else {
      this.frozenCache.cols.valid = false;
      this.frozenCache.cols.cache = null;
    }
    
    // 计算冻结区域交集
    if (freezeR > 0 && freezeC > 0) {
      result.intersection = {
        startRow: 0,
        endRow: freezeR - 1,
        startCol: 0,
        endCol: freezeC - 1,
        x: 0,
        y: 0,
        width: this.frozenCache.cols.cache?.colRange.endX || 0,
        height: this.frozenCache.rows.cache?.rowRange.endY || 0
      };
    }
    
    return result;
  }
  
  /**
   * 使冻结区域缓存失效
   */
  invalidateFrozenCache() {
    this.frozenCache.rows.valid = false;
    this.frozenCache.rows.cache = null;
    this.frozenCache.cols.valid = false;
    this.frozenCache.cols.cache = null;
  }
  
  /**
   * 获取综合性能统计
   */
  getPerformanceStats() {
    return {
      incrementalUpdate: this.getIncrementalUpdateStats(),
      frozenCache: this.getFrozenCacheStats(),
      dirty: this.getDirtyStats(),
      scrollState: {
        velocityX: this.scrollState.velocityX.toFixed(2),
        velocityY: this.scrollState.velocityY.toFixed(2),
        directionX: this.scrollState.directionX,
        directionY: this.scrollState.directionY
      }
    };
  }

  getIncrementalUpdateStats() {
    const stats = this.updateStats;
    const total = stats.totalUpdates;
    return {
      total,
      incremental: stats.incrementalUpdates,
      full: stats.fullUpdates,
      totalUpdates: stats.totalUpdates,
      incrementalUpdates: stats.incrementalUpdates,
      fullUpdates: stats.fullUpdates,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      totalAddedRows: stats.addedRowCount,
      totalRemovedRows: stats.removedRowCount,
      totalAddedCols: stats.addedColCount,
      totalRemovedCols: stats.removedColCount,
      hitRate: total > 0 ? (stats.cacheHits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  resetIncrementalUpdateStats() {
    this.updateStats = this._createUpdateStats();
  }

  getFrozenCacheStats() {
    const stats = this.frozenCache.stats;
    const total = stats.hits + stats.misses;
    return {
      total,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: total > 0 ? (stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  getDirtyStats() {
    return {
      rows: this.dirtyState.rows.size,
      cols: this.dirtyState.cols.size,
      cells: this._dirtyCellCount
    };
  }
  
  // ========================================
  // 增量更新其他辅助方法
  // ========================================

  _createUpdateStats() {
    return {
      totalUpdates: 0,
      incrementalUpdates: 0,
      fullUpdates: 0,
      cacheHits: 0,
      cacheMisses: 0,
      addedRowCount: 0,
      removedRowCount: 0,
      addedColCount: 0,
      removedColCount: 0
    };
  }
  
  _calculateRangeChanges(oldRange, newRange) {
    const changes = {
      addedRows: [], removedRows: [], addedCols: [], removedCols: [],
      totalAddedRows: 0, totalRemovedRows: 0, totalAddedCols: 0, totalRemovedCols: 0
    };
    
    if (newRange.startRow < oldRange.startRow) {
      changes.addedRows.push({ start: newRange.startRow, end: oldRange.startRow - 1, direction: 'top' });
      changes.totalAddedRows += (oldRange.startRow - newRange.startRow);
    } else if (newRange.startRow > oldRange.startRow) {
      changes.removedRows.push({ start: oldRange.startRow, end: newRange.startRow - 1, direction: 'top' });
      changes.totalRemovedRows += (newRange.startRow - oldRange.startRow);
    }
    
    if (newRange.endRow > oldRange.endRow) {
      changes.addedRows.push({ start: oldRange.endRow + 1, end: newRange.endRow, direction: 'bottom' });
      changes.totalAddedRows += (newRange.endRow - oldRange.endRow);
    } else if (newRange.endRow < oldRange.endRow) {
      changes.removedRows.push({ start: newRange.endRow + 1, end: oldRange.endRow, direction: 'bottom' });
      changes.totalRemovedRows += (oldRange.endRow - newRange.endRow);
    }
    
    if (newRange.startCol < oldRange.startCol) {
      changes.addedCols.push({ start: newRange.startCol, end: oldRange.startCol - 1, direction: 'left' });
      changes.totalAddedCols += (oldRange.startCol - newRange.startCol);
    } else if (newRange.startCol > oldRange.startCol) {
      changes.removedCols.push({ start: oldRange.startCol, end: newRange.startCol - 1, direction: 'left' });
      changes.totalRemovedCols += (newRange.startCol - oldRange.startCol);
    }
    
    if (newRange.endCol > oldRange.endCol) {
      changes.addedCols.push({ start: oldRange.endCol + 1, end: newRange.endCol, direction: 'right' });
      changes.totalAddedCols += (newRange.endCol - oldRange.endCol);
    } else if (newRange.endCol < oldRange.endCol) {
      changes.removedCols.push({ start: newRange.endCol + 1, end: oldRange.endCol, direction: 'right' });
      changes.totalRemovedCols += (oldRange.endCol - newRange.endCol);
    }
    
    return changes;
  }
  
  _incrementallyUpdateRange(oldRange, newRange, changes) {
    const updated = { ...newRange };
    const intersect = {
      startRow: Math.max(oldRange.startRow, newRange.startRow),
      endRow: Math.min(oldRange.endRow, newRange.endRow),
      startCol: Math.max(oldRange.startCol, newRange.startCol),
      endCol: Math.min(oldRange.endCol, newRange.endCol)
    };
    
    const dirtyRegions = this.getDirtyRegions(intersect);
    updated.needsIncrementalRender = true;
    updated.renderChanges = {
      addedRows: changes.addedRows.map(s => ({ ...s, colStart: newRange.startCol, colEnd: newRange.endCol, mode: 'full' })),
      dirtyRows: dirtyRegions.rows.map(item => ({ rowIndex: item.index, colStart: intersect.startCol, colEnd: intersect.endCol, mode: 'dirty' })),
      addedCols: changes.addedCols.map(s => ({ ...s, rowStart: newRange.startRow, rowEnd: newRange.endRow, mode: 'full' })),
      dirtyCols: dirtyRegions.cols.map(item => ({ colIndex: item.index, rowStart: intersect.startRow, rowEnd: intersect.endRow, mode: 'dirty' })),
      dirtyCells: dirtyRegions.cells.map(c => ({ row: c.rowIndex, col: c.colIndex, mode: 'cell' })),
      skipRange: intersect
    };
    
    this.cachedRange = updated;
    return updated;
  }
  
  _recordIncrementalUpdate(changes) {
    this.updateStats.totalUpdates++;
    this.updateStats.incrementalUpdates++;
    this.updateStats.cacheHits++;
    this.updateStats.addedRowCount += changes.totalAddedRows;
    this.updateStats.removedRowCount += changes.totalRemovedRows;
    this.updateStats.addedColCount += changes.totalAddedCols;
    this.updateStats.removedColCount += changes.totalRemovedCols;
  }

  _recordFullUpdate() {
    this.updateStats.totalUpdates++;
    this.updateStats.fullUpdates++;
    this.updateStats.cacheMisses++;
  }
  
  // ========================================
  // 脏标记管理
  // ========================================
  
  markDirtyRow(rowIndex) { this.dirtyState.rows.set(rowIndex, { timestamp: Date.now() }); }
  markDirtyCol(colIndex) { this.dirtyState.cols.set(colIndex, { timestamp: Date.now() }); }
  markDirtyCell(r, c) {
    let colMap = this.dirtyState.cells.get(r);
    if (!colMap) {
      colMap = new Map();
      this.dirtyState.cells.set(r, colMap);
    }
    if (!colMap.has(c)) {
      colMap.set(c, { timestamp: Date.now() });
      this._dirtyCellCount++;
    }
  }
  
  cleanDirtyRange(range) {
    for (let r = range.startRow; r <= range.endRow; r++) this.dirtyState.rows.delete(r);
    for (let c = range.startCol; c <= range.endCol; c++) this.dirtyState.cols.delete(c);
    // 按行分桶结构：只遍历 range 内的行，而非全量 dirty cells
    for (let r = range.startRow; r <= range.endRow; r++) {
      const colMap = this.dirtyState.cells.get(r);
      if (!colMap) continue;
      for (let c = range.startCol; c <= range.endCol; c++) {
        if (colMap.delete(c)) this._dirtyCellCount--;
      }
      if (colMap.size === 0) this.dirtyState.cells.delete(r);
    }
  }

  getDirtyRegions(range) {
    const rows = [], cols = [], cells = [];
    for (let r = range.startRow; r <= range.endRow; r++) if (this.dirtyState.rows.has(r)) rows.push({ index: r });
    for (let c = range.startCol; c <= range.endCol; c++) if (this.dirtyState.cols.has(c)) cols.push({ index: c });
    // 按行分桶：只遍历 range 内的行
    for (let r = range.startRow; r <= range.endRow; r++) {
      const colMap = this.dirtyState.cells.get(r);
      if (!colMap) continue;
      for (let c = range.startCol; c <= range.endCol; c++) {
        const info = colMap.get(c);
        if (info) cells.push({ rowIndex: r, colIndex: c, ...info });
      }
    }
    return { rows, cols, cells };
  }

  _checkDirtyThreshold() {
    // 简化的阈值控制
    if (this.dirtyState.rows.size > 1000) this.dirtyState.rows.clear();
    if (this.dirtyState.cols.size > 1000) this.dirtyState.cols.clear();
    if (this._dirtyCellCount > 5000) {
      this.dirtyState.cells.clear();
      this._dirtyCellCount = 0;
    }
  }
  
  invalidateCache() {
    this.rangeValid = false;
    this.cachedRange = null;
    this.invalidateFrozenCache();
  }

  triggerPreload() { /* 预留 */ }
}
