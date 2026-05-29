/**
 * 表格结构管理器
 * 管理行列的插入、删除和自动填充
 */
import { cloneCell } from './utils/Clipboard.js';

export class SheetStructure {
  constructor(deps) {
    this.d = deps;
  }

  fillAuto(sourceRange, targetRange) {
    const s = sourceRange;
    const t = targetRange;
    const isVert = (t.e.r > s.e.r);
    const updates = [];

    const srcSize = isVert ? (s.e.r - s.s.r + 1) : (s.e.c - s.s.c + 1);
    const outerStart = isVert ? t.s.c : t.s.r;
    const outerEnd = isVert ? t.e.c : t.e.r;

    for (let outer = outerStart; outer <= outerEnd; outer++) {
      const srcCross = (isVert ? s.s.c : s.s.r) + ((outer - outerStart) % (isVert ? (s.e.c - s.s.c + 1) : (s.e.r - s.s.r + 1)));

      const nums = [];
      let allNum = true;
      const srcFillStart = isVert ? s.s.r : s.s.c;
      const srcFillEnd = isVert ? s.e.r : s.e.c;

      for (let i = srcFillStart; i <= srcFillEnd; i++) {
        const cell = isVert ? this.d.getCell(i, srcCross) : this.d.getCell(srcCross, i);
        const val = cell ? cell.v : null;
        if (typeof val === 'number') {
          nums.push(val);
        } else if (val && !isNaN(parseFloat(String(val).replace(/,/g, ''))) && String(val).trim() !== '') {
          nums.push(parseFloat(String(val).replace(/,/g, '')));
        } else {
          allNum = false;
          nums.push(val);
        }
      }

      let step = 0;
      let isSequence = false;
      if (allNum && nums.length >= 2) {
        const d1 = nums[1] - nums[0];
        let constantDiff = true;
        for (let i = 1; i < nums.length; i++) {
          if (Math.abs(nums[i] - nums[i - 1] - d1) > 1e-9) {
            constantDiff = false;
            break;
          }
        }
        if (constantDiff) {
          step = d1;
          isSequence = true;
        }
      }

      const fillStart = isVert ? s.e.r : s.e.c;
      const fillEnd = isVert ? t.e.r : t.e.c;
      const srcFillBase = isVert ? s.s.r : s.s.c;

      for (let i = fillStart + 1; i <= fillEnd; i++) {
        const srcCycle = srcFillBase + ((i - fillStart - 1) % srcSize);
        const srcCell = isVert ? this.d.getCell(srcCycle, srcCross) : this.d.getCell(srcCross, srcCycle);
        const newStyle = srcCell ? srcCell.s : undefined;
        let newVal;
        if (isSequence) {
          const index = i - srcFillBase;
          newVal = nums[0] + step * index;
        } else {
          const patternIdx = (i - fillStart - 1) % nums.length;
          newVal = nums[patternIdx];
        }
        const r = isVert ? i : outer;
        const c = isVert ? outer : i;
        updates.push({ r, c, val: { v: newVal, s: newStyle } });
      }
    }

    if (updates.length > 0) {
      this.d.bulkSetCells(updates);
    }
  }

  insertRow(rowIndex) {
    this._shiftDimension(true, rowIndex, 1);
    this.d.getHistory().execute({ type: 'insert-row', r: rowIndex });
  }

  deleteRow(rowIndex) {
    const deletedCells = [];
    const rowData = this.d.getDataMatrix().getRow(rowIndex);
    if (rowData) {
      for (const [col, cell] of rowData) {
        deletedCells.push({ c: col, cell: cloneCell(cell) });
      }
    }
    this._shiftDimension(true, rowIndex, -1);
    this.d.getHistory().execute({ type: 'delete-row', r: rowIndex, deletedCells });
  }

  insertColumn(colIndex) {
    this._shiftDimension(false, colIndex, 1);
    this.d.getHistory().execute({ type: 'insert-col', c: colIndex });
  }

  deleteColumn(colIndex) {
    const deletedCells = [];
    const colData = this.d.getDataMatrix().getCol(colIndex);
    if (colData) {
      for (const [row, cell] of colData) {
        deletedCells.push({ r: row, cell: cloneCell(cell) });
      }
    }
    this._shiftDimension(false, colIndex, -1);
    this.d.getHistory().execute({ type: 'delete-col', c: colIndex, deletedCells });
  }

  _shiftDimension(isRow, index, delta) {
    const isInsert = delta > 0;
    const dataMatrix = this.d.getDataMatrix();

    if (!isInsert) {
      if (isRow) dataMatrix.deleteRow(index);
      else dataMatrix.deleteCol(index);
    }

    const indicesSet = new Set();
    dataMatrix.forEach((r, c, cell) => {
      const idx = isRow ? r : c;
      if (isInsert ? idx >= index : idx > index) {
        indicesSet.add(idx);
      }
    });
    const indices = Array.from(indicesSet);
    indices.sort((a, b) => b - a);

    for (const idx of indices) {
      const lineData = isRow ? dataMatrix.getRow(idx) : dataMatrix.getCol(idx);
      if (lineData) {
        for (const [otherIdx, cell] of lineData) {
          dataMatrix.delete(isRow ? idx : otherIdx, isRow ? otherIdx : idx, true);
          const newIdx = idx + delta;
          dataMatrix.set(isRow ? newIdx : otherIdx, isRow ? otherIdx : newIdx, cell, true);
        }
      }
    }

    if (isRow) {
      this.d.setRowCount(isInsert ? this.d.getRowCount() + 1 : Math.max(1, this.d.getRowCount() - 1));
    } else {
      this.d.setColCount(isInsert ? this.d.getColCount() + 1 : Math.max(1, this.d.getColCount() - 1));
    }
    this.d.setDataVersion(this.d.getDataVersion() + 1);
    this.d.markDirty();
    this.d.markFrozenDirty();
    this.d.notify();
  }

  _insertRow(r) { this._shiftDimension(true, r, 1); }
  _deleteRow(r) { this._shiftDimension(true, r, -1); }
  _insertColumn(c) { this._shiftDimension(false, c, 1); }
  _deleteColumn(c) { this._shiftDimension(false, c, -1); }
}
