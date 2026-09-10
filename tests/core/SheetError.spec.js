/**
 * SheetError / ErrorHandler 单元测试
 * 测试错误处理模块的 safeExecute、wrap 及错误创建
 */

import { ErrorHandler, ErrorCodes, SheetError, safeExecute } from '@/core/data/SheetError';

describe('SheetError', () => {
  test('应该创建基本错误', () => {
    const err = new SheetError(ErrorCodes.FORMULA_ERROR, '测试错误');
    expect(err.code).toBe('FORMULA_ERROR');
    expect(err.message).toBe('测试错误');
    expect(err.name).toBe('SheetError');
  });

  test('应该使用默认消息模板', () => {
    const err = new SheetError(ErrorCodes.DIVISION_BY_ZERO);
    expect(err.message).toContain('除数不能为零');
  });

  test('toExcelValue 应该返回 Excel 错误值', () => {
    const err = new SheetError(ErrorCodes.DIVISION_BY_ZERO);
    expect(err.toExcelValue()).toBe('#DIV/0!');
  });

  test('SheetError.isExcelError 应该正确识别错误值', () => {
    expect(SheetError.isExcelError('#DIV/0!')).toBe(true);
    expect(SheetError.isExcelError('#REF!')).toBe(true);
    expect(SheetError.isExcelError('#VALUE!')).toBe(true);
    expect(SheetError.isExcelError('normal text')).toBe(false);
  });
});

describe('ErrorHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new ErrorHandler({ logToConsole: false });
  });

  describe('safeExecute - 同步函数', () => {
    test('正常返回同步值', async () => {
      const result = await handler.safeExecute(() => 42, -1);
      expect(result).toBe(42);
    });

    test('同步 throw 应返回 defaultValue', async () => {
      const result = await handler.safeExecute(
        () => { throw new Error('boom'); },
        'fallback'
      );
      expect(result).toBe('fallback');
    });

    test('同步 throw 应记录错误到历史', async () => {
      await handler.safeExecute(
        () => { throw new Error('boom'); },
        null
      );
      const history = handler.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].error.code).toBe('UNKNOWN_ERROR');
    });
  });

  describe('safeExecute - Promise 函数（原缺陷：返回 Promise 而非 defaultValue）', () => {
    test('Promise reject 应返回 defaultValue 而非 Promise', async () => {
      // 这是缺陷核心场景：传入返回 Promise.reject 的异步逻辑
      const result = await handler.safeExecute(
        () => Promise.reject(new Error('async boom')),
        'safe-default'
      );
      // 修复前：result.catch(() => defaultValue) 返回 Promise 对象
      // 修复后：await 解包，返回同步字符串
      expect(result).toBe('safe-default');
      expect(typeof result).toBe('string');
      // 确保不是 Promise 实例
      expect(result).not.toHaveProperty('then');
    });

    test('Promise resolve 应正常返回', async () => {
      const result = await handler.safeExecute(
        () => Promise.resolve(99),
        -1
      );
      expect(result).toBe(99);
    });

    test('Promise reject 应记录错误', async () => {
      await handler.safeExecute(
        () => Promise.reject(new Error('async fail')),
        null
      );
      const history = handler.getHistory();
      expect(history.length).toBe(1);
    });

    test('Promise reject 后调用方不应拿到 Promise 实例', async () => {
      // 模拟外部调用链条：出错时访问返回值属性不应抛出 TypeError
      const result = await handler.safeExecute(
        () => Promise.reject(new Error('fail')),
        { safe: true }
      );
      // 修复前：result 是 Promise → result.safe 为 undefined → 引起白屏
      // 修复后：result 是 { safe: true }
      expect(result.safe).toBe(true);
    });
  });

  describe('safeExecute - 混合场景', () => {
    test('async fn 中的同步 throw 应被捕获', async () => {
      const result = await handler.safeExecute(
        async () => { throw new Error('sync in async'); },
        'caught'
      );
      expect(result).toBe('caught');
    });

    test('嵌套 Promise rejection 应正确传播到 catch', async () => {
      const result = await handler.safeExecute(
        () => Promise.resolve().then(() => { throw new Error('nested'); }),
        'nested-default'
      );
      expect(result).toBe('nested-default');
    });
  });
});

describe('ErrorHandler.wrap - 同步/异步一致性', () => {
  let handler;

  beforeEach(() => {
    handler = new ErrorHandler({ logToConsole: false });
  });

  test('同步 throw 应被转换为 throw SheetError', async () => {
    const wrapped = handler.wrap(() => { throw new Error('sync err'); });
    await expect(wrapped()).rejects.toBeInstanceOf(SheetError);
  });

  test('Promise reject 应被转换为 throw SheetError', async () => {
    const wrapped = handler.wrap(() => Promise.reject(new Error('async err')));
    await expect(wrapped()).rejects.toBeInstanceOf(SheetError);
  });

  test('正常返回应透传', async () => {
    const wrapped = handler.wrap((x) => x * 2);
    const result = await wrapped(5);
    expect(result).toBe(10);
  });

  test('Promise resolve 应透传', async () => {
    const wrapped = handler.wrap((x) => Promise.resolve(x + 1));
    const result = await wrapped(10);
    expect(result).toBe(11);
  });
});

describe('safeExecute 便捷函数', () => {
  test('导出的 safeExecute 应与 ErrorHandler 一致', async () => {
    // 注意：便捷函数使用的是 defaultErrorHandler，history 可能被污染
    const result = await safeExecute(() => 42, 'fallback');
    expect(result).toBe(42);
  });

  test('便捷函数错误时应返回默认值', async () => {
    const result = await safeExecute(
      () => { throw new Error('test'); },
      'default-value'
    );
    expect(result).toBe('default-value');
  });
});
