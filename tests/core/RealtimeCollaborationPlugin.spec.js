import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeCollaborationPlugin } from '../../src/plugins/RealtimeCollaborationPlugin';

// _sendRaw 依赖全局 WebSocket.OPEN 常量
beforeEach(() => {
  vi.stubGlobal('WebSocket', { OPEN: 1, CONNECTING: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makePlugin() {
  const plugin = new RealtimeCollaborationPlugin({
    autoConnect: false,
    roomId: 'room-1',
    userId: 'me'
  });
  const sent = [];
  plugin._socket = { readyState: 1, send: (str) => sent.push(JSON.parse(str)), close: vi.fn() };
  return { plugin, sent };
}

describe('RealtimeCollaborationPlugin - cell-change 批量合并 (sub-2)', () => {
  it('同一 tick 内多格变更合并为单条 cell-change-batch', async () => {
    const { plugin, sent } = makePlugin();

    plugin._handleLocalCellChange({ row: 0, col: 0, cell: 'a' });
    plugin._handleLocalCellChange({ row: 0, col: 1, cell: 'b' });
    plugin._handleLocalCellChange({ row: 1, col: 0, cell: 'c' });

    // 微任务冲刷前未发送
    expect(sent).toHaveLength(0);
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('cell-change-batch');
    expect(sent[0].cells).toEqual([
      { row: 0, col: 0, cell: 'a' },
      { row: 0, col: 1, cell: 'b' },
      { row: 1, col: 0, cell: 'c' }
    ]);
  });

  it('单格变更仍走传统 cell-change（向后兼容）', async () => {
    const { plugin, sent } = makePlugin();

    plugin._handleLocalCellChange({ row: 2, col: 3, cell: 'x' });
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('cell-change');
    expect(sent[0].row).toBe(2);
    expect(sent[0].col).toBe(3);
    expect(sent[0].cell).toBe('x');
  });

  it('远程同步引起的变更不回环入队', async () => {
    const { plugin, sent } = makePlugin();
    plugin._isApplyingRemote = true;
    plugin._handleLocalCellChange({ row: 0, col: 0, cell: 'a' });
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });

  it('接收端 cell-change-batch 逐格 setCell 且只渲染一次', () => {
    const { plugin } = makePlugin();
    const setCell = vi.fn();
    plugin._workbook = { setCell };
    plugin._registry = { get: () => null };
    plugin._requestRender = vi.fn();
    plugin._checkDraftsAnimation = vi.fn();

    plugin._handleRemoteMessage({
      type: 'cell-change-batch',
      roomId: 'room-1',
      userId: 'other',
      cells: [
        { row: 0, col: 0, cell: 'a' },
        { row: 1, col: 1, cell: 'b' }
      ]
    });

    expect(setCell).toHaveBeenCalledTimes(2);
    expect(setCell).toHaveBeenCalledWith(0, 0, 'a', { skipEvent: true });
    expect(setCell).toHaveBeenCalledWith(1, 1, 'b', { skipEvent: true });
    expect(plugin._requestRender).toHaveBeenCalledTimes(1);
    expect(plugin._isApplyingRemote).toBe(false);
  });
});

describe('RealtimeCollaborationPlugin - 选区广播节流 (sub-1)', () => {
  it('窗口内多次选区变化合并为一次发送（最后一次）', () => {
    vi.useFakeTimers();
    const { plugin, sent } = makePlugin();

    plugin._broadcastSelection({ startRow: 0 });
    plugin._broadcastSelection({ startRow: 1 });
    plugin._broadcastSelection({ startRow: 2 });

    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(plugin._selectionThrottleMs);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('selection-change');
    expect(sent[0].selection).toEqual({ startRow: 2 });
  });

  it('disconnect 清理未冲刷的节流定时器，不再发送', () => {
    vi.useFakeTimers();
    const { plugin, sent } = makePlugin();

    plugin._broadcastSelection({ startRow: 5 });
    plugin.disconnect(); // 清理 socket + 定时器（disconnect 自身会发 user-leave）
    vi.advanceTimersByTime(1000);

    expect(sent.some(m => m.type === 'selection-change')).toBe(false);
  });
});
