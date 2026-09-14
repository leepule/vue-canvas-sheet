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
 *   3. 为单元格变更维护房间级递增 seq，重连客户端携带 lastSeq 时按日志补发漏掉的修改。
 *   4. 通过应用层心跳检测异常断开的客户端，超时后主动断开并触发清理。
 *   5. 支持只读协作者：连接可声明 readOnly；配置 COLLAB_EDIT_TOKEN 后，未持有匹配 editToken 的连接一律只读。
 *   6. 断线时自动广播 user-leave，并清理该用户持有的锁。
 *
 * 启动：
 *   node scripts/collab-server.mjs                 # 默认 0.0.0.0:8800，未设置 token 时拒绝所有连接
 *   COLLAB_AUTH_TOKEN=dev-secret PORT=9000 node scripts/collab-server.mjs
 *   COLLAB_EDIT_TOKEN=edit-secret node scripts/collab-server.mjs
 *   HOST=127.0.0.1 COLLAB_AUTH_TOKEN=dev-secret PORT=8080 node scripts/collab-server.mjs
 */

import { WebSocketServer } from 'ws';
import {
  CLOSE_POLICY_VIOLATION,
  authenticateCollabRequestParams,
  isCollabMessageAuthorized
} from './collab-auth.mjs';

const PORT = Number(process.env.PORT) || 8800;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.COLLAB_AUTH_TOKEN || '';
const EDIT_TOKEN = process.env.COLLAB_EDIT_TOKEN || '';
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 5000;
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS) || 15000;

const wss = new WebSocketServer({ host: HOST, port: PORT });

/** roomId -> Set<ws> */
const rooms = new Map();
/** ws -> { roomId, userId, userName, userColor } */
const clientMeta = new WeakMap();
/** roomId -> Map<userId, lastSelectionMessage> */
const lastSelection = new Map();
/** roomId -> Map<"r,c", lockMessage> */
const lockedCells = new Map();
/** roomId -> Map<commentId, comment-change message> */
const commentThreads = new Map();
/** roomId -> 已分配的最大单元格同步序号 */
const cellChangeSequences = new Map();
/** roomId -> 按 seq 排列的单元格变更补偿日志 */
const cellChangeLogs = new Map();
/** ws -> { roomId, userId } */
const connectionAuth = new WeakMap();
/** ws -> { lastPong } */
const heartbeatStates = new WeakMap();
let heartbeatTimer = null;
const WRITE_MESSAGE_TYPES = new Set([
  'cell-change',
  'cell-change-batch',
  'cell-lock',
  'cell-unlock',
  'cell-editing',
  'comment-change',
  'state-snapshot'
]);

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }
  return room;
}

function getRoomMembers(room) {
  const members = new Map();
  for (const peer of room) {
    const meta = clientMeta.get(peer);
    if (!meta?.userId) continue;
    members.set(meta.userId, {
      userId: meta.userId,
      userName: meta.userName || meta.userId,
      userColor: meta.userColor || '#3498db',
      readOnly: meta.readOnly === true
    });
  }
  return [...members.values()];
}

