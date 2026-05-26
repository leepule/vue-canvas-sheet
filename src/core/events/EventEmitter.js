/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 事件类型常量
 * @readonly
 * @enum {string}
 */
export const Events = {
  /** 单元格内容变化 */
  CELL_CHANGE: 'cell-change',
  /** 选区变化 */
  SELECTION_CHANGE: 'selection-change',
  /** 数据加载完成 */
  DATA_LOAD: 'data-load',
  /** 行列结构变化 */
  STRUCTURE_CHANGE: 'structure-change',
  /** 样式变化 */
  STYLE_CHANGE: 'style-change',
  /** 合并单元格变化 */
  MERGE_CHANGE: 'merge-change',
  /** 冻结窗格变化 */
  FREEZE_CHANGE: 'freeze-change',
  /** 撤销/重做 */
  HISTORY_CHANGE: 'history-change',
  /** 公式计算完成 */
  FORMULAS_CALCULATED: 'formulas-calculated',
  /** 错误事件 */
  ERROR: 'error',
  /** 保存状态变化 */
  SAVE_STATUS: 'save-status',
  /** 通用更新（兼容旧版） */
  CHANGE: 'change'
};

/**
 * 事件数据接口
 * @typedef {Object} EventPayload
 * @property {string} type - 事件类型
 * @property {*} [data] - 事件相关数据
 * @property {Object} [source] - 事件来源
 */

/**
 * 事件监听器函数
 * @typedef {function(EventPayload): void} EventListener
 */

import { EventEmitterOptimizer } from './EventEmitterOptimizer.js';

/**
 * 轻量级 EventEmitter 实现
 * 支持事件类型区分、一次性订阅、批量触发
 */
export class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<EventListener>>} */
    this._events = new Map();
    
    // 启用优化器
    this.optimizer = new EventEmitterOptimizer(this);
  }

  /**
   * 订阅事件
   * @param {string} event - 事件类型
   * @param {EventListener} callback - 回调函数
   * @returns {function(): void} 取消订阅函数
   */
  on(event, callback) {
    if (!this._events.has(event)) {
      this._events.set(event, new Set());
    }
    this._events.get(event).add(callback);
    
    // 返回取消订阅函数
    return () => this.off(event, callback);
  }

  /**
   * 取消订阅事件
   * @param {string} event - 事件类型
   * @param {EventListener} callback - 回调函数
   */
  off(event, callback) {
    const listeners = this._events.get(event);
    if (listeners) {
      listeners.delete(callback);
      // 如果没有监听器了，移除该事件类型
      if (listeners.size === 0) {
        this._events.delete(event);
      }
    }
  }

  /**
   * 一次性订阅事件
   * @param {string} event - 事件类型
   * @param {EventListener} callback - 回调函数
   * @returns {function(): void} 取消订阅函数
   */
  once(event, callback) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      callback(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * 触发事件
   * @param {string} event - 事件类型
   * @param {EventPayload} [payload] - 事件数据
   */
  emit(event, payload) {
    const listeners = this._events.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(payload);
        } catch (e) {
          console.error(`[EventEmitter] Error in listener for "${event}":`, e);
        }
      });
    }
  }

  /**
   * 节流触发事件
   * @param {string} event - 事件类型
   * @param {number} delay - 节流延迟，默认 100ms
   */
  emitThrottled(event, delay = 100) {
    if (!this._throttledEmitters) {
      this._throttledEmitters = new Map();
    }
    let emitter = this._throttledEmitters.get(event);
    if (!emitter) {
      emitter = this.optimizer.throttle((event, payload) => this.emit(event, payload), delay);
      this._throttledEmitters.set(event, emitter);
    }
    
    return (payload) => emitter(event, payload);
  }

  /**
   * 去重触发事件（指定时间内重复的事件只触发最后一次）
   * @param {string} event - 事件类型
   * @param {EventPayload} [payload] - 事件数据
   */
  emitDedup(event, payload) {
    if (this.optimizer.deduplicate(event, payload)) {
      this.emit(event, payload);
    }
  }

  /**
   * 触发多个事件（批量更新场景）
   * @param {Array<{event: string, payload: EventPayload}>} events - 事件列表
   */
  emitBatch(events) {
    events.forEach(({ event, payload }) => {
      this.emit(event, payload);
    });
  }

  /**
   * 清除指定事件的所有监听器
   * @param {string} [event] - 事件类型，不传则清除所有
   */
  clear(event) {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
      this.optimizer.cleanup();
    }
  }

  /**
   * 获取指定事件的监听器数量
   * @param {string} event - 事件类型
   * @returns {number} 监听器数量
   */
  listenerCount(event) {
    const listeners = this._events.get(event);
    return listeners ? listeners.size : 0;
  }

  /**
   * 检查是否有指定事件的监听器
   * @param {string} event - 事件类型
   * @returns {boolean}
   */
  hasListeners(event) {
    return this.listenerCount(event) > 0;
  }
}
