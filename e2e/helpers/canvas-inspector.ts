/**
 * Canvas 像素检查工具
 *
 * 支持分层检查 CanvasTable 的 4 层 Canvas：
 *   - grid (z-index: 1): 网格线和行列标题
 *   - content (z-index: 2): 单元格背景、文字、边框
 *   - selection (z-index: 3): 选区高亮、拖拽预览
 *   - animation (z-index: 4): 蚂蚁线动画
 */
import type { Page } from '@playwright/test';

/** RGBA 像素值 */
export interface RGBA {
  r: number; g: number; b: number; a: number;
}

/** Canvas 层级 */
export type CanvasLayer = 'grid' | 'content' | 'selection' | 'animation';

/** 层级 → z-index 映射 */
const LAYER_Z_INDEX: Record<CanvasLayer, number> = {
  grid: 1,
  content: 2,
  selection: 3,
  animation: 4,
};

/** 常用颜色 */
export const Colors = {
  SELECTION_BG: 'rgba(33, 115, 70, 0.1)',
  SELECTION_BORDER: '#217346',
  GRID_BORDER: '#dcdfe6',
  HEADER_BG: '#f4f5f8',
  FILL_HANDLE: '#217346',
  DRAG_GUIDE: '#409eff',
  TEXT: '#606266',
} as const;

export class CanvasInspector {
  constructor(private page: Page) {}

  /**
   * 获取指定层的 canvas 元素
   */
  private _getLayerSelector(layer: CanvasLayer): string {
    return `canvas[style*="z-index: ${LAYER_Z_INDEX[layer]}"]`;
  }

  /**
   * 获取指定层 canvas 的 dataURL
   * 可用于 Playwright 的 expect(png).toMatchSnapshot()
   */
  async captureLayer(layer: CanvasLayer): Promise<string> {
    return this.page.evaluate(
      ({ selector }) => {
        const canvas = document.querySelector(selector) as HTMLCanvasElement;
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
      },
      { selector: this._getLayerSelector(layer) }
    );
  }

  /**
   * 获取指定层的 ImageData（完整画布）
   */
  async getLayerImageData(layer: CanvasLayer): Promise<{ width: number; height: number; data: number[] } | null> {
    return this.page.evaluate(
      ({ selector }) => {
        const canvas = document.querySelector(selector) as HTMLCanvasElement;
        if (!canvas) return null;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
          ctx = canvas.getContext('2d');
        } catch {
          // Canvas 控制权已转移到 OffscreenCanvas (Web Worker 渲染路径)
          return null;
        }
        if (!ctx) return null;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
          width: imageData.width,
          height: imageData.height,
          data: Array.from(imageData.data.slice(0, 10000)), // 截断大数据
        };
      },
      { selector: this._getLayerSelector(layer) }
    );
  }

  /**
   * 读取指定层的单个像素
   * @param layer Canvas 层级
   * @param x canvas 相对 X 坐标
   * @param y canvas 相对 Y 坐标
   */
  async getPixelAt(layer: CanvasLayer, x: number, y: number): Promise<RGBA | null> {
    return this.page.evaluate(
      ({ selector, x, y }) => {
        const canvas = document.querySelector(selector) as HTMLCanvasElement;
        if (!canvas) return null;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
          ctx = canvas.getContext('2d');
        } catch {
          // Canvas 控制权已转移到 OffscreenCanvas (Web Worker 渲染路径)
          return null;
        }
        if (!ctx) return null;
        const dpr = window.devicePixelRatio || 1;
        const pixel = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] / 255 };
      },
      { selector: this._getLayerSelector(layer), x, y }
    );
  }

  /**
   * 读取指定层矩形范围的 ImageData
   */
  async getImageDataRegion(
    layer: CanvasLayer,
    x: number, y: number,
    width: number, height: number
  ): Promise<{ width: number; height: number; data: number[] } | null> {
    return this.page.evaluate(
      ({ selector, x, y, width, height }) => {
        const canvas = document.querySelector(selector) as HTMLCanvasElement;
        if (!canvas) return null;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
          ctx = canvas.getContext('2d');
        } catch {
          // Canvas 控制权已转移到 OffscreenCanvas (Web Worker 渲染路径)
          return null;
        }
        if (!ctx) return null;
        const dpr = window.devicePixelRatio || 1;
        const imageData = ctx.getImageData(
          Math.round(x * dpr), Math.round(y * dpr),
          Math.round(width * dpr), Math.round(height * dpr)
        );
        return { width: imageData.width, height: imageData.height, data: Array.from(imageData.data) };
      },
      { selector: this._getLayerSelector(layer), x, y, width, height }
    );
  }

  /**
   * 验证指定位置存在非透明像素（用于验证文字/内容已渲染）
   * @returns 是否存在至少一个非透明像素
   */
  async hasContentAt(
    layer: CanvasLayer,
    x: number, y: number,
    width: number, height: number
  ): Promise<boolean> {
    const region = await this.getImageDataRegion(layer, x, y, width, height);
    if (!region || !region.data.length) return false;

    // 检查 alpha 通道（每 4 个值的第 4 个）
    for (let i = 3; i < region.data.length; i += 4) {
      if (region.data[i] > 0) return true;
    }
    return false;
  }

  /**
   * 像素颜色匹配（带容差）
   */
  matchColor(pixel: RGBA, expected: string, tolerance = 3): boolean {
    // 解析期望颜色字符串
    const parsed = this._parseColor(expected);
    if (!parsed) return false;
    return (
      Math.abs(pixel.r - parsed.r) <= tolerance &&
      Math.abs(pixel.g - parsed.g) <= tolerance &&
      Math.abs(pixel.b - parsed.b) <= tolerance &&
      Math.abs(pixel.a - parsed.a) <= 0.05
    );
  }

  /**
   * 解析 CSS 颜色字符串为 RGBA
   */
  private _parseColor(color: string): RGBA | null {
    // rgba(r, g, b, a)
    const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
    if (rgbaMatch) {
      return {
        r: parseInt(rgbaMatch[1]),
        g: parseInt(rgbaMatch[2]),
        b: parseInt(rgbaMatch[3]),
        a: rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1,
      };
    }
    // #RRGGBB
    const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (hexMatch) {
      return {
        r: parseInt(hexMatch[1], 16),
        g: parseInt(hexMatch[2], 16),
        b: parseInt(hexMatch[3], 16),
        a: 1,
      };
    }
    return null;
  }

  /**
   * 截图整个 canvas 容器区域
   * 剪裁到 table 元素范围内
   */
  async screenshotCanvasArea(): Promise<Buffer> {
    const tableContainer = this.page.locator('.vue-canvas-sheet-table');
    if (await tableContainer.count() > 0) {
      return tableContainer.screenshot({ type: 'png' });
    }
    // fallback: 截取整个视口
    return this.page.screenshot({ type: 'png' });
  }
}
