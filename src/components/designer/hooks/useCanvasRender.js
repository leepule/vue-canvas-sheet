import { debounce } from 'es-toolkit';
import { MetricTypes } from '../../../core/utils/PerformanceMonitor';
import { VirtualScrollManager } from '../../../core/render/VirtualScrollManager';
import { TableTheme } from '../config';
import { formatCellText } from '../utils/formatCellText';
import { getBorderProps } from '../utils/borderUtils';
import { calcMergeSize } from '../utils/cellUtils';
import { ObjectPool } from '../../../core/utils/ObjectPool';
import useCanvasTextRender from './useCanvasTextRender';

// ============================================================================
// 边框绘制优化相关缓存与收集器
// ============================================================================

const BorderStyleCache = {
  solid: { dash: [], width: 1 },
  dashed: { dash: [4, 4], width: 1 },
  dotted: { dash: [2, 2], width: 1 }
};

const HEX_COLOR_RE = /^#([A-Fa-f0-9]{3}){1,2}$/;

// ============================================================================
// 单元格渲染对象池
// ----------------------------------------------------------------------------
// collectCellData 每帧为每个可见单元格创建 cellData / text / clip 对象，
// 50×30 视口 ≈ 1500 对象/帧，滚动时持续制造 GC 压力。这些对象生命周期严格
// 限定在单帧：collectCellData 产出后 push 进 cellDataList，由 drawCellsBatched
// 消费完即释放，无任何跨帧引用（渐进渲染与主渲染互斥，均以 drawCellsBatched
// 收尾）。因此可用对象池复用：每个 cellData 永久拥有 _text / _clip 子对象，
// 复用 cellData 时子对象一并复用，仅切换 text/clip 引用，彻底消除逐帧分配。
// ============================================================================
const cellDataPool = new ObjectPool(
  () => ({
    r: 0, c: 0, x: 0, y: 0, w: 0, h: 0,
    bg: null, text: null, gridLine: true, clip: null,
    _text: { content: '', font: '', color: '', align: 'left', valign: 'middle', fSize: '', isWrap: false, padding: 4, style: null },
    _clip: { x: 0, y: 0, w: 0, h: 0 }
  }),
  // reset：仅断开引用型字段，_text.style 置空以免滞留样式对象；子对象本身保留复用
  (o) => { o.bg = null; o.text = null; o.clip = null; o.gridLine = true; o._text.style = null; },
  4096
);

/**
 * 释放一帧收集的 cellData 列表回对象池
 */
function _releaseCellDataList(list) {
  for (let i = 0; i < list.length; i++) {
    cellDataPool.release(list[i]);
  }
}

