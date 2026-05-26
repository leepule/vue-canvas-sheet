/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @typedef {Object} HistoryCommand - 历史命令
 * @property {string} type - 命令类型
 * @property {number} [r] - 行索引
 * @property {number} [c] - 列索引
 * @property {*} [oldValue] - 旧值
 * @property {*} [newValue] - 新值
 * @property {Array} [changes] - 批量变更
 * @property {Array} [cmds] - 子命令列表
 */

import { HistoryOptimizer } from './HistoryOptimizer.js';
import { RingBuffer } from '../utils/Queues.js';


const DEFAULT_MAX_DEPTH = 100;

/**
 * 历史记录管理器
 * 支持撤销/重做、操作合并、批量操作
 */
export class HistoryManager {
  /**
   * 创建历史管理器
   * @param {import('./Workbook').Workbook} workbook - 工作簿实例
   */
  constructor(workbook) {
    this.workbook = workbook;
    this._maxDepth = DEFAULT_MAX_DEPTH;
    // 容量自动淘汰：push 超出 maxDepth 时自动丢弃最旧条目（替代旧的 shift）
    this.undoStack = new RingBuffer(this._maxDepth);
    this.redoStack = new RingBuffer(this._maxDepth);
    this.batching = false;
    this.batchCmds = [];
    
    // 操作合并配置
    this.mergeWindow = 500; // 500ms 内的操作可合并
    this.lastOpTime = 0;
    this.lastOpType = null;
    this.lastOpCell = null;
    
    // 启用优化器
    this.optimizer = new HistoryOptimizer(this);
  }

  /**
   * 执行命令并记录到历史
   * @param {HistoryCommand} cmd - 命令对象
   */
  execute(cmd) {
    if (this.batching) {
      this.batchCmds.push(cmd);
      return;
    }

    const now = Date.now();
    
    // 尝试合并操作
    if (this._tryMerge(cmd, now)) {
      return;
    }

    // 记录本次操作信息
    this._recordOpInfo(cmd, now);

    // RingBuffer 已自带容量上限淘汰，不需要手动 shift
    this.undoStack.push(cmd);
    this.redoStack.clear();
    
    // 执行完命令后尝试智能压缩
    this.optimizer.compressHistory();
  }

  /**
   * 尝试合并操作
   * @param {HistoryCommand} cmd - 新命令
   * @param {number} now - 当前时间戳
   * @returns {boolean} 是否成功合并
   * @private
   */
  _tryMerge(cmd, now) {
    // 检查是否可以合并
    if (now - this.lastOpTime > this.mergeWindow) {
      return false;
    }

    // 只合并同一单元格的 set-cell 操作
    if (cmd.type !== 'set-cell') {
      return false;
    }

    const lastCmd = this.undoStack.last();
    if (!lastCmd || lastCmd.type !== 'set-cell') {
      return false;
    }

    // 检查是否同一单元格
    if (lastCmd.r !== cmd.r || lastCmd.c !== cmd.c) {
      return false;
    }

    // 合并：只保留最新的 newValue，保留最早的 oldValue
    lastCmd.newValue = cmd.newValue;
    this.lastOpTime = now;
    return true;
  }

  /**
   * 记录操作信息用于后续合并判断
   * @param {HistoryCommand} cmd - 命令对象
   * @param {number} now - 当前时间戳
   * @private
   */
  _recordOpInfo(cmd, now) {
    this.lastOpTime = now;
    this.lastOpType = cmd.type;
    if (cmd.type === 'set-cell') {
      this.lastOpCell = { r: cmd.r, c: cmd.c };
    } else {
      this.lastOpCell = null;
    }
  }

  /**
   * 开始批量操作
   */
  startBatch() {
    this.batching = true;
    this.batchCmds = [];
    // 批量操作期间禁用合并
    this.lastOpTime = 0;
  }

  /**
   * 结束批量操作
   */
  endBatch() {
    this.batching = false;
    if (this.batchCmds.length > 0) {
      const batchCmd = {
        type: 'batch',
        cmds: this.batchCmds
      };
      this.execute(batchCmd);
      this.batchCmds = [];
    }
  }

  /**
   * 撤销上一步操作
   */
  undo() {
    if (this.undoStack.length === 0) return;
    const cmd = this.undoStack.pop();
    this.redoStack.push(cmd);
    this.workbook.applyCommand(cmd, true);
    
    // 重置合并状态
    this.lastOpTime = 0;
  }

  /**
   * 重做下一步操作
   */
  redo() {
    if (this.redoStack.length === 0) return;
    const cmd = this.redoStack.pop();
    this.undoStack.push(cmd);
    this.workbook.applyCommand(cmd, false);
    
    // 更新合并状态
    this._recordOpInfo(cmd, Date.now());
  }

  /**
   * 清空历史记录
   */
  clear() {
    this.undoStack.clear();
    this.redoStack.clear();
    this.lastOpTime = 0;
    this.lastOpType = null;
    this.lastOpCell = null;
  }

  /**
   * 检查是否可撤销
   * @returns {boolean}
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * 检查是否可重做
   * @returns {boolean}
   */
  canRedo() {
    return this.redoStack.length > 0;
  }

  get maxDepth() {
    return this._maxDepth;
  }

  set maxDepth(value) {
    if (!Number.isInteger(value) || value <= 0) return;
    if (this._maxDepth === value) return;
    this._maxDepth = value;
    this.undoStack.resize(value);
    this.redoStack.resize(value);
  }

  /**
   * 获取撤销栈大小
   * @returns {number}
   */
  get undoStackSize() {
    return this.undoStack.length;
  }

  /**
   * 获取重做栈大小
   * @returns {number}
   */
  get redoStackSize() {
    return this.redoStack.length;
  }
}
