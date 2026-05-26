/**
 * 渐进式渲染 Mixin
 *
 * 将 ProgressiveRenderer 集成到 Canvas 渲染流程中
 * 实现分帧渲染以保证 UI 流畅度
 */

import {
  createProgressiveRenderer,
  Priority,
} from '../../../render/ProgressiveRenderer';

// 渐进式渲染配置
const PROGRESSIVE_CONFIG = {
  // 每帧时间预算（ms）
  frameBudget: 8,
  // 每帧最大任务数
  maxTasksPerFrame: 5,
  // 行分块大小
  rowsPerChunk: 10,
  // 列分块大小
  colsPerChunk: 10,
  // 是否启用渐进式渲染（数据量阈值）
  enableThreshold: 1000, // 单元格数超过此值启用渐进式渲染
  // 是否使用 requestIdleCallback
  useIdleCallback: true
};

export default {
  data() {
    return {
      // 渐进式渲染器实例
      progressiveRenderer: null,
      // 是否启用渐进式渲染
      progressiveEnabled: false,
      // 渐进式渲染状态
      progressiveState: {
        isRendering: false,
        progress: 0,
        phase: 'idle' // idle, collecting, rendering, complete
      },
      // 收集的单元格数据缓存
      collectedCellData: {
        backgrounds: {},
        gridLines: [],
        texts: [],
        borders: {}
      }
    };
  },

  methods: {
    /**
     * 初始化渐进式渲染器
     */
    initProgressiveRenderer() {
      if (this.progressiveRenderer) {
        this.progressiveRenderer.destroy();
      }

      this.progressiveRenderer = createProgressiveRenderer({
        frameBudget: PROGRESSIVE_CONFIG.frameBudget,
        maxTasksPerFrame: PROGRESSIVE_CONFIG.maxTasksPerFrame,
        useIdleCallback: PROGRESSIVE_CONFIG.useIdleCallback
      });

      // 设置帧开始回调
      this.progressiveRenderer.onFrameStart = (remainingTime) => {
        // 可以在这里做一些帧前准备工作
      };

      // 设置帧结束回调
      this.progressiveRenderer.onFrameEnd = (frameTime, tasksExecuted) => {
        // 如果帧时间超过预算，记录警告
        if (frameTime > PROGRESSIVE_CONFIG.frameBudget * 1.5) {
          console.warn(`[ProgressiveRender] Frame time ${frameTime.toFixed(2)}ms exceeded budget`);
        }
      };

      // 设置所有任务完成回调
      this.progressiveRenderer.onAllTasksComplete = () => {
        this.progressiveState.isRendering = false;
        this.progressiveState.phase = 'complete';
        this.progressiveState.progress = 1;
        
        // 触发最终绘制
        this._flushCollectedData();
        
        // 触发完成事件
        this.$emit('progressive-render-complete');
      };
    },

    /**
     * 销毁渐进式渲染器
     */
    destroyProgressiveRenderer() {
      if (this.progressiveRenderer) {
        this.progressiveRenderer.destroy();
        this.progressiveRenderer = null;
      }
      this._clearCollectedData();
    },

    /**
     * 检查是否应该启用渐进式渲染
     * @returns {boolean}
     */
    shouldUseProgressiveRender() {
      if (!this.workbook) return false;
      
      const visibleRange = this._getVisibleRange();
      if (!visibleRange) return false;
      
      // 只按真实视口计算是否启用渐进渲染，避免缓冲行列让普通滚动也误入渐进流程。
      const bodyCells = (visibleRange.exactEndRow - visibleRange.exactStartRow + 1) *
                        (visibleRange.exactEndCol - visibleRange.exactStartCol + 1);
      
      // 计算冻结区域的单元格数量
      const freezeCells = Math.max(0, visibleRange.freezeEndRow + 1) *
                          Math.max(0, visibleRange.freezeEndCol + 1);
      
      const totalCells = bodyCells + freezeCells;
      
      return totalCells > PROGRESSIVE_CONFIG.enableThreshold;
    },

    /**
     * 开始渐进式渲染
     */
    startProgressiveRender() {
      if (!this.progressiveRenderer) {
        this.initProgressiveRenderer();
      }

      // 清空之前的任务和数据，同时取消已经排队的旧帧，避免旧滚动位置的任务回写画布。
      this.progressiveRenderer.stop();
      this.progressiveRenderer.clearAll();
      this._clearCollectedData();
      this.ctx.clearRect(0, 0, this.width, this.height);

      // 更新状态
      this.progressiveState.isRendering = true;
      this.progressiveState.phase = 'collecting';
      this.progressiveState.progress = 0;

      const visibleRange = this._getVisibleRange();
      if (!visibleRange) return;

      // 生成渲染任务
      const tasks = this._generateRenderTasks(visibleRange);
      
      // 添加任务
      this.progressiveRenderer.addTasks(tasks);
      
      // 开始调度
      this.progressiveRenderer.start();
    },

    /**
     * 停止渐进式渲染
     */
    stopProgressiveRender() {
      if (this.progressiveRenderer) {
        this.progressiveRenderer.stop();
      }
      this.progressiveState.isRendering = false;
      this.progressiveState.phase = 'idle';
    },

    /**
     * 暂停渐进式渲染
     */
    pauseProgressiveRender() {
      if (this.progressiveRenderer) {
        this.progressiveRenderer.pause();
      }
    },

    /**
     * 恢复渐进式渲染
     */
    resumeProgressiveRender() {
      if (this.progressiveRenderer) {
        this.progressiveRenderer.resume();
      }
    },

    /**
     * 生成渲染任务
     * @param {Object} visibleRange - 可见范围
     * @returns {Array<Object>}
     */
    _generateRenderTasks(visibleRange) {
      const tasks = [];
      const wb = this.workbook;
      const ctx = this.ctx;
      
      const {
        freezeR, freezeC,
        startRow, endRow, startCol, endCol,
        freezeEndRow, freezeEndCol,
        bodyStartX, bodyStartY,
        frozenWidth, frozenHeight
      } = visibleRange;

      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);

      // 计算偏移量
      const vyBody = CH + wb.getRowPos(startRow) - this.scrollY;
      const vxBody = RW + wb.getColPos(startCol) - this.scrollX;

      // 1. 冻结区域任务（最高优先级）
      if (freezeR > 0 && freezeC > 0) {
        tasks.push(this._createAreaRenderTask({
          id: 'freeze-corner',
          priority: Priority.CRITICAL,
          startRow: 0,
          endRow: freezeEndRow,
          startCol: 0,
          endCol: freezeEndCol,
          offsetX: RW,
          offsetY: CH,
          clipRect: {
            x: RW,
            y: CH,
            w: frozenWidth,
            h: frozenHeight
          }
        }));
      }

      // 2. 冻结行任务
      if (freezeR > 0) {
        tasks.push(this._createAreaRenderTask({
          id: 'freeze-top',
          priority: Priority.CRITICAL,
          startRow: 0,
          endRow: freezeEndRow,
          startCol,
          endCol,
          offsetX: vxBody,
          offsetY: CH,
          clipRect: {
            x: bodyStartX,
            y: CH,
            w: this.width - bodyStartX,
            h: frozenHeight
          }
        }));
      }

      // 3. 冻结列任务
      if (freezeC > 0) {
        tasks.push(this._createAreaRenderTask({
          id: 'freeze-left',
          priority: Priority.CRITICAL,
          startRow,
          endRow,
          startCol: 0,
          endCol: freezeEndCol,
          offsetX: RW,
          offsetY: vyBody,
          clipRect: {
            x: RW,
            y: bodyStartY,
            w: frozenWidth,
            h: this.height - bodyStartY
          }
        }));
      }

      // 4. 主体区域任务（按行分块）
      const rowsPerChunk = PROGRESSIVE_CONFIG.rowsPerChunk;
      let taskId = 0;
      
      for (let r = startRow; r <= endRow; r += rowsPerChunk) {
        const chunkEndRow = Math.min(r + rowsPerChunk - 1, endRow);
        
        // 计算优先级：靠近可见区域中心的更高
        const centerRow = (startRow + endRow) / 2;
        const distance = Math.abs(r - centerRow);
        const priority = distance < rowsPerChunk * 2 ? Priority.HIGH : Priority.NORMAL;
        
        tasks.push(this._createAreaRenderTask({
          id: `body-chunk-${taskId++}`,
          priority,
          startRow: r,
          endRow: chunkEndRow,
          startCol,
          endCol,
          offsetX: vxBody,
          offsetY: CH + wb.getRowPos(r) - this.scrollY,
          clipRect: {
            x: bodyStartX,
            y: bodyStartY,
            w: this.width - bodyStartX,
            h: this.height - bodyStartY
          }
        }));
      }

      // 注意：由于开启了分层渲染，行列头由 gridCanvas 负责，渐进式渲染不再包含表头任务

      return tasks;
    },

    /**
     * 创建区域渲染任务
     * @param {Object} options
     * @returns {Object}
     */
    _createAreaRenderTask(options) {
      const {
        id,
        priority,
        startRow,
        endRow,
        startCol,
        endCol,
        offsetX,
        offsetY,
        clipRect
      } = options;

      return {
        id,
        priority,
        estimatedTime: 2,
        execute: (context) => {
          // 执行区域渲染
          this._renderAreaProgressive(
            startRow, endRow, startCol, endCol, offsetX, offsetY, clipRect
          );
          return { done: true, progress: 1 };
        }
      };
    },

    /**
     * 创建表头渲染任务
     * @param {Object} options
     * @returns {Object}
     */
    _createHeaderRenderTask(options) {
      const { id, priority, type, startCol, endCol, startRow, endRow, offsetX, offsetY, clipRect } = options;
      const wb = this.workbook;

      return {
        id,
        priority,
        estimatedTime: 1,
        execute: (context) => {
          const ctx = this.ctx;

          ctx.save();
          if (clipRect) {
            ctx.beginPath();
            ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
            ctx.clip();
            ctx.clearRect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
          }
          
          if (type === 'col') {
            let cx = offsetX;
            for (let c = startCol; c <= endCol; c++) {
              const w = wb.getColWidth(c);
              this.drawColHeader(ctx, c, cx, w, this.colHeaderHeight);
              cx += w;
            }
          } else if (type === 'row') {
            let ry = offsetY;
            for (let r = startRow; r <= endRow; r++) {
              const h = wb.getRowHeight(r);
              this.drawRowHeader(ctx, r, ry, this.rowHeaderWidth, h);
              ry += h;
            }
          }

          ctx.restore();
          
          return { done: true, progress: 1 };
        }
      };
    },

    /**
     * 渐进式区域渲染
     * 收集数据并立即绘制
     */
    _renderAreaProgressive(startRow, endRow, startCol, endCol, offsetX, offsetY, clipRect = null) {
      const ctx = this.ctx;
      const wb = this.workbook;
      const W = this.width;
      const H = this.height;

      const cellDataList = [];
      const borderBatch = {};

      ctx.save();
      if (clipRect) {
        ctx.beginPath();
        ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
        ctx.clip();
      }

      let vy = offsetY;
      for (let r = startRow; r <= endRow; r++) {
        const h = wb.getRowHeight(r);
        if (vy + h > 0 && vy < H) {
          let cx = offsetX;
          for (let c = startCol; c <= endCol; c++) {
            const w = wb.getColWidth(c);
            if (cx + w > 0 && cx < W) {
              const merge = wb.getMerge(r, c);
              if (merge) {
                if (merge.s.r === r && merge.s.c === c) {
                  let mw = 0; for (let i = c; i <= merge.e.c; i++) mw += wb.getColWidth(i);
                  let mh = 0; for (let i = r; i <= merge.e.r; i++) mh += wb.getRowHeight(i);
                  
                  cellDataList.push(this.collectCellData(r, c, cx, vy, mw, mh));
                  this.drawCellBorders(ctx, r, c, cx, vy, mw, mh, borderBatch);
                }
              } else {
                cellDataList.push(this.collectCellData(r, c, cx, vy, w, h));
                this.drawCellBorders(ctx, r, c, cx, vy, w, h, borderBatch);
              }
            }
            cx += w;
            if (cx > W) break;
          }
        }
        vy += h;
        if (vy > H) break;
      }

      // 立即绘制这个区域
      if (cellDataList.length > 0) {
        this.drawCellsBatched(ctx, cellDataList);
        this._drawBatchedBorders(ctx, borderBatch);
      }

      ctx.restore();
    },

    /**
     * 清空收集的数据
     */
    _clearCollectedData() {
      this.collectedCellData = {
        backgrounds: {},
        gridLines: [],
        texts: [],
        borders: {}
      };
    },

    /**
     * 刷新收集的数据到画布
     */
    _flushCollectedData() {
      // 用于批量模式（当前未使用，保留扩展）
    },

    /**
     * 获取渐进式渲染状态
     * @returns {Object}
     */
    getProgressiveState() {
      return {
        ...this.progressiveState,
        rendererStats: this.progressiveRenderer ? this.progressiveRenderer.getStats() : null
      };
    },

    /**
     * 智能渲染 - 根据数据量自动选择渲染模式
     * 替代原有的 render 方法
     */
    smartRender() {
      if (!this.ctx || !this.workbook) return;

      // 检查是否应该使用渐进式渲染
      const useProgressive = this.shouldUseProgressiveRender();

      if (useProgressive) {
        // 使用渐进式渲染
        if (!this.progressiveState.isRendering) {
          this.startProgressiveRender();
        }
      } else {
        // 使用传统渲染
        this._renderContent();
      }
    }
  }
};
