/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * OffscreenCanvas 渲染管理器
 *
 * 管理 Worker 中的 Canvas 渲染，提供以下功能：
 * 1. Worker 生命周期管理
 * 2. 渲染命令发送和结果接收
 * 3. 降级机制（不支持 OffscreenCanvas 时回退到主线程）
 * 4. 性能统计
 */

import { serializeRenderData } from '../worker/TransferableSerializer.js';
import { WorkerClient } from '../worker/WorkerClient.js';

function getDevicePixelRatio() {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

function normalizeDevicePixelRatio(dpr) {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * 检测浏览器是否支持 OffscreenCanvas
 * @returns {boolean}
 */
export function isOffscreenCanvasSupported() {
  return typeof OffscreenCanvas !== 'undefined' && 
         typeof Worker !== 'undefined' &&
         typeof HTMLCanvasElement !== 'undefined' &&
         typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}

/**
 * 渲染统计信息
 */
class RenderStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.totalRenders = 0;
    this.workerRenders = 0;
    this.mainThreadRenders = 0;
    this.totalRenderTime = 0;
    this.workerRenderTime = 0;
    this.mainThreadRenderTime = 0;
    this.fallbackCount = 0;
  }

  recordWorkerRender(time) {
    this.totalRenders++;
    this.workerRenders++;
    this.totalRenderTime += time;
    this.workerRenderTime += time;
  }

  recordMainThreadRender(time) {
    this.totalRenders++;
    this.mainThreadRenders++;
    this.totalRenderTime += time;
    this.mainThreadRenderTime += time;
  }

  recordFallback() {
    this.fallbackCount++;
  }

  getStats() {
    return {
      totalRenders: this.totalRenders,
      workerRenders: this.workerRenders,
      mainThreadRenders: this.mainThreadRenders,
      avgRenderTime: this.totalRenders > 0 ? this.totalRenderTime / this.totalRenders : 0,
      avgWorkerRenderTime: this.workerRenders > 0 ? this.workerRenderTime / this.workerRenders : 0,
      avgMainThreadRenderTime: this.mainThreadRenders > 0 ? this.mainThreadRenderTime / this.mainThreadRenders : 0,
      fallbackCount: this.fallbackCount,
      workerRenderRatio: this.totalRenders > 0 ? this.workerRenders / this.totalRenders : 0
    };
  }
}

/**
 * OffscreenCanvas 渲染器类
 */
export class OffscreenRenderer {
  /**
   * @param {Object} options 配置选项
   * @param {HTMLCanvasElement} options.canvas 目标 Canvas 元素
   * @param {Object} options.theme 表格主题配置
   * @param {boolean} [options.enableWorker=true] 是否启用 Worker
   * @param {number} [options.timeout=5000] Worker 超时时间（毫秒）
   * @param {Function} [options.onFallback] 降级回调
   */
  constructor(options) {
    this.canvas = options.canvas;
    this.theme = options.theme;
    this.enableWorker = options.enableWorker !== false;
    this.timeout = options.timeout || 5000;
    this.onFallback = options.onFallback;

    // 状态
    this.worker = null;
    this.workerClient = null;
    this.offscreen = null;
    this.ctx = null;
    this.mainCtx = null;
    this.isInitialized = false;
    this.useWorker = false;
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.workerCanvasReady = false;
    this.canvasTransferred = false;
    this.sizePromise = null;

    // 统计
    this.stats = new RenderStats();

    // 初始化
    this._init();
  }

  /**
   * 初始化渲染器
   * @private
   */
  _init() {
    this.dpr = getDevicePixelRatio();

    if (!this.enableWorker || !isOffscreenCanvasSupported()) {
      this._initMainThread();
      return;
    }

    try {
      this.workerClient = new WorkerClient({
        name: 'RenderWorker',
        timeout: this.timeout,
        requestIdField: 'id',
        createWorker: () => new Worker(new URL('../../workers/render.worker.js', import.meta.url), { type: 'module' }),
        onError: this._handleWorkerError.bind(this)
      });
      this.worker = this.workerClient.worker;

      this.useWorker = true;
      this.isInitialized = true;
    } catch (error) {
      // Worker 初始化失败是预期行为，静默降级到主线程渲染
      this._initMainThread();
      this.stats.recordFallback();
      if (this.onFallback) {
        this.onFallback(error);
      }
    }
  }

  /**
   * 初始化主线程渲染（降级模式）
   * @private
   */
  _initMainThread() {
    this.useWorker = false;
    this.isInitialized = true;
    this.workerCanvasReady = false;
    this.mainCtx = this.canvas ? this.canvas.getContext('2d') : null;
    this.ctx = this.mainCtx;
  }

