/**
 * 视觉回归测试（Visual Regression Testing）
 *
 * 首次运行生成基线：npm run test:e2e:visual:update
 */
import { test, expect } from '../fixtures/test-fixture';

const VISUAL_DATA = [['A', 'B', 'C'], ['1', '2', '3'], ['X', 'Y', 'Z']];

test.describe('视觉回归', () => {
  test.describe('全表截图', () => {
    test.beforeEach(async ({ tablePage }) => {
      await tablePage.loadTestData(VISUAL_DATA);
    });

    test('全画布截图应与基线匹配', async ({ page, tablePage }) => {
      await tablePage.waitForStable(5);
      await expect(page).toHaveScreenshot('canvas-full.png', {
        fullPage: false,
        maxDiffPixelRatio: 0.01,
      });
    });
  });

  test.describe('选区视觉', () => {
    test.beforeEach(async ({ tablePage, smallData }) => {
      await tablePage.loadTestData(smallData);
    });

    test('设置范围选区后应保存精确坐标', async ({ tablePage }) => {
      await tablePage.setSelection(1, 0, 3, 2);
      await tablePage.assertSelection(1, 0, 3, 2);
    });
  });
});
