/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 实时多人协同插件 (原生高健壮版)
 * 使用原生 WebSocket 实现实时选区光标和单元格数据的多人同步，无任何外部库依赖。
 */
export class RealtimeCollaborationPlugin {
  name = 'RealtimeCollaboration';
  version = '1.0.0';
  description = '实时多人协同插件，提供高性能的原生 WebSocket 选区与数据同步';
  dependencies = ['CollaborativeCursor'];

  constructor(options = {}) {
    this.options = options;
    this.debug = options.debug === true || options.verbose === true;
    this.serverUrl = options.serverUrl || null;
    this.roomId = options.roomId || 'default-room';
    this.userId = options.userId || 'user_' + Math.random().toString(36).substring(2, 7);
    this.userName = options.userName || `用户_${this.userId}`;
    this.userColor = options.userColor || '#3498db';
    this.autoConnect = options.autoConnect !== false;
    this.authToken = options.token ?? options.authToken ?? '';
    this.authTokenParam = options.authTokenParam || 'token';
    this.authRequired = options.authRequired ?? (!!(options.token || options.authToken));
    this.readOnly = options.readOnly === true || options.permission === 'viewer';
    this.editToken = options.editToken ?? '';
    this.editTokenParam = options.editTokenParam || 'editToken';
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 20000;

    // 自定义网络传输字段名映射配置
    const fieldNames = options.fieldNames || {};
    this.fieldNames = {
      type: fieldNames.type || 'type',
      roomId: fieldNames.roomId || 'roomId',
      userId: fieldNames.userId || 'userId',
      userName: fieldNames.userName || 'userName',
      userColor: fieldNames.userColor || 'userColor',
      selection: fieldNames.selection || 'selection',
      row: fieldNames.row || 'row',
      col: fieldNames.col || 'col',
      cell: fieldNames.cell || 'cell',
      timestamp: fieldNames.timestamp || 'timestamp',
      r: fieldNames.r || 'r',
      c: fieldNames.c || 'c',
      val: fieldNames.val || 'val',
      text: fieldNames.text || 'text',
      comment: fieldNames.comment || 'comment'
    };

    // 建立反向映射表以快速反序列化
    this._reverseFieldNames = {};
    for (const [standardKey, networkKey] of Object.entries(this.fieldNames)) {
      this._reverseFieldNames[networkKey] = standardKey;
    }

    this._socket = null;
    this._workbook = null;
    this._registry = null;
    this._isApplyingRemote = false; // 回环锁
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._lockedCells = new Map(); // key: sheetId:r,c -> { userId, userName }
    this._editingDrafts = new Map(); // key: sheetId:r,c -> { userId, userName, value }
    this._localFocusTime = Date.now();
    this._lastSelectionKey = null; // 缓存上一次的选区，避免原地重复点击或双击时重置聚焦时间

    // 选区广播节流：拖拽/连续点选会爆发式触发 selection-change，逐次 _sendRaw 浪费网络与序列化。
    // 这里只节流「网络发送」，焦点时间判定仍同步执行（见 onMounted）。窗口内合并为最后一次选区。
    this._selectionThrottleMs = options.selectionThrottleMs ?? 30;
    this._selectionSendTimer = null;
    this._pendingSelection = null;

    // cell-change 批量合并：同一同步任务（如 bulkSetCells 粘贴/填充）内爆发的多格变更，
    // 入队后于微任务统一冲刷——单格走传统 cell-change（向后兼容），多格合并为单条 cell-change-batch。
    this._cellChangeQueue = [];
    this._cellChangeFlushScheduled = false;
    this._offlineCellChangeQueue = [];
    this._lastSyncSequence = 0;
    this._cellVersions = new Map(); // key: sheetId:r,c -> seq
    this._hasSyncedConnection = false;
    this._connectionOpened = false;
    this._waitingForSnapshotBeforeOfflineFlush = false;
    this._roomMembers = new Map(); // userId -> { userId, userName, userColor }
    this._pendingRemoteCellChanges = [];
    this._pendingRemoteCommentChanges = [];
    this._heartbeatTimeoutTimer = null;
    this._heartbeatWatchdogStarted = false;
    this._workbookReadOnlyBeforeCollab = null;
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;

    this._applyWorkbookReadOnly();

    // 由实时协同插件统一负责批注同步，使用批注插件时也不会重复广播。
    registry.setSharedState('collaboration:comment-sync-owner', true);
    registry.setSharedState('collaboration:getUserInfo', () => ({
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor
    }));

    // 注册全局共享状态与控制 API 供外部 UI 调用
    registry.setSharedState('collaboration:connect', (url) => this.connect(url));
    registry.setSharedState('collaboration:disconnect', () => this.disconnect());
    registry.setSharedState('collaboration:sendChat', (msg) => this.sendChatMessage(msg));
    registry.setSharedState('collaboration:getStatus', () => this.getConnectionStatus());
    registry.setSharedState('collaboration:getConnectionInfo', () => this.getConnectionInfo());
    registry.setSharedState('collaboration:setReadOnly', (readOnly) => this.setReadOnly(readOnly));
    registry.setSharedState('collaboration:isCellLocked', (r, c) => this.isCellLocked(r, c));
    registry.setSharedState('collaboration:isCellEditLocked', (r, c) => this.isCellEditLocked(r, c));
    registry.setSharedState('collaboration:getCellLockInfo', (r, c) => this.getCellLockInfo(r, c));
    registry.setSharedState('collaboration:lockCell', (r, c) => this.lockLocalCell(r, c));
    registry.setSharedState('collaboration:unlockCell', (r, c) => this.unlockLocalCell(r, c));
    registry.setSharedState('collaboration:broadcastEditing', (r, c, val) => this.broadcastEditing(r, c, val));
    registry.setSharedState('collaboration:getEditingDraft', (r, c) => this.getEditingDraft(r, c));
    registry.setSharedState('collaboration:getLocalFocusTime', () => this._localFocusTime);
    registry.setSharedState('collaboration:broadcastComment', (comment, action) => this.broadcastComment(comment, action));
  }