  /**
   * 处理 Worker 错误
   * @private
   */
  _handleWorkerError(error) {
    console.error('[OffscreenRenderer] Worker error:', error);
    
    // 降级到主线程
    this._fallbackToMainThread();
    
  }

  /**
   * 降级到主线程渲染
   * @private
   */
  _fallbackToMainThread() {
    if (this.workerClient) {
      this.workerClient.destroy('Render worker fallback');
      this.workerClient = null;
    }
    this.worker = null;
    
    this.useWorker = false;
    this.workerCanvasReady = false;

    // canvas 控制权一旦通过 transferControlToOffscreen 转移给 worker，
    // 主线程对同一元素调用 getContext('2d') 会抛 InvalidStateError，必须换用全新的
    // canvas 元素才能重获 2D 绘制权。但创建/替换 DOM 节点是 Vue 的职责——核心渲染层
    // 直接 replaceChild 会让 Vue 的 VNode 缓存指向游离节点，下次 patch 抛 NotFoundError。
    // 因此这里只发出"需要重建 canvas"信号，由组件层通过 :key 变更让 Vue 重建后再 attachCanvas 回挂。
    const needsRebuild = this.canvasTransferred;
    if (needsRebuild) {
      this.ctx = null;
      this.mainCtx = null;
    } else {
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.mainCtx = this.ctx;
    }
    this.stats.recordFallback();

    console.warn('[OffscreenRenderer] Fallback to main thread rendering');

    if (this.onFallback) {
      this.onFallback(new Error('Fallback to main thread'), { needsCanvasRebuild: needsRebuild });
    }
  }

  /**
   * 回挂主线程 canvas 元素（用于 worker 降级后 Vue 重建 canvas 的场景）
   *
   * 当 canvas 控制权已转移给 worker 时，_fallbackToMainThread 无法就地获取 2D context，
   * 需由组件层通过 :key 变更让 Vue 重建出全新 canvas 元素后调用本方法回挂。
   * @param {HTMLCanvasElement} canvasEl 新的 canvas 元素
   * @returns {CanvasRenderingContext2D|null} 新元素的 2D 上下文
   */
  attachCanvas(canvasEl) {
    this.canvas = canvasEl;
    this.canvasTransferred = false;
    this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
    this.mainCtx = this.ctx;
    return this.ctx;
  }

  /**
   * 发送命令到 Worker
   * @private
   */
  async _sendCommand(type, data, transfer = []) {
    if (!this.useWorker) {
      throw new Error('Worker not available');
    }

    const response = await this.workerClient.request({ type, data }, transfer, { requestIdField: 'id' });
    if (!response || response.success === false) {
      throw new Error(response?.error || `Command ${type} failed`);
    }
    const { id, success, error, ...result } = response;
    return result;
  }

  /**
   * 初始化 Canvas 尺寸
   * @param {number} width 宽度
   * @param {number} height 高度
   */
  async initSize(width, height) {
    return this.resize(width, height);
  }

  /**
   * 执行尺寸同步
   * @private
   */
  async _applySize(width, height, dpr = this.dpr) {
    this.width = width;
    this.height = height;
    this.dpr = normalizeDevicePixelRatio(dpr);

    if (this.canvas) {
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
    }

    if (this.useWorker) {
      try {
        const shouldInit = !this.workerCanvasReady;
        const data = { width, height, dpr: this.dpr };
        const transfer = [];

        if (shouldInit) {
          // 跳过此前的 `ping` 探测：`isOffscreenCanvasSupported()` 已在主线程同步检测过
          // `OffscreenCanvas` 全局与 `transferControlToOffscreen`，浏览器在两个上下文
          // 共享同一特性闸；worker 端的 `initCanvas` 自身仍保留 hasOffscreenCanvas 守卫
          // 作为防御层。这样冷启动从 2 次 worker 往返合并为 1 次。
          try {
            this.offscreen = this.canvas.transferControlToOffscreen();
            this.canvasTransferred = true;
            data.canvas = this.offscreen;
            transfer.push(this.offscreen);
          } catch (error) {
            this.canvasTransferred = false;
            this.offscreen = null;
            throw error;
          }
        }

        await this._sendCommand(shouldInit ? 'init' : 'resize', data, transfer);
        this.workerCanvasReady = true;
        if (shouldInit) {
          this.offscreen = null;
        }
        return true;
      } catch (error) {
        console.warn('[OffscreenRenderer] Failed to sync worker canvas size:', error);
        this._fallbackToMainThread();
        return false;
      }
    } else {
      // 主线程模式
      if (!this.ctx) {
        return false;
      }
      this.canvas.width = width * this.dpr;
      this.canvas.height = height * this.dpr;
      if (this.ctx.setTransform) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      this.ctx.scale(this.dpr, this.dpr);
      return true;
    }
  }

