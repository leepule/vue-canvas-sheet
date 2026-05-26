/**
 * OffscreenCanvas 渲染 Worker
 * 
 * 在 Worker 中执行 Canvas 渲染，避免阻塞主线程
 * 支持降级到主线程渲染（当 OffscreenCanvas 不可用时）
 */

// 检测 OffscreenCanvas 是否可用
const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

import { deserializeRenderData } from '../core/worker/TransferableSerializer.js';
import {
  LRUCache,
  canCacheTextBitmap,
  getBitmapDrawPosition,
  getLineStartX,
  getSingleLineDecoration,
  getSingleLineTextLayout,
  getTextBitmapSize,
  getWrappedTextLayout,
  makeTextBitmapCacheKey,
  measureTextWidth,
  parseFontSize
} from '../render/TextLayout';

// 缓存变量
let offscreenCanvas = null;
let ctx = null;
const textFontState = { current: null };
let currentDpr = 1;

// 文本测量缓存
const textCache = new LRUCache(2000);
const numberCache = new LRUCache(500);
const textBitmapCache = new LRUCache(600);
const wrappedTextCache = new LRUCache(1000);

function getTextBitmap(text, font, color) {
  const key = makeTextBitmapCacheKey(font, color, text);
  const cached = textBitmapCache.get(key);
  if (cached) return cached;

  if (typeof OffscreenCanvas === 'undefined') return null;

  const size = getTextBitmapSize(measureTextWithCache(text, font), font);
  if (!size) return null;

  const canvas = new OffscreenCanvas(size.width, size.height);
  const bitmapCtx = canvas.getContext('2d');
  if (!bitmapCtx) return null;

  bitmapCtx.font = font;
  bitmapCtx.fillStyle = color;
  bitmapCtx.textAlign = 'left';
  bitmapCtx.textBaseline = 'middle';
  bitmapCtx.fillText(text, 2, size.height / 2);

  const bitmap = { canvas, width: size.width, height: size.height };
  textBitmapCache.set(key, bitmap);
  return bitmap;
}

/**
 * 初始化 OffscreenCanvas
 */
function initCanvas(data) {
  const { canvas, width, height, dpr } = data;
  currentDpr = dpr || 1;
  
  if (!hasOffscreenCanvas) {
    return { success: false, error: 'OffscreenCanvas not supported' };
  }

  if (!canvas) {
    return { success: false, error: 'Transferred canvas is required' };
  }

  offscreenCanvas = canvas;
  offscreenCanvas.width = width * currentDpr;
  offscreenCanvas.height = height * currentDpr;
  ctx = offscreenCanvas.getContext('2d');
  if (ctx.setTransform) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.scale(currentDpr, currentDpr);
  return { success: true, width, height };
}

/**
 * 调整 Canvas 尺寸
 */
function resizeCanvas(data) {
  const { width, height } = data;
  
  if (!offscreenCanvas || !ctx) {
    return { success: false, error: 'Canvas not initialized' };
  }
  
  offscreenCanvas.width = width * currentDpr;
  offscreenCanvas.height = height * currentDpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0); // 重置变换
  ctx.scale(currentDpr, currentDpr);
  
  return { success: true, width, height };
}

/**
 * 测量文本宽度（带缓存）
 */
function measureTextWithCache(text, font) {
  return measureTextWidth(ctx, text, font, {
    textCache,
    numberCache,
    fontState: textFontState
  });
}

/**
 * 批量绘制背景
 */
function drawBatchedBackgrounds(bgGroups) {
  for (const color in bgGroups) {
    const rects = bgGroups[color];
    ctx.fillStyle = color;
    for (let i = 0; i < rects.length; i += 4) {
      ctx.fillRect(rects[i], rects[i+1], rects[i+2], rects[i+3]);
    }
  }
}

/**
 * 批量绘制网格线
 */
function drawBatchedGridLines(gridLines, borderColor) {
  if (!gridLines.length) return;
  
  ctx.lineWidth = 1;
  ctx.strokeStyle = borderColor;
  ctx.beginPath();
  
  for (let i = 0; i < gridLines.length; i += 4) {
    // 水平线
    ctx.moveTo(gridLines[i] + 0.5, gridLines[i+1] + 0.5);
    ctx.lineTo(gridLines[i] + gridLines[i+2] - 0.5, gridLines[i+1] + 0.5);
    // 垂直线
    ctx.moveTo(gridLines[i] + 0.5, gridLines[i+1] + 0.5);
    ctx.lineTo(gridLines[i] + 0.5, gridLines[i+1] + gridLines[i+3] - 0.5);
  }
  
  ctx.stroke();
}