  _logDebug(...args) {
    if (this.debug) console.log(...args);
  }

  _getActiveSheetId() {
    return this._workbook?.activeSheetId || null;
  }

  _getMessageSheetId(msg) {
    if (msg?.sheetId === undefined || msg?.sheetId === null) return this._getActiveSheetId();
    const sheetId = String(msg.sheetId);
    return sheetId || null;
  }

  _recordSyncSequence(msg) {
    if (Number.isInteger(msg?.seq) && msg.seq > this._lastSyncSequence) {
      this._lastSyncSequence = msg.seq;
    }
  }

  _getCellSequence(item, msg) {
    const seq = item?.seq ?? msg?.seq;
    return Number.isInteger(seq) ? seq : null;
  }

  _shouldApplyCellVersion(sheetId, row, col, seq) {
    if (seq === null) return true;
    const key = this._cellStateKey(sheetId, row, col);
    const current = this._cellVersions.get(key);
    if (current !== undefined && seq <= current) {
      this._emitCellSequenceConflict({ key, current, incoming: seq, row, col, sheetId });
      return false;
    }
    this._cellVersions.set(key, seq);
    return true;
  }

  _recordAckCellVersions(msg) {
    if (!Array.isArray(msg.cellVersions)) return;
    for (const item of msg.cellVersions) {
      if (
        !Number.isInteger(item.row) || !Number.isInteger(item.col) ||
        !Number.isInteger(item.seq)
      ) continue;
      const key = this._cellStateKey(item.sheetId ?? null, item.row, item.col);
      const current = this._cellVersions.get(key);
      if (current === undefined || item.seq > current) {
        this._cellVersions.set(key, item.seq);
      }
    }
  }

  _emitCellSequenceConflict(payload) {
    if (this._workbook && typeof this._workbook.emitEvent === 'function') {
      this._workbook.emitEvent('collaboration-conflict', {
        type: 'cell-sequence',
        reason: 'stale-or-duplicate',
        ...payload
      });
    }
  }

  _sheetExists(sheetId) {
    if (!sheetId || !this._workbook) return false;
    return this._workbook.getSheets().some(sheet => sheet.id === sheetId);
  }

  _canApplyRemoteSheet(sheetId) {
    return sheetId === null || this._sheetExists(sheetId);
  }

  _cellStateKey(sheetId, r, c) {
    return `${sheetId}:${r},${c}`;
  }

  _queueRemoteCellChange(sheetId, item) {
    if (!this._sheetExists(sheetId)) return;
    this._pendingRemoteCellChanges.push({ ...item, sheetId });
  }

  _queueRemoteCommentChange(sheetId, msg) {
    if (!this._sheetExists(sheetId) || !msg.comment) return;
    this._pendingRemoteCommentChanges.push({
      sheetId,
      action: msg.action,
      comment: msg.comment
    });
  }

  _applyPendingRemoteCellChanges(sheetId) {
    if (!this._workbook || this._pendingRemoteCellChanges.length === 0) return;
    const remaining = [];
    this._isApplyingRemote = true;
    try {
      for (const item of this._pendingRemoteCellChanges) {
        if (item.sheetId !== sheetId) {
          remaining.push(item);
          continue;
        }
        if (
          !Number.isInteger(item.row) || !Number.isInteger(item.col) ||
          item.row < 0 || item.col < 0 ||
          item.row >= this._workbook.rowCount || item.col >= this._workbook.colCount
        ) {
          continue;
        }
        this._workbook.setCell(item.row, item.col, item.cell, null, {
          skipEvent: true,
          skipHistory: true
        });
        this._editingDrafts.delete(this._cellStateKey(sheetId, item.row, item.col));
      }
    } finally {
      this._isApplyingRemote = false;
    }
    this._pendingRemoteCellChanges = remaining;
    this._requestRender();
  }

  _applyPendingRemoteCommentChanges(sheetId) {
    if (!this._workbook || this._pendingRemoteCommentChanges.length === 0) return;
    const remaining = [];
    for (const item of this._pendingRemoteCommentChanges) {
      if (item.sheetId !== sheetId) {
        remaining.push(item);
        continue;
      }
      if (item.action === 'remove') {
        this._workbook.removeComment(item.comment.id, { remote: true });
      } else {
        this._workbook.upsertComment(item.comment);
      }
    }
    this._pendingRemoteCommentChanges = remaining;
  }

  _clearSheetCollaborationState(sheetId) {
    const prefix = `${sheetId}:`;
    for (const key of this._lockedCells.keys()) {
      if (key.startsWith(prefix)) this._lockedCells.delete(key);
    }
    for (const key of this._editingDrafts.keys()) {
      if (key.startsWith(prefix)) this._editingDrafts.delete(key);
    }
    this._pendingRemoteCellChanges = this._pendingRemoteCellChanges.filter(item => item.sheetId !== sheetId);
    this._pendingRemoteCommentChanges = this._pendingRemoteCommentChanges.filter(item => item.sheetId !== sheetId);
    this._checkDraftsAnimation();
  }

  onMounted(workbook, registry) {
    // 1. 订阅本地选区变化并广播
    this._unsubSelection = workbook.on('selection-change', (selection) => {
      // 💡 焦点防冲突：只有当选区真正发生物理改变时，才重置本地聚焦时间戳，避免原地重复点击或双击时错把先来者判定为后来者
      if (selection) {
        const selectionKey = JSON.stringify(selection);
        if (this._lastSelectionKey !== selectionKey) {
          this._localFocusTime = Date.now();
          this._lastSelectionKey = selectionKey;
        }
      } else {
        this._lastSelectionKey = null;
      }
      this._broadcastSelection(selection);
    });

    // 2. 拦截本地数据变化并广播
    this._unsubCell = registry.on('cell-change', (data) => {
      return this._handleLocalCellChange(data);
    });

    // 即使未额外注册 CellCommentPlugin，本地批注也能通过 WebSocket 同步。
    this._unsubComment = workbook.on('comment-change', (payload) => {
      if (payload?.remote || !payload?.comment) return;
      this.broadcastComment(payload.comment, payload.action);
    });

    this._unsubSheetChange = workbook.on('sheet-change', (payload) => {
      if (payload?.deleted) {
        this._clearSheetCollaborationState(payload.id);
        return;
      }

      this._localFocusTime = Date.now();
      this._lastSelectionKey = null;
      this._flushPendingSelection();
      this._applyPendingRemoteCellChanges(payload.id);
      this._applyPendingRemoteCommentChanges(payload.id);
      this._broadcastSelection(workbook.selection);
    });

    // 3. 自动连接
    if (this.autoConnect && this.serverUrl) {
      this.connect();
    }
  }

