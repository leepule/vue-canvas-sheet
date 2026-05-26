/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @fileoverview 性能监控系统
 * 提供性能指标收集、分析和报告功能
 */
import { RingBuffer } from './Queues.js';

/**
 * @typedef {Object} MetricEntry - 指标条目
 * @property {number} value - 值
 * @property {number} timestamp - 时间戳
 * @property {Object} [metadata] - 元数据
 */

/**
 * @typedef {Object} MetricStats - 指标统计
 * @property {number} count - 计数
 * @property {number} sum - 总和
 * @property {number} min - 最小值
 * @property {number} max - 最大值
 * @property {number} avg - 平均值
 * @property {number} p50 - 50 百分位
 * @property {number} p95 - 95 百分位
 * @property {number} p99 - 99 百分位
 */

/**
 * @typedef {Object} PerformanceReport - 性能报告
 * @property {number} timestamp - 报告时间戳
 * @property {number} duration - 监控持续时间（毫秒）
 * @property {Object.<string, MetricStats>} metrics - 指标统计
 * @property {MemorySnapshot|null} memory - 内存快照
 * @property {FPSStats|null} fps - FPS 统计
 */

/**
 * @typedef {Object} MemorySnapshot - 内存快照
 * @property {number} usedJSHeapSize - 已用堆大小
 * @property {number} totalJSHeapSize - 总堆大小
 * @property {number} jsHeapSizeLimit - 堆大小限制
 */

/**
 * @typedef {Object} FPSStats - FPS 统计
 * @property {number} current - 当前 FPS
 * @property {number} avg - 平均 FPS
 * @property {number} min - 最低 FPS
 * @property {number} max - 最高 FPS
 * @property {number} frames - 总帧数
 */

/**
 * 指标类型枚举
 */
export const MetricTypes = {
  // 渲染相关
  RENDER_FULL: 'render.full',
  RENDER_PARTIAL: 'render.partial',
  RENDER_CELL: 'render.cell',
  RENDER_SELECTION: 'render.selection',
  
  // 数据操作相关
  DATA_SET: 'data.set',
  DATA_LOAD: 'data.load',
  DATA_CLEAR: 'data.clear',
  
  // 公式相关
  FORMULA_EVAL: 'formula.eval',
  FORMULA_RECALC: 'formula.recalc',
  FORMULA_RECALC_ALL: 'formula.recalcAll',
  
  // 用户交互相关
  INTERACTION_CLICK: 'interaction.click',
  INTERACTION_SCROLL: 'interaction.scroll',
  INTERACTION_KEYPRESS: 'interaction.keypress',
  INTERACTION_DRAG: 'interaction.drag',
  
  // 剪贴板相关
  CLIPBOARD_COPY: 'clipboard.copy',
  CLIPBOARD_PASTE: 'clipboard.paste',
  
  // 历史记录相关
  HISTORY_UNDO: 'history.undo',
  HISTORY_REDO: 'history.redo',
  
  // 搜索相关
  SEARCH_FIND: 'search.find',
  SEARCH_REPLACE: 'search.replace',
  
  // 导入导出相关
  IO_EXPORT: 'io.export',
  IO_IMPORT: 'io.import'
};

/**
 * 性能指标类
 */
class Metric {
  /**
   * @param {string} name - 指标名称
   * @param {number} [maxEntries=100] - 最大条目数
   */
  constructor(name, maxEntries = 100) {
    this.name = name;
    this.maxEntries = maxEntries;
    /** @type {RingBuffer<MetricEntry>} */
    this.entries = new RingBuffer(maxEntries);
    // 增量统计：record/evict 时 O(1) 维护，省掉 getStats 中的 reduce 与 min/max 单独扫描
    this._sum = 0;
    this._cachedMin = 0;
    this._cachedMax = 0;
    this._minValid = false;
    this._maxValid = false;
  }

  /**
   * 记录一个值
   * @param {number} value - 值
   * @param {Object} [metadata] - 元数据
   */
  record(value, metadata = null) {
    // 容量满时：先减去即将被覆盖的最旧值，必要时让 min/max 缓存失效
    if (this.entries.length === this.maxEntries) {
      const evictedValue = this.entries.first().value;
      this._sum -= evictedValue;
      if (this._minValid && evictedValue === this._cachedMin) this._minValid = false;
      if (this._maxValid && evictedValue === this._cachedMax) this._maxValid = false;
    }

