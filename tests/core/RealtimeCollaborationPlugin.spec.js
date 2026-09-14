import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeCollaborationPlugin } from '../../src/plugins/RealtimeCollaborationPlugin';
import { CollaborativeCursorPlugin } from '../../src/plugins/CollaborativeCursorPlugin';
import { Workbook } from '../../src/core/Workbook';

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

  it('默认不输出聊天内容，debug 时才输出调试日志', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me'
    });
    plugin._registry = { get: () => null };

    plugin._handleRemoteMessage({
      type: 'chat-message',
      roomId: 'room-1',
      userId: 'other',
      userName: '韩梅梅',
      text: '秘密内容'
    });
    expect(logSpy).not.toHaveBeenCalled();

    plugin.debug = true;
    plugin._handleRemoteMessage({
      type: 'chat-message',
      roomId: 'room-1',
      userId: 'other',
      userName: '韩梅梅',
      text: '调试内容'
    });
    expect(logSpy).toHaveBeenCalledWith('[RealtimeCollaboration] Chat [韩梅梅]: 调试内容');

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

    expect(plugin._lockedCells.get(plugin._cellStateKey(null, 10, 20))).toEqual({
      userId: 'other',
      userName: 'Other',
      sheetId: null
    });
    expect(plugin._editingDrafts.get(plugin._cellStateKey(null, 10, 20))).toEqual({
      userId: 'other',
      userName: 'Other',
      sheetId: null,
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
    expect(sent[0]).toMatchObject({
      userId: 'me',
      userName: plugin.userName,
      userColor: plugin.userColor
    });
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

describe('RealtimeCollaborationPlugin - 批注同步', () => {
  it('未注册 CellCommentPlugin 时也会广播本地批注变更', () => {
    const { plugin, sent } = makePlugin();
    const events = new Map();
    const workbook = {
      on: vi.fn((event, handler) => {
        events.set(event, handler);
        return vi.fn();
      })
    };
    const registry = {
      on: vi.fn(() => vi.fn()),
      get: vi.fn(() => null),
      setSharedState: vi.fn(),
      deleteSharedState: vi.fn()
    };

    plugin.onInit(workbook, registry);
    plugin.onMounted(workbook, registry);
    events.get('comment-change')({
      action: 'add',
      comment: { id: 'comment-1', r: 0, c: 1, messages: [{ text: '请复核' }] }
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'comment-change',
      action: 'add',
      comment: expect.objectContaining({ id: 'comment-1', r: 0, c: 1 })
    }));
    plugin.onUnmount();
  });

  it('收到远程批注后会写入本地 Workbook', () => {
    const { plugin } = makePlugin();
    const upsertComment = vi.fn();
    plugin._workbook = { upsertComment };
    plugin._registry = { get: () => null };

    plugin._handleRemoteMessage({
      type: 'comment-change',
      roomId: 'room-1',
      userId: 'other',
      action: 'add',
      comment: { id: 'comment-2', r: 2, c: 3, messages: [{ text: '远程批注' }] }
    });

    expect(upsertComment).toHaveBeenCalledWith(expect.objectContaining({
      id: 'comment-2',
      r: 2,
      c: 3
    }));
  });
});

describe('RealtimeCollaborationPlugin - 多 Sheet 协同隔离', () => {
  function createCollabWorkbook() {
    const workbook = new Workbook({ enableWasm: false, sheetName: '总表' });
    workbook.plugins.register(new CollaborativeCursorPlugin());
    workbook.plugins.register(new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me'
    }));
    const detailId = workbook.addSheet('明细', { activate: false });
    const plugin = workbook.plugins.get('RealtimeCollaboration');
    return { workbook, plugin, detailId };
  }

  it('其他 Sheet 的远程单元格修改不会写入当前 Sheet，切回后自动应用', () => {
    const { workbook, plugin, detailId } = createCollabWorkbook();

    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: detailId,
      row: 1,
      col: 2,
      cell: { v: '明细远程数据' }
    });

    expect(workbook.getCell(1, 2)?.v).toBeUndefined();
    workbook.switchSheet(detailId);
    expect(workbook.getCell(1, 2).v).toBe('明细远程数据');

    plugin.disconnect();
    workbook.destroy();
  });

  it('其他 Sheet 的批注和光标不会显示在当前 Sheet', () => {
    const { workbook, plugin, detailId } = createCollabWorkbook();
    const cursorPlugin = workbook.plugins.get('CollaborativeCursor');

    plugin._handleRemoteMessage({
      type: 'comment-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: detailId,
      action: 'add',
      comment: {
        id: 'comment-detail',
        r: 0,
        c: 0,
        messages: [{ id: 'message-detail', text: '明细批注' }]
      }
    });
    plugin._handleRemoteMessage({
      type: 'selection-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: detailId,
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }
    });

    expect(workbook.getComments()).toHaveLength(0);
    expect(cursorPlugin.getActiveCursors('sheet-1')).toHaveLength(0);

    workbook.switchSheet(detailId);
    expect(workbook.getComments()).toHaveLength(1);
    expect(workbook.getComments()[0].messages[0].text).toBe('明细批注');
    expect(cursorPlugin.getActiveCursors(detailId)).toHaveLength(1);

    plugin.disconnect();
    workbook.destroy();
  });

  it('编辑锁按 Sheet 隔离，同坐标不会互相覆盖', () => {
    const { workbook, plugin, detailId } = createCollabWorkbook();

    plugin._handleRemoteMessage({
      type: 'cell-lock',
      roomId: 'room-1',
      userId: 'other',
      sheetId: detailId,
      r: 5,
      c: 6
    });

    expect(plugin.isCellEditLocked(5, 6)).toBe(false);
    workbook.switchSheet(detailId);
    expect(plugin.isCellEditLocked(5, 6)).toBe(true);

    plugin.disconnect();
    workbook.destroy();
  });
});

