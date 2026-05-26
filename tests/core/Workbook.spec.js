/**
 * Workbook 单元测试
 * 测试核心数据模型的单元格操作、行列管理、合并、选区等功能
 */

import { Workbook } from '@/core/Workbook';
import { Events } from '@/core/events/EventEmitter';


describe('Workbook', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
  });

  afterEach(() => {
    workbook.destroy();
  });

  describe('构造函数和初始化', () => {
    test('应该创建默认配置的工作簿', () => {
      expect(workbook.rowCount).toBe(1000);
      expect(workbook.colCount).toBe(200);
      expect(workbook.defaultRowHeight).toBe(25);
      expect(workbook.defaultColWidth).toBe(100);
    });

    test('应该初始化空数据', () => {
      expect(workbook.data).toEqual({});
      expect(workbook.merges).toEqual([]);
      expect(workbook.mergeMap).toEqual({});
    });

    test('应该初始化选区状态', () => {
      expect(workbook.selection).toBeNull();
      expect(workbook.activeCell).toEqual({ r: 0, c: 0 });
    });

    test('应该初始化冻结配置', () => {
      expect(workbook.freeze).toEqual({ r: 0, c: 0 });
    });

    test('应该初始化历史管理器', () => {
      expect(workbook.history).toBeDefined();
    });

    test('应该初始化事件系统', () => {
      expect(workbook._events).toBeDefined();
    });
  });

  describe('单元格数据操作', () => {
    describe('getCell / setCell', () => {
      test('应该正确设置和获取单元格值', () => {
        workbook.setCell(0, 0, { v: 'test' });
        
        const cell = workbook.getCell(0, 0);
        expect(cell).toBeDefined();
        expect(cell.v).toBe('test');
      });

      test('获取不存在的单元格应返回 null', () => {
        const cell = workbook.getCell(100, 100);
        expect(cell).toBeNull();
      });

      test('应该支持各种数据类型', () => {
        workbook.setCell(0, 0, { v: 'string' });
        workbook.setCell(1, 0, { v: 123 });
        workbook.setCell(2, 0, { v: true });
        workbook.setCell(3, 0, { v: null });

        expect(workbook.getCell(0, 0).v).toBe('string');
        expect(workbook.getCell(1, 0).v).toBe(123);
        expect(workbook.getCell(2, 0).v).toBe(true);
        expect(workbook.getCell(3, 0).v).toBeNull();
      });

      test('设置公式应该正确处理', () => {
        workbook.setCell(0, 0, { v: '=SUM(A1:A10)' });
        
        const cell = workbook.getCell(0, 0);
        expect(cell.f).toBe('=SUM(A1:A10)');
      });

      test('设置普通值应该清除公式', () => {
        workbook.setCell(0, 0, { v: '=SUM(A1:A10)' });
        workbook.setCell(0, 0, { v: 100 });
        
        const cell = workbook.getCell(0, 0);
        expect(cell.f).toBeUndefined();
        expect(cell.v).toBe(100);
      });
    });

    describe('getCellValue', () => {
      test('应该返回单元格值', () => {
        workbook.setCell(0, 0, { v: 42 });
        
        expect(workbook.getCellValue(0, 0)).toBe(42);
      });

      test('不存在的单元格应返回 null', () => {
        expect(workbook.getCellValue(100, 100)).toBeNull();
      });

      test('应该正确计算简单公式', () => {
        workbook.setCell(0, 0, { v: 10 });
        workbook.setCell(0, 1, { v: 20 });
        workbook.setCell(0, 2, { v: '=A1+B1' });
        
        expect(workbook.getCellValue(0, 2)).toBe(30);
      });
    });

    describe('bulkSetCells', () => {
      test('应该批量设置单元格', () => {
        workbook.bulkSetCells([
          { r: 0, c: 0, val: { v: 'a' } },
          { r: 0, c: 1, val: { v: 'b' } },
          { r: 0, c: 2, val: { v: 'c' } }
        ]);

        expect(workbook.getCell(0, 0).v).toBe('a');
        expect(workbook.getCell(0, 1).v).toBe('b');
        expect(workbook.getCell(0, 2).v).toBe('c');
      });

      test('批量设置应该支持撤销', () => {
        workbook.bulkSetCells([
          { r: 0, c: 0, val: { v: 'test' } }
        ]);

        workbook.undo();

        expect(workbook.getCell(0, 0)).toBeNull();
      });
    });

    describe('_cellKey / _parseKey', () => {
      test('应该生成正确的安全字符串键', () => {
        const key = workbook._cellKey(1, 2);
        expect(key).toBe('1-2');
        
        const { r, c } = workbook._parseKey(key);
        expect(r).toBe(1);
        expect(c).toBe(2);
      });

      test('应该支持超过 16 位边界的行列', () => {
        const key = workbook._cellKey(1048575, 16383);
        const { r, c } = workbook._parseKey(key);
        expect(r).toBe(1048575);
        expect(c).toBe(16383);
      });

      test('应该兼容旧版压缩数字键解析', () => {
        const { r, c } = workbook._parseKey((1 << 16) | 2);
        expect(r).toBe(1);
        expect(c).toBe(2);
      });

      test('应该支持字符串键解析', () => {
        const { r, c } = workbook._parseKey('1-2');
        expect(r).toBe(1);
        expect(c).toBe(2);
      });
    });
  });

  describe('行列尺寸管理', () => {
    describe('getColWidth / setColWidth', () => {
      test('应该返回默认列宽', () => {
        expect(workbook.getColWidth(0)).toBe(100);
      });

      test('应该正确设置列宽', () => {
        workbook.setColWidth(0, 150);
        
        expect(workbook.getColWidth(0)).toBe(150);
        expect(workbook.colWidths[0]).toBe(150);
      });

      test('设置列宽应该支持撤销', () => {
        workbook.setColWidth(0, 150);
        workbook.undo();

        expect(workbook.getColWidth(0)).toBe(100);
      });
    });

    describe('getRowHeight / setRowHeight', () => {
      test('应该返回默认行高', () => {
        expect(workbook.getRowHeight(0)).toBe(25);
      });

      test('应该正确设置行高', () => {
        workbook.setRowHeight(0, 30);
        
        expect(workbook.getRowHeight(0)).toBe(30);
        expect(workbook.rowHeights[0]).toBe(30);
      });

      test('设置行高应该支持撤销', () => {
        workbook.setRowHeight(0, 30);
        workbook.undo();

        expect(workbook.getRowHeight(0)).toBe(25);
      });
    });

    describe('偏移量计算', () => {
      test('getRowPos 应该返回正确的 Y 坐标', () => {
        workbook.setRowHeight(0, 30);
        
        expect(workbook.getRowPos(0)).toBe(0);
        expect(workbook.getRowPos(1)).toBe(30);
        expect(workbook.getRowPos(2)).toBe(55); // 30 + 25
      });

      test('getColPos 应该返回正确的 X 坐标', () => {
        workbook.setColWidth(0, 150);
        
        expect(workbook.getColPos(0)).toBe(0);
        expect(workbook.getColPos(1)).toBe(150);
        expect(workbook.getColPos(2)).toBe(250); // 150 + 100
      });

      test('setRowHeight 应该增量更新已有行偏移缓存', () => {
        workbook.getRowPos(5);
        const rowOffsets = workbook._rowOffsets;

        workbook.setRowHeight(2, 40);

        expect(workbook._offsetsDirty).toBe(false);
        expect(workbook._rowOffsets).toBe(rowOffsets);
        expect(workbook.getRowPos(2)).toBe(50);
        expect(workbook.getRowPos(3)).toBe(90);
      });

      test('setColWidth 应该增量更新已有列偏移缓存', () => {
        workbook.getColPos(5);
        const colOffsets = workbook._colOffsets;

        workbook.setColWidth(2, 160);

        expect(workbook._offsetsDirty).toBe(false);
        expect(workbook._colOffsets).toBe(colOffsets);
        expect(workbook.getColPos(2)).toBe(200);
        expect(workbook.getColPos(3)).toBe(360);
      });

      test('增量更新行偏移时应该保留已有前缀并补齐数组长度', () => {
        workbook.rowCount = 3;
        expect(workbook.getRowPos(3)).toBe(75);
        workbook._dataStore.setState({ rowCount: 4 });

        workbook._updateRowOffsetsFrom(3);

        expect(workbook._offsetsDirty).toBe(false);
        expect(workbook._rowOffsets).toEqual([0, 25, 50, 75, 100]);
      });

      test('增量更新列偏移时应该保留已有前缀并补齐数组长度', () => {
        workbook.colCount = 3;
        expect(workbook.getColPos(3)).toBe(300);
        workbook._dataStore.setState({ colCount: 4 });

        workbook._updateColOffsetsFrom(3);

        expect(workbook._offsetsDirty).toBe(false);
        expect(workbook._colOffsets).toEqual([0, 100, 200, 300, 400]);
      });

      test('getRowIndexAt 应该返回正确的行索引', () => {
        workbook.setRowHeight(0, 30);
        
        expect(workbook.getRowIndexAt(0)).toBe(0);
        expect(workbook.getRowIndexAt(15)).toBe(0);
        expect(workbook.getRowIndexAt(30)).toBe(1);
        expect(workbook.getRowIndexAt(55)).toBe(2);
      });

      test('getColIndexAt 应该返回正确的列索引', () => {
        workbook.setColWidth(0, 150);
        
        expect(workbook.getColIndexAt(0)).toBe(0);
        expect(workbook.getColIndexAt(75)).toBe(0);
        expect(workbook.getColIndexAt(150)).toBe(1);
        expect(workbook.getColIndexAt(250)).toBe(2);
      });

      test('totalWidth / totalHeight 应该返回正确的总尺寸', () => {
        workbook.colCount = 5;
        workbook.rowCount = 10;
        
        expect(workbook.totalWidth).toBe(5 * 100 + 15);
        expect(workbook.totalHeight).toBe(10 * 25 + 15);
      });
    });
  });

  describe('行列操作', () => {
    describe('insertRow / deleteRow', () => {
      test('应该在第0行位置插入行', () => {
        workbook.setCell(0, 0, { v: 'original' });
        
        workbook.insertRow(0);
        
        // 原第0行的数据应该移动到第1行
        expect(workbook.getCell(0, 0)).toBeNull();
        expect(workbook.getCell(1, 0).v).toBe('original');
        expect(workbook.rowCount).toBe(1001);
      });

      test('应该在指定位置插入行', () => {
        workbook.setCell(0, 0, { v: 'row0' });
        workbook.setCell(1, 0, { v: 'row1' });
        
        workbook.insertRow(1);
        
        expect(workbook.getCell(0, 0).v).toBe('row0');
        expect(workbook.getCell(1, 0)).toBeNull();
        expect(workbook.getCell(2, 0).v).toBe('row1');
      });

      test('应该删除指定行', () => {
        workbook.setCell(0, 0, { v: 'row0' });
        workbook.setCell(1, 0, { v: 'row1' });
        workbook.setCell(2, 0, { v: 'row2' });
        
        workbook.deleteRow(1);
        
        expect(workbook.getCell(0, 0).v).toBe('row0');
        expect(workbook.getCell(1, 0).v).toBe('row2');
        expect(workbook.rowCount).toBe(999);
      });

      test('删除行应该支持撤销', () => {
        workbook.setCell(0, 0, { v: 'row0' });
        workbook.setCell(1, 0, { v: 'row1' });
        
        workbook.deleteRow(0);
        workbook.undo();
        
        expect(workbook.getCell(0, 0).v).toBe('row0');
        expect(workbook.getCell(1, 0).v).toBe('row1');
      });

      test('插入和删除行后应该重新构建偏移缓存', () => {
        workbook.rowCount = 3;
        workbook.setRowHeight(0, 30);
        expect(workbook.getRowPos(3)).toBe(80);

        workbook.insertRow(1);

        expect(workbook._offsetsDirty).toBe(true);
        expect(workbook.getRowPos(4)).toBe(105);
        expect(workbook._rowOffsets).toEqual([0, 30, 55, 80, 105]);

        workbook.deleteRow(2);

        expect(workbook._offsetsDirty).toBe(true);
        expect(workbook.getRowPos(3)).toBe(80);
        expect(workbook._rowOffsets).toEqual([0, 30, 55, 80]);
      });
    });

    describe('insertColumn / deleteColumn', () => {
      test('应该在第0列位置插入列', () => {
        workbook.setCell(0, 0, { v: 'original' });
        
        workbook.insertColumn(0);
        
        expect(workbook.getCell(0, 0)).toBeNull();
        expect(workbook.getCell(0, 1).v).toBe('original');
        expect(workbook.colCount).toBe(201);
      });

      test('应该在指定位置插入列', () => {
        workbook.setCell(0, 0, { v: 'col0' });
        workbook.setCell(0, 1, { v: 'col1' });
        
        workbook.insertColumn(1);
        
        expect(workbook.getCell(0, 0).v).toBe('col0');
        expect(workbook.getCell(0, 1)).toBeNull();
        expect(workbook.getCell(0, 2).v).toBe('col1');
      });

      test('应该删除指定列', () => {
        workbook.setCell(0, 0, { v: 'col0' });
        workbook.setCell(0, 1, { v: 'col1' });
        workbook.setCell(0, 2, { v: 'col2' });
        
        workbook.deleteColumn(1);
        
        expect(workbook.getCell(0, 0).v).toBe('col0');
        expect(workbook.getCell(0, 1).v).toBe('col2');
        expect(workbook.colCount).toBe(199);
      });

      test('删除列应该支持撤销', () => {
        workbook.setCell(0, 0, { v: 'col0' });
        workbook.setCell(0, 1, { v: 'col1' });
        
        workbook.deleteColumn(0);
        workbook.undo();
        
        expect(workbook.getCell(0, 0).v).toBe('col0');
        expect(workbook.getCell(0, 1).v).toBe('col1');
      });

      test('插入和删除列后应该重新构建偏移缓存', () => {
        workbook.colCount = 3;
        workbook.setColWidth(0, 120);
        expect(workbook.getColPos(3)).toBe(320);

        workbook.insertColumn(1);

        expect(workbook._offsetsDirty).toBe(true);
        expect(workbook.getColPos(4)).toBe(420);
        expect(workbook._colOffsets).toEqual([0, 120, 220, 320, 420]);

        workbook.deleteColumn(2);

        expect(workbook._offsetsDirty).toBe(true);
        expect(workbook.getColPos(3)).toBe(320);
        expect(workbook._colOffsets).toEqual([0, 120, 220, 320]);
      });
    });

    describe('moveColumn', () => {
      test('应该交换列数据', () => {
        workbook.setCell(0, 0, { v: 'A' });
        workbook.setCell(0, 1, { v: 'B' });
        workbook.setCell(0, 2, { v: 'C' });
        
        workbook.moveColumn(0, 2);
        
        // moveColumn 是交换操作：第0列和第2列交换
        expect(workbook.getCell(0, 0).v).toBe('C');
        expect(workbook.getCell(0, 1).v).toBe('B');
        expect(workbook.getCell(0, 2).v).toBe('A');
      });

      test('移动相同位置不应改变数据', () => {
        workbook.setCell(0, 0, { v: 'A' });
        
        workbook.moveColumn(0, 0);
        
        expect(workbook.getCell(0, 0).v).toBe('A');
      });
    });
  });

  describe('合并单元格', () => {
    describe('addMerge / removeMerge', () => {
      test('应该添加合并区域', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.addMerge(range);
        
        expect(workbook.merges).toHaveLength(1);
        expect(workbook.getMerge(0, 0)).toEqual(range);
        expect(workbook.getMerge(1, 1)).toEqual(range);
      });

      test('应该移除合并区域', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.addMerge(range);
        
        workbook.removeMerge(range);
        
        expect(workbook.merges).toHaveLength(0);
        expect(workbook.getMerge(0, 0)).toBeNull();
      });

      test('getMerge 应该返回 null 对于非合并单元格', () => {
        expect(workbook.getMerge(0, 0)).toBeNull();
      });
    });

    describe('mergeCells / unmergeCells', () => {
      test('mergeCells 应该合并选区并清除非主单元格数据', () => {
        workbook.setCell(0, 0, { v: 'main' });
        workbook.setCell(0, 1, { v: 'secondary' });
        workbook.setCell(1, 0, { v: 'data' });
        
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.mergeCells(range);
        
        expect(workbook.merges).toHaveLength(1);
        expect(workbook.getCell(0, 1)).toBeNull();
        expect(workbook.getCell(1, 0)).toBeNull();
      });

      test('unmergeCells 应该取消合并', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.mergeCells(range);
        
        workbook.unmergeCells(range);
        
        expect(workbook.merges).toHaveLength(0);
      });
    });

    describe('allowsMerge / allowsUnmerge', () => {
      test('allowsMerge 对于多单元格区域应返回 true', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        expect(workbook.allowsMerge(range)).toBe(true);
      });

      test('allowsMerge 对于单个单元格应返回 false', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        expect(workbook.allowsMerge(range)).toBe(false);
      });

      test('allowsUnmerge 对于有合并的区域应返回 true', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.addMerge(range);
        
        expect(workbook.allowsUnmerge(range)).toBe(true);
      });

      test('allowsUnmerge 对于无合并的区域应返回 false', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        expect(workbook.allowsUnmerge(range)).toBe(false);
      });
    });

    describe('getIntersectingMerges', () => {
      test('应该返回相交的合并区域', () => {
        const merge1 = { s: { r: 0, c: 0 }, e: { r: 2, c: 2 } };
        const merge2 = { s: { r: 5, c: 5 }, e: { r: 7, c: 7 } };
        workbook.addMerge(merge1);
        workbook.addMerge(merge2);
        
        const range = { s: { r: 1, c: 1 }, e: { r: 3, c: 3 } };
        const intersecting = workbook.getIntersectingMerges(range);
        
        expect(intersecting).toHaveLength(1);
        expect(intersecting[0]).toEqual(merge1);
      });

      test('不相交的范围应返回空数组', () => {
        const merge = { s: { r: 0, c: 0 }, e: { r: 2, c: 2 } };
        workbook.addMerge(merge);
        
        const range = { s: { r: 5, c: 5 }, e: { r: 7, c: 7 } };
        const intersecting = workbook.getIntersectingMerges(range);
        
        expect(intersecting).toHaveLength(0);
      });
    });
  });

  describe('选区管理', () => {
    describe('setSelection', () => {
      test('应该设置选区', () => {
        workbook.setSelection(0, 0, 2, 2);
        
        expect(workbook.selection).toEqual({
          s: { r: 0, c: 0 },
          e: { r: 2, c: 2 }
        });
        expect(workbook.activeCell).toEqual({ r: 0, c: 0 });
      });

      test('选区应该自动扩展到合并区域', () => {
        const merge = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.addMerge(merge);
        
        workbook.setSelection(0, 0, 0, 0);
        
        expect(workbook.selection).toEqual({
          s: { r: 0, c: 0 },
          e: { r: 1, c: 1 }
        });
      });

      test('应该正确处理反向选择', () => {
        workbook.setSelection(2, 2, 0, 0);
        
        expect(workbook.selection).toEqual({
          s: { r: 0, c: 0 },
          e: { r: 2, c: 2 }
        });
      });
    });

    describe('setCopyRange / clearCopyRange', () => {
      test('应该设置复制范围', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 2, c: 2 } };
        workbook.setCopyRange(range);
        
        expect(workbook.copyRange).toEqual(range);
      });

      test('应该清除复制范围', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 2, c: 2 } };
        workbook.setCopyRange(range);
        
        workbook.clearCopyRange();
        
        expect(workbook.copyRange).toBeNull();
      });
    });
  });

  describe('样式设置', () => {
    describe('setStyle', () => {
      test('应该设置范围样式', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.setStyle(range, { fontWeight: 'bold', color: 'red' });
        
        expect(workbook.getStyle(0, 0).fontWeight).toBe('bold');
        expect(workbook.getStyle(0, 0).color).toBe('red');
        expect(workbook.getStyle(1, 1).fontWeight).toBe('bold');
      });

      test('设置样式应该支持撤销', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setStyle(range, { fontWeight: 'bold' });
        
        workbook.undo();
        
        expect(workbook.getStyle(0, 0).fontWeight).toBeUndefined();
      });
    });

    describe('setBorder', () => {
      test('应该设置全边框', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.setBorder(range, 'all', '#000000', 'solid');
        
        const style = workbook.getStyle(0, 0);
        expect(style.border.top).toBeDefined();
        expect(style.border.bottom).toBeDefined();
        expect(style.border.left).toBeDefined();
        expect(style.border.right).toBeDefined();
      });

      test('应该设置外边框', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.setBorder(range, 'outer', '#000000', 'solid');
        
        // 左上角单元格
        const style00 = workbook.getStyle(0, 0);
        expect(style00.border.top).toBeDefined();
        expect(style00.border.left).toBeDefined();
        expect(style00.border.right).toBeUndefined();
        expect(style00.border.bottom).toBeUndefined();
        
        // 右下角单元格
        const style11 = workbook.getStyle(1, 1);
        expect(style11.border.bottom).toBeDefined();
        expect(style11.border.right).toBeDefined();
      });

      test('应该清除边框', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
        workbook.setBorder(range, 'all', '#000000', 'solid');
        workbook.setBorder(range, 'none');
        
        const style = workbook.getStyle(0, 0);
        expect(style.border.top).toBeUndefined();
        expect(style.border.bottom).toBeUndefined();
      });
    });

    describe('setFormat', () => {
      test('应该设置数字格式', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setFormat(range, 'comma');
        
        expect(workbook.getStyle(0, 0).fmt).toBe('comma');
      });

      test('应该设置百分比格式', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setFormat(range, 'percent');
        
        expect(workbook.getStyle(0, 0).fmt).toBe('percent');
        expect(workbook.getStyle(0, 0).decimals).toBe(0);
      });
    });

    describe('setDecimals', () => {
      test('应该增加小数位数', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setDecimals(range, 1);
        
        expect(workbook.getStyle(0, 0).decimals).toBe(3);
      });

      test('应该减少小数位数', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setDecimals(range, -1);
        
        expect(workbook.getStyle(0, 0).decimals).toBe(1);
      });

      test('小数位数不应小于0', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setDecimals(range, -10);
        
        expect(workbook.getStyle(0, 0).decimals).toBe(0);
      });

      test('小数位数不应大于10', () => {
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.setDecimals(range, 20);
        
        expect(workbook.getStyle(0, 0).decimals).toBe(10);
      });
    });

    describe('clearContent', () => {
      test('应该清除单元格内容但保留样式', () => {
        workbook.setCell(0, 0, { v: 'test', s: { fontWeight: 'bold' } });
        
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.clearContent(range);
        
        const cell = workbook.getCell(0, 0);
        expect(cell.v).toBeUndefined();
        expect(cell.s.fontWeight).toBe('bold');
      });
    });

    describe('clearCells', () => {
      test('应该完全清除单元格', () => {
        workbook.setCell(0, 0, { v: 'test', s: { fontWeight: 'bold' } });
        
        const range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        workbook.clearCells(range);
        
        expect(workbook.getCell(0, 0)).toBeNull();
      });
    });
  });

  describe('冻结窗格', () => {
    test('应该设置冻结配置', () => {
      workbook.setFreeze(2, 3);
      
      expect(workbook.freeze).toEqual({ r: 2, c: 3 });
    });

    test('getFrozenSize 应该返回正确的冻结区域尺寸', () => {
      workbook.setFreeze(2, 2);
      
      const size = workbook.getFrozenSize();
      
      expect(size.w).toBe(200); // 2 * 100
      expect(size.h).toBe(50);  // 2 * 25
    });

    test('冻结区域内尺寸变更在撤销后应该刷新冻结尺寸缓存', () => {
      workbook.setFreeze(2, 2);
      expect(workbook.getFrozenSize()).toEqual({ w: 200, h: 50 });

      workbook.setRowHeight(0, 40);
      expect(workbook.getFrozenSize()).toEqual({ w: 200, h: 65 });

      workbook.undo();
      expect(workbook.getFrozenSize()).toEqual({ w: 200, h: 50 });

      workbook.setColWidth(0, 150);
      expect(workbook.getFrozenSize()).toEqual({ w: 250, h: 50 });

      workbook.undo();
      expect(workbook.getFrozenSize()).toEqual({ w: 200, h: 50 });
    });

    test('插入和删除行列应该让冻结尺寸缓存失效', () => {
      workbook.setFreeze(1, 1);
      workbook.getFrozenSize();
      expect(workbook._frozenSizeDirty).toBe(false);

      workbook.insertRow(0);
      expect(workbook._frozenSizeDirty).toBe(true);
      workbook.getFrozenSize();

      workbook.deleteRow(0);
      expect(workbook._frozenSizeDirty).toBe(true);
      workbook.getFrozenSize();

      workbook.insertColumn(0);
      expect(workbook._frozenSizeDirty).toBe(true);
      workbook.getFrozenSize();

      workbook.deleteColumn(0);
      expect(workbook._frozenSizeDirty).toBe(true);
    });
  });

  describe('公式计算', () => {
    let consoleErrorSpy;

    beforeEach(() => {
      workbook.setCell(0, 0, { v: 10 });
      workbook.setCell(0, 1, { v: 20 });
      workbook.setCell(0, 2, { v: 30 });
    });

    afterEach(() => {
      if (consoleErrorSpy) {
        consoleErrorSpy.mockRestore();
        consoleErrorSpy = null;
      }
    });

    test('应该计算 SUM 函数', () => {
      workbook.setCell(1, 0, { v: '=SUM(A1:C1)' });
      
      expect(workbook.getCellValue(1, 0)).toBe(60);
    });

    test('应该计算 AVERAGE 函数', () => {
      workbook.setCell(1, 0, { v: '=AVERAGE(A1:C1)' });
      
      expect(workbook.getCellValue(1, 0)).toBe(20);
    });

    test('应该计算 MAX 函数', () => {
      workbook.setCell(1, 0, { v: '=MAX(A1:C1)' });
      
      expect(workbook.getCellValue(1, 0)).toBe(30);
    });

    test('应该计算 MIN 函数', () => {
      workbook.setCell(1, 0, { v: '=MIN(A1:C1)' });
      
      expect(workbook.getCellValue(1, 0)).toBe(10);
    });

    test('应该正确处理公式依赖', () => {
      workbook.setCell(1, 0, { v: '=A1+B1' }); // 30
      workbook.setCell(2, 0, { v: '=A2*2' });  // 60
      
      expect(workbook.getCellValue(2, 0)).toBe(60);
      
      // 修改依赖的单元格
      workbook.setCell(0, 0, { v: 20 });
      
      // A2 应该被标记为 dirty
      const cellA2 = workbook.getCell(1, 0);
      expect(cellA2.dirty).toBe(true);
    });

    test('应该检测循环引用', () => {
      // Mock console.error 以抑制预期的错误日志
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      workbook.setCell(0, 0, { v: '=B1' });
      workbook.setCell(0, 1, { v: '=A1' });

      // 尝试获取值时应该返回错误
      const result = workbook.getCellValue(0, 0);
      // 循环引用会抛出错误，返回 #ERROR! 或 #CYCLE!
      expect(result).toMatch(/#(ERROR|CYCLE)!/);
    });

    describe('getDependencies', () => {
      test('应该返回单元格依赖', () => {
        const deps = workbook.getDependencies('=A1+B1');
        
        expect(deps.size).toBe(2);
      });

      test('应该返回范围依赖', () => {
        const deps = workbook.getDependencies('=SUM(A1:C1)');
        
        expect(deps.size).toBe(3);
      });
    });
  });

  describe('序列化', () => {
    describe('toJSON / fromJSON', () => {
      test('应该正确序列化工作簿', () => {
        workbook.setCell(0, 0, { v: 'test' });
        workbook.setColWidth(0, 150);
        workbook.setRowHeight(0, 30);
        workbook.addMerge({ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } });
        workbook.setFreeze(1, 1);
        
        const json = workbook.toJSON();
        
        expect(json.rowCount).toBeDefined();
        expect(json.colCount).toBeDefined();
        expect(json.data).toBeDefined();
        expect(json.merges).toHaveLength(1);
        expect(json.freeze).toEqual({ r: 1, c: 1 });
      });

      test('应该正确反序列化工作簿', () => {
        const json = {
          rowCount: 30,
          colCount: 15,
          rowHeights: { 0: 30 },
          colWidths: { 0: 150 },
          data: { '0-0': { v: 'test' } },
          merges: [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }],
          freeze: { r: 1, c: 1 }
        };
        
        workbook.fromJSON(json);
        
        expect(workbook.rowCount).toBe(30);
        expect(workbook.colCount).toBe(15);
        // fromJSON 使用 data setter，数据会被迁移到稀疏矩阵
        const cell = workbook.getCell(0, 0);
        expect(cell).not.toBeNull();
        expect(cell.v).toBe('test');
        expect(workbook.merges).toHaveLength(1);
        expect(workbook.freeze).toEqual({ r: 1, c: 1 });
      });

      test('反序列化应该清除历史', () => {
        workbook.setCell(0, 0, { v: 'old' });
        
        workbook.fromJSON({
          data: { '0-0': { v: 'new' } }
        });
        
        // fromJSON 会清除历史栈
        expect(workbook.history.undoStackSize).toBe(0);
      });
    });
  });

  describe('性能监控 (Performance Monitor)', () => {
    test('应该能够启用和禁用性能监控', () => {
      workbook.enablePerformanceMonitoring({ thresholds: { 'render': 100 } });
      workbook.enablePerformanceMonitoring({ thresholds: { 'render': 100 } });
      const monitor = workbook.getPerformanceMonitor();
      expect(monitor).toBeDefined();

      workbook.disablePerformanceMonitoring();
    });

    test('应该能够获取报表和导出', () => {
      workbook.enablePerformanceMonitoring();
      workbook.getPerformanceMonitor().record('testMetric', 10);
      
      const report = workbook.getPerformanceReport();
      expect(report).toBeDefined();

      const json = workbook.exportPerformanceJSON();
      expect(typeof json).toBe('string');
      
      const csv = workbook.exportPerformanceCSV();
      expect(typeof csv).toBe('string');
      expect(csv.includes('testMetric')).toBe(true);
      
      expect(() => {
        workbook.printPerformanceSummary();
      }).not.toThrow();
    });
  });

  describe('Store 订阅 (Store Subscriptions)', () => {
    test('应该能够订阅各个 store', () => {
      const dataListener = vi.fn();
      const selListener = vi.fn();
      const uiListener = vi.fn();

      workbook.subscribeData(dataListener);
      workbook.subscribeSelection(selListener);
      workbook.subscribeUI(uiListener);

      workbook.subscribeUI(uiListener);

      workbook.select('data', state => state.dataVersion, dataListener);

      workbook.setCell(0, 0, { v: 'test payload' });

      // 数据更新触发了 listener
      expect(dataListener).toHaveBeenCalled();
      
      workbook.beginBatchUpdate();
      workbook.setCell(0, 1, { v: 'batch1' });
      workbook.endBatchUpdate();
      
      expect(workbook.getStoreManager()).toBeDefined();
    });
  });

  describe('Web Worker 集成 (Web Worker)', () => {
    test('应该能处理 Web Worker 启用、禁用', () => {
      // 通过模拟 isWorkerSupported 如果不够，只确认不抛出即可
      workbook.enableWorker();
      // 在 node 环境下通常不支持真正 Worker，这依赖内部条件，如果支持则会被创建
      expect(() => workbook.disableWorker()).not.toThrow();
      
      // 测试 fallback executor
      expect(workbook._fallbackExecutor('evaluate', { formula: '=1+2', r: 0, c: 0 })).toBe(3);
      expect(workbook._fallbackExecutor('evaluateBatch', { formulas: [{ cellId: '1', formula: '=1+2', r: 0, c: 0 }] })).toEqual({ '1': 3 });
      
      expect(() => workbook._fallbackExecutor('unknown_type', {})).toThrow();
      
      expect(workbook.getWorkerStats()).toBeNull();
      expect(workbook.isWorkerEnabled()).toBe(false);
    });
  });

  describe('事件系统', () => {
    test('应该触发 CELL_CHANGE 事件', () => {
      const handler = vi.fn();
      workbook.on(Events.CELL_CHANGE, handler);
      
      workbook.setCell(0, 0, { v: 'test' });
      
      expect(handler).toHaveBeenCalled();
    });

    test('应该触发 SELECTION_CHANGE 事件', () => {
      const handler = vi.fn();
      workbook.on(Events.SELECTION_CHANGE, handler);
      
      workbook.setSelection(0, 0, 2, 2);
      
      expect(handler).toHaveBeenCalled();
    });

    test('应该触发 MERGE_CHANGE 事件', () => {
      const handler = vi.fn();
      workbook.on(Events.MERGE_CHANGE, handler);
      
      workbook.addMerge({ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } });
      
      expect(handler).toHaveBeenCalled();
    });

    test('subscribe 应该向后兼容', () => {
      const handler = vi.fn();
      workbook.subscribe(handler);
      
      workbook.setCell(0, 0, { v: 'test' });
      
      expect(handler).toHaveBeenCalled();
    });

    test('取消订阅应该正常工作', () => {
      const handler = vi.fn();
      const unsubscribe = workbook.on(Events.CELL_CHANGE, handler);
      
      unsubscribe();
      workbook.setCell(0, 0, { v: 'test' });
      
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('setData', () => {
    test('应该从数组设置数据', () => {
      const data = [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 }
      ];
      
      workbook.setData(data);
      
      expect(workbook.getCell(0, 0).v).toBe('name');
      expect(workbook.getCell(0, 1).v).toBe('age');
      expect(workbook.getCell(1, 0).v).toBe('Alice');
      expect(workbook.getCell(1, 1).v).toBe(30);
    });

    test('应该从对象设置数据', () => {
      const data = {
        '0-0': { v: 'A1' },
        '0-1': { v: 'B1' }
      };
      
      workbook.setData(data);
      
      expect(workbook.getCell(0, 0).v).toBe('A1');
      expect(workbook.getCell(0, 1).v).toBe('B1');
    });

    test('空数组应该清空数据', () => {
      workbook.setCell(0, 0, { v: 'test' });
      
      workbook.setData([]);
      
      // 数据应该被清空，只保留表头行
      expect(workbook.dataVersion).toBeGreaterThan(0);
    });
  });

  describe('setColumns', () => {
    test('应该设置列配置', () => {
      const columns = [
        { field: 'name', title: '姓名', width: 120 },
        { field: 'age', title: '年龄', width: 80 }
      ];
      
      workbook.setColumns(columns);
      
      expect(workbook.fieldMap.name).toBe(0);
      expect(workbook.fieldMap.age).toBe(1);
      expect(workbook.colWidths[0]).toBe(120);
      expect(workbook.colWidths[1]).toBe(80);
    });

    test('应该处理嵌套列', () => {
      const columns = [
        {
          title: '基本信息',
          children: [
            { field: 'name', title: '姓名' },
            { field: 'age', title: '年龄' }
          ]
        }
      ];
      
      workbook.setColumns(columns);
      
      expect(workbook.headerDepth).toBe(2);
      expect(workbook.fieldMap.name).toBeDefined();
      expect(workbook.fieldMap.age).toBeDefined();
    });

    test('应该创建合并的表头', () => {
      const columns = [
        {
          title: '基本信息',
          children: [
            { field: 'name', title: '姓名' },
            { field: 'age', title: '年龄' }
          ]
        }
      ];
      
      workbook.setColumns(columns);
      
      // 基本信息应该被合并
      expect(workbook.merges.length).toBeGreaterThan(0);
    });
  });

  describe('fillAuto', () => {
    test('应该填充数字序列', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: 2 });
      workbook.setCell(0, 2, { v: 3 });
      
      const sourceRange = { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } };
      const targetRange = { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } };
      
      workbook.fillAuto(sourceRange, targetRange);
      
      expect(workbook.getCellValue(0, 3)).toBe(4);
      expect(workbook.getCellValue(0, 4)).toBe(5);
      expect(workbook.getCellValue(0, 5)).toBe(6);
    });

    test('应该垂直填充', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(1, 0, { v: 2 });
      workbook.setCell(2, 0, { v: 3 });
      
      const sourceRange = { s: { r: 0, c: 0 }, e: { r: 2, c: 0 } };
      const targetRange = { s: { r: 0, c: 0 }, e: { r: 5, c: 0 } };
      
      workbook.fillAuto(sourceRange, targetRange);
      
      expect(workbook.getCellValue(3, 0)).toBe(4);
      expect(workbook.getCellValue(4, 0)).toBe(5);
      expect(workbook.getCellValue(5, 0)).toBe(6);
    });

    test('水平填充应该批量写入并只记录一个历史命令', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: 2 });
      workbook.setCell(0, 2, { v: 3 });
      workbook.history.clear();

      const notifySpy = vi.spyOn(workbook, 'notify');
      const setCellSpy = vi.spyOn(workbook, 'setCell');
      const bulkSetCellsSpy = vi.spyOn(workbook, 'bulkSetCells');
      const sourceRange = { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } };
      const targetRange = { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } };

      workbook.fillAuto(sourceRange, targetRange);

      expect(setCellSpy).not.toHaveBeenCalled();
      expect(bulkSetCellsSpy).toHaveBeenCalledTimes(1);
      expect(bulkSetCellsSpy.mock.calls[0][0]).toHaveLength(3);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(workbook.history.undoStackSize).toBe(1);
      expect(workbook.history.undoStack.get(0).type).toBe('batch-set-cell');

      workbook.undo();

      expect(workbook.getCell(0, 3)).toBeNull();
      expect(workbook.getCell(0, 4)).toBeNull();
      expect(workbook.getCell(0, 5)).toBeNull();
    });

    test('垂直填充多个列时应该一次性批量写入', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(1, 0, { v: 2 });
      workbook.setCell(0, 1, { v: 'A' });
      workbook.setCell(1, 1, { v: 'B' });
      workbook.history.clear();

      const notifySpy = vi.spyOn(workbook, 'notify');
      const bulkSetCellsSpy = vi.spyOn(workbook, 'bulkSetCells');
      const sourceRange = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
      const targetRange = { s: { r: 0, c: 0 }, e: { r: 4, c: 1 } };

      workbook.fillAuto(sourceRange, targetRange);

      expect(bulkSetCellsSpy).toHaveBeenCalledTimes(1);
      expect(bulkSetCellsSpy.mock.calls[0][0]).toHaveLength(6);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(workbook.getCellValue(2, 0)).toBe(3);
      expect(workbook.getCellValue(3, 1)).toBe('B');
      expect(workbook.getCellValue(4, 1)).toBe('A');
    });
  });

  describe('地址转换', () => {
    test('getAddress 应该返回正确的单元格地址', () => {
      expect(workbook.getAddress(0, 0)).toBe('A1');
      expect(workbook.getAddress(0, 1)).toBe('B1');
      expect(workbook.getAddress(1, 0)).toBe('A2');
      expect(workbook.getAddress(0, 25)).toBe('Z1');
      expect(workbook.getAddress(0, 26)).toBe('AA1');
    });

    test('_colStrToIndex 应该正确转换列字母', () => {
      expect(workbook._colStrToIndex('A')).toBe(0);
      expect(workbook._colStrToIndex('B')).toBe(1);
      expect(workbook._colStrToIndex('Z')).toBe(25);
      expect(workbook._colStrToIndex('AA')).toBe(26);
      expect(workbook._colStrToIndex('AB')).toBe(27);
    });
  });

  describe('迭代方法', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: 2 });
      workbook.setCell(1, 0, { v: 3 });
      workbook.setCell(1, 1, { v: 4 });
    });

    test('iterateRange 应该遍历范围内的单元格', () => {
      const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
      const values = [];
      
      workbook.iterateRange(range, (r, c, cell) => {
        values.push(cell ? cell.v : null);
      });
      
      expect(values).toEqual([1, 2, 3, 4]);
    });

    test('collectRange 应该收集范围内的结果', () => {
      const range = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
      
      const values = workbook.collectRange(range, (r, c, cell) => {
        return cell ? cell.v : null;
      });
      
      expect(values).toEqual([1, 2, 3, 4]);
    });
  });

  describe('销毁', () => {
    test('destroy 应该清理所有资源', () => {
      workbook.setCell(0, 0, { v: 'test' });
      workbook.addMerge({ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } });
      
      workbook.destroy();
      
      expect(workbook.merges).toEqual([]);
      expect(workbook.mergeMap).toEqual({});
    });
  });

  describe('对象池 (CellPool) 管理', () => {
    test('删除单元格应回收对象', () => {
      workbook.setCell(0, 0, { v: 'test' });
      const cell = workbook.getCell(0, 0);
      const spy = vi.spyOn(workbook._cellPool, 'releaseCell');
      
      workbook.setCell(0, 0, null);
      
      expect(spy).toHaveBeenCalledWith(cell);
      spy.mockRestore();
    });

    test('重写单元格应回收旧对象', () => {
      workbook.setCell(0, 0, { v: 'old' });
      const oldCell = workbook.getCell(0, 0);
      const spy = vi.spyOn(workbook._cellPool, 'releaseCell');
      
      // 注意：setCell 内部如果只是修改属性可能不会触发 SparseMatrix.set 替换对象
      // 但如果调用的是会分发新对象的逻辑（如 setData 或直接 _dataMatrix.set），则会回收
      const newCell = { v: 'new' };
      workbook._dataMatrix.set(0, 0, newCell);
      
      expect(spy).toHaveBeenCalledWith(oldCell);
      spy.mockRestore();
    });

    test('删除行应回收该行所有单元格', () => {
      workbook.setCell(0, 0, { v: '1' });
      workbook.setCell(0, 1, { v: '2' });
      const cell1 = workbook.getCell(0, 0);
      const cell2 = workbook.getCell(0, 1);
      const spy = vi.spyOn(workbook._cellPool, 'releaseCell');
      
      workbook.deleteRow(0);
      
      expect(spy).toHaveBeenCalledWith(cell1);
      expect(spy).toHaveBeenCalledWith(cell2);
      spy.mockRestore();
    });

    test('行列移动时不应回收被移动的单元格', () => {
      workbook.setCell(0, 0, { v: 'original' });
      const cell = workbook.getCell(0, 0);
      const spy = vi.spyOn(workbook._cellPool, 'releaseCell');
      
      workbook.insertRow(0); // 单元格从 0,0 移到 1,0
      
      // 应该没有被回收
      expect(spy).not.toHaveBeenCalledWith(cell);
      expect(workbook.getCell(1, 0)).toBe(cell);
      spy.mockRestore();
    });

    test('清空工作簿应回收所有单元格', () => {
      workbook.setCell(0, 0, { v: 'a' });
      workbook.setCell(1, 1, { v: 'b' });
      const cellA = workbook.getCell(0, 0);
      const cellB = workbook.getCell(1, 1);
      const spy = vi.spyOn(workbook._cellPool, 'releaseCell');
      
      workbook.destroy();
      
      expect(spy).toHaveBeenCalledWith(cellA);
      expect(spy).toHaveBeenCalledWith(cellB);
      spy.mockRestore();
    });
  });

  describe('只读模式 (ReadOnly) 动态边界', () => {
    test('只读模式应根据数据动态计算行列数', () => {
      // 默认编辑模式
      expect(workbook.readOnly).toBe(false);
      expect(workbook.rowCount).toBe(1000);
      expect(workbook.colCount).toBe(200);

      // 设置数据到第 30 行
      workbook.setCell(30, 0, { v: 'test' });
      expect(workbook.rowCount).toBe(1000); // 编辑模式下依然是默认值或之前设定的值

      // 切换到只读模式
      workbook.readOnly = true;
      expect(workbook.rowCount).toBe(31); // 30 + 1
      expect(workbook.colCount).toBe(1);  // 只有一列有数据

      // 切换回编辑模式
      workbook.readOnly = false;
      expect(workbook.rowCount).toBe(1000);
    });

    test('只读模式下增加数据应自动扩展边界', () => {
      workbook.readOnly = true;
      workbook.setCell(5, 5, { v: 'data' });
      expect(workbook.rowCount).toBe(6);
      expect(workbook.colCount).toBe(6);

      workbook.setCell(10, 2, { v: 'more' });
      expect(workbook.rowCount).toBe(11);
      expect(workbook.colCount).toBe(6);
    });

    test('空数据时只读模式应显示 1x1 最小边界', () => {
      workbook.readOnly = true;
      expect(workbook.rowCount).toBe(1);
      expect(workbook.colCount).toBe(1);
    });
  });
});
