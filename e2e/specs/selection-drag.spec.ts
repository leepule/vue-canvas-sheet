/**
 * 鼠标拖拽选区 E2E 测试
 */
import { test } from '../fixtures/test-fixture';

test.describe('鼠标选区交互', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('单击单元格应选中单个单元格', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.assertActiveCell(1, 0);
    await tablePage.assertSelection(1, 0, 1, 0);
  });

  test('鼠标拖拽应创建范围选区', async ({ tablePage }) => {
    await tablePage.simulator.dragSelect(1, 0, 3, 2);
    await tablePage.assertSelection(1, 0, 3, 2);
  });

  test('点击不同单元格应移动选区', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.assertActiveCell(1, 0);

    await tablePage.simulator.clickCell(3, 0);
    await tablePage.assertActiveCell(3, 0);
  });

  test('选区后应可获取正确的单元格值', async ({ tablePage }) => {
    await tablePage.simulator.clickCell(1, 0);
    await tablePage.assertCellValue(1, 0, 'Alice');
  });
});