export default function useCanvasRender(tableContext) {
  const textRender = useCanvasTextRender({
    getWorkbook: () => tableContext.props.workbook,
    getTheme: () => tableContext.state.tableTheme
  });
  const {
    measureTextWithCache,
    importMeasuredMetrics,
    scanPreloadText: _scanPreloadText,
    measureTextBatch,
    drawText
  } = textRender;

  // 局部的非响应式缓存
  let _virtualScrollManager = null;
  let _gridLayerCache = null;
  let gridVersion = 0;
  let renderRafId = null;
  let isDisposed = false;

  /**
   * 计算可见区域范围
   */
  function _getVisibleRange() {
    if (!tableContext.props.workbook) return null;

    if (!_virtualScrollManager || _virtualScrollManager.workbook !== tableContext.props.workbook) {
      _virtualScrollManager = new VirtualScrollManager(tableContext.props.workbook);
    }

    _virtualScrollManager.scrollX = tableContext.state.scrollX;
    _virtualScrollManager.scrollY = tableContext.state.scrollY;

    const range = _virtualScrollManager.getVisibleRange(
      tableContext.state.width,
      tableContext.state.height,
      tableContext.computed.rowHeaderWidth.value,
      tableContext.computed.colHeaderHeight.value
    );

    _virtualScrollManager.triggerPreload(range);

    return range;
  }

  /**
   * 收集单元格渲染数据用于批量绘制
   */
  function collectCellData(r, c, x, y, w, h, clipRect = null, cell, val) {
    if (cell === undefined) cell = tableContext.props.workbook.getCell(r, c);
    if (val === undefined) val = tableContext.props.workbook.formulaEvaluator.getCellValue(r, c);
    const s = cell ? cell.s : null;

    const cellData = cellDataPool.acquire();
    cellData.r = r; cellData.c = c;
    cellData.x = x; cellData.y = y; cellData.w = w; cellData.h = h;
    cellData.bg = (s && (s.bg || s.bgcolor)) ? (s.bg || s.bgcolor) : null;
    cellData.text = null;
    cellData.gridLine = true;
    if (clipRect) {
      const clip = cellData._clip;
      clip.x = clipRect.minX;
      clip.y = clipRect.minY;
      clip.w = clipRect.maxX - clipRect.minX;
      clip.h = clipRect.maxY - clipRect.minY;
      cellData.clip = clip;
    } else {
      cellData.clip = null;
    }

    if (val !== null && val !== undefined && val !== '') {
      let fontFunc = '';
      if (s && (s.fw === 'bold' || s.bold)) fontFunc += 'bold ';
      if (s && (s.fs === 'italic' || s.italic)) fontFunc += 'italic ';
      const fSize = (s && s.fontSize) ? s.fontSize + 'px' : tableContext.state.tableTheme.fontSize;
      const fontSetting = `${fontFunc}${fSize} ${tableContext.state.tableTheme.fontFamily}`;

      const textColor = (s && s.color) ? s.color : tableContext.state.tableTheme.textColor;
      const align = (s && s.align) ? s.align : 'left';
      const valign = (s && s.valign) ? s.valign : 'middle';
      const formattedText = formatCellText(val, s);
      const isWrap = s && s.wrap;
      const padding = 4;

      const text = cellData._text;
      text.content = formattedText;
      text.font = fontSetting;
      text.color = textColor;
      text.align = align;
      text.valign = valign;
      text.fSize = fSize;
      text.isWrap = isWrap;
      text.padding = padding;
      text.style = s;
      cellData.text = text;
    }

    return cellData;
  }

  /**
   * 批量绘制背景
   */
  function _drawBatchedBackgrounds(ctx, bgGroups) {
    for (const color in bgGroups) {
      const rects = bgGroups[color];
      ctx.fillStyle = color;
      for (let i = 0; i < rects.length; i += 4) {
        ctx.fillRect(rects[i], rects[i+1], rects[i+2], rects[i+3]);
      }
    }
  }

  /**
   * 批量绘制文本
   */
  function _drawBatchedTexts(ctx, textGroups, cellDataList) {
    let lastFont = null, lastFill = null, lastAlign = null;
    for (const cellData of cellDataList) {
      if (!cellData.text) continue;
      const { text, x, y, w, h, clip } = cellData;

      if (lastFont !== text.font) { ctx.font = text.font; lastFont = text.font; }
      if (lastFill !== text.color) { ctx.fillStyle = text.color; lastFill = text.color; }
      if (lastAlign !== text.align) { ctx.textAlign = text.align; lastAlign = text.align; }

      const hasGlobalClip = !!clip;
      if (hasGlobalClip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
      }

      let needsClip = true;
      if (!text.isWrap) {
        const padding = text.padding || 0;
        const available = w - padding * 2;
        const fSize = text.fSize || 13;
        const upperBound = text.content.length * fSize;
        if (upperBound <= available) {
          needsClip = false;
        } else {
          const textWidth = measureTextWithCache(ctx, text.content, text.font);
          if (textWidth <= available) {
            needsClip = false;
          }
        }
      }

      if (needsClip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }

      drawText(ctx, cellData);

      if (needsClip) {
        ctx.restore();
      }

      if (hasGlobalClip) {
        ctx.restore();
      }
    }
  }

  /**
   * 批量绘制单元格
   */
  function drawCellsBatched(ctx, cellDataList, gridLines = null) {
    const bgGroups = {};

    for (const cell of cellDataList) {
      if (cell.bg && cell.bg !== '#ffffff') {
        if (!bgGroups[cell.bg]) bgGroups[cell.bg] = [];
        bgGroups[cell.bg].push(cell.x, cell.y, cell.w, cell.h);
      }
    }

    _drawBatchedBackgrounds(ctx, bgGroups);
    _drawBatchedTexts(ctx, null, cellDataList);

    if (tableContext.props.workbook && tableContext.props.workbook.plugins) {
      const isEditLockedFn = tableContext.props.workbook.plugins.getSharedState('collaboration:isCellEditLocked') ||
                             tableContext.props.workbook.plugins.getSharedState('collaboration:isCellLocked');
      const getEditingDraftFn = tableContext.props.workbook.plugins.getSharedState('collaboration:getEditingDraft');
      if (isEditLockedFn) {
        for (const cell of cellDataList) {
          if (isEditLockedFn(cell.r, cell.c)) {
            ctx.save();
            ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
            ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

            ctx.font = '10px "Segoe UI Symbol", "Apple Color Emoji", sans-serif';
            ctx.fillStyle = '#e67e22';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText('🔒', cell.x + cell.w - 3, cell.y + 3);

            if (getEditingDraftFn) {
              const draft = getEditingDraftFn(cell.r, cell.c);
              if (draft && draft.value !== undefined && draft.value !== null) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
                ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
                ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);

                ctx.font = '10px "Segoe UI Symbol", "Apple Color Emoji", sans-serif';
                ctx.fillStyle = '#e67e22';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'top';
                ctx.fillText('🔒', cell.x + cell.w - 3, cell.y + 3);

                ctx.fillStyle = '#7f8c8d';
                ctx.font = 'italic 11px Inter, sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                const padding = 5;
                const maxTextWidth = cell.w - padding * 2 - 15;
                const suffix = '...';
                let text = String(draft.value);
                if (ctx.measureText(text).width > maxTextWidth) {
                  // 二分查找：将 measureText 次数从 O(N) 降至 O(log N)
                  let lo = 0, hi = text.length;
                  while (lo < hi) {
                    const mid = Math.ceil((lo + hi) / 2);
                    const testText = text.slice(0, mid) + suffix;
                    if (ctx.measureText(testText).width <= maxTextWidth) {
                      lo = mid;
                    } else {
                      hi = mid - 1;
                    }
                  }
                  text = text.slice(0, lo) + suffix;
                }
                ctx.fillText(text, cell.x + padding, cell.y + cell.h / 2);

                ctx.font = '9px Inter, sans-serif';
                ctx.fillStyle = '#95a5a6';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                const dots = '.'.repeat((Math.floor(Date.now() / 500) % 3) + 1);
                ctx.fillText(`${draft.userName} 正在输入${dots}`, cell.x + cell.w - 3, cell.y + cell.h - 2);
              }
            }
            ctx.restore();
          }
        }
      }
    }

    // 所有消费者读取完毕，释放本帧 cellData 回对象池供下帧复用
    _releaseCellDataList(cellDataList);
  }

  /**
   * 绘制单元格边框
   */
  function drawCellBorders(ctx, r, c, x, y, w, h, batchAccumulator = null) {
    const cell = tableContext.props.workbook.getCell(r, c);
    const s = cell ? cell.s : null;

    if (!s || !s.border) return;

    const { top, bottom, left, right } = s.border;
    if (!top && !bottom && !left && !right) return;

    const bx = x + 0.5;
    const by = y + 0.5;
    const bxw = bx + w;
    const byh = by + h;

    if (batchAccumulator) {
      const addLine = (x1, y1, x2, y2, color, style) => {
        const key = `${color}|${style}`;
        if (!batchAccumulator[key]) batchAccumulator[key] = [];
        batchAccumulator[key].push(x1, y1, x2, y2);
      };
      if (top) { const { color, style } = getBorderProps(top); addLine(bx, by, bxw, by, color, style); }
      if (bottom) { const { color, style } = getBorderProps(bottom); addLine(bx, byh, bxw, byh, color, style); }
      if (left) { const { color, style } = getBorderProps(left); addLine(bx, by, bx, byh, color, style); }
      if (right) { const { color, style } = getBorderProps(right); addLine(bxw, by, bxw, byh, color, style); }
    } else {
      const styleGroups = new Map();
      const edges = [
        { edge: top, x1: bx, y1: by, x2: bxw, y2: by },
        { edge: bottom, x1: bx, y1: byh, x2: bxw, y2: byh },
        { edge: left, x1: bx, y1: by, x2: bx, y2: byh },
        { edge: right, x1: bxw, y1: by, x2: bxw, y2: byh }
      ];

      edges.forEach(({ edge, x1, y1, x2, y2 }) => {
        if (edge) {
          const { color, style } = getBorderProps(edge);
          const key = `${color}|${style}`;
          if (!styleGroups.has(key)) styleGroups.set(key, { color, style, path: new Path2D() });
          const group = styleGroups.get(key);
          group.path.moveTo(x1, y1);
          group.path.lineTo(x2, y2);
        }
      });

      styleGroups.forEach(group => {
        ctx.strokeStyle = group.color;
        ctx.lineWidth = 1;
        const styleConfig = BorderStyleCache[group.style] || BorderStyleCache.solid;
        ctx.setLineDash(styleConfig.dash);
        ctx.stroke(group.path);
      });
      ctx.setLineDash([]);
    }
  }

  /**
   * 批量绘制边框
   */
  function _drawBatchedBorders(ctx, batch) {
    if (!batch) return;

    const keys = Object.keys(batch);
    if (keys.length === 0) return;

    ctx.save();
    ctx.lineWidth = 1;

    const solidKeys = [];
    const otherKeys = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key.endsWith('|solid')) {
        solidKeys.push(key);
      } else {
        otherKeys.push(key);
      }
    }

    if (solidKeys.length > 0) {
      ctx.setLineDash([]);

      for (let i = 0; i < solidKeys.length; i++) {
        const key = solidKeys[i];
        const color = key.slice(0, -6);
        const coords = batch[key];

        ctx.strokeStyle = color;

        const path = new Path2D();
        for (let j = 0; j < coords.length; j += 4) {
          path.moveTo(coords[j], coords[j + 1]);
          path.lineTo(coords[j + 2], coords[j + 3]);
        }
        ctx.stroke(path);
      }
    }

    for (let i = 0; i < otherKeys.length; i++) {
      const key = otherKeys[i];
      const pipeIndex = key.lastIndexOf('|');
      const color = key.slice(0, pipeIndex);
      const style = key.slice(pipeIndex + 1);
      const coords = batch[key];

      ctx.strokeStyle = color;

      const styleConfig = BorderStyleCache[style];
      if (styleConfig) {
        ctx.setLineDash(styleConfig.dash);
      } else {
        ctx.setLineDash([]);
      }

      const path = new Path2D();
      for (let j = 0; j < coords.length; j += 4) {
        path.moveTo(coords[j], coords[j + 1]);
        path.lineTo(coords[j + 2], coords[j + 3]);
      }
      ctx.stroke(path);
    }

    ctx.restore();
  }

  function drawColHeader(ctx, c, x, w, h) {
    ctx.fillStyle = tableContext.state.tableTheme.headerBg;
    ctx.fillRect(x, 0, w, h);
    ctx.strokeStyle = tableContext.state.tableTheme.borderColor;
    ctx.strokeRect(x, 0, w, h);

    if (tableContext.props.workbook.selection && tableContext.props.workbook.selection.s.c <= c && tableContext.props.workbook.selection.e.c >= c) {
      ctx.fillStyle = tableContext.state.tableTheme.selectionBg;
      ctx.fillRect(x, 0, w, h);
    }

    ctx.fillStyle = tableContext.state.tableTheme.textColor;
    ctx.textAlign = 'center';
    ctx.font = `${tableContext.state.tableTheme.headerFontSize} ${tableContext.state.tableTheme.fontFamily}`;

    ctx.fillText(tableContext.props.workbook.indexToColStr(c), x + w / 2, h / 2);
  }

  function drawRowHeader(ctx, r, y, w, h) {
    ctx.fillStyle = tableContext.state.tableTheme.headerBg;
    if (tableContext.props.workbook.selection && tableContext.props.workbook.selection.s.r <= r && tableContext.props.workbook.selection.e.r >= r) {
      ctx.fillStyle = tableContext.state.tableTheme.headerHoverBg;
    }
    ctx.fillRect(0, y, w, h);
    ctx.strokeStyle = tableContext.state.tableTheme.borderColor;
    ctx.strokeRect(0, y, w, h);
    ctx.fillStyle = tableContext.state.tableTheme.textColor;
    ctx.textAlign = 'center';
    ctx.fillText(String(r + 1), w / 2, y + h / 2);
  }

  function drawCopySelection(ox, oy) {
    const wb = tableContext.props.workbook;
    if (!wb || !wb.copyRange) return;

    const sel = wb.copyRange;
    const ctx = tableContext.state.ctxAnimation;
    if (!ctx) return;

    const getRect = (r1, c1, r2, c2) => {
      const x = wb.getColPos(c1);
      const y = wb.getRowPos(r1);
      const w = wb.getColPos(c2 + 1) - x;
      const h = wb.getRowPos(r2 + 1) - y;
      return { x, y, w, h };
    };

    const rect = getRect(sel.s.r, sel.s.c, sel.e.r, sel.e.c);
    const cx = ox + rect.x;
    const cy = oy + rect.y;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = tableContext.state.tableTheme.selectionBorder;

    // 蚂蚁线偏移动画
    const offset = (Math.floor(Date.now() / 60) % 12);
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -offset;
    ctx.strokeRect(cx, cy, rect.w, rect.h);
    ctx.restore();
  }

  function drawCopySelectionInQuadrants(ctx, fR, fC, fW, fH, RW, CH, W, H) {
    const wb = tableContext.props.workbook;
    if (!wb || !wb.copyRange) return;

    const sel = wb.copyRange;

    // 在主体区域绘制
    ctx.save();
    ctx.beginPath();
    ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
    ctx.clip();
    drawCopySelection(RW - tableContext.state.scrollX, CH - tableContext.state.scrollY);
    ctx.restore();

    // 在冻结区域绘制
    if (fR > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH, W - (RW + fW), fH);
      ctx.clip();
      drawCopySelection(RW - tableContext.state.scrollX, CH);
      ctx.restore();
    }

    if (fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH + fH, fW, H - (CH + fH));
      ctx.clip();
      drawCopySelection(RW, CH - tableContext.state.scrollY);
      ctx.restore();
    }

    if (fR > 0 && fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH, fW, fH);
      ctx.clip();
      drawCopySelection(RW, CH);
      ctx.restore();
    }
  }

  /**
   * 渲染选区层（静态部分）
   */
  function _renderSelection() {
    if (!tableContext.state.ctxSelection || !tableContext.props.workbook) return;
    const ctx = tableContext.state.ctxSelection;
    const wb = tableContext.props.workbook;

    const W = tableContext.state.width;
    const H = tableContext.state.height;
    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);

    ctx.clearRect(0, 0, W, H);

    const theme = tableContext.state.tableTheme || TableTheme;
    ctx.fillStyle = theme.headerBg;
    ctx.fillRect(0, 0, RW, CH);
    ctx.beginPath();
    ctx.moveTo(RW - 10, CH - 2);
    ctx.lineTo(RW - 2, CH - 2);
    ctx.lineTo(RW - 2, CH - 10);
    ctx.closePath();
    ctx.fillStyle = theme.borderColor;
    ctx.fill();

    const fR = wb.freeze.r || 0;
    const fC = wb.freeze.c || 0;
    // 冻结区域尺寸由 LayoutEngine 缓存，仅在 setFreeze / 行列尺寸变更时失效，避免逐帧重复累加
    const { w: fW, h: fH } = wb.getFrozenSize ? wb.getFrozenSize() : { w: 0, h: 0 };

    const active = wb.activeCell;
    const sel = wb.selection;

    if (active && sel) {
      drawSelectionInQuadrants(ctx, sel, fR, fC, fW, fH, RW, CH, W, H, CH - tableContext.state.scrollY);
    }

    // 拖拽多字段放置预览提示
    if (tableContext.state.dragOverCell) {
      const { r, c } = tableContext.state.dragOverCell;
      const rect = tableContext.methods.getCellScreenRect(r, c);
      ctx.save();
      ctx.strokeStyle = '#409eff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }

    // 渲染协同用户光标
    drawCollaborativeCursorsInQuadrants(ctx, fR, fC, fW, fH, RW, CH, W, H);
  }

  /**
   * 渲染动画层（动态部分，主要是蚂蚁线）
   */
  function _renderAnimation() {
    if (!tableContext.state.ctxAnimation || !tableContext.props.workbook) return;
    const ctx = tableContext.state.ctxAnimation;
    const wb = tableContext.props.workbook;

    const W = tableContext.state.width;
    const H = tableContext.state.height;
    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);

    ctx.clearRect(0, 0, W, H);

    const fR = wb.freeze.r || 0;
    const fC = wb.freeze.c || 0;
    // 冻结区域尺寸由 LayoutEngine 缓存，仅在 setFreeze / 行列尺寸变更时失效，避免逐帧重复累加
    const { w: fW, h: fH } = wb.getFrozenSize ? wb.getFrozenSize() : { w: 0, h: 0 };

    drawCopySelectionInQuadrants(ctx, fR, fC, fW, fH, RW, CH, W, H);
  }

  function drawSelectionInQuadrants(ctx, sel, fR, fC, fW, fH, RW, CH, W, H, vyBody) {
    const wb = tableContext.props.workbook;
    const active = wb.activeCell;

    const getRect = (r1, c1, r2, c2) => {
      const x = wb.getColPos(c1);
      const y = wb.getRowPos(r1);
      const w = wb.getColPos(c2 + 1) - x;
      const h = wb.getRowPos(r2 + 1) - y;
      return { x, y, w, h };
    };

    const rect = getRect(sel.s.r, sel.s.c, sel.e.r, sel.e.c);
    const activeRect = getRect(active.r, active.c, active.r, active.c);

    const drawSelection = (ox, oy) => {
      if (!sel) return;
      const cx = ox + rect.x;
      const cy = oy + rect.y;

      ctx.fillStyle = tableContext.state.tableTheme.selectionBg;
      if (sel.s.r === sel.e.r && sel.s.c === sel.e.c) {
        // 仅单选单元格时不绘制背景
      } else {
        ctx.beginPath();
        ctx.rect(cx, cy, rect.w, rect.h);
        ctx.rect(ox + activeRect.x, oy + activeRect.y, activeRect.w, activeRect.h);
        ctx.fill('evenodd');
      }

      ctx.lineWidth = 2;
      ctx.strokeStyle = tableContext.state.tableTheme.selectionBorder;
      ctx.strokeRect(cx, cy, rect.w, rect.h);

      ctx.fillStyle = tableContext.state.tableTheme.selectionBorder;
      const handleSize = 6;
      const hx = cx + rect.w - handleSize / 2;
      const hy = cy + rect.h - handleSize / 2;
      ctx.fillRect(hx, hy, handleSize, handleSize);

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx, hy, handleSize, handleSize);

      tableContext.state.fillHandleRect = { x: hx, y: hy, w: handleSize, h: handleSize };
    };

    // 在主体区域绘制
    ctx.save();
    ctx.beginPath();
    ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
    ctx.clip();
    drawSelection(RW - tableContext.state.scrollX, CH - tableContext.state.scrollY);
    ctx.restore();

    // 在冻结区域绘制
    if (fR > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH, W - (RW + fW), fH);
      ctx.clip();
      drawSelection(RW - tableContext.state.scrollX, CH);
      ctx.restore();
    }

    if (fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH + fH, fW, H - (CH + fH));
      ctx.clip();
      drawSelection(RW, CH - tableContext.state.scrollY);
      ctx.restore();
    }

    if (fR > 0 && fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH, fW, fH);
      ctx.clip();
      drawSelection(RW, CH);
      ctx.restore();
    }
  }

  function drawCollaborativeCursorsInQuadrants(ctx, fR, fC, fW, fH, RW, CH, W, H) {
    const wb = tableContext.props.workbook;
    if (!wb || !wb.plugins) return;
    const activeCursors = wb.plugins.getSharedState('collaborative:active-cursors') || [];
    if (activeCursors.length === 0) return;

    const getRect = (r1, c1, r2, c2) => {
      const x = wb.getColPos(c1);
      const y = wb.getRowPos(r1);
      const w = wb.getColPos(c2 + 1) - x;
      const h = wb.getRowPos(r2 + 1) - y;
      return { x, y, w, h };
    };

    const drawSingleCursor = (ox, oy, item) => {
      const range = item.range;

      if (wb.activeCell) {
        const activeR = wb.activeCell.r;
        const activeC = wb.activeCell.c;
        if (
          activeR >= range.startRow &&
          activeR <= range.endRow &&
          activeC >= range.startCol &&
          activeC <= range.endCol
        ) {
          if (tableContext.state.isEditing) {
            return;
          }

          const getLocalFocusTimeFn = wb.plugins.getSharedState('collaboration:getLocalFocusTime');
          if (getLocalFocusTimeFn) {
            const localFocusTime = getLocalFocusTimeFn() || Date.now();
            const otherFocusTime = item.focusTime || Date.now();
            if (localFocusTime <= otherFocusTime) {
              return;
            }
          }
        }
      }

      const rect = getRect(range.startRow, range.startCol, range.endRow, range.endCol);
      const cx = ox + rect.x;
      const cy = oy + rect.y;

      ctx.fillStyle = _hexToRgba(item.userInfo.color, 0.08);
      ctx.fillRect(cx, cy, rect.w, rect.h);

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = item.userInfo.color;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(cx, cy, rect.w, rect.h);
      ctx.setLineDash([]);

      ctx.fillStyle = item.userInfo.color;
      const text = item.userInfo.name;
      ctx.font = '10px sans-serif';
      const textWidth = ctx.measureText(text).width;

      const labelHeight = 16;
      const labelWidth = textWidth + 8;

      let lx = cx;
      let ly = cy - labelHeight;
      if (ly < CH) {
        ly = cy;
      }

      _drawRoundedRect(ctx, lx, ly, labelWidth, labelHeight, 2);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lx + 4, ly + labelHeight / 2);
    };

    const drawAll = (ox, oy) => {
      activeCursors.forEach(item => {
        drawSingleCursor(ox, oy, item);
      });
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
    ctx.clip();
    drawAll(RW - tableContext.state.scrollX, CH - tableContext.state.scrollY);
    ctx.restore();

    if (fR > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH, W - (RW + fW), fH);
      ctx.clip();
      drawAll(RW - tableContext.state.scrollX, CH);
      ctx.restore();
    }

    if (fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH + fH, fW, H - (CH + fH));
      ctx.clip();
      drawAll(RW, CH - tableContext.state.scrollY);
      ctx.restore();
    }

    if (fR > 0 && fC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH, fW, fH);
      ctx.clip();
      drawAll(RW, CH);
      ctx.restore();
    }
  }

  function _hexToRgba(hex, alpha) {
    if (!HEX_COLOR_RE.test(hex)) return hex;
    const h = hex.substring(1);
    const n = parseInt(h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function _drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function _getGridRenderSignature(range) {
    const wb = tableContext.props.workbook;
    let h = 0;
    const mix = (v) => { h = (h * 31 + (v | 0)) | 0; };

    mix(tableContext.state.width); mix(tableContext.state.height);
    mix(tableContext.computed.rowHeaderWidth.value); mix(tableContext.computed.colHeaderHeight.value);
    mix(tableContext.state.scrollX); mix(tableContext.state.scrollY);
    mix(range.startRow); mix(range.endRow);
    mix(range.startCol); mix(range.endCol);

    if (typeof wb.getLayoutVersion === 'function') {
      mix(wb.getLayoutVersion());
    } else {
      for (let r = range.startRow; r <= range.endRow; r++) mix(wb.getRowHeight(r));
      for (let c = range.startCol; c <= range.endCol; c++) mix(wb.getColWidth(c));
    }

    if (wb.freeze) { mix(wb.freeze.r); mix(wb.freeze.c); }

    const merges = wb.merges || [];
    mix(merges.length);
    for (let i = 0; i < merges.length; i++) {
      const merge = merges[i];
      mix(merge.s.r); mix(merge.s.c);
      mix(merge.e.r); mix(merge.e.c);
    }

    return h;
  }

  function _getGridCacheContext(width, height) {
    if (typeof document === 'undefined') return null;

    if (!_gridLayerCache) {
      const canvas = document.createElement('canvas');
      _gridLayerCache = {
        canvas,
        ctx: canvas.getContext('2d'),
        signature: null
      };
    }

    const cache = _gridLayerCache;
    if (!cache.ctx) return null;
    if (cache.canvas.width !== width || cache.canvas.height !== height) {
      cache.canvas.width = width;
      cache.canvas.height = height;
      cache.signature = null;
    }
    return cache;
  }

  function _renderGrid() {
    if (!tableContext.state.ctxGrid || !tableContext.props.workbook) return;
    const ctx = tableContext.state.ctxGrid;
    const theme = tableContext.state.tableTheme || TableTheme;
    const wb = tableContext.props.workbook;

    const W = tableContext.state.width;
    const H = tableContext.state.height;
    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);

    const range = _getVisibleRange();
    if (!range) return;

    const signature = _getGridRenderSignature(range);
    const cache = _getGridCacheContext(W, H);

    if (cache && cache.signature === signature) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(cache.canvas, 0, 0);
      return;
    }

    const drawCtx = cache?.ctx || ctx;
    drawCtx.clearRect(0, 0, W, H);

    drawCtx.fillStyle = theme.headerBg;
    drawCtx.fillRect(0, 0, W, CH);
    drawCtx.fillRect(0, 0, RW, H);

    drawCtx.lineWidth = 1;
    drawCtx.strokeStyle = theme.borderColor;
    drawCtx.beginPath();

    drawCtx.moveTo(0.5, 0);
    drawCtx.lineTo(0.5, H);

    drawCtx.moveTo(RW + 0.5, 0);
    drawCtx.lineTo(RW + 0.5, H);

    let vx = RW + wb.getColPos(range.startCol) - tableContext.state.scrollX;
    for (let c = range.startCol; c <= range.endCol + 1; c++) {
      const x = Math.floor(vx) + 0.5;
      if (x > RW) {
        drawCtx.moveTo(x, 0);
        drawCtx.lineTo(x, CH);
      }
      if (c <= range.endCol) vx += wb.getColWidth(c);
    }

    const bodyStartY = (range.bodyStartY != null) ? range.bodyStartY : CH;
    const bodyStartX = (range.bodyStartX != null) ? range.bodyStartX : RW;
    let vy = CH + wb.getRowPos(range.startRow) - tableContext.state.scrollY;
    for (let r = range.startRow; r <= range.endRow; r++) {
      const h = wb.getRowHeight(r);
      const yStart = Math.max(Math.floor(vy), bodyStartY);
      const yEnd = Math.max(Math.floor(vy + h), bodyStartY);

      if (yEnd > yStart) {
        let cx = RW + wb.getColPos(range.startCol) - tableContext.state.scrollX;
        for (let c = range.startCol; c <= range.endCol; c++) {
          const w = wb.getColWidth(c);
          const x = Math.floor(cx + w) + 0.5;

          if (x >= bodyStartX) {
            const merge = wb.getMerge(r, c);
            let shouldDraw = true;
            if (merge) {
              shouldDraw = (c === merge.e.c);
            }
            if (shouldDraw) {
              drawCtx.moveTo(x, yStart);
              drawCtx.lineTo(x, yEnd);
            }
          }
          cx += w;
        }
      }
      vy += h;
    }

    const freezeR = range.freezeR || 0;
    const freezeC = range.freezeC || 0;
    const headerSepY = CH + 0.5;
    if (freezeR > 0) {
      let vx_fr = RW + wb.getColPos(range.startCol) - tableContext.state.scrollX;
      for (let c = range.startCol; c <= range.endCol + 1; c++) {
        const x = Math.floor(vx_fr) + 0.5;
        if (x > RW) {
          drawCtx.moveTo(x, CH);
          drawCtx.lineTo(x, bodyStartY);
        }
        if (c <= range.endCol) vx_fr += wb.getColWidth(c);
      }
    }
    if (freezeC > 0) {
      let vx_fc = RW;
      for (let c = 0; c <= range.freezeEndCol; c++) {
        const w = wb.getColWidth(c);
        const x = Math.floor(vx_fc + w) + 0.5;
        if (x > RW && x < bodyStartX) {
          drawCtx.moveTo(x, CH);
          drawCtx.lineTo(x, H);
        }
        vx_fc += w;
      }
    }

    drawCtx.moveTo(0, 0.5);
    drawCtx.lineTo(W, 0.5);

    drawCtx.moveTo(0, headerSepY);
    drawCtx.lineTo(W, headerSepY);

    if (freezeR > 0) {
      let vy_fr = CH;
      for (let r = 0; r <= Math.min(freezeR, range.endRow + 1); r++) {
        const y = Math.floor(vy_fr) + 0.5;
        if (y > CH && Math.abs(y - headerSepY) > 0.01) {
          drawCtx.moveTo(RW, y);
          drawCtx.lineTo(W, y);
        }
        if (r <= range.endRow) vy_fr += wb.getRowHeight(r);
      }
      let vy_rh = CH;
      for (let r = 0; r <= Math.min(freezeR, range.endRow + 1); r++) {
        const y = Math.floor(vy_rh) + 0.5;
        if (y > CH && Math.abs(y - headerSepY) > 0.01) {
          drawCtx.moveTo(0, y);
          drawCtx.lineTo(RW, y);
        }
        if (r <= range.endRow) vy_rh += wb.getRowHeight(r);
      }
      drawCtx.moveTo(RW + 0.5, CH);
      drawCtx.lineTo(RW + 0.5, bodyStartY);
    }
    if (freezeC > 0) {
      let vy_fc = CH + wb.getRowPos(range.startRow) - tableContext.state.scrollY;
      for (let r = range.startRow; r <= range.endRow + 1; r++) {
        const y = Math.floor(vy_fc) + 0.5;
        if (y > CH && y < bodyStartY) {
          drawCtx.moveTo(RW, y);
          drawCtx.lineTo(bodyStartX, y);
        }
        if (r <= range.endRow) vy_fc += wb.getRowHeight(r);
      }
    }

    let vy2 = CH + wb.getRowPos(range.startRow) - tableContext.state.scrollY;
    for (let r = range.startRow; r <= range.endRow + 1; r++) {
      const y = Math.floor(vy2) + 0.5;
      if (y > CH) {
        drawCtx.moveTo(0, y);
        drawCtx.lineTo(RW, y);
      }
      if (r <= range.endRow) vy2 += wb.getRowHeight(r);
    }

    let vy3 = CH + wb.getRowPos(range.startRow) - tableContext.state.scrollY;
    for (let r = range.startRow; r <= range.endRow; r++) {
      const h = wb.getRowHeight(r);
      const y = Math.floor(vy3 + h) + 0.5;

      if (y >= bodyStartY) {
        let cx = RW + wb.getColPos(range.startCol) - tableContext.state.scrollX;
        for (let c = range.startCol; c <= range.endCol; c++) {
          const w = wb.getColWidth(c);
          const xStart = Math.max(Math.floor(cx), bodyStartX);
          const xEnd = Math.max(Math.floor(cx + w), bodyStartX);

          if (xEnd > xStart) {
            const merge = wb.getMerge(r, c);
            let shouldDraw = true;
            if (merge) {
              shouldDraw = (r === merge.e.r);
            }
            if (shouldDraw) {
              drawCtx.moveTo(xStart, y);
              drawCtx.lineTo(xEnd, y);
            }
          }
          cx += w;
        }
      }
      vy3 += h;
    }

    drawCtx.stroke();

    _renderHeaders(drawCtx, range);

    if (cache) {
      cache.signature = signature;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(cache.canvas, 0, 0);
    }
  }

  function _renderHeaders(ctx, range = null) {
    const theme = tableContext.state.tableTheme;
    const wb = tableContext.props.workbook;
    range = range || _getVisibleRange();
    if (!range) return;

    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);
    const W = tableContext.state.width;
    const H = tableContext.state.height;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textColor;
    ctx.font = `${theme.headerFontSize} ${theme.fontFamily}`;

    const frozenHeight = range.frozenHeight || 0;

    if (range.freezeR > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, CH, RW, frozenHeight);
      ctx.clip();
      let curFrozenY = CH;
      for (let r = 0; r < range.freezeR; r++) {
        const h = wb.getRowHeight(r);
        const y = Math.floor(curFrozenY);
        ctx.fillText(String(r + 1), RW / 2, y + h / 2);
        curFrozenY += h;
      }
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CH + frozenHeight, RW, H - CH - frozenHeight);
    ctx.clip();
    let curY = CH + wb.getRowPos(range.startRow) - tableContext.state.scrollY;
    for (let r = range.startRow; r <= range.endRow; r++) {
      const h = wb.getRowHeight(r);
      const y = Math.floor(curY);
      ctx.fillText(String(r + 1), RW / 2, y + h / 2);
      curY += h;
    }
    ctx.restore();

    const frozenWidth = range.frozenWidth || 0;

    if (range.freezeC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, 0, frozenWidth, CH);
      ctx.clip();
      let curFrozenX = RW;
      for (let c = 0; c < range.freezeC; c++) {
        const w = wb.getColWidth(c);
        const x = Math.floor(curFrozenX);
        ctx.fillText(wb.indexToColStr(c), x + w / 2, CH / 2);
        curFrozenX += w;
      }
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(RW + frozenWidth, 0, W - RW - frozenWidth, CH);
    ctx.clip();
    let curX = RW + wb.getColPos(range.startCol) - tableContext.state.scrollX;
    for (let c = range.startCol; c <= range.endCol; c++) {
      const w = wb.getColWidth(c);
      const x = Math.floor(curX);
      ctx.fillText(wb.indexToColStr(c), x + w / 2, CH / 2);
      curX += w;
    }
    ctx.restore();

    ctx.restore();
  }

  function _updateAriaGridImpl(range) {
    const wb = tableContext.props.workbook;
    if (!wb) return;

    tableContext.state.totalRowCount = wb.rowCount;
    tableContext.state.totalColCount = wb.colCount;

    let startRow, endRow, startCol, endCol;
    if (range) {
      startRow = range.exactStartRow;
      endRow = range.exactEndRow;
      startCol = range.exactStartCol;
      endCol = range.exactEndCol;
    } else {
      const RW = tableContext.computed.rowHeaderWidth.value;
      const CH = tableContext.computed.colHeaderHeight.value;
      const W = tableContext.state.width;
      const H = tableContext.state.height;
      startRow = wb.getRowIndexAt(tableContext.state.scrollY);
      endRow = wb.getRowIndexAt(tableContext.state.scrollY + H - CH);
      startCol = wb.getColIndexAt(tableContext.state.scrollX);
      endCol = wb.getColIndexAt(tableContext.state.scrollX + W - RW);
    }

    if (startRow === -1 || startCol === -1) return;

    const prevStartRow = tableContext.state._ariaStartRow;
    const prevEndRow = tableContext.state._ariaEndRow;
    const prevStartCol = tableContext.state._ariaStartCol;
    const prevEndCol = tableContext.state._ariaEndCol;

    if (startRow === prevStartRow && endRow === prevEndRow &&
        startCol === prevStartCol && endCol === prevEndCol) {
      return;
    }

    tableContext.state._ariaStartRow = startRow;
    tableContext.state._ariaEndRow = endRow;
    tableContext.state._ariaStartCol = startCol;
    tableContext.state._ariaEndCol = endCol;

    const rows = [];
    for (let r = startRow; r <= endRow && r < wb.rowCount; r++) {
      rows.push({ index: r });
    }

    const cols = [];
    for (let c = startCol; c <= endCol && c < wb.colCount; c++) {
      cols.push({ index: c });
    }

    tableContext.state.ariaRows = rows;
    tableContext.state.ariaCols = cols;
  }

  const _debouncedUpdate = debounce((range) => {
    _updateAriaGridImpl(range);
  }, 150);

  function _updateAriaGrid(range) {
    if (tableContext.state._ariaStartRow === -1) {
      _updateAriaGridImpl(range);
    } else {
      _debouncedUpdate(range);
    }
  }

  function cleanupCanvasRender() {
    isDisposed = true;

    if (renderRafId !== null) {
      cancelAnimationFrame(renderRafId);
      renderRafId = null;
    }
    tableContext.state.pendingRender = false;

    if (_debouncedUpdate && typeof _debouncedUpdate.cancel === 'function') {
      _debouncedUpdate.cancel();
    }
  }

  function invalidateCore(rect = null) {
    if (_virtualScrollManager) {
      _virtualScrollManager.invalidateCache();
    }

    if (!rect) {
      tableContext.state.fullRedraw = true;
      tableContext.state.dirtyRect = null;
    } else if (!tableContext.state.fullRedraw) {
      if (!tableContext.state.dirtyRect) {
        tableContext.state.dirtyRect = { ...rect };
      } else {
        const x1 = Math.min(tableContext.state.dirtyRect.x, rect.x);
        const y1 = Math.min(tableContext.state.dirtyRect.y, rect.y);
        const x2 = Math.max(tableContext.state.dirtyRect.x + tableContext.state.dirtyRect.w, rect.x + rect.w);
        const y2 = Math.max(tableContext.state.dirtyRect.y + tableContext.state.dirtyRect.h, rect.y + rect.h);
        tableContext.state.dirtyRect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
    }
    tableContext.state.renderContentRequested = true;
    tableContext.state.renderSelectionRequested = true;
    tableContext.state.renderGridRequested = true;
    gridVersion = gridVersion + 1;
    render();
  }

  function invalidate(rect = null) {
    invalidateCore(rect);
  }

  function _runRenderMainThread() {
    const useProgressive = tableContext.methods.shouldUseProgressiveRender && tableContext.methods.shouldUseProgressiveRender();
    if (useProgressive && tableContext.methods.startProgressiveRender) {
      tableContext.methods.startProgressiveRender();
    } else {
      const monitor = tableContext.props.workbook.getPerformanceMonitor();
      const metricType = tableContext.state.fullRedraw ? MetricTypes.RENDER_FULL : MetricTypes.RENDER_PARTIAL;
      if (monitor && monitor.enabled) {
        monitor.measure(metricType, () => { _renderContent(); });
      } else {
        _renderContent();
      }
    }
  }

  function _finishContentRender() {
    tableContext.state.renderContentRequested = false;
    tableContext.state.renderSelectionRequested = true;
  }

  function _flushOverlayRender() {
    if (tableContext.state.renderSelectionRequested) {
      _renderSelection();
      tableContext.state.renderSelectionRequested = false;
    }
    if (tableContext.state.renderAnimationRequested) {
      _renderAnimation();
      tableContext.state.renderAnimationRequested = false;
    }
  }

  function render() {
    if (isDisposed) return;
    if ((!tableContext.state.ctx && !tableContext.computed.isOffscreenActive.value) || !tableContext.props.workbook) return;

    if (tableContext.state.pendingRender) return;
    tableContext.state.pendingRender = true;
    renderRafId = requestAnimationFrame(() => {
      renderRafId = null;
      if (isDisposed) return;
      tableContext.state.pendingRender = false;

      if (tableContext.state.progressiveState && tableContext.state.progressiveState.isRendering) {
        const needsContentRestart = tableContext.state.renderContentRequested && tableContext.state.fullRedraw;
        if (!needsContentRestart) {
          _flushOverlayRender();
          return;
        }
        tableContext.methods.stopProgressiveRender();
      }

      if (tableContext.state.renderGridRequested) {
        _renderGrid();
        tableContext.state.renderGridRequested = false;
      }

      if (tableContext.state.renderContentRequested) {
        const useWorker = tableContext.methods.shouldUseWorkerRender && tableContext.methods.shouldUseWorkerRender();
        if (useWorker && tableContext.methods._renderContentWithWorker) {
          tableContext.methods._renderContentWithWorker().then((success) => {
            if (isDisposed) return;
            if (!success) _runRenderMainThread();
            _finishContentRender();
            _flushOverlayRender();
          }).catch((error) => {
            if (isDisposed) return;
            console.error('[CanvasRenderHook] Worker render failed:', error);
            _runRenderMainThread();
            _finishContentRender();
            _flushOverlayRender();
          });
          return;
        }

        _runRenderMainThread();
        _finishContentRender();
      }

      _flushOverlayRender();
    });
  }

  function _renderContent() {
    if (!tableContext.state.ctx || !tableContext.props.workbook) return;
    const ctx = tableContext.state.ctx;
    const wb = tableContext.props.workbook;

    const W = tableContext.state.width;
    const H = tableContext.state.height;
    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);

    const visibleRange = _getVisibleRange();
    if (!visibleRange) return;

    const {
      freezeR, freezeC, frozenWidth, frozenHeight,
      startRow, endRow, startCol, endCol,
      freezeEndRow, freezeEndCol,
      bodyStartX, bodyStartY
    } = visibleRange;

    const isPartial = !tableContext.state.fullRedraw && tableContext.state.dirtyRect;
    const renderRect = isPartial ? { ...tableContext.state.dirtyRect } : { x: 0, y: 0, w: W, h: H };

    if (isPartial && (frozenWidth > 0 || frozenHeight > 0)) {
      let x1 = renderRect.x;
      let y1 = renderRect.y;
      let x2 = renderRect.x + renderRect.w;
      let y2 = renderRect.y + renderRect.h;
      if (frozenWidth > 0) {
        x1 = Math.min(x1, RW);
        x2 = Math.max(x2, RW + frozenWidth);
        y1 = Math.min(y1, CH);
        y2 = Math.max(y2, H);
      }
      if (frozenHeight > 0) {
        x1 = Math.min(x1, RW);
        x2 = Math.max(x2, W);
        y1 = Math.min(y1, CH);
        y2 = Math.max(y2, CH + frozenHeight);
      }
      renderRect.x = x1;
      renderRect.y = y1;
      renderRect.w = x2 - x1;
      renderRect.h = y2 - y1;
    }

    tableContext.state.fullRedraw = false;
    tableContext.state.dirtyRect = null;

    ctx.save();

    if (!isPartial) {
      ctx.clearRect(0, 0, W, H);
    } else {
      ctx.clearRect(renderRect.x, renderRect.y, renderRect.w, renderRect.h);
    }

    ctx.beginPath();
    if (isPartial) {
      const clipX = Math.max(renderRect.x, RW);
      const clipY = Math.max(renderRect.y, CH);
      const clipW = Math.max(0, Math.min(renderRect.x + renderRect.w, W) - clipX);
      const clipH = Math.max(0, Math.min(renderRect.y + renderRect.h, H) - clipY);
      ctx.rect(clipX, clipY, clipW, clipH);
    } else {
      ctx.rect(RW, CH, W - RW, H - CH);
    }
    ctx.clip();

    ctx.textBaseline = 'middle';
    ctx.font = `${tableContext.state.tableTheme.fontSize} ${tableContext.state.tableTheme.fontFamily}`;

    const intersects = (r1, r2) => {
      return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
    };

    const drawRangeBatched = (rStart, rEnd, cStart, cEnd, offsetX, offsetY, clipRect = null, forceFull = false, drawEmptyBorders = false) => {
      const cellDataList = [];
      const borderBatch = {};
      const usePartial = isPartial && !forceFull;
      const cellRenderRect = forceFull ? { x: 0, y: 0, w: W, h: H } : renderRect;

      let vy = offsetY;
      for (let r = rStart; r <= rEnd; r++) {
        const h = wb.getRowHeight(r);
        if (vy + h > 0 && vy < H) {
          if (usePartial && (vy + h < renderRect.y || vy > renderRect.y + renderRect.h)) {
            vy += h;
            continue;
          }

          let cx = offsetX;
          for (let c = cStart; c <= cEnd; c++) {
            const w = wb.getColWidth(c);
            if (cx + w > 0 && cx < W) {
              if (usePartial && (cx + w < renderRect.x || cx > renderRect.x + renderRect.w)) {
                cx += w;
                continue;
              }

              const merge = wb.getMerge(r, c);
              const cell = wb.getCell(r, c);
              const val = wb.getCellValue(r, c);
              const isEmpty = !cell || ((val === undefined || val === null || val === '') && !cell.f && !cell.s);

              if (merge) {
                if (merge.s.r === r && merge.s.c === c) {
                  const { mw, mh } = calcMergeSize(wb, merge, r, c);
                  if (intersects({ x: cx, y: vy, w: mw, h: mh }, cellRenderRect)) {
                    if (!clipRect || (cx + mw > clipRect.minX && cx < clipRect.maxX && vy + mh > clipRect.minY && vy < clipRect.maxY)) {
                      cellDataList.push(collectCellData(r, c, cx, vy, mw, mh, clipRect, cell, val));
                      drawCellBorders(ctx, r, c, cx, vy, mw, mh, borderBatch);
                    }
                  }
                }
              } else if (!isEmpty || drawEmptyBorders) {
                if (!clipRect || (cx + w > clipRect.minX && cx < clipRect.maxX && vy + h > clipRect.minY && vy < clipRect.maxY)) {
                  if (!isEmpty) {
                    cellDataList.push(collectCellData(r, c, cx, vy, w, h, clipRect, cell, val));
                  }
                  drawCellBorders(ctx, r, c, cx, vy, w, h, borderBatch);
                }
              }
            }
            cx += w;
            if (cx > W) break;
          }
        }
        vy += h;
        if (vy > H) break;
      }

      drawCellsBatched(ctx, cellDataList, null);
      _drawBatchedBorders(ctx, borderBatch);
    };

    const frozenBg = tableContext.state.tableTheme.frozenBg || null;

    const rowPos = wb.getRowPos(startRow);
    const colPos = wb.getColPos(startCol);
    const vyBody = CH + rowPos - tableContext.state.scrollY;
    const vxBody = RW + colPos - tableContext.state.scrollX;

    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyStartX, bodyStartY, W - bodyStartX, H - bodyStartY);
    ctx.clip();
    drawRangeBatched(startRow, endRow, startCol, endCol, vxBody, vyBody, {
      minX: bodyStartX,
      minY: bodyStartY,
      maxX: W,
      maxY: H
    });
    ctx.restore();

    if (freezeC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, bodyStartY, frozenWidth, H - bodyStartY);
      ctx.clip();
      if (frozenBg) {
        ctx.fillStyle = frozenBg;
        ctx.fillRect(RW, bodyStartY, frozenWidth, H - bodyStartY);
      }
      drawRangeBatched(startRow, endRow, 0, freezeEndCol, RW, vyBody, {
        minX: RW,
        minY: bodyStartY,
        maxX: bodyStartX,
        maxY: H
      }, true, true);
      ctx.restore();
    }

    if (freezeR > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(bodyStartX, CH, W - bodyStartX, frozenHeight);
      ctx.clip();
      if (frozenBg) {
        ctx.fillStyle = frozenBg;
        ctx.fillRect(bodyStartX, CH, W - bodyStartX, frozenHeight);
      }
      drawRangeBatched(0, freezeEndRow, startCol, endCol, vxBody, CH, {
        minX: bodyStartX,
        minY: CH,
        maxX: W,
        maxY: bodyStartY
      }, true, true);
      ctx.restore();
    }

    if (freezeR > 0 && freezeC > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW, CH, frozenWidth, frozenHeight);
      ctx.clip();
      if (frozenBg) {
        ctx.fillStyle = frozenBg;
        ctx.fillRect(RW, CH, frozenWidth, frozenHeight);
      }
      drawRangeBatched(0, freezeEndRow, 0, freezeEndCol, RW, CH, {
        minX: RW,
        minY: CH,
        maxX: bodyStartX,
        maxY: bodyStartY
      }, true, true);
      ctx.restore();
    }

    ctx.restore();
    _updateAriaGrid(visibleRange);
  }

  return {
    _getVisibleRange,
    measureTextWithCache,
    importMeasuredMetrics,
    _scanPreloadText,
    measureTextBatch,
    collectCellData,
    drawCellsBatched,
    _drawBatchedBackgrounds,
    _drawBatchedTexts,
    drawCellBorders,
    _drawBatchedBorders,
    drawColHeader,
    drawRowHeader,
    drawCopySelection,
    _renderSelection,
    _renderAnimation,
    drawSelectionInQuadrants,
    drawCollaborativeCursorsInQuadrants,
    _hexToRgba,
    _drawRoundedRect,
    _getGridRenderSignature,
    _getGridCacheContext,
    _renderGrid,
    _renderHeaders,
    _updateAriaGrid,
    cleanupCanvasRender,
    invalidateCore,
    invalidate,
    _runRenderMainThread,
    _finishContentRender,
    _flushOverlayRender,
    render
  };
}
