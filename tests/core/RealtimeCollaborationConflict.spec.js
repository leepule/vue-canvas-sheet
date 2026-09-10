import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeCollaborationPlugin } from '../../src/plugins/RealtimeCollaborationPlugin';

const ROOM_ID = 'room-1';

beforeEach(() => {
  vi.stubGlobal('WebSocket', {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeWorkbook() {
  return {
    rowCount: 100,
    colCount: 50,
    setCell: vi.fn(),
    requestRender: vi.fn(),
    emitEvent: vi.fn()
  };
}

function makePlugin(userId, userName = userId) {
  const plugin = new RealtimeCollaborationPlugin({
    autoConnect: false,
    serverUrl: 'ws://collaboration.test',
    roomId: ROOM_ID,
    userId,
    userName,
    token: 'test-token'
  });
  plugin._workbook = makeWorkbook();
  plugin._registry = { get: vi.fn(() => null) };
  return plugin;
}

function attachOpenSocket(plugin) {
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [],
    close: vi.fn(() => {
      socket.readyState = WebSocket.CLOSED;
    }),
    send: vi.fn((raw) => {
      const message = JSON.parse(raw);
      socket.sent.push(message);
      socket.onSend?.(message);
    })
  };
  plugin._socket = socket;
  plugin._setupSocketListeners();
  return socket;
}

function deliverJson(socket, message) {
  socket.onmessage({ data: JSON.stringify(message) });
}

function linkWithDelay(fromSocket, toSocket, delayMs) {
  fromSocket.onSend = (message) => {
    setTimeout(() => deliverJson(toSocket, message), delayMs);
  };
}

function installMockWebSocket() {
  const sockets = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      this.close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
      });
      sockets.push(this);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }

    failClose() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({ code: 1006 });
    }
  }

  vi.stubGlobal('WebSocket', MockWebSocket);
  return sockets;
}

describe('RealtimeCollaborationPlugin - 弱网冲突收敛', () => {
  it('100ms 网络抖动下两个用户同时锁定同一单元格，最终按稳定 userId 收敛', () => {
    vi.useFakeTimers();
    const alice = makePlugin('alice', 'Alice');
    const bob = makePlugin('bob', 'Bob');
    const aliceSocket = attachOpenSocket(alice);
    const bobSocket = attachOpenSocket(bob);

    linkWithDelay(aliceSocket, bobSocket, 100);
    linkWithDelay(bobSocket, aliceSocket, 35);

    expect(alice.lockLocalCell(1, 1)).toBe(true);
    expect(bob.lockLocalCell(1, 1)).toBe(true);
    expect(alice._lockedCells.get('1,1')).toEqual({ userId: 'alice', userName: 'Alice' });
    expect(bob._lockedCells.get('1,1')).toEqual({ userId: 'bob', userName: 'Bob' });

    vi.advanceTimersByTime(35);
    expect(alice._lockedCells.get('1,1')).toEqual({ userId: 'alice', userName: 'Alice' });
    expect(bob._lockedCells.get('1,1')).toEqual({ userId: 'bob', userName: 'Bob' });

    vi.advanceTimersByTime(65);
    expect(alice._lockedCells.get('1,1')).toEqual({ userId: 'alice', userName: 'Alice' });
    expect(bob._lockedCells.get('1,1')).toEqual({ userId: 'alice', userName: 'Alice' });

    const bobSentBeforeRetry = bobSocket.sent.length;
    expect(bob.lockLocalCell(1, 1)).toBe(false);
    expect(bobSocket.sent).toHaveLength(bobSentBeforeRetry);
  });

  it('收到离场消息后清理该用户遗留锁，不影响其他用户锁', () => {
    const bob = makePlugin('bob', 'Bob');
    bob._checkDraftsAnimation = vi.fn();
    bob._lockedCells.set('2,2', { userId: 'alice', userName: 'Alice' });
    bob._lockedCells.set('3,3', { userId: 'carol', userName: 'Carol' });
    bob._editingDrafts.set('2,2', {
      userId: 'alice',
      userName: 'Alice',
      value: 'draft'
    });

    bob._handleRemoteMessage({
      type: 'user-leave',
      roomId: ROOM_ID,
      userId: 'alice'
    });

    expect(bob._lockedCells.has('2,2')).toBe(false);
    expect(bob._editingDrafts.has('2,2')).toBe(false);
    expect(bob._lockedCells.get('3,3')).toEqual({ userId: 'carol', userName: 'Carol' });
    expect(bob._workbook.requestRender).toHaveBeenCalledTimes(1);
    expect(bob._workbook.emitEvent).toHaveBeenCalledWith('lock-change');
  });

  it('WebSocket 意外断开会丢弃本地锁，重连后不继承旧锁', () => {
    vi.useFakeTimers();
    const sockets = installMockWebSocket();
    const alice = makePlugin('alice', 'Alice');

    alice.connect('ws://collaboration.test');
    expect(sockets).toHaveLength(1);
    const firstSocket = sockets[0];
    firstSocket.open();

    expect(firstSocket.sent[0]).toMatchObject({
      type: 'user-join',
      roomId: ROOM_ID,
      userId: 'alice',
      userName: 'Alice'
    });

    expect(alice.lockLocalCell(4, 4)).toBe(true);
    alice._editingDrafts.set('4,4', {
      userId: 'alice',
      userName: 'Alice',
      value: '=A1'
    });
    alice._workbook.requestRender.mockClear();
    alice._workbook.emitEvent.mockClear();

    firstSocket.failClose();

    expect(alice._socket).toBeNull();
    expect(alice._lockedCells.has('4,4')).toBe(false);
    expect(alice._editingDrafts.has('4,4')).toBe(false);
    expect(alice._workbook.requestRender).toHaveBeenCalledTimes(1);
    expect(alice._workbook.emitEvent).toHaveBeenCalledWith('lock-change');

    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    const reconnectedSocket = sockets[1];
    reconnectedSocket.open();

    expect(reconnectedSocket.sent).toHaveLength(1);
    expect(reconnectedSocket.sent[0]).toMatchObject({
      type: 'user-join',
      roomId: ROOM_ID,
      userId: 'alice',
      userName: 'Alice'
    });
    expect(reconnectedSocket.sent.some((message) => message.type === 'cell-lock')).toBe(false);
    expect(alice._lockedCells.size).toBe(0);
  });

  it('主动断开也会发送离场消息并清理本地锁状态', () => {
    const alice = makePlugin('alice', 'Alice');
    const socket = attachOpenSocket(alice);
    alice._lockedCells.set('5,5', { userId: 'alice', userName: 'Alice' });
    alice._editingDrafts.set('5,5', {
      userId: 'alice',
      userName: 'Alice',
      value: 'draft'
    });

    alice.disconnect();

    expect(socket.sent.some((message) => message.type === 'user-leave')).toBe(true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(alice._socket).toBeNull();
    expect(alice._lockedCells.has('5,5')).toBe(false);
    expect(alice._editingDrafts.has('5,5')).toBe(false);
  });
});