/**
 * 绘制单行文本
 */
function drawSingleLineText(text, x, y, w, h, padding, align, valign, fSize, color, style) {
  const bitmap = canCacheTextBitmap(text, style) ? getTextBitmap(text, ctx.font, color) : null;
  const { textX, textY, baseline } = getSingleLineTextLayout({ x, y, w, h, padding, align, valign });
  ctx.textBaseline = baseline;

  if (bitmap) {
    const { drawX, drawY } = getBitmapDrawPosition({
      textX,
      textY,
      align,
      baseline,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height
    });
    ctx.drawImage(bitmap.canvas, drawX, drawY);
  } else {
    ctx.fillText(text, textX, textY);
  }

  // 删除线
  if (style && style.td === 'line-through') {
    const width = measureTextWithCache(text, ctx.font);
    const line = getSingleLineDecoration({
      textX,
      textY,
      align,
      baseline,
      width,
      fontSize: parseFontSize(fSize)
    });

    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * 绘制多行文本
 */
function drawWrappedText(text, x, y, w, h, padding, align, valign, fSize, color, style) {
  ctx.textBaseline = 'middle';

  const availableWidth = w - padding * 2;
  const font = ctx.font;
  if (availableWidth <= 0) return;

  const layout = getWrappedTextLayout({
    text,
    x,
    y,
    w,
    h,
    padding,
    align,
    valign,
    fSize,
    font,
    cache: wrappedTextCache,
    measureText: measureTextWithCache
  });

  layout.lines.forEach((line, i) => {
    ctx.fillText(line, layout.startX, layout.startY + i * layout.lineHeight);
  });

  // 删除线
  if (style && style.td === 'line-through') {
    layout.lines.forEach((line, i) => {
      const lineW = measureTextWithCache(line, font);
      const sx = getLineStartX(layout.startX, align, lineW);
      const sy = layout.startY + i * layout.lineHeight;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + lineW, sy);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }
}

function formatCellValue(val, s) {
  if (val === null || val === undefined || val === '') return '';
  if (!s) return String(val);

  const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
  let numVal = parseFloat(cleanVal);
  if (isNaN(numVal)) return String(val);

  if (s.decimals !== undefined) {
    numVal = Number(numVal.toFixed(s.decimals));
  }

  if (s.fmt === 'percent') {
    let pVal = numVal * 100;
    if (s.decimals !== undefined) pVal = Number(pVal.toFixed(s.decimals));
    return pVal.toFixed(s.decimals !== undefined ? s.decimals : 2) + '%';
  } else if (s.fmt === 'comma') {
    const opts = {};
    if (s.decimals !== undefined) {
      opts.minimumFractionDigits = s.decimals;
      opts.maximumFractionDigits = s.decimals;
    }
    return numVal.toLocaleString('en-US', opts);
  } else if (s.decimals !== undefined) {
    return numVal.toFixed(s.decimals);
  }

  return String(val);
}

function getFontSetting(s, defaultFontSize, defaultFontFamily) {
  let fontFunc = '';
  // 同时兼容 bold/fontWeight 两种属性名（与主线程渲染保持一致）
  if (s.fontWeight === 'bold' || s.fw === 'bold' || s.bold) fontFunc += 'bold ';
  // 同时兼容 italic/fontStyle 两种属性名
  if (s.fontStyle === 'italic' || s.fs === 'italic' || s.italic) fontFunc += 'italic ';
  const fSize = s.fontSize ? s.fontSize + 'px' : defaultFontSize;
  return `${fontFunc}${fSize} ${defaultFontFamily}`;
}

/**
 * 批量绘制文本
 */
function drawBatchedTexts(cellDataList, theme) {
  const defaultFontSize = theme.fontSize || '13px';
  const defaultFontFamily = theme.fontFamily || 'Arial';

  for (const cellData of cellDataList) {
    if (!cellData.text) continue;
    
    const { text, x, y, w, h } = cellData;
    const s = text.style || {};

    // 动态计算样式属性（原在主线程 prepareRenderDataForWorker 中执行）
    const formattedContent = formatCellValue(text.content, s);
    const font = getFontSetting(s, defaultFontSize, defaultFontFamily);
    const color = text.color || theme.textColor || '#000000';
    const align = text.align || 'left';
    const valign = text.valign || 'middle';
    const fSize = s.fontSize ? s.fontSize + 'px' : defaultFontSize;

    // 性能优化：检查是否真的需要裁剪
    // 自动换行文本由于高度不确定，始终建议裁剪
    let needsClip = true;
    if (!text.isWrap) {
      const available = w - 8; // 8 为默认 padding (4*2)
      // 启发式上界：每字符宽度 ≤ 1 em（fSize），ASCII 与 CJK 同时安全。
      // 上界都装得下时跳过 measureText，省掉缓存查询/底层测量调用。
      const fSizePx = s.fontSize || 13;
      const upperBound = formattedContent.length * fSizePx;
      if (upperBound <= available) {
        needsClip = false;
      } else {
        const textWidth = measureTextWithCache(formattedContent, font);
        if (textWidth <= available) {
          needsClip = false;
        }
      }
    }

    if (needsClip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }

    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = valign;

    if (text.isWrap) {
      drawWrappedText(
        formattedContent, x, y, w, h, 
        8/2, align, valign, 
        fSize, color, s
      );
    } else {
      drawSingleLineText(
        formattedContent, x, y, w, h, 
        8/2, align, valign, 
        fSize, color, s
      );
    }

    if (needsClip) {
      ctx.restore();
    }
  }
}

/**
 * 批量绘制边框
 */
function drawBatchedBorders(batch) {
  if (!batch) return;
  
  ctx.save();
  ctx.lineWidth = 1;

  for (const key in batch) {
    const [color, style] = key.split('|');
    const coords = batch[key];

    ctx.strokeStyle = color;
    if (style === 'dashed') ctx.setLineDash([4, 4]);
    else if (style === 'dotted') ctx.setLineDash([2, 2]);
    else ctx.setLineDash([]);

    ctx.beginPath();
    for (let i = 0; i < coords.length; i += 4) {
      ctx.moveTo(coords[i], coords[i + 1]);
      ctx.lineTo(coords[i + 2], coords[i + 3]);
    }
    ctx.stroke();
  }
  
  ctx.restore();
}

/**
 * 绘制列头
 */
function drawColHeader(c, x, w, h, theme, selection) {
  const ix = Math.floor(x);
  ctx.fillStyle = theme.headerBg;
  ctx.fillRect(ix, 0, w, h);
  ctx.strokeStyle = theme.borderColor;
  ctx.strokeRect(ix + 0.5, 0.5, w, h);

  if (selection && selection.s && selection.s.c <= c && selection.e.c >= c) {
    ctx.fillStyle = theme.selectionBg;
    ctx.fillRect(x, 0, w, h);
  }

  ctx.fillStyle = theme.textColor;
  ctx.textAlign = 'center';
  ctx.font = `${theme.headerFontSize} ${theme.fontFamily}`;

  let colName = '';
  let n = c + 1;
  while (n > 0) {
    let m = (n - 1) % 26;
    colName = String.fromCharCode(65 + m) + colName;
    n = Math.floor((n - m) / 26);
  }
  
  ctx.fillText(colName, x + w / 2, h / 2);
}

/**
 * 绘制行头
 */
function drawRowHeader(r, y, w, h, theme, selection) {
  const iy = Math.floor(y);
  ctx.fillStyle = theme.headerBg;
  if (selection && selection.s && selection.s.r <= r && selection.e.r >= r) {
    ctx.fillStyle = theme.headerHoverBg;
  }
  ctx.fillRect(0, iy, w, h);
  ctx.strokeStyle = theme.borderColor;
  ctx.strokeRect(0.5, iy + 0.5, w, h);
  ctx.fillStyle = theme.textColor;
  ctx.textAlign = 'center';
  ctx.font = `${theme.headerFontSize} ${theme.fontFamily}`;
  ctx.fillText(String(r + 1), w / 2, y + h / 2);
}

/**
 * 绘制选区
 */
function drawSelection(ctx, sel, active, theme, ox, oy, wb) {
  if (!sel) return;

  const getRect = (r1, c1, r2, c2) => {
    // 这里需要从主线程传入位置信息
    return { x: 0, y: 0, w: 0, h: 0 }; // 简化处理
  };

  ctx.fillStyle = theme.selectionBg;
  ctx.lineWidth = 2;
  ctx.strokeStyle = theme.selectionBorder;

  // 选区由主线程绘制，这里只处理简单的覆盖层
}

/**
 * 执行渲染命令
 */
function executeRender(data) {
  const { 
    type, 
    cellDataList, 
    borderBatch, 
    bgGroups, 
    gridLines,
    theme,
    width, 
    height,
    renderRect,
    colHeaders,
    rowHeaders,
    frozenLines,
    selectionData
  } = data;

  if (!ctx) {
    return { success: false, error: 'Canvas not initialized' };
  }

  const startTime = performance.now();

  // 清除画布
  ctx.textBaseline = 'middle';

  // 清除画布
  if (renderRect) {
    ctx.clearRect(renderRect.x, renderRect.y, renderRect.w, renderRect.h);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  // 如果提供了渲染区域，则应用全局裁剪，防止内容溢出到表头或行号区域
  const hasClip = !!renderRect;
  if (hasClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(renderRect.x, renderRect.y, renderRect.w, renderRect.h);
    ctx.clip();
  }

  // 1. 批量绘制背景
  if (bgGroups) {
    drawBatchedBackgrounds(bgGroups);
  }

  // 2. 批量绘制网格线
  if (!data.skipGrid && gridLines && gridLines.length) {
    drawBatchedGridLines(gridLines, theme.borderColor);
  }

  // 3. 批量绘制文本
  if (cellDataList && cellDataList.length) {
    drawBatchedTexts(cellDataList, theme);
  }

  // 4. 批量绘制边框
  if (borderBatch) {
    drawBatchedBorders(borderBatch);
  }

  // 恢复裁剪状态
  if (hasClip) {
    ctx.restore();
  }

  const RW = data.rowHeaderWidth || theme.rowHeaderWidth || 40;
  const CH = data.colHeaderHeight || theme.colHeaderHeight || 24;

  // 5. 绘制行头 (底层，带裁剪)
  if (!data.skipGrid && rowHeaders && rowHeaders.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CH, RW, height - CH);
    ctx.clip();
    for (const header of rowHeaders) {
      drawRowHeader(header.r, header.y, RW, header.h, theme, header.selection);
    }
    ctx.restore();
  }

  // 6. 绘制列头 (顶层，带裁剪)
  if (!data.skipGrid && colHeaders && colHeaders.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(RW, 0, width - RW, CH);
    ctx.clip();
    for (const header of colHeaders) {
      drawColHeader(header.c, header.x, header.w, CH, theme, header.selection);
    }
    ctx.restore();
  }

  // 7. 绘制左上角全选方块 (最高优先级)
  if (!data.skipGrid) {
    ctx.fillStyle = theme.headerBg;
    ctx.fillRect(0, 0, RW, CH);
    ctx.strokeStyle = theme.borderColor;
    ctx.strokeRect(0.5, 0.5, RW, CH);
  }

  // 8. 绘制冻结线
  if (!data.skipGrid && frozenLines && frozenLines.length) {
    ctx.strokeStyle = theme.frozenLineColor;
    ctx.lineWidth = 2;
    
    for (const line of frozenLines) {
      ctx.beginPath();
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
      ctx.stroke();
    }
  }

  const renderTime = performance.now() - startTime;

  // 返回渲染结果（ImageBitmap 可传输）
  if (hasOffscreenCanvas && offscreenCanvas) {
    // 创建 ImageBitmap 用于传输到主线程
    // 注意：实际使用时可能需要使用 transferToImageBitmap()
    return { 
      success: true, 
      renderTime,
      bitmap: null // 可以使用 offscreenCanvas.transferToImageBitmap()
    };
  }

  return { success: true, renderTime };
}

/**
 * 消息处理
 */
self.onmessage = function(e) {
  const { type, id, data } = e.data;

  let result;

  try {
    switch (type) {
      case 'ping':
        result = { success: true, hasOffscreenCanvas };
        break;

      case 'init':
        result = initCanvas(data);
        break;

      case 'resize':
        result = resizeCanvas(data);
        break;

      case 'render':
        if (data && data.useTransferable && data.buffer) {
          const deserializedData = deserializeRenderData(data.buffer);
          result = executeRender(deserializedData);
        } else {
          result = executeRender(data);
        }
        break;

      case 'measureText':
        // 文本测量请求
        if (!ctx) {
          result = { success: false, error: 'Canvas not initialized' };
        } else {
          const widths = data.items.map(item => measureTextWithCache(item.text, item.font));
          result = { success: true, widths };
        }
        break;

      default:
        result = { success: false, error: `Unknown message type: ${type}` };
    }
  } catch (error) {
    result = { success: false, error: error.message };
  }

  // 发送结果回主线程
  self.postMessage({ id, ...result });
};
