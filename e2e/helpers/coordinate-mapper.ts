/**
 * 坐标映射器：将电子表格单元格坐标 (r, c) 映射为屏幕像素坐标
 *
 * 复刻 useCanvasInteraction.js:768-797 的 getCellScreenRect() 逻辑。
 * 通过 page.evaluate() 调用 E2E 测试桥进行计算。
 */
import type { Page } from '@playwright/test';

/** 单元格在 canvas 上的屏幕矩形 */
export interface CellScreenRect {
  x: number;   // canvas 相对 X
  y: number;   // canvas 相对 Y
  w: number;   // 可见宽度
  h: number;   // 可见高度
  r: number;   // 行索引
  c: number;   // 列索引
}

/** 布局常量 */
export interface LayoutConstants {
  rowHeaderWidth: number;
  colHeaderHeight: number;
  defaultRowHeight: number;
  defaultColWidth: number;
}

export class CoordinateMapper {
  private _canvasBbox: { left: number; top: number; width: number; height: number } | null = null;

  constructor(private page: Page) {}

  /**
   * 提取布局常量
   */
  async getLayoutConstants(): Promise<LayoutConstants> {
    return this.page.evaluate(() => {
      const wb = (window as any).__e2e?.getWorkbook();
      const rowCount = wb?.rowCount || 100;
      const digits = Math.max(2, String(rowCount).length);
      return {
        rowHeaderWidth: Math.floor(Math.max(40, digits * 8 + 10)),
        colHeaderHeight: 24, // TableTheme.colHeaderHeight
        defaultRowHeight: 25,
        defaultColWidth: 100,
      };
    });
  }

  /**
   * 获取 cell 在 canvas 上的屏幕矩形（相对于 canvas 元素）
   * 返回 null 表示 cell 完全不可见
   */
  async getCellScreenRect(r: number, c: number): Promise<CellScreenRect | null> {
    return this.page.evaluate(
      ({ r, c }) => {
        const wb = (window as any).__e2e?.getWorkbook();
        if (!wb) return null;

        // 布局常量
        const rowCount = wb.rowCount || 100;
        const digits = Math.max(2, String(rowCount).length);
        const RW = Math.floor(Math.max(40, digits * 8 + 10));
        const CH = 24; // TableTheme.colHeaderHeight
        const canvasWidth = (document.querySelector('canvas') as HTMLCanvasElement)?.width || 1280;
        const canvasHeight = (document.querySelector('canvas') as HTMLCanvasElement)?.height || 720;

        // 处理合并单元格
        const merge = typeof wb.getMerge === 'function' ? wb.getMerge(r, c) : null;
        const targetR = merge ? merge.s.r : r;
        const targetC = merge ? merge.s.c : c;

        // 冻结区域
        const freezeC = (wb.freeze && wb.freeze.c) || 0;
        const freezeR = (wb.freeze && wb.freeze.r) || 0;
        const frozenWidth = typeof wb.getColPos === 'function' ? wb.getColPos(freezeC) : 0;
        const frozenHeight = typeof wb.getRowPos === 'function' ? wb.getRowPos(freezeR) : 0;

        // 当前滚动位置（从 DOM 滚动条元素读取，由 CanvasTable 组件同步）
        const scrollV = document.querySelector('.vue-canvas-sheet-scrollbar-v') as HTMLElement;
        const scrollH = document.querySelector('.vue-canvas-sheet-scrollbar-h') as HTMLElement;
        const scrollX = scrollH ? scrollH.scrollLeft : 0;
        const scrollY = scrollV ? scrollV.scrollTop : 0;

        // 计算屏幕 X
        let x: number;
        if (targetC < freezeC) {
          x = RW + (typeof wb.getColPos === 'function' ? wb.getColPos(targetC) : targetC * 100);
        } else {
          x = RW + frozenWidth
            + (typeof wb.getColPos === 'function' ? wb.getColPos(targetC) : targetC * 100)
            - (typeof wb.getColPos === 'function' ? wb.getColPos(freezeC) : 0)
            - scrollX;
        }

        // 计算屏幕 Y
        let y: number;
        if (targetR < freezeR) {
          y = CH + (typeof wb.getRowPos === 'function' ? wb.getRowPos(targetR) : targetR * 25);
        } else {
          y = CH + frozenHeight
            + (typeof wb.getRowPos === 'function' ? wb.getRowPos(targetR) : targetR * 25)
            - (typeof wb.getRowPos === 'function' ? wb.getRowPos(freezeR) : 0)
            - scrollY;
        }

        // 宽度和高度
        let w = typeof wb.getColWidth === 'function' ? wb.getColWidth(targetC) : 100;
        let h = typeof wb.getRowHeight === 'function' ? wb.getRowHeight(targetR) : 25;

        if (merge) {
          w = 0;
          for (let mc = merge.s.c; mc <= merge.e.c; mc++) {
            w += typeof wb.getColWidth === 'function' ? wb.getColWidth(mc) : 100;
          }
          h = 0;
          for (let mr = merge.s.r; mr <= merge.e.r; mr++) {
            h += typeof wb.getRowHeight === 'function' ? wb.getRowHeight(mr) : 25;
          }
        }

        const dpr = window.devicePixelRatio || 1;
        const screenX = x * dpr;
        const screenY = y * dpr;
        const screenW = w * dpr;
        const screenH = h * dpr;

        // 裁剪检查：完全不可见则返回 null
        if (screenX + screenW < RW * dpr || screenY + screenH < CH * dpr ||
            screenX > canvasWidth || screenY > canvasHeight) {
          return null;
        }

        return { x: screenX, y: screenY, w: screenW, h: screenH, r: targetR, c: targetC };
      },
      { r, c }
    );
  }