    // RingBuffer 容量已满时自动淘汰最旧元素
    this.entries.push({
      value,
      timestamp: Date.now(),
      metadata
    });
    this._sum += value;

    // 维护 min/max 缓存：仅在缓存仍有效时增量更新；失效则等 getStats 重扫
    if (this._minValid) {
      if (value < this._cachedMin) this._cachedMin = value;
    } else if (this.entries.length === 1) {
      this._cachedMin = value;
      this._minValid = true;
    }
    if (this._maxValid) {
      if (value > this._cachedMax) this._cachedMax = value;
    } else if (this.entries.length === 1) {
      this._cachedMax = value;
      this._maxValid = true;
    }
  }

  /**
   * 获取统计信息
   * @returns {MetricStats}
   */
  getStats() {
    const count = this.entries.length;
    if (count === 0) {
      return {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0
      };
    }

    const sum = this._sum;
    let min;
    let max;

    // min/max 缓存有效则 O(1) 读取；任一失效则一次扫描重建
    if (this._minValid && this._maxValid) {
      min = this._cachedMin;
      max = this._cachedMax;
    } else {
      min = Infinity;
      max = -Infinity;
      this.entries.forEach((entry) => {
        const v = entry.value;
        if (v < min) min = v;
        if (v > max) max = v;
      });
      this._cachedMin = min;
      this._cachedMax = max;
      this._minValid = true;
      this._maxValid = true;
    }

    // 百分位仍需 sort：使用单次拷贝并 in-place 排序
    const sorted = new Array(count);
    for (let i = 0; i < count; i++) {
      sorted[i] = this.entries.get(i).value;
    }
    sorted.sort((a, b) => a - b);

    return {
      count,
      sum,
      min,
      max,
      avg: sum / count,
      p50: this._percentile(sorted, 50),
      p95: this._percentile(sorted, 95),
      p99: this._percentile(sorted, 99)
    };
  }

  /**
   * 计算百分位值
   * @param {number[]} sortedValues - 已排序的值数组
   * @param {number} p - 百分位（0-100）
   * @returns {number}
   */
  _percentile(sortedValues, p) {
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }

  /**
   * 清空所有条目
   */
  clear() {
    this.entries.clear();
    this._sum = 0;
    this._cachedMin = 0;
    this._cachedMax = 0;
    this._minValid = false;
    this._maxValid = false;
  }

  /**
   * 获取最近的条目
   * @param {number} [count=10] - 条目数量
   * @returns {MetricEntry[]}
   */
  getRecent(count = 10) {
    return this.entries.lastN(count);
  }
}

/**
 * FPS 监控器
 */
class FPSMonitor {
  constructor() {
    this.frames = new RingBuffer(100);
    this.lastTime = 0;
    this.frameCount = 0;
    this.isRunning = false;
    this.rafId = null;
    // 增量统计：避免 60Hz 调用 getStats 时反复 sort + reduce
    this._sum = 0;
    this._cachedMin = 0;
    this._cachedMax = 0;
    this._minValid = false;
    this._maxValid = false;
  }

  /**
   * 开始监控
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this._tick();
  }

  /**
   * 停止监控
   */
  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 内部帧循环
   */
  _tick() {
    if (!this.isRunning) return;
    
    const now = performance.now();
    const delta = now - this.lastTime;
    
    if (delta > 0) {
      const fps = 1000 / delta;
      // 容量满时先减去即将被覆盖的最旧值，并按需失效 min/max 缓存
      if (this.frames.length === 100) {
        const evictedFps = this.frames.first().fps;
        this._sum -= evictedFps;
        if (this._minValid && evictedFps === this._cachedMin) this._minValid = false;
        if (this._maxValid && evictedFps === this._cachedMax) this._maxValid = false;
      }
      this.frames.push({
        fps,
        timestamp: now
      });
      this._sum += fps;
      if (this._minValid) {
        if (fps < this._cachedMin) this._cachedMin = fps;
      } else if (this.frames.length === 1) {
        this._cachedMin = fps;
        this._minValid = true;
      }
      if (this._maxValid) {
        if (fps > this._cachedMax) this._cachedMax = fps;
      } else if (this.frames.length === 1) {
        this._cachedMax = fps;
        this._maxValid = true;
      }
    }
    
    this.lastTime = now;
    this.frameCount++;
    
    this.rafId = requestAnimationFrame(() => this._tick());
  }

