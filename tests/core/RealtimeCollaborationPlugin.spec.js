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

describe('RealtimeCollaborationPlugin - WebSocket 鉴权握手', () => {
  it('connect 应在 WebSocket 握手 URL 中附带 token、roomId 和 userId', () => {
    const urls = [];
    const WebSocketMock = vi.fn(function(url) {
      urls.push(url);
      this.readyState = WebSocketMock.OPEN;
      this.send = vi.fn();
      this.close = vi.fn();
    });
    WebSocketMock.OPEN = 1;
    WebSocketMock.CONNECTING = 0;
    vi.stubGlobal('WebSocket', WebSocketMock);

    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      serverUrl: 'ws://collab.example.test/socket?transport=ws',
      roomId: 'room 1',
      userId: 'user/1',
      token: 'secret token'
    });

    expect(plugin.connect()).toBe(true);
    expect(WebSocketMock).toHaveBeenCalledTimes(1);

    const url = new URL(urls[0]);
    expect(url.origin).toBe('ws://collab.example.test');
    expect(url.pathname).toBe('/socket');
    expect(url.searchParams.get('transport')).toBe('ws');
    expect(url.searchParams.get('token')).toBe('secret token');
    expect(url.searchParams.get('roomId')).toBe('room 1');
    expect(url.searchParams.get('userId')).toBe('user/1');
  });

  it('默认缺少 token 时拒绝建立匿名协作连接', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const WebSocketMock = vi.fn(function() {
      this.readyState = WebSocketMock.OPEN;
      this.send = vi.fn();
      this.close = vi.fn();
    });
    WebSocketMock.OPEN = 1;
    WebSocketMock.CONNECTING = 0;
    vi.stubGlobal('WebSocket', WebSocketMock);

    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      serverUrl: 'ws://collab.example.test/socket',
      roomId: 'room-1',
      userId: 'me'
    });

    expect(plugin.connect()).toBe(false);
    expect(WebSocketMock).not.toHaveBeenCalled();
    expect(plugin._socket).toBeNull();
    warnSpy.mockRestore();
  });

  it('authRequired=false 时允许本地联调模式不附带 token', () => {
    const urls = [];
    const WebSocketMock = vi.fn(function(url) {
      urls.push(url);
      this.readyState = WebSocketMock.OPEN;
      this.send = vi.fn();
      this.close = vi.fn();
    });
    WebSocketMock.OPEN = 1;
    WebSocketMock.CONNECTING = 0;
    vi.stubGlobal('WebSocket', WebSocketMock);

    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      authRequired: false,
      serverUrl: 'ws://localhost:8800',
      roomId: 'room-1',
      userId: 'me'
    });

    expect(plugin.connect()).toBe(true);
    const url = new URL(urls[0]);
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.get('roomId')).toBe('room-1');
    expect(url.searchParams.get('userId')).toBe('me');
  });
});

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
    plugin._workbook = { setCell, rowCount: 100, colCount: 50 };
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
    expect(setCell).toHaveBeenCalledWith(0, 0, 'a', null, { skipEvent: true, skipHistory: true });
    expect(setCell).toHaveBeenCalledWith(1, 1, 'b', null, { skipEvent: true, skipHistory: true });
    expect(plugin._requestRender).toHaveBeenCalledTimes(1);
    expect(plugin._isApplyingRemote).toBe(false);
  });
});