  /**
   * 获取单元格中心点（canvas 相对坐标）
   */
  async getCellCenter(r: number, c: number): Promise<{ x: number; y: number } | null> {
    const rect = await this.getCellScreenRect(r, c);
    if (!rect) return null;
    return {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
    };
  }

  /**
   * 将 canvas 相对坐标转换为页面绝对坐标（page.mouse API 需要）
   */
  async canvasToPagePoint(canvasX: number, canvasY: number): Promise<{ x: number; y: number }> {
    const bbox = await this.getCanvasBoundingBox();
    // canvas 元素尺寸可能和实际分辨率不同（DPR scaling）
    const canvasEl = await this.page.evaluate(() => {
      const el = document.querySelector('canvas');
      if (!el) return { width: 1, height: 1 };
      return { width: el.clientWidth, height: el.clientHeight };
    });
    const dpr = await this.page.evaluate(() => window.devicePixelRatio || 1);

    const scaleX = bbox.width / (canvasEl.width * dpr);
    const scaleY = bbox.height / (canvasEl.height * dpr);

    return {
      x: bbox.left + canvasX * scaleX,
      y: bbox.top + canvasY * scaleY,
    };
  }

  /**
   * 获取主 canvas 元素的页面绝对位置和尺寸
   */
  async getCanvasBoundingBox(): Promise<{ left: number; top: number; width: number; height: number }> {
    if (this._canvasBbox) return this._canvasBbox;
    const bbox = await this.page.evaluate(() => {
      // 优先取内容层 canvas（z-index: 2）
      const canvases = document.querySelectorAll('canvas');
      const contentCanvas = canvases[0] || canvases[1];
      if (!contentCanvas) return { left: 0, top: 0, width: 0, height: 0 };
      const rect = contentCanvas.getBoundingClientRect();
      return {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
    this._canvasBbox = bbox;
    return bbox;
  }

  /**
   * 清除缓存的 canvas 边界框（resize 后使用）
   */
  clearBboxCache(): void {
    this._canvasBbox = null;
  }

  /**
   * 将单元格中心点转换为页面绝对坐标（一步到位）
   */
  async getCellPageCenter(r: number, c: number): Promise<{ x: number; y: number } | null> {
    const center = await this.getCellCenter(r, c);
    if (!center) return null;
    return this.canvasToPagePoint(center.x, center.y);
  }
}
