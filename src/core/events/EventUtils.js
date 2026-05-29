/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 事件工具函数
 *
 * 提供 throttle（节流）功能
 * 用于优化高频事件处理
 */

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
  let rafId = null;
  let lastArgs = null;
  let lastThis = null;

  const throttled = function(...args) {
    lastArgs = args;
    lastThis = this;

    if (!ticking) {
      ticking = true;
      rafId = requestAnimationFrame(() => {
        rafId = null;
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
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    ticking = false;
    lastArgs = null;
    lastThis = null;
  };

  return throttled;
}

export default {
  throttle,
  rafThrottle
};