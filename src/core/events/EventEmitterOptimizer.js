/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
export class EventEmitterOptimizer {
  constructor(eventEmitter) {
    this.emitter = eventEmitter;
    
    // 事件频率限制
    this.throttleMap = new Map();
    
    // 事件去重
    this.dedupBuffer = new Map();
    this.dedupTimeout = 100;
  }
  
  /**
   * 节流事件触发
   */
  throttle(event, handler, delay = 100) {
    let lastCall = 0;
    let timeoutId = null;
    
    return (...args) => {
      const now = Date.now();
      
      if (now - lastCall >= delay) {
        lastCall = now;
        handler(...args);
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = Date.now();
          timeoutId = null;
          handler(...args);
        }, delay - (now - lastCall));
      }
    };
  }
  
  /**
   * 去重事件触发（短时间内相同事件只触发一次）
   */
  deduplicate(event, data) {
    const key = this._getEventKey(event, data);
    const lastCall = this.dedupBuffer.get(key);
    const now = Date.now();
    
    if (lastCall && now - lastCall < this.dedupTimeout) {
      return false; // 跳过重复事件
    }
    
    this.dedupBuffer.set(key, now);
    return true;
  }
  
  /**
   * 批量处理事件
   */
  batchProcess(events, callback) {
    const batch = [];
    const processBatch = () => {
      if (batch.length > 0) {
        callback(batch);
        batch.length = 0;
      }
    };
    
    const batchTimeout = setTimeout(processBatch, 16); // 一帧后处理
    
    events.forEach(event => {
      batch.push(event);
    });
    
    return batchTimeout;
  }
  
  _getEventKey(event, data) {
    // 生成事件唯一键
    const dataStr = typeof data === 'object' 
      ? JSON.stringify(data) 
      : String(data);
    return `${event}|${dataStr}`;
  }
  
  cleanup() {
    this.dedupBuffer.clear();
  }
}