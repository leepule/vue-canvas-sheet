import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const serverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/collab-server.mjs'
);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startServer(envOverrides = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('collab server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, port };
}

function openSocket(port, userId, { respondHeartbeat = true, query = '' } = {}) {
  const messages = [];
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}?roomId=room-sync&userId=${userId}${query ? `&${query}` : ''}`
  );
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (respondHeartbeat && message.type === 'heartbeat-ping') {
      socket.send(JSON.stringify({
        type: 'heartbeat-pong',
        roomId: message.roomId,
        userId
      }));
    }
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function waitFor(messages, predicate) {
  for (let i = 0; i < 150; i++) {
    const message = messages.find(predicate);
    if (message) return message;
    await delay(20);
  }
  throw new Error('expected collaboration message was not received');
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    socket.once('close', resolve);
    socket.close();
  });
}

describe('collab-server 初始状态同步', () => {
  it('晚加入成员会收到带身份的选区回放和完整快照请求结果', async () => {
    let server;
    let alice;
    let bob;

    try {
      server = await startServer();
      alice = await openSocket(server.port, 'alice');
      bob = await openSocket(server.port, 'bob');

      alice.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'alice',
        userName: 'Alice',
        userColor: '#e74c3c'
      }));
      alice.socket.send(JSON.stringify({
        type: 'selection-change',
        roomId: 'room-sync',
        userId: 'alice',
        sheetId: 'sheet-1',
        selection: { startRow: 1, startCol: 2, endRow: 1, endCol: 2 }
      }));
      bob.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'bob',
        userName: 'Bob',
        userColor: '#2ecc71'
      }));

      const initialMembers = await waitFor(alice.messages, item =>
        item.type === 'room-members' && item.members.length === 2
      );
      expect(initialMembers.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: 'alice', userName: 'Alice' }),
        expect.objectContaining({ userId: 'bob', userName: 'Bob' })
      ]));
      expect(initialMembers.members).toHaveLength(2);

      const request = await waitFor(alice.messages, item => item.type === 'state-request');
      expect(request).toMatchObject({
        roomId: 'room-sync',
        userId: 'collab-server',
        targetUserId: 'bob'
      });

      alice.socket.send(JSON.stringify({
        type: 'state-snapshot',
        roomId: 'room-sync',
        userId: 'alice',
        targetUserId: 'bob',
        snapshot: { data: { '0-0': { v: 'from-alice' } } }
      }));

      const selection = await waitFor(bob.messages, item => item.type === 'selection-change');
      expect(selection).toMatchObject({
        userId: 'alice',
        userName: 'Alice',
        userColor: '#e74c3c',
        sheetId: 'sheet-1'
      });

      const snapshot = await waitFor(bob.messages, item => item.type === 'state-snapshot');
      expect(snapshot).toMatchObject({
        userId: 'alice',
        targetUserId: 'bob',
        snapshot: { data: { '0-0': { v: 'from-alice' } } }
      });
    } finally {
      await closeSocket(alice?.socket);
      await closeSocket(bob?.socket);
      server?.child.kill();
    }
  }, 10000);
});

describe('collab-server 心跳与异常清理', () => {
  it('心跳超时会断开异常客户端并通知房间内其他成员', async () => {
    let server;
    let alice;
    let bob;

    try {
      server = await startServer({
        HEARTBEAT_INTERVAL_MS: '20',
        HEARTBEAT_TIMEOUT_MS: '60'
      });
      alice = await openSocket(server.port, 'alice', { respondHeartbeat: false });
      bob = await openSocket(server.port, 'bob');

      alice.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'alice',
        userName: 'Alice'
      }));
      bob.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'bob',
        userName: 'Bob'
      }));

      const ping = await waitFor(bob.messages, item => item.type === 'heartbeat-ping');
      expect(ping).toMatchObject({
        roomId: 'room-sync',
        userId: 'collab-server'
      });

      const leave = await waitFor(bob.messages, item =>
        item.type === 'user-leave' && item.userId === 'alice'
      );
      expect(leave).toMatchObject({ roomId: 'room-sync', userId: 'alice' });

      const members = await waitFor(bob.messages, item =>
        item.type === 'room-members' && item.members.length === 1
      );
      expect(members.members).toEqual([
        expect.objectContaining({ userId: 'bob', userName: 'Bob' })
      ]);
    } finally {
      await closeSocket(alice?.socket);
      await closeSocket(bob?.socket);
      server?.child.kill();
    }
  }, 10000);
});

describe('collab-server 只读权限协同', () => {
  it('只读成员可以同步查看但不能写入房间数据', async () => {
    let server;
    let editor;
    let viewer;

    try {
      server = await startServer({ COLLAB_EDIT_TOKEN: 'edit-secret' });
      editor = await openSocket(server.port, 'editor', {
        query: 'editToken=edit-secret'
      });
      viewer = await openSocket(server.port, 'viewer');

      editor.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'editor',
        userName: 'Editor'
      }));
      viewer.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'viewer',
        userName: 'Viewer'
      }));

      const members = await waitFor(editor.messages, item =>
        item.type === 'room-members' && item.members.length === 2
      );
      expect(members.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: 'editor', readOnly: false }),
        expect.objectContaining({ userId: 'viewer', readOnly: true })
      ]));

      editor.socket.send(JSON.stringify({
        type: 'selection-change',
        roomId: 'room-sync',
        userId: 'editor',
        sheetId: 'sheet-1',
        selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }
      }));
      await waitFor(viewer.messages, item =>
        item.type === 'selection-change' && item.userId === 'editor'
      );

      viewer.socket.send(JSON.stringify({
        type: 'cell-change',
        roomId: 'room-sync',
        userId: 'viewer',
        sheetId: 'sheet-1',
        row: 2,
        col: 2,
        cell: { v: 'viewer-write' }
      }));

      const denied = await waitFor(viewer.messages, item =>
        item.type === 'permission-denied' && item.messageType === 'cell-change'
      );
      expect(denied).toMatchObject({
        roomId: 'room-sync',
        userId: 'collab-server',
        readOnly: true
      });

      await delay(100);
      expect(editor.messages.some(item =>
        item.type === 'cell-change' && item.userId === 'viewer'
      )).toBe(false);
    } finally {
      await closeSocket(editor?.socket);
      await closeSocket(viewer?.socket);
      server?.child.kill();
    }
  }, 10000);

  it('房间没有可编辑成员时新成员直接完成同步，不等待只读快照', async () => {
    let server;
    let viewer;
    let editor;

    try {
      server = await startServer({ COLLAB_EDIT_TOKEN: 'edit-secret' });
      viewer = await openSocket(server.port, 'viewer');
      viewer.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'viewer',
        userName: 'Viewer'
      }));
      await waitFor(viewer.messages, item => item.type === 'sync-ready');

      editor = await openSocket(server.port, 'editor', {
        query: 'editToken=edit-secret'
      });
      editor.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'editor',
        userName: 'Editor'
      }));

      await waitFor(editor.messages, item => item.type === 'sync-ready');
      expect(editor.messages.some(item => item.type === 'state-request')).toBe(false);
      expect(viewer.messages.some(item =>
        item.type === 'state-request' && item.targetUserId === 'editor'
      )).toBe(false);
    } finally {
      await closeSocket(viewer?.socket);
      await closeSocket(editor?.socket);
      server?.child.kill();
    }
  }, 10000);
});

describe('collab-server 断线重连补偿', () => {
  it('重连时按 lastSeq 补发离线期间其他用户的单元格修改', async () => {
    let server;
    let alice;
    let aliceReconnected;
    let bob;

    function send(socket, message) {
      socket.send(JSON.stringify(message));
    }

    try {
      server = await startServer();
      alice = await openSocket(server.port, 'alice');
      bob = await openSocket(server.port, 'bob');

      send(alice.socket, {
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'alice',
        userName: 'Alice'
      });
      send(bob.socket, {
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'bob',
        userName: 'Bob'
      });

      send(alice.socket, {
        type: 'cell-change',
        roomId: 'room-sync',
        userId: 'alice',
        sheetId: 'sheet-1',
        row: 0,
        col: 0,
        cell: { v: 'before-offline' }
      });
      const firstAck = await waitFor(alice.messages, item => item.type === 'sync-ack');
      expect(firstAck.seq).toBe(1);

      await closeSocket(alice.socket);
      const membersAfterLeave = await waitFor(bob.messages, item =>
        item.type === 'room-members' && item.members.length === 1
      );
      expect(membersAfterLeave.members[0]).toMatchObject({ userId: 'bob' });

      send(bob.socket, {
        type: 'cell-change',
        roomId: 'room-sync',
        userId: 'bob',
        sheetId: 'sheet-1',
        row: 1,
        col: 1,
        cell: { v: 'offline-change' }
      });
      const secondAck = await waitFor(bob.messages, item => item.type === 'sync-ack' && item.seq === 2);
      expect(secondAck.seq).toBe(2);

      aliceReconnected = await openSocket(server.port, 'alice');
      send(aliceReconnected.socket, {
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'alice',
        userName: 'Alice',
        resume: true,
        lastSeq: 1
      });

      const replay = await waitFor(aliceReconnected.messages, item =>
        item.type === 'cell-change' && item.seq === 2
      );
      expect(replay).toMatchObject({
        userId: 'bob',
        sheetId: 'sheet-1',
        row: 1,
        col: 1,
        cell: { v: 'offline-change' }
      });

      const ready = await waitFor(aliceReconnected.messages, item => item.type === 'sync-ready');
      expect(ready).toMatchObject({
        userId: 'collab-server',
        seq: 2
      });
      expect(aliceReconnected.messages.some(item => item.type === 'state-request')).toBe(false);
      const membersAfterReconnect = await waitFor(aliceReconnected.messages, item =>
        item.type === 'room-members' && item.members.length === 2
      );
      expect(membersAfterReconnect.members.map(member => member.userId).sort()).toEqual(['alice', 'bob']);
    } finally {
      await closeSocket(alice?.socket);
      await closeSocket(aliceReconnected?.socket);
      await closeSocket(bob?.socket);
      server?.child.kill();
    }
  }, 10000);
});

describe('collab-server 批量消息序列', () => {
  it('批量粘贴会为每个单元格分配独立递增 seq 并在确认中返回', async () => {
    let server;
    let alice;
    let bob;

    try {
      server = await startServer();
      alice = await openSocket(server.port, 'alice');
      bob = await openSocket(server.port, 'bob');

      alice.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'alice',
        userName: 'Alice'
      }));
      bob.socket.send(JSON.stringify({
        type: 'user-join',
        roomId: 'room-sync',
        userId: 'bob',
        userName: 'Bob'
      }));
      bob.socket.send(JSON.stringify({
        type: 'cell-change-batch',
        roomId: 'room-sync',
        userId: 'bob',
        cells: [
          { sheetId: 'sheet-1', row: 0, col: 0, cell: { v: 'A' } },
          { sheetId: 'sheet-1', row: 1, col: 1, cell: { v: 'B' } }
        ]
      }));

      const ack = await waitFor(bob.messages, item => item.type === 'sync-ack');
      expect(ack.seq).toBe(2);
      expect(ack.cellVersions).toEqual([
        { sheetId: 'sheet-1', row: 0, col: 0, seq: 1 },
        { sheetId: 'sheet-1', row: 1, col: 1, seq: 2 }
      ]);

      const batch = await waitFor(alice.messages, item => item.type === 'cell-change-batch');
      expect(batch.seq).toBe(2);
      expect(batch.cells.map(item => item.seq)).toEqual([1, 2]);
    } finally {
      await closeSocket(alice?.socket);
      await closeSocket(bob?.socket);
      server?.child.kill();
    }
  }, 10000);
});