function broadcastRoomMembers(roomId, senderWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  const message = {
    type: 'room-members',
    roomId,
    userId: 'collab-server',
    members: getRoomMembers(room)
  };
  broadcast(roomId, senderWs, message);
  sendTo(senderWs, message);
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

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const peer of room) {
        const state = heartbeatStates.get(peer);
        const meta = clientMeta.get(peer);
        if (!state || !meta) continue;

        if (now - state.lastPong > HEARTBEAT_TIMEOUT_MS) {
          console.warn(`[collab] heartbeat timeout: ${meta.userId} in room "${meta.roomId}"`);
          peer.terminate();
          continue;
        }

        sendTo(peer, {
          type: 'heartbeat-ping',
          roomId: meta.roomId,
          userId: 'collab-server',
          timestamp: now
        });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function nextCellChangeSequence(roomId) {
  const seq = (cellChangeSequences.get(roomId) || 0) + 1;
  cellChangeSequences.set(roomId, seq);
  return seq;
}

function appendCellChangeLog(roomId, message) {
  const seq = nextCellChangeSequence(roomId);
  let loggedMessage = { ...message, seq };

  if (message.type === 'cell-change-batch' && Array.isArray(message.cells)) {
    loggedMessage = {
      ...loggedMessage,
      cells: message.cells.map((item, index) => ({ ...item, seq: seq + index })),
      seq: seq + message.cells.length - 1
    };
    cellChangeSequences.set(roomId, loggedMessage.seq);
  }

  const log = cellChangeLogs.get(roomId) || [];
  log.push(loggedMessage);
  cellChangeLogs.set(roomId, log);
  return loggedMessage;
}

function getAckCellVersions(message) {
  if (message.type === 'cell-change-batch' && Array.isArray(message.cells)) {
    return message.cells.map(({ sheetId, row, col, seq }) => ({ sheetId, row, col, seq }));
  }
  const { sheetId, row, col, seq } = message;
  return [{ sheetId, row, col, seq }];
}

function parseRequestParams(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  return new URL(req.url || '/', `ws://${host}`).searchParams;
}

function authenticateRequest(req) {
  return authenticateCollabRequestParams(parseRequestParams(req), AUTH_TOKEN, EDIT_TOKEN);
}

function denyWrite(ws, msg) {
  const auth = connectionAuth.get(ws) || {};
  console.warn(`[collab] write denied for read-only user ${auth.userId} in room "${auth.roomId}": ${msg.type}`);
  sendTo(ws, {
    type: 'permission-denied',
    roomId: msg.roomId,
    userId: 'collab-server',
    readOnly: true,
    messageType: msg.type
  });
}

function closeUnauthorized(ws, reason) {
  console.warn(`[collab] unauthorized connection rejected: ${reason}`);
  try {
    ws.close(CLOSE_POLICY_VIOLATION, 'Unauthorized');
  } catch (_) {
    try { ws.terminate(); } catch (__) { /* noop */ }
  }
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
      commentThreads.delete(roomId);
      cellChangeSequences.delete(roomId);
      cellChangeLogs.delete(roomId);
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
  broadcastRoomMembers(roomId, ws);
  clientMeta.delete(ws);
  connectionAuth.delete(ws);

  console.log(`[collab] - ${userId} left room "${roomId}" (room size: ${room ? room.size : 0})`);
}

function handleJoin(ws, msg) {
  const { roomId, userId, userName, userColor } = msg;
  const auth = connectionAuth.get(ws);
  if (!isCollabMessageAuthorized(auth, msg)) {
    closeUnauthorized(ws, 'join identity does not match authenticated handshake');
    return;
  }

  if (!roomId || !userId) {
    console.warn('[collab] user-join missing roomId/userId, ignored');
    return;
  }

  const room = getRoom(roomId);
  room.add(ws);
  clientMeta.set(ws, {
    roomId,
    userId,
    userName,
    userColor,
    readOnly: auth.readOnly === true
  });

  console.log(`[collab] + ${userName || userId} joined room "${roomId}" (room size: ${room.size})`);

  // 1. 让房间内已存在的成员知道新人来了
  broadcast(roomId, ws, { ...msg, readOnly: auth.readOnly === true });
  broadcastRoomMembers(roomId, ws);

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
  const comments = commentThreads.get(roomId);
  if (comments) {
    for (const payload of comments.values()) {
      if (payload.userId !== userId) sendTo(ws, payload);
    }
  }

  const sourceCandidates = [...room].filter(peer =>
    peer !== ws &&
    peer.readyState === peer.OPEN &&
    clientMeta.get(peer)?.userId !== userId
  );
  // 只读成员可以作为快照接收方，但不能作为权威快照来源。
  const sourcePeer = sourceCandidates.find(peer =>
    connectionAuth.get(peer)?.readOnly !== true
  );

  function requestSnapshot() {
    if (!sourcePeer) {
      sendTo(ws, {
        type: 'sync-ready',
        roomId,
        userId: 'collab-server',
        seq: cellChangeSequences.get(roomId) || 0
      });
      return;
    }

    sendTo(sourcePeer, {
      type: 'state-request',
      roomId,
      // 插件会忽略 userId 等于自己的消息；这里必须使用服务端身份，不能填 sourcePeer 的 userId。
      userId: 'collab-server',
      targetUserId: userId
    });
  }

  const canResume = msg.resume === true && Number.isInteger(msg.lastSeq);
  const serverSequence = cellChangeSequences.get(roomId) || 0;

  if (canResume && msg.lastSeq <= serverSequence) {
    const log = cellChangeLogs.get(roomId) || [];
    for (const payload of log) {
      if (payload.seq > msg.lastSeq && payload.userId !== userId) {
        sendTo(ws, payload);
      }
    }
    sendTo(ws, {
      type: 'sync-ready',
      roomId,
      userId: 'collab-server',
      seq: serverSequence
    });
    return;
  }

  if (canResume) {
    // 客户端序号超过服务端序号，说明服务端重启或房间状态被重建，需要完整快照重新对齐。
    sendTo(ws, {
      type: 'sync-reset',
      roomId,
      userId: 'collab-server'
    });
  }

  requestSnapshot();
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const auth = authenticateRequest(req);
  if (!auth.ok) {
    closeUnauthorized(ws, auth.reason);
    return;
  }

  connectionAuth.set(ws, {
    roomId: auth.roomId,
    userId: auth.userId,
    readOnly: auth.readOnly === true
  });
  heartbeatStates.set(ws, { lastPong: Date.now() });
  console.log(`[collab] authenticated connection from ${ip} as ${auth.userId} in room "${auth.roomId}"`);

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

    const auth = connectionAuth.get(ws);
    if (!isCollabMessageAuthorized(auth, msg)) {
      closeUnauthorized(ws, 'message identity does not match authenticated handshake');
      cleanupClient(ws);
      return;
    }

    if (WRITE_MESSAGE_TYPES.has(type) && auth.readOnly === true) {
      denyWrite(ws, msg);
      return;
    }

    switch (type) {
      case 'user-join':
        handleJoin(ws, msg);
        return;

      case 'heartbeat-pong': {
        const state = heartbeatStates.get(ws);
        if (state) state.lastPong = Date.now();
        return;
      }

      case 'user-leave':
        broadcast(roomId, ws, msg);
        cleanupClient(ws);
        return;

      case 'selection-change': {
        const meta = clientMeta.get(ws) || {};
        const selectionMessage = {
          ...msg,
          userName: msg.userName ?? meta.userName,
          userColor: msg.userColor ?? meta.userColor
        };
        const sel = lastSelection.get(roomId) || new Map();
        sel.set(userId, selectionMessage);
        lastSelection.set(roomId, sel);
        broadcast(roomId, ws, selectionMessage);
        return;
      }

      case 'cell-lock': {
        const locks = lockedCells.get(roomId) || new Map();
        locks.set(`${msg.sheetId || ''}:${msg.r},${msg.c}`, msg);
        lockedCells.set(roomId, locks);
        broadcast(roomId, ws, msg);
        return;
      }

      case 'cell-unlock': {
        const locks = lockedCells.get(roomId);
        if (locks) {
          const key = `${msg.sheetId || ''}:${msg.r},${msg.c}`;
          const existing = locks.get(key);
          if (existing && existing.userId === userId) locks.delete(key);
        }
        broadcast(roomId, ws, msg);
        return;
      }

      case 'cell-change':
      case 'cell-change-batch': {
        if (msg.type === 'cell-change-batch' && (!Array.isArray(msg.cells) || msg.cells.length === 0)) {
          return;
        }
        const loggedMessage = appendCellChangeLog(roomId, msg);
        broadcast(roomId, ws, loggedMessage);
        sendTo(ws, {
          type: 'sync-ack',
          roomId,
          userId: 'collab-server',
          seq: loggedMessage.seq,
          cellVersions: getAckCellVersions(loggedMessage)
        });
        return;
      }

      case 'cell-editing':
      case 'chat-message':
      case 'comment-change':
        {
          const comments = commentThreads.get(roomId) || new Map();
          if (msg.action === 'remove') comments.delete(msg.comment?.id);
          else if (msg.comment?.id) comments.set(msg.comment.id, msg);
          commentThreads.set(roomId, comments);
        }
        broadcast(roomId, ws, msg);
        return;

      case 'state-snapshot': {
        if (!msg.targetUserId) {
          console.warn('[collab] state-snapshot missing targetUserId, ignored');
          return;
        }
        const room = rooms.get(roomId);
        const target = room
          ? [...room].find(peer => clientMeta.get(peer)?.userId === msg.targetUserId)
          : null;
        if (target) sendTo(target, msg);
        return;
      }

      default:
        // 透传其他自定义消息
        broadcast(roomId, ws, msg);
    }
  });

  ws.on('close', () => cleanupClient(ws));
  ws.on('error', (err) => console.warn('[collab] socket error:', err.message));
});

wss.on('listening', () => {
  startHeartbeat();
  console.log(`[collab] WebSocket collaboration server listening on ws://${HOST}:${PORT}`);
  if (!AUTH_TOKEN) {
    console.log('[collab] COLLAB_AUTH_TOKEN is not set; server running in open mode (no auth token required).');
  }
  console.log('[collab] Set RealtimeCollaborationPlugin serverUrl to e.g. ws://localhost:' + PORT);
});

function shutdown() {
  console.log('\n[collab] shutting down…');
  stopHeartbeat();
  for (const ws of wss.clients) {
    try { ws.close(); } catch (_) { /* noop */ }
  }
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
