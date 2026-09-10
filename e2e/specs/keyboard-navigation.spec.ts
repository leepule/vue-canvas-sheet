/**
 * 键盘导航 E2E 测试
 */
import { test } from '../fixtures/test-fixture';

test.describe('键盘导航', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('ArrowDown 向下移动选区', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.simulator.keyDown('ArrowDown');
    await tablePage.assertActiveCell(2, 0);
  });

  test('ArrowRight 向右移动选区', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.simulator.keyDown('ArrowRight');
    await tablePage.assertActiveCell(1, 1);
  });

  test('ArrowUp 向上移动选区', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(3, 0);
    await tablePage.simulator.keyDown('ArrowUp');
    await tablePage.assertActiveCell(2, 0);
  });

  test('ArrowLeft 向左移动选区', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 1);
    await tablePage.simulator.keyDown('ArrowLeft');
    await tablePage.assertActiveCell(1, 0);
  });

  test('Ctrl+A 应选择整个数据区域', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(2, 1);
    await tablePage.simulator.keyDown('a', { ctrl: true });
    const rowCount = await tablePage.getRowCount();
    const colCount = await tablePage.getColCount();
    await tablePage.assertSelection(0, 0, rowCount - 1, colCount - 1);
  });
});
