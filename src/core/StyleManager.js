/**
 * 样式管理器 — 管理单元格样式、边框、数字格式的设置与清除。
 *
 * @typedef {Object} StyleManagerDeps
 * @property {(range: Object, cb: Function) => void} iterateRange        — 遍历范围内单元格
 * @property {(r: number, c: number, v: Object) => void} setCellData     — 设置单元格数据
 * @property {(r: number, c: number) => Cell|null}     getCell           — 获取单元格
 * @property {(r: number, c: number) => string}        getCellKey        — 行列 → 单元格键
 * @property {() => SparseMatrix}                      getDataMatrix     — 数据矩阵引用
 * @property {() => HistoryManager}                    getHistory        — 历史管理器
 * @property {(r: number, c: number, v: number) => void} syncSharedValue — 同步到共享内存
 * @property {(id: string, f: string) => void}         updateDependencyMap — 更新公式依赖图
 * @property {(r: number, c: number) => void}          markCellChanged   — 标记单元格变更
 * @property {(...args: any[]) => void}                emit              — 事件发射
 * @property {(...args: any[]) => void}                notify            — UI 通知
 */

import { cloneCell } from './utils/Clipboard.js';
import { Events } from './events/EventEmitter.js';
export class StyleManager {
  /**
   * @param {StyleManagerDeps} deps — 具名依赖注入，详见 StyleManagerDeps typedef
   */
  constructor(deps) {
    /** @type {StyleManagerDeps} */
    this.d = deps;
  }