  onUnmount() {
    this.disconnect();
    this._lastSelectionKey = null;
    this._reconnectAttempts = 0;
    this._lockedCells.clear();
    
    if (this._unsubSelection) {
      this._unsubSelection();
      this._unsubSelection = null;
    }
    if (this._unsubCell) {
      this._unsubCell();
      this._unsubCell = null;
    }
    if (this._unsubComment) {
      this._unsubComment();
      this._unsubComment = null;
    }
    if (this._unsubSheetChange) {
      this._unsubSheetChange();
      this._unsubSheetChange = null;
    }
    if (this._registry) {
      this._registry.deleteSharedState('collaboration:connect');
      this._registry.deleteSharedState('collaboration:disconnect');
      this._registry.deleteSharedState('collaboration:sendChat');
      this._registry.deleteSharedState('collaboration:getStatus');
      this._registry.deleteSharedState('collaboration:getConnectionInfo');
      this._registry.deleteSharedState('collaboration:setReadOnly');
      this._registry.deleteSharedState('collaboration:isCellLocked');
      this._registry.deleteSharedState('collaboration:isCellEditLocked');
      this._registry.deleteSharedState('collaboration:getCellLockInfo');
      this._registry.deleteSharedState('collaboration:lockCell');
      this._registry.deleteSharedState('collaboration:unlockCell');
      this._registry.deleteSharedState('collaboration:broadcastEditing');
      this._registry.deleteSharedState('collaboration:getEditingDraft');
      this._registry.deleteSharedState('collaboration:getLocalFocusTime');
      this._registry.deleteSharedState('collaboration:broadcastComment');
      this._registry.deleteSharedState('collaboration:comment-sync-owner');
      this._registry.deleteSharedState('collaboration:getUserInfo');
    }
    if (this._draftsAnimTimer) {
      clearInterval(this._draftsAnimTimer);
      this._draftsAnimTimer = null;
    }
    this._editingDrafts.clear();
    this._cellVersions.clear();
    this._pendingRemoteCellChanges = [];
    this._pendingRemoteCommentChanges = [];
    this._roomMembers.clear();
    this._workbook = null;
  }

  /**
   * 建立 WebSocket 连接
   */
  connect(url = null) {
    if (url) this.serverUrl = url;
    if (!this.serverUrl) {
      console.warn('[RealtimeCollaboration] Cannot connect: serverUrl is not specified.');
      return;
    }

    this.disconnect();
    this._logDebug(`[RealtimeCollaboration] Connecting to ${this.serverUrl} [Room: ${this.roomId}]`);

    try {
      const connectionUrl = this._buildAuthenticatedUrl();
      if (!connectionUrl) return false;
      this._socket = new WebSocket(connectionUrl);
      this._setupSocketListeners();
      this._emitConnectionStatus();
      return true;
    } catch (error) {
      console.error('[RealtimeCollaboration] WebSocket connection failed:', error);
      this._handleReconnect();
      return false;
    }
  }

  _buildAuthenticatedUrl() {
    const token = typeof this.authToken === 'function' ? this.authToken() : this.authToken;
    const editToken = typeof this.editToken === 'function' ? this.editToken() : this.editToken;
    if (this.authRequired && !token) {
      console.warn('[RealtimeCollaboration] Cannot connect: collaboration auth token is required.');
      return null;
    }

    const base =
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : undefined;
    const url = base ? new URL(this.serverUrl, base) : new URL(this.serverUrl);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';

    url.searchParams.set('roomId', this.roomId);
    url.searchParams.set('userId', this.userId);
    if (token) {
      url.searchParams.set(this.authTokenParam, token);
    } else {
      url.searchParams.delete(this.authTokenParam);
    }

    if (this.readOnly) {
      url.searchParams.set('readOnly', 'true');
    } else {
      url.searchParams.delete('readOnly');
      if (editToken) {
        url.searchParams.set(this.editTokenParam, editToken);
      } else {
        url.searchParams.delete(this.editTokenParam);
      }
    }
    return url.toString();
  }

  setReadOnly(readOnly) {
    this._setCollaborationReadOnly(readOnly === true);
    return this.getConnectionInfo();
  }

  _setCollaborationReadOnly(readOnly) {
    if (this.readOnly === readOnly) {
      this._applyWorkbookReadOnly();
      return;
    }
    this.readOnly = readOnly;
    this._applyWorkbookReadOnly();
    this._emitConnectionStatus();
  }

  _applyWorkbookReadOnly() {
    if (!this._workbook || !this.readOnly) return;
    if (this._workbookReadOnlyBeforeCollab === null) {
      this._workbookReadOnlyBeforeCollab = this._workbook.readOnly === true;
    }
    this._workbook.readOnly = true;
  }

  _restoreWorkbookReadOnly() {
    if (this._workbookReadOnlyBeforeCollab === null || !this._workbook) return;
    this._workbook.readOnly = this._workbookReadOnlyBeforeCollab;
    this._workbookReadOnlyBeforeCollab = null;
  }

