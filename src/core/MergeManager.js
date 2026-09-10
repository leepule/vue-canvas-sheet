/**
 * 合并单元格管理器 — 管理合并单元格的索引、查询、添加与删除。
 *
 * @typedef {Object} MergeManagerDeps
 * @property {() => Array<{s:{r,c}, e:{r,c}}>} getMerges      — 获取合并区域列表
 * @property {(v: Array) => void}               setMerges      — 设置合并区域列表
 * @property {() => Map<string, Object>}        getMergeMap    — 获取合并映射 (cellKey → mergeInfo)
 * @property {(r: number, c: number) => string} getCellKey     — 行列 → 单元格键
 * @property {(range: Object, cb: Function) => void} iterateRange — 遍历范围内单元格
 * @property {() => SparseMatrix}               getDataMatrix  — 数据矩阵引用
 * @property {() => HistoryManager}             getHistory     — 历史管理器
 * @property {(...args: any[]) => void}         emit           — 事件发射
 * @property {(...args: any[]) => void}         notify         — UI 通知
 */

import { cloneCell, cloneRange } from './utils/Clipboard.js';
import { Events } from './events/EventEmitter.js';
export class MergeManager {
  /**
   * @param {MergeManagerDeps} deps — 具名依赖注入，详见 MergeManagerDeps typedef
   */
  constructor(deps) {
    /** @type {MergeManagerDeps} */
    this.d = deps;
    this._mergeRowIndex = new Map();
    this._mergeIndexDirty = true;
  }

  _rebuildMergeIndex() {
    if (!this._mergeIndexDirty) return;

    this._mergeRowIndex.clear();
    const merges = this.d.getMerges();

    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      for (let r = m.s.r; r <= m.e.r; r++) {
        if (!this._mergeRowIndex.has(r)) {
          this._mergeRowIndex.set(r, []);
        }
        this._mergeRowIndex.get(r).push(m);
      }
    }

    this._mergeIndexDirty = false;
  }

  getIntersectingMerges(range) {
    this._rebuildMergeIndex();

    const result = [];
    const seen = new Set();

    for (let r = range.s.r; r <= range.e.r; r++) {
      const mergesInRow = this._mergeRowIndex.get(r);
      if (mergesInRow) {
        for (let i = 0; i < mergesInRow.length; i++) {
          const m = mergesInRow[i];
          const key = `${m.s.r}-${m.s.c}-${m.e.r}-${m.e.c}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const intersects = !(range.e.c < m.s.c || range.s.c > m.e.c ||
                              range.e.r < m.s.r || range.s.r > m.e.r);
          if (intersects) {
            result.push(m);
          }
        }
      }
    }

    return result;
  }

  addMerge(range) {
    const merges = [...this.d.getMerges(), range];
    this.d.setMerges(merges);
    const mergeMap = { ...this.d.getMergeMap() };
    this.d.iterateRange(range, (r, c) => {
      mergeMap[this.d.getCellKey(r, c)] = range;
    });
    this.d.setMergeMap(mergeMap);
    this._mergeIndexDirty = true;
    this.d.emit(Events.MERGE_CHANGE, { action: 'add', range });
    this.d.notify();
  }

  removeMerge(range) {
    const merges = this.d.getMerges();
    const mergeMap = { ...this.d.getMergeMap() };
    const toRemove = merges.filter(m => {
      const intersects = !(range.e.c < m.s.c || range.s.c > m.e.c || range.e.r < m.s.r || range.s.r > m.e.r);
      return intersects;
    });
    toRemove.forEach(m => {
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          delete mergeMap[this.d.getCellKey(r, c)];
        }
      }
    });
    const removeSet = new Set(toRemove);
    this.d.setMerges(merges.filter(m => !removeSet.has(m)));
    this.d.setMergeMap(mergeMap);
    this._mergeIndexDirty = true;
    this.d.emit(Events.MERGE_CHANGE, { action: 'remove', range, removed: toRemove });
    this.d.notify();
  }

  getMerge(r, c) {
    return this.d.getMergeMap()[this.d.getCellKey(r, c)] || null;
  }

  mergeCells(range) {
    if (range.s.r === range.e.r && range.s.c === range.e.c) return;
    this.d.getHistory().startBatch();
    const changes = [];
    this.d.iterateRange(range, (r, c, cell) => {
      if (r === range.s.r && c === range.s.c) return;
      const oldVal = cell ? cloneCell(cell) : null;
      if (oldVal) {
        this.d.getDataMatrix().delete(r, c);
        changes.push({ r, c, oldValue: oldVal, newValue: null });
      }
    });
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
    }
    const rr = cloneRange(range);
    this.addMerge(rr);
    this.d.getHistory().execute({ type: 'merge', range: rr });
    this.d.getHistory().endBatch();
  }

  unmergeCells(range) {
    const sel = range;
    const toRemove = this.d.getMerges().filter(m => {
      const intersects = !(sel.e.c < m.s.c || sel.s.c > m.e.c || sel.e.r < m.s.r || sel.s.r > m.e.r);
      return intersects;
    });
    if (toRemove.length > 0) {
      this.d.getHistory().startBatch();
      toRemove.forEach(m => {
        this.removeMerge(m);
        this.d.getHistory().execute({ type: 'unmerge', range: m });
      });
      this.d.getHistory().endBatch();
    }
  }

  allowsMerge(range) {
    if (!range) return false;
    return range.s.r !== range.e.r || range.s.c !== range.e.c;
  }

  allowsUnmerge(range) {
    if (!range) return false;
    const intersecting = this.getIntersectingMerges(range);
    return intersecting.length > 0;
  }

  destroy() {
    this._mergeRowIndex.clear();
    this._mergeIndexDirty = true;
  }
}
