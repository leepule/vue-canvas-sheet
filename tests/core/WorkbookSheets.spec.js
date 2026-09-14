import { Workbook } from '@/core/Workbook';
import { Events } from '@/core/events/EventEmitter';

describe('Workbook 多工作表', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook({ sheetName: '总表' });
  });

  afterEach(() => {
    workbook.destroy();
  });

  test('初始化默认工作表并暴露名称与列表', () => {
    expect(workbook.sheetName).toBe('总表');
    expect(workbook.activeSheetId).toBe('sheet-1');
    expect(workbook.getSheets()).toEqual([
      { id: 'sheet-1', name: '总表', isActive: true }
    ]);
  });

  test('addSheet 默认激活新表并自动去重名称', () => {
    expect(workbook.addSheet()).toBe('sheet-2');
    expect(workbook.sheetName).toBe('Sheet1');

    workbook.addSheet('明细');
    expect(workbook.sheetName).toBe('明细');

    workbook.addSheet('明细');
    expect(workbook.getSheets()[3].name).toBe('明细 (2)');
    const id = workbook.addSheet();
    expect(workbook.sheetName).toBe('Sheet2');
    expect(workbook.getSheets()).toHaveLength(5);
    expect(workbook.activeSheetId).toBe(id);
  });

  test('switchSheet 保留各表数据、样式、合并与冻结配置', () => {
    workbook.setColumns([{ title: '名称', field: 'name', width: 180 }]);
    workbook.setCell(0, 0, { v: '总表数据', s: { fontWeight: 'bold' } });
    workbook.mergeManager.addMerge({ s: { r: 1, c: 1 }, e: { r: 2, c: 2 } });
    workbook.setFreeze(1, 2);

    workbook.addSheet('明细');
    workbook.setCell(0, 0, { v: '明细数据' });

    workbook.switchSheet('总表');
    expect(workbook.getCell(0, 0).v).toBe('总表数据');
    expect(workbook.getStyle(0, 0)).toEqual({ fontWeight: 'bold' });
    expect(workbook.merges).toHaveLength(1);
    expect(workbook.freeze).toEqual({ r: 1, c: 2 });
    expect(workbook.headerDepth).toBe(1);
    expect(workbook.fieldMap).toEqual({ name: 0 });
    expect(workbook.colWidths).toEqual({ 0: 180 });

    workbook.switchSheet('明细');
    expect(workbook.getCell(0, 0).v).toBe('明细数据');
    expect(workbook.merges).toHaveLength(0);
    expect(workbook.freeze).toEqual({ r: 0, c: 0 });
    expect(workbook.headerDepth).toBe(0);
    expect(workbook.fieldMap).toEqual({});
  });

  test('切换后公式依赖能够重建并继续计算', () => {
    workbook.setCell(0, 0, { v: 21 });
    workbook.setCell(0, 1, { v: '=A1*2' });
    workbook.recalcAll({ useWorker: false });

    workbook.addSheet('明细');
    workbook.switchSheet('总表');
    workbook.recalcAll({ useWorker: false });

    expect(workbook.getCellValue(0, 1)).toBe(42);
  });

  test('toJSON / fromJSON 保留多工作表', () => {
    workbook.setCell(0, 0, { v: '总表数据' });
    workbook.addSheet('明细');
    workbook.setCell(1, 2, { v: '明细数据' });

    const json = workbook.toJSON();
    expect(json.sheetName).toBe('明细');
    expect(json.sheets.map(sheet => sheet.name)).toEqual(['总表', '明细']);

    const restored = new Workbook();
    restored.fromJSON(json);

    expect(restored.sheetName).toBe('明细');
    expect(restored.getSheets()).toEqual([
      { id: 'sheet-1', name: '总表', isActive: false },
      { id: 'sheet-2', name: '明细', isActive: true }
    ]);
    expect(restored.getCell(1, 2).v).toBe('明细数据');
    expect(restored.headerDepth).toBe(0);

    restored.switchSheet('总表');
    expect(restored.getCell(0, 0).v).toBe('总表数据');
    expect(restored.headerDepth).toBe(0);
    restored.destroy();
  });

  test('切换和重命名会触发 sheet-change 事件', () => {
    const changes = [];
    workbook.on(Events.SHEET_CHANGE, payload => changes.push(payload));

    workbook.addSheet('明细');
    workbook.sheetName = '数据';
    workbook.renameSheet('总表', '汇总');

    expect(changes).toEqual([
      { type: 'sheet-change', id: 'sheet-2', name: '明细', previousId: 'sheet-1', previousName: '总表' },
      { type: 'sheet-change', id: 'sheet-2', name: '数据', previousName: '明细' },
      { type: 'sheet-change', id: 'sheet-1', name: '汇总', previousName: '总表' }
    ]);
  });

  test('重命名拒绝空名称与重复名称', () => {
    workbook.addSheet('明细', { activate: false });

    expect(() => { workbook.sheetName = ' '; }).toThrow(TypeError);
    expect(() => { workbook.renameSheet('总表', '明细'); }).toThrow(/已存在/);
  });

  test('deleteSheet 删除当前表后自动切换并保留剩余表数据', () => {
    workbook.setCell(0, 0, { v: '总表数据' });
    workbook.addSheet('明细');
    workbook.setCell(0, 0, { v: '明细数据' });

    expect(workbook.deleteSheet('明细')).toBe(true);
    expect(workbook.getSheets()).toEqual([
      { id: 'sheet-1', name: '总表', isActive: true }
    ]);
    expect(workbook.sheetName).toBe('总表');
    expect(workbook.getCell(0, 0).v).toBe('总表数据');
  });

  test('deleteSheet 支持删除非当前表并保持活动表不变', () => {
    workbook.setCell(0, 0, { v: '总表数据' });
    workbook.addSheet('明细', { activate: false });

    expect(workbook.deleteSheet('明细')).toBe(true);
    expect(workbook.getSheets()).toEqual([
      { id: 'sheet-1', name: '总表', isActive: true }
    ]);
    expect(workbook.getCell(0, 0).v).toBe('总表数据');
  });

  test('deleteSheet 拒绝删除最后一个工作表并触发删除事件', () => {
    const changes = [];
    workbook.on(Events.SHEET_CHANGE, payload => changes.push(payload));

    expect(() => { workbook.deleteSheet('总表'); }).toThrow(/至少保留一个工作表/);
    workbook.addSheet('明细');
    expect(workbook.deleteSheet('sheet-1')).toBe(true);

    expect(changes).toEqual([
      { type: 'sheet-change', id: 'sheet-2', name: '明细', previousId: 'sheet-1', previousName: '总表' },
      {
        type: 'sheet-change',
        id: 'sheet-1',
        name: '总表',
        deleted: true,
        nextId: 'sheet-2',
        nextName: '明细'
      }
    ]);
  });
});