describe('RealtimeCollaborationPlugin - 初始状态同步', () => {
  function createSyncWorkbook(userId, value) {
    const workbook = new Workbook({ enableWasm: false, sheetName: '协同表' });
    workbook.plugins.register(new CollaborativeCursorPlugin());
    workbook.plugins.register(new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId,
      userName: userId
    }));
    workbook.setCell(0, 0, { v: value });

    const plugin = workbook.plugins.get('RealtimeCollaboration');
    const sent = [];
    plugin._socket = {
      readyState: 1,
      close: vi.fn(),
      send: raw => sent.push(JSON.parse(raw))
    };

    return { workbook, plugin, sent };
  }

  it('收到状态请求后会向目标用户发送工作簿快照', () => {
    const { workbook, plugin, sent } = createSyncWorkbook('alice', '已有数据');

    plugin._handleRemoteMessage({
      type: 'state-request',
      roomId: 'room-1',
      userId: 'server',
      targetUserId: 'bob'
    });

    const snapshotMessage = sent.find(item => item.type === 'state-snapshot');
    expect(snapshotMessage).toMatchObject({
      roomId: 'room-1',
      userId: 'alice',
      targetUserId: 'bob'
    });
    expect(snapshotMessage.snapshot.data['0-0']).toMatchObject({ v: '已有数据' });

    plugin.disconnect();
    workbook.destroy();
  });

  it('收到快照后应用完整工作簿状态并广播当前位置', () => {
    vi.useFakeTimers();
    const source = createSyncWorkbook('alice', '远端已有数据');
    const target = createSyncWorkbook('bob', '本地旧数据');
    const snapshot = source.workbook.toJSON();
    target.plugin.readOnly = true;
    target.workbook.readOnly = true;

    target.plugin._handleRemoteMessage({
      type: 'state-snapshot',
      roomId: 'room-1',
      userId: 'alice',
      targetUserId: 'bob',
      snapshot
    });
    vi.advanceTimersByTime(target.plugin._selectionThrottleMs);

    expect(target.workbook.getCell(0, 0).v).toBe('远端已有数据');
    expect(target.workbook.rowCount).toBe(snapshot.rowCount);
    expect(target.workbook.colCount).toBe(snapshot.colCount);
    expect(target.sent.some(item => item.type === 'selection-change')).toBe(true);

    source.plugin.disconnect();
    source.workbook.destroy();
    target.plugin.disconnect();
    target.workbook.destroy();
  });
});

