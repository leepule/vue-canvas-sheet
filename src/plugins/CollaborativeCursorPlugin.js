/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 协同光标管理器插件
 * 维护多人在协同编辑状态下的光标选区，提供过期的定时清理及状态同步
 */
export class CollaborativeCursorPlugin {
  name = 'CollaborativeCursor';
  version = '1.0.0';
  description = '多用户协同光标管理器，用于高亮模拟和渲染其他协同用户的光标区域';
  dependencies = [];

  constructor(options = {}) {
    this.expireTime = options.expireTime || 15000; // 自动过期时间（毫秒），默认 15s
    this._cursors = new Map(); // userId -> { range, userInfo, lastActive }
    this._workbook = null;
    this._registry = null;
    this._cleanupTimer = null;
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
    
    // 注册全局共享 API 接口供外部/UI 直接调用
    registry.setSharedState('collaborative:setCursor', (userId, range, userInfo) => this.setRemoteCursor(userId, range, userInfo));
    registry.setSharedState('collaborative:removeCursor', (userId) => this.removeRemoteCursor(userId));
    registry.setSharedState('collaborative:getCursors', () => this.getActiveCursors());
  }

  onMounted(workbook, registry) {
    // 启动定时清理过期用户的机制，每 5 秒轮询检测一次
    this._cleanupTimer = setInterval(() => {
      this._cleanupExpiredCursors();
    }, 5000);
  }

  onUnmount() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._registry) {
      this._registry.deleteSharedState('collaborative:setCursor');
      this._registry.deleteSharedState('collaborative:removeCursor');
      this._registry.deleteSharedState('collaborative:getCursors');
      this._registry.deleteSharedState('collaborative:active-cursors');
    }
    this._cursors.clear();
  }

  /**
   * 标准化选区 Range 数据结构，高度兼容复合结构与旧扁平结构
   * @private
   */
  _normalizeRange(range) {
    let startRow = 0, startCol = 0, endRow = 0, endCol = 0;
    
    // 1. 如果包含 selection 内部属性 { s: { r, c }, e: { r, c } }
    if (range.selection && range.selection.s && range.selection.e) {
      startRow = range.selection.s.r;
      startCol = range.selection.s.c;
      endRow = range.selection.e.r;
      endCol = range.selection.e.c;
    } 
    // 2. 如果直接是 { s: { r, c }, e: { r, c } }
    else if (range.s && range.e && range.s.r !== undefined) {
      startRow = range.s.r;
      startCol = range.s.c;
      endRow = range.e.r;
      endCol = range.e.c;
    } 
    // 3. 如果是标准的 { startRow, startCol, endRow, endCol }
    else if (range.startRow !== undefined && range.startCol !== undefined) {
      startRow = range.startRow;
      startCol = range.startCol;
      endRow = range.endRow !== undefined ? range.endRow : range.startRow;
      endCol = range.endCol !== undefined ? range.endCol : range.startCol;
    } 
    // 4. 兜底如果有 activeCell
    else if (range.activeCell && range.activeCell.r !== undefined) {
      startRow = endRow = range.activeCell.r;
      startCol = endCol = range.activeCell.c;
    }

    return { startRow, startCol, endRow, endCol };
  }

  /**
   * 注册或更新远程协同用户的光标区域
   * @param {string|number} userId 用户唯一标识
   * @param {Object} range 选区范围 { startRow, startCol, endRow, endCol }
   * @param {Object} userInfo 用户个人信息，如 { name: '张三', color: '#3498DB' }
   */
  setRemoteCursor(userId, range, userInfo = {}) {
    if (!userId || !range) return;

    const normalizedRange = this._normalizeRange(range);

    // 💡 焦点防冲突：若选区范围变了，重新记录其刚移入该格子的聚焦时间戳
    const existing = this._cursors.get(userId);
    let focusTime = existing ? existing.focusTime : Date.now();
    if (!existing || 
        existing.range.startRow !== normalizedRange.startRow || 
        existing.range.startCol !== normalizedRange.startCol ||
        existing.range.endRow !== normalizedRange.endRow ||
        existing.range.endCol !== normalizedRange.endCol) {
      focusTime = Date.now();
    }

    // 默认内置的彩虹协同颜色调色盘
    const defaultColors = ['#E74C3C', '#2ECC71', '#3498DB', '#F1C40F', '#9B59B6', '#1ABC9C', '#E67E22'];
    const color = userInfo.color || defaultColors[Math.abs(String(userId).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % defaultColors.length];

    this._cursors.set(userId, {
      range: normalizedRange,
      userInfo: {
        name: userInfo.name || `用户_${userId}`,
        color,
        ...userInfo
      },
      focusTime,
      lastActive: Date.now()
    });

    this._updateSharedState();
    
    // 触发 Canvas 视图重绘以刷新协同高亮状态
    if (this._workbook && typeof this._workbook.requestRender === 'function') {
      this._workbook.requestRender();
    }
  }

  /**
   * 移除特定用户的协同光标
   * @param {string|number} userId 用户唯一标识
   */
  removeRemoteCursor(userId) {
    if (this._cursors.delete(userId)) {
      this._updateSharedState();
      if (this._workbook && typeof this._workbook.requestRender === 'function') {
        this._workbook.requestRender();
      }
    }
  }

  /**
   * 获取所有未过期的活跃协同光标
   * @returns {Array<Object>}
   */
  getActiveCursors() {
    const now = Date.now();
    const active = [];
    this._cursors.forEach((data, userId) => {
      if (now - data.lastActive < this.expireTime) {
        active.push({
          userId,
          range: data.range,
          userInfo: data.userInfo,
          focusTime: data.focusTime || data.lastActive
        });
      }
    });
    return active;
  }

  _cleanupExpiredCursors() {
    const now = Date.now();
    let changed = false;
    this._cursors.forEach((data, userId) => {
      if (now - data.lastActive >= this.expireTime) {
        this._cursors.delete(userId);
        changed = true;
      }
    });

    if (changed) {
      this._updateSharedState();
      if (this._workbook && typeof this._workbook.requestRender === 'function') {
        this._workbook.requestRender();
      }
    }
  }

  _updateSharedState() {
    if (this._registry) {
      this._registry.setSharedState('collaborative:active-cursors', this.getActiveCursors());
    }
  }
}

export function createCollaborativeCursorPlugin(options = {}) {
  return new CollaborativeCursorPlugin(options);
}
