/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 命令执行器 — 将 applyCommand 的 11 分支 switch 逻辑从 Workbook 解耦
 *
 * @typedef {Object} CommandExecutorDeps
 * @property {(r: number, c: number, val: any) => void} updateCellContent
 * @property {(from: number, to: number) => void}                moveColumnData
 * @property {import('../MergeManager').MergeManager}            mergeManager
 * @property {import('../SheetStructure').SheetStructure}        sheetStructure
 * @property {import('../LayoutEngine').LayoutEngine}            layoutEngine
 * @property {import('../../data/Store').DataStore}              dataStore
 * @property {SparseMatrix}                                      dataMatrix
 * @property {() => number}                                      getFreezeR
 * @property {() => number}                                      getFreezeC
 * @property {() => Object}                                      getRowHeights
 * @property {(v: Object) => void}                               setRowHeights
 * @property {() => Object}                                      getColWidths
 * @property {(v: Object) => void}                               setColWidths
 * @property {() => void}                                        notify
 */

import { cloneCell } from '../utils/Clipboard.js';

export class CommandExecutor {
  /**
   * @param {CommandExecutorDeps} deps
   */
  constructor(deps) {
    /** @type {CommandExecutorDeps} */
    this.d = deps;
  }

  /**
   * 执行命令（供 HistoryManager 的 applyCommand 回调使用）
   * @param {Object} cmd
   * @param {boolean} isUndo
   */
  execute(cmd, isUndo) {
    switch (cmd.type) {
      case 'set-cell':
        this._applySetCell(cmd, isUndo); break;
      case 'batch-set-cell':
        this._applyBatchSetCell(cmd, isUndo); break;
      case 'move-column':
        this._applyMoveColumn(cmd, isUndo); break;
      case 'batch':
        this._applyBatch(cmd, isUndo); break;
      case 'set-col-width':
        this._applySetColWidth(cmd, isUndo); break;
      case 'set-row-height':
        this._applySetRowHeight(cmd, isUndo); break;
      case 'merge':
        this._applyMerge(cmd, isUndo); break;
      case 'unmerge':
        this._applyUnmerge(cmd, isUndo); break;
      case 'insert-row':
        this._applyInsertRow(cmd, isUndo); break;
      case 'delete-row':
        this._applyDeleteRow(cmd, isUndo); break;
      case 'insert-col':
        this._applyInsertCol(cmd, isUndo); break;
      case 'delete-col':
        this._applyDeleteCol(cmd, isUndo); break;
    }
    this.d.layoutEngine.markDirty();
    this.d.notify();
  }

  _applySetCell(cmd, isUndo) {
    const val = isUndo ? cmd.oldValue : cmd.newValue;
    // clone 后放回矩阵：history 快照与活单元格解耦，避免活 cell 被对象池回收时
    // 就地清空共享的 s/border 对象，进而摧毁 history 中的 oldValue/newValue 快照
    this.d.updateCellContent(cmd.r, cmd.c, (val && typeof val === 'object') ? cloneCell(val) : val);
  }

  _applyBatchSetCell(cmd, isUndo) {
    cmd.changes.forEach(change => {
      const val = isUndo ? change.oldValue : change.newValue;
      // 同 _applySetCell：clone 隔离 history 快照，防止池回收就地清空共享样式对象
      this.d.updateCellContent(change.r, change.c, (val && typeof val === 'object') ? cloneCell(val) : val);
    });
  }

  _applyMoveColumn(cmd, isUndo) {
    const from = isUndo ? cmd.to : cmd.from;
    const to = isUndo ? cmd.from : cmd.to;
    this.d.moveColumnData(from, to);
  }

  _applyBatch(cmd, isUndo) {
    const cmds = isUndo ? [...cmd.cmds].reverse() : cmd.cmds;
    cmds.forEach(subCmd => this.execute(subCmd, isUndo));
  }

  _applySetColWidth(cmd, isUndo) {
    const colWidths = { ...this.d.getColWidths() };
    if (isUndo) colWidths[cmd.c] = cmd.oldValue;
    else colWidths[cmd.c] = cmd.newValue;
    this.d.setColWidths(colWidths);
    if (cmd.c < (this.d.getFreezeC() || 0)) {
      this.d.layoutEngine.markFrozenDirty();
    }
  }

  _applySetRowHeight(cmd, isUndo) {
    const rowHeights = { ...this.d.getRowHeights() };
    if (isUndo) rowHeights[cmd.r] = cmd.oldValue;
    else rowHeights[cmd.r] = cmd.newValue;
    this.d.setRowHeights(rowHeights);
    if (cmd.r < (this.d.getFreezeR() || 0)) {
      this.d.layoutEngine.markFrozenDirty();
    }
  }

  _applyMerge(cmd, isUndo) {
    if (isUndo) this.d.mergeManager.removeMerge(cmd.range);
    else this.d.mergeManager.addMerge(cmd.range);
  }

  _applyUnmerge(cmd, isUndo) {
    if (isUndo) this.d.mergeManager.addMerge(cmd.range);
    else this.d.mergeManager.removeMerge(cmd.range);
  }

  _applyInsertRow(cmd, isUndo) {
    if (isUndo) this.d.sheetStructure._deleteRow(cmd.r);
    else this.d.sheetStructure._insertRow(cmd.r);
  }

  _applyDeleteRow(cmd, isUndo) {
    if (isUndo) {
      this.d.sheetStructure._insertRow(cmd.r);
      if (cmd.deletedCells) {
        for (const { c, cell } of cmd.deletedCells) {
          if (cell) this.d.dataMatrix.set(cmd.r, c, cloneCell(cell));
        }
      }
    } else {
      this.d.sheetStructure._deleteRow(cmd.r);
    }
  }

  _applyInsertCol(cmd, isUndo) {
    if (isUndo) this.d.sheetStructure._deleteColumn(cmd.c);
    else this.d.sheetStructure._insertColumn(cmd.c);
  }

  _applyDeleteCol(cmd, isUndo) {
    if (isUndo) {
      this.d.sheetStructure._insertColumn(cmd.c);
      if (cmd.deletedCells) {
        for (const { r, cell } of cmd.deletedCells) {
          if (cell) this.d.dataMatrix.set(r, cmd.c, cloneCell(cell));
        }
      }
    } else {
      this.d.sheetStructure._deleteColumn(cmd.c);
    }
  }
}
