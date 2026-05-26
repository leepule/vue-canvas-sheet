import { cellKey, cellKeyNumeric, decodeNumeric, isValidCellKey, normalizeCellKey, parseCellKey } from '@/core/data/CellKey';

describe('CellKey', () => {
  test('应该生成不受 16 位上限影响的字符串键', () => {
    expect(cellKey(1048575, 16383)).toBe('1048575-16383');
    expect(parseCellKey('1048575-16383')).toEqual({ r: 1048575, c: 16383 });
  });

  test('应该兼容旧版正数压缩键', () => {
    expect(parseCellKey((1 << 16) | 2)).toEqual({ r: 1, c: 2 });
    expect(normalizeCellKey((1 << 16) | 2)).toBe('1-2');
  });

  test('应该兼容旧版负数压缩键字符串', () => {
    expect(parseCellKey(String((65535 << 16) | 2))).toEqual({ r: 65535, c: 2 });
  });

  test('应该识别无效键', () => {
    expect(parseCellKey('invalid')).toEqual({ r: -1, c: -1 });
    expect(isValidCellKey('invalid')).toBe(false);
  });

  test('cellKeyNumeric 应该编码为 (r << 16) | c', () => {
    expect(cellKeyNumeric(0, 0)).toBe(0);
    expect(cellKeyNumeric(1, 2)).toBe((1 << 16) | 2);
    expect(cellKeyNumeric(100, 200)).toBe((100 << 16) | 200);
  });

  test('decodeNumeric 应该从数字键还原 r, c', () => {
    expect(decodeNumeric(0)).toEqual({ r: 0, c: 0 });
    expect(decodeNumeric((1 << 16) | 2)).toEqual({ r: 1, c: 2 });
    expect(decodeNumeric((100 << 16) | 200)).toEqual({ r: 100, c: 200 });
  });

  test('cellKeyNumeric + decodeNumeric 应该互为逆操作', () => {
    const pairs = [[0, 0], [1, 1], [100, 200], [65535, 65535]];
    for (const [r, c] of pairs) {
      expect(decodeNumeric(cellKeyNumeric(r, c))).toEqual({ r, c });
    }
  });

  test('cellKeyNumeric 应该与 parseCellKey 兼容格式一致', () => {
    const nk = cellKeyNumeric(1, 2);
    expect(parseCellKey(nk)).toEqual({ r: 1, c: 2 });
  });
});
