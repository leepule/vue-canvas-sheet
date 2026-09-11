import { describe, expect, it, vi } from 'vitest';
import { DataController } from '../../src/components/designer/controller/DataController.js';

describe('DataController', () => {
  it('已删除列只跳过当前绑定，不中断整页渲染', () => {
    const workbook = {
      rowCount: 0,
      clearCells: vi.fn(),
      bulkSetCells: vi.fn()
    };
    const controller = new DataController(workbook, vi.fn());
    controller.bindings = [
      { row: 0, col: 0, field: 'name', name: '名称' },
      { row: 0, col: 1, field: 'score', name: '分数' }
    ];
    controller.initialData = [
      { name: 'A', score: 1 },
      { name: 'B', score: 2 }
    ];
    controller._deletedColumns.add(0);

    controller.renderPage();

    expect(workbook.bulkSetCells).toHaveBeenCalledTimes(1);
    expect(workbook.bulkSetCells).toHaveBeenCalledWith([
      { r: 0, c: 1, val: { v: '分数', s: { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' } } },
      { r: 1, c: 1, val: { v: 1 } },
      { r: 2, c: 1, val: { v: 2 } }
    ]);
  });
});
