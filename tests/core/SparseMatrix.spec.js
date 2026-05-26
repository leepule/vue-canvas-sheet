/**
 * SparseMatrix 单元测试
 */

import { SparseMatrix, createSparseMatrix } from '@/core/data/SparseMatrix';
import { parseCellKey } from '@/core/data/CellKey';


describe('SparseMatrix', () => {
  let matrix;

  beforeEach(() => {
    matrix = new SparseMatrix();
  });

  describe('基本操作', () => {
    test('应该正确创建空矩阵', () => {
      expect(matrix.size).toBe(0);
      expect(matrix.isEmpty()).toBe(true);
      expect(matrix.version).toBe(0);
    });

    test('应该正确设置和获取单元格', () => {
      matrix.set(0, 0, { v: 'Hello' });
      expect(matrix.size).toBe(1);
      expect(matrix.get(0, 0)).toEqual({ v: 'Hello' });
      expect(matrix.isEmpty()).toBe(false);
    });

    test('应该正确处理 undefined 和 null 值', () => {
      matrix.set(0, 0, { v: 'test' });
      expect(matrix.size).toBe(1);

      matrix.set(0, 0, null);
      expect(matrix.size).toBe(0);
      expect(matrix.get(0, 0)).toBeUndefined();

      matrix.set(1, 1, { v: 'test2' });
      matrix.set(1, 1, undefined);
      expect(matrix.size).toBe(0);
    });

    test('应该正确更新已存在的单元格', () => {
      matrix.set(0, 0, { v: 'old' });
      expect(matrix.size).toBe(1);

      matrix.set(0, 0, { v: 'new' });
      expect(matrix.size).toBe(1);
      expect(matrix.get(0, 0)).toEqual({ v: 'new' });
    });

    test('应该正确删除单元格', () => {
      matrix.set(0, 0, { v: 'test' });
      expect(matrix.has(0, 0)).toBe(true);

      const result = matrix.delete(0, 0);
      expect(result).toBe(true);
      expect(matrix.has(0, 0)).toBe(false);
      expect(matrix.size).toBe(0);
    });

    test('删除不存在的单元格应返回 false', () => {
      const result = matrix.delete(0, 0);
      expect(result).toBe(false);
    });

    test('应该正确检查单元格是否存在', () => {
      expect(matrix.has(0, 0)).toBe(false);
      matrix.set(0, 0, { v: 'test' });
      expect(matrix.has(0, 0)).toBe(true);
      expect(matrix.has(0, 1)).toBe(false);
    });
  });

  describe('版本控制', () => {
    test('每次修改应该增加版本号', () => {
      const v1 = matrix.version;
      matrix.set(0, 0, { v: 'test' });
      expect(matrix.version).toBe(v1 + 1);

      const v2 = matrix.version;
      matrix.set(0, 0, { v: 'updated' });
      expect(matrix.version).toBe(v2 + 1);

      const v3 = matrix.version;
      matrix.delete(0, 0);
      expect(matrix.version).toBe(v3 + 1);
    });
  });

  describe('行列操作', () => {
    beforeEach(() => {
      // 创建测试数据
      // (0,0) (0,1) (0,2)
      // (1,0)       (1,2)
      //       (2,1) (2,2)
      matrix.set(0, 0, { v: 'A1' });
      matrix.set(0, 1, { v: 'B1' });
      matrix.set(0, 2, { v: 'C1' });
      matrix.set(1, 0, { v: 'A2' });
      matrix.set(1, 2, { v: 'C2' });
      matrix.set(2, 1, { v: 'B3' });
      matrix.set(2, 2, { v: 'C3' });
    });

    test('应该正确获取一行数据', () => {
      const row0 = matrix.getRow(0);
      expect(row0.size).toBe(3);
      expect(row0.get(0)).toEqual({ v: 'A1' });
      expect(row0.get(1)).toEqual({ v: 'B1' });
      expect(row0.get(2)).toEqual({ v: 'C1' });

      const row1 = matrix.getRow(1);
      expect(row1.size).toBe(2);
      expect(row1.get(1)).toBeUndefined();
    });

    test('应该正确获取一列数据', () => {
      const col0 = matrix.getCol(0);
      expect(col0.size).toBe(2);
      expect(col0.get(0)).toEqual({ v: 'A1' });
      expect(col0.get(1)).toEqual({ v: 'A2' });

      const col1 = matrix.getCol(1);
      expect(col1.size).toBe(2);
      expect(col1.get(0)).toEqual({ v: 'B1' });
      expect(col1.get(2)).toEqual({ v: 'B3' });
    });

    test('应该正确删除整行', () => {
      const count = matrix.deleteRow(0);
      expect(count).toBe(3);
      expect(matrix.size).toBe(4);
      expect(matrix.has(0, 0)).toBe(false);
      expect(matrix.has(0, 1)).toBe(false);
      expect(matrix.has(0, 2)).toBe(false);
      expect(matrix.has(1, 0)).toBe(true);
    });

    test('应该正确删除整列', () => {
      const count = matrix.deleteCol(1);
      expect(count).toBe(2);
      expect(matrix.size).toBe(5);
      expect(matrix.has(0, 1)).toBe(false);
      expect(matrix.has(2, 1)).toBe(false);
      expect(matrix.has(0, 0)).toBe(true);
    });

    test('应该正确删除行范围', () => {
      const count = matrix.deleteRowRange(1, 2);
      expect(count).toBe(4);
      expect(matrix.size).toBe(3);
      expect(matrix.has(1, 0)).toBe(false);
      expect(matrix.has(2, 1)).toBe(false);
      expect(matrix.has(0, 0)).toBe(true);
    });

    test('应该正确删除列范围', () => {
      const count = matrix.deleteColRange(1, 2);
      expect(count).toBe(5);
      expect(matrix.size).toBe(2);
      expect(matrix.has(0, 1)).toBe(false);
      expect(matrix.has(0, 2)).toBe(false);
      expect(matrix.has(0, 0)).toBe(true);
    });

    test('删除空行应返回 0', () => {
      const count = matrix.deleteRow(10);
      expect(count).toBe(0);
      expect(matrix.size).toBe(7);
    });
  });

  describe('范围遍历', () => {
    beforeEach(() => {
      matrix.set(0, 0, { v: 'A1' });
      matrix.set(0, 1, { v: 'B1' });
      matrix.set(1, 0, { v: 'A2' });
      matrix.set(1, 1, { v: 'B2' });
      matrix.set(5, 5, { v: 'F6' });
    });

    test('应该正确遍历范围内的单元格', () => {
      const cells = [];
      matrix.iterateRange(0, 0, 1, 1, (r, c, cell) => {
        cells.push({ r, c, v: cell.v });
      });
      expect(cells).toHaveLength(4);
      expect(cells).toContainEqual({ r: 0, c: 0, v: 'A1' });
      expect(cells).toContainEqual({ r: 0, c: 1, v: 'B1' });
      expect(cells).toContainEqual({ r: 1, c: 0, v: 'A2' });
      expect(cells).toContainEqual({ r: 1, c: 1, v: 'B2' });
    });

    test('不应该遍历范围外的单元格', () => {
      const cells = [];
      matrix.iterateRange(0, 0, 0, 1, (r, c, cell) => {
        cells.push({ r, c, v: cell.v });
      });
      expect(cells).toHaveLength(2);
      expect(cells).not.toContainEqual({ r: 5, c: 5, v: 'F6' });
    });
  });

  describe('迭代方法', () => {
    beforeEach(() => {
      matrix.set(0, 0, { v: 'A' });
      matrix.set(0, 1, { v: 'B' });
      matrix.set(1, 0, { v: 'C' });
    });

    test('forEach 应该遍历所有单元格', () => {
      const cells = [];
      matrix.forEach((r, c, cell) => {
        cells.push({ r, c, v: cell.v });
      });
      expect(cells).toHaveLength(3);
    });

    test('entries 应该返回所有条目', () => {
      const entries = matrix.entries();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toHaveProperty('r');
      expect(entries[0]).toHaveProperty('c');
      expect(entries[0]).toHaveProperty('cell');
    });

    test('keys 应该返回所有键', () => {
      const keys = matrix.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContainEqual({ r: 0, c: 0 });
      expect(keys).toContainEqual({ r: 0, c: 1 });
      expect(keys).toContainEqual({ r: 1, c: 0 });
    });

    test('values 应该返回所有值', () => {
      const values = matrix.values();
      expect(values).toHaveLength(3);
      expect(values.map(v => v.v)).toContain('A');
      expect(values.map(v => v.v)).toContain('B');
      expect(values.map(v => v.v)).toContain('C');
    });

    test('rowIndices 应该返回所有行索引', () => {
      const rows = matrix.rowIndices();
      expect(rows).toContain(0);
      expect(rows).toContain(1);
    });

    test('colIndices 应该返回所有列索引', () => {
      const cols = matrix.colIndices();
      expect(cols).toContain(0);
      expect(cols).toContain(1);
    });
  });

  describe('边界和统计', () => {
    test('空矩阵的边界应该是无效的', () => {
      const bounds = matrix.getBounds();
      expect(bounds.minRow).toBe(0);
      expect(bounds.maxRow).toBe(-1);
    });

    test('应该正确计算边界', () => {
      matrix.set(2, 3, { v: 'test' });
      matrix.set(5, 1, { v: 'test' });
      matrix.set(0, 10, { v: 'test' });

      const bounds = matrix.getBounds();
      expect(bounds.minRow).toBe(0);
      expect(bounds.maxRow).toBe(5);
      expect(bounds.minCol).toBe(1);
      expect(bounds.maxCol).toBe(10);
    });

    test('应该正确计算统计信息', () => {
      matrix.set(0, 0, { v: 'A' });
      matrix.set(0, 1, { v: 'B' });
      matrix.set(1, 0, { v: 'C' });

      const stats = matrix.getStats();
      expect(stats.cellCount).toBe(3);
      expect(stats.rowCount).toBe(2);
      expect(stats.colCount).toBe(2);
      expect(stats.density).toBeCloseTo(0.75, 2); // 3/4 = 0.75
    });
  });

  describe('批量操作', () => {
    test('setCells 应该批量设置单元格', () => {
      matrix.setCells([
        { r: 0, c: 0, cell: { v: 'A' } },
        { r: 0, c: 1, cell: { v: 'B' } },
        { r: 1, c: 0, cell: { v: 'C' } }
      ]);
      expect(matrix.size).toBe(3);
      expect(matrix.get(0, 0)).toEqual({ v: 'A' });
    });
  });

  describe('对象转换', () => {
    test('toObject 应该正确转换为普通对象（安全键）', () => {
      matrix.set(0, 0, { v: 'A' });
      matrix.set(1, 2, { v: 'B' });
      
      const obj = matrix.toObject(true);
      expect(obj['0-0']).toEqual({ v: 'A' });
      expect(obj['1-2']).toEqual({ v: 'B' });
    });

    test('toObject 应该正确转换为普通对象（字符串键）', () => {
      matrix.set(0, 0, { v: 'A' });
      matrix.set(1, 2, { v: 'B' });
      
      const obj = matrix.toObject(false);
      expect(obj['0-0']).toEqual({ v: 'A' });
      expect(obj['1-2']).toEqual({ v: 'B' });
    });

    test('fromObject 应该正确从普通对象导入', () => {
      const obj = {
        0: { v: 'A' },
        65538: { v: 'B' }
      };
      
      matrix.fromObject(obj, (key) => {
        return parseCellKey(key);
      });
      
      expect(matrix.size).toBe(2);
      expect(matrix.get(0, 0)).toEqual({ v: 'A' });
      expect(matrix.get(1, 2)).toEqual({ v: 'B' });
    });
  });

  describe('克隆和序列化', () => {
    test('clone 应该创建独立副本', () => {
      matrix.set(0, 0, { v: 'A' });
      const cloned = matrix.clone();
      
      expect(cloned.size).toBe(matrix.size);
      expect(cloned.get(0, 0)).toEqual({ v: 'A' });
      
      cloned.set(0, 0, { v: 'B' });
      expect(matrix.get(0, 0)).toEqual({ v: 'A' });
      expect(cloned.get(0, 0)).toEqual({ v: 'B' });
    });

    test('toJSON 和 fromJSON 应该正确序列化', () => {
      matrix.set(0, 0, { v: 'A', s: { fontWeight: 'bold' } });
      matrix.set(1, 2, { v: 100, f: '=SUM(A1:A10)' });
      
      const json = matrix.toJSON();
      expect(json.size).toBe(2);
      expect(json.cells).toHaveLength(2);
      
      const newMatrix = new SparseMatrix();
      newMatrix.fromJSON(json);
      
      expect(newMatrix.size).toBe(2);
      expect(newMatrix.get(0, 0)).toEqual({ v: 'A', s: { fontWeight: 'bold' } });
      expect(newMatrix.get(1, 2)).toEqual({ v: 100, f: '=SUM(A1:A10)' });
    });
  });

  describe('清空操作', () => {
    test('clear 应该清空所有数据', () => {
      matrix.set(0, 0, { v: 'A' });
      matrix.set(1, 1, { v: 'B' });
      
      matrix.clear();
      
      expect(matrix.size).toBe(0);
      expect(matrix.isEmpty()).toBe(true);
      expect(matrix._rows.size).toBe(0);
      expect(matrix._colIndex.size).toBe(0);
    });
  });

  describe('工厂函数', () => {
    test('createSparseMatrix 应该创建新实例', () => {
      const m = createSparseMatrix();
      expect(m).toBeInstanceOf(SparseMatrix);
      expect(m.size).toBe(0);
    });
  });

  describe('性能测试', () => {
    test('大规模数据操作应该高效', () => {
      const start = performance.now();
      
      // 插入 10000 个单元格
      for (let i = 0; i < 10000; i++) {
        matrix.set(i, i, { v: i });
      }
      
      const insertTime = performance.now() - start;
      expect(matrix.size).toBe(10000);
      expect(insertTime).toBeLessThan(500); // 应该在 500ms 内完成
      
      // 查找测试
      const lookupStart = performance.now();
      for (let i = 0; i < 1000; i++) {
        const val = matrix.get(i, i);
        expect(val.v).toBe(i);
      }
      const lookupTime = performance.now() - lookupStart;
      expect(lookupTime).toBeLessThan(500); // 1000 次查找应该在 500ms 内完成（考虑环境波动）
      
      // 行删除测试
      const deleteStart = performance.now();
      matrix.deleteRow(5000);
      const deleteTime = performance.now() - deleteStart;
      expect(matrix.size).toBe(9999);
      expect(deleteTime).toBeLessThan(50); // 单行删除应该在 50ms 内完成
    });
  });
});
