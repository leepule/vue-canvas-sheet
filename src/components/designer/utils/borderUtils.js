/**
 * 边框属性解析工具
 * 将边框值（字符串或对象）统一解析为 { color, style } 格式
 * @param {string|Object} b - 边框值
 * @returns {{ color: string, style: string }}
 */
export function getBorderProps(b) {
  if (typeof b === 'string') return { color: b, style: 'solid' };
  return {
    color: (b && b.color) ? b.color : '#000000',
    style: (b && b.style) ? b.style : 'solid'
  };
}
