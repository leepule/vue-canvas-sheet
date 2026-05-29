/**
 * 单元格工具函数
 */

/**
 * 将列字母字符串转换为 0 基索引（如 'A' → 0, 'Z' → 25, 'AA' → 26）
 * @param {string} str - 列字母字符串
 * @returns {number} 0 基列索引
 */
export function colStrToIndex(str) {
  let val = 0;
  for (let i = 0; i < str.length; i++) {
    val *= 26;
    val += str.charCodeAt(i) - 64;
  }
  return val - 1;
}
