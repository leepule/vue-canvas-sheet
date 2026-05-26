import { describe, it, expect, vi } from 'vitest';
import { SelectionHistoryPlugin } from '../../src/plugins/SelectionHistoryPlugin';

function createWorkbook(overrides = {}) {
  const handlers = new Map();
  return {
    setSelection: vi.fn(),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    trigger(event, payload) {
      handlers.get(event)?.(payload);
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

describe('SelectionHistoryPlugin', () => {
  it('records selection history properly', () => {
    const workbook = createWorkbook();
    const registry = createRegistry();
    const plugin = new SelectionHistoryPlugin({ maxSize: 3 });

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);

    // 触发多次选区改变
    const s1 = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const s2 = { startRow: 2, startCol: 2, endRow: 3, endCol: 3 };
    const s3 = { startRow: 4, startCol: 4, endRow: 5, endCol: 5 };

    workbook.trigger('selection-change', s1);
    workbook.trigger('selection-change', s2);
    workbook.trigger('selection-change', s3);

    expect(plugin.canGoBack()).toBe(true);
    expect(plugin.canGoForward()).toBe(false);

    // 后退
    plugin.goBack();
    expect(workbook.setSelection).toHaveBeenCalledWith(s2);
    expect(plugin.canGoForward()).toBe(true);

    // 再次后退
    plugin.goBack();
    expect(workbook.setSelection).toHaveBeenCalledWith(s1);

    // 前进
    plugin.goForward();
    expect(workbook.setSelection).toHaveBeenCalledWith(s2);
  });

  it('honors maxSize limit to avoid unbounded growth', () => {
    const workbook = createWorkbook();
    const registry = createRegistry();
    const plugin = new SelectionHistoryPlugin({ maxSize: 2 });

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);

    workbook.trigger('selection-change', { startRow: 1 });
    workbook.trigger('selection-change', { startRow: 2 });
    workbook.trigger('selection-change', { startRow: 3 });
    workbook.trigger('selection-change', { startRow: 4 });

    // maxSize = 2, 能够往回退 2 次
    expect(plugin.canGoBack()).toBe(true);
    plugin.goBack(); // 回到 3
    plugin.goBack(); // 回到 2
    expect(plugin.canGoBack()).toBe(false); // 到头了
  });
});