  /**
   * 获取当前 FPS
   * @returns {number}
   */
  getCurrentFPS() {
    if (this.frames.length === 0) return 0;
    return this.frames.last().fps;
  }

  /**
   * 获取 FPS 统计
   * @returns {FPSStats}
   */
  getStats() {
    const count = this.frames.length;
    if (count === 0) {
      return {
        current: 0,
        avg: 0,
        min: 0,
        max: 0,
        frames: 0
      };
    }

    let min;
    let max;
    if (this._minValid && this._maxValid) {
      min = this._cachedMin;
      max = this._cachedMax;
    } else {
      min = Infinity;
      max = -Infinity;
      this.frames.forEach((frame) => {
        const v = frame.fps;
        if (v < min) min = v;
        if (v > max) max = v;
      });
      this._cachedMin = min;
      this._cachedMax = max;
      this._minValid = true;
      this._maxValid = true;
    }

    return {
      current: this.frames.last().fps,
      avg: this._sum / count,
      min,
      max,
      frames: this.frameCount
    };
  }

  /**
   * 重置
   */
  reset() {
    this.frames.clear();
    this.frameCount = 0;
    this._sum = 0;
    this._cachedMin = 0;
    this._cachedMax = 0;
    this._minValid = false;
    this._maxValid = false;
  }
}

/**
 * 性能监控器主类
 */
export class PerformanceMonitor {
  /**
   * @param {Object} [options] - 配置选项
   * @param {boolean} [options.enabled=true] - 是否启用
   * @param {number} [options.maxEntries=100] - 每个指标最大条目数
   * @param {boolean} [options.trackFPS=false] - 是否追踪 FPS
   * @param {boolean} [options.trackMemory=false] - 是否追踪内存
   */
  constructor(options = {}) {
    this.options = {
      enabled: options.enabled !== false,
      maxEntries: options.maxEntries || 100,
      trackFPS: options.trackFPS || false,
      trackMemory: options.trackMemory || false
    };

    /** @type {Map<string, Metric>} */
    this.metrics = new Map();
    
    /** @type {Map<string, number>} */
    this.activeMarks = new Map();
    
    /** @type {FPSMonitor|null} */
    this.fpsMonitor = this.options.trackFPS ? new FPSMonitor() : null;
    
    /** @type {number} */
    this.startTime = Date.now();
    
    /** @type {Map<string, Function>} */
    this.thresholdCallbacks = new Map();
  }

  /**
   * 启用监控
   */
  enable() {
    this.options.enabled = true;
    if (this.fpsMonitor) {
      this.fpsMonitor.start();
    }
  }

  /**
   * 禁用监控
   */
  disable() {
    this.options.enabled = false;
    if (this.fpsMonitor) {
      this.fpsMonitor.stop();
    }
  }

