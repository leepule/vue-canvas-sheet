/**
 * Spreadsheet 页面对象（Page Object Model）
 *
 * 封装所有表格操作：数据加载、选区断言、编辑状态检查等。
 * 通过 E2E 测试桥与 Workbook 交互，通过 Playwright 与 DOM/Canvas 交互。
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CoordinateMapper } from '../helpers/coordinate-mapper';
import { CanvasInspector } from '../helpers/canvas-inspector';
import { InteractionSimulator } from '../helpers/interaction-simulator';
import {
  waitForWorkbook,
  waitForCanvasReady,
  waitForRenderStable,
  waitForEditorVisible,
  waitForEditorHidden,
  waitForContextMenuVisible,
} from '../helpers/wait-utils';

export class TablePage {
  readonly mapper: CoordinateMapper;
  readonly inspector: CanvasInspector;
  readonly simulator: InteractionSimulator;

  constructor(readonly page: Page) {
    this.mapper = new CoordinateMapper(page);
    this.inspector = new CanvasInspector(page);
    this.simulator = new InteractionSimulator(page);
  }

  // ═══════════════════════════════════════════════════════
  // 导航与就绪等待
  // ═══════════════════════════════════════════════════════

  /** 导航到测试页面 */
  async goto(): Promise<void> {
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  /** 等待 Workbook + Canvas 初始化完成 */
  async waitForReady(timeout = 15_000): Promise<void> {
    await waitForWorkbook(this.page, timeout);
    await waitForCanvasReady(this.page, timeout);
    await waitForRenderStable(this.page);
  }

  /**
   * 等待渲染完全稳定
   * 在视觉回归测试前调用此方法
   */
  async waitForStable(frames = 5): Promise<void> {
    await waitForRenderStable(this.page, frames);
  }

  // ═══════════════════════════════════════════════════════
  // 数据操作
  // ═══════════════════════════════════════════════════════

  /** 加载测试数据（通过 Workbook API） */
  async loadTestData(data: any[][]): Promise<void> {
    await this.page.evaluate((d) => {
      const wb = (window as any).__e2e?.getWorkbook();
      if (!wb || typeof wb.setData !== 'function') {
        throw new Error('E2E Workbook is unavailable');
      }
      wb.setData(d);
    }, data);
    // setData 后需要重置坐标映射缓存
    this.mapper.clearBboxCache();
    await waitForRenderStable(this.page);
  }

  /** 通过 __e2e 辅助加载数据（更快速，不走 initialData watch） */
  async loadDataViaE2E(data: any[][]): Promise<void> {
    await this.page.evaluate((d) => {
      const e2e = (window as any).__e2e;
      if (!e2e || typeof e2e.loadData !== 'function') {
        throw new Error('E2E data bridge is unavailable');
      }
      e2e.loadData(d);
    }, data);
    this.mapper.clearBboxCache();
    await waitForRenderStable(this.page);
  }

  // ═══════════════════════════════════════════════════════
  // Workbook API 查询
  // ═══════════════════════════════════════════════════════

  /** 获取选区 */
  async getSelection(): Promise<{ s: { r: number; c: number }; e: { r: number; c: number } } | null> {
    return this.page.evaluate(() => {
      const wb = (window as any).__e2e?.getWorkbook();
      return wb?.selection || null;
    });
  }

  /** 获取活动单元格 */
  async getActiveCell(): Promise<{ r: number; c: number } | null> {
    return this.page.evaluate(() => {
      const wb = (window as any).__e2e?.getWorkbook();
      return wb?.activeCell || null;
    });
  }

  /** 获取单元格值 */
  async getCellValue(r: number, c: number): Promise<any> {
    return this.page.evaluate(
      ({ r, c }) => {
        const wb = (window as any).__e2e?.getWorkbook();
        if (typeof wb?.getCellValue === 'function') {
          return wb.getCellValue(r, c);
        }
        return null;
      },
      { r, c }
    );
  }

  /** 获取单元格原始数据 */
  async getCellRaw(r: number, c: number): Promise<{ v: any; f?: string; s?: any } | null> {
    return this.page.evaluate(
      ({ r, c }) => {
        const wb = (window as any).__e2e?.getWorkbook();
        return wb?.getCell(r, c) || null;
      },
      { r, c }
    );
  }

  /** 获取行数 */
  async getRowCount(): Promise<number> {
    return this.page.evaluate(() => (window as any).__e2e?.getWorkbook()?.rowCount || 0);
  }

  /** 获取列数 */
  async getColCount(): Promise<number> {
    return this.page.evaluate(() => (window as any).__e2e?.getWorkbook()?.colCount || 0);
  }

  /** 获取指定列宽 */
  async getColumnWidth(c: number): Promise<number> {
    return this.page.evaluate((column) => {
      const wb = (window as any).__e2e?.getWorkbook();
      if (!wb || typeof wb.getColWidth !== 'function') {
        throw new Error('Workbook.getColWidth is unavailable');
      }
      return wb.getColWidth(column);
    }, c);
  }

  /** 获取滚动位置（从 DOM 滚动条元素读取） */
  async getScrollPosition(): Promise<{ x: number; y: number }> {
    return this.page.evaluate(() => {
      const scrollV = document.querySelector('.vue-canvas-sheet-scrollbar-v') as HTMLElement;
      const scrollH = document.querySelector('.vue-canvas-sheet-scrollbar-h') as HTMLElement;
      return {
        x: scrollH ? scrollH.scrollLeft : 0,
        y: scrollV ? scrollV.scrollTop : 0,
      };
    });
  }

  /** 获取 editor 状态 */
  async getEditorState(): Promise<{ visible: boolean; value: string } | null> {
    return this.page.evaluate(() => {
      const editorDiv = document.querySelector('.vue-canvas-sheet-cell-editor') as HTMLElement;
      if (!editorDiv) return null;
      const input = editorDiv.querySelector('input') as HTMLInputElement;
      if (!input) return null;
      return {
        visible: editorDiv.style.visibility !== 'hidden' && editorDiv.offsetParent !== null,
        value: input.value || '',
      };
    });
  }

  // ═══════════════════════════════════════════════════════
  // 断言
  // ═══════════════════════════════════════════════════════

  /** 断言单元格值等于期望 */
  async assertCellValue(r: number, c: number, expected: any): Promise<void> {
    const value = await this.getCellValue(r, c);
    expect(value).toBe(expected);
  }

  /** 断言选区范围 */
  async assertSelection(sR: number, sC: number, eR: number, eC: number): Promise<void> {
    const sel = await this.getSelection();
    expect(sel).not.toBeNull();
    expect(sel!.s.r).toBe(sR);
    expect(sel!.s.c).toBe(sC);
    expect(sel!.e.r).toBe(eR);
    expect(sel!.e.c).toBe(eC);
  }

  /** 断言活动单元格 */
  async assertActiveCell(r: number, c: number): Promise<void> {
    const cell = await this.getActiveCell();
    expect(cell).not.toBeNull();
    expect(cell!.r).toBe(r);
    expect(cell!.c).toBe(c);
  }

  /** 断言 editor 可见且包含指定值 */
  async assertEditorVisible(expectedValue?: string): Promise<void> {
    await waitForEditorVisible(this.page);
    if (expectedValue !== undefined) {
      const state = await this.getEditorState();
      expect(state).not.toBeNull();
      expect(state!.value).toBe(expectedValue);
    }
  }

  /** 断言 editor 已隐藏 */
  async assertEditorHidden(): Promise<void> {
    await waitForEditorHidden(this.page);
    const state = await this.getEditorState();
    expect(state?.visible).toBeFalsy();
  }

  /** 断言 context menu 可见 */
  async assertContextMenuVisible(): Promise<void> {
    await waitForContextMenuVisible(this.page);
    const menu = this.page.locator('.vue-canvas-sheet-context-menu');
    await expect(menu).toBeVisible();
  }

  // ═══════════════════════════════════════════════════════
  // 高级操作
  // ═══════════════════════════════════════════════════════

  /** 通过 Workbook API 设置选区（不通过鼠标） */
  async setSelection(sR: number, sC: number, eR: number, eC: number): Promise<void> {
    await this.page.evaluate(
      ({ sR, sC, eR, eC }) => {
        const wb = (window as any).__e2e?.getWorkbook();
        if (!wb || typeof wb.setSelection !== 'function') {
          throw new Error('Workbook.setSelection is unavailable');
        }
        wb.setSelection(sR, sC, eR, eC);
      },
      { sR, sC, eR, eC }
    );
    await waitForRenderStable(this.page);
  }

  /** 点击上下文菜单项（通过文本匹配） */
  async clickContextMenuItem(label: string): Promise<void> {
    const item = this.page.locator('.vue-canvas-sheet-menu-item', { hasText: label });
    await item.click();
    await waitForRenderStable(this.page);
  }

  /** 设置为只读模式 */
  async setReadOnly(readonly: boolean): Promise<void> {
    await this.page.evaluate((val) => {
      const e2e = (window as any).__e2e;
      if (!e2e || typeof e2e.setReadOnly !== 'function') {
        throw new Error('E2E read-only bridge is unavailable');
      }
      e2e.setReadOnly(val);
    }, readonly);
  }

  /** 在当前页面执行任意 Workbook 操作 */
  async evaluate(fn: string): Promise<any> {
    return this.page.evaluate(fn);
  }

  /** 销毁 Workbook 及其 Worker、定时器和存储资源 */
  async dispose(): Promise<void> {
    if (this.page.isClosed()) return;
    await this.page.evaluate(() => {
      const e2e = (window as any).__e2e;
      e2e?.destroy?.();
      (window as any).__e2eUnmountApp?.();
      delete (window as any).__e2e;
      delete (window as any).__e2eUnmountApp;
    });
  }
}
