
/**
 * 文本测量缓存优化
 *
 * 优化策略：
 * 1. 分层缓存：字体级别缓存 + 文本级别缓存
 * 2. 数字文本特殊处理：数字是高频重复文本
 * 3. 高效 LRU：使用双向链表实现真正的 LRU
 * 4. 字体状态缓存：避免重复设置字体
 */
import { MetricTypes } from '../../../core/utils/PerformanceMonitor';
import { VirtualScrollManager } from '../../../core/render/VirtualScrollManager';
import {
  LRUCache,
  canCacheTextBitmap,
  getBitmapDrawPosition,
  getLineStartX,
  getSingleLineDecoration,
  getSingleLineTextLayout,
  getTextBitmapSize,
  getWrappedTextLayout,
  makeTextBitmapCacheKey,
  makeTextCacheKey,
  measureTextWidth,
  parseFontSize
} from '../../../core/render/TextLayout';
import { formatCellText } from '../utils/formatCellText';
import { getBorderProps } from '../utils/borderUtils';
import { calcMergeSize } from '../utils/cellUtils';
// ============================================================================
// 边框绘制优化
// ============================================================================

/**
 * 边框样式配置缓存
 * 避免重复解析样式字符串
 */
const BorderStyleCache = {
  solid: { dash: [], width: 1 },
  dashed: { dash: [4, 4], width: 1 },
  dotted: { dash: [2, 2], width: 1 }
};

/**
 * 边框坐标数据收集器
 * 使用 TypedArray 优化内存和性能
 */
class BorderCoordCollector {
  constructor(initialCapacity = 256) {
    this.initialCapacity = initialCapacity;
    this.data = null;
    this.reset();
  }

  /**
   * 重置收集器
   */
  reset() {
    // 使用普通数组，避免 TypedArray 的创建开销
    // 对于边框数据量来说，普通数组更灵活
    this.data = {};
  }

  /**
   * 添加边框线段
   * @param {string} color - 颜色
   * @param {string} style - 样式
   * @param {number} x1 - 起点 X
   * @param {number} y1 - 起点 Y
   * @param {number} x2 - 终点 X
   * @param {number} y2 - 终点 Y
   */
  addLine(color, style, x1, y1, x2, y2) {
    const key = `${color}|${style}`;
    if (!this.data[key]) {
      this.data[key] = [];
    }
    const arr = this.data[key];
    arr.push(x1, y1, x2, y2);
  }

  /**
   * 获取收集的数据
   * @returns {Object} 边框数据
   */
  getData() {
    return this.data;
  }

  /**
   * 获取总边框线段数量
   * @returns {number}
   */
  getLineCount() {
    let count = 0;
    for (const key in this.data) {
      count += this.data[key].length / 4;
    }
    return count;
  }
}

// 全局边框坐标收集器
const borderCoordCollector = new BorderCoordCollector(256);

// 文本测量缓存
const TextCache = new LRUCache(2000);

// 数字文本专用缓存（数字文本更短，可以更激进地缓存）
const NumberCache = new LRUCache(500);

// 自动换行文本缓存
const WrappedTextCache = new LRUCache(1000);

// 短文本位图缓存：数字、表头、短状态文本会在滚动时高频重复出现
const TextBitmapCache = new LRUCache(600, (_key, bitmap) => {
  if (bitmap && bitmap.canvas) {
    bitmap.canvas.width = 0;
    bitmap.canvas.height = 0;
  }
});

// 当前字体状态缓存
const textFontState = { current: null };
const HEX_COLOR_RE = /^#([A-Fa-f0-9]{3}){1,2}$/;

