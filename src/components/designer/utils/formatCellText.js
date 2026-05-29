/**
 * 格式化单元格文本（数字格式化：decimals / percent / comma）
 * 在主线程渲染和 Worker 渲染中共享
 */
export function formatCellText(val, style) {
  if (val === null || val === undefined || val === '') return '';

  const textVal = String(val);
  if (!style) return textVal;

  const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
  const numVal = parseFloat(cleanVal);
  if (isNaN(numVal)) return textVal;

  if (style.fmt === 'percent') {
    let pVal = parseFloat(cleanVal) * 100;
    if (style.decimals !== undefined) pVal = Number(pVal.toFixed(style.decimals));
    return pVal.toFixed(style.decimals !== undefined ? style.decimals : 2) + '%';
  }

  if (style.fmt === 'comma') {
    const opts = {};
    if (style.decimals !== undefined) {
      opts.minimumFractionDigits = style.decimals;
      opts.maximumFractionDigits = style.decimals;
    }
    return parseFloat(cleanVal).toLocaleString('en-US', opts);
  }

  if (style.decimals !== undefined) {
    return Number(numVal.toFixed(style.decimals)).toFixed(style.decimals);
  }

  return textVal;
}
