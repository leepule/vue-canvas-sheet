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
    this.serverUrl = options.serverUrl || null;
    this.roomId = options.roomId || 'default-room';
    this.userId = options.userId || 'user_' + Math.random().toString(36).substring(2, 7);
    this.userName = options.userName || `用户_${this.userId}`;
    this.userColor = options.userColor || '#3498db';
    this.autoConnect = options.autoConnect !== false;

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
      text: fieldNames.text || 'text'
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
    this._lockedCells = new Map(); // key: r,c -> { userId, userName }
    this._editingDrafts = new Map(); // key: r,c -> { userId, userName, value }
    this._localFocusTime = Date.now();
    this._lastSelectionKey = null; // 缓存上一次的选区，避免原地重复点击或双击时重置聚焦时间
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;

    // 注册全局共享状态与控制 API 供外部 UI 调用
    registry.setSharedState('collaboration:connect', (url) => this.connect(url));
    registry.setSharedState('collaboration:disconnect', () => this.disconnect());
    registry.setSharedState('collaboration:sendChat', (msg) => this.sendChatMessage(msg));
    registry.setSharedState('collaboration:getStatus', () => this.getConnectionStatus());
    registry.setSharedState('collaboration:isCellLocked', (r, c) => this.isCellLocked(r, c));
    registry.setSharedState('collaboration:isCellEditLocked', (r, c) => this.isCellEditLocked(r, c));
    registry.setSharedState('collaboration:getCellLockInfo', (r, c) => this.getCellLockInfo(r, c));
    registry.setSharedState('collaboration:lockCell', (r, c) => this.lockLocalCell(r, c));
    registry.setSharedState('collaboration:unlockCell', (r, c) => this.unlockLocalCell(r, c));
    registry.setSharedState('collaboration:broadcastEditing', (r, c, val) => this.broadcastEditing(r, c, val));
    registry.setSharedState('collaboration:getEditingDraft', (r, c) => this.getEditingDraft(r, c));
    registry.setSharedState('collaboration:getLocalFocusTime', () => this._localFocusTime);
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

    // 3. 自动连接
    if (this.autoConnect && this.serverUrl) {
      this.connect();
    }
  }

  onUnmount() {
    this.disconnect();
    this._lastSelectionKey = null;
    
    if (this._unsubSelection) {
      this._unsubSelection();
      this._unsubSelection = null;
    }
    if (this._unsubCell) {
      this._unsubCell();
      this._unsubCell = null;
    }
    if (this._registry) {
      this._registry.deleteSharedState('collaboration:connect');
      this._registry.deleteSharedState('collaboration:disconnect');
      this._registry.deleteSharedState('collaboration:sendChat');
      this._registry.deleteSharedState('collaboration:getStatus');
      this._registry.deleteSharedState('collaboration:isCellLocked');
      this._registry.deleteSharedState('collaboration:isCellEditLocked');
      this._registry.deleteSharedState('collaboration:getCellLockInfo');
      this._registry.deleteSharedState('collaboration:lockCell');
      this._registry.deleteSharedState('collaboration:unlockCell');
      this._registry.deleteSharedState('collaboration:broadcastEditing');
      this._registry.deleteSharedState('collaboration:getEditingDraft');
      this._registry.deleteSharedState('collaboration:getLocalFocusTime');
    }
    if (this._draftsAnimTimer) {
      clearInterval(this._draftsAnimTimer);
      this._draftsAnimTimer = null;
    }
    this._editingDrafts.clear();
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
    console.log(`[RealtimeCollaboration] Connecting to ${this.serverUrl} [Room: ${this.roomId}]`);

    try {
      this._socket = new WebSocket(this.serverUrl);
      this._setupSocketListeners();
    } catch (error) {
      console.error('[RealtimeCollaboration] WebSocket connection failed:', error);
      this._handleReconnect();
    }
  }

  /**
   * 断开连接并回收定时器
   */
  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
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
    // 移除协作画板上的协同光标高亮
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (collabCursor) {
      collabCursor._cursors.clear();
      collabCursor._updateSharedState();
      this._requestRender();
    }
  }

  getConnectionStatus() {
    if (!this._socket) return 'DISCONNECTED';
    switch (this._socket.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'CONNECTED';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  _setupSocketListeners() {
    this._socket.onopen = () => {
      console.log('[RealtimeCollaboration] WebSocket connection established successfully.');
      this._reconnectAttempts = 0;
      
      // 广播加入房间消息，同步当前用户信息
      this._sendRaw({
        type: 'user-join',
        roomId: this.roomId,
        userId: this.userId,
        userName: this.userName,
        userColor: this.userColor
      });
    };

    this._socket.onmessage = (event) => {
      try {
        const dataStr = typeof event.data === 'string' ? event.data.trim() : '';
        
        // 寻找第一个 JSON 起始符，高能剥离由于测试服务端回显前缀（如 <b>从服务端返回你发的消息：</b>）包装的 HTML 壳子
        const firstBrace = dataStr.indexOf('{');
        const firstBracket = dataStr.indexOf('[');
        let startIndex = -1;
        if (firstBrace !== -1 && firstBracket !== -1) {
          startIndex = Math.min(firstBrace, firstBracket);
        } else {
          startIndex = firstBrace !== -1 ? firstBrace : firstBracket;
        }

        if (startIndex === -1) {
          console.log('[RealtimeCollaboration] Server feedback message:', event.data);
          return;
        }

        // 剥离 HTML 前缀，提取核心 JSON 部分
        const jsonPart = dataStr.substring(startIndex);
        
        let networkMessage;
        try {
          networkMessage = JSON.parse(jsonPart);
        } catch (parseErr) {
          // 如果截取出的部分不能解析为 JSON，则视为普通文本消息处理
          console.log('[RealtimeCollaboration] Server raw feedback:', event.data);
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
      this._socket = null;
      this._handleReconnect();
    };
  }

  _handleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error('[RealtimeCollaboration] Max reconnection attempts reached. Giving up.');
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 10000); // 指数退避重连算法
    console.log(`[RealtimeCollaboration] Reconnecting in ${delay}ms (Attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
    
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
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

  /**
   * 广播本地用户的选区光标
   */
  _broadcastSelection(selection) {
    if (!selection) return;
    this._sendRaw({
      type: 'selection-change',
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor,
      selection
    });
  }

  /**
   * 拦截并广播本地单元格修改
   */
  _handleLocalCellChange(data) {
    if (this._isApplyingRemote) return data; // 屏蔽远程同步引起的回环

    const row = data.row !== undefined ? data.row : data.r;
    const col = data.col !== undefined ? data.col : data.c;
    const cell = data.cell !== undefined ? data.cell : data.newValue;

    if (row === undefined || col === undefined) return data;

    this._sendRaw({
      type: 'cell-change',
      roomId: this.roomId,
      userId: this.userId,
      row,
      col,
      cell,
      timestamp: Date.now()
    });

    return data;
  }

  /**
   * 判断单元格是否被他人硬锁定 (即他人正在双击或打字编辑中)
   */
  isCellEditLocked(r, c) {
    const key = `${r},${c}`;
    const info = this._lockedCells.get(key);
    return !!(info && info.userId !== this.userId);
  }

  /**
   * 判断单元格是否被他人锁定 (包括硬锁，以及检查是否只有第一个焦点的人可编辑)
   */
  isCellLocked(r, c) {
    // 1. 首先检查硬锁 (他人正在双击或输入锁定中)
    const key = `${r},${c}`;
    const info = this._lockedCells.get(key);
    if (info && info.userId !== this.userId) {
      return true;
    }

    // 2. 检查普通焦点的竞争顺序 (只允许最早将光标移到此格子上的那个人编辑)
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (collabCursor) {
      const activeCursors = collabCursor.getActiveCursors();
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
    const key = `${r},${c}`;
    const info = this._lockedCells.get(key);
    if (info) return info;

    // 如果没有硬锁，检查是否被他人焦点选中，如果是，则返回该用户的信息
    const collabCursor = this._registry ? this._registry.get('CollaborativeCursor') : null;
    if (collabCursor) {
      const activeCursors = collabCursor.getActiveCursors();
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
    const key = `${r},${c}`;
    this._lockedCells.set(key, { userId: this.userId, userName: this.userName });
    this._sendRaw({
      type: 'cell-lock',
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      r,
      c
    });
    if (this._workbook) {
      this._requestRender();
      this._emitLockChange();
    }
  }

  /**
   * 解锁本地单元格并广播
   */
  unlockLocalCell(r, c) {
    const key = `${r},${c}`;
    const info = this._lockedCells.get(key);
    if (info && info.userId === this.userId) {
      this._lockedCells.delete(key);
      this._editingDrafts.delete(key);
      this._sendRaw({
        type: 'cell-unlock',
        roomId: this.roomId,
        userId: this.userId,
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
      case 'user-join':
        console.log(`[RealtimeCollaboration] User ${msg.userName} joined.`);
        break;

      case 'user-leave':
        console.log(`[RealtimeCollaboration] User with ID ${msg.userId} left.`);
        if (collabCursor) {
          collabCursor.removeRemoteCursor(msg.userId);
        }
        // 清理离开用户占有的所有编辑锁和打字草稿
        let changed = false;
        for (const [key, value] of this._lockedCells.entries()) {
          if (value.userId === msg.userId) {
            this._lockedCells.delete(key);
            changed = true;
          }
        }
        for (const [key, value] of this._editingDrafts.entries()) {
          if (value.userId === msg.userId) {
            this._editingDrafts.delete(key);
          }
        }
        if (this._workbook) {
          this._requestRender();
          this._emitLockChange();
        }
        this._checkDraftsAnimation();
        break;

      case 'selection-change':
        // 收到远程用户的选区变化，应用到协作光标渲染插件中进行 Canvas 高亮
        if (collabCursor && msg.selection) {
          collabCursor.setRemoteCursor(msg.userId, msg.selection, {
            name: msg.userName,
            color: msg.userColor
          });
          // 他人选区焦点变化时，锁定状态改变，主动派发 lock-change 触发 UI 刷新！
          if (this._workbook) {
            this._emitLockChange();
          }
        }
        break;

      case 'cell-lock':
        // 收到远程加锁通知
        const lockKey = `${msg.r},${msg.c}`;
        this._lockedCells.set(lockKey, { userId: msg.userId, userName: msg.userName });
        if (this._workbook) {
          this._requestRender();
          this._emitLockChange();
        }
        break;

      case 'cell-unlock':
        // 收到远程解锁通知
        const unlockKey = `${msg.r},${msg.c}`;
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
        if (this._workbook) {
          this._isApplyingRemote = true;
          try {
            const { row, col, cell } = msg;
            this._workbook.setCell(row, col, cell, { skipEvent: true });
            // 应用最终修改后，清理对应的草稿
            this._editingDrafts.delete(`${row},${col}`);
            this._requestRender();
          } finally {
            this._isApplyingRemote = false;
          }
        }
        this._checkDraftsAnimation();
        break;

      case 'cell-editing':
        // 收到远程用户的打字草稿
        const editKey = `${msg.r},${msg.c}`;
        if (msg.val === '' || msg.val === undefined || msg.val === null) {
          this._editingDrafts.delete(editKey);
        } else {
          this._editingDrafts.set(editKey, {
            userId: msg.userId,
            userName: msg.userName,
            value: msg.val
          });
        }
        this._requestRender();
        this._checkDraftsAnimation();
        break;

      case 'chat-message':
        console.log(`[RealtimeCollaboration] Chat [${msg.userName}]: ${msg.text}`);
        break;

      default:
        break;
    }
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
    if (this._workbook && typeof this._workbook._emit === 'function') {
      this._workbook._emit('lock-change');
    }
  }

  /**
   * 广播当前单元格的输入草稿
   */
  broadcastEditing(r, c, val) {
    this._sendRaw({
      type: 'cell-editing',
      roomId: this.roomId,
      userId: this.userId,
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
    const key = `${r},${c}`;
    return this._editingDrafts.get(key) || null;
  }
}

export function createRealtimeCollaborationPlugin(options = {}) {
  return new RealtimeCollaborationPlugin(options);
}
