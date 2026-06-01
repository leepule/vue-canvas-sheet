#!/usr/bin/env node
/**
 * 协同编辑测试 WebSocket 服务
 *
 * 配套 src/plugins/RealtimeCollaborationPlugin.js 使用，仅供本地联调，不适合生产。
 *
 * 消息协议（所有消息均为 JSON 字符串）：
 *   { type, roomId, userId, ...payload }
 *
 * 服务端职责：
 *   1. 按 roomId 分房，把任一客户端发来的消息广播给同房间的其他客户端（不回发给自己）。
 *   2. 缓存每个用户最近一次的 selection-change 与持有的 cell-lock，新成员加入时回放，
 *      让后到的客户端能立刻看到已经在房间里的他人光标 / 锁。
 *   3. 断线时自动广播 user-leave，并清理该用户持有的锁。
 *
 * 启动：
 *   node scripts/collab-server.mjs                 # 默认 0.0.0.0:8080
 *   PORT=9000 node scripts/collab-server.mjs
 *   HOST=127.0.0.1 PORT=8080 node scripts/collab-server.mjs
 */

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8800;
const HOST = process.env.HOST || '0.0.0.0';

const wss = new WebSocketServer({ host: HOST, port: PORT });

/** roomId -> Set<ws> */
const rooms = new Map();
/** ws -> { roomId, userId, userName, userColor } */
const clientMeta = new WeakMap();
/** roomId -> Map<userId, lastSelectionMessage> */
const lastSelection = new Map();
/** roomId -> Map<"r,c", lockMessage> */
const lockedCells = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }
  return room;
}

function broadcast(roomId, senderWs, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const peer of room) {
    if (peer === senderWs) continue;
    if (peer.readyState === peer.OPEN) {
      peer.send(text);
    }
  }
}

function sendTo(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function cleanupClient(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;
  const { roomId, userId } = meta;
  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(roomId);
      lastSelection.delete(roomId);
      lockedCells.delete(roomId);
    }
  }

  // 清理该用户缓存的选区与单元格锁
  const sel = lastSelection.get(roomId);
  if (sel) sel.delete(userId);
  const locks = lockedCells.get(roomId);
  if (locks) {
    for (const [key, info] of locks) {
      if (info.userId === userId) locks.delete(key);
    }
  }

  // 广播离线
  broadcast(roomId, ws, { type: 'user-leave', roomId, userId });
  clientMeta.delete(ws);

  console.log(`[collab] - ${userId} left room "${roomId}" (room size: ${room ? room.size : 0})`);
}

function handleJoin(ws, msg) {
  const { roomId, userId, userName, userColor } = msg;
  if (!roomId || !userId) {
    console.warn('[collab] user-join missing roomId/userId, ignored');
    return;
  }

  const room = getRoom(roomId);
  room.add(ws);
  clientMeta.set(ws, { roomId, userId, userName, userColor });

  console.log(`[collab] + ${userName || userId} joined room "${roomId}" (room size: ${room.size})`);

  // 1. 让房间内已存在的成员知道新人来了
  broadcast(roomId, ws, msg);

  // 2. 把房间内现有的 selection 与 cell-lock 回放给新人，让他立刻看到他人光标 / 锁
  const sel = lastSelection.get(roomId);
  if (sel) {
    for (const [otherUserId, payload] of sel) {
      if (otherUserId !== userId) sendTo(ws, payload);
    }
  }
  const locks = lockedCells.get(roomId);
  if (locks) {
    for (const payload of locks.values()) {
      if (payload.userId !== userId) sendTo(ws, payload);
    }
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[collab] connection from ${ip}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.warn('[collab] invalid JSON, ignored:', raw.toString().slice(0, 120));
      return;
    }

    const { type, roomId, userId } = msg || {};
    if (!type || !roomId || !userId) {
      console.warn('[collab] message missing type/roomId/userId, ignored:', msg);
      return;
    }

    switch (type) {
      case 'user-join':
        handleJoin(ws, msg);
        return;

      case 'user-leave':
        broadcast(roomId, ws, msg);
        cleanupClient(ws);
        return;

      case 'selection-change': {
        const sel = lastSelection.get(roomId) || new Map();
        sel.set(userId, msg);
        lastSelection.set(roomId, sel);
        broadcast(roomId, ws, msg);
        return;
      }

      case 'cell-lock': {
        const locks = lockedCells.get(roomId) || new Map();
        locks.set(`${msg.r},${msg.c}`, msg);
        lockedCells.set(roomId, locks);
        broadcast(roomId, ws, msg);
        return;
      }

      case 'cell-unlock': {
        const locks = lockedCells.get(roomId);
        if (locks) {
          const key = `${msg.r},${msg.c}`;
          const existing = locks.get(key);
          if (existing && existing.userId === userId) locks.delete(key);
        }
        broadcast(roomId, ws, msg);
        return;
      }

      case 'cell-change':
      case 'cell-change-batch': // 批量单元格变更（粘贴/填充合并），与 cell-change 一样纯透传
      case 'cell-editing':
      case 'chat-message':
        broadcast(roomId, ws, msg);
        return;

      default:
        // 透传其他自定义消息
        broadcast(roomId, ws, msg);
    }
  });

  ws.on('close', () => cleanupClient(ws));
  ws.on('error', (err) => console.warn('[collab] socket error:', err.message));
});

wss.on('listening', () => {
  console.log(`[collab] WebSocket collaboration server listening on ws://${HOST}:${PORT}`);
  console.log('[collab] Set RealtimeCollaborationPlugin serverUrl to e.g. ws://localhost:' + PORT);
});

function shutdown() {
  console.log('\n[collab] shutting down…');
  for (const ws of wss.clients) {
    try { ws.close(); } catch (_) { /* noop */ }
  }
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