  setStyle(range, style) {
    const changes = [];
    this.d.iterateRange(range, (r, c, cell) => {
      const oldVal = cloneCell(cell);
      const oldStyle = oldVal ? (oldVal.s || {}) : {};
      const newStyle = { ...oldStyle, ...style };
      Object.keys(style).forEach(k => {
        if (style[k] === undefined) delete newStyle[k];
      });
      const newVal = oldVal ? { ...oldVal, s: newStyle } : { s: newStyle };
      changes.push({ r: r, c, oldValue: oldVal, newValue: newVal });
      this.d.setCellData(r, c, { s: newStyle });
    });
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
      this.d.emit(Events.STYLE_CHANGE, { range, style, changes });
      this.d.notify();
    }
  }

  setBorder(range, type, color, style = 'solid') {
    if (!range) return;
    const changes = [];
    const getStyle = (r, c) => {
      const cell = this.d.getCell(r, c);
      if (cell && cell.s) return { ...cell.s };
      return {};
    };
    const getBorder = (s) => {
      if (s.border) return { ...s.border };
      return {};
    };
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const oldVal = cloneCell(this.d.getCell(r, c));
        let changeNeeded = false;
        let s = getStyle(r, c);
        let b = getBorder(s);
        const isTop = r === range.s.r;
        const isBottom = r === range.e.r;
        const isLeft = c === range.s.c;
        const isRight = c === range.e.c;
        const safeColor = color || '#000000';
        const bStyle = { color: safeColor, style };
        if (type === 'all') {
          b.top = { ...bStyle }; b.bottom = { ...bStyle }; b.left = { ...bStyle }; b.right = { ...bStyle };
          changeNeeded = true;
        } else if (type === 'color') {
          if (b.top) { b.top = { ...b.top, color: safeColor }; changeNeeded = true; }
          if (b.bottom) { b.bottom = { ...b.bottom, color: safeColor }; changeNeeded = true; }
          if (b.left) { b.left = { ...b.left, color: safeColor }; changeNeeded = true; }
          if (b.right) { b.right = { ...b.right, color: safeColor }; changeNeeded = true; }
        } else if (type === 'none') {
          b.top = undefined; b.bottom = undefined; b.left = undefined; b.right = undefined;
          changeNeeded = true;
        } else if (type === 'outer') {
          if (isTop) { b.top = { ...bStyle }; changeNeeded = true; }
          if (isBottom) { b.bottom = { ...bStyle }; changeNeeded = true; }
          if (isLeft) { b.left = { ...bStyle }; changeNeeded = true; }
          if (isRight) { b.right = { ...bStyle }; changeNeeded = true; }
        } else if (type === 'left') {
          if (isLeft) { b.left = { ...bStyle }; changeNeeded = true; }
        } else if (type === 'right') {
          if (isRight) { b.right = { ...bStyle }; changeNeeded = true; }
        } else if (type === 'top') {
          if (isTop) { b.top = { ...bStyle }; changeNeeded = true; }
        } else if (type === 'bottom') {
          if (isBottom) { b.bottom = { ...bStyle }; changeNeeded = true; }
        } else if (type === 'inner') {
          if (!isTop) { b.top = { ...bStyle }; changeNeeded = true; }
          if (!isBottom) { b.bottom = { ...bStyle }; changeNeeded = true; }
          if (!isLeft) { b.left = { ...bStyle }; changeNeeded = true; }
          if (!isRight) { b.right = { ...bStyle }; changeNeeded = true; }
        }
        if (changeNeeded) {
          s.border = b;
          const newVal = { ...oldVal, s };
          changes.push({ r: r, c, oldValue: oldVal, newValue: newVal });
          this.d.setCellData(r, c, { s });
        }
      }
    }
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
      this.d.emit(Events.STYLE_CHANGE, { range, borderType: type, color, changes });
      this.d.notify();
    }
  }

  setFormat(range, fmt) {
    if (!range) return;
    const changes = [];
    this.d.iterateRange(range, (r, c, cell) => {
      const oldVal = cloneCell(cell);
      const oldStyle = oldVal ? (oldVal.s || {}) : {};
      const s = { ...oldStyle };
      s.fmt = fmt;
      if (fmt === 'percent' && s.decimals === undefined) s.decimals = 0;
      const newVal = oldVal ? { ...oldVal, s } : { s };
      changes.push({ r: r, c, oldValue: oldVal, newValue: newVal });
      this.d.setCellData(r, c, { s });
    });
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
      this.d.notify();
    }
  }

  setDecimals(range, delta) {
    if (!range) return;
    const changes = [];
    this.d.iterateRange(range, (r, c, cell) => {
      const oldVal = cloneCell(cell);
      const oldStyle = oldVal ? (oldVal.s || {}) : {};
      const s = { ...oldStyle };
      let dec = (s.decimals !== undefined) ? s.decimals : 2;
      dec += delta;
      if (dec < 0) dec = 0;
      if (dec > 10) dec = 10;
      s.decimals = dec;
      const newVal = oldVal ? { ...oldVal, s } : { s };
      changes.push({ r: r, c, oldValue: oldVal, newValue: newVal });
      this.d.setCellData(r, c, { s });
    });
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
      this.d.notify();
    }
  }

  clearContent(range) {
    if (!range) return;
    const changes = [];
    this.d.iterateRange(range, (r, c, cell) => {
      if (!cell) return;

      const oldVal = cloneCell(cell);
      if (oldVal.v !== undefined || oldVal.f !== undefined || oldVal.m !== undefined) {
        const cellId = this.d.getCellKey(r, c);
        const newVal = { ...oldVal };
        delete newVal.v;
        delete newVal.f;
        delete newVal.m;
        delete newVal.dirty;
        changes.push({ r: r, c, oldValue: oldVal, newValue: newVal });

        const targetCell = this.d.getDataMatrix().get(r, c);
        if (targetCell) {
          delete targetCell.v;
          delete targetCell.f;
          delete targetCell.m;
          delete targetCell.dirty;

          this.d.syncSharedValue(r, c, null);
          this.d.updateDependencyMap(cellId, null);
        }

        this.d.markCellChanged(r, c);
      }
    });
    if (changes.length > 0) {
      this.d.getHistory().execute({ type: 'batch-set-cell', changes });
      this.d.notify();
    }
  }
}
