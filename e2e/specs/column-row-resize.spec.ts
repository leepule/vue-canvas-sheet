/**
 * 列宽/行高调整 E2E 测试
 *
 * 验证拖拽列标题边界会实际修改 Workbook 列宽
 */
import { test, expect } from '../fixtures/test-fixture';

test.describe('列宽和行高调整', () => {
  test.beforeEach(async ({ tablePage, smallData }) => {
    await tablePage.loadTestData(smallData);
  });

  test('向右拖拽列标题边界应增加列宽', async ({ tablePage }) => {
    const initialWidth = await tablePage.getColumnWidth(1);

    await tablePage.simulator.resizeColumn(1, 30);
    await tablePage.waitForStable();

    const newWidth = await tablePage.getColumnWidth(1);

    expect(newWidth).toBeGreaterThan(initialWidth + 20);
  });

  test('向左拖拽列标题边界应减小列宽', async ({ tablePage }) => {
    const initialWidth = await tablePage.getColumnWidth(1);
    await tablePage.simulator.resizeColumn(1, -20);
    await tablePage.waitForStable();

    const newWidth = await tablePage.getColumnWidth(1);
    expect(newWidth).toBeLessThan(initialWidth);
    expect(newWidth).toBeGreaterThanOrEqual(5);
  });
});
