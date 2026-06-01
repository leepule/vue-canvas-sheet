/**
 * 布局引擎
 * 管理行列偏移量计算、冻结区域尺寸、像素坐标与行列索引的转换
 */
export class LayoutEngine {
  constructor(deps) {
    this.d = deps;
    this._rowOffsets = [];
    this._colOffsets = [];
    this._offsetsDirty = true;
    this._frozenSize = null;
    this._frozenSizeDirty = true;
    // 单调递增的布局版本号：任何会移动网格线的几何变更（行高/列宽/插删/计数）
    // 都经 markDirty() 自增。供渲染层 O(1) 判定网格缓存是否失效，替代逐格累加哈希。
    this._layoutVersion = 0;
  }

  getLayoutVersion() {
    return this._layoutVersion;
  }

  _ensureOffsets() {
    if (!this._offsetsDirty) return;

    const rowCount = this.d.getRowCount();
    const colCount = this.d.getColCount();
    const defaultRowH = this.d.getDefaultRowHeight();
    const defaultColW = this.d.getDefaultColWidth();
    const rowHeights = this.d.getRowHeights();
    const colWidths = this.d.getColWidths();

    this._rowOffsets = new Array(rowCount + 1);
    let currentY = 0;
    for (let r = 0; r < rowCount; r++) {
      this._rowOffsets[r] = currentY;
      currentY += (rowHeights[r] !== undefined ? rowHeights[r] : defaultRowH);
    }
    this._rowOffsets[rowCount] = currentY;

    this._colOffsets = new Array(colCount + 1);
    let currentX = 0;
    for (let c = 0; c < colCount; c++) {
      this._colOffsets[c] = currentX;
      currentX += (colWidths[c] !== undefined ? colWidths[c] : defaultColW);
    }
    this._colOffsets[colCount] = currentX;

    this._offsetsDirty = false;
  }

  _updateRowOffsetsFrom(startIndex) {
    if (this._offsetsDirty) {
      this._ensureOffsets();
      return;
    }

    const rowCount = this.d.getRowCount();
    if (startIndex < 0) startIndex = 0;
    if (startIndex > rowCount) return;

    if (this._rowOffsets.length !== rowCount + 1) {
      const oldLen = this._rowOffsets.length;
      const newOffsets = new Array(rowCount + 1);
      const copyLen = Math.min(oldLen, newOffsets.length);
      for (let i = 0; i < copyLen; i++) newOffsets[i] = this._rowOffsets[i];
      this._rowOffsets = newOffsets;

      if (startIndex >= oldLen) {
        startIndex = Math.max(0, oldLen - 1);
      }
    }

    const defaultRowH = this.d.getDefaultRowHeight();
    const rowHeights = this.d.getRowHeights();
    let currentY = startIndex > 0
      ? this._rowOffsets[startIndex - 1] + (rowHeights[startIndex - 1] !== undefined ? rowHeights[startIndex - 1] : defaultRowH)
      : 0;

    for (let r = startIndex; r < rowCount; r++) {
      this._rowOffsets[r] = currentY;
      currentY += (rowHeights[r] !== undefined ? rowHeights[r] : defaultRowH);
    }
    this._rowOffsets[rowCount] = currentY;
  }

  _updateColOffsetsFrom(startIndex) {
    if (this._offsetsDirty) {
      this._ensureOffsets();
      return;
    }

    const colCount = this.d.getColCount();
    if (startIndex < 0) startIndex = 0;
    if (startIndex > colCount) return;

    if (this._colOffsets.length !== colCount + 1) {
      const oldLen = this._colOffsets.length;
      const newOffsets = new Array(colCount + 1);
      const copyLen = Math.min(oldLen, newOffsets.length);
      for (let i = 0; i < copyLen; i++) newOffsets[i] = this._colOffsets[i];
      this._colOffsets = newOffsets;

      if (startIndex >= oldLen) {
        startIndex = Math.max(0, oldLen - 1);
      }
    }

    const defaultColW = this.d.getDefaultColWidth();
    const colWidths = this.d.getColWidths();
    let currentX = startIndex > 0
      ? this._colOffsets[startIndex - 1] + (colWidths[startIndex - 1] !== undefined ? colWidths[startIndex - 1] : defaultColW)
      : 0;

    for (let c = startIndex; c < colCount; c++) {
      this._colOffsets[c] = currentX;
      currentX += (colWidths[c] !== undefined ? colWidths[c] : defaultColW);
    }
    this._colOffsets[colCount] = currentX;
  }

  getFrozenSize() {
    if (!this._frozenSizeDirty && this._frozenSize) {
      return this._frozenSize;
    }

    let w = 0, h = 0;
    const freeze = this.d.getFreeze();
    const freezeC = freeze.c || 0;
    const freezeR = freeze.r || 0;

    for (let i = 0; i < freezeC; i++) {
      w += this.d.getColWidth(i);
    }
    for (let i = 0; i < freezeR; i++) {
      h += this.d.getRowHeight(i);
    }

    this._frozenSize = { w, h };
    this._frozenSizeDirty = false;
    return this._frozenSize;
  }

  _clearRowRange(startRow, endRow = -1) {
    if (startRow < 0) return;
    const maxRow = endRow === -1 ? this.d.getRowCount() : Math.min(endRow, this.d.getRowCount() - 1);
    this.d.getDataMatrix().deleteRowRange(startRow, maxRow);
  }

  getRowPos(r) {
    this._ensureOffsets();
    return this._rowOffsets[r] !== undefined ? this._rowOffsets[r] : 0;
  }

  getColPos(c) {
    this._ensureOffsets();
    return this._colOffsets[c] !== undefined ? this._colOffsets[c] : 0;
  }

  getRowIndexAt(y) {
    if (y < 0) return 0;
    this._ensureOffsets();
    let low = 0, high = this.d.getRowCount() - 1;
    while (low <= high) {
      let mid = (low + high) >> 1;
      let start = this._rowOffsets[mid];
      let end = this._rowOffsets[mid + 1];
      if (y >= start && y < end) return mid;
      if (y < start) high = mid - 1;
      else low = mid + 1;
    }
    return this.d.getRowCount();
  }

  getColIndexAt(x) {
    if (x < 0) return 0;
    this._ensureOffsets();
    let low = 0, high = this.d.getColCount() - 1;
    while (low <= high) {
      let mid = (low + high) >> 1;
      let start = this._colOffsets[mid];
      let end = this._colOffsets[mid + 1];
      if (x >= start && x < end) return mid;
      if (x < start) high = mid - 1;
      else low = mid + 1;
    }
    return this.d.getColCount();
  }

  get totalWidth() {
    this._ensureOffsets();
    return this._colOffsets[this.d.getColCount()] + 15;
  }

  get totalHeight() {
    this._ensureOffsets();
    return this._rowOffsets[this.d.getRowCount()] + 15;
  }

  markDirty() {
    this._offsetsDirty = true;
    this._layoutVersion++;
  }

  markFrozenDirty() {
    this._frozenSizeDirty = true;
  }

  destroy() {
    this._rowOffsets = [];
    this._colOffsets = [];
    this._offsetsDirty = true;
    this._frozenSize = null;
    this._frozenSizeDirty = true;
  }
}