  /**
   * 调整 Canvas 尺寸
   * @param {number} width 新宽度
   * @param {number} height 新高度
   * @param {number} [dpr] 当前设备像素比，未传入时从运行环境读取
   */
  async resize(width, height, dpr = getDevicePixelRatio()) {
    const nextDpr = normalizeDevicePixelRatio(dpr);

    if (this.sizePromise) {
      await this.sizePromise;
    }

    if (this.width === width && this.height === height && this.dpr === nextDpr &&
        (!this.useWorker || this.workerCanvasReady)) {
      return true;
    }

    const promise = this._applySize(width, height, nextDpr);
    this.sizePromise = promise;

    try {
      return await promise;
    } finally {
      if (this.sizePromise === promise) {
        this.sizePromise = null;
      }
    }
  }

  /**
   * 执行渲染
   * @param {Object} renderData 渲染数据
   * @returns {Promise<Object>} 渲染结果
   */
  async render(renderData) {
    const startTime = performance.now();

    if (this.useWorker) {
      try {
        const sizeReady = await this.resize(
          renderData.width || this.width,
          renderData.height || this.height
        );

        if (!sizeReady || !this.useWorker) {
          return { success: false, error: 'Worker canvas is not available' };
        }

        // 使用 TransferableSerializer 序列化数据
        const { buffer, transferables } = serializeRenderData({
          ...renderData,
          theme: this.theme,
          width: this.width,
          height: this.height
        });

        const result = await this._sendCommand('render', {
          useTransferable: true,
          buffer
        }, transferables);

        const renderTime = performance.now() - startTime;
        this.stats.recordWorkerRender(renderTime);

        return { 
          success: true, 
          renderTime,
          workerTime: result.renderTime 
        };
      } catch (error) {
        console.warn('[OffscreenRenderer] Worker render failed:', error);
        this._fallbackToMainThread();
        return { success: false, error: error.message };
      }
    }

    // 主线程渲染
    return this._renderOnMainThread(renderData, startTime);
  }

  /**
   * 主线程渲染（内部方法）
   * @private
   */
  _renderOnMainThread(renderData, startTime = performance.now()) {
    const { 
      cellDataList, 
      borderBatch, 
      bgGroups, 
      gridLines,
      renderRect,
      colHeaders,
      rowHeaders,
      frozenLines
    } = renderData;

    const ctx = this.ctx;
    if (!ctx) {
      return { success: false, error: 'Main thread canvas context is not available' };
    }

    // 清除画布
    if (renderRect) {
      ctx.clearRect(renderRect.x, renderRect.y, renderRect.w, renderRect.h);
    } else {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    // 主线程路径只负责清屏，具体内容由调用方渲染
    const renderTime = performance.now() - startTime;
    this.stats.recordMainThreadRender(renderTime);

    return { success: true, renderTime };
  }

  /**
   * 批量测量文本宽度
   * @param {Array<{text: string, font: string}>} items 文本项
   * @returns {Promise<number[]>} 宽度数组
   */
  async measureTextBatch(items) {
    if (this.useWorker) {
      try {
        const result = await this._sendCommand('measureText', { items });
        return result.widths;
      } catch (error) {
        // 降级到主线程测量
      }
    }

    // 主线程测量
    if (!this.ctx) {
      return items.map(() => 0);
    }

    return items.map(item => {
      this.ctx.font = item.font;
      return this.ctx.measureText(item.text).width;
    });
  }

  /**
   * 获取渲染统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return this.stats.getStats();
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats.reset();
  }

  /**
   * 检查是否使用 Worker
   * @returns {boolean}
   */
  isUsingWorker() {
    return this.useWorker;
  }

  /**
   * 强制降级到主线程
   */
  forceFallback() {
    if (this.useWorker) {
      this._fallbackToMainThread();
    }
  }

  /**
   * 销毁渲染器
   */
  destroy() {
    if (this.workerClient) {
      this.workerClient.destroy('OffscreenRenderer destroyed');
      this.workerClient = null;
    }
    this.worker = null;

    this.offscreen = null;
    this.ctx = null;
    this.mainCtx = null;
    this.canvas = null;
    this.workerCanvasReady = false;
    this.canvasTransferred = false;
    this.sizePromise = null;
    this.isInitialized = false;
  }
}

/**
 * 创建 OffscreenRenderer 实例
 * @param {Object} options 配置选项
 * @returns {OffscreenRenderer}
 */
export function createOffscreenRenderer(options) {
  return new OffscreenRenderer(options);
}
