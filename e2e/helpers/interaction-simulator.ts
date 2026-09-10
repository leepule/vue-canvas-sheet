/**
 * 交互模拟器：模拟用户在 Canvas 表格上的鼠标/键盘操作
 *
 * 所有鼠标操作先通过 CoordinateMapper 获取屏幕坐标，
 * 再通过 Playwright page.mouse API 执行。
 */
import type { Page } from '@playwright/test';
import { CoordinateMapper } from './coordinate-mapper';
import { waitForRenderStable } from './wait-utils';

export interface KeyboardModifiers {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export class InteractionSimulator {
  readonly mapper: CoordinateMapper;

  constructor(private page: Page) {
    this.mapper = new CoordinateMapper(page);
  }

  /**
   * 点击单元格
   */
  async clickCell(r: number, c: number): Promise<void> {
    const center = await this.mapper.getCellPageCenter(r, c);
    if (!center) {
      throw new Error(`Cell (${r}, ${c}) is not visible`);
    }
    await this.page.mouse.click(center.x, center.y);
    await waitForRenderStable(this.page);
  }

  /**
   * 鼠标拖拽：从 start 单元格拖到 end 单元格（选区拖拽）
   * @param steps 中间 mousemove 事件步数
   */
  async dragSelect(
    startR: number, startC: number,
    endR: number, endC: number,
    steps = 5
  ): Promise<void> {
    const start = await this.mapper.getCellPageCenter(startR, startC);
    const end = await this.mapper.getCellPageCenter(endR, endC);
    if (!start || !end) {
      throw new Error(
        `Drag endpoints (${startR}, ${startC}) -> (${endR}, ${endC}) are not visible`
      );
    }

    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();

    // 中间步进
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mx = start.x + (end.x - start.x) * t;
      const my = start.y + (end.y - start.y) * t;
      await this.page.mouse.move(mx, my);
      // 小延迟让 canvas 重绘
      await this.page.waitForTimeout(16);
    }

    await this.page.mouse.up();
    await waitForRenderStable(this.page);
  }

  /**
   * 双击单元格（激活 inline 编辑）
   */
  async doubleClickCell(r: number, c: number): Promise<void> {
    const center = await this.mapper.getCellPageCenter(r, c);
    if (!center) {
      throw new Error(`Cell (${r}, ${c}) is not visible`);
    }
    await this.page.mouse.dblclick(center.x, center.y);
    await waitForRenderStable(this.page);
  }

  /**
   * 右键点击单元格
   */
  async rightClickCell(r: number, c: number): Promise<void> {
    const center = await this.mapper.getCellPageCenter(r, c);
    if (!center) {
      throw new Error(`Cell (${r}, ${c}) is not visible`);
    }
    await this.page.mouse.click(center.x, center.y, { button: 'right' });
    await this.page.waitForTimeout(100);
  }

  /**
   * 鼠标滚轮
   * @param deltaX 水平滚动增量（正=向右）
   * @param deltaY 垂直滚动增量（正=向下）
   */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    const bbox = await this.mapper.getCanvasBoundingBox();
    const centerX = bbox.left + bbox.width / 2;
    const centerY = bbox.top + bbox.height / 2;
    // 需要先将鼠标移到 canvas 中心，滚轮事件才能被 canvas 容器捕获
    await this.page.mouse.move(centerX, centerY);
    await this.page.mouse.wheel(deltaX, deltaY);
    await waitForRenderStable(this.page);
  }

  /**
   * 键盘按键
   */
  async keyDown(key: string, modifiers?: KeyboardModifiers): Promise<void> {
    if (modifiers?.ctrl || modifiers?.meta) {
      const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
      await this.page.keyboard.down(modKey);
    }
    if (modifiers?.shift) {
      await this.page.keyboard.down('Shift');
    }

    await this.page.keyboard.press(key);

    if (modifiers?.shift) {
      await this.page.keyboard.up('Shift');
    }
    if (modifiers?.ctrl || modifiers?.meta) {
      const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
      await this.page.keyboard.up(modKey);
    }

    await waitForRenderStable(this.page);
  }

  /**
   * 在 inline editor 中输入文本
   */
  async typeInEditor(text: string): Promise<void> {
    const editor = this.page.locator('.vue-canvas-sheet-cell-editor input');
    await editor.waitFor({ state: 'visible', timeout: 3_000 });

    // 先清除现有内容
    await editor.click({ clickCount: 3 }); // triple click to select all
    await editor.fill(text);
  }

  /**
   * 提交编辑（Enter）
   */
  async commitEdit(): Promise<void> {
    await this.page.keyboard.press('Enter');
    await waitForRenderStable(this.page);
  }

  /**
   * 取消编辑（Escape）
   */
  async cancelEdit(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await waitForRenderStable(this.page);
  }

  /**
   * 填充柄拖拽：从当前选区的填充柄拖到目标单元格
   */
  async dragFillHandle(targetR: number, targetC: number): Promise<void> {
    // 填充柄位于选区右下角
    const fillHandle = await this.page.evaluate(() => {
      const wb = (window as any).__e2e?.getWorkbook();
      if (!wb?.selection) return null;
      const { e } = wb.selection;
      // 填充柄位于选区最后一个单元格的右下角
      // 通过 canvas 元素定位
      return { r: e.r, c: e.c };
    });
    if (!fillHandle) {
      throw new Error('Fill handle is unavailable because no selection exists');
    }

    // 获取选区右下角单元格的右边中点
    const cornerRect = await this.mapper.getCellScreenRect(fillHandle.r, fillHandle.c);
    if (!cornerRect) {
      throw new Error('Fill handle cell is outside the visible viewport');
    }

    // 填充柄在右下角，略微超出单元格边界
    const handleX = cornerRect.x + cornerRect.w + 2;
    const handleY = cornerRect.y + cornerRect.h + 2;
    const start = await this.mapper.canvasToPagePoint(handleX, handleY);

    const end = await this.mapper.getCellPageCenter(targetR, targetC);
    if (!end) {
      throw new Error(`Fill target (${targetR}, ${targetC}) is outside the visible viewport`);
    }

    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(end.x, end.y, { steps: 5 });
    await this.page.mouse.up();
    await waitForRenderStable(this.page);
  }

  /**
   * 列宽调整：拖拽列标题右边界
   */
  async resizeColumn(c: number, deltaPixels: number): Promise<void> {
    // 列标题中心点
    const bbox = await this.mapper.getCanvasBoundingBox();
    const layout = await this.mapper.getLayoutConstants();

    // 列标题右边缘 X 坐标
    const headerX = await this.page.evaluate(
      ({ c }) => {
        const wb = (window as any).__e2e?.getWorkbook();
        if (!wb || typeof wb.getColPos !== 'function') {
          throw new Error('Workbook column layout API is unavailable');
        }
        const rowCount = wb.rowCount;
        const digits = Math.max(2, String(rowCount).length);
        const RW = Math.floor(Math.max(40, digits * 8 + 10));
        return RW + wb.getColPos(c + 1);
      },
      { c }
    );

    const headerY = bbox.top + layout.colHeaderHeight / 2;
    const resizerX = bbox.left + headerX;

    await this.page.mouse.move(resizerX, headerY);
    await this.page.waitForFunction(() =>
      Array.from(document.querySelectorAll('canvas'))
        .some(canvas => canvas.style.cursor === 'col-resize')
    );
    await this.page.mouse.down();
    await this.page.mouse.move(resizerX + deltaPixels, headerY, { steps: 3 });
    await this.page.mouse.up();
    await waitForRenderStable(this.page);
  }
}
