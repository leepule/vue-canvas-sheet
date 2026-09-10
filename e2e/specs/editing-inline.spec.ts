/**
 * 双击激活 inline 编辑 E2E 测试
 *
 * 数据布局：row=0 header, row=1 起为数据。
 * col=0=Name, col=1=Age, col=2=Score, col=3=Grade, col=4=Status
 */
import { test, expect } from '../fixtures/test-fixture';

test.describe('双击 inline 编辑', () => {
  test.describe('普通文本编辑', () => {
    test.beforeEach(async ({ tablePage, smallData }) => {
      await tablePage.loadTestData(smallData);
    });

    test('双击单元格应激活 inline editor', async ({ tablePage }) => {
      await tablePage.simulator.clickCell(1, 0);
      await tablePage.simulator.doubleClickCell(1, 0);
      await tablePage.assertEditorVisible();
    });

    test('Editor 应显示单元格原值', async ({ tablePage }) => {
      await tablePage.simulator.clickCell(1, 0);
      await tablePage.simulator.doubleClickCell(1, 0);
      await tablePage.assertEditorVisible('Alice');
    });

    test('输入新值 + Enter → 值被提交', async ({ tablePage }) => {
      await tablePage.simulator.clickCell(1, 0);
      await tablePage.simulator.doubleClickCell(1, 0);
      await tablePage.simulator.typeInEditor('NewName');
      await tablePage.simulator.commitEdit();
      await tablePage.assertEditorHidden();
      await tablePage.assertCellValue(1, 0, 'NewName');
    });

    test('Escape 取消编辑 → 值保持不变', async ({ tablePage }) => {
      const originalValue = await tablePage.getCellValue(1, 0);
      await tablePage.simulator.clickCell(1, 0);
      await tablePage.simulator.doubleClickCell(1, 0);
      await tablePage.simulator.typeInEditor('ShouldBeCancelled');
      await tablePage.simulator.cancelEdit();
      await tablePage.assertEditorHidden();
      await tablePage.assertCellValue(1, 0, originalValue);
    });
  });

  test.describe('只读模式', () => {
    test.beforeEach(async ({ tablePage, smallData }) => {
      await tablePage.loadTestData(smallData);
    });

    test('只读模式下双击不应激活 editor', async ({ tablePage }) => {
      await tablePage.setReadOnly(true);
      await tablePage.simulator.clickCell(1, 0);
      await tablePage.simulator.doubleClickCell(1, 0);
      const state = await tablePage.getEditorState();
      expect(state?.visible).toBeFalsy();
    });
  });
});
