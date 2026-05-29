/**
 * 单元格迭代工具函数
 */

/**
 * 计算合并单元格的像素尺寸
 * @param {Object} wb - 工作簿实例
 * @param {Object} merge - 合并范围 { s: { r, c }, e: { r, c } }
 * @param {number} r - 合并起始行
 * @param {number} c - 合并起始列
 * @returns {{ mw: number, mh: number }}
 */
export function calcMergeSize(wb, merge, r, c) {
  let mw = 0;
  for (let i = c; i <= merge.e.c; i++) mw += wb.getColWidth(i);
  let mh = 0;
  for (let i = r; i <= merge.e.r; i++) mh += wb.getRowHeight(i);
  return { mw, mh };
}
