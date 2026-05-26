/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 样式位掩码与工具函数
 * 用于高效存储和比较布尔样式属性
 */

export const STYLE_BIT = {
  BOLD: 1 << 0,
  ITALIC: 1 << 1,
  STRIKE: 1 << 2,
  UNDERLINE: 1 << 3,
  WRAP: 1 << 4
};

export class StyleUtils {
  /**
   * 将样式对象转换为位掩码
   * @param {Object} style 
   * @returns {number}
   */
  static encodeBitmask(style) {
    let mask = 0;
    if (style.fontWeight === 'bold') mask |= STYLE_BIT.BOLD;
    if (style.fontStyle === 'italic') mask |= STYLE_BIT.ITALIC;
    if (style.td === 'line-through') mask |= STYLE_BIT.STRIKE;
    if (style.td === 'underline') mask |= STYLE_BIT.UNDERLINE;
    if (style.wrap) mask |= STYLE_BIT.WRAP;
    return mask;
  }

  /**
   * 从位掩码还原部分样式
   * @param {number} mask 
   * @returns {Object}
   */
  static decodeBitmask(mask) {
    return {
      fontWeight: (mask & STYLE_BIT.BOLD) ? 'bold' : undefined,
      fontStyle: (mask & STYLE_BIT.ITALIC) ? 'italic' : undefined,
      td: (mask & STYLE_BIT.STRIKE) ? 'line-through' : (mask & STYLE_BIT.UNDERLINE ? 'underline' : undefined),
      wrap: !!(mask & STYLE_BIT.WRAP)
    };
  }

  /**
   * 快速比较两个样式位掩码
   */
  static compare(mask1, mask2) {
    return mask1 === mask2;
  }
}
