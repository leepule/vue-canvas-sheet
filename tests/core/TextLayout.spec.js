import {
  LRUCache,
  canCacheTextBitmap,
  getBitmapDrawPosition,
  getSingleLineDecoration,
  getSingleLineTextLayout,
  getWrappedTextLayout,
  isNumberLikeText,
  makeTextCacheKey,
  measureTextWidth,
  parseFontSize,
  wrapTextByWidth
} from '@/core/render/TextLayout';

function createMeasureContext() {
  return {
    font: '',
    measureCalls: 0,
    measureText(text) {
      this.measureCalls++;
      return { width: String(text).length * 10 };
    }
  };
}

describe('TextLayout', () => {
  test('LRUCache 应该淘汰最久未使用项', () => {
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  test('measureTextWidth 应该区分数字缓存和文本缓存', () => {
    const ctx = createMeasureContext();
    const textCache = new LRUCache(10);
    const numberCache = new LRUCache(10);
    const fontState = { current: null };
    const font = '13px Arial';

    expect(measureTextWidth(ctx, '123', font, { textCache, numberCache, fontState })).toBe(30);
    expect(measureTextWidth(ctx, '123', font, { textCache, numberCache, fontState })).toBe(30);
    expect(ctx.measureCalls).toBe(1);
    expect(numberCache.has(makeTextCacheKey(font, '123'))).toBe(true);

    expect(measureTextWidth(ctx, 'hello', font, { textCache, numberCache, fontState })).toBe(50);
    expect(textCache.has(makeTextCacheKey(font, 'hello'))).toBe(true);
  });

  test('文本类型和 bitmap 缓存条件应该稳定', () => {
    expect(isNumberLikeText('1,234.50%')).toBe(true);
    expect(isNumberLikeText('A123')).toBe(false);
    expect(canCacheTextBitmap('Short 123', null)).toBe(true);
    expect(canCacheTextBitmap('text with 中文', null)).toBe(false);
    expect(canCacheTextBitmap('Short', { td: 'line-through' })).toBe(false);
  });

  test('单行文本定位应该按水平和垂直对齐计算', () => {
    expect(getSingleLineTextLayout({
      x: 10,
      y: 20,
      w: 100,
      h: 40,
      padding: 4,
      align: 'right',
      valign: 'bottom'
    })).toEqual({
      textX: 106,
      textY: 56,
      baseline: 'bottom'
    });
  });

  test('bitmap 和删除线坐标应该复用同一套对齐规则', () => {
    expect(getBitmapDrawPosition({
      textX: 60,
      textY: 40,
      align: 'center',
      baseline: 'middle',
      bitmapWidth: 30,
      bitmapHeight: 12
    })).toEqual({ drawX: 45, drawY: 34 });

    expect(getSingleLineDecoration({
      textX: 100,
      textY: 30,
      align: 'right',
      baseline: 'top',
      width: 40,
      fontSize: 12
    })).toEqual({ x1: 60, y1: 36, x2: 100, y2: 36 });
  });

  test('wrapTextByWidth 应该使用二分切分并缓存结果', () => {
    const cache = new LRUCache(10);
    const measure = (text) => String(text).length * 10;
    const lines = wrapTextByWidth('abcdef', 25, '13px Arial', measure, cache);

    expect(lines).toEqual(['ab', 'cd', 'ef']);
    expect(wrapTextByWidth('abcdef', 25, '13px Arial', measure, cache)).toBe(lines);
  });

  test('getWrappedTextLayout 应该计算多行起点和行高', () => {
    const layout = getWrappedTextLayout({
      text: 'abcdef',
      x: 10,
      y: 20,
      w: 50,
      h: 100,
      padding: 5,
      align: 'center',
      valign: 'middle',
      fSize: '10px',
      font: '10px Arial',
      measureText: (text) => String(text).length * 10
    });

    expect(layout.lines).toEqual(['abcd', 'ef']);
    expect(layout.lineHeight).toBe(12);
    expect(layout.startX).toBe(35);
    expect(layout.startY).toBe(64);
  });

  test('parseFontSize 应该处理无效字体并使用 fallback', () => {
    expect(parseFontSize('16px Arial')).toBe(16);
    expect(parseFontSize('bold Arial', 13)).toBe(13);
  });
});
