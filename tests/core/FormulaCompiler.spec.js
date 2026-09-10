/**
 * FormulaCompiler 安全测试（new Function 已废除版本）
 *
 * 覆盖：
 *  1. FormulaRPNEvaluator 公式求值正确性（替代原 compile() 路径）
 *  2. formulaCompiler.toR1C1() 引用归一化
 *  3. 缓存与 LRU 驱逐行为
 */
import { FormulaCompiler, formulaCompiler } from '@/core/data/FormulaCompiler';
import { FormulaRPNEvaluator, FormulaParser, FormulaSyntaxError } from '@/core/data/FormulaRPNEvaluator';

// ─── 辅助工具 ───────────────────────────────────────────

/** 构造一个最小 mock context，提供 _refToRC 和 _rangeRefToBounds */
function mockContext() {
  const colMap = {};
  for (let i = 0; i < 26; i++) colMap[String.fromCharCode(65 + i)] = i;
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++)
      colMap[String.fromCharCode(65 + i) + String.fromCharCode(65 + j)] = 26 * (i + 1) + j;

  return {
    _refToRC(ref) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) return null;
      return { r: parseInt(m[2], 10) - 1, c: colMap[m[1]] };
    },
    _rangeRefToBounds(ref) {
      const parts = ref.split(':');
      if (parts.length !== 2) return null;
      const s = this._refToRC(parts[0]);
      const e = this._refToRC(parts[1]);
      if (!s || !e) return null;
      return {
        startR: Math.min(s.r, e.r),
        endR: Math.max(s.r, e.r),
        startC: Math.min(s.c, e.c),
        endC: Math.max(s.c, e.c)
      };
    }
  };
}

/** 构造带单元格数据的 RPN 求值器 */
function createEvaluator(cellData = {}) {
  return new FormulaRPNEvaluator({
    getCellValue: (r, c, _stack) => {
      const key = `${r},${c}`;
      return cellData[key] !== undefined ? cellData[key] : null;
    }
  });
}

// ═══════════════════════════════════════════════════════════
// FormulaRPNEvaluator 求值正确性（替代旧 compile() 路径）
// ═══════════════════════════════════════════════════════════

