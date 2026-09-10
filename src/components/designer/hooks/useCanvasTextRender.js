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
  makeTextCacheKey,
  measureTextWidth,
  parseFontSize
} from '../../../core/render/TextLayout';

const textWidthCache = new LRUCache(2000);
const numberWidthCache = new LRUCache(500);
const wrappedLineCache = new LRUCache(1000);
const textBitmapCache = new LRUCache(600, (_key, bitmap) => {
  if (bitmap?.canvas) {
    bitmap.canvas.width = 0;
    bitmap.canvas.height = 0;
  }
});
const textFontState = { current: null };

function cellFont(style, theme) {
  const weight = style && (style.fw === 'bold' || style.bold) ? 'bold ' : '';
  const slant = style && (style.fs === 'italic' || style.italic) ? 'italic ' : '';
  const size = style?.fontSize ? `${style.fontSize}px` : theme.fontSize;
  return `${weight}${slant}${size} ${theme.fontFamily}`;
}

function lineThroughSingleText(ctx, cellData, layout, measureText) {
  const text = cellData.text;
  const width = measureText(ctx, text.content, ctx.font);
  const line = getSingleLineDecoration({
    textX: layout.textX,
    textY: layout.textY,
    align: text.align,
    baseline: layout.baseline,
    width,
    fontSize: parseFontSize(text.fSize)
  });
  ctx.beginPath();
  ctx.moveTo(line.x1, line.y1);
  ctx.lineTo(line.x2, line.y2);
  ctx.strokeStyle = text.color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function lineThroughWrappedText(ctx, cellData, layout, measureText) {
  const text = cellData.text;
  layout.lines.forEach((lineText, lineIndex) => {
    const lineWidth = measureText(ctx, lineText, ctx.font);
    const lineStartX = getLineStartX(layout.startX, text.align, lineWidth);
    const lineY = layout.startY + lineIndex * layout.lineHeight;
    ctx.beginPath();
    ctx.moveTo(lineStartX, lineY);
    ctx.lineTo(lineStartX + lineWidth, lineY);
    ctx.strokeStyle = text.color;
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

function createTextBitmapCanvas(ctx, text, bitmapSize) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmapSize.width;
  canvas.height = bitmapSize.height;
  const bitmapContext = canvas.getContext('2d');
  if (!bitmapContext) return null;

  bitmapContext.font = ctx.font;
  bitmapContext.fillStyle = text.color;
  bitmapContext.textAlign = 'left';
  bitmapContext.textBaseline = 'middle';
  bitmapContext.fillText(text.content, 2, bitmapSize.height / 2);
  return { canvas, width: bitmapSize.width, height: bitmapSize.height };
}

export default function useCanvasTextRender({ getWorkbook, getTheme }) {
  function measureTextWithCache(ctx, text, font) {
    return measureTextWidth(ctx, text, font, {
      textCache: textWidthCache,
      numberCache: numberWidthCache,
      fontState: textFontState
    });
  }

  function importMeasuredMetrics(measuredMetrics) {
    if (!measuredMetrics) return;
    for (const cacheKey in measuredMetrics) {
      if (!textWidthCache.has(cacheKey)) {
        textWidthCache.set(cacheKey, measuredMetrics[cacheKey]);
      }
    }
  }

  function scanPreloadText(range) {
    const measureRequests = [];
    const queuedKeys = new Set();
    const workbook = getWorkbook();
    const theme = getTheme();

    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startCol; column <= range.endCol; column++) {
        const cellValue = workbook.getCellValue(row, column);
        if (cellValue === null || cellValue === undefined || cellValue === '') continue;

        const text = String(cellValue);
        const style = workbook.getCell(row, column)?.s || null;
        const font = cellFont(style, theme);
        const cacheKey = makeTextCacheKey(font, text);
        const isQueued = queuedKeys.has(cacheKey);
        const isCached = textWidthCache.has(cacheKey) || numberWidthCache.has(cacheKey);
        if (!isQueued && !isCached) {
          measureRequests.push({ text, font, key: cacheKey });
          queuedKeys.add(cacheKey);
        }
        if (measureRequests.length > 200) return measureRequests;
      }
    }
    return measureRequests;
  }

  function measureTextBatch(ctx, measureRequests) {
    const measuredWidths = new Array(measureRequests.length);
    const requestsByFont = new Map();

    measureRequests.forEach((request, requestIndex) => {
      if (!requestsByFont.has(request.font)) requestsByFont.set(request.font, []);
      requestsByFont.get(request.font).push({ requestIndex, text: request.text });
    });

    for (const [font, fontRequests] of requestsByFont) {
      for (const request of fontRequests) {
        measuredWidths[request.requestIndex] = measureTextWithCache(ctx, request.text, font);
      }
    }
    return measuredWidths;
  }

  function textBitmap(ctx, cellData) {
    const text = cellData.text;
    if (typeof document === 'undefined' || !canCacheTextBitmap(text.content, text.style)) return null;

    const cacheKey = makeTextBitmapCacheKey(ctx.font, text.color, text.content);
    const cachedBitmap = textBitmapCache.get(cacheKey);
    if (cachedBitmap) return cachedBitmap;

    const bitmapSize = getTextBitmapSize(measureTextWithCache(ctx, text.content, ctx.font), ctx.font);
    if (!bitmapSize) return null;

    const bitmap = createTextBitmapCanvas(ctx, text, bitmapSize);
    if (!bitmap) return null;
    textBitmapCache.set(cacheKey, bitmap);
    return bitmap;
  }

  function drawBitmapOrText(ctx, cellData, layout, bitmap) {
    if (!bitmap) {
      ctx.fillText(cellData.text.content, layout.textX, layout.textY);
      return;
    }
    const bitmapPosition = getBitmapDrawPosition({
      textX: layout.textX,
      textY: layout.textY,
      align: cellData.text.align,
      baseline: layout.baseline,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height
    });
    ctx.drawImage(bitmap.canvas, bitmapPosition.drawX, bitmapPosition.drawY);
  }

  function drawSingleLineText(ctx, cellData) {
    const text = cellData.text;
    const bitmap = textBitmap(ctx, cellData);
    const layout = getSingleLineTextLayout({
      x: cellData.x,
      y: cellData.y,
      w: cellData.w,
      h: cellData.h,
      padding: text.padding,
      align: text.align,
      valign: text.valign
    });
    ctx.textBaseline = layout.baseline;

    drawBitmapOrText(ctx, cellData, layout, bitmap);

    if (text.style?.td === 'line-through') {
      lineThroughSingleText(ctx, cellData, layout, measureTextWithCache);
    }
  }

  function wrappedTextLayout(ctx, cellData) {
    const text = cellData.text;
    return getWrappedTextLayout({
      text: text.content,
      x: cellData.x,
      y: cellData.y,
      w: cellData.w,
      h: cellData.h,
      padding: text.padding,
      align: text.align,
      valign: text.valign,
      fSize: text.fSize,
      font: ctx.font,
      cache: wrappedLineCache,
      ctx,
      fontState: textFontState,
      measureText: (text, font) => measureTextWithCache(ctx, text, font)
    });
  }

  function drawWrappedText(ctx, cellData) {
    const text = cellData.text;
    ctx.textBaseline = 'middle';
    if (cellData.w - text.padding * 2 <= 0) return;

    const layout = wrappedTextLayout(ctx, cellData);
    layout.lines.forEach((lineText, lineIndex) => {
      ctx.fillText(lineText, layout.startX, layout.startY + lineIndex * layout.lineHeight);
    });
    if (text.style?.td === 'line-through') {
      lineThroughWrappedText(ctx, cellData, layout, measureTextWithCache);
    }
  }

  function drawText(ctx, cellData) {
    if (cellData.text.isWrap) drawWrappedText(ctx, cellData);
    else drawSingleLineText(ctx, cellData);
  }

  return {
    measureTextWithCache,
    importMeasuredMetrics,
    scanPreloadText,
    measureTextBatch,
    drawText
  };
}
