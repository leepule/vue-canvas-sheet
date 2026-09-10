/**
 * 剪贴板 E2E 测试
 */
import { test, expect } from '../fixtures/test-fixture';

test.describe('剪贴板操作', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('Ctrl+C 应写入所选区域的制表符文本', async ({ tablePage }) => {
    await tablePage.simulator.dragSelect(1, 0, 3, 1);
    await tablePage.simulator.keyDown('c', { ctrl: true });

    const clipboardText = await tablePage.page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('Alice\t25\nBob\t30\nCarol\t28');
  });

  test('Ctrl+V 应把复制值写入目标单元格', async ({ tablePage }) => {
    await tablePage.simulator.dragSelect(1, 0, 1, 0);
    await tablePage.simulator.keyDown('c', { ctrl: true });
    await tablePage.waitForStable();

    await tablePage.simulator.clickCell(5, 0);
    await tablePage.waitForStable();
    await tablePage.simulator.keyDown('v', { ctrl: true });
    await tablePage.waitForStable();

    await tablePage.assertCellValue(5, 0, 'Alice');
  });

  test('Delete 清除单元格内容', async ({ tablePage }) => {
    const valBefore = await tablePage.getCellValue(1, 0);
    expect(valBefore).toBe('Alice');

    await tablePage.simulator.clickCell(1, 0);
    await tablePage.simulator.keyDown('Delete');
    await tablePage.waitForStable();

    const valAfter = await tablePage.getCellValue(1, 0);
    expect(valAfter).toBeNull();
  });
});
