/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 事件工具函数
 * 
 * 提供 debounce（防抖）和 throttle（节流）功能
 * 用于优化高频事件处理
 */

/**
 * 防抖函数
 * 
 * 在事件被触发后，等待一定时间才执行回调
 * 如果在这段时间内事件再次触发，则重新计时
 * 
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟时间（毫秒）
 * @param {Object} options - 配置选项
 * @param {boolean} options.immediate - 是否立即执行（首次触发时）
 * @returns {Function} 防抖后的函数
 */
export function debounce(fn, delay = 100, options = {}) {
  const { immediate = false } = options;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;

  const debounced = function(...args) {
    lastArgs = args;
    lastThis = this;

    if (timer) {
      clearTimeout(timer);
    }

    if (immediate && !timer) {
      // 立即执行一次
      fn.apply(this, args);
    }

    timer = setTimeout(() => {
      timer = null;
      if (!immediate && lastArgs) {
        fn.apply(lastThis, lastArgs);
      }
      lastArgs = null;
      lastThis = null;
    }, delay);
  };

  /**
   * 取消防抖
   */
  debounced.cancel = function() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
    lastThis = null;
  };

  /**
   * 立即执行
   */
  debounced.flush = function() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) {
        fn.apply(lastThis, lastArgs);
      }
      lastArgs = null;
      lastThis = null;
    }
  };

  return debounced;
}

/**
 * 节流函数
 * 
 * 在一定时间内只执行一次回调
 * 适用于持续触发的事件（如 scroll、mousemove）
 * 
 * @param {Function} fn - 要执行的函数
 * @param {number} interval - 执行间隔（毫秒）
 * @param {Object} options - 配置选项
 * @param {boolean} options.leading - 是否在开始时立即执行
 * @param {boolean} options.trailing - 是否在结束后执行最后一次
 * @returns {Function} 节流后的函数
 */
export function throttle(fn, interval = 16, options = {}) {
  const { leading = true, trailing = true } = options;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let lastTime = 0;

  const throttled = function(...args) {
    const now = Date.now();
    lastArgs = args;
    lastThis = this;

    // 首次调用且需要立即执行
    if (lastTime === 0) {
      if (leading) {
        lastTime = now;
        fn.apply(this, args);
        lastArgs = null;
        lastThis = null;
      } else {
        lastTime = now;
      }
      return;
    }

    const remaining = interval - (now - lastTime);

    if (remaining <= 0) {
      // 已经超过间隔时间，立即执行
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastTime = now;
      fn.apply(this, args);
      lastArgs = null;
      lastThis = null;
    } else if (!timer && trailing) {
      // 还在间隔时间内，设置定时器在结束时执行
      timer = setTimeout(() => {
        timer = null;
        lastTime = Date.now();
        if (lastArgs) {
          fn.apply(lastThis, lastArgs);
        }
        lastArgs = null;
        lastThis = null;
      }, remaining);
    }
  };

  /**
   * 取消节流
   */
  throttled.cancel = function() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
    lastThis = null;
    lastTime = 0;
  };

  /**
   * 立即执行
   */
  throttled.flush = function() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      fn.apply(lastThis, lastArgs);
    }
    lastArgs = null;
    lastThis = null;
    lastTime = 0;
  };

  return throttled;
}

/**
 * RAF 节流函数
 * 
 * 使用 requestAnimationFrame 进行节流
 * 确保每帧最多执行一次，适合动画相关操作
 * 
 * @param {Function} fn - 要执行的函数
 * @returns {Function} RAF 节流后的函数
 */
export function rafThrottle(fn) {
  let ticking = false;
  let lastArgs = null;
  let lastThis = null;

  const throttled = function(...args) {
    lastArgs = args;
    lastThis = this;

    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (lastArgs) {
          fn.apply(lastThis, lastArgs);
        }
        lastArgs = null;
        lastThis = null;
      });
    }
  };

  /**
   * 取消 RAF 节流
   */
  throttled.cancel = function() {
    ticking = false;
    lastArgs = null;
    lastThis = null;
  };

  return throttled;
}

/**
 * 双重节流函数
 * 
 * 结合时间节流和 RAF 节流
 * 确保在指定时间间隔内最多执行一次，且在帧边界执行
 * 
 * @param {Function} fn - 要执行的函数
 * @param {number} minInterval - 最小执行间隔（毫秒）
 * @returns {Function} 双重节流后的函数
 */
export function doubleThrottle(fn, minInterval = 16) {
  let lastTime = 0;
  let rafId = null;
  let pendingArgs = null;
  let pendingThis = null;

  const execute = () => {
    rafId = null;
    if (pendingArgs) {
      fn.apply(pendingThis, pendingArgs);
      lastTime = performance.now();
      pendingArgs = null;
      pendingThis = null;
    }
  };

  const throttled = function(...args) {
    const now = performance.now();
    const elapsed = now - lastTime;

    pendingArgs = args;
    pendingThis = this;

    if (elapsed >= minInterval && !rafId) {
      // 已经超过最小间隔，立即安排执行
      rafId = requestAnimationFrame(execute);
    } else if (!rafId) {
      // 还在间隔内，安排在间隔结束后执行
      setTimeout(() => {
        if (!rafId && pendingArgs) {
          rafId = requestAnimationFrame(execute);
        }
      }, minInterval - elapsed);
    }
  };

  /**
   * 取消双重节流
   */
  throttled.cancel = function() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingArgs = null;
    pendingThis = null;
  };

  return throttled;
}

/**
 * 批量处理器
 * 
 * 收集一段时间内的所有调用，然后批量处理
 * 适合需要批量处理的高频事件
 */
export class BatchProcessor {
  /**
   * @param {Function} processor - 批量处理函数，接收收集到的参数数组
   * @param {number} delay - 批量收集时间窗口（毫秒）
   */
  constructor(processor, delay = 16) {
    this.processor = processor;
    this.delay = delay;
    this.batch = [];
    this.timer = null;
  }

  /**
   * 添加到批处理队列
   * @param {...any} args - 参数
   */
  add(...args) {
    this.batch.push(args);

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.delay);
    }
  }

  /**
   * 立即处理并清空队列
   */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length > 0) {
      const batch = this.batch;
      this.batch = [];
      this.processor(batch);
    }
  }

  /**
   * 清空队列（不处理）
   */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.batch = [];
  }
}

export default {
  debounce,
  throttle,
  rafThrottle,
  doubleThrottle,
  BatchProcessor
};