describe('RealtimeCollaborationPlugin - 远程消息边界安全校验', () => {
  it('WebSocket 消息必须是纯 JSON 对象，不从 HTML 或乱码包装中截取解析', () => {
    const { plugin } = makePlugin();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    plugin._handleRemoteMessage = vi.fn();
    plugin._setupSocketListeners();

    const payload = JSON.stringify({
      type: 'chat-message',
      roomId: 'room-1',
      userId: 'other',
      text: 'ok'
    });

    plugin._socket.onmessage({ data: `<b>server echo:</b>${payload}` });
    plugin._socket.onmessage({ data: `prefix ${payload}` });
    plugin._socket.onmessage({ data: '{not-json' });

    expect(plugin._handleRemoteMessage).not.toHaveBeenCalled();

    plugin._socket.onmessage({ data: payload });

    expect(plugin._handleRemoteMessage).toHaveBeenCalledTimes(1);
    expect(plugin._handleRemoteMessage).toHaveBeenCalledWith({
      type: 'chat-message',
      roomId: 'room-1',
      userId: 'other',
      text: 'ok'
    });

    logSpy.mockRestore();
  });

  it('cell-change 越界行号应被静默过滤，不调用 setCell', () => {
    const { plugin } = makePlugin();
    const setCell = vi.fn();
    plugin._workbook = { setCell, rowCount: 100, colCount: 50 };
    plugin._registry = { get: () => null };
    plugin._requestRender = vi.fn();
    plugin._checkDraftsAnimation = vi.fn();

    // 行号越界（>= rowCount）
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      row: 999999,
      col: 5,
      cell: 'bad'
    });
    expect(setCell).not.toHaveBeenCalled();
    expect(plugin._requestRender).not.toHaveBeenCalled();

    // 列号越界（>= colCount）
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      row: 5,
      col: 999999,
      cell: 'bad'
    });
    expect(setCell).not.toHaveBeenCalled();

    // 负行号
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      row: -1,
      col: 5,
      cell: 'bad'
    });
    expect(setCell).not.toHaveBeenCalled();

    // 非整数值
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      row: 1.5,
      col: 5,
      cell: 'bad'
    });
    expect(setCell).not.toHaveBeenCalled();

    // 合法值应正常通过
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      row: 10,
      col: 20,
      cell: 'ok'
    });
    expect(setCell).toHaveBeenCalledTimes(1);
    expect(setCell).toHaveBeenCalledWith(10, 20, 'ok', null, { skipEvent: true, skipHistory: true });
    expect(plugin._isApplyingRemote).toBe(false);
  });

  it('cell-change-batch 应过滤越界项，仅应用合法项', () => {
    const { plugin } = makePlugin();
    const setCell = vi.fn();
    plugin._workbook = { setCell, rowCount: 100, colCount: 50 };
    plugin._registry = { get: () => null };
    plugin._requestRender = vi.fn();
    plugin._checkDraftsAnimation = vi.fn();

    plugin._handleRemoteMessage({
      type: 'cell-change-batch',
      roomId: 'room-1',
      userId: 'other',
      cells: [
        { row: 0, col: 0, cell: 'a' },         // 合法
        { row: 999999, col: 5, cell: 'bad1' },  // 行越界 → 过滤
        { row: 1, col: 1, cell: 'b' },          // 合法
        { row: 5, col: 999999, cell: 'bad2' },  // 列越界 → 过滤
        { row: 2, col: 2, cell: 'c' },          // 合法
        { row: -1, col: 0, cell: 'bad3' },      // 负数 → 过滤
        { row: 0, col: 1.5, cell: 'bad4' },     // 非整数 → 过滤
        { row: 3, col: 3, cell: 'd' }           // 合法
      ]
    });

    expect(setCell).toHaveBeenCalledTimes(4);
    expect(setCell).toHaveBeenCalledWith(0, 0, 'a', null, { skipEvent: true, skipHistory: true });
    expect(setCell).toHaveBeenCalledWith(1, 1, 'b', null, { skipEvent: true, skipHistory: true });
    expect(setCell).toHaveBeenCalledWith(2, 2, 'c', null, { skipEvent: true, skipHistory: true });
    expect(setCell).toHaveBeenCalledWith(3, 3, 'd', null, { skipEvent: true, skipHistory: true });
    expect(plugin._requestRender).toHaveBeenCalledTimes(1);
    expect(plugin._isApplyingRemote).toBe(false);
  });

  it('cell-lock、cell-unlock 与 cell-editing 应过滤非法行列，不残留远程状态', () => {
    const { plugin } = makePlugin();
    plugin._workbook = { rowCount: 100, colCount: 50, requestRender: vi.fn(), emitEvent: vi.fn() };
    plugin._registry = { get: () => null };
    plugin._checkDraftsAnimation = vi.fn();

    const invalidCoords = [
      { r: 999999, c: 5 },
      { r: 5, c: 999999 },
      { r: -1, c: 0 },
      { r: 0, c: -1 },
      { r: 1.5, c: 0 },
      { r: 0, c: 'x' }
    ];

    for (const coord of invalidCoords) {
      plugin._handleRemoteMessage({
        type: 'cell-lock',
        roomId: 'room-1',
        userId: 'other',
        userName: 'Other',
        ...coord
      });
      plugin._handleRemoteMessage({
        type: 'cell-editing',
        roomId: 'room-1',
        userId: 'other',
        userName: 'Other',
        val: 'draft',
        ...coord
      });
      plugin._handleRemoteMessage({
        type: 'cell-unlock',
        roomId: 'room-1',
        userId: 'other',
        ...coord
      });
    }

    expect(plugin._lockedCells.size).toBe(0);
    expect(plugin._editingDrafts.size).toBe(0);
    expect(plugin._workbook.requestRender).not.toHaveBeenCalled();
    expect(plugin._workbook.emitEvent).not.toHaveBeenCalled();

    plugin._handleRemoteMessage({
      type: 'cell-lock',
      roomId: 'room-1',
      userId: 'other',
      userName: 'Other',
      r: 10,
      c: 20
    });
    plugin._handleRemoteMessage({
      type: 'cell-editing',
      roomId: 'room-1',
      userId: 'other',
      userName: 'Other',
      r: 10,
      c: 20,
      val: 'draft'
    });

    expect(plugin._lockedCells.get('10,20')).toEqual({ userId: 'other', userName: 'Other' });
    expect(plugin._editingDrafts.get('10,20')).toEqual({
      userId: 'other',
      userName: 'Other',
      value: 'draft'
    });
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