  /**
   * 断开连接并回收定时器
   */
  disconnect() {
    const hadOpenConnection = !!(this._socket && this._socket.readyState === WebSocket.OPEN);
    this._stopHeartbeat();
    this._restoreWorkbookReadOnly();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._selectionSendTimer !== null) {
      clearTimeout(this._selectionSendTimer);
      this._selectionSendTimer = null;
      this._pendingSelection = null;
    }
    // 断线前尚未发出的修改不能丢弃，重连后需要补偿给其他协作者。
    for (const change of this._cellChangeQueue) {
      this._queueOfflineCellChange(change);
    }
    this._cellChangeQueue = [];
    this._cellChangeFlushScheduled = false;
    if (this._socket) {
      // 移除所有监听，避免触发 close 重连
      this._socket.onopen = null;
      this._socket.onmessage = null;
      this._socket.onerror = null;
      this._socket.onclose = null;
      
      if (this._socket.readyState === WebSocket.OPEN || this._socket.readyState === WebSocket.CONNECTING) {
        // 优雅发送离线通知
        this._sendRaw({
          type: 'user-leave',
          roomId: this.roomId,
          userId: this.userId
        });
        this._socket.close();
      }
      this._socket = null;
    }
    const lockStateChanged = this._clearLocksForUser(this.userId);
    if (lockStateChanged && this._workbook) {
      this._requestRender();
      this._emitLockChange();
      this._checkDraftsAnimation();
    }
    this._clearRemoteCursors();

