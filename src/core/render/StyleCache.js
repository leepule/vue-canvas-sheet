/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
const STYLE_PROPS = [
  'fontWeight', 'fontStyle', 'fontSize', 'color', 'bg',
  'align', 'valign', 'border', 'fmt', 'decimals'
];

const BORDER_PROP_INDEX = STYLE_PROPS.indexOf('border');
const BORDER_SIDES = ['top', 'bottom', 'left', 'right'];

/**
 * 手写 border 哈希片段。border.<side> 可能是：
 *   string（颜色，等价于 { color, style: 'solid' }）
 *   对象 { color?, style?, width? }
 * 避免使用 JSON.stringify（含键名遍历 / 引号转义开销）。
 */
function hashBorder(border) {
  // "B" 前缀 + 各侧的紧凑表示，未设侧用 "-"
  let s = 'B';
  for (let i = 0; i < BORDER_SIDES.length; i++) {
    const side = border[BORDER_SIDES[i]];
    if (side == null) {
      s += '-';
    } else if (typeof side === 'string') {
      s += '|s:' + side;
    } else {
      // 字段顺序固定，避免对象 key 顺序影响
      s += '|c:' + (side.color || '') + ',y:' + (side.style || '') + ',w:' + (side.width || '');
    }
  }
  return s;
}

export class StyleCache {
  constructor() {
    this.styleMap = new Map(); // 样式哈希 -> 唯一ID
    this.styleStore = new Map(); // ID -> 样式对象
    // 反向索引：ID -> 样式哈希。让 cleanup 删除时无需 O(N) 扫描 styleMap
    this._hashByStyleId = new Map();
    this.nextId = 0;

    // 样式使用统计
    this.usageCount = new Map();

    // 属性映射优化
    this._propMap = new Map();
    STYLE_PROPS.forEach((prop, index) => this._propMap.set(prop, index));
  }
  
  /**
   * 标准化并缓存样式
   */
  normalize(style) {
    if (!style) return null;
    
    // 生成基于属性的哈希键，避免使用 JSON.stringify
    const hash = this._generateHash(style);
    
    // 查找或创建样式ID
    let styleId = this.styleMap.get(hash);
    
    if (styleId === undefined) {
      styleId = this.nextId++;
      const normalized = this._normalizeStyle(style);
      this.styleMap.set(hash, styleId);
      this.styleStore.set(styleId, normalized);
      this._hashByStyleId.set(styleId, hash);
      this.usageCount.set(styleId, 0);
    }
    
    // 更新使用计数
    this.usageCount.set(styleId, (this.usageCount.get(styleId) || 0) + 1);
    
    return styleId;
  }

  /**
   * 生成样式的快速哈希键
   * @private
   */
  _generateHash(style) {
    let hash = '';
    // 只针对核心样式属性进行哈希
    for (let i = 0; i < STYLE_PROPS.length; i++) {
      const prop = STYLE_PROPS[i];
      const val = style[prop];
      if (val === undefined || val === null) continue;
      if (i === BORDER_PROP_INDEX && typeof val === 'object') {
        // border 走手写拼接，避开 JSON.stringify 开销
        hash += `${i}:${hashBorder(val)}|`;
      } else if (typeof val === 'object') {
        hash += `${i}:obj_${JSON.stringify(val)}|`;
      } else {
        hash += `${i}:${val}|`;
      }
    }

    // 处理动态添加的其他非核心属性
    for (const prop in style) {
      if (!this._propMap.has(prop)) {
        hash += `${prop}:${JSON.stringify(style[prop])}|`;
      }
    }

    return hash;
  }
  
  /**
   * 标准化样式对象
   */
  _normalizeStyle(style) {
    const normalized = {};
    
    // 按固定顺序排列核心属性
    for (const prop of STYLE_PROPS) {
      if (style[prop] !== undefined) {
        normalized[prop] = style[prop];
      }
    }
    
    // 添加其他非核心属性
    for (const prop in style) {
      if (normalized[prop] === undefined) {
        normalized[prop] = style[prop];
      }
    }
    
    return normalized;
  }
  
  /**
   * 获取样式对象
   */
  getStyle(styleId) {
    return this.styleStore.get(styleId);
  }
}