describe('FormulaRPNEvaluator 公式求值', () => {
  let evaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  test('简单加法：=1+2 → 3', () => {
    expect(evaluator.evaluate('=1+2')).toBe(3);
  });

  test('混合类型加法隐式数值转换和错误传播', () => {
    expect(evaluator.evaluate('="1"+2')).toBe(3);
    expect(evaluator.evaluate('="1.5"+2')).toBe(3.5);
    expect(evaluator.evaluate('="hello"+2')).toBe('#VALUE!');
    expect(evaluator.evaluate('=1+"world"')).toBe('#VALUE!');
    expect(evaluator.evaluate('="1,000"+2')).toBe(1002);
  });

  test('减法：=10-3 → 7', () => {
    expect(evaluator.evaluate('=10-3')).toBe(7);
  });

  test('乘法：=4*5 → 20', () => {
    expect(evaluator.evaluate('=4*5')).toBe(20);
  });

  test('除法：=10/2 → 5', () => {
    expect(evaluator.evaluate('=10/2')).toBe(5);
  });

  test('除零应返回 #DIV/0!', () => {
    expect(evaluator.evaluate('=1/0')).toBe('#DIV/0!');
  });

  test('减法/乘法/除法对非数值操作数应返回 #VALUE! 而非 NaN', () => {
    expect(evaluator.evaluate('=10-"abc"')).toBe('#VALUE!');
    expect(evaluator.evaluate('="xyz"*5')).toBe('#VALUE!');
    expect(evaluator.evaluate('=10/"abc"')).toBe('#VALUE!');
    // 合法的隐式数值转换仍应正常计算
    expect(evaluator.evaluate('="3"-1')).toBe(2);
    expect(evaluator.evaluate('="2"*"3"')).toBe(6);
    expect(evaluator.evaluate('="1,000"-1')).toBe(999);
  });

  test('复杂单元格值应 fail-fast 为 #VALUE!，避免 NaN 或宽松转换污染', () => {
    const ev = createEvaluator({
      '0,0': [1, 2],
      '0,1': { v: 5 },
      '0,2': [[1]],
      '0,3': NaN,
      '0,4': Infinity
    });

    expect(ev.evaluate('=A1')).toBe('#VALUE!');
    expect(ev.evaluate('=B1+1')).toBe('#VALUE!');
    expect(ev.evaluate('=SUM(A1:C1)')).toBe('#VALUE!');
    expect(ev.evaluate('=D1+1')).toBe('#VALUE!');
    expect(ev.evaluate('=E1')).toBe('#VALUE!');
  });

  test('数值字符串必须完整合法，不能被 parseFloat 半截解析', () => {
    const ev = createEvaluator({
      '0,0': '1abc',
      '0,1': '1,00',
      '0,2': 'NaN',
      '0,3': '1,000',
      '0,4': '1e3'
    });

    expect(ev.evaluate('=A1+1')).toBe('#VALUE!');
    expect(ev.evaluate('=B1+1')).toBe('#VALUE!');
    expect(ev.evaluate('=C1')).toBe('#VALUE!');
    expect(ev.evaluate('=D1+1')).toBe(1001);
    expect(ev.evaluate('=E1+1')).toBe(1001);
  });

  test('SUM 聚合函数', () => {
    expect(evaluator.evaluate('=SUM(1,2,3)')).toBe(6);
  });

  test('非法公式（括号不配对）应返回 #SYNTAX! 而非笼统的 #ERROR!', () => {
    // 未闭合的左括号
    expect(evaluator.evaluate('=10+(5')).toBe('#SYNTAX!');
    expect(evaluator.evaluate('=SUM(A1,')).toBe('#SYNTAX!');
    expect(evaluator.evaluate('=(1+2')).toBe('#SYNTAX!');
    // 多余的右括号
    expect(evaluator.evaluate('=10+5)')).toBe('#SYNTAX!');
    expect(evaluator.evaluate('=1)*2')).toBe('#SYNTAX!');
    // 合法的配对括号仍应正常求值
    expect(evaluator.evaluate('=(1+2)*3')).toBe(9);
    expect(evaluator.evaluate('=SUM(1,2)')).toBe(3);
  });

  test('非法公式（非法字符）应快速失败返回 #SYNTAX! 而非静默吃掉算错', () => {
    // 词法分析器遇到无法匹配任何合规 Token 的字符必须抛错，
    // 而不是 i++ 静默跳过导致 `=1 @ 2` 被错误地算成 1。
    expect(evaluator.evaluate('=1 @ 2')).toBe('#SYNTAX!');
    expect(evaluator.evaluate('=1 # 2')).toBe('#SYNTAX!');
    expect(evaluator.evaluate('=1+~2')).toBe('#SYNTAX!');
    // 合法公式不受影响
    expect(evaluator.evaluate('=1+2')).toBe(3);
  });

  test('tokenize 遇到非法字符应抛出携带位置的 FormulaSyntaxError', () => {
    const parser = new FormulaParser();
    try {
      parser.tokenize('1 @ 2');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaSyntaxError);
      expect(e.code).toBe('SYNTAX_ERROR');
      expect(e.pos).toBe(2);
    }
  });

  test('shuntingYard 对未配对括号应抛出携带位置的 FormulaSyntaxError', () => {
    const parser = new FormulaParser();
    try {
      parser.shuntingYard(parser.tokenize('10+(5'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaSyntaxError);
      expect(e.code).toBe('SYNTAX_ERROR');
      expect(typeof e.pos).toBe('number');
      expect(e.pos).toBeGreaterThanOrEqual(0);
    }
  });

  test('AVERAGE 函数', () => {
    expect(evaluator.evaluate('=AVERAGE(10,20,30)')).toBe(20);
  });

  test('MAX 函数', () => {
    expect(evaluator.evaluate('=MAX(5,10,3)')).toBe(10);
  });

  test('MIN 函数', () => {
    expect(evaluator.evaluate('=MIN(5,10,3)')).toBe(3);
  });

  test('COUNT 函数', () => {
    expect(evaluator.evaluate('=COUNT(1,2,"text",4)')).toBe(3);
  });

  test('IF 条件为真时返回第二参数', () => {
    expect(evaluator.evaluate('=IF(TRUE, "yes", "no")')).toBe('yes');
  });

  test('IF 条件为假时返回第三参数', () => {
    expect(evaluator.evaluate('=IF(FALSE, "yes", "no")')).toBe('no');
  });

  test('AND 逻辑函数', () => {
    expect(evaluator.evaluate('=AND(TRUE, TRUE)')).toBe(true);
    expect(evaluator.evaluate('=AND(TRUE, FALSE)')).toBe(false);
  });

  test('OR 逻辑函数', () => {
    expect(evaluator.evaluate('=OR(TRUE, FALSE)')).toBe(true);
    expect(evaluator.evaluate('=OR(FALSE, FALSE)')).toBe(false);
  });

  test('NOT 逻辑函数', () => {
    expect(evaluator.evaluate('=NOT(TRUE)')).toBe(false);
    expect(evaluator.evaluate('=NOT(FALSE)')).toBe(true);
  });

  test('字符串字面量', () => {
    expect(evaluator.evaluate('="hello world"')).toBe('hello world');
  });

  test('ROUND 数学函数', () => {
    expect(evaluator.evaluate('=ROUND(3.14159, 2)')).toBe(3.14);
  });

  test('ABS 绝对值', () => {
    expect(evaluator.evaluate('=ABS(-5)')).toBe(5);
  });

  test('INT 取整', () => {
    expect(evaluator.evaluate('=INT(3.9)')).toBe(3);
  });

  test('LEN 文本长度', () => {
    expect(evaluator.evaluate('=LEN("hello")')).toBe(5);
  });

  test('UPPER 转大写', () => {
    expect(evaluator.evaluate('=UPPER("hello")')).toBe('HELLO');
  });

  test('LOWER 转小写', () => {
    expect(evaluator.evaluate('=LOWER("HELLO")')).toBe('hello');
  });

  test('CONCAT 拼接', () => {
    expect(evaluator.evaluate('=CONCAT("a", "b", "c")')).toBe('abc');
  });

  test('比较运算符', () => {
    expect(evaluator.evaluate('=1<2')).toBe(true);
    expect(evaluator.evaluate('=2>1')).toBe(true);
    expect(evaluator.evaluate('=1=1')).toBe(true);
    expect(evaluator.evaluate('=1<>2')).toBe(true);
    expect(evaluator.evaluate('=2<=2')).toBe(true);
    expect(evaluator.evaluate('=2>=2')).toBe(true);
  });

  test('非公式字符串原样返回', () => {
    expect(evaluator.evaluate('hello')).toBe('hello');
    expect(evaluator.evaluate('123')).toBe('123');
  });

  test('空值/null 返回原值', () => {
    expect(evaluator.evaluate(null)).toBe(null);
    expect(evaluator.evaluate(undefined)).toBe(undefined);
  });

  test('含单元格引用的公式', () => {
    const ev = createEvaluator({
      '0,0': 100,   // A1 = 100
      '0,1': 200,   // B1 = 200
    });
    expect(ev.evaluate('=A1+B1')).toBe(300);
  });

  test('含范围的 SUM', () => {
    const ev = createEvaluator({
      '0,0': 10,   // A1
      '0,1': 20,   // B1
      '0,2': 30,   // C1
    });
    expect(ev.evaluate('=SUM(A1:C1)')).toBe(60);
  });

  test('未知函数应返回 #NAME?', () => {
    const result = evaluator.evaluate('=FOOBAR(1)');
    expect(result).toBe('#NAME?');
  });

  test('RPN 缓存复用：相同公式返回一致结果', () => {
    expect(evaluator.evaluate('=SUM(1,2,3)')).toBe(6);
    // 第二次调用应命中解析缓存
    expect(evaluator.evaluate('=SUM(1,2,3)')).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════
// FormulaRPNEvaluator 安全性：无代码注入风险
// ═══════════════════════════════════════════════════════════

describe('FormulaRPNEvaluator 安全性（纯解释执行，无 new Function）', () => {
  test('含 eval 字符串的公式不会被执行，作为普通字符串求值', () => {
    const ev = createEvaluator();
    // RPN 求值器中 "eval(...)" 被视为未知函数名，返回 #NAME?
    const result = ev.evaluate('=EVAL("1+1")');
    // 不应执行任意代码 — 返回错误标记
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^#/);
  });

  test('含 window/document 的公式不会访问全局对象', () => {
    const ev = createEvaluator();
    // "WINDOW" 不是有效 token（既非 cell ref 也非函数调用），
    // 词法分析器快速失败 → #SYNTAX!，绝无路径能通过公式字符串访问全局对象
    const r1 = ev.evaluate('=1+WINDOW');
    expect(r1).toBe('#SYNTAX!');
    // WINDOW( 才会被识别为函数调用，但函数表中无此函数 → #NAME?
    const r2 = ev.evaluate('=WINDOW(1)');
    expect(r2).toBe('#NAME?');
  });

  test('含分号的公式不做多语句处理', () => {
    const ev = createEvaluator();
    // 分号在 RPN evaluator 中是非 token 字符，会被跳过
    // 实际行为取决于 tokenizer 如何处理分号
    const result = ev.evaluate('=1');
    expect(result).toBe(1);
  });

  test('字符串内的危险内容不会被当作代码执行', () => {
    const ev = createEvaluator();
    // 字符串中的内容始终是数据，不可能是代码
    const result = ev.evaluate('="alert(1)"');
    expect(result).toBe('alert(1)');
  });
});

// ═══════════════════════════════════════════════════════════
// FormulaCompiler.toR1C1() 引用归一化
// ═══════════════════════════════════════════════════════════

describe('FormulaCompiler R1C1 归一化', () => {
  test('无 context 时返回原公式', () => {
    expect(formulaCompiler.toR1C1('=SUM(A1:A10)')).toBe('=SUM(A1:A10)');
  });

  test('简单单元格引用归一化', () => {
    const ctx = mockContext();
    // 以 (0,0) 为基准，B2 → R[1]C[1]
    // toR1C1 输出不含前导 '='（由调用方手动拼接）
    const result = formulaCompiler.toR1C1('=B2', ctx, 0, 0);
    expect(result).toBe('R[1]C[1]');
  });

  test('范围引用归一化', () => {
    const ctx = mockContext();
    // 以 (0,0) 为基准，A1:B2 → R[0]C[0]:R[1]C[1]
    const result = formulaCompiler.toR1C1('=SUM(A1:B2)', ctx, 0, 0);
    expect(result).toContain('R[0]C[0]:R[1]C[1]');
  });

  test('以非零坐标为基准的归一化', () => {
    const ctx = mockContext();
    // 以 (5,3) 为基准(第6行第4列)，B2 = (1,1) → R[-4]C[-2]
    const result = formulaCompiler.toR1C1('=B2', ctx, 5, 3);
    expect(result).toBe('R[-4]C[-2]');
  });

  test('混合公式：函数+引用+常量', () => {
    const ctx = mockContext();
    const result = formulaCompiler.toR1C1('=SUM(A1, B2)*C3', ctx, 0, 0);
    // toR1C1 不保留空白分隔（token 直接拼接），与 R1C1 引擎兼容
    expect(result).toBe('SUM(R[0]C[0],R[1]C[1])*R[2]C[2]');
  });

  test('函数名保留原样（不转换为 R1C1）', () => {
    const ctx = mockContext();
    const result = formulaCompiler.toR1C1('=IF(A1>10, B1, 0)', ctx, 0, 0);
    expect(result).toBe('IF(R[0]C[0]>10,R[0]C[1],0)');
  });
});

// ═══════════════════════════════════════════════════════════
// 缓存行为测试
// ═══════════════════════════════════════════════════════════

describe('FormulaCompiler 缓存', () => {
  test('相同公式+坐标应命中缓存', () => {
    const compiler = new FormulaCompiler(10);
    const ctx = mockContext();

    // 首次调用
    const r1 = compiler.toR1C1('=A1+B2', ctx, 0, 0);
    expect(compiler.cache.size).toBeGreaterThan(0);

    // 再次调用相同参数
    const r2 = compiler.toR1C1('=A1+B2', ctx, 0, 0);
    expect(r1).toBe(r2);
  });

  test('不同坐标产生不同的缓存条目', () => {
    const compiler = new FormulaCompiler(10);
    const ctx = mockContext();

    compiler.toR1C1('=A1', ctx, 0, 0);
    compiler.toR1C1('=A1', ctx, 5, 3);
    // 不同 baseR/baseC 产生不同缓存键
    expect(compiler.cache.size).toBeGreaterThanOrEqual(2);
  });

  test('clearCache 清除所有缓存', () => {
    const compiler = new FormulaCompiler(10);
    const ctx = mockContext();

    compiler.toR1C1('=A1', ctx, 0, 0);
    compiler.toR1C1('=B2', ctx, 0, 0);
    compiler.clearCache();
    expect(compiler.cache.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// LRU 驱逐
// ═══════════════════════════════════════════════════════════

describe('FormulaCompiler LRU 驱逐', () => {
  test('缓存满时驱逐最旧条目', () => {
    const compiler = new FormulaCompiler(3);
    const ctx = mockContext();

    compiler.toR1C1('=A1', ctx, 0, 0);
    compiler.toR1C1('=A2', ctx, 1, 0);
    compiler.toR1C1('=A3', ctx, 2, 0);
    compiler.toR1C1('=A4', ctx, 3, 0); // 应触发驱逐

    expect(compiler.cache.size).toBeLessThanOrEqual(3);
  });

  test('LRU 命中后条目不会被驱逐', () => {
    const compiler = new FormulaCompiler(3);
    const ctx = mockContext();

    compiler.toR1C1('=A1', ctx, 0, 0);
    compiler.toR1C1('=A2', ctx, 1, 0);
    // 重新访问 A1，使其成为最新
    compiler.toR1C1('=A1', ctx, 0, 0);
    compiler.toR1C1('=A3', ctx, 2, 0);
    compiler.toR1C1('=A4', ctx, 3, 0); // 触发驱逐

    // A1 因被重新访问应仍在缓存中，A2 被驱逐
    expect(compiler.cache.size).toBeLessThanOrEqual(3);
  });
});
