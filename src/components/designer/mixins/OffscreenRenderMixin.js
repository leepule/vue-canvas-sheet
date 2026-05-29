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
import { formatCellText } from '../utils/formatCellText';
import { getBorderProps } from '../utils/borderUtils';
import { calcMergeSize } from '../utils/cellUtils';

export default {
  data() {
    return {
      // OffscreenCanvas 相关状态
      offscreenEnabled: false,
      offscreenRenderer: null,
      useOffscreen: false
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
      const borderBatch = {};
      const skipGrid = true; // 开启分层后，主 Worker 不再渲染网格

      const styleMapUsed = {};

      // 辅助函数：收集单元格数据
      const collectCellData = (r, c, x, y, w, h, clipRect) => {
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
          text: null,
          clip: clipRect ? { x: clipRect.minX, y: clipRect.minY, w: clipRect.maxX - clipRect.minX, h: clipRect.maxY - clipRect.minY } : null
        };

        // 只有明确设置了背景色才收集，避免遮挡底层的网格线
        // 按区域 clipRect 裁剪 bg 矩形，避免主体单元格的底色越界画到冻结区
        if (cellData.bg) {
          let bx = x, by = y, bw = w, bh = h;
          if (clipRect) {
            const cx1 = Math.max(x, clipRect.minX);
            const cy1 = Math.max(y, clipRect.minY);
            const cx2 = Math.min(x + w, clipRect.maxX);
            const cy2 = Math.min(y + h, clipRect.maxY);
            bx = cx1; by = cy1; bw = cx2 - cx1; bh = cy2 - cy1;
          }
          if (bw > 0 && bh > 0) {
            if (!bgGroups[cellData.bg]) bgGroups[cellData.bg] = [];
            bgGroups[cellData.bg].push(bx, by, bw, bh);
          }
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
            content: formatCellText(val, s),
            styleId // 仅传输 ID，不再预计算 font, color, align 等字符串
          };
        }

        cellDataList.push(cellData);

        // 收集边框（传入区域 clipRect，避免主体单元格的边框线越界画入冻结区）
        if (s && s.border) {
          this._collectBorderData(r, c, x, y, w, h, s.border, borderBatch, clipRect);
        }
      };

      // 收集范围数据 (增加基于裁剪矩形的物理过滤，防止不同区域单元格在Worker中被重复叠加绘制)
      const collectRange = (rStart, rEnd, cStart, cEnd, offsetX, offsetY, clipRect) => {
        let vy = offsetY;
        for (let r = rStart; r <= rEnd; r++) {
          const h = wb.getRowHeight(r);
          let cx = offsetX;
          
          for (let c = cStart; c <= cEnd; c++) {
            const w = wb.getColWidth(c);
            
            const merge = wb.getMerge(r, c);
            if (merge) {
              if (merge.s.r === r && merge.s.c === c) {
                const { mw, mh } = calcMergeSize(wb, merge, r, c);

                const cellX = cx;
                const cellY = vy;
                if (!clipRect || (cellX + mw > clipRect.minX && cellX < clipRect.maxX && cellY + mh > clipRect.minY && cellY < clipRect.maxY)) {
                  collectCellData(r, c, cx, vy, mw, mh, clipRect);
                }
              }
            } else {
              const cellX = cx;
              const cellY = vy;
              if (!clipRect || (cellX + w > clipRect.minX && cellX < clipRect.maxX && cellY + h > clipRect.minY && cellY < clipRect.maxY)) {
                collectCellData(r, c, cx, vy, w, h, clipRect);
              }
            }
            
            cx += w;
          }
          vy += h;
        }
      };

      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);
      const W = this.width;
      const H = this.height;

      // 收集主体区域
      const rowPos = wb.getRowPos ? wb.getRowPos(startRow) : 0;
      const colPos = wb.getColPos ? wb.getColPos(startCol) : 0;
      const vyBody = CH + (rowPos || 0) - (this.scrollY || 0);
      const vxBody = RW + (colPos || 0) - (this.scrollX || 0);
      collectRange(startRow, endRow, startCol, endCol, vxBody, vyBody, {
        minX: bodyStartX,
        minY: bodyStartY,
        maxX: W,
        maxY: H
      });

      // 收集冻结区域
      if (freezeR > 0) {
        collectRange(0, freezeEndRow, startCol, endCol, vxBody, CH, {
          minX: bodyStartX,
          minY: CH,
          maxX: W,
          maxY: bodyStartY
        });
      }
      if (freezeC > 0) {
        collectRange(startRow, endRow, 0, freezeEndCol, RW, vyBody, {
          minX: RW,
          minY: bodyStartY,
          maxX: bodyStartX,
          maxY: H
        });
      }
      if (freezeR > 0 && freezeC > 0) {
        collectRange(0, freezeEndRow, 0, freezeEndCol, RW, CH, {
          minX: RW,
          minY: CH,
          maxX: bodyStartX,
          maxY: bodyStartY
        });
      }

      // 注意：由于开启了分层渲染 (skipGrid = true)，网格线、表头和冻结线由主线程 gridCanvas 负责
      // Worker 仅负责单元格内容渲染，因此不再收集这些冗余数据，减少传输开销

      // 冻结区域几何信息，让 Worker 在绘制前填充不透明底色，避免主体内容透出
      const frozenRegions = [];
      if (freezeC > 0) {
        frozenRegions.push({ x: RW, y: bodyStartY, w: frozenWidth, h: H - bodyStartY });
      }
      if (freezeR > 0) {
        frozenRegions.push({ x: bodyStartX, y: CH, w: W - bodyStartX, h: frozenHeight });
      }
      if (freezeR > 0 && freezeC > 0) {
        frozenRegions.push({ x: RW, y: CH, w: frozenWidth, h: frozenHeight });
      }

      return {
        cellDataList,
        bgGroups,
        borderBatch,
        frozenRegions,
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

      // 部分重绘时把冻结区域并入脏矩形，保证 Worker 能填充不透明底色并重绘冻结单元格
      const fw = visibleRange.frozenWidth || 0;
      const fh = visibleRange.frozenHeight || 0;
      if (fw > 0 || fh > 0) {
        const RW = this.rowHeaderWidth;
        const CH = this.colHeaderHeight;
        let x1 = renderRect.x;
        let y1 = renderRect.y;
        let x2 = renderRect.x + renderRect.w;
        let y2 = renderRect.y + renderRect.h;
        // 冻结列：宽 fw，纵跨整个内容区
        if (fw > 0) {
          x1 = Math.min(x1, RW);
          x2 = Math.max(x2, RW + fw);
          y1 = Math.min(y1, CH);
          y2 = Math.max(y2, this.height);
        }
        // 冻结行：高 fh，横跨整个内容区
        if (fh > 0) {
          x1 = Math.min(x1, RW);
          x2 = Math.max(x2, this.width);
          y1 = Math.min(y1, CH);
          y2 = Math.max(y2, CH + fh);
        }
        renderRect.x = x1;
        renderRect.y = y1;
        renderRect.w = x2 - x1;
        renderRect.h = y2 - y1;
      }

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
      return true;
    },

    /**
     * 收集边框数据
     * @private
     */
    _collectBorderData(r, c, x, y, w, h, border, batch, clipRect = null) {
      const bx = x + 0.5;
      const by = y + 0.5;

      // 把线段按 clipRect 物理裁剪（水平/垂直线，AABB clamp 即可），
      // 完全落在 clipRect 外的线段会被丢弃；这样 Worker 中无需对 borderBatch 做区域裁剪
      const addLine = (p1, p2, color, style) => {
        let x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
        if (clipRect) {
          if (y1 === y2) {
            // 水平线
            if (y1 < clipRect.minY || y1 > clipRect.maxY) return;
            const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
            const clampedLo = Math.max(lo, clipRect.minX);
            const clampedHi = Math.min(hi, clipRect.maxX);
            if (clampedHi <= clampedLo) return;
            x1 = clampedLo; x2 = clampedHi;
          } else if (x1 === x2) {
            // 垂直线
            if (x1 < clipRect.minX || x1 > clipRect.maxX) return;
            const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
            const clampedLo = Math.max(lo, clipRect.minY);
            const clampedHi = Math.min(hi, clipRect.maxY);
            if (clampedHi <= clampedLo) return;
            y1 = clampedLo; y2 = clampedHi;
          }
        }
        const key = `${color}|${style}`;
        if (!batch[key]) batch[key] = [];
        batch[key].push(x1, y1, x2, y2);
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
