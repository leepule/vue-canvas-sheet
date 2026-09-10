/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

import { Events } from './events/EventEmitter.js';
import { cloneRange } from './utils/Clipboard.js';

/**
 * 选区状态管理器。
 *
 * Workbook 只负责生命周期和向后兼容代理，选区扩展、活动单元格、
 * 复制范围与选区事件都收敛在这里。
 */
export class SelectionManager {
  /**
   * @param {{
   *   getSelection: () => any,
   *   setSelectionState: (selection: any) => void,
   *   getActiveCell: () => any,
   *   setActiveCell: (cell: any) => void,
   *   setCopyRangeState: (range: any) => void,
   *   mergeManager: import('./MergeManager.js').MergeManager,
   *   emit: (event: string, payload?: any) => void,
   *   notify: (payload?: any) => void
   * }} deps
   */
  constructor(deps) {
    this.d = deps;
  }

  get selection() {
    return this.d.getSelection();
  }

  get activeCell() {
    return this.d.getActiveCell();
  }

  setSelection(startR, startC, endR, endC) {
    const normalized = this._normalizeSelectionArgs(startR, startC, endR, endC);
    if (!normalized) return;

    const { start, end } = normalized;
    let s = { r: Math.min(start.r, end.r), c: Math.min(start.c, end.c) };
    let e = { r: Math.max(start.r, end.r), c: Math.max(start.c, end.c) };
    let expanded = true;

    this.d.mergeManager._rebuildMergeIndex();

    while (expanded) {
      expanded = false;
      const currentRange = { s, e };
      const intersectingMerges = this.d.mergeManager.getIntersectingMerges(currentRange);

      for (let i = 0; i < intersectingMerges.length; i++) {
        const m = intersectingMerges[i];
        const newSR = Math.min(s.r, m.s.r);
        const newSC = Math.min(s.c, m.s.c);
        const newER = Math.max(e.r, m.e.r);
        const newEC = Math.max(e.c, m.e.c);
        if (newSR < s.r || newSC < s.c || newER > e.r || newEC > e.c) {
          s.r = newSR; s.c = newSC;
          e.r = newER; e.c = newEC;
          expanded = true;
          break;
        }
      }
    }

    const selection = { s, e };
    this.d.setSelectionState(selection);

    const anchorMerge = this.d.mergeManager.getMerge(start.r, start.c);
    this.d.setActiveCell(anchorMerge
      ? { r: anchorMerge.s.r, c: anchorMerge.s.c }
      : { r: start.r, c: start.c });

    this.d.emit(Events.SELECTION_CHANGE, {
      selection: this.selection,
      activeCell: this.activeCell
    });
    this.d.notify({ type: 'selection' });
  }

  setCopyRange(range) {
    this.d.setCopyRangeState(cloneRange(range));
    this.d.notify({ type: 'selection' });
  }

  clearCopyRange() {
    this.d.setCopyRangeState(null);
    this.d.notify({ type: 'selection' });
  }

  destroy() {
    this.d = null;
  }

  _normalizeSelectionArgs(startR, startC, endR, endC) {
    if (startR && typeof startR === 'object') {
      if (startR.selection) {
        return this._normalizeSelectionArgs(startR.selection);
      }
      if (startR.s && startR.e) {
        return {
          start: { r: startR.s.r, c: startR.s.c },
          end: { r: startR.e.r, c: startR.e.c }
        };
      }
      if ('startRow' in startR || 'startCol' in startR || 'endRow' in startR || 'endCol' in startR) {
        const sr = startR.startRow ?? startR.r ?? 0;
        const sc = startR.startCol ?? startR.c ?? 0;
        return {
          start: { r: sr, c: sc },
          end: { r: startR.endRow ?? sr, c: startR.endCol ?? sc }
        };
      }
    }

    if (![startR, startC, endR, endC].every(Number.isFinite)) return null;
    return {
      start: { r: startR, c: startC },
      end: { r: endR, c: endC }
    };
  }
}

export default SelectionManager;
