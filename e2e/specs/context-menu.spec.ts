/**
 * 右键菜单 E2E 测试
 */
import { test, expect } from '../fixtures/test-fixture';

test.describe('右键菜单', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('右键单元格应弹出上下文菜单', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.simulator.rightClickCell(1, 0);
    await tablePage.assertContextMenuVisible();
  });

  test('右键菜单在点击空白区域后应关闭', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.simulator.rightClickCell(1, 0);
    const menu = tablePage.page.locator('.vue-canvas-sheet-context-menu');
    await expect(menu).toBeVisible();

    await tablePage.page.mouse.click(10, 10);
    await expect(menu).toBeHidden();
  });
});