describe('RealtimeCollaborationPlugin - 断线重连补偿', () => {
  it('断线期间的本地修改会在重连同步完成后补发', () => {
    vi.useFakeTimers();
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me'
    });
    const sent = [];
    plugin._registry = { get: () => null };
    plugin._hasSyncedConnection = true;
    plugin._lastSyncSequence = 3;

    plugin._handleLocalCellChange({
      row: 2,
      col: 3,
      cell: { v: '离线修改' }
    });
    expect(plugin._offlineCellChangeQueue).toHaveLength(1);

    plugin._socket = {
      readyState: 1,
      send: raw => sent.push(JSON.parse(raw)),
      close: vi.fn()
    };
    plugin._setupSocketListeners();
    plugin._socket.onopen();

    const joinMessage = sent.find(item => item.type === 'user-join');
    expect(joinMessage).toMatchObject({
      roomId: 'room-1',
      userId: 'me',
      resume: true,
      lastSeq: 3
    });
    expect(sent.some(item => item.type === 'cell-change')).toBe(false);

    plugin._handleRemoteMessage({
      type: 'sync-ready',
      roomId: 'room-1',
      userId: 'collab-server',
      seq: 4
    });

    expect(sent.some(item =>
      item.type === 'cell-change' &&
      item.cell?.v === '离线修改'
    )).toBe(true);
    expect(plugin._offlineCellChangeQueue).toHaveLength(0);
    expect(plugin._lastSyncSequence).toBe(4);

    plugin.disconnect();
  });
});

describe('RealtimeCollaborationPlugin - 消息序列与冲突收敛', () => {
  function createSequencePlugin() {
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me'
    });
    const workbook = {
      rowCount: 100,
      colCount: 100,
      activeSheetId: 'sheet-1',
      getSheets: () => [{ id: 'sheet-1' }],
      setCell: vi.fn(),
      requestRender: vi.fn(),
      emitEvent: vi.fn()
    };
    plugin._workbook = workbook;
    plugin._registry = { get: () => null };
    return { plugin, workbook };
  }

  it('同格旧版本和重复消息会被丢弃，只应用最新版本', () => {
    const { plugin, workbook } = createSequencePlugin();

    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: 'sheet-1',
      row: 2,
      col: 3,
      seq: 5,
      cell: { v: 'latest' }
    });
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: 'sheet-1',
      row: 2,
      col: 3,
      seq: 4,
      cell: { v: 'stale' }
    });
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: 'sheet-1',
      row: 2,
      col: 3,
      seq: 5,
      cell: { v: 'duplicate' }
    });

    expect(workbook.setCell).toHaveBeenCalledTimes(1);
    expect(workbook.setCell).toHaveBeenCalledWith(2, 3, { v: 'latest' }, null, {
      skipEvent: true,
      skipHistory: true
    });
    expect(plugin._cellVersions.get(plugin._cellStateKey('sheet-1', 2, 3))).toBe(5);
    expect(plugin._lastSyncSequence).toBe(5);
    expect(workbook.emitEvent).toHaveBeenCalledWith('collaboration-conflict', expect.objectContaining({
      reason: 'stale-or-duplicate'
    }));
  });

  it('批量粘贴按每个单元格的独立 seq 收敛，延迟旧批量不会覆盖新数据', () => {
    const { plugin, workbook } = createSequencePlugin();

    plugin._handleRemoteMessage({
      type: 'cell-change-batch',
      roomId: 'room-1',
      userId: 'other',
      seq: 12,
      cells: [
        { sheetId: 'sheet-1', row: 0, col: 0, seq: 11, cell: { v: 'new-a' } },
        { sheetId: 'sheet-1', row: 1, col: 1, seq: 12, cell: { v: 'new-b' } }
      ]
    });
    plugin._handleRemoteMessage({
      type: 'cell-change-batch',
      roomId: 'room-1',
      userId: 'other',
      seq: 10,
      cells: [
        { sheetId: 'sheet-1', row: 0, col: 0, seq: 9, cell: { v: 'old-a' } },
        { sheetId: 'sheet-1', row: 1, col: 1, seq: 10, cell: { v: 'old-b' } }
      ]
    });

    expect(workbook.setCell).toHaveBeenCalledTimes(2);
    expect(workbook.setCell).toHaveBeenNthCalledWith(1, 0, 0, { v: 'new-a' }, null, {
      skipEvent: true,
      skipHistory: true
    });
    expect(workbook.setCell).toHaveBeenNthCalledWith(2, 1, 1, { v: 'new-b' }, null, {
      skipEvent: true,
      skipHistory: true
    });
    expect(plugin._cellVersions.get(plugin._cellStateKey('sheet-1', 0, 0))).toBe(11);
    expect(plugin._cellVersions.get(plugin._cellStateKey('sheet-1', 1, 1))).toBe(12);
  });

  it('本地变更确认后会记录逐格版本，后续旧远端消息不能覆盖本地结果', () => {
    const { plugin, workbook } = createSequencePlugin();

    plugin._handleRemoteMessage({
      type: 'sync-ack',
      roomId: 'room-1',
      userId: 'collab-server',
      seq: 8,
      cellVersions: [{ sheetId: 'sheet-1', row: 4, col: 5, seq: 8 }]
    });
    plugin._handleRemoteMessage({
      type: 'cell-change',
      roomId: 'room-1',
      userId: 'other',
      sheetId: 'sheet-1',
      row: 4,
      col: 5,
      seq: 7,
      cell: { v: 'old' }
    });

    expect(workbook.setCell).not.toHaveBeenCalled();
    expect(plugin._lastSyncSequence).toBe(8);
    expect(plugin._cellVersions.get(plugin._cellStateKey('sheet-1', 4, 5))).toBe(8);
  });
});