    if (hadOpenConnection) this._hasSyncedConnection = true;
    this._roomMembers.clear();
    this._emitConnectionStatus();
  }

  getConnectionStatus() {
    if (!this._socket) {
      if (this._reconnectTimer) return 'RECONNECTING';
      return 'OFFLINE';
    }
    switch (this._socket.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'CONNECTED';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  getConnectionInfo() {
    return {
      status: this.getConnectionStatus(),
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor,
      readOnly: this.readOnly,
      memberCount: this._roomMembers.size,
      members: [...this._roomMembers.values()]
    };
  }

  _emitConnectionStatus() {
    if (this._workbook && typeof this._workbook.emitEvent === 'function') {
      this._workbook.emitEvent('collaboration-status', this.getConnectionInfo());
    }
  }

  _setRoomMembers(members) {
    this._roomMembers.clear();
    for (const member of members || []) {
      if (!member?.userId) continue;
      this._roomMembers.set(member.userId, {
        userId: member.userId,
        userName: member.userName || member.userId,
        userColor: member.userColor || '#3498db',
        readOnly: member.readOnly === undefined ? undefined : member.readOnly === true
      });
    }
    const self = this._roomMembers.get(this.userId);
    if (self && typeof self.readOnly === 'boolean') {
      this._setCollaborationReadOnly(self.readOnly);
    }
    this._emitConnectionStatus();
  }

  _setupSocketListeners() {
    this._socket.onopen = () => {
      this._logDebug('[RealtimeCollaboration] WebSocket connection established successfully.');
      this._reconnectAttempts = 0;
      
      const resume = this._hasSyncedConnection;
      this._connectionOpened = true;
      this._emitConnectionStatus();

      // resume 携带最后确认序号，服务端据此补发断线期间的远端变更。
      this._sendRaw({
        type: 'user-join',
        roomId: this.roomId,
        userId: this.userId,
        userName: this.userName,
        userColor: this.userColor,
        resume,
        lastSeq: this._lastSyncSequence
      });

      // 让房间内已有成员立即看到新用户的当前位置。
      this._broadcastSelection(this._workbook?.selection);

      // 首次连接但本地已有修改时，等待快照落地后再补发，避免快照覆盖本地输入。
      if (!resume && this._offlineCellChangeQueue.length > 0) {
        this._waitingForSnapshotBeforeOfflineFlush = true;
      }
    };

    this._socket.onmessage = (event) => {
      try {
        const dataStr = typeof event.data === 'string' ? event.data.trim() : '';

        if (!dataStr) {
          this._logDebug('[RealtimeCollaboration] Server feedback message:', event.data);
          return;
        }
        
        let networkMessage;
        try {
          networkMessage = JSON.parse(dataStr);
        } catch (parseErr) {
          this._logDebug('[RealtimeCollaboration] Server raw feedback:', event.data);
          return;
        }

        if (!networkMessage || typeof networkMessage !== 'object' || Array.isArray(networkMessage)) {
          this._logDebug('[RealtimeCollaboration] Ignored non-object message:', event.data);
          return;
        }

        // 利用反向映射表将网络传输字段还原为标准字段
        const message = {};
        for (const [netKey, val] of Object.entries(networkMessage)) {
          const standardKey = this._reverseFieldNames[netKey] || netKey;
          message[standardKey] = val;
        }

        if (message.roomId !== this.roomId || message.userId === this.userId) return; // 忽略非本房间或自身的广播

        this._handleRemoteMessage(message);
      } catch (err) {
        console.warn('[RealtimeCollaboration] Ignored processing message error:', err.message);
      }
    };

    this._socket.onerror = (err) => {
      console.error('[RealtimeCollaboration] WebSocket error occurred:', err);
    };

    this._socket.onclose = () => {
      console.warn('[RealtimeCollaboration] WebSocket connection closed.');
      this._stopHeartbeat();
      if (this._connectionOpened) this._hasSyncedConnection = true;
      this._roomMembers.clear();
      const changed = this._clearLocksForUser(this.userId);
      if (changed && this._workbook) {
        this._requestRender();
        this._emitLockChange();
        this._checkDraftsAnimation();
      }
      this._socket = null;
      this._handleReconnect();
      this._emitConnectionStatus();
    };
  }

  _handleReconnect() {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error('[RealtimeCollaboration] Max reconnection attempts reached. Giving up.');
      this._emitConnectionStatus();
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 10000); // 指数退避重连算法
    this._logDebug(`[RealtimeCollaboration] Reconnecting in ${delay}ms (Attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
    
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    this._emitConnectionStatus();
  }

  _sendRaw(data) {
    if (this._socket && this._socket.readyState === WebSocket.OPEN) {
      const mappedData = {};
      for (const [key, value] of Object.entries(data)) {
        const networkKey = this.fieldNames[key] || key;
        mappedData[networkKey] = value;
      }
      this._socket.send(JSON.stringify(mappedData));
    }
  }

  _resetHeartbeatWatchdog() {
    if (!this._isSocketOpen() || !Number.isFinite(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs <= 0) {
      return;
    }
    if (this._heartbeatTimeoutTimer) clearTimeout(this._heartbeatTimeoutTimer);
    this._heartbeatWatchdogStarted = true;
    this._heartbeatTimeoutTimer = setTimeout(() => this._handleHeartbeatTimeout(), this.heartbeatTimeoutMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer);
      this._heartbeatTimeoutTimer = null;
    }
    this._heartbeatWatchdogStarted = false;
  }

  _handleHeartbeatTimeout() {
    const socket = this._socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    console.warn('[RealtimeCollaboration] WebSocket heartbeat timeout.');
    this._stopHeartbeat();
    try {
      socket.close();
    } catch (error) {
      this._logDebug('[RealtimeCollaboration] WebSocket close after heartbeat timeout failed:', error);
    }
    // 半开连接下浏览器可能迟迟不触发 close；主动触发已有 onclose 走统一清理和重连。
    socket.onclose?.({ code: 1006, reason: 'heartbeat timeout' });
  }

  _clearRemoteCursors() {
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (!collabCursor) return;
    collabCursor._cursors.clear();
    collabCursor._updateSharedState();
    this._requestRender();
  }

  _isSocketOpen() {
    return !!(this._socket && this._socket.readyState === WebSocket.OPEN);
  }

  _queueOfflineCellChange(change) {
    if (this.readOnly) return;
    if (!change || !Number.isInteger(change.row) || !Number.isInteger(change.col)) return;
    const key = `${change.sheetId ?? ''}:${change.row},${change.col}`;
    const existing = this._offlineCellChangeQueue.find(item =>
      `${item.sheetId ?? ''}:${item.row},${item.col}` === key
    );
    if (existing) {
      existing.cell = change.cell;
      return;
    }
    this._offlineCellChangeQueue.push({ ...change });
  }

  _flushOfflineCellChanges() {
    if (!this._isSocketOpen() || this._offlineCellChangeQueue.length === 0) return;
    this._cellChangeQueue = this._offlineCellChangeQueue;
    this._offlineCellChangeQueue = [];
    this._flushCellChanges();
  }

  /**
   * 广播本地用户的选区光标
   */
  _broadcastSelection(selection) {
    if (!selection) return;
    // 节流：窗口内只保留最后一次选区，窗口结束统一发送，合并拖拽爆发。
    const sheetId = this._getActiveSheetId();
    this._pendingSelection = { selection, sheetId };
    if (this._selectionSendTimer !== null) return;
    this._selectionSendTimer = setTimeout(() => this._flushPendingSelection(), this._selectionThrottleMs);
  }

  _flushPendingSelection() {
    if (this._selectionSendTimer !== null) {
      clearTimeout(this._selectionSendTimer);
      this._selectionSendTimer = null;
    }
    const pending = this._pendingSelection;
    this._pendingSelection = null;
    if (!pending) return;

    // 服务端会缓存最近一次选区并回放给晚加入者，身份字段必须随消息一起保存。
    this._sendRaw({
      type: 'selection-change',
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor,
      sheetId: pending.sheetId,
      selection: pending.selection
    });
  }

  /**
   * 拦截并广播本地单元格修改
   */
  _handleLocalCellChange(data) {
    if (this._isApplyingRemote) return data; // 屏蔽远程同步引起的回环
    if (this.readOnly) return data; // 只读协作者不产生写入消息，也不会积压离线补偿

    const row = data.row !== undefined ? data.row : data.r;
    const col = data.col !== undefined ? data.col : data.c;
    const cell = data.cell !== undefined ? data.cell : data.newValue;

    if (row === undefined || col === undefined) return data;

    // 入队 + 微任务冲刷：同一同步任务内的爆发式变更合并为一次发送，避免逐格 WS 消息。
    const sheetId = this._getActiveSheetId();
    const change = { row, col, cell };
    if (sheetId !== null) change.sheetId = sheetId;
    if (!this._isSocketOpen()) {
      this._queueOfflineCellChange(change);
      return data;
    }
    this._cellChangeQueue.push(change);
    if (!this._cellChangeFlushScheduled) {
      this._cellChangeFlushScheduled = true;
      queueMicrotask(() => this._flushCellChanges());
    }

    return data;
  }

  /**
   * 冲刷 cell-change 队列：单格走传统 cell-change（向后兼容），多格合并为单条 cell-change-batch。
   */
  _flushCellChanges() {
    this._cellChangeFlushScheduled = false;
    const queue = this._cellChangeQueue;
    if (this.readOnly) {
      this._cellChangeQueue = [];
      return;
    }
    if (queue.length === 0) return;
    this._cellChangeQueue = [];
    if (!this._isSocketOpen()) {
      for (const change of queue) this._queueOfflineCellChange(change);
      return;
    }

    if (queue.length === 1) {
      const { sheetId, row, col, cell } = queue[0];
      this._sendRaw({
        type: 'cell-change',
        roomId: this.roomId,
        userId: this.userId,
        sheetId,
        row,
        col,
        cell,
        timestamp: Date.now()
      });
    } else {
      // batch 内层固定使用标准字段 {row,col,cell}（不走 fieldNames 映射），两端同版本原样透传。
      this._sendRaw({
        type: 'cell-change-batch',
        roomId: this.roomId,
        userId: this.userId,
        cells: queue,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 判断单元格是否被他人硬锁定 (即他人正在双击或打字编辑中)
   */
  isCellEditLocked(r, c) {
    const key = this._cellStateKey(this._getActiveSheetId(), r, c);
    const info = this._lockedCells.get(key);
    return !!(info && info.userId !== this.userId);
  }

  /**
   * 判断单元格是否被他人锁定 (包括硬锁，以及检查是否只有第一个焦点的人可编辑)
   */
  isCellLocked(r, c) {
    // 1. 首先检查硬锁 (他人正在双击或输入锁定中)
    const sheetId = this._getActiveSheetId();
    const key = this._cellStateKey(sheetId, r, c);
    const info = this._lockedCells.get(key);
    if (info && info.userId !== this.userId) {
      return true;
    }

    // 2. 检查普通焦点的竞争顺序 (只允许最早将光标移到此格子上的那个人编辑)
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (collabCursor) {
      const activeCursors = collabCursor.getActiveCursors(sheetId);
      for (const item of activeCursors) {
        if (item.userId !== this.userId) { // 必须是他人的普通焦点
          const range = item.range;
          if (range) {
            let isCovered = false;
            if (
              range.startRow !== undefined &&
              range.startCol !== undefined &&
              range.endRow !== undefined &&
              range.endCol !== undefined
            ) {
              if (
                r >= range.startRow &&
                r <= range.endRow &&
                c >= range.startCol &&
                c <= range.endCol
              ) {
                isCovered = true;
              }
            }

            // 若他人的焦点同样覆盖了当前格子，且他的移入时间戳早于我们，则本地被锁定（我们是后来者）
            if (isCovered) {
              const otherFocusTime = item.focusTime || Date.now();
              const localFocusTime = this._localFocusTime || Date.now();
              if (otherFocusTime < localFocusTime) {
                return true; // 对方先到达该单元格，拦截本地编辑权
              }
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * 获取单元格锁的信息
   */
  getCellLockInfo(r, c) {
    const sheetId = this._getActiveSheetId();
    const key = this._cellStateKey(sheetId, r, c);
    const info = this._lockedCells.get(key);
    if (info) return info;

    // 如果没有硬锁，检查是否被他人焦点选中，如果是，则返回该用户的信息
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (collabCursor) {
      const activeCursors = collabCursor.getActiveCursors(sheetId);
      for (const item of activeCursors) {
        if (item.userId !== this.userId) {
          const range = item.range;
          if (range) {
            let isContained = false;
            if (
              range.startRow !== undefined &&
              range.startCol !== undefined &&
              range.endRow !== undefined &&
              range.endCol !== undefined
            ) {
              if (
                r >= range.startRow &&
                r <= range.endRow &&
                c >= range.startCol &&
                c <= range.endCol
              ) {
                isContained = true;
              }
            }
            if (range.selection) {
              const sel = range.selection;
              if (
                r >= sel.startRow &&
                r <= sel.endRow &&
                c >= sel.startCol &&
                c <= sel.endCol
              ) {
                isContained = true;
              }
            }
            if (range.activeCell) {
              const ac = range.activeCell;
              if (r === ac.r && c === ac.c) {
                isContained = true;
              }
            }

            if (isContained) {
              return {
                userId: item.userId,
                userName: (item.userInfo.name || `用户_${item.userId}`) + ' (选区占用中)'
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * 锁定本地单元格并广播
   */
  lockLocalCell(r, c) {
    if (this.readOnly) return false;
    const sheetId = this._getActiveSheetId();
    const key = this._cellStateKey(sheetId, r, c);
    const existing = this._lockedCells.get(key);
    if (existing && existing.userId !== this.userId && !this._isLockOwnerWinner(this.userId, existing.userId)) {
      return false;
    }

    this._lockedCells.set(key, {
      userId: this.userId,
      userName: this.userName,
      sheetId
    });
    this._sendRaw({
      type: 'cell-lock',
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      sheetId,
      r,
      c
    });
    if (this._workbook) {
      this._requestRender();
      this._emitLockChange();
    }
    return true;
  }

  /**
   * 解锁本地单元格并广播
   */
  unlockLocalCell(r, c) {
    const sheetId = this._getActiveSheetId();
    const key = this._cellStateKey(sheetId, r, c);
    const info = this._lockedCells.get(key);
    if (info && info.userId === this.userId) {
      this._lockedCells.delete(key);
      this._editingDrafts.delete(key);
      this._sendRaw({
        type: 'cell-unlock',
        roomId: this.roomId,
        userId: this.userId,
        sheetId,
        r,
        c
      });
      if (this._workbook) {
        this._requestRender();
        this._emitLockChange();
      }
    }
  }

  /**
   * 解析并应用远程广播的消息指令
   */
  _handleRemoteMessage(msg) {
    const collabCursor = this._registry.get('CollaborativeCursor');

    switch (msg.type) {
      case 'heartbeat-ping':
        this._sendRaw({
          type: 'heartbeat-pong',
          roomId: this.roomId,
          userId: this.userId
        });
        this._resetHeartbeatWatchdog();
        break;

      case 'user-join':
        this._logDebug(`[RealtimeCollaboration] User ${msg.userName} joined.`);
        this._roomMembers.set(msg.userId, {
          userId: msg.userId,
          userName: msg.userName || msg.userId,
          userColor: msg.userColor || '#3498db'
        });
        this._emitConnectionStatus();
        // 新成员加入后，回放自己的当前位置，避免对方连接后看不到已有协作者。
        this._broadcastSelection(this._workbook?.selection);
        break;

      case 'user-leave':
        this._logDebug(`[RealtimeCollaboration] User with ID ${msg.userId} left.`);
        this._roomMembers.delete(msg.userId);
        this._emitConnectionStatus();
        if (collabCursor) {
          collabCursor.removeRemoteCursor(msg.userId);
        }
        // 清理离开用户占有的所有编辑锁和打字草稿
        this._clearLocksForUser(msg.userId);
        if (this._workbook) {
          this._requestRender();
          this._emitLockChange();
        }
        this._checkDraftsAnimation();
        break;

      case 'room-members':
        this._setRoomMembers(msg.members);
        break;

      case 'permission-denied':
        this._setCollaborationReadOnly(true);
        if (this._workbook && typeof this._workbook.emitEvent === 'function') {
          this._workbook.emitEvent('collaboration-permission-denied', {
            messageType: msg.messageType,
            readOnly: true
          });
        }
        break;

      case 'selection-change':
        // 收到远程用户的选区变化，应用到协作光标渲染插件中进行 Canvas 高亮
        if (collabCursor && msg.selection) {
          const sheetId = this._getMessageSheetId(msg);
          collabCursor.setRemoteCursor(msg.userId, msg.selection, {
            name: msg.userName,
            color: msg.userColor,
            sheetId
          });
          // 他人选区焦点变化时，锁定状态改变，主动派发 lock-change 触发 UI 刷新！
          if (this._workbook) {
            this._emitLockChange();
          }
        }
        break;

      case 'cell-lock':
        // 收到远程加锁通知
        const lockSheetId = this._getMessageSheetId(msg);
        if (!this._canApplyRemoteSheet(lockSheetId)) return;
        const lockCoord = this._getValidRemoteCellCoord(msg, 'r', 'c', lockSheetId);
        if (!lockCoord) return;
        const lockKey = this._cellStateKey(lockSheetId, lockCoord.r, lockCoord.c);
        const existingLock = this._lockedCells.get(lockKey);
        if (existingLock && existingLock.userId !== msg.userId && !this._isLockOwnerWinner(msg.userId, existingLock.userId)) {
          return;
        }
        this._lockedCells.set(lockKey, {
          userId: msg.userId,
          userName: msg.userName,
          sheetId: lockSheetId
        });
        if (this._workbook) {
          this._requestRender();
          this._emitLockChange();
        }
        break;

      case 'cell-unlock':
        // 收到远程解锁通知
        const unlockSheetId = this._getMessageSheetId(msg);
        if (!this._canApplyRemoteSheet(unlockSheetId)) return;
        const unlockCoord = this._getValidRemoteCellCoord(msg, 'r', 'c', unlockSheetId);
        if (!unlockCoord) return;
        const unlockKey = this._cellStateKey(unlockSheetId, unlockCoord.r, unlockCoord.c);
        const existing = this._lockedCells.get(unlockKey);
        if (existing && existing.userId === msg.userId) {
          this._lockedCells.delete(unlockKey);
        }
        this._editingDrafts.delete(unlockKey);
        if (this._workbook) {
          this._requestRender();
          this._emitLockChange();
        }
        this._checkDraftsAnimation();
        break;

      case 'cell-change':
        // 收到远程单元格修改，应用到本地 Workbook 实例中
        {
          this._recordSyncSequence(msg);
          const sheetId = this._getMessageSheetId(msg);
          if (!this._canApplyRemoteSheet(sheetId)) break;
          if (sheetId !== null && sheetId !== this._getActiveSheetId()) {
            const { row, col } = msg;
            if (
              Number.isInteger(row) && Number.isInteger(col) &&
              this._shouldApplyCellVersion(sheetId, row, col, this._getCellSequence(msg, msg))
            ) {
              this._queueRemoteCellChange(sheetId, msg);
            }
            break;
          }

          this._isApplyingRemote = true;
          try {
            const { row, col, cell } = msg;
            // 边界与防御性校验：拒绝非法行列值，防止越界 DoS 攻击
            if (!Number.isInteger(row) || !Number.isInteger(col) ||
                row < 0 || col < 0 ||
                row >= this._workbook.rowCount || col >= this._workbook.colCount) {
              return;
            }
            if (!this._shouldApplyCellVersion(sheetId, row, col, this._getCellSequence(msg, msg))) return;
            this._workbook.setCell(row, col, cell, null, { skipEvent: true, skipHistory: true });
            // 应用最终修改后，清理对应的草稿
            this._editingDrafts.delete(this._cellStateKey(sheetId, row, col));
            this._requestRender();
          } finally {
            this._isApplyingRemote = false;
          }
        }
        this._checkDraftsAnimation();
        break;

      case 'cell-change-batch':
        // 收到远程批量单元格修改，一次性应用后只渲染一次
        this._recordSyncSequence(msg);
        if (this._workbook && Array.isArray(msg.cells)) {
          const batchSheetId = this._getMessageSheetId(msg);
          if (!this._canApplyRemoteSheet(batchSheetId)) break;
          this._isApplyingRemote = true;
          try {
            const maxRow = this._workbook.rowCount;
            const maxCol = this._workbook.colCount;
            for (const item of msg.cells) {
              const sheetId = item.sheetId ?? batchSheetId;
              if (!this._canApplyRemoteSheet(sheetId)) continue;
              if (sheetId !== null && sheetId !== this._getActiveSheetId()) {
                const { row, col } = item;
                if (
                  Number.isInteger(row) && Number.isInteger(col) &&
                  this._shouldApplyCellVersion(sheetId, row, col, this._getCellSequence(item, msg))
                ) {
                  this._queueRemoteCellChange(sheetId, item);
                }
                continue;
              }

              const { row, col, cell } = item;
              if (row === undefined || col === undefined) continue;
              // 边界与防御性校验：拒绝非法行列值，防止越界 DoS 攻击
              if (!Number.isInteger(row) || !Number.isInteger(col) ||
                  row < 0 || col < 0 ||
                  row >= maxRow || col >= maxCol) {
                continue;
              }
              if (!this._shouldApplyCellVersion(sheetId, row, col, this._getCellSequence(item, msg))) {
                continue;
              }
              this._workbook.setCell(row, col, cell, null, { skipEvent: true, skipHistory: true });
              this._editingDrafts.delete(this._cellStateKey(sheetId, row, col));
            }
            this._requestRender();
          } finally {
            this._isApplyingRemote = false;
          }
        }
        this._checkDraftsAnimation();
        break;

      case 'cell-editing':
        // 收到远程用户的打字草稿
        const editSheetId = this._getMessageSheetId(msg);
        if (!this._canApplyRemoteSheet(editSheetId)) return;
        const editCoord = this._getValidRemoteCellCoord(msg, 'r', 'c', editSheetId);
        if (!editCoord) return;
        const editKey = this._cellStateKey(editSheetId, editCoord.r, editCoord.c);
        if (msg.val === '' || msg.val === undefined || msg.val === null) {
          this._editingDrafts.delete(editKey);
        } else {
          this._editingDrafts.set(editKey, {
            userId: msg.userId,
            userName: msg.userName,
            sheetId: editSheetId,
            value: msg.val
          });
        }
        this._requestRender();
        this._checkDraftsAnimation();
        break;

      case 'chat-message':
        this._logDebug(`[RealtimeCollaboration] Chat [${msg.userName}]: ${msg.text}`);
        break;

      case 'sync-ack':
        this._recordSyncSequence(msg);
        this._recordAckCellVersions(msg);
        break;

      case 'sync-ready':
        this._recordSyncSequence(msg);
        this._hasSyncedConnection = true;
        this._waitingForSnapshotBeforeOfflineFlush = false;
        this._flushOfflineCellChanges();
        break;

      case 'sync-reset':
        this._lastSyncSequence = 0;
        this._cellVersions.clear();
        this._hasSyncedConnection = true;
        if (this._offlineCellChangeQueue.length > 0) {
          this._waitingForSnapshotBeforeOfflineFlush = true;
        }
        break;

      case 'state-request':
        if (!msg.targetUserId || !this._workbook || typeof this._workbook.toJSON !== 'function') break;
        this._sendRaw({
          type: 'state-snapshot',
          roomId: this.roomId,
          userId: this.userId,
          targetUserId: msg.targetUserId,
          snapshot: this._workbook.toJSON()
        });
        break;

      case 'state-snapshot':
        if (
          msg.targetUserId !== this.userId ||
          !msg.snapshot ||
          !this._workbook ||
          typeof this._workbook.fromJSON !== 'function'
        ) break;

        this._isApplyingRemote = true;
        try {
          this._workbook.fromJSON(msg.snapshot);
          this._pendingRemoteCellChanges = [];
          this._pendingRemoteCommentChanges = [];
          this._cellVersions.clear();
          this._requestRender();
        } finally {
          this._isApplyingRemote = false;
        }

        this._lastSelectionKey = null;
        this._broadcastSelection(this._workbook.selection);
        this._hasSyncedConnection = true;
        if (this._waitingForSnapshotBeforeOfflineFlush) {
          this._waitingForSnapshotBeforeOfflineFlush = false;
          this._flushOfflineCellChanges();
        }
        break;

      case 'comment-change':
        {
          const sheetId = this._getMessageSheetId(msg);
          if (!this._canApplyRemoteSheet(sheetId) || !msg.comment || !this._workbook) break;
          if (sheetId !== null && sheetId !== this._getActiveSheetId()) {
            this._queueRemoteCommentChange(sheetId, msg);
            break;
          }

          if (msg.action === 'remove' && typeof this._workbook.removeComment === 'function') {
            this._workbook.removeComment(msg.comment.id, { remote: true });
          } else if (typeof this._workbook.upsertComment === 'function') {
            this._workbook.upsertComment(msg.comment);
          }
        }
        break;

      default:
        break;
    }
  }

  _isLockOwnerWinner(candidateUserId, currentUserId) {
    const candidate = String(candidateUserId ?? '');
    const current = String(currentUserId ?? '');
    if (!current) return true;
    if (!candidate) return false;
    return candidate < current;
  }

  _clearLocksForUser(userId) {
    let changed = false;
    for (const [key, value] of this._lockedCells.entries()) {
      if (value.userId === userId) {
        this._lockedCells.delete(key);
        changed = true;
      }
    }
    for (const [key, value] of this._editingDrafts.entries()) {
      if (value.userId === userId) {
        this._editingDrafts.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  _getValidRemoteCellCoord(msg, rowField = 'row', colField = 'col', sheetId = null) {
    if (!this._workbook) return null;
    const r = Number(msg?.[rowField]);
    const c = Number(msg?.[colField]);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) {
      return null;
    }
    const activeSheetId = this._getActiveSheetId();
    if (sheetId !== null && sheetId !== activeSheetId) return { r, c };
    if (r >= this._workbook.rowCount || c >= this._workbook.colCount) {
      return null;
    }
    return { r, c };
  }

  /**
   * 广播群聊消息（扩展功能）
   */
  sendChatMessage(text) {
    if (!text) return;
    this._sendRaw({
      type: 'chat-message',
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      text
    });
  }

  broadcastComment(comment, action = 'update') {
    if (!comment) return;
    if (this.readOnly) return;
    this._sendRaw({
      type: 'comment-change',
      roomId: this.roomId,
      userId: this.userId,
      sheetId: this._getActiveSheetId(),
      userName: this.userName,
      userColor: this.userColor,
      action,
      comment
    });
  }

  _requestRender() {
    if (this._workbook && typeof this._workbook.requestRender === 'function') {
      this._workbook.requestRender();
    }
  }

  _checkDraftsAnimation() {
    if (this._editingDrafts.size > 0) {
      if (!this._draftsAnimTimer) {
        this._draftsAnimTimer = setInterval(() => {
          this._requestRender();
        }, 500);
      }
    } else {
      if (this._draftsAnimTimer) {
        clearInterval(this._draftsAnimTimer);
        this._draftsAnimTimer = null;
      }
    }
  }

  _emitLockChange() {
    if (this._workbook && typeof this._workbook.emitEvent === 'function') {
      this._workbook.emitEvent('lock-change');
    }
  }

  /**
   * 广播当前单元格的输入草稿
   */
  broadcastEditing(r, c, val) {
    if (this.readOnly) return;
    this._sendRaw({
      type: 'cell-editing',
      roomId: this.roomId,
      userId: this.userId,
      sheetId: this._getActiveSheetId(),
      userName: this.userName,
      r,
      c,
      val
    });
  }

  /**
   * 获取他人正在输入单元格的临时草稿
   */
  getEditingDraft(r, c) {
    const key = this._cellStateKey(this._getActiveSheetId(), r, c);
    return this._editingDrafts.get(key) || null;
  }
}

export function createRealtimeCollaborationPlugin(options = {}) {
  return new RealtimeCollaborationPlugin(options);
}
