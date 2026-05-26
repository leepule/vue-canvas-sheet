/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
class CacheNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

export class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.head = new CacheNode(null, null);
    this.tail = new CacheNode(null, null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get(key) {
    const node = this.cache.get(key);
    if (!node) return undefined;
    this._moveToHead(node);
    return node.value;
  }

  set(key, value) {
    let node = this.cache.get(key);
    if (node) {
      node.value = value;
      this._moveToHead(node);
      return;
    }

    node = new CacheNode(key, value);
    this.cache.set(key, node);
    this._addToHead(node);
    if (this.cache.size > this.maxSize) {
      this._removeTail();
    }
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size() {
    return this.cache.size;
  }

  _addToHead(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }

  _removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _moveToHead(node) {
    this._removeNode(node);
    this._addToHead(node);
  }

  _removeTail() {
    const node = this.tail.prev;
    if (node !== this.head) {
      this._removeNode(node);
      this.cache.delete(node.key);
    }
  }
}

export function makeTextCacheKey(font, text) {
  return `${font}|${String(text ?? '')}`;
}

export function makeTextBitmapCacheKey(font, color, text) {
  return `${font}|${color}|${String(text ?? '')}`;
}

export function makeWrappedTextCacheKey(font, availableWidth, text) {
  return `${font}|${availableWidth}|${String(text ?? '')}`;
}

export function isNumberLikeText(text) {
  const normalized = String(text ?? '');
  return normalized.length <= 20 && /^[\d,.\-%]+$/.test(normalized);
}

export function parseFontSize(fontOrSize, fallback = 13) {
  const match = /(\d+(?:\.\d+)?)px/.exec(String(fontOrSize ?? ''));
  if (!match) return fallback;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : fallback;
}

export function measureTextWidth(ctx, text, font, options = {}) {
  const normalized = String(text ?? '');
  const textCache = options.textCache;
  const numberCache = options.numberCache;
  const fontState = options.fontState;
  const cache = isNumberLikeText(normalized) ? numberCache : textCache;
  const key = makeTextCacheKey(font, normalized);

  const cached = cache?.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (fontState) {
    if (fontState.current !== font) {
      ctx.font = font;
      fontState.current = font;
    }
  } else {
    ctx.font = font;
  }

  const width = ctx.measureText(normalized).width;
  cache?.set(key, width);
  return width;
}

export function canCacheTextBitmap(text, style) {
  const normalized = String(text ?? '');
  if (!normalized) return false;
  if (style && (style.td === 'line-through' || style.textDecoration === 'line-through')) return false;
  if (normalized.length > 16) return false;
  return /^[\w\s.,%+\-:/()]+$/.test(normalized);
}

export function getTextBitmapSize(textWidth, font, options = {}) {
  const width = Math.ceil(textWidth) + (options.paddingX ?? 4);
  const fontSize = parseFontSize(font, options.fallbackFontSize ?? 13);
  const height = Math.ceil(fontSize * (options.heightMultiplier ?? 1.6)) + (options.paddingY ?? 2);
  const maxWidth = options.maxWidth ?? 256;
  const maxHeight = options.maxHeight ?? 64;

  if (width <= 0 || height <= 0 || width > maxWidth || height > maxHeight) {
    return null;
  }

  return { width, height, fontSize };
}

export function getSingleLineTextLayout({ x, y, w, h, padding = 4, align = 'left', valign = 'middle' }) {
  let textX = x + padding;
  if (align === 'center') textX = x + w / 2;
  else if (align === 'right') textX = x + w - padding;

  if (valign === 'top') {
    return { textX, textY: y + padding, baseline: 'top' };
  }
  if (valign === 'bottom') {
    return { textX, textY: y + h - padding, baseline: 'bottom' };
  }
  return { textX, textY: y + h / 2, baseline: 'middle' };
}

export function getLineStartX(anchorX, align, width) {
  if (align === 'center') return anchorX - width / 2;
  if (align === 'right') return anchorX - width;
  return anchorX;
}

export function getBitmapDrawPosition({ textX, textY, align, baseline, bitmapWidth, bitmapHeight }) {
  return {
    drawX: getLineStartX(textX, align, bitmapWidth),
    drawY: baseline === 'top'
      ? textY
      : baseline === 'bottom'
        ? textY - bitmapHeight
        : textY - bitmapHeight / 2
  };
}

export function getSingleLineDecoration({ textX, textY, align, baseline, width, fontSize }) {
  let sy = textY;
  if (baseline === 'top') sy = textY + fontSize / 2;
  else if (baseline === 'bottom') sy = textY - fontSize / 2;

  return {
    x1: getLineStartX(textX, align, width),
    y1: sy,
    x2: getLineStartX(textX, align, width) + width,
    y2: sy
  };
}

export function wrapTextByWidth(text, availableWidth, font, measureText, cache) {
  const normalized = String(text ?? '');
  if (!normalized || availableWidth <= 0) return [];

  const cacheKey = makeWrappedTextCacheKey(font, availableWidth, normalized);
  const cached = cache?.get(cacheKey);
  if (cached) return cached;

  const lines = [];
  let remainingText = normalized;

  while (remainingText.length > 0) {
    let low = 1;
    let high = remainingText.length;
    let splitIndex = 1;

    if (measureText(remainingText, font) <= availableWidth) {
      lines.push(remainingText);
      break;
    }

    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = remainingText.substring(0, mid);
      if (measureText(candidate, font) <= availableWidth) {
        splitIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    lines.push(remainingText.substring(0, splitIndex));
    remainingText = remainingText.substring(splitIndex);

    if (splitIndex === 0 && remainingText.length > 0) {
      lines.push(remainingText[0]);
      remainingText = remainingText.substring(1);
    }
  }

  cache?.set(cacheKey, lines);
  return lines;
}

export function getWrappedTextLayout(options) {
  const {
    text,
    x,
    y,
    w,
    h,
    padding = 4,
    align = 'left',
    valign = 'middle',
    fSize,
    font,
    measureText,
    cache
  } = options;

  const availableWidth = w - padding * 2;
  const lines = wrapTextByWidth(text, availableWidth, font, measureText, cache);
  const lineHeight = parseFontSize(fSize, parseFontSize(font)) * 1.2;
  const totalTextHeight = lines.length * lineHeight;

  let startY = y + padding + lineHeight / 2;
  if (valign === 'middle') startY = y + (h - totalTextHeight) / 2 + lineHeight / 2;
  else if (valign === 'bottom') startY = y + h - totalTextHeight + lineHeight / 2;

  let startX = x + padding;
  if (align === 'center') startX = x + w / 2;
  else if (align === 'right') startX = x + w - padding;

  return {
    lines,
    lineHeight,
    totalTextHeight,
    startX,
    startY
  };
}