describe('RealtimeCollaborationPlugin - 连接状态 UI', () => {
  function createStatusPlugin() {
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me',
      userName: '我'
    });
    plugin._workbook = { emitEvent: vi.fn() };
    plugin._registry = { get: () => null };
    return plugin;
  }

  it('未连接时返回离线状态和空成员列表', () => {
    const plugin = createStatusPlugin();

    expect(plugin.getConnectionInfo()).toMatchObject({
      status: 'OFFLINE',
      roomId: 'room-1',
      userId: 'me',
      memberCount: 0,
      members: []
    });
  });

  it('服务端成员广播会更新人数并触发状态事件', () => {
    const plugin = createStatusPlugin();

    plugin._handleRemoteMessage({
      type: 'room-members',
      roomId: 'room-1',
      userId: 'collab-server',
      members: [
        { userId: 'me', userName: '我', userColor: '#3498db' },
        { userId: 'alice', userName: 'Alice', userColor: '#e74c3c' }
      ]
    });

    expect(plugin.getConnectionInfo()).toMatchObject({
      status: 'OFFLINE',
      memberCount: 2
    });
    expect(plugin._roomMembers.get('alice')).toEqual({
      userId: 'alice',
      userName: 'Alice',
      userColor: '#e74c3c',
      readOnly: false
    });
    expect(plugin._workbook.emitEvent).toHaveBeenCalledWith('collaboration-status', expect.objectContaining({
      status: 'OFFLINE',
      memberCount: 2
    }));
  });

  it('重连定时器存在时状态为重连中，达到上限后为离线', () => {
    const plugin = createStatusPlugin();

    plugin._reconnectTimer = setTimeout(() => {}, 1000);
    expect(plugin.getConnectionStatus()).toBe('RECONNECTING');
    clearTimeout(plugin._reconnectTimer);
    plugin._reconnectTimer = null;

    plugin._reconnectAttempts = plugin._maxReconnectAttempts;
    expect(plugin.getConnectionStatus()).toBe('OFFLINE');
  });

  it('用户加入和离开会维护房间成员', () => {
    const plugin = createStatusPlugin();

    plugin._handleRemoteMessage({
      type: 'user-join',
      roomId: 'room-1',
      userId: 'alice',
      userName: 'Alice',
      userColor: '#e74c3c'
    });
    expect(plugin.getConnectionInfo()).toMatchObject({
      memberCount: 1,
      members: [expect.objectContaining({ userId: 'alice' })]
    });

    plugin._handleRemoteMessage({
      type: 'user-leave',
      roomId: 'room-1',
      userId: 'alice'
    });
    expect(plugin.getConnectionInfo()).toMatchObject({
      memberCount: 0,
      members: []
    });
  });
});