export default {
  methods: {
    /**
     * 计算可见区域范围
     * 返回当前视口内可见的行列范围，包含缓冲区
     * @returns {Object} { startRow, endRow, startCol, endCol, freezeStartRow, freezeEndRow, freezeStartCol, freezeEndCol }
     */
    _getVisibleRange() {
      if (!this.workbook) return null;
      
      if (!this._virtualScrollManager || this._virtualScrollManager.workbook !== this.workbook) {
        this._virtualScrollManager = new VirtualScrollManager(this.workbook);
      }
      
      this._virtualScrollManager.scrollX = this.scrollX;
      this._virtualScrollManager.scrollY = this.scrollY;
      
      const range = this._virtualScrollManager.getVisibleRange(
        this.width, this.height, this.rowHeaderWidth, this.colHeaderHeight
      );
      
      this._virtualScrollManager.triggerPreload(range);
      
      return range;
    },

    /**
     * 测量文本宽度（带缓存）
     * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
     * @param {string} text - 要测量的文本
     * @param {string} font - 字体设置
     * @returns {number} 文本宽度
     */
    measureTextWithCache(ctx, text, font) {
        return measureTextWidth(ctx, text, font, {
          textCache: TextCache,
          numberCache: NumberCache,
          fontState: textFontState
        });
    },

    /**
     * 批量导入测量结果
     * @param {Map|Object} metricsMap - 包含 { key: width } 的对象
     */
    importMeasuredMetrics(metricsMap) {
      if (!metricsMap) return;
      for (const key in metricsMap) {
        if (!TextCache.has(key)) {
          TextCache.set(key, metricsMap[key]);
        }
      }
    },

    /**
     * 扫描指定范围内的单元格文本，用于预测量
     * @param {Object} range - 行列范围 {startRow, endRow, startCol, endCol}
     * @returns {Array<{text: string, font: string, key: string}>}
     */
    _scanPreloadText(range) {
      const items = [];
      const seen = new Set();
      const wb = this.workbook;
      
      for (let r = range.startRow; r <= range.endRow; r++) {
        for (let c = range.startCol; c <= range.endCol; c++) {
          const val = wb.getCellValue(r, c);
          if (val === null || val === undefined || val === '') continue;
          
          const text = String(val);
          const cell = wb.getCell(r, c);
          const s = cell ? cell.s : null;
          
          let fontFunc = '';
          if (s && (s.fw === 'bold' || s.bold)) fontFunc += 'bold ';
          if (s && (s.fs === 'italic' || s.italic)) fontFunc += 'italic ';
          const fSize = (s && s.fontSize) ? s.fontSize + 'px' : this.tableTheme.fontSize;
          const font = `${fontFunc}${fSize} ${this.tableTheme.fontFamily}`;
          
          const key = makeTextCacheKey(font, text);
          if (!TextCache.has(key) && !NumberCache.has(key) && !seen.has(key)) {
            items.push({ text, font, key });
            seen.add(key);
          }
          
          // 限制单词预取的数量，避免 Worker 任务过重
          if (items.length > 200) return items;
        }
      }
      return items;
    },

    /**
     * 批量测量文本宽度（减少字体状态切换）
     * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
     * @param {Array<{text: string, font: string}>} items - 要测量的文本项
     * @returns {Array<number>} 文本宽度数组
     */
    measureTextBatch(ctx, items) {
        const results = new Array(items.length);
        const fontGroups = new Map();
        
        // 按字体分组
        for (let i = 0; i < items.length; i++) {
          const { text, font } = items[i];
          if (!fontGroups.has(font)) {
            fontGroups.set(font, []);
          }
          fontGroups.get(font).push({ index: i, text });
        }
        
        // 按字体批量测量
        for (const [font, group] of fontGroups) {
          for (const { index, text } of group) {
            results[index] = this.measureTextWithCache(ctx, text, font);
          }
        }
        
        return results;
    },

    /**
     * 收集单元格渲染数据用于批量绘制
     * @returns {Object} 包含背景、文本、网格线数据的对象
     */
    collectCellData(r, c, x, y, w, h, clipRect = null, cell, val) {
      // 调用方（主渲染循环）通常已取到 cell/val，直接复用避免二次查找；
      // 未传入时（如渐进式渲染路径）回退内部查询，保持兼容。
      if (cell === undefined) cell = this.workbook.getCell(r, c);
      if (val === undefined) val = this.workbook.getCellValue(r, c);
      const s = cell ? cell.s : null;

      const cellData = {
        r, c, x, y, w, h,
        bg: (s && (s.bg || s.bgcolor)) ? (s.bg || s.bgcolor) : null,
        text: null,
        gridLine: true,
        clip: clipRect ? { x: clipRect.minX, y: clipRect.minY, w: clipRect.maxX - clipRect.minX, h: clipRect.maxY - clipRect.minY } : null
      };

      // 收集文本数据
      if (val !== null && val !== undefined && val !== '') {
        // Font & Style
        let fontFunc = '';
        if (s && (s.fw === 'bold' || s.bold)) fontFunc += 'bold ';
        if (s && (s.fs === 'italic' || s.italic)) fontFunc += 'italic ';
        const fSize = (s && s.fontSize) ? s.fontSize + 'px' : this.tableTheme.fontSize;
        const fontSetting = `${fontFunc}${fSize} ${this.tableTheme.fontFamily}`;

        // Color
        const textColor = (s && s.color) ? s.color : this.tableTheme.textColor;

        // Alignment
        const align = (s && s.align) ? s.align : 'left';
        const valign = (s && s.valign) ? s.valign : 'middle';

        // Handle Number Formatting
        const formattedText = formatCellText(val, s);

        const isWrap = s && s.wrap;
        const padding = 4;

        cellData.text = {
          content: formattedText,
          font: fontSetting,
          color: textColor,
          align,
          valign,
          fSize,
          isWrap,
          padding,
          style: s
        };
      }

      return cellData;
    },

    /**
     * 批量绘制背景 - 按颜色分组减少状态切换
     */
    _drawBatchedBackgrounds(ctx, bgGroups) {
      for (const color in bgGroups) {
        const rects = bgGroups[color];
        ctx.fillStyle = color;
        for (let i = 0; i < rects.length; i += 4) {
          ctx.fillRect(rects[i], rects[i+1], rects[i+2], rects[i+3]);
        }
      }
    },

    /**
     * 批量绘制文本 - 按字体分组减少状态切换
     */
    _drawBatchedTexts(ctx, textGroups, cellDataList) {
      // 跨格缓存已写入的文本状态，仅在变化时写 canvas（其中 font 字符串解析开销显著）。
      // 关键：状态在任何 clip 的 save() 之前写入，使其成为被保存的基线状态——clip 的
      // save/restore 只还原到该基线，不会抹掉它，故相邻同样式单元格可命中缓存跳过重复 set。
      // textBaseline 不在此缓存：_drawSingleLineText / _drawWrappedText 各自会按需设置。
      let lastFont = null, lastFill = null, lastAlign = null;
      for (const cellData of cellDataList) {
        if (!cellData.text) continue;
        const { text, x, y, w, h, clip } = cellData;

        if (lastFont !== text.font) { ctx.font = text.font; lastFont = text.font; }
        if (lastFill !== text.color) { ctx.fillStyle = text.color; lastFill = text.color; }
        if (lastAlign !== text.align) { ctx.textAlign = text.align; lastAlign = text.align; }

        // 应用区域的物理裁剪保护（解决主线程异步渐进式渲染没有全局裁剪而越界叠字的问题）
        const hasGlobalClip = !!clip;
        if (hasGlobalClip) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(clip.x, clip.y, clip.w, clip.h);
          ctx.clip();
        }

        // 性能优化：检查是否真的需要裁剪
        // 自动换行文本由于高度不确定，始终建议裁剪
        let needsClip = true;
        if (!text.isWrap) {
          const padding = text.padding || 0;
          const available = w - padding * 2;
          // 启发式上界：每个字符的宽度不超过 1 em（fSize），可同时覆盖 ASCII 与 CJK。
          // 上界都装得下时直接跳过 measureText，省掉缓存查询/键构造/底层测量。
          const fSize = text.fSize || 13;
          const upperBound = text.content.length * fSize;
          if (upperBound <= available) {
            needsClip = false;
          } else {
            const textWidth = this.measureTextWithCache(ctx, text.content, text.font);
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

        if (text.isWrap) {
          this._drawWrappedText(ctx, text.content, x, y, w, h, text.padding, text.align, text.valign, text.fSize, text.color, text.style);
        } else {
          this._drawSingleLineText(ctx, text.content, x, y, w, h, text.padding, text.align, text.valign, text.fSize, text.color, text.style);
        }

        if (needsClip) {
          ctx.restore();
        }

        if (hasGlobalClip) {
          ctx.restore();
        }
      }
    },

    /**
     * 批量绘制单元格 - 主入口
     * 优化：移除网格线绘制，已由背景层承担
     */
    drawCellsBatched(ctx, cellDataList, gridLines = null) {
      // 1. 按背景色分组
      const bgGroups = {};
      
      for (const cell of cellDataList) {
        // 收集非白背景
        if (cell.bg && cell.bg !== '#ffffff') {
          if (!bgGroups[cell.bg]) bgGroups[cell.bg] = [];
          bgGroups[cell.bg].push(cell.x, cell.y, cell.w, cell.h);
        }
      }

      // 2. 批量绘制自定义背景
      this._drawBatchedBackgrounds(ctx, bgGroups);

      // 3. 批量绘制文本
      this._drawBatchedTexts(ctx, null, cellDataList);

      // 4. 绘制被他人锁定的单元格特殊半透明遮罩与右上角锁头 🔒
      if (this.workbook && this.workbook.plugins) {
        const isEditLockedFn = this.workbook.plugins.getSharedState('collaboration:isCellEditLocked') ||
                               this.workbook.plugins.getSharedState('collaboration:isCellLocked');
        const getEditingDraftFn = this.workbook.plugins.getSharedState('collaboration:getEditingDraft');
        if (isEditLockedFn) {
          for (const cell of cellDataList) {
            if (isEditLockedFn(cell.r, cell.c)) {
              ctx.save();
              // 绘制淡淡的橙黄色半透明背景，表示锁定
              ctx.fillStyle = 'rgba(230, 126, 34, 0.08)'; // 温暖高档的琥珀橙
              ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
              
              // 绘制右上角的小锁头 🔒 标识
              ctx.font = '10px "Segoe UI Symbol", "Apple Color Emoji", sans-serif';
              ctx.fillStyle = '#e67e22'; // 琥珀橙
              ctx.textAlign = 'right';
              ctx.textBaseline = 'top';
              ctx.fillText('🔒', cell.x + cell.w - 3, cell.y + 3);

              // 检查是否有来自其他协同用户的临时打字草稿
              if (getEditingDraftFn) {
                const draft = getEditingDraftFn(cell.r, cell.c);
                if (draft && draft.value !== undefined && draft.value !== null) {
                  // 1. 擦除原有的静态数据文本，用纯白重新覆盖该单元格背景，再叠加微黄半透明锁定层
                  ctx.fillStyle = '#ffffff';
                  ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2); // 留出网格线
                  ctx.fillStyle = 'rgba(230, 126, 34, 0.08)';
                  ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
                  
                  // 补画刚才被擦除的右上角小锁头 🔒
                  ctx.font = '10px "Segoe UI Symbol", "Apple Color Emoji", sans-serif';
                  ctx.fillStyle = '#e67e22';
                  ctx.textAlign = 'right';
                  ctx.textBaseline = 'top';
                  ctx.fillText('🔒', cell.x + cell.w - 3, cell.y + 3);

                  // 2. 以高雅的“灰色斜体”在单元格正中间偏左绘制草稿文本
                  ctx.fillStyle = '#7f8c8d'; // 优雅的灰色
                  ctx.font = 'italic 11px Inter, sans-serif';
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'middle';
                  
                  // 测量并截断草稿文本以防止溢出单元格边界
                  const padding = 5;
                  const maxTextWidth = cell.w - padding * 2 - 15; // 预留右侧锁头和右下角输入提示空间
                  let text = String(draft.value);
                  if (ctx.measureText(text).width > maxTextWidth) {
                    while (text.length > 0 && ctx.measureText(text + '...').width > maxTextWidth) {
                      text = text.slice(0, -1);
                    }
                    text = text + '...';
                  }
                  ctx.fillText(text, cell.x + padding, cell.y + cell.h / 2);

                  // 3. 在右下角绘制精致小字 “XXX 正在输入...” 微动画
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
    },

    _canUseTextBitmap(text, style) {
      return canCacheTextBitmap(text, style);
    },

    _getTextBitmap(ctx, text, font, color) {
      if (typeof document === 'undefined') return null;

      const key = makeTextBitmapCacheKey(font, color, text);
      const cached = TextBitmapCache.get(key);
      if (cached) return cached;

      const size = getTextBitmapSize(this.measureTextWithCache(ctx, text, font), font);
      if (!size) return null;

      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const bitmapCtx = canvas.getContext('2d');
      if (!bitmapCtx) return null;

      bitmapCtx.font = font;
      bitmapCtx.fillStyle = color;
      bitmapCtx.textAlign = 'left';
      bitmapCtx.textBaseline = 'middle';
      bitmapCtx.fillText(text, 2, size.height / 2);

      const bitmap = { canvas, width: size.width, height: size.height };
      TextBitmapCache.set(key, bitmap);
      return bitmap;
    },

    _drawSingleLineText(ctx, text, x, y, w, h, padding, align, valign, fSize, color, s) {
        const bitmap = this._canUseTextBitmap(text, s) ? this._getTextBitmap(ctx, text, ctx.font, color) : null;
        const { textX, textY, baseline } = getSingleLineTextLayout({ x, y, w, h, padding, align, valign });
        ctx.textBaseline = baseline;

        if (bitmap) {
            const { drawX, drawY } = getBitmapDrawPosition({
              textX,
              textY,
              align,
              baseline,
              bitmapWidth: bitmap.width,
              bitmapHeight: bitmap.height
            });
            ctx.drawImage(bitmap.canvas, drawX, drawY);
        } else {
            ctx.fillText(text, textX, textY);
        }

        if (s && s.td === 'line-through') {
            const width = this.measureTextWithCache(ctx, text, ctx.font);
            const line = getSingleLineDecoration({
              textX,
              textY,
              align,
              baseline,
              width,
              fontSize: parseFontSize(fSize)
            });

            ctx.beginPath();
            ctx.moveTo(line.x1, line.y1);
            ctx.lineTo(line.x2, line.y2);
            ctx.strokeStyle = color; // Use text color for strikethrough
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    },

    _drawWrappedText(ctx, text, x, y, w, h, padding, align, valign, fSize, color, s) {
         // Force middle baseline for wrapped text
         ctx.textBaseline = 'middle';

         const availableWidth = w - padding * 2;
         if (availableWidth <= 0) return;

         const font = ctx.font;
         const layout = getWrappedTextLayout({
           text,
           x,
           y,
           w,
           h,
           padding,
           align,
           valign,
           fSize,
           font,
           cache: WrappedTextCache,
           ctx,
           fontState: textFontState,
           measureText: (value, activeFont) => this.measureTextWithCache(ctx, value, activeFont)
         });

         layout.lines.forEach((line, i) => {
           ctx.fillText(line, layout.startX, layout.startY + i * layout.lineHeight);
         });

          if (s && s.td === 'line-through') {
            layout.lines.forEach((line, i) => {
              const lineW = this.measureTextWithCache(ctx, line, font);
              const sx = getLineStartX(layout.startX, align, lineW);
              const sy = layout.startY + i * layout.lineHeight; // Approximate middle of line

              ctx.beginPath();
              ctx.moveTo(sx, sy);
              ctx.lineTo(sx + lineW, sy);
              ctx.strokeStyle = color;
              ctx.lineWidth = 1;
              ctx.stroke();
            });
          }
    },

    /**
     * 绘制单元格边框（优化版本）
     *
     * 优化点：
     * 1. 使用预缓存的边框样式配置
     * 2. 减少对象创建
     * 3. 批量收集边框数据
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
     * @param {number} r - 行索引
     * @param {number} c - 列索引
     * @param {number} x - X 坐标
     * @param {number} y - Y 坐标
     * @param {number} w - 宽度
     * @param {number} h - 高度
     * @param {Object} batchAccumulator - 边框批量数据累加器（可选）
     */
    drawCellBorders(ctx, r, c, x, y, w, h, batchAccumulator = null) {
      const cell = this.workbook.getCell(r, c);
      const s = cell ? cell.s : null;

      if (!s || !s.border) return;

      const { top, bottom, left, right } = s.border;
      if (!top && !bottom && !left && !right) return;

      // 预计算坐标（+0.5 用于像素对齐）
      const bx = x + 0.5;
      const by = y + 0.5;
      const bxw = bx + w;
      const byh = by + h;

      // 绘制各边
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
        // 直接绘制模式：按样式分组并使用 Path2D
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
    },

    /**
     * 批量绘制边框（优化版本）
     *
     * 优化点：
     * 1. 使用预缓存的边框样式配置
     * 2. 减少字符串分割操作
     * 3. 先处理 solid 边框（最常见情况）
     * 4. 使用缓存的样式对象
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
     * @param {Object} batch - 边框批量数据
     */
    _drawBatchedBorders(ctx, batch) {
        if (!batch) return;
        
        const keys = Object.keys(batch);
        if (keys.length === 0) return;

        ctx.save();
        ctx.lineWidth = 1;

        // 优化：使用 Path2D 预编译路径，减少 Canvas 状态指令
        // 分离 solid 和其他样式
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

        // 绘制 solid 边框
        if (solidKeys.length > 0) {
          ctx.setLineDash([]);
          
          for (let i = 0; i < solidKeys.length; i++) {
            const key = solidKeys[i];
            const color = key.slice(0, -6);
            const coords = batch[key];

            ctx.strokeStyle = color;
            
            // 使用 Path2D 收集路径
            const path = new Path2D();
            for (let j = 0; j < coords.length; j += 4) {
              path.moveTo(coords[j], coords[j + 1]);
              path.lineTo(coords[j + 2], coords[j + 3]);
            }
            ctx.stroke(path);
          }
        }

        // 绘制其他样式边框
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
    },

    drawColHeader(ctx, c, x, w, h) {
      ctx.fillStyle = this.tableTheme.headerBg;
      ctx.fillRect(x, 0, w, h);
      ctx.strokeStyle = this.tableTheme.borderColor;
      ctx.strokeRect(x, 0, w, h);

      if (this.workbook.selection && this.workbook.selection.s.c <= c && this.workbook.selection.e.c >= c) {
        ctx.fillStyle = this.tableTheme.selectionBg;
        ctx.fillRect(x, 0, w, h);
      }

      ctx.fillStyle = this.tableTheme.textColor;
      ctx.textAlign = 'center';
      ctx.font = `${this.tableTheme.headerFontSize} ${this.tableTheme.fontFamily}`;

      ctx.fillText(this.workbook._indexToColStr(c), x + w / 2, h / 2);
    },

    /**
     * 渲染选区层（静态部分）
     * 包括：选区背景、边框、填充手柄
     * 只在选区变化时重绘，不受动画影响
     */
    _renderSelection() {
      if (!this.ctxSelection || !this.workbook) return;
      const ctx = this.ctxSelection;
      const wb = this.workbook;

      const W = this.width;
      const H = this.height;
      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);

      ctx.clearRect(0, 0, W, H);

      // 绘制左上角全选方块（在选区层，确保不被内容层遮挡）
      const theme = this.tableTheme || TableTheme;
      ctx.fillStyle = theme.headerBg;
      ctx.fillRect(0, 0, RW, CH);
      // 三角形指示器
      ctx.beginPath();
      ctx.moveTo(RW - 10, CH - 2);
      ctx.lineTo(RW - 2, CH - 2);
      ctx.lineTo(RW - 2, CH - 10);
      ctx.closePath();
      ctx.fillStyle = theme.borderColor;
      ctx.fill();

      const freezeC = wb.freeze.c || 0;
      const freezeR = wb.freeze.r || 0;
      const { w: frozenWidth, h: frozenHeight } = wb.getFrozenSize();

      const sel = wb.selection;
      if (sel) {
        let startRow = freezeR;
        if (this.scrollY > 0) {
            const frozenH = wb.getRowPos(freezeR);
            const targetY = frozenH + this.scrollY;
            const idx = wb.getRowIndexAt(targetY);
            if (idx !== -1) startRow = idx;
        }
        const vyBody = CH + wb.getRowPos(startRow) - this.scrollY;

        this.drawSelectionInQuadrants(ctx, sel, freezeR, freezeC, frozenWidth, frozenHeight, RW, CH, W, H, vyBody, false);
      }

      // Draw collaborative cursors
      this.drawCollaborativeCursorsInQuadrants(ctx, freezeR, freezeC, frozenWidth, frozenHeight, RW, CH, W, H);
    },

    /**
     * 渲染动画层（动态部分）
     * 包括：蚂蚁线动画
     * 每帧重绘，不影响选区层
     */
    _renderAnimation() {
      if (!this.ctxAnimation || !this.workbook) return;
      const ctx = this.ctxAnimation;
      const wb = this.workbook;

      const W = this.width;
      const H = this.height;
      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);

      ctx.clearRect(0, 0, W, H);

      const range = wb.copyRange;
      if (!range) return;

      const freezeC = wb.freeze.c || 0;
      const freezeR = wb.freeze.r || 0;

      // 使用缓存的冻结区域尺寸
      const { w: frozenWidth, h: frozenHeight } = wb.getFrozenSize();

      let startRow = freezeR;
      if (this.scrollY > 0) {
          const frozenH = wb.getRowPos(freezeR);
          const targetY = frozenH + this.scrollY;
          const idx = wb.getRowIndexAt(targetY);
          if (idx !== -1) startRow = idx;
      }
      const vyBody = CH + wb.getRowPos(startRow) - this.scrollY;

      this.drawCopySelectionAnimation(ctx, range, freezeR, freezeC, frozenWidth, frozenHeight, RW, CH, W, H);
    },

    /**
     * 绘制蚂蚁线动画（独立方法）
     * 只绘制复制范围的蚂蚁线，不绘制选区
     */
    drawCopySelectionAnimation(ctx, range, fR, fC, fW, fH, RW, CH, W, H) {
      const wb = this.workbook;

      const getRect = (r1, c1, r2, c2) => {
        const x = wb.getColPos(c1);
        const y = wb.getRowPos(r1);
        const w = wb.getColPos(c2 + 1) - x;
        const h = wb.getRowPos(r2 + 1) - y;
        return { x, y, w, h };
      };

      const drawCopySelection = (ox, oy) => {
        const cRect = getRect(range.s.r, range.s.c, range.e.r, range.e.c);
        const cx = ox + cRect.x;
        const cy = oy + cRect.y;

        ctx.save();
        ctx.lineWidth = 2;

        const time = Date.now() / 100;
        ctx.setLineDash([4, 4]);

        ctx.lineDashOffset = -time % 8;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(cx, cy, cRect.w, cRect.h);

        ctx.lineDashOffset = (-time % 8) + 4;
        ctx.strokeStyle = '#217346';
        ctx.strokeRect(cx, cy, cRect.w, cRect.h);

        ctx.restore();
      };

      // 在主体区域绘制
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
      ctx.clip();
      drawCopySelection(RW - this.scrollX, CH - this.scrollY);
      ctx.restore();

      // 在冻结区域绘制
      if (fR > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW + fW, CH, W - (RW + fW), fH);
        ctx.clip();
        drawCopySelection(RW - this.scrollX, CH);
        ctx.restore();
      }

      if (fC > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW, CH + fH, fW, H - (CH + fH));
        ctx.clip();
        drawCopySelection(RW, CH - this.scrollY);
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
    },

    invalidateCore(rect = null) {
      if (this._virtualScrollManager) {
        this._virtualScrollManager.invalidateCache();
      }

      if (!rect) {
        this.fullRedraw = true;
        this.dirtyRect = null;
      } else if (!this.fullRedraw) {
        if (!this.dirtyRect) {
          this.dirtyRect = { ...rect };
        } else {
          // Merge rects
          const x1 = Math.min(this.dirtyRect.x, rect.x);
          const y1 = Math.min(this.dirtyRect.y, rect.y);
          const x2 = Math.max(this.dirtyRect.x + this.dirtyRect.w, rect.x + rect.w);
          const y2 = Math.max(this.dirtyRect.y + this.dirtyRect.h, rect.y + rect.h);
          this.dirtyRect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
      }
      this.renderContentRequested = true;
      this.renderSelectionRequested = true;
      this.renderGridRequested = true;
      this.gridVersion = (this.gridVersion || 0) + 1;
      this.render();
    },

    invalidate(rect = null) {
      this.invalidateCore(rect);
    },

    // ── 预绑定渲染子步骤，避免每帧 requestAnimationFrame 内重建闭包 ──

    _runRenderMainThread() {
      const useProgressive = this.shouldUseProgressiveRender && this.shouldUseProgressiveRender();
      if (useProgressive && this.startProgressiveRender) {
        this.startProgressiveRender();
      } else {
        const monitor = this.workbook.getPerformanceMonitor();
        const metricType = this.fullRedraw ? MetricTypes.RENDER_FULL : MetricTypes.RENDER_PARTIAL;
        if (monitor && monitor.enabled) {
          monitor.measure(metricType, () => { this._renderContent(); });
        } else {
          this._renderContent();
        }
      }
    },

    _finishContentRender() {
      this.renderContentRequested = false;
      this.renderSelectionRequested = true;
    },

    _flushOverlayRender() {
      if (this.renderSelectionRequested) {
        this._renderSelection();
        this.renderSelectionRequested = false;
      }
      if (this.renderAnimationRequested) {
        this._renderAnimation();
        this.renderAnimationRequested = false;
      }
    },

    render() {
      if ((!this.ctx && !this.isOffscreenActive) || !this.workbook) return;

      if (this.pendingRender) return;
      this.pendingRender = true;
      requestAnimationFrame(() => {
        this.pendingRender = false;

        // 渐进式渲染正在进行，只刷新覆盖层
        if (this.progressiveRenderer && this.progressiveState && this.progressiveState.isRendering) {
          this._flushOverlayRender();
          return;
        }

        if (this.renderGridRequested) {
          this._renderGrid();
          this.renderGridRequested = false;
        }

        if (this.renderContentRequested) {
          const useWorker = this.shouldUseWorkerRender && this.shouldUseWorkerRender();
          if (useWorker && this._renderContentWithWorker) {
            this._renderContentWithWorker().then((success) => {
              if (!success) this._runRenderMainThread();
              this._finishContentRender();
              this._flushOverlayRender();
            }).catch((error) => {
              console.error('[CanvasRenderMixin] Worker render failed:', error);
              this._runRenderMainThread();
              this._finishContentRender();
              this._flushOverlayRender();
            });
            return;
          }

          this._runRenderMainThread();
          this._finishContentRender();
        }

        this._flushOverlayRender();
      });
    },

    _renderContent() {
      if (!this.ctx || !this.workbook) return;
      const ctx = this.ctx;
      const wb = this.workbook;

      const W = this.width;
      const H = this.height;
      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);

      const visibleRange = this._getVisibleRange();
      if (!visibleRange) return;

      const {
        freezeR, freezeC, frozenWidth, frozenHeight,
        startRow, endRow, startCol, endCol,
        freezeEndRow, freezeEndCol,
        bodyStartX, bodyStartY
      } = visibleRange;

      const isPartial = !this.fullRedraw && this.dirtyRect;
      const renderRect = isPartial ? { ...this.dirtyRect } : { x: 0, y: 0, w: W, h: H };

      // 部分重绘时把冻结区域并入脏矩形，保证冻结区的清屏+裁剪+不透明底色生效
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

      this.fullRedraw = false;
      this.dirtyRect = null;

      ctx.save();

      // 1. 基础清理
      if (!isPartial) {
        ctx.clearRect(0, 0, W, H);
      } else {
        ctx.clearRect(renderRect.x, renderRect.y, renderRect.w, renderRect.h);
      }

      // 2. 核心裁剪：确保内容不会溢出到表头
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
      ctx.font = `${this.tableTheme.fontSize} ${this.tableTheme.fontFamily}`;

      const intersects = (r1, r2) => {
        return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
      };

      const drawRangeBatched = (rStart, rEnd, cStart, cEnd, offsetX, offsetY, clipRect = null, forceFull = false, drawEmptyBorders = false) => {
        const cellDataList = [];
        const borderBatch = {};
        // 冻结区域不滚动，始终需要完整重绘（背景填充会先擦除整个区域）
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
                    if (intersects({x: cx, y: vy, w: mw, h: mh}, cellRenderRect)) {
                      // 物理裁剪过滤，防止滚动时边缘有微小溢出单元格越界画到冻结区域内
                      if (!clipRect || (cx + mw > clipRect.minX && cx < clipRect.maxX && vy + mh > clipRect.minY && vy < clipRect.maxY)) {
                        cellDataList.push(this.collectCellData(r, c, cx, vy, mw, mh, clipRect, cell, val));
                        this.drawCellBorders(ctx, r, c, cx, vy, mw, mh, borderBatch);
                      }
                    }
                  }
                } else if (!isEmpty || drawEmptyBorders) {
                  // 物理裁剪过滤
                  if (!clipRect || (cx + w > clipRect.minX && cx < clipRect.maxX && vy + h > clipRect.minY && vy < clipRect.maxY)) {
                    if (!isEmpty) {
                      cellDataList.push(this.collectCellData(r, c, cx, vy, w, h, clipRect, cell, val));
                    }
                    this.drawCellBorders(ctx, r, c, cx, vy, w, h, borderBatch);
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

        this.drawCellsBatched(ctx, cellDataList, null);
        this._drawBatchedBorders(ctx, borderBatch);
      };

      // 冻结区域底色：优先使用 frozenBg 配置，否则不填充（使用普通单元格默认背景）
      const frozenBg = this.tableTheme.frozenBg || null;

      const rowPos = wb.getRowPos(startRow);
      const colPos = wb.getColPos(startCol);
      const vyBody = CH + rowPos - this.scrollY;
      const vxBody = RW + colPos - this.scrollX;

      // 1. 绘制主体区域
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

      // 2. 绘制冻结列
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

      // 3. 绘制冻结行
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

      // 4. 绘制左上角冻结区域
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
      this._updateAriaGrid(visibleRange);
    },

    /**
     * 更新辅助功能网格（ARIA Grid）
     * 仅在可见区域渲染 DOM，平衡可访问性与性能
     */
    _updateAriaGrid(range) {
      const wb = this.workbook;
      if (!wb) return;

      this.totalRowCount = wb.rowCount;
      this.totalColCount = wb.colCount;

      // 优先复用 getVisibleRange 已算好的精确可见范围，省掉这 4 次二分查找；
      // 缺省（未传 range）时回退自行二分，保持独立可用。
      let startRow, endRow, startCol, endCol;
      if (range) {
        startRow = range.exactStartRow;
        endRow = range.exactEndRow;
        startCol = range.exactStartCol;
        endCol = range.exactEndCol;
      } else {
        const RW = this.rowHeaderWidth;
        const CH = this.colHeaderHeight;
        const W = this.width;
        const H = this.height;
        startRow = wb.getRowIndexAt(this.scrollY);
        endRow = wb.getRowIndexAt(this.scrollY + H - CH);
        startCol = wb.getColIndexAt(this.scrollX);
        endCol = wb.getColIndexAt(this.scrollX + W - RW);
      }

      if (startRow === -1 || startCol === -1) return;

      // 缓存上次的范围，仅在真正变化时才重建数组触发 Vue diff
      const prevStartRow = this._ariaStartRow;
      const prevEndRow = this._ariaEndRow;
      const prevStartCol = this._ariaStartCol;
      const prevEndCol = this._ariaEndCol;

      if (startRow === prevStartRow && endRow === prevEndRow &&
          startCol === prevStartCol && endCol === prevEndCol) {
        return;
      }

      this._ariaStartRow = startRow;
      this._ariaEndRow = endRow;
      this._ariaStartCol = startCol;
      this._ariaEndCol = endCol;

      const rows = [];
      for (let r = startRow; r <= endRow && r < wb.rowCount; r++) {
        rows.push({ index: r });
      }

      const cols = [];
      for (let c = startCol; c <= endCol && c < wb.colCount; c++) {
        cols.push({ index: c });
      }

      this.ariaRows = rows;
      this.ariaCols = cols;
    },

    drawRowHeader(ctx, r, y, w, h) {
      ctx.fillStyle = this.tableTheme.headerBg;
      if (this.workbook.selection && this.workbook.selection.s.r <= r && this.workbook.selection.e.r >= r) {
        ctx.fillStyle = this.tableTheme.headerHoverBg;
      }
      ctx.fillRect(0, y, w, h);
      ctx.strokeStyle = this.tableTheme.borderColor;
      ctx.strokeRect(0, y, w, h);
      ctx.fillStyle = this.tableTheme.textColor;
      ctx.textAlign = 'center';
      ctx.fillText(String(r + 1), w / 2, y + h / 2);
    },

    drawSelectionInQuadrants(ctx, sel, fR, fC, fW, fH, RW, CH, W, H, vyBody, includeAnimation = true) {
      const wb = this.workbook;
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

        ctx.fillStyle = this.tableTheme.selectionBg;
        if (sel.s.r === sel.e.r && sel.s.c === sel.e.c) {
        } else {
          ctx.beginPath();
          ctx.rect(cx, cy, rect.w, rect.h);
          ctx.rect(ox + activeRect.x, oy + activeRect.y, activeRect.w, activeRect.h);
          ctx.fill('evenodd');
        }

        ctx.lineWidth = 2;
        ctx.strokeStyle = this.tableTheme.selectionBorder;
        ctx.strokeRect(cx, cy, rect.w, rect.h);

        ctx.fillStyle = this.tableTheme.selectionBorder;
        const handleSize = 6;
        const hx = cx + rect.w - handleSize / 2;
        const hy = cy + rect.h - handleSize / 2;
        ctx.fillRect(hx, hy, handleSize, handleSize);

        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(hx, hy, handleSize, handleSize);

        this.fillHandleRect = { x: hx, y: hy, w: handleSize, h: handleSize };
      };

      // 在主体区域绘制
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
      ctx.clip();
      drawSelection(RW - this.scrollX, CH - this.scrollY);
      ctx.restore();

      // 在冻结区域绘制
      if (fR > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW + fW, CH, W - (RW + fW), fH);
        ctx.clip();
        drawSelection(RW - this.scrollX, CH);
        ctx.restore();
      }

      if (fC > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW, CH + fH, fW, H - (CH + fH));
        ctx.clip();
        drawSelection(RW, CH - this.scrollY);
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
    },

    drawCollaborativeCursorsInQuadrants(ctx, fR, fC, fW, fH, RW, CH, W, H) {
      const wb = this.workbook;
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

        // 🛡️ 核心防冲突与第一个人焦点隐藏逻辑
        if (this.workbook.activeCell) {
          const activeR = this.workbook.activeCell.r;
          const activeC = this.workbook.activeCell.c;
          if (
            activeR >= range.startRow &&
            activeR <= range.endRow &&
            activeC >= range.startCol &&
            activeC <= range.endCol
          ) {
            // A. 如果本地正处于打字/编辑状态，直接跳过绘制以防遮挡原生输入框
            if (this.isEditing) {
              return;
            }

            // B. 第一个人（先到者）不显示后来者的焦点：
            // 若本地聚焦时间戳早于或等于该远程用户的聚焦时间戳，说明本地是该单元格的“第一个焦点人”（先到者）
            const getLocalFocusTimeFn = this.workbook.plugins.getSharedState('collaboration:getLocalFocusTime');
            if (getLocalFocusTimeFn) {
              const localFocusTime = getLocalFocusTimeFn() || Date.now();
              const otherFocusTime = item.focusTime || Date.now();
              if (localFocusTime <= otherFocusTime) {
                // 本地是先到者，不显示后来者在这个格子上的虚线与气泡，获得极佳的清爽界面体验
                return;
              }
            }
          }
        }

        const rect = getRect(range.startRow, range.startCol, range.endRow, range.endCol);
        const cx = ox + rect.x;
        const cy = oy + rect.y;

        // 1. 填充半透明背景
        ctx.fillStyle = this._hexToRgba(item.userInfo.color, 0.08);
        ctx.fillRect(cx, cy, rect.w, rect.h);

        // 2. 绘制边框
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = item.userInfo.color;
        ctx.setLineDash([4, 3]); // 使用精美的虚线
        ctx.strokeRect(cx, cy, rect.w, rect.h);
        ctx.setLineDash([]); // 还原实线

        // 3. 绘制带有名字的协同小标签气泡
        ctx.fillStyle = item.userInfo.color;
        const text = item.userInfo.name;
        ctx.font = '10px sans-serif';
        const textWidth = ctx.measureText(text).width;
        
        const labelHeight = 16;
        const labelWidth = textWidth + 8;
        
        // 绘制在左上角稍微往上的位置，或者如果顶部不够，绘制在内部
        let lx = cx;
        let ly = cy - labelHeight;
        if (ly < CH) {
          ly = cy; // 如果太靠顶，绘制在内部
        }

        // 绘制圆角小矩形气泡
        this._drawRoundedRect(ctx, lx, ly, labelWidth, labelHeight, 2);
        ctx.fill();

        // 绘制名字
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, lx + 4, ly + labelHeight / 2);
      };

      const drawAll = (ox, oy) => {
        activeCursors.forEach(item => {
          drawSingleCursor(ox, oy, item);
        });
      };

      // 主体区域
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + fW, CH + fH, W - (RW + fW), H - (CH + fH));
      ctx.clip();
      drawAll(RW - this.scrollX, CH - this.scrollY);
      ctx.restore();

      // 冻结行
      if (fR > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW + fW, CH, W - (RW + fW), fH);
        ctx.clip();
        drawAll(RW - this.scrollX, CH);
        ctx.restore();
      }

      // 冻结列
      if (fC > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW, CH + fH, fW, H - (CH + fH));
        ctx.clip();
        drawAll(RW, CH - this.scrollY);
        ctx.restore();
      }

      // 冻结交叉区
      if (fR > 0 && fC > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW, CH, fW, fH);
        ctx.clip();
        drawAll(RW, CH);
        ctx.restore();
      }
    },

    _hexToRgba(hex, alpha) {
      if (!HEX_COLOR_RE.test(hex)) return hex;
      const h = hex.substring(1);
      const n = parseInt(h.length === 3
        ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
        : h, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    },

    _drawRoundedRect(ctx, x, y, width, height, radius) {
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
    },

    _getGridRenderSignature(range) {
      const wb = this.workbook;

      // 数值哈希：仅包含影响网格线和表头的字段（不含选区，选区在 selectionCanvas 渲染）
      let h = 0;
      const mix = (v) => { h = (h * 31 + (v | 0)) | 0; };

      mix(this.width); mix(this.height);
      mix(this.rowHeaderWidth); mix(this.colHeaderHeight);
      mix(this.scrollX); mix(this.scrollY);
      mix(range.startRow); mix(range.endRow);
      mix(range.startCol); mix(range.endCol);

      // 行高/列宽变化检测：用 LayoutEngine 单调布局版本号 O(1) 替代逐格累加哈希。
      // 任何会移动网格线的几何变更（行高/列宽/插删/计数）都经 markDirty() 自增该版本，
      // 故版本不变即可断定可见区网格线未移动。回退到逐格累加以兼容无该接口的 workbook。
      if (typeof wb.getLayoutVersion === 'function') {
        mix(wb.getLayoutVersion());
      } else {
        for (let r = range.startRow; r <= range.endRow; r++) mix(wb.getRowHeight(r));
        for (let c = range.startCol; c <= range.endCol; c++) mix(wb.getColWidth(c));
      }

      // 冻结位置变化时失效
      if (wb.freeze) { mix(wb.freeze.r); mix(wb.freeze.c); }

      return h;
    },

    _getGridCacheContext(width, height) {
      if (typeof document === 'undefined') return null;

      if (!this._gridLayerCache) {
        const canvas = document.createElement('canvas');
        this._gridLayerCache = {
          canvas,
          ctx: canvas.getContext('2d'),
          signature: null
        };
      }

      const cache = this._gridLayerCache;
      if (!cache.ctx) return null;
      if (cache.canvas.width !== width || cache.canvas.height !== height) {
        cache.canvas.width = width;
        cache.canvas.height = height;
        cache.signature = null;
      }
      return cache;
    },

    _renderGrid() {
      if (!this.ctxGrid || !this.workbook) return;
      const ctx = this.ctxGrid;
      const theme = this.tableTheme || TableTheme;
      const wb = this.workbook;
      
      const W = this.width;
      const H = this.height;
      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);
      
      const range = this._getVisibleRange();
      if (!range) return;

      const signature = this._getGridRenderSignature(range);
      const cache = this._getGridCacheContext(W, H);

      if (cache && cache.signature === signature) {
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(cache.canvas, 0, 0);
        return;
      }

      const drawCtx = cache?.ctx || ctx;
      drawCtx.clearRect(0, 0, W, H);

      // 1. 绘制表头背景 (先行绘制，作为底色)
      drawCtx.fillStyle = theme.headerBg;
      drawCtx.fillRect(0, 0, W, CH); // 顶部列标背景
      drawCtx.fillRect(0, 0, RW, H); // 左侧行号背景

      // 2. 集中绘制所有网格线 (Global Grid)
      drawCtx.lineWidth = 1;
      drawCtx.strokeStyle = theme.borderColor;
      drawCtx.beginPath();

      // --- 绘制垂直线 (按需绘制，避开合并单元格) ---
      // 左边界线 (贯穿)
      drawCtx.moveTo(0.5, 0);
      drawCtx.lineTo(0.5, H);
      
      // 分隔线：行号与数据区之间 (贯穿)
      drawCtx.moveTo(RW + 0.5, 0);
      drawCtx.lineTo(RW + 0.5, H);

      // 1. 绘制列标区域内的垂直分隔线 (仅在列标区域 0 到 CH 贯穿)
      let vx = RW + wb.getColPos(range.startCol) - this.scrollX;
      for (let c = range.startCol; c <= range.endCol + 1; c++) {
        const x = Math.floor(vx) + 0.5;
        if (x > RW) {
          drawCtx.moveTo(x, 0);
          drawCtx.lineTo(x, CH);
        }
        if (c <= range.endCol) vx += wb.getColWidth(c);
      }

      // 2. 绘制数据区域内的垂直线段 (按行分段，跳过合并单元格内部的线)
      // 限制在主体区域内，避免主体行的线段越界画入冻结行/列区域，
      // 否则在异步 Worker 重绘冻结区前会有一帧出现"主体内容穿透冻结区"的视觉残留
      const bodyStartY = (range.bodyStartY != null) ? range.bodyStartY : CH;
      const bodyStartX = (range.bodyStartX != null) ? range.bodyStartX : RW;
      let vy = CH + wb.getRowPos(range.startRow) - this.scrollY;
      for (let r = range.startRow; r <= range.endRow; r++) {
        const h = wb.getRowHeight(r);
        const yStart = Math.max(Math.floor(vy), bodyStartY);
        const yEnd = Math.max(Math.floor(vy + h), bodyStartY);

        if (yEnd > yStart) {
          let cx = RW + wb.getColPos(range.startCol) - this.scrollX;
          for (let c = range.startCol; c <= range.endCol; c++) {
            const w = wb.getColWidth(c);
            const x = Math.floor(cx + w) + 0.5;

            if (x >= bodyStartX) {
              const merge = wb.getMerge(r, c);
              let shouldDraw = true;
              if (merge) {
                // 只有当该列是合并区域的最右列时才绘制右边线
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

      // 3. 绘制冻结区域的垂直网格线
      const freezeR = range.freezeR || 0;
      const freezeC = range.freezeC || 0;
      const headerSepY = CH + 0.5; // 列标与数据区分隔线 y 坐标
      if (freezeR > 0) {
        // 冻结行区域的垂直线：从 CH 到 bodyStartY
        let vx_fr = RW + wb.getColPos(range.startCol) - this.scrollX;
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
        // 冻结列区域的垂直线：从 CH 到 H（贯穿冻结行区域和主体区域）
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

      // --- 绘制水平线 (按需绘制，避开合并单元格) ---
      // 顶边界线 (贯穿)
      drawCtx.moveTo(0, 0.5);
      drawCtx.lineTo(W, 0.5);

      // 分隔线：列标与数据区之间 (贯穿)
      drawCtx.moveTo(0, headerSepY);
      drawCtx.lineTo(W, headerSepY);

      // 4. 绘制冻结区域的水平网格线
      if (freezeR > 0) {
        // 冻结行区域的水平线：每个冻结行的底边
        // 跳过与列标分隔线重合的 y 坐标，避免双线
        // 从 RW 开始绘制，避免穿过行号列区域
        let vy_fr = CH;
        for (let r = 0; r <= Math.min(freezeR, range.endRow + 1); r++) {
          const y = Math.floor(vy_fr) + 0.5;
          if (y > CH && Math.abs(y - headerSepY) > 0.01) {
            drawCtx.moveTo(RW, y);
            drawCtx.lineTo(W, y);
          }
          if (r <= range.endRow) vy_fr += wb.getRowHeight(r);
        }
        // 行号列内的冻结行分隔线
        let vy_rh = CH;
        for (let r = 0; r <= Math.min(freezeR, range.endRow + 1); r++) {
          const y = Math.floor(vy_rh) + 0.5;
          if (y > CH && Math.abs(y - headerSepY) > 0.01) {
            drawCtx.moveTo(0, y);
            drawCtx.lineTo(RW, y);
          }
          if (r <= range.endRow) vy_rh += wb.getRowHeight(r);
        }
        // 重画行号列右侧垂直边框，防止被冻结行内容覆盖
        drawCtx.moveTo(RW + 0.5, CH);
        drawCtx.lineTo(RW + 0.5, bodyStartY);
      }
      if (freezeC > 0) {
        // 冻结列区域的水平线：从 RW 到 bodyStartX
        // 跳过与行号分隔线重合的 x 坐标，避免双线
        let vy_fc = CH + wb.getRowPos(range.startRow) - this.scrollY;
        for (let r = range.startRow; r <= range.endRow + 1; r++) {
          const y = Math.floor(vy_fc) + 0.5;
          if (y > CH && y < bodyStartY) {
            drawCtx.moveTo(RW, y);
            drawCtx.lineTo(bodyStartX, y);
          }
          if (r <= range.endRow) vy_fc += wb.getRowHeight(r);
        }
      }

      // 1. 绘制行号区域内的水平分隔线 (仅在行号区域 0 到 RW 贯穿)
      let vy2 = CH + wb.getRowPos(range.startRow) - this.scrollY;
      for (let r = range.startRow; r <= range.endRow + 1; r++) {
        const y = Math.floor(vy2) + 0.5;
        if (y > CH) {
          drawCtx.moveTo(0, y);
          drawCtx.lineTo(RW, y);
        }
        if (r <= range.endRow) vy2 += wb.getRowHeight(r);
      }

      // 2. 绘制数据区域内的水平线段 (按列分段，跳过合并单元格内部的线)
      // 与垂直线段同理，限制在主体区域内，避免越界进入冻结区
      let vy3 = CH + wb.getRowPos(range.startRow) - this.scrollY;
      for (let r = range.startRow; r <= range.endRow; r++) {
        const h = wb.getRowHeight(r);
        const y = Math.floor(vy3 + h) + 0.5;

        if (y >= bodyStartY) {
          let cx = RW + wb.getColPos(range.startCol) - this.scrollX;
          for (let c = range.startCol; c <= range.endCol; c++) {
            const w = wb.getColWidth(c);
            const xStart = Math.max(Math.floor(cx), bodyStartX);
            const xEnd = Math.max(Math.floor(cx + w), bodyStartX);

            if (xEnd > xStart) {
              const merge = wb.getMerge(r, c);
              let shouldDraw = true;
              if (merge) {
                // 只有当该行是合并区域的最底行时才绘制下边线
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

      this._renderHeaders(drawCtx, range);

      if (cache) {
        cache.signature = signature;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(cache.canvas, 0, 0);
      }
    },

    /**
     * 渲染表头（行号和列标）
     * 优化：确保列表头层级在行号之上，解决滚动时的重叠问题
     */
    _renderHeaders(ctx, range = null) {
      const theme = this.tableTheme;
      const wb = this.workbook;
      range = range || this._getVisibleRange();
      if (!range) return;

      const RW = Math.floor(this.rowHeaderWidth);
      const CH = Math.floor(this.colHeaderHeight);
      const W = this.width;
      const H = this.height;

      ctx.save();

      // 设置文字样式
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.textColor;
      ctx.font = `${theme.headerFontSize} ${theme.fontFamily}`;

      // --- 1. 渲染行号文字 ---
      const frozenHeight = range.frozenHeight || 0;

      // A. 绘制冻结行的行号 (固定在最顶端，不受scrollY影响)
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

      // B. 绘制滚动主体的行号 (裁剪到冻结区域下方，让边界处的行号随其单元格自然裁剪)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, CH + frozenHeight, RW, H - CH - frozenHeight);
      ctx.clip();
      let curY = CH + wb.getRowPos(range.startRow) - this.scrollY;
      for (let r = range.startRow; r <= range.endRow; r++) {
        const h = wb.getRowHeight(r);
        const y = Math.floor(curY);
        ctx.fillText(String(r + 1), RW / 2, y + h / 2);
        curY += h;
      }
      ctx.restore();

      // --- 3. 渲染列标文字 ---
      const frozenWidth = range.frozenWidth || 0;

      // A. 绘制冻结列的列标 (固定在最左侧，不受scrollX影响)
      if (range.freezeC > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(RW, 0, frozenWidth, CH);
        ctx.clip();
        let curFrozenX = RW;
        for (let c = 0; c < range.freezeC; c++) {
          const w = wb.getColWidth(c);
          const x = Math.floor(curFrozenX);
          ctx.fillText(wb._indexToColStr(c), x + w / 2, CH / 2);
          curFrozenX += w;
        }
        ctx.restore();
      }

      // B. 绘制滚动主体的列标 (裁剪到冻结区域右侧)
      ctx.save();
      ctx.beginPath();
      ctx.rect(RW + frozenWidth, 0, W - RW - frozenWidth, CH);
      ctx.clip();
      let curX = RW + wb.getColPos(range.startCol) - this.scrollX;
      for (let c = range.startCol; c <= range.endCol; c++) {
        const w = wb.getColWidth(c);
        const x = Math.floor(curX);
        ctx.fillText(wb._indexToColStr(c), x + w / 2, CH / 2);
        curX += w;
      }
      ctx.restore();

      ctx.restore();
    }
  }
};
