import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CollaborativeCursorPlugin } from '../../src/plugins/CollaborativeCursorPlugin';

function createWorkbook(overrides = {}) {
  return {
    requestRender: vi.fn(),
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

describe('CollaborativeCursorPlugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks, updates and exposes active collaborative cursors', () => {
    const workbook = createWorkbook();
    const registry = createRegistry();
    const plugin = new CollaborativeCursorPlugin({ expireTime: 1000 });

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);

    const range1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    plugin.setRemoteCursor('user1', range1, { name: 'Alice', color: '#ff0000' });

    expect(workbook.requestRender).toHaveBeenCalled();
    expect(registry.setSharedState).toHaveBeenCalledWith('collaborative:active-cursors', expect.arrayContaining([
      expect.objectContaining({
        userId: 'user1',
        range: range1,
        userInfo: expect.objectContaining({ name: 'Alice', color: '#ff0000' })
      })
    ]));

    // 定时清理，100ms 后仍然活跃
    vi.advanceTimersByTime(100);
    plugin._cleanupExpiredCursors();
    expect(plugin.getActiveCursors().length).toBe(1);

    // 1100ms 后超过过期时间，自动清除
    vi.advanceTimersByTime(1000);
    plugin._cleanupExpiredCursors();
    expect(plugin.getActiveCursors().length).toBe(0);
  });

  it('explicitly removes cursor', () => {
    const workbook = createWorkbook();
    const registry = createRegistry();
    const plugin = new CollaborativeCursorPlugin();

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);

    plugin.setRemoteCursor('user1', { startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    expect(plugin.getActiveCursors().length).toBe(1);

    plugin.removeRemoteCursor('user1');
    expect(plugin.getActiveCursors().length).toBe(0);
  });
});