  /**
   * 开始计时
   * @param {string} metricType - 指标类型
   * @param {string} [id] - 可选的唯一标识符
   * @returns {string} 返回标记 ID，用于结束计时
   */
  startMark(metricType, id = null) {
    if (!this.options.enabled) return null;
    
    const markId = id || `${metricType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.activeMarks.set(markId, {
      type: metricType,
      startTime: performance.now(),
      timestamp: Date.now()
    });
    
    return markId;
  }

  /**
   * 结束计时并记录
   * @param {string} markId - 标记 ID
   * @param {Object} [metadata] - 元数据
   * @returns {number} 持续时间（毫秒），如果标记不存在返回 0
   */
  endMark(markId, metadata = null) {
    if (!this.options.enabled || !markId) return 0;
    
    const mark = this.activeMarks.get(markId);
    if (!mark) {
      console.warn(`[PerformanceMonitor] Mark not found: ${markId}`);
      return 0;
    }
    
    this.activeMarks.delete(markId);
    
    const duration = performance.now() - mark.startTime;
    this.record(mark.type, duration, metadata);
    
    return duration;
  }

  /**
   * 记录一个指标值
   * @param {string} metricType - 指标类型
   * @param {number} value - 值
   * @param {Object} [metadata] - 元数据
   */
  record(metricType, value, metadata = null) {
    if (!this.options.enabled) return;
    
    if (!this.metrics.has(metricType)) {
      this.metrics.set(metricType, new Metric(metricType, this.options.maxEntries));
    }
    
    this.metrics.get(metricType).record(value, metadata);
    
    // 检查阈值回调
    const callbackKey = metricType;
    const callback = this.thresholdCallbacks.get(callbackKey);
    if (callback) {
      callback(value, metricType, metadata);
    }
  }

  /**
   * 测量一个函数的执行时间
   * @param {string} metricType - 指标类型
   * @param {Function} fn - 要测量的函数
   * @param {Object} [metadata] - 元数据
   * @returns {*} 函数返回值
   */
  measure(metricType, fn, metadata = null) {
    if (!this.options.enabled) {
      return fn();
    }
    
    const markId = this.startMark(metricType);
    try {
      const result = fn();
      this.endMark(markId, metadata);
      return result;
    } catch (error) {
      this.endMark(markId, { ...metadata, error: error.message });
      throw error;
    }
  }

  /**
   * 测量一个异步函数的执行时间
   * @param {string} metricType - 指标类型
   * @param {Function} fn - 要测量的异步函数
   * @param {Object} [metadata] - 元数据
   * @returns {Promise<*>} 函数返回值
   */
  async measureAsync(metricType, fn, metadata = null) {
    if (!this.options.enabled) {
      return fn();
    }
    
    const markId = this.startMark(metricType);
    try {
      const result = await fn();
      this.endMark(markId, metadata);
      return result;
    } catch (error) {
      this.endMark(markId, { ...metadata, error: error.message });
      throw error;
    }
  }

  /**
   * 设置阈值回调
   * @param {string} metricType - 指标类型
   * @param {number} threshold - 阈值（毫秒）
   * @param {Function} callback - 回调函数 (value, metricType, metadata) => void
   */
  setThreshold(metricType, threshold, callback) {
    this.thresholdCallbacks.set(metricType, (value, type, metadata) => {
      if (value > threshold) {
        callback(value, type, metadata);
      }
    });
  }

  /**
   * 获取指标统计
   * @param {string} metricType - 指标类型
   * @returns {MetricStats|null}
   */
  getStats(metricType) {
    const metric = this.metrics.get(metricType);
    return metric ? metric.getStats() : null;
  }

  /**
   * 获取所有指标统计
   * @returns {Object.<string, MetricStats>}
   */
  getAllStats() {
    const result = {};
    this.metrics.forEach((metric, type) => {
      result[type] = metric.getStats();
    });
    return result;
  }

  /**
   * 获取内存快照
   * @returns {MemorySnapshot|null}
   */
  getMemorySnapshot() {
    if (!this.options.trackMemory || !performance.memory) {
      return null;
    }
    
    return {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
    };
  }

  /**
   * 获取 FPS 统计
   * @returns {FPSStats|null}
   */
  getFPSStats() {
    return this.fpsMonitor ? this.fpsMonitor.getStats() : null;
  }

  /**
   * 生成性能报告
   * @returns {PerformanceReport}
   */
  generateReport() {
    return {
      timestamp: Date.now(),
      duration: Date.now() - this.startTime,
      metrics: this.getAllStats(),
      memory: this.getMemorySnapshot(),
      fps: this.getFPSStats()
    };
  }

  /**
   * 导出报告为 JSON 字符串
   * @param {boolean} [pretty=true] - 是否格式化
   * @returns {string}
   */
  exportJSON(pretty = true) {
    const report = this.generateReport();
    return JSON.stringify(report, null, pretty ? 2 : 0);
  }

  /**
   * 导出报告为 CSV 格式
   * @returns {string}
   */
  exportCSV() {
    const stats = this.getAllStats();
    const lines = ['Metric,Count,Avg,Min,Max,P50,P95,P99'];
    
    Object.entries(stats).forEach(([type, stat]) => {
      lines.push(`${type},${stat.count},${stat.avg.toFixed(2)},${stat.min.toFixed(2)},${stat.max.toFixed(2)},${stat.p50.toFixed(2)},${stat.p95.toFixed(2)},${stat.p99.toFixed(2)}`);
    });
    
    return lines.join('\n');
  }

  /**
   * 打印性能摘要到控制台
   */
  printSummary() {
    const report = this.generateReport();
    
    console.group('📊 Performance Monitor Summary');
    console.log(`Duration: ${(report.duration / 1000).toFixed(2)}s`);
    
    if (report.fps) {
      console.log(`FPS: ${report.fps.current.toFixed(1)} (avg: ${report.fps.avg.toFixed(1)}, min: ${report.fps.min.toFixed(1)})`);
    }
    
    if (report.memory) {
      const usedMB = (report.memory.usedJSHeapSize / 1024 / 1024).toFixed(2);
      const totalMB = (report.memory.totalJSHeapSize / 1024 / 1024).toFixed(2);
      console.log(`Memory: ${usedMB}MB / ${totalMB}MB`);
    }
    
    console.group('📈 Metrics');
    Object.entries(report.metrics).forEach(([type, stat]) => {
      if (stat.count > 0) {
        console.log(`${type}: avg=${stat.avg.toFixed(2)}ms, p95=${stat.p95.toFixed(2)}ms, count=${stat.count}`);
      }
    });
    console.groupEnd();
    
    console.groupEnd();
  }

  /**
   * 清空所有指标
   */
  clear() {
    this.metrics.clear();
    this.activeMarks.clear();
    this.startTime = Date.now();
    if (this.fpsMonitor) {
      this.fpsMonitor.reset();
    }
  }

  /**
   * 销毁监控器
   */
  destroy() {
    this.disable();
    this.clear();
    this.thresholdCallbacks.clear();
  }

  /**
   * 创建一个装饰器，用于自动测量方法执行时间
   * @param {string} metricType - 指标类型
   * @returns {Function} 装饰器函数
   */
  static decorate(metricType) {
    const monitor = PerformanceMonitor.instance;
    
    return function(target, propertyKey, descriptor) {
      const originalMethod = descriptor.value;
      
      descriptor.value = function(...args) {
        if (!monitor || !monitor.options.enabled) {
          return originalMethod.apply(this, args);
        }
        
        return monitor.measure(metricType, () => {
          return originalMethod.apply(this, args);
        });
      };
      
      return descriptor;
    };
  }
}

// 单例实例
PerformanceMonitor.instance = null;

/**
 * 获取全局性能监控器实例
 * @param {Object} [options] - 配置选项
 * @returns {PerformanceMonitor}
 */
export function getPerformanceMonitor(options = {}) {
  if (!PerformanceMonitor.instance) {
    PerformanceMonitor.instance = new PerformanceMonitor(options);
  }
  return PerformanceMonitor.instance;
}

/**
 * 创建一个新的性能监控器实例
 * @param {Object} [options] - 配置选项
 * @returns {PerformanceMonitor}
 */
export function createPerformanceMonitor(options = {}) {
  return new PerformanceMonitor(options);
}

/**
 * 性能监控插件 - 用于集成到 Workbook
 */
export class PerformancePlugin {
  /**
   * @param {PerformanceMonitor} [monitor] - 性能监控器实例
   */
  constructor(monitor = null) {
    this.name = 'performance-plugin';
    this.version = '1.0.0';
    this.description = 'Performance monitoring plugin for Workbook';
    
    this.monitor = monitor || getPerformanceMonitor({
      trackFPS: false,
      trackMemory: true
    });
    
    this.workbook = null;
  }

  /**
   * 插件初始化
   * @param {Object} workbook - Workbook 实例
   */
  onInit(workbook) {
    this.workbook = workbook;
    
    // 设置阈值警告
    this.monitor.setThreshold(MetricTypes.RENDER_FULL, 100, (value) => {
      console.warn(`[Performance] Slow render detected: ${value.toFixed(2)}ms`);
    });
    
    this.monitor.setThreshold(MetricTypes.FORMULA_EVAL, 50, (value) => {
      console.warn(`[Performance] Slow formula evaluation: ${value.toFixed(2)}ms`);
    });
  }

  /**
   * 插件挂载
   */
  onMounted() {
    // 启动监控
    this.monitor.enable();
  }

  /**
   * 插件卸载
   */
  onUnmounted() {
    this.monitor.disable();
  }

  /**
   * 销毁插件
   */
  onDestroy() {
    this.monitor.destroy();
  }

  /**
   * 获取性能报告
   * @returns {PerformanceReport}
   */
  getReport() {
    return this.monitor.generateReport();
  }

  /**
   * 打印性能摘要
   */
  printSummary() {
    this.monitor.printSummary();
  }

  /**
   * 清空统计数据
   */
  clear() {
    this.monitor.clear();
  }
}

/**
 * 创建性能监控插件
 * @param {PerformanceMonitor} [monitor] - 性能监控器实例
 * @returns {PerformancePlugin}
 */
export function createPerformancePlugin(monitor = null) {
  return new PerformancePlugin(monitor);
}

export default PerformanceMonitor;