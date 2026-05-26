/**
 * OffscreenCanvas 渲染混入
 * 
 * 扩展 CanvasRenderMixin，支持在 Worker 中进行 Canvas 渲染
 * 当 OffscreenCanvas 不可用时自动降级到主线程渲染
 */

import {
  createOffscreenRenderer,
  isOffscreenCanvasSupported
} from '../../../core/render/OffscreenRenderer';

export default {
  data() {
    return {
      // OffscreenCanvas 相关状态
      offscreenEnabled: false,
      offscreenRenderer: null,
      useOffscreen: false,
      offscreenStats: null
    };
  },

  computed: {
    /**
     * 是否启用了离屏渲染
     */
    isOffscreenActive() {
      return this.useOffscreen && this.offscreenRenderer && this.offscreenRenderer.isUsingWorker();
    }
  },

  methods: {
    /**
     * 初始化 OffscreenCanvas 渲染器
     * 在 CanvasTable.vue 的 mounted 钩子中调用
     * @param {Object} options 配置选项
     */
    initOffscreenRenderer(options = {}) {
      // 检查是否支持
      if (!isOffscreenCanvasSupported()) {
        this.useOffscreen = false;
        this.offscreenEnabled = false;
        return false;
      }

      try {
        this.offscreenRenderer = createOffscreenRenderer({
          canvas: this.$refs.canvas,
          theme: this.tableTheme,
          enableWorker: options.enableWorker !== false,
          timeout: options.timeout || 5000,
          onFallback: () => {
            // Worker 初始化失败是预期行为，静默降级到主线程渲染
            this.useOffscreen = false;
            if (this.offscreenRenderer && this.offscreenRenderer.ctx) {
              this.ctx = this.offscreenRenderer.ctx;
            }
          }
        });

        this.useOffscreen = this.offscreenRenderer.isUsingWorker();
        this.offscreenEnabled = true;
        return this.useOffscreen;
      } catch (error) {
        console.error('[OffscreenRenderMixin] Failed to initialize:', error);
        this.useOffscreen = false;
        this.offscreenEnabled = false;
        return false;
      }
    },

    /**
     * 是否优先使用 Worker 渲染内容层
     * @returns {boolean}
     */
    shouldUseWorkerRender() {
      return !!(
        this.isOffscreenActive &&
        this.width > 0 &&
        this.height > 0 &&
        this.workbook &&
        this.offscreenRenderer &&
        typeof this.prepareRenderDataForWorker === 'function' &&
        typeof this.renderWithWorker === 'function'
      );
    },

    /**
     * 启用离屏渲染
     */
    enableOffscreen() {
      if (this.offscreenRenderer && this.offscreenEnabled) {
        this.useOffscreen = true;
      }
    },

    /**
     * 禁用离屏渲染（降级到主线程）
     */
    disableOffscreen() {
      if (this.offscreenRenderer) {
        this.offscreenRenderer.forceFallback();
        this.useOffscreen = false;
      }
    },

    /**
     * 获取离屏渲染统计信息
     * @returns {Object|null} 统计信息
     */
    getOffscreenStats() {
      if (this.offscreenRenderer) {
        return this.offscreenRenderer.getStats();
      }
      return null;
    },

    /**
     * 打印离屏渲染统计信息
     */
    printOffscreenStats() {
      const stats = this.getOffscreenStats();
      if (stats) {
        console.log('[OffscreenRenderMixin] Stats:', {
          totalRenders: stats.totalRenders,
          workerRenders: stats.workerRenders,
          mainThreadRenders: stats.mainThreadRenders,
          avgRenderTime: stats.avgRenderTime.toFixed(2) + 'ms',
          avgWorkerRenderTime: stats.avgWorkerRenderTime.toFixed(2) + 'ms',
          avgMainThreadRenderTime: stats.avgMainThreadRenderTime.toFixed(2) + 'ms',
          workerRatio: (stats.workerRenderRatio * 100).toFixed(1) + '%',
          fallbackCount: stats.fallbackCount
        });
      }
    },

    /**
     * 准备渲染数据用于 Worker
     * 将单元格数据序列化为可传输格式
     * @param {Object} visibleRange 可见范围
     * @returns {Object} 渲染数据
     */
    prepareRenderDataForWorker(visibleRange) {
      if (!this.workbook) return null;

      const wb = this.workbook;
      const {
        freezeR, freezeC, frozenWidth, frozenHeight,
        startRow, endRow, startCol, endCol,
        freezeEndRow, freezeEndCol,
        bodyStartX, bodyStartY
      } = visibleRange;

      const cellDataList = [];
      const bgGroups = {};
      const gridLines = [];
      const borderBatch = {};
      const colHeaders = [];
      const rowHeaders = [];
      const frozenLines = [];
      const skipGrid = true; // 开启分层后，主 Worker 不再渲染网格

      const styleMapUsed = {};

      // 辅助函数：收集单元格数据
      const collectCellData = (r, c, x, y, w, h) => {
        const cell = wb.getCell(r, c);
        const s = cell ? cell.s : null;
        const val = wb.getCellValue(r, c);
        
        // 性能优化：跳过完全空的单元格（无内容、无公式、无背景、无边框）
        // 这与 CanvasRenderMixin.js 中的 isEmpty 逻辑一致
        const hasText = val !== null && val !== undefined && val !== '';
        const hasFormula = !!(cell && cell.f);
        const hasBg = !!(s && (s.bg || s.bgcolor));
        const hasBorder = !!(s && s.border);
        
        if (!hasText && !hasFormula && !hasBg && !hasBorder) {
            return;
        }

        const cellData = {
          r, c, x, y, w, h,
          bg: hasBg ? (s.bg || s.bgcolor) : null,
          text: null
        };

        // 只有明确设置了背景色才收集，避免遮挡底层的网格线
        if (cellData.bg) {
          if (!bgGroups[cellData.bg]) bgGroups[cellData.bg] = [];
          bgGroups[cellData.bg].push(x, y, w, h);
        }

        // 收集网格线
        if (!skipGrid) {
          gridLines.push(x, y, w, h);
        }

        // 收集文本数据
        if (hasText || hasFormula) {
          // 获取并记录样式 ID
          let styleId = 0xFFFFFFFF;
          if (s && wb.styleCache) {
            styleId = wb.styleCache.normalize(s);
            if (styleMapUsed[styleId] === undefined) {
              styleMapUsed[styleId] = wb.styleCache.getStyle(styleId);
            }
          }

          cellData.text = {
            content: String(val),
            styleId // 仅传输 ID，不再预计算 font, color, align 等字符串
          };
        }

        cellDataList.push(cellData);

        // 收集边框
        if (s && s.border) {
          this._collectBorderData(r, c, x, y, w, h, s.border, borderBatch);
        }
      };

      // 收集范围数据
      const collectRange = (rStart, rEnd, cStart, cEnd, offsetX, offsetY) => {
        let vy = offsetY;
        for (let r = rStart; r <= rEnd; r++) {
          const h = wb.getRowHeight(r);
          let cx = offsetX;
          
          for (let c = cStart; c <= cEnd; c++) {
            const w = wb.getColWidth(c);
            
            const merge = wb.getMerge(r, c);
            if (merge) {
              if (merge.s.r === r && merge.s.c === c) {
                let mw = 0; for (let i = c; i <= merge.e.c; i++) mw += wb.getColWidth(i);
                let mh = 0; for (let i = r; i <= merge.e.r; i++) mh += wb.getRowHeight(i);
                collectCellData(r, c, cx, vy, mw, mh);
              }
            } else {
              collectCellData(r, c, cx, vy, w, h);
            }
            
            cx += w;
          }
          vy += h;
        }
      };

      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);

      // 收集主体区域
      const rowPos = wb.getRowPos ? wb.getRowPos(startRow) : 0;
      const colPos = wb.getColPos ? wb.getColPos(startCol) : 0;
      const vyBody = CH + (rowPos || 0) - (this.scrollY || 0);
      const vxBody = RW + (colPos || 0) - (this.scrollX || 0);
      collectRange(startRow, endRow, startCol, endCol, vxBody, vyBody);

      // 收集冻结区域
      if (freezeR > 0) {
        collectRange(0, freezeEndRow, startCol, endCol, vxBody, CH);
      }
      if (freezeC > 0) {
        collectRange(startRow, endRow, 0, freezeEndCol, RW, vyBody);
      }
      if (freezeR > 0 && freezeC > 0) {
        collectRange(0, freezeEndRow, 0, freezeEndCol, RW, CH);
      }

      // 注意：由于开启了分层渲染 (skipGrid = true)，网格线、表头和冻结线由主线程 gridCanvas 负责
      // Worker 仅负责单元格内容渲染，因此不再收集这些冗余数据，减少传输开销

      return {
        cellDataList,
        bgGroups,
        gridLines,
        borderBatch,
        colHeaders,
        rowHeaders,
        frozenLines,
        skipGrid, // 传递给 Worker
        theme: this.tableTheme,
        width: this.width,
        height: this.height,
        styleMap: styleMapUsed
      };
    },

    /**
     * 使用 Worker 渲染当前内容层
     * @returns {Promise<boolean>} 是否由 Worker 成功完成渲染
     */
    async _renderContentWithWorker() {
      if (!this.shouldUseWorkerRender()) return false;

      const renderRect = !this.fullRedraw && this.dirtyRect
        ? { ...this.dirtyRect }
        : { 
            x: this.rowHeaderWidth, 
            y: this.colHeaderHeight, 
            w: this.width - this.rowHeaderWidth, 
            h: this.height - this.colHeaderHeight 
          };

      // 强制约束在内容区域，防止脏矩形包含表头
      if (renderRect.x < this.rowHeaderWidth) {
        renderRect.w -= (this.rowHeaderWidth - renderRect.x);
        renderRect.x = this.rowHeaderWidth;
      }
      if (renderRect.y < this.colHeaderHeight) {
        renderRect.h -= (this.colHeaderHeight - renderRect.y);
        renderRect.y = this.colHeaderHeight;
      }

      if (renderRect.w <= 0 || renderRect.h <= 0) return true;

      const visibleRange = this._getVisibleRange();
      if (!visibleRange) return false;

      const renderData = this.prepareRenderDataForWorker(visibleRange);
      if (!renderData) return false;

      const result = await this.renderWithWorker({
        ...renderData,
        renderRect
      });

      if (!result || !result.success) {
        if (!this.offscreenRenderer || !this.offscreenRenderer.isUsingWorker()) {
          this.useOffscreen = false;
        }
        return false;
      }

      this.fullRedraw = false;
      this.dirtyRect = null;
      this.offscreenStats = this.getOffscreenStats();
      return true;
    },

    /**
     * 收集边框数据
     * @private
     */
    _collectBorderData(r, c, x, y, w, h, border, batch) {
      const getBorderProps = (b) => {
        if (typeof b === 'string') return { color: b, style: 'solid' };
        const color = (b && b.color) ? b.color : '#000000';
        const style = (b && b.style) ? b.style : 'solid';
        return { color, style };
      };

      const bx = x + 0.5;
      const by = y + 0.5;

      const addLine = (p1, p2, color, style) => {
        const key = `${color}|${style}`;
        if (!batch[key]) batch[key] = [];
        batch[key].push(p1.x, p1.y, p2.x, p2.y);
      };

      if (border.top) {
        const { color, style } = getBorderProps(border.top);
        addLine({x: bx, y: by}, {x: bx + w, y: by}, color, style);
      }
      if (border.bottom) {
        const { color, style } = getBorderProps(border.bottom);
        addLine({x: bx, y: by + h}, {x: bx + w, y: by + h}, color, style);
      }
      if (border.left) {
        const { color, style } = getBorderProps(border.left);
        addLine({x: bx, y: by}, {x: bx, y: by + h}, color, style);
      }
      if (border.right) {
        const { color, style } = getBorderProps(border.right);
        addLine({x: bx + w, y: by}, {x: bx + w, y: by + h}, color, style);
      }
    },

    /**
     * 使用 Worker 渲染（异步）
     * @param {Object} renderData 渲染数据
     * @returns {Promise<Object>} 渲染结果
     */
    async renderWithWorker(renderData) {
      if (!this.offscreenRenderer || !this.useOffscreen) {
        return { success: false, error: 'Worker not available' };
      }

      try {
        const result = await this.offscreenRenderer.render(renderData);
        return result;
      } catch (error) {
        console.error('[OffscreenRenderMixin] Worker render error:', error);
        return { success: false, error: error.message };
      }
    },

    /**
     * 销毁离屏渲染器
     */
    destroyOffscreenRenderer() {
      if (this.offscreenRenderer) {
        this.offscreenRenderer.destroy();
        this.offscreenRenderer = null;
      }
      this.useOffscreen = false;
      this.offscreenEnabled = false;
    }
  }
};