describe('RealtimeCollaborationPlugin - 心跳与异常清理', () => {
  function createHeartbeatPlugin(overrides = {}) {
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me',
      ...overrides
    });
    plugin._workbook = { emitEvent: vi.fn(), requestRender: vi.fn() };
    plugin._registry = { get: () => null };
    return plugin;
  }

  it('收到服务端心跳后返回 pong 并启动失联检测', () => {
    const plugin = createHeartbeatPlugin({ heartbeatTimeoutMs: 100 });
    const sent = [];
    plugin._socket = {
      readyState: 1,
      send: str => sent.push(JSON.parse(str)),
      close: vi.fn()
    };

    plugin._handleRemoteMessage({
      type: 'heartbeat-ping',
      roomId: 'room-1',
      userId: 'collab-server',
      timestamp: 123
    });

    expect(sent).toEqual([
      { type: 'heartbeat-pong', roomId: 'room-1', userId: 'me' }
    ]);
    expect(plugin._heartbeatWatchdogStarted).toBe(true);
    plugin._stopHeartbeat();
  });

  it('服务端心跳超时会主动触发关闭回调', () => {
    vi.useFakeTimers();
    const plugin = createHeartbeatPlugin({ heartbeatTimeoutMs: 100 });
    const socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      onclose: vi.fn()
    };
    plugin._socket = socket;

    plugin._handleRemoteMessage({
      type: 'heartbeat-ping',
      roomId: 'room-1',
      userId: 'collab-server'
    });

    vi.advanceTimersByTime(99);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.onclose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onclose).toHaveBeenCalledWith(expect.objectContaining({
      code: 1006,
      reason: 'heartbeat timeout'
    }));
    expect(plugin._heartbeatTimeoutTimer).toBeNull();
  });

  it('断开连接时清空协作光标并停止心跳定时器', () => {
    const plugin = createHeartbeatPlugin();
    const cursors = new Map([['alice', { userId: 'alice' }]]);
    const cursorPlugin = {
      _cursors: cursors,
      _updateSharedState: vi.fn()
    };
    plugin._registry = { get: () => cursorPlugin };
    plugin._socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn()
    };
    plugin._resetHeartbeatWatchdog();

    plugin.disconnect();

    expect(cursors.size).toBe(0);
    expect(cursorPlugin._updateSharedState).toHaveBeenCalledTimes(1);
    expect(plugin._heartbeatTimeoutTimer).toBeNull();
    expect(plugin._heartbeatWatchdogStarted).toBe(false);
  });
});

describe('RealtimeCollaborationPlugin - 只读权限协同', () => {
  function createPermissionPlugin(options = {}) {
    const plugin = new RealtimeCollaborationPlugin({
      autoConnect: false,
      roomId: 'room-1',
      userId: 'me',
      ...options
    });
    plugin._workbook = {
      readOnly: false,
      emitEvent: vi.fn(),
      requestRender: vi.fn()
    };
    plugin._registry = { get: () => null };
    return plugin;
  }

  it('只读协作者的握手 URL 会携带 readOnly 标记', () => {
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

    const plugin = createPermissionPlugin({
      readOnly: true,
      authRequired: false,
      serverUrl: 'ws://127.0.0.1:8800'
    });

    expect(plugin.connect()).toBe(true);
    expect(new URL(urls[0]).searchParams.get('readOnly')).toBe('true');
    expect(plugin.getConnectionInfo()).toMatchObject({
      readOnly: true
    });
  });

  it('只读协作者不会发送本地单元格修改，也不会积压离线补偿', async () => {
    const plugin = createPermissionPlugin({ readOnly: true });
    const sent = [];
    plugin._socket = {
      readyState: 1,
      send: str => sent.push(JSON.parse(str)),
      close: vi.fn()
    };

    plugin._handleLocalCellChange({ row: 1, col: 1, cell: { v: 'local' } });
    await Promise.resolve();

    expect(sent).toHaveLength(0);
    expect(plugin._cellChangeQueue).toHaveLength(0);
    expect(plugin._offlineCellChangeQueue).toHaveLength(0);
  });

  it('只读协作者会将工作簿置为只读，断开后恢复原状态', () => {
    const plugin = createPermissionPlugin();

    plugin.setReadOnly(true);
    expect(plugin._workbook.readOnly).toBe(true);

    plugin.disconnect();
    expect(plugin._workbook.readOnly).toBe(false);
  });

  it('服务端权限拒绝会收敛为只读并派发事件', () => {
    const plugin = createPermissionPlugin();

    plugin._handleRemoteMessage({
      type: 'permission-denied',
      roomId: 'room-1',
      userId: 'collab-server',
      readOnly: true,
      messageType: 'cell-change'
    });

    expect(plugin.readOnly).toBe(true);
    expect(plugin._workbook.readOnly).toBe(true);
    expect(plugin._workbook.emitEvent).toHaveBeenCalledWith('collaboration-permission-denied', {
      messageType: 'cell-change',
      readOnly: true
    });
    plugin._restoreWorkbookReadOnly();
  });
});
