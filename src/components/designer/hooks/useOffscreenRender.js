import { ref, computed } from 'vue';
import {
  createOffscreenRenderer,
  isOffscreenCanvasSupported
} from '../../../core/render/OffscreenRenderer';
import { formatCellText } from '../utils/formatCellText';
import { getBorderProps } from '../utils/borderUtils';
import { calcMergeSize } from '../utils/cellUtils';

export default function useOffscreenRender(tableContext) {
  // OffscreenCanvas 相关状态
  const offscreenEnabled = ref(false);
  const offscreenRenderer = ref(null);
  const useOffscreen = ref(false);

  /**
   * 是否启用了离屏渲染
   */
  const isOffscreenActive = computed(() => {
    return useOffscreen.value && offscreenRenderer.value && offscreenRenderer.value.isUsingWorker();
  });

  /**
   * 初始化 OffscreenCanvas 渲染器
   * @param {Object} options 配置选项
   */
  function initOffscreenRenderer(options = {}) {
    if (!isOffscreenCanvasSupported()) {
      useOffscreen.value = false;
      offscreenEnabled.value = false;
      return false;
    }

    try {
      offscreenRenderer.value = createOffscreenRenderer({
        canvas: tableContext.refs.canvas.value,
        theme: tableContext.state.tableTheme,
        enableWorker: options.enableWorker !== false,
        timeout: options.timeout || 5000,
        onFallback: (error, info) => {
          useOffscreen.value = false;
          if (info && info.needsCanvasRebuild) {
            // canvas 控制权已转移给 worker，交由 Vue 重建全新 canvas 元素后回挂上下文
            tableContext.methods.rebuildContentCanvas();
          } else if (offscreenRenderer.value && offscreenRenderer.value.ctx) {
            tableContext.state.ctx = offscreenRenderer.value.ctx;
          }
        }
      });

      useOffscreen.value = offscreenRenderer.value.isUsingWorker();
      offscreenEnabled.value = true;
      return useOffscreen.value;
    } catch (error) {
      console.error('[OffscreenRenderHook] Failed to initialize:', error);
      useOffscreen.value = false;
      offscreenEnabled.value = false;
      return false;
    }
  }

  /**
   * 是否优先使用 Worker 渲染内容层
   */
  function shouldUseWorkerRender() {
    return !!(
      isOffscreenActive.value &&
      tableContext.state.width > 0 &&
      tableContext.state.height > 0 &&
      tableContext.props.workbook &&
      offscreenRenderer.value
    );
  }

  /**
   * 获取离屏渲染统计信息
   */
  function getOffscreenStats() {
    if (offscreenRenderer.value) {
      return offscreenRenderer.value.getStats();
    }
    return null;
  }

  /**
   * 收集边框数据
   */
  function _collectBorderData(r, c, x, y, w, h, border, batch, clipRect = null) {
    const bx = x + 0.5;
    const by = y + 0.5;

    const addLine = (p1, p2, color, style) => {
      let x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
      if (clipRect) {
        if (y1 === y2) {
          if (y1 < clipRect.minY || y1 > clipRect.maxY) return;
          const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
          const clampedLo = Math.max(lo, clipRect.minX);
          const clampedHi = Math.min(hi, clipRect.maxX);
          if (clampedHi <= clampedLo) return;
          x1 = clampedLo; x2 = clampedHi;
        } else if (x1 === x2) {
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
      addLine({ x: bx, y: by }, { x: bx + w, y: by }, color, style);
    }
    if (border.bottom) {
      const { color, style } = getBorderProps(border.bottom);
      addLine({ x: bx, y: by + h }, { x: bx + w, y: by + h }, color, style);
    }
    if (border.left) {
      const { color, style } = getBorderProps(border.left);
      addLine({ x: bx, y: by }, { x: bx, y: by + h }, color, style);
    }
    if (border.right) {
      const { color, style } = getBorderProps(border.right);
      addLine({ x: bx + w, y: by }, { x: bx + w, y: by + h }, color, style);
    }
  }

  /**
   * 准备渲染数据用于 Worker
   */
  function prepareRenderDataForWorker(visibleRange) {
    if (!tableContext.props.workbook) return null;

    const wb = tableContext.props.workbook;
    const {
      freezeR, freezeC, frozenWidth, frozenHeight,
      startRow, endRow, startCol, endCol,
      freezeEndRow, freezeEndCol,
      bodyStartX, bodyStartY
    } = visibleRange;

    const cellDataList = [];
    const bgGroups = {};
    const borderBatch = {};
    const skipGrid = true;

    const styleMapUsed = {};

    const collectCellData = (r, c, x, y, w, h, clipRect) => {
      const cell = wb.getCell(r, c);
      const s = cell ? cell.s : null;
      const val = wb.getCellValue(r, c);

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

      if (hasText || hasFormula) {
        let styleId = 0xFFFFFFFF;
        if (s && wb.styleCache) {
          styleId = wb.styleCache.normalize(s);
          if (styleMapUsed[styleId] === undefined) {
            styleMapUsed[styleId] = wb.styleCache.getStyle(styleId);
          }
        }

        cellData.text = {
          content: formatCellText(val, s),
          styleId
        };
      }

      cellDataList.push(cellData);

      if (s && s.border) {
        _collectBorderData(r, c, x, y, w, h, s.border, borderBatch, clipRect);
      }
    };

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

    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);
    const W = tableContext.state.width;
    const H = tableContext.state.height;

    const rowPos = wb.getRowPos ? wb.getRowPos(startRow) : 0;
    const colPos = wb.getColPos ? wb.getColPos(startCol) : 0;
    const vyBody = CH + (rowPos || 0) - (tableContext.state.scrollY || 0);
    const vxBody = RW + (colPos || 0) - (tableContext.state.scrollX || 0);
    collectRange(startRow, endRow, startCol, endCol, vxBody, vyBody, {
      minX: bodyStartX,
      minY: bodyStartY,
      maxX: W,
      maxY: H
    });

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
      skipGrid,
      theme: tableContext.state.tableTheme,
      width: tableContext.state.width,
      height: tableContext.state.height,
      styleMap: styleMapUsed
    };
  }

  /**
   * 使用 Worker 进行异步渲染
   */
  async function renderWithWorker(renderData) {
    if (!offscreenRenderer.value || !useOffscreen.value) {
      return { success: false, error: 'Worker not available' };
    }

    try {
      const result = await offscreenRenderer.value.render(renderData);
      return result;
    } catch (error) {
      console.error('[OffscreenRenderHook] Worker render error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 使用 Worker 渲染当前内容层
   */
  async function _renderContentWithWorker() {
    if (!shouldUseWorkerRender()) return false;

    const RW = tableContext.computed.rowHeaderWidth.value;
    const CH = tableContext.computed.colHeaderHeight.value;

    const renderRect = !tableContext.state.fullRedraw && tableContext.state.dirtyRect
      ? { ...tableContext.state.dirtyRect }
      : {
          x: RW,
          y: CH,
          w: tableContext.state.width - RW,
          h: tableContext.state.height - CH
        };

    if (renderRect.x < RW) {
      renderRect.w -= (RW - renderRect.x);
      renderRect.x = RW;
    }
    if (renderRect.y < CH) {
      renderRect.h -= (CH - renderRect.y);
      renderRect.y = CH;
    }

    if (renderRect.w <= 0 || renderRect.h <= 0) return true;

    const visibleRange = tableContext.methods._getVisibleRange();
    if (!visibleRange) return false;

    const fw = visibleRange.frozenWidth || 0;
    const fh = visibleRange.frozenHeight || 0;
    if (fw > 0 || fh > 0) {
      let x1 = renderRect.x;
      let y1 = renderRect.y;
      let x2 = renderRect.x + renderRect.w;
      let y2 = renderRect.y + renderRect.h;
      if (fw > 0) {
        x1 = Math.min(x1, RW);
        x2 = Math.max(x2, RW + fw);
        y1 = Math.min(y1, CH);
        y2 = Math.max(y2, tableContext.state.height);
      }
      if (fh > 0) {
        x1 = Math.min(x1, RW);
        x2 = Math.max(x2, tableContext.state.width);
        y1 = Math.min(y1, CH);
        y2 = Math.max(y2, CH + fh);
      }
      renderRect.x = x1;
      renderRect.y = y1;
      renderRect.w = x2 - x1;
      renderRect.h = y2 - y1;
    }

    const renderData = prepareRenderDataForWorker(visibleRange);
    if (!renderData) return false;

    const result = await renderWithWorker({
      ...renderData,
      renderRect
    });

    if (!result || !result.success) {
      if (!offscreenRenderer.value || !offscreenRenderer.value.isUsingWorker()) {
        useOffscreen.value = false;
      }
      return false;
    }

    tableContext.state.fullRedraw = false;
    tableContext.state.dirtyRect = null;
    return true;
  }

  /**
   * 销毁离屏渲染器
   */
  function destroyOffscreenRenderer() {
    if (offscreenRenderer.value) {
      offscreenRenderer.value.destroy();
      offscreenRenderer.value = null;
    }
    useOffscreen.value = false;
    offscreenEnabled.value = false;
  }

  return {
    offscreenEnabled,
    offscreenRenderer,
    useOffscreen,
    isOffscreenActive,
    initOffscreenRenderer,
    shouldUseWorkerRender,
    getOffscreenStats,
    prepareRenderDataForWorker,
    renderWithWorker,
    _renderContentWithWorker,
    destroyOffscreenRenderer
  };
}
