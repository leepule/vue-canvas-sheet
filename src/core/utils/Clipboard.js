/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 浅克隆单元格对象
 * 单元格结构: { v, s, f, dirty }
 * 样式结构: { bg, color, align, valign, fontSize, fontWeight, border, ... }
 * 只需要两层浅拷贝，比 cloneDeep 快 10 倍以上
 *
 * @param {Object|null} cell - 单元格对象
 * @returns {Object} 克隆后的单元格对象
 */
function cloneCell(cell) {
  if (!cell) {
    // 返回 null 表示单元格不存在
    return null;
  }
  
  // 创建新的单元格对象（不使用对象池，避免污染）
  const result = { ...cell };
  
  // 样式对象需要单独拷贝
  if (cell.s) {
    result.s = { ...cell.s };
    // border 是嵌套对象，需要额外处理
    if (cell.s.border) {
      result.s.border = {
        top: cell.s.border.top ? { ...cell.s.border.top } : undefined,
        bottom: cell.s.border.bottom ? { ...cell.s.border.bottom } : undefined,
        left: cell.s.border.left ? { ...cell.s.border.left } : undefined,
        right: cell.s.border.right ? { ...cell.s.border.right } : undefined
      };
    }
  }
  
  return result;
}

/**
 * 浅克隆范围对象
 * 范围结构: { s: { r, c }, e: { r, c } }
 *
 * @param {Object} range - 范围对象
 * @returns {Object} 克隆后的范围对象
 */
function cloneRange(range) {
  if (!range) return null;
  return {
    s: { r: range.s.r, c: range.s.c },
    e: { r: range.e.r, c: range.e.c }
  };
}

export class ClipboardManager {
    /**
     * @param {{
     *   getCell: (r: number, c: number) => any,
     *   getRowCount: () => number,
     *   getColCount: () => number,
     *   setCellData: (r: number, c: number, val: any) => void,
     *   recordHistory: (cmd: any) => void,
     *   notify: (data?: any) => void
     * }} deps
     */
    constructor(deps) {
        this.d = deps;
        this.clipboardData = [];
    }

    copy(range) {
        if (!range) return;
        const data = [];
        for (let r = range.s.r; r <= range.e.r; r++) {
          const rowData = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            rowData.push(cloneCell(this.d.getCell(r, c)));
          }
          data.push(rowData);
        }
        this.clipboardData = data;
    }

	    paste(range) {
	        if (!this.clipboardData || this.clipboardData.length === 0) return;
	        const changes = [];
        const startR = range.s.r;
        const startC = range.s.c;
        const rowCount = this.d.getRowCount();
        const colCount = this.d.getColCount();

        for (let i = 0; i < this.clipboardData.length; i++) {
          for (let j = 0; j < this.clipboardData[i].length; j++) {
            const r = startR + i;
            const c = startC + j;
            if (r >= rowCount || c >= colCount) continue;

            // 保存旧值用于撤销
            const oldVal = cloneCell(this.d.getCell(r, c));

            // 克隆剪贴板数据
            const sourceVal = this.clipboardData[i][j];
            const newVal = cloneCell(sourceVal);

            changes.push({ r, c, oldValue: oldVal, newValue: newVal });
            this.d.setCellData(r, c, newVal);
          }
        }
        if (changes.length > 0) {
          this.d.recordHistory({ type: 'batch-set-cell', changes });
	          this.d.notify();
	        }
	    }

	    destroy() {
	        this.clipboardData = [];
	        this.d = null;
	    }
	}

// 导出工具函数供其他模块使用
export { cloneCell, cloneRange };
