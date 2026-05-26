import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoSavePlugin } from '../../src/plugins/AutoSavePlugin';
import { Events } from '../../src/core/events/EventEmitter';


function createWorkbook(overrides = {}) {
  const handlers = new Map();
  return {
    _dirtyCells: new Map([['0-0', { v: 1 }]]),
    enablePersistenceStorage: vi.fn(),
    savePendingChanges: vi.fn().mockResolvedValue({ mode: 'diff', sheetId: 'sheet-1' }),
    toJSON: vi.fn(() => ({ rowCount: 1, colCount: 1, data: { '0-0': { v: 1 } } })),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
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
    expect(workbook._emit).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'saving' }));
    expect(workbook._emit).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'saved', backend: 'indexedDB' }));
  });

  it('falls back to localStorage when IndexedDB save fails', async () => {
    const workbook = createWorkbook({
      savePendingChanges: vi.fn().mockRejectedValue(new Error('idb failed'))
    });
    const plugin = new AutoSavePlugin({ interval: 0, key: 'fallback-key', sheetId: 'sheet-1' });

    plugin.onMounted(workbook, createRegistry());
    await plugin.saveNow();

    expect(localStorage.getItem('fallback-key')).toContain('"rowCount":1');
    expect(workbook._emit).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({
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

    expect(workbook._emit).toHaveBeenCalledWith(Events.SAVE_STATUS, expect.objectContaining({ status: 'quotaExceeded' }));
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
});
