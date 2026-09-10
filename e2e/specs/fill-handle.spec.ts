/**
 * 填充柄拖拽 E2E 测试
 */
import { test } from '../fixtures/test-fixture';

test.describe('填充柄', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('向下拖拽填充柄应扩展选区并复制数据模式', async ({ tablePage }) => {
    await tablePage.setSelection(1, 0, 3, 1);
    await tablePage.waitForStable();
    await tablePage.simulator.dragFillHandle(5, 1);

    await tablePage.assertSelection(1, 0, 5, 1);
    await tablePage.assertCellValue(4, 0, 'Alice');
    await tablePage.assertCellValue(4, 1, 25);
    await tablePage.assertCellValue(5, 0, 'Bob');
    await tablePage.assertCellValue(5, 1, 30);
  });
});
