/**
 * SearchEngine 单元测试
 * 测试搜索引擎的查找、替换功能
 */

import { Workbook } from '@/core/Workbook';
import { SearchEngine, parseCellKey } from '@/core/search/Search';


describe('SearchEngine', () => {
  let workbook;
  let searchEngine;

  beforeEach(() => {
    workbook = new Workbook();
    searchEngine = new SearchEngine(workbook);
  });

  afterEach(() => {
    workbook.destroy();
  });

  describe('parseCellKey', () => {
    test('应该解析数字键', () => {
      // 兼容旧数字键格式：(r << 16) | c
      const key = (1 << 16) | 2; // row 1, col 2
      const result = parseCellKey(key);
      expect(result.r).toBe(1);
      expect(result.c).toBe(2);
    });

    test('应该解析超过旧 16 位边界的字符串键', () => {
      const result = parseCellKey('1048575-16383');
      expect(result.r).toBe(1048575);
      expect(result.c).toBe(16383);
    });

    test('应该解析字符串键', () => {
      const result = parseCellKey('3-5');
      expect(result.r).toBe(3);
      expect(result.c).toBe(5);
    });

    test('应该处理无效字符串键', () => {
      const result = parseCellKey('invalid');
      expect(result.r).toBe(-1);
      expect(result.c).toBe(-1);
    });
  });

  describe('基本查找', () => {
    beforeEach(() => {
      // 设置测试数据
      workbook.setCell(0, 0, { v: 'Apple' });
      workbook.setCell(0, 1, { v: 'Banana' });
      workbook.setCell(1, 0, { v: 'Cherry' });
      workbook.setCell(1, 1, { v: 'Apple Pie' });
      workbook.setCell(2, 0, { v: 123 });
      workbook.setCell(2, 1, { v: '123 Main St' });
    });

    test('find 应该查找第一个匹配', () => {
      const result = searchEngine.find('Apple');
      expect(result).not.toBeNull();
      expect(result.r).toBe(0);
      expect(result.c).toBe(0);
    });

    test('find 应该从指定位置开始查找', () => {
      const result = searchEngine.find('Apple', { r: 0, c: 1 });
      expect(result).not.toBeNull();
      expect(result.r).toBe(1);
      expect(result.c).toBe(1);
    });

    test('find 应该返回 null 如果没有匹配', () => {
      const result = searchEngine.find('Orange');
      expect(result).toBeNull();
    });

    test('find 应该返回 null 如果查询为空', () => {
      const result = searchEngine.find('');
      expect(result).toBeNull();
    });

    test('findAll 应该返回所有匹配', () => {
      const results = searchEngine.findAll('Apple');
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ r: 0, c: 0 });
      expect(results[1]).toEqual({ r: 1, c: 1 });
    });

    test('findAll 应该返回空数组如果没有匹配', () => {
      const results = searchEngine.findAll('Orange');
      expect(results).toEqual([]);
    });

    test('find 应该匹配数字值', () => {
      const result = searchEngine.find('123');
      expect(result).not.toBeNull();
      expect(result.r).toBe(2);
      expect(result.c).toBe(0);
    });

    test('find 应该匹配包含数字的字符串', () => {
      const result = searchEngine.find('Main');
      expect(result).not.toBeNull();
      expect(result.r).toBe(2);
      expect(result.c).toBe(1);
    });
  });

  describe('大小写敏感', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'Apple' });
      workbook.setCell(0, 1, { v: 'apple' });
      workbook.setCell(1, 0, { v: 'APPLE' });
    });

    test('默认应该不区分大小写', () => {
      const results = searchEngine.findAll('apple');
      expect(results).toHaveLength(3);
    });

    test('区分大小写应该只匹配精确大小写', () => {
      const results = searchEngine.findAll('apple', { caseSensitive: true });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ r: 0, c: 1 });
    });

    test('区分大小写应该匹配大写', () => {
      const results = searchEngine.findAll('APPLE', { caseSensitive: true });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ r: 1, c: 0 });
    });
  });

  describe('全词匹配', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'apple' });
      workbook.setCell(0, 1, { v: 'apple pie' });
      workbook.setCell(1, 0, { v: 'pineapple' });
      workbook.setCell(1, 1, { v: 'APPLE' });
    });

    test('全词匹配应该只匹配完整单词', () => {
      const results = searchEngine.findAll('apple', { wholeWord: true });
      expect(results).toHaveLength(2); // 'apple' 和 'APPLE'
      expect(results).toContainEqual({ r: 0, c: 0 });
      expect(results).toContainEqual({ r: 1, c: 1 });
    });

    test('非全词匹配应该匹配所有包含的字符串', () => {
      const results = searchEngine.findAll('apple');
      expect(results).toHaveLength(4);
    });
  });

  describe('正则表达式', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'apple' });
      workbook.setCell(0, 1, { v: 'application' });
      workbook.setCell(1, 0, { v: 'banana' });
      workbook.setCell(1, 1, { v: '123' });
      workbook.setCell(2, 0, { v: 'test123test' });
    });

    test('应该支持正则表达式格式 /pattern/', () => {
      const results = searchEngine.findAll('/app/');
      expect(results).toHaveLength(2);
      expect(results).toContainEqual({ r: 0, c: 0 });
      expect(results).toContainEqual({ r: 0, c: 1 });
    });

    test('应该支持正则表达式标志', () => {
      // /app/i 已经默认不区分大小写
      const results = searchEngine.findAll('/APP/');
      expect(results).toHaveLength(2);
    });

    test('应该支持数字正则', () => {
      const results = searchEngine.findAll('/\\d+/');
      expect(results).toHaveLength(2);
    });

    test('无效正则应该作为普通字符串处理', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const results = searchEngine.findAll('/[invalid/');
      // 应该作为普通字符串 "[invalid" 处理，没有匹配
      expect(results).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('循环搜索', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'test' });
      workbook.setCell(1, 0, { v: 'test' });
      workbook.setCell(2, 0, { v: 'other' });
    });

    test('默认应该循环搜索', () => {
      // 从第二个 test 开始搜索，应该循环到第一个
      const result = searchEngine.find('test', { r: 1, c: 1 });
      expect(result).not.toBeNull();
      expect(result.r).toBe(0);
      expect(result.c).toBe(0);
    });

    test('禁用循环搜索应该不循环', () => {
      const result = searchEngine.find('test', { r: 1, c: 1 }, { wrapAround: false });
      expect(result).toBeNull();
    });
  });

  describe('findPrevious', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'first' });
      workbook.setCell(1, 0, { v: 'second' });
      workbook.setCell(2, 0, { v: 'third' });
      workbook.setCell(3, 0, { v: 'second' });
    });

    test('应该向前查找匹配', () => {
      // 从第三行开始向前查找 'second'
      const result = searchEngine.findPrevious('second', { r: 3, c: 0 });
      expect(result).not.toBeNull();
      expect(result.r).toBe(1);
      expect(result.c).toBe(0);
    });

    test('应该循环到末尾', () => {
      // 从第一行开始向前查找 'second'
      const result = searchEngine.findPrevious('second', { r: 0, c: 1 });
      expect(result).not.toBeNull();
      expect(result.r).toBe(3);
      expect(result.c).toBe(0);
    });

    test('没有匹配应该返回 null', () => {
      const result = searchEngine.findPrevious('notfound');
      expect(result).toBeNull();
    });
  });

  describe('countMatches', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'test' });
      workbook.setCell(0, 1, { v: 'test' });
      workbook.setCell(1, 0, { v: 'other' });
    });

    test('应该返回正确的匹配数量', () => {
      expect(searchEngine.countMatches('test')).toBe(2);
      expect(searchEngine.countMatches('other')).toBe(1);
      expect(searchEngine.countMatches('notfound')).toBe(0);
    });
  });

  describe('替换功能', () => {
    beforeEach(() => {
      workbook.setCell(0, 0, { v: 'apple' });
      workbook.setCell(0, 1, { v: 'apple pie' });
      workbook.setCell(1, 0, { v: 'banana' });
      workbook.setCell(1, 1, { v: 'APPLE' });
    });

    describe('replaceAll', () => {
      test('应该替换所有匹配', () => {
        const count = searchEngine.replaceAll('apple', 'orange');
        expect(count).toBe(3); // apple, apple pie, APPLE
        
        expect(workbook.getCellValue(0, 0)).toBe('orange');
        expect(workbook.getCellValue(0, 1)).toBe('orange pie');
        expect(workbook.getCellValue(1, 1)).toBe('orange');
      });

      test('区分大小写替换', () => {
        const count = searchEngine.replaceAll('apple', 'orange', { caseSensitive: true });
        expect(count).toBe(2); // apple, apple pie (不匹配 APPLE)
        
        expect(workbook.getCellValue(0, 0)).toBe('orange');
        expect(workbook.getCellValue(1, 1)).toBe('APPLE');
      });

      test('空查询应该返回 0', () => {
        const count = searchEngine.replaceAll('', 'orange');
        expect(count).toBe(0);
      });

      test('应该支持撤销', () => {
        searchEngine.replaceAll('apple', 'orange');
        workbook.undo();
        
        expect(workbook.getCellValue(0, 0)).toBe('apple');
      });

      test('应该保留单元格样式', () => {
        workbook.setCell(0, 0, { v: 'apple', s: { fontWeight: 'bold' } });
        searchEngine.replaceAll('apple', 'orange');
        
        const cell = workbook.getCell(0, 0);
        expect(cell.v).toBe('orange');
        expect(cell.s.fontWeight).toBe('bold');
      });
    });

    describe('replaceAt', () => {
      test('应该替换指定位置的单元格', () => {
        const result = searchEngine.replaceAt('apple', 'orange', { r: 0, c: 0 });
        expect(result).toBe(true);
        expect(workbook.getCellValue(0, 0)).toBe('orange');
      });

      test('不应该替换不匹配的单元格', () => {
        const result = searchEngine.replaceAt('banana', 'orange', { r: 0, c: 0 });
        expect(result).toBe(false);
        expect(workbook.getCellValue(0, 0)).toBe('apple');
      });

      test('应该返回 false 如果位置无效', () => {
        const result = searchEngine.replaceAt('apple', 'orange', null);
        expect(result).toBe(false);
      });

      test('应该返回 false 如果单元格为空', () => {
        const result = searchEngine.replaceAt('apple', 'orange', { r: 10, c: 10 });
        expect(result).toBe(false);
      });

      test('应该支持正则表达式替换', () => {
        workbook.setCell(0, 0, { v: 'test123test' });
        const result = searchEngine.replaceAt('/\\d+/', 'X', { r: 0, c: 0 });
        expect(result).toBe(true);
        expect(workbook.getCellValue(0, 0)).toBe('testXtest');
      });

      test('应该直接读取目标单元格而不触发 data getter', () => {
        const dataSpy = vi.spyOn(workbook, 'data', 'get');

        try {
          const result = searchEngine.replaceAt('apple', 'orange', { r: 0, c: 0 });

          expect(result).toBe(true);
          expect(workbook.getCellValue(0, 0)).toBe('orange');
          expect(dataSpy).not.toHaveBeenCalled();
        } finally {
          dataSpy.mockRestore();
        }
      });
    });
  });

  describe('索引缓存', () => {
    test('应该缓存索引', () => {
      workbook.setCell(0, 0, { v: 'test' });
      
      // 第一次查找会构建索引
      searchEngine.find('test');
      const cachedVersion = searchEngine.cache.version;
      
      // 第二次查找应该使用缓存
      searchEngine.find('test');
      expect(searchEngine.cache.version).toBe(cachedVersion);
    });

    test('数据变化应该更新索引', () => {
      workbook.setCell(0, 0, { v: 'test' });
      searchEngine.find('test');
      const oldVersion = searchEngine.cache.version;
      
      // 修改数据
      workbook.setCell(1, 0, { v: 'new' });
      
      // 索引应该更新
      searchEngine.find('new');
      expect(searchEngine.cache.version).toBeGreaterThan(oldVersion);
    });

    test('空工作簿应该返回空结果', () => {
      expect(searchEngine.find('test')).toBeNull();
      expect(searchEngine.findAll('test')).toEqual([]);
    });

    test('增量更新：CELL_CHANGE 事件触发后无需全量重建即可命中新值', () => {
      workbook.setCell(0, 0, { v: 'apple' });
      // 触发首次全量构建
      expect(searchEngine.find('apple')).toEqual({ r: 0, c: 0 });
      expect(searchEngine.cache.index.length).toBe(1);

      // 新增单元格 → 应通过事件 patch 进索引
      workbook.setCell(5, 3, { v: 'banana' });
      expect(searchEngine.find('banana')).toEqual({ r: 5, c: 3 });
      expect(searchEngine.cache.index.length).toBe(2);
      // 索引顺序应保持按 (r,c) 升序
      expect(searchEngine.cache.index[0].r).toBe(0);
      expect(searchEngine.cache.index[1].r).toBe(5);
    });

    test('增量更新：单元格删除（newValue 为 null）从索引中移除', () => {
      workbook.setCell(0, 0, { v: 'A' });
      workbook.setCell(1, 0, { v: 'B' });
      // 触发首次构建
      searchEngine.find('A');
      expect(searchEngine.cache.index.length).toBe(2);

      workbook.setCell(0, 0, null);
      // 触发一次 find 让 pending 应用
      expect(searchEngine.find('A')).toBeNull();
      expect(searchEngine.cache.index.length).toBe(1);
      expect(searchEngine.find('B')).toEqual({ r: 1, c: 0 });
    });

    test('增量更新：同一单元格值变化原位 patch', () => {
      workbook.setCell(0, 0, { v: 'before' });
      expect(searchEngine.find('before')).toEqual({ r: 0, c: 0 });
      const lenAfterFirst = searchEngine.cache.index.length;

      workbook.setCell(0, 0, { v: 'after' });
      expect(searchEngine.find('after')).toEqual({ r: 0, c: 0 });
      expect(searchEngine.find('before')).toBeNull();
      expect(searchEngine.cache.index.length).toBe(lenAfterFirst);
    });

    test('STRUCTURE_CHANGE 事件触发全量重建标记', () => {
      workbook.setCell(0, 0, { v: 'x' });
      searchEngine.find('x');
      expect(searchEngine.cache.needsRebuild).toBe(false);

      // 模拟结构性变化
      workbook._events.emit('structure-change', { type: 'structure-change' });
      expect(searchEngine.cache.needsRebuild).toBe(true);

      // 下次查找应触发全量重建
      workbook.setCell(2, 2, { v: 'y' });
      expect(searchEngine.find('y')).toEqual({ r: 2, c: 2 });
      expect(searchEngine.cache.needsRebuild).toBe(false);
    });
  });

  describe('边界情况', () => {
    test('应该处理 null 和 undefined 值', () => {
      workbook.setCell(0, 0, { v: null });
      workbook.setCell(0, 1, { v: undefined });
      workbook.setCell(1, 0, { v: 'test' });
      
      const results = searchEngine.findAll('test');
      expect(results).toHaveLength(1);
    });

    test('应该处理特殊字符', () => {
      workbook.setCell(0, 0, { v: 'test[1]' });
      workbook.setCell(0, 1, { v: 'test(2)' });
      workbook.setCell(1, 0, { v: 'test$3' });
      
      // 特殊字符应该被正确转义
      expect(searchEngine.find('test[1]')).not.toBeNull();
      expect(searchEngine.find('test(2)')).not.toBeNull();
      expect(searchEngine.find('test$3')).not.toBeNull();
    });

    test('应该处理空单元格', () => {
      workbook.setCell(0, 0, { v: '' });
      workbook.setCell(0, 1, { v: 'test' });
      
      const results = searchEngine.findAll('test');
      expect(results).toHaveLength(1);
    });
  });

  describe('性能', () => {
    test('应该使用二分搜索定位起始位置', () => {
      // 创建大量数据
      for (let i = 0; i < 100; i++) {
        workbook.setCell(i, 0, { v: `row${i}` });
      }
      
      // 从中间位置开始搜索
      const start = performance.now();
      const result = searchEngine.find('row99', { r: 50, c: 0 });
      const duration = performance.now() - start;
      
      expect(result).not.toBeNull();
      expect(result.r).toBe(99);
      expect(duration).toBeLessThan(200);
    });

    test('查找热路径不应该重复读取 data getter', () => {
      for (let i = 0; i < 100; i++) {
        workbook.setCell(i, 0, { v: `row${i}` });
      }

      const dataSpy = vi.spyOn(workbook, 'data', 'get');

      try {
        expect(searchEngine.find('row99', { r: 0, c: 0 })).toEqual({ r: 99, c: 0 });
        expect(searchEngine.findAll('row')).toHaveLength(100);
        expect(searchEngine.findPrevious('row98', { r: 99, c: 0 })).toEqual({ r: 98, c: 0 });
        expect(dataSpy).not.toHaveBeenCalled();
      } finally {
        dataSpy.mockRestore();
      }
    });
  });
});
