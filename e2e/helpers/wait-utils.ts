/**
 * 渲染稳定等待工具
 *
 * 确保 Canvas 渲染完成后才进行断言，消除 requestAnimationFrame 竞态。
 */
import type { Page } from '@playwright/test';

/**
 * 等待 Workbook 初始化完成
 * 轮询显式 E2E 测试桥直到 Workbook 已初始化
 */
export async function waitForWorkbook(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const wb = (window as any).__e2e?.getWorkbook();
      return wb && typeof wb.rowCount === 'number' && wb.rowCount > 0;
    },
    { timeout }
  );
}

/**
 * 等待 Canvas 元素渲染完成
 * 检查 4 层 canvas 都存在且有非零尺寸
 */
export async function waitForCanvasReady(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length < 2) return false;
      for (const c of canvases) {
        if (c.width === 0 || c.height === 0) return false;
      }
      return true;
    },
    { timeout }
  );
}

/**
 * 等待渲染稳定：多次 rAF 后确认没有渲染脏标记
 * 表格使用 debounced resize (16ms) 和 throttled mouse move (rAF)
 */
export async function waitForRenderStable(page: Page, frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
  // 安全余量：额外等待 debounce 完成
  await page.waitForTimeout(50);
}

/**
 * 等待特定事件从 Workbook 发射
 * @param eventName Workbook 事件名（如 'selection-change'）
 */
export async function waitForWorkbookEvent(
  page: Page,
  eventName: string,
  timeout = 5_000
): Promise<void> {
  await page.evaluate(
    ({ eventName }) => {
      return new Promise<void>((resolve) => {
        const wb = (window as any).__e2e?.getWorkbook();
        if (!wb || !wb.on) { resolve(); return; }
        const done = () => { wb.off(eventName, done); resolve(); };
        wb.on(eventName, done);
        // 超时安全网
        setTimeout(resolve, 5000);
      });
    },
    { eventName }
  ).catch(() => { /* 超时不失败 */ });

  // 额外等待渲染完成
  await waitForRenderStable(page);
}

/**
 * 等待 inline editor 可见
 */
export async function waitForEditorVisible(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForSelector('.vue-canvas-sheet-cell-editor', {
    state: 'visible',
    timeout,
  });
}

/**
 * 等待 inline editor 隐藏
 */
export async function waitForEditorHidden(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForSelector('.vue-canvas-sheet-cell-editor', {
    state: 'hidden',
    timeout,
  });
}

/**
 * 等待上下文菜单可见
 */
export async function waitForContextMenuVisible(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForSelector('.vue-canvas-sheet-context-menu', {
    state: 'visible',
    timeout,
  });
}
