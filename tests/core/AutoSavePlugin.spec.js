import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoSavePlugin } from '../../src/plugins/AutoSavePlugin';
import { Events } from '../../src/core/events/EventEmitter';


function createWorkbook(overrides = {}) {
  const handlers = new Map();
  const dirtyCellsMap = new Map([['0-0', { v: 1 }]]);
  const dataMatrixMock = { size: 1 };
  return {
    getDirtyCells: () => dirtyCellsMap,
    getDataMatrix: () => dataMatrixMock,
    enablePersistenceStorage: vi.fn(),
    savePendingChanges: vi.fn().mockResolvedValue({ mode: 'diff', sheetId: 'sheet-1' }),
    toJSON: vi.fn(() => ({ rowCount: 1, colCount: 1, data: { '0-0': { v: 1 } } })),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    emitEvent: vi.fn(),
    _emit: vi.fn(),
    trigger(event, payload = {}) {
      handlers.get(event)?.({ type: event, ...payload });
    },
    ...overrides
  };
}

function createRegistry() {
  const sharedState = new Map();
  return {
    setSharedState: vi.fn((key, value) => sharedState.set(key, value)),
    deleteSharedState: vi.fn((key) => sharedState.delete(key)),
    sharedState
  };
}

describe('AutoSavePlugin', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses Workbook IndexedDB persistence by default instead of localStorage snapshots', async () => {
    const workbook = createWorkbook();
    const registry = createRegistry();
    const plugin = new AutoSavePlugin({ interval: 0, debounce: 10, sheetId: 'sheet-1' });

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);
    await plugin.saveNow();

    expect(workbook.enablePersistenceStorage).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      storageOptions: {}
    });
    expect(workbook.savePendingChanges).toHaveBeenCalledWith('sheet-1');
    expect(localStorage.getItem(plugin.key)).toBeNull();
    expect(workbook.emitEvent).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'saving' }));
    expect(workbook.emitEvent).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'saved', backend: 'indexedDB' }));
  });

  it('falls back to localStorage when IndexedDB save fails', async () => {
    const workbook = createWorkbook({
      savePendingChanges: vi.fn().mockRejectedValue(new Error('idb failed'))
    });
    const plugin = new AutoSavePlugin({ interval: 0, key: 'fallback-key', sheetId: 'sheet-1' });

    plugin.onMounted(workbook, createRegistry());
    await plugin.saveNow();

    expect(localStorage.getItem('fallback-key')).toContain('"rowCount":1');
    expect(workbook.emitEvent).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({
      status: 'saved',
      backend: 'localStorage',
      fallback: true
    }));
  });

  it('reports quotaExceeded without throwing when localStorage is full', async () => {
    const quotaError = new Error('quota exceeded');
    quotaError.name = 'QuotaExceededError';
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw quotaError;
    });
    const workbook = createWorkbook({
      savePendingChanges: vi.fn().mockRejectedValue(new Error('idb failed'))
    });
    const plugin = new AutoSavePlugin({ interval: 0, key: 'quota-key', sheetId: 'sheet-1' });

    await plugin.saveNow(workbook);

    expect(workbook.emitEvent).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'quotaExceeded' }));
    setItemSpy.mockRestore();
  });

  it('does not throw when localStorage contains bad JSON in getStats', () => {
    localStorage.setItem('bad-json', '{ nope');
    const plugin = new AutoSavePlugin({ key: 'bad-json', interval: 0 });

    const stats = plugin.getStats();

    expect(stats.localStorageSize).toBeGreaterThan(0);
    expect(stats.parseError).toBeTruthy();
  });

  it('debounces event-driven saves', async () => {
    const workbook = createWorkbook();
    const plugin = new AutoSavePlugin({ interval: 0, debounce: 50, sheetId: 'sheet-1' });

    plugin.onMounted(workbook, createRegistry());
    workbook.trigger('cell-change');
    workbook.trigger('cell-change');
    vi.advanceTimersByTime(49);
    expect(workbook.savePendingChanges).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(workbook.savePendingChanges).toHaveBeenCalledTimes(1);
  });

  describe('localStorage 大表安全拦截 (缺陷修复)', () => {
    it('行数超限 (>2000) 时应拒绝 localStorage 直接写入并抛出', () => {
      const BIG_ROWS = 5000;
      const workbook = createWorkbook({
        savePendingChanges: vi.fn(),
        toJSON: vi.fn(() => ({ rowCount: BIG_ROWS, colCount: 1, data: {} })),
        rowCount: BIG_ROWS,
        getDataMatrix: () => ({ size: 0 })
      });
      const plugin = new AutoSavePlugin({ backend: 'localStorage', interval: 0, key: 'big-table' });

      expect(() => plugin._saveToLocalStorage(workbook))
        .toThrow(/行数超限/);
      expect(localStorage.getItem('big-table')).toBeNull();
    });

    it('有值单元格超限 (>10000) 时应拒绝 localStorage 写入', () => {
      const CELL_COUNT = 25000;
      const workbook = createWorkbook({
        savePendingChanges: vi.fn(),
        toJSON: vi.fn(() => ({ rowCount: 500, colCount: 50, data: {} })),
        rowCount: 500,
        getDataMatrix: () => ({ size: CELL_COUNT })
      });
      const plugin = new AutoSavePlugin({ backend: 'localStorage', interval: 0, key: 'dense-table' });

      expect(() => plugin._saveToLocalStorage(workbook))
        .toThrow(/有值单元格超限/);
    });

    it('正常小表 localStorage 写入仍可正常工作', () => {
      const workbook = createWorkbook({
        toJSON: vi.fn(() => ({ rowCount: 10, colCount: 5, data: { '1-1': { v: 42 } } })),
        rowCount: 10,
        getDataMatrix: () => ({ size: 5 })
      });
      const plugin = new AutoSavePlugin({ backend: 'localStorage', interval: 0, key: 'small-table' });

      const result = plugin._saveToLocalStorage(workbook);
      expect(result.backend).toBe('localStorage');
      expect(localStorage.getItem('small-table')).toContain('"rowCount":10');
    });

    it('IndexedDB 失败降级时大表应发 tooLarge 状态而非白屏', async () => {
      const BIG_ROWS = 50000;
      const workbook = createWorkbook({
        savePendingChanges: vi.fn().mockRejectedValue(new Error('idb unavailable')),
        toJSON: vi.fn(() => ({ rowCount: BIG_ROWS, colCount: 10, data: {} })),
        rowCount: BIG_ROWS,
        getDataMatrix: () => ({ size: 0 })
      });
      const plugin = new AutoSavePlugin({ interval: 0, key: 'big-fallback', sheetId: 'sheet-1' });

      await plugin.saveNow(workbook);

      // 应该发出 tooLarge 状态，而非 saved 或 failed
      expect(workbook.emitEvent).toHaveBeenCalledWith(
        Events.SAVE_STATUS,
        expect.objectContaining({
          status: 'tooLarge',
          reason: 'fallback'
        })
      );
      // 不应写入 localStorage
      expect(localStorage.getItem('big-fallback')).toBeNull();
    });

    it('JSON 序列化后字节数超限应被拦截', () => {
      // 构造序列化后超过 4MB 的数据块
      let hugeData = {};
      const BIG_STRING = 'x'.repeat(500); // 每个单元格 ~500 字节
      for (let i = 0; i < 9000; i++) {
        hugeData[`${i}-0`] = { v: BIG_STRING };
      }
      // 9000 * ~550 ≈ 4.95MB (> 4MB 上限)
      const workbook = createWorkbook({
        toJSON: vi.fn(() => ({ rowCount: 1000, colCount: 10, data: hugeData })),
        rowCount: 1000,
        getDataMatrix: () => ({ size: 9000 })
      });
      const plugin = new AutoSavePlugin({ backend: 'localStorage', interval: 0, key: 'huge-cells' });

      expect(() => plugin._saveToLocalStorage(workbook))
        .toThrow(/过大/);
    });
  });
});
