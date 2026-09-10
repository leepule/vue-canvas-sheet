/**
 * 滚轮滚动 E2E 测试
 */
import { test, expect } from '../fixtures/test-fixture';

test.describe('滚轮滚动', () => {
  test.beforeEach(async ({ tablePage, mediumData }) => {
    await tablePage.loadTestData(mediumData);
  });

  test('滚轮向下滚动应增加 scrollY', async ({ tablePage }) => {
    const before = await tablePage.getScrollPosition();
    await tablePage.simulator.wheel(0, 300);
    const after = await tablePage.getScrollPosition();
    expect(after.y).toBeGreaterThan(before.y);
  });

  test('连续向下滚动应累计增加 scrollY', async ({ tablePage }) => {
    const before = await tablePage.getScrollPosition();
    for (let i = 0; i < 5; i++) {
      await tablePage.simulator.wheel(0, 200);
    }
    const after = await tablePage.getScrollPosition();
    expect(after.y).toBeGreaterThan(before.y + 500);
  });

  test('滚动后单元格数据仍可访问', async ({ tablePage }) => {
    const valBefore = await tablePage.getCellValue(0, 1);
    expect(valBefore).toBeDefined();

    await tablePage.simulator.wheel(0, 400);
    await tablePage.waitForStable();

    const valAfter = await tablePage.getCellValue(0, 1);
    expect(valAfter).toBe(valBefore);
  });

  test('滚轮向上应减少 scrollY', async ({ tablePage }) => {
    const before = await tablePage.getScrollPosition();
    await tablePage.simulator.wheel(0, 300);
    const afterDown = await tablePage.getScrollPosition();
    await tablePage.simulator.wheel(0, -100);
    const afterUp = await tablePage.getScrollPosition();

    expect(afterDown.y).toBeGreaterThan(before.y);
    expect(afterUp.y).toBeLessThan(afterDown.y);
    expect(afterUp.y).toBeGreaterThanOrEqual(before.y);
  });

  test('水平滚轮应增加 scrollX', async ({ tablePage }) => {
    const before = await tablePage.getScrollPosition();
    await tablePage.simulator.wheel(300, 0);
    const after = await tablePage.getScrollPosition();
    expect(after.x).toBeGreaterThan(before.x);
  });
});
