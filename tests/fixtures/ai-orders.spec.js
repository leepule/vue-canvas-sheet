import { describe, expect, it } from 'vitest';
import { Workbook } from '../../src/core/Workbook.js';
import {
  createOrdersFixture,
  createOrdersWithExistingTargetFixture,
  createOrdersWithMissingPriceFixture,
  createOrdersWithStyledTargetFixture
} from './ai-orders.js';

const fixtureFactories = [
  ['基础订单', createOrdersFixture],
  ['目标已有值', createOrdersWithExistingTargetFixture],
  ['单价为空', createOrdersWithMissingPriceFixture],
  ['目标带格式', createOrdersWithStyledTargetFixture]
];

describe('AI 订单测试夹具', () => {
  it('提供固定的三行订单和空白结果列', () => {
    expect(createOrdersFixture()).toEqual([
      ['单价', '数量', '销售额'],
      [10, 2, null],
      [5, 3, null],
      [8, 4, null]
    ]);
  });

  it('目标已有值场景只将 C2 设置为待保护的原值', () => {
    const expected = createOrdersFixture();
    expected[1][2] = 999;

    expect(createOrdersWithExistingTargetFixture()).toEqual(expected);
  });

  it('单价为空场景只将 A2 设置为 null，不替换为零', () => {
    const expected = createOrdersFixture();
    expected[1][0] = null;

    expect(createOrdersWithMissingPriceFixture()).toEqual(expected);
  });

  it('为 C2:C4 提供空值、两位小数格式和嵌套边框', () => {
    const data = createOrdersWithStyledTargetFixture();
    const base = createOrdersFixture();

    expect(data.map(row => row.slice(0, 2))).toEqual(
      base.map(row => row.slice(0, 2))
    );
    expect(data[0]).toEqual(base[0]);

    for (let r = 1; r < data.length; r++) {
      expect(data[r][2]).toEqual({
        v: null,
        s: {
          fmt: 'comma',
          decimals: 2,
          border: {
            bottom: { color: '#333333', style: 'solid' }
          }
        }
      });
    }
  });

  it.each(fixtureFactories)('%s 每次创建独立的数组和行', (_, createFixture) => {
    const first = createFixture();
    const second = createFixture();

    expect(first).not.toBe(second);
    first.forEach((row, index) => {
      expect(row).not.toBe(second[index]);
    });

    first[0][0] = 'changed';
    first[1][0] = -1;
    first.pop();

    expect(second).toEqual(createFixture());
  });

  it('带格式目标的单元格和嵌套样式不在行或调用之间共享', () => {
    const first = createOrdersWithStyledTargetFixture();
    const second = createOrdersWithStyledTargetFixture();

    for (let r = 1; r < first.length; r++) {
      expect(first[r][2]).not.toBe(second[r][2]);
      expect(first[r][2].s).not.toBe(second[r][2].s);
      expect(first[r][2].s.border).not.toBe(second[r][2].s.border);
      expect(first[r][2].s.border.bottom).not.toBe(second[r][2].s.border.bottom);

      if (r > 1) {
        expect(first[r][2]).not.toBe(first[1][2]);
        expect(first[r][2].s).not.toBe(first[1][2].s);
        expect(first[r][2].s.border).not.toBe(first[1][2].s.border);
        expect(first[r][2].s.border.bottom).not.toBe(first[1][2].s.border.bottom);
      }
    }

    first[1][2].v = 100;
    first[1][2].s.decimals = 0;
    first[1][2].s.border.bottom.color = '#ff0000';

    expect(second).toEqual(createOrdersWithStyledTargetFixture());
    expect(first[2][2]).toEqual(second[2][2]);
    expect(first[3][2]).toEqual(second[3][2]);
  });

  it.each([
    ['基础订单', createOrdersFixture],
    ['目标带格式', createOrdersWithStyledTargetFixture]
  ])('%s 可由现有 Workbook 计算得到 20、15、32', async (_, createFixture) => {
    const workbook = new Workbook({ enableWasm: false });

    try {
      workbook.setData(createFixture());

      for (let r = 1; r <= 3; r++) {
        expect(workbook.getCellValue(r, 2)).toBeNull();
        workbook.setCell(r, 2, { f: `=A${r + 1}*B${r + 1}` });
      }

      await workbook.recalcAll({ useWorker: false });

      expect([1, 2, 3].map(r => workbook.getCellValue(r, 2))).toEqual([20, 15, 32]);
    } finally {
      workbook.destroy();
    }
  });
});
