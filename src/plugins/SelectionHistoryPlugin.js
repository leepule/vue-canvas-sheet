/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { HookTypes } from '../core/plugin/PluginRegistry.js';

/**
 * 选区历史管理器插件
 * 自动记录用户的历史选区，并支持在最近的历史选区中“后退”或“前进”
 */
export class SelectionHistoryPlugin {
  name = 'SelectionHistory';
  version = '1.0.0';
  description = '选区历史管理器，记录并允许用户在最近的选区历史中前进或后退';
  dependencies = [];

  constructor(options = {}) {
    this.maxSize = options.maxSize || 50; // 历史最大容量
    this._undoStack = [];
    this._redoStack = [];
    this._currentSelection = null;
    this._workbook = null;
    this._registry = null;
    this._isNavigating = false; // 导航标记，防止循环触发
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
    
    // 注册全局共享 API 接口供外部/UI 直接调用
    registry.setSharedState('selectionHistory:goBack', () => this.goBack());
    registry.setSharedState('selectionHistory:goForward', () => this.goForward());
    registry.setSharedState('selectionHistory:canGoBack', () => this.canGoBack());
    registry.setSharedState('selectionHistory:canGoForward', () => this.canGoForward());
    registry.setSharedState('selectionHistory:clear', () => this.clearHistory());
  }

  onMounted(workbook, registry) {
    if (workbook.on) {
      // 监听选区变化事件
      this._unsub = workbook.on('selection-change', (selection) => {
        this._handleSelectionChange(selection);
      });
    }
  }

  onUnmount() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    if (this._registry) {
      this._registry.deleteSharedState('selectionHistory:goBack');
      this._registry.deleteSharedState('selectionHistory:goForward');
      this._registry.deleteSharedState('selectionHistory:canGoBack');
      this._registry.deleteSharedState('selectionHistory:canGoForward');
      this._registry.deleteSharedState('selectionHistory:clear');
    }
    this._undoStack = [];
    this._redoStack = [];
    this._currentSelection = null;
  }

  _handleSelectionChange(selection) {
    if (this._isNavigating) return;
    if (!selection) return;

    // 格式化当前选区，判断是否与前一个选区相同（避免高频相同事件积压）
    const selectionKey = JSON.stringify(selection);
    if (this._currentSelection && JSON.stringify(this._currentSelection) === selectionKey) {
      return;
    }

    if (this._currentSelection) {
      this._undoStack.push(this._currentSelection);
      if (this._undoStack.length > this.maxSize) {
        this._undoStack.shift();
      }
    }

    this._currentSelection = JSON.parse(selectionKey);
    this._redoStack = []; // 每次新选区动作都会清空 redo 栈
  }

  goBack() {
    if (!this.canGoBack()) return false;

    this._isNavigating = true;
    try {
      const prev = this._undoStack.pop();
      if (this._currentSelection) {
        this._redoStack.push(this._currentSelection);
      }
      this._currentSelection = prev;
      
      // 应用历史选区到 workbook 实例
      if (this._workbook && typeof this._workbook.setSelection === 'function') {
        this._workbook.setSelection(prev);
      }
      return true;
    } finally {
      this._isNavigating = false;
    }
  }

  goForward() {
    if (!this.canGoForward()) return false;

    this._isNavigating = true;
    try {
      const next = this._redoStack.pop();
      if (this._currentSelection) {
        this._undoStack.push(this._currentSelection);
      }
      this._currentSelection = next;

      // 应用历史选区到 workbook 实例
      if (this._workbook && typeof this._workbook.setSelection === 'function') {
        this._workbook.setSelection(next);
      }
      return true;
    } finally {
      this._isNavigating = false;
    }
  }

  canGoBack() {
    return this._undoStack.length > 0;
  }

  canGoForward() {
    return this._redoStack.length > 0;
  }

  clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._currentSelection = null;
  }
}

export function createSelectionHistoryPlugin(options = {}) {
  return new SelectionHistoryPlugin(options);
}
