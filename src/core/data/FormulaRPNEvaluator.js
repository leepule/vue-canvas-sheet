/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 *
 * 共享公式 RPN 求值器
 *
 * 从 formula.worker.js 中提取，作为主线程与 Worker 线程共用的单一 JS 公式引擎。
 * 消除原先主线程 FormulaCompiler (new Function) 与 Worker RPN 解释器双轨实现
 * 导致的类型强制、边界值处理、错误传播等行为差异。
 *
 * 用法：
 *   const evaluator = new FormulaRPNEvaluator({
 *     getCellValue: (r, c, stack) => workbook.formulaEvaluator.getCellValue(r, c)
 *   });
 *   const result = evaluator.evaluate('=SUM(A1:A10)', { stack: [] });
 */

import { cellKey, parseCellKey } from './CellKey.js';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

const PATTERNS = [
  { type: 'fn',      regex: /[A-Z]+(?=\()/y },
  { type: 'range',   regex: /[A-Z]+[0-9]+:[A-Z]+[0-9]+/y },
  { type: 'cell',    regex: /[A-Z]+[0-9]+/y },
  { type: 'string',  regex: /"([^"]*)"/y },
  { type: 'boolean', regex: /(TRUE|FALSE)(?![A-Z0-9])/iy },
  { type: 'number',  regex: /\d+(\.\d+)?/y },
  { type: 'op',      regex: /[\+\-\*\/]/y },
  { type: 'compare', regex: /(<>|<=|>=|[<>=])/y },
  { type: 'lparen',  regex: /\(/y },
  { type: 'rparen',  regex: /\)/y },
  { type: 'comma',   regex: /,/y },
  { type: 'ws',      regex: /\s+/y }
];

const PRECEDENCE = {
  '+': 1, '-': 1,
  '*': 2, '/': 2,
  '=': 0, '<': 0, '>': 0, '<=': 0, '>=': 0, '<>': 0
};

const FUNCTION_TYPES = {
  AGGREGATE: ['SUM', 'AVERAGE', 'MAX', 'MIN', 'COUNT', 'COUNTA'],
  MATH:      ['ROUND', 'ABS', 'INT', 'MOD', 'POWER', 'SQRT', 'CEILING', 'FLOOR'],
  TEXT:      ['CONCAT', 'LEFT', 'RIGHT', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'SUBSTITUTE'],
  LOGIC:     ['IF', 'AND', 'OR', 'NOT'],
  DATE:      ['TODAY', 'NOW', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DATE', 'DATEDIF']
};

const ErrorCodes = {
  FORMULA_ERROR:      'FORMULA_ERROR',
  DIVISION_BY_ZERO:   'DIVISION_BY_ZERO',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
  UNKNOWN_FUNCTION:   'UNKNOWN_FUNCTION',
  INVALID_ARGUMENT:   'INVALID_ARGUMENT',
  VALUE_ERROR:        'VALUE_ERROR',
  NUM_ERROR:          'NUM_ERROR',
  SYNTAX_ERROR:       'SYNTAX_ERROR'
};

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function createError(code) {
  const map = {
    [ErrorCodes.DIVISION_BY_ZERO]:   '#DIV/0!',
    [ErrorCodes.CIRCULAR_REFERENCE]: '#CYCLE!',
    [ErrorCodes.UNKNOWN_FUNCTION]:   '#NAME?',
    [ErrorCodes.INVALID_ARGUMENT]:   '#VALUE!',
    [ErrorCodes.NUM_ERROR]:          '#NUM!',
    [ErrorCodes.FORMULA_ERROR]:      '#ERROR!',
    [ErrorCodes.VALUE_ERROR]:        '#VALUE!',
    [ErrorCodes.SYNTAX_ERROR]:       '#SYNTAX!'
  };
  return map[code] || '#ERROR!';
}

/**
 * 公式语法解析异常
 *
 * 在调度场算法（shuntingYard）阶段检测到非法语法（如未闭合/多余的括号）时抛出，
 * 携带错误码与出错位置，便于 evaluate 拦截后返回精确的 #SYNTAX! 而非笼统的 #ERROR!。
 */
class FormulaSyntaxError extends Error {
  /**
   * @param {string} message 错误描述
   * @param {number} [pos=-1] 出错 token 在表达式中的字符位置（不含前导 '='）
   */
  constructor(message, pos = -1) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.code = ErrorCodes.SYNTAX_ERROR;
    this.pos = pos;
  }
}

function colStrToIndex(str) {
  let val = 0;
  for (let i = 0; i < str.length; i++) {
    val *= 26;
    val += str.charCodeAt(i) - 64;
  }
  return val - 1;
}

function indexToColStr(index) {
  let str = '';
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    str = String.fromCharCode(65 + m) + str;
    n = Math.floor((n - m) / 26);
  }
  return str;
}

function refToRC(ref) {
  const letter = ref.match(/[A-Z]+/)[0];
  const num    = ref.match(/[0-9]+/)[0];
  return {
    r: parseInt(num, 10) - 1,
    c: colStrToIndex(letter)
  };
}

function rangeToRC(range) {
  const parts = range.split(':');
  return { start: refToRC(parts[0]), end: refToRC(parts[1]) };
}

// ═══════════════════════════════════════════════════════════
// 公式解析器（词法分析 + 调度场 → RPN）
// ═══════════════════════════════════════════════════════════

const MAX_RPN_CACHE = 500;

class FormulaParser {
  constructor() {
    this.rpnCache = new Map();
  }

  tokenize(expr) {
    const tokens = [];
    let i = 0;
    const len = expr.length;

    while (i < len) {
      let matched = false;
      const start = i;
      for (let j = 0; j < PATTERNS.length; j++) {
        const { type, regex } = PATTERNS[j];
        regex.lastIndex = i;
        const match = regex.exec(expr);
        if (match) {
          if (type !== 'ws') {
            if (type === 'string') {
              tokens.push({ type, value: match[1] !== undefined ? match[1] : match[0], pos: start });
            } else if (type === 'boolean') {
              tokens.push({ type, value: match[0].toUpperCase(), pos: start });
            } else {
              tokens.push({ type, value: match[0], pos: start });
            }
          }
          i = regex.lastIndex;
          matched = true;
          break;
        }
      }
      if (!matched) {
        throw new FormulaSyntaxError(`Unexpected character "${expr[i]}"`, i);
      }
    }
    return tokens;
  }

  shuntingYard(tokens) {
    const output = [];
    const ops    = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      if (t.type === 'number' || t.type === 'cell' || t.type === 'range' ||
          t.type === 'string' || t.type === 'boolean') {
        output.push(t);
      } else if (t.type === 'fn') {
        t.value = t.value.toUpperCase();
        ops.push(t);
      } else if (t.type === 'comma') {
        while (ops.length && ops[ops.length - 1].type !== 'lparen') {
          output.push(ops.pop());
        }
      } else if (t.type === 'op' || t.type === 'compare') {
        while (ops.length) {
          const top = ops[ops.length - 1];
          if ((top.type === 'op' || top.type === 'compare') &&
              PRECEDENCE[top.value] >= PRECEDENCE[t.value]) {
            output.push(ops.pop());
          } else { break; }
        }
        ops.push(t);
      } else if (t.type === 'lparen') {
        ops.push(t);
      } else if (t.type === 'rparen') {
        while (ops.length && ops[ops.length - 1].type !== 'lparen') {
          output.push(ops.pop());
        }
        if (!ops.length) {
          // 多余的右括号：栈中找不到与之匹配的左括号
          throw new FormulaSyntaxError('Unmatched closing parenthesis', t.pos);
        }
        ops.pop(); // 弹出匹配的 lparen
        if (ops.length && ops[ops.length - 1].type === 'fn') {
          output.push(ops.pop());
        }
      }
    }

    while (ops.length) {
      const top = ops.pop();
      if (top.type === 'lparen') {
        // 未闭合的左括号：循环结束后栈内仍残留左括号
        throw new FormulaSyntaxError('Unclosed parenthesis', top.pos);
      }
      output.push(top);
    }
    return output;
  }

  parse(formula) {
    if (!formula || !formula.startsWith('=')) return null;
    const expr = formula.substring(1);
    const key  = expr.toUpperCase();

    if (this.rpnCache.has(key)) {
      const rpn = this.rpnCache.get(key);
      this.rpnCache.delete(key);
      this.rpnCache.set(key, rpn);
      return rpn;
    }

    const tokens = this.tokenize(expr);
    if (!tokens.length) return null;

    const rpn = this.shuntingYard(tokens);
    if (this.rpnCache.size >= MAX_RPN_CACHE) {
      this.rpnCache.delete(this.rpnCache.keys().next().value);
    }
    this.rpnCache.set(key, rpn);
    return rpn;
  }

  getDependencies(formula) {
    if (!formula || !formula.startsWith('=')) return new Set();
    const expr   = formula.substring(1).toUpperCase();
    const tokens = this.tokenize(expr);
    const deps   = new Set();

    for (const t of tokens) {
      if (t.type === 'cell') {
        const { r, c } = refToRC(t.value);
        deps.add(cellKey(r, c));
      } else if (t.type === 'range') {
        const { start, end } = rangeToRC(t.value);
        for (let i = Math.min(start.r, end.r); i <= Math.max(start.r, end.r); i++) {
          for (let j = Math.min(start.c, end.c); j <= Math.max(start.c, end.c); j++) {
            deps.add(cellKey(i, j));
          }
        }
      }
    }
    return deps;
  }
}

// ═══════════════════════════════════════════════════════════
// 共享公式求值器
// ═══════════════════════════════════════════════════════════

const REF_RANGE_TYPE = 'REF_RANGE';
const STRICT_NUMERIC_STRING_RE = /^[+-]?(?:(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?)|\.\d+)(?:e[+-]?\d+)?$/i;

function parseStrictNumericString(value) {
  const text = String(value).trim();
  if (!text || !STRICT_NUMERIC_STRING_RE.test(text)) {
    return { ok: false, value: null };
  }
  const num = Number(text.replace(/,/g, ''));
  return Number.isFinite(num)
    ? { ok: true, value: num }
    : { ok: false, value: null };
}

function isFormulaErrorValue(value) {
  return typeof value === 'string' && value.startsWith('#');
}

export class FormulaRPNEvaluator {
  /**
   * @param {Object} options
   * @param {Function} options.getCellValue — (r: number, c: number, stack: string[]) => any
   *   主线程: (r, c, stack) => formulaEvaluator.getCellValue(r, c, stack)
   *   Worker: 内部通过 dataProvider(key, stack) 桥接
   */
  constructor(options = {}) {
    this._getCellValue = options.getCellValue || (() => null);
    this.parser = new FormulaParser();
  }

  // ─── 单元格访问 ─────────────────────────────────────────

  _getCell(r, c, stack = []) {
    const key = cellKey(r, c);
    if (stack.includes(key)) throw new Error('#CYCLE!');
    return this._getCellValue(r, c, stack);
  }

  // ─── 值解析 ─────────────────────────────────────────────

  _parseCellValue(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'number') {
      return Number.isFinite(val) ? val : createError(ErrorCodes.VALUE_ERROR);
    }
    if (typeof val === 'boolean') return val;
    if (typeof val !== 'string') return createError(ErrorCodes.VALUE_ERROR);

    const str = val.trim();
    if (!str) return '';
    if (isFormulaErrorValue(str)) return str;
    if (/^[+-]?(?:NaN|Infinity)$/i.test(str)) return createError(ErrorCodes.VALUE_ERROR);

    const numeric = parseStrictNumericString(str);
    return numeric.ok ? numeric.value : val;
  }

  _resolveToScalar(val, context) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
    if (val && typeof val === 'object' && val.type === REF_RANGE_TYPE) {
      let first = null, found = false;
      this._iterateRange(val.ref, context, (v) => {
        if (!found) { first = this._parseCellValue(v); found = true; }
      });
      return first !== null ? first : 0;
    }
    return createError(ErrorCodes.VALUE_ERROR);
  }

  _toCalculationNumber(val) {
    if (isFormulaErrorValue(val)) return { ok: false, error: val };
    if (typeof val === 'number') {
      return Number.isFinite(val)
        ? { ok: true, value: val }
        : { ok: false, error: createError(ErrorCodes.VALUE_ERROR) };
    }
    if (typeof val === 'boolean') return { ok: true, value: Number(val) };
    if (typeof val === 'string') {
      const numeric = parseStrictNumericString(val);
      return numeric.ok
        ? { ok: true, value: numeric.value }
        : { ok: false, error: createError(ErrorCodes.VALUE_ERROR) };
    }
    return { ok: false, error: createError(ErrorCodes.VALUE_ERROR) };
  }

  _toAggregateNumber(val) {
    if (isFormulaErrorValue(val)) return { ok: false, error: val };
    if (typeof val === 'number') {
      return Number.isFinite(val)
        ? { ok: true, value: val }
        : { ok: false, error: createError(ErrorCodes.VALUE_ERROR) };
    }
    if (typeof val === 'string') {
      const numeric = parseStrictNumericString(val);
      return numeric.ok
        ? { ok: true, value: numeric.value }
        : { ok: false, ignored: true };
    }
    if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
      return { ok: false, ignored: true };
    }
    return { ok: false, error: createError(ErrorCodes.VALUE_ERROR) };
  }

  _iterateRange(rangeRef, context, callback) {
    const { start, end } = rangeToRC(rangeRef);
    const sr = Math.min(start.r, end.r), er = Math.max(start.r, end.r);
    const sc = Math.min(start.c, end.c), ec = Math.max(start.c, end.c);
    const stack = context?.stack || [];
    for (let i = sr; i <= er; i++)
      for (let j = sc; j <= ec; j++)
        callback(this._getCell(i, j, stack));
  }

  _collectArgs(stack) {
    const args = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top && typeof top === 'object' && top.type === 'ARGS') { stack.pop(); break; }
      args.push(stack.pop());
    }
    args.reverse();
    return args;
  }

  // ─── 比较 ───────────────────────────────────────────────

  _compare(a, b, op) {
    if (typeof a === 'string' && typeof b === 'string') {
      a = a.toLowerCase(); b = b.toLowerCase();
    }
    switch (op) {
      case '=':  return a === b;
      case '<>': return a !== b;
      case '<':  return a < b;
      case '>':  return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default:   return false;
    }
  }

  // ─── 函数调度 ───────────────────────────────────────────

  _evalFunction(name, args, context) {
    if (FUNCTION_TYPES.AGGREGATE.includes(name)) return this._evalAggregate(name, args, context);
    if (FUNCTION_TYPES.MATH.includes(name))      return this._evalMath(name, args, context);
    if (FUNCTION_TYPES.TEXT.includes(name))      return this._evalText(name, args, context);
    if (FUNCTION_TYPES.LOGIC.includes(name))     return this._evalLogic(name, args, context);
    if (FUNCTION_TYPES.DATE.includes(name))      return this._evalDate(name, args, context);
    return createError(ErrorCodes.UNKNOWN_FUNCTION);
  }

  // ─── 聚合函数 ───────────────────────────────────────────

  _evalAggregate(name, args, context) {
    let result = 0, count = 0, min = Infinity, max = -Infinity, countA = 0;
    let aggregateError = null;

    const processNumeric = (n) => {
      if (name === 'SUM' || name === 'AVERAGE') result += n;
      if (name === 'MAX') max = Math.max(max, n);
      if (name === 'MIN') min = Math.min(min, n);
      count++;
    };

    const consumeValue = (val, { fromRange = false } = {}) => {
      const value = fromRange ? this._parseCellValue(val) : val;
      const numeric = this._toAggregateNumber(value);
      if (numeric.ok) {
        processNumeric(numeric.value);
      } else if (numeric.error && !aggregateError) {
        aggregateError = numeric.error;
      }

      if (value !== null && value !== undefined && value !== '') countA++;
    };

    const processRange = (rangeRef) => {
      this._iterateRange(rangeRef, context, (val) => {
        consumeValue(val, { fromRange: true });
      });
    };

    for (const arg of args) {
      if (arg && typeof arg === 'object' && arg.type === REF_RANGE_TYPE) processRange(arg.ref);
      else consumeValue(arg);
    }

    if (aggregateError) return aggregateError;

    switch (name) {
      case 'SUM':     return result;
      case 'AVERAGE': return count === 0 ? createError(ErrorCodes.DIVISION_BY_ZERO) : result / count;
      case 'MAX':     return count === 0 ? 0 : max;
      case 'MIN':     return count === 0 ? 0 : min;
      case 'COUNT':   return count;
      case 'COUNTA':  return countA;
      default:        return 0;
    }
  }

  // ─── 数学函数 ───────────────────────────────────────────

  _evalMath(name, args, context) {
    if (!args.length) return createError(ErrorCodes.INVALID_ARGUMENT);

    const getNum = (arg) => {
      if (arg && typeof arg === 'object' && arg.type === REF_RANGE_TYPE) {
        arg = this._resolveToScalar(arg, context);
      }
      if (typeof arg === 'string' && arg.startsWith('#')) throw new Error(arg);
      const numeric = this._toCalculationNumber(arg);
      if (!numeric.ok) throw new Error(numeric.error || `Cannot convert "${arg}" to number`);
      return numeric.value;
    };

    try {
      switch (name) {
        case 'ROUND': {
          const num    = getNum(args[0]);
          const digits = args.length > 1 ? Math.floor(getNum(args[1])) : 0;
          return Math.round(num * Math.pow(10, digits)) / Math.pow(10, digits);
        }
        case 'ABS':    return Math.abs(getNum(args[0]));
        case 'INT':    return Math.floor(getNum(args[0]));
        case 'MOD': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]), div = getNum(args[1]);
          if (div === 0) return createError(ErrorCodes.DIVISION_BY_ZERO);
          return num - div * Math.floor(num / div);
        }
        case 'POWER': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          return Math.pow(getNum(args[0]), getNum(args[1]));
        }
        case 'SQRT': {
          const n = getNum(args[0]);
          return n < 0 ? createError(ErrorCodes.NUM_ERROR) : Math.sqrt(n);
        }
        case 'CEILING': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]), sig = getNum(args[1]);
          return sig === 0 ? 0 : Math.ceil(num / sig) * sig;
        }
        case 'FLOOR': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]), sig = getNum(args[1]);
          return sig === 0 ? 0 : Math.floor(num / sig) * sig;
        }
        default: return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  // ─── 文本函数 ───────────────────────────────────────────

  _evalText(name, args, context) {
    const getStr = (arg) => {
      if (arg && typeof arg === 'object' && arg.type === REF_RANGE_TYPE) arg = this._resolveToScalar(arg, context);
      if (typeof arg === 'string' && arg.startsWith('#')) throw new Error(arg);
      return String(arg ?? '');
    };

    try {
      switch (name) {
        case 'CONCAT': return args.map(a => getStr(a)).join('');
        case 'LEFT': {
          const s = getStr(args[0]);
          const n = args.length > 1 ? Math.floor(parseFloat(args[1]) || 0) : 1;
          return s.substring(0, Math.max(0, n));
        }
        case 'RIGHT': {
          const s = getStr(args[0]);
          const n = args.length > 1 ? Math.floor(parseFloat(args[1]) || 0) : 1;
          return s.substring(Math.max(0, s.length - n));
        }
        case 'LEN':   return getStr(args[0]).length;
        case 'UPPER': return getStr(args[0]).toUpperCase();
        case 'LOWER': return getStr(args[0]).toLowerCase();
        case 'TRIM':  return getStr(args[0]).trim();
        case 'SUBSTITUTE': {
          const text = getStr(args[0]), oldT = getStr(args[1]), newT = getStr(args[2]);
          const inst = args.length > 3 ? Math.floor(parseFloat(args[3]) || 0) : 0;
          if (inst === 0) return text.split(oldT).join(newT);
          let cnt = 0, res = '';
          for (let i = 0; i < text.length; i++) {
            if (text.substring(i, i + oldT.length) === oldT) {
              if (++cnt === inst) { res += newT; i += oldT.length - 1; continue; }
            }
            res += text[i];
          }
          return res;
        }
        default: return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  // ─── 逻辑函数 ───────────────────────────────────────────

  _toBool(val) {
    if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number')  return val !== 0;
    if (typeof val === 'string') {
      const u = val.toUpperCase();
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      return val !== '';
    }
    return Boolean(val);
  }

  _evalLogic(name, args, context) {
    try {
      switch (name) {
        case 'IF':
          return args.length < 2
            ? createError(ErrorCodes.VALUE_ERROR)
            : (this._toBool(args[0]) ? args[1] : (args.length > 2 ? args[2] : false));
        case 'AND': return args.every(a => this._toBool(a));
        case 'OR':  return args.some(a => this._toBool(a));
        case 'NOT': return !this._toBool(args[0]);
        default:    return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  // ─── 日期函数 ───────────────────────────────────────────

  _evalDate(name, args, context) {
    const parseDate = (val) => {
      if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
      if (val instanceof Date) return val;
      if (typeof val === 'number') return new Date((val - 25569) * 86400 * 1000);
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };
    const toExcelDate = (d) => Math.floor(d.getTime() / 86400000 + 25569);

    try {
      switch (name) {
        case 'TODAY': {
          const now = new Date();
          return toExcelDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        }
        case 'NOW': {
          const now = new Date();
          return toExcelDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
               + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
        }
        case 'YEAR':  { const d = parseDate(args[0]); return d ? d.getFullYear() : createError(ErrorCodes.VALUE_ERROR); }
        case 'MONTH': { const d = parseDate(args[0]); return d ? d.getMonth() + 1  : createError(ErrorCodes.VALUE_ERROR); }
        case 'DAY':   { const d = parseDate(args[0]); return d ? d.getDate()      : createError(ErrorCodes.VALUE_ERROR); }
        case 'HOUR':  { const d = parseDate(args[0]); return d ? d.getHours()     : createError(ErrorCodes.VALUE_ERROR); }
        case 'MINUTE':{ const d = parseDate(args[0]); return d ? d.getMinutes()   : createError(ErrorCodes.VALUE_ERROR); }
        case 'SECOND':{ const d = parseDate(args[0]); return d ? d.getSeconds()   : createError(ErrorCodes.VALUE_ERROR); }
        case 'DATE':
          return args.length < 3 ? createError(ErrorCodes.VALUE_ERROR)
            : toExcelDate(new Date(
                Math.floor(parseFloat(args[0]) || 0),
                Math.floor(parseFloat(args[1]) || 0) - 1,
                Math.floor(parseFloat(args[2]) || 0)));
        case 'DATEDIF': {
          if (args.length < 3) return createError(ErrorCodes.VALUE_ERROR);
          const sd = parseDate(args[0]), ed = parseDate(args[1]);
          if (!sd || !ed) return createError(ErrorCodes.VALUE_ERROR);
          const unit = String(args[2]).toUpperCase();
          switch (unit) {
            case 'Y': {
              let y = ed.getFullYear() - sd.getFullYear();
              if (ed.getMonth() < sd.getMonth() || (ed.getMonth() === sd.getMonth() && ed.getDate() < sd.getDate())) y--;
              return y;
            }
            case 'M': {
              let m = (ed.getFullYear() - sd.getFullYear()) * 12 + ed.getMonth() - sd.getMonth();
              if (ed.getDate() < sd.getDate()) m--;
              return m;
            }
            case 'D': return Math.floor((ed - sd) / 86400000);
            case 'YM': {
              let m = ed.getMonth() - sd.getMonth();
              if (ed.getDate() < sd.getDate()) m--;
              return m < 0 ? m + 12 : m;
            }
            case 'YD': {
              const s = new Date(sd), e = new Date(ed);
              s.setFullYear(ed.getFullYear());
              if (s > e) s.setFullYear(ed.getFullYear() - 1);
              return Math.floor((e - s) / 86400000);
            }
            case 'MD': {
              let d = ed.getDate() - sd.getDate();
              return d < 0 ? d + 32 : d;
            }
            default: return createError(ErrorCodes.VALUE_ERROR);
          }
        }
        default: return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  // ─── RPN 求值 ───────────────────────────────────────────

  evaluateRPN(rpn, context) {
    const stack = [];

    for (let i = 0; i < rpn.length; i++) {
      const t = rpn[i];

      if (t.type === 'number') {
        stack.push(parseFloat(t.value) || 0);
      } else if (t.type === 'string') {
        stack.push(t.value);
      } else if (t.type === 'boolean') {
        stack.push(t.value === 'TRUE');
      } else if (t.type === 'cell') {
        const { r, c } = refToRC(t.value);
        stack.push(this._parseCellValue(this._getCell(r, c, context?.stack || [])));
      } else if (t.type === 'range') {
        stack.push({ type: REF_RANGE_TYPE, ref: t.value.toUpperCase() });
      } else if (t.type === 'op') {
        const b = this._resolveToScalar(stack.pop(), context);
        const a = this._resolveToScalar(stack.pop(), context);
        if (typeof a === 'string' && a.startsWith('#')) { stack.push(a); continue; }
        if (typeof b === 'string' && b.startsWith('#')) { stack.push(b); continue; }

        const op = t.value;
        // 四则运算前统一做数值转换与 NaN 校验：任一操作数无法转为数值（如 "abc"）
        // 时返回 Excel 标准的 #VALUE! 错误，避免 NaN 沿计算链污染广播。
        const numA = this._toCalculationNumber(a);
        const numB = this._toCalculationNumber(b);
        if (!numA.ok || !numB.ok) {
          stack.push(createError(ErrorCodes.VALUE_ERROR));
        } else if (op === '+') {
          stack.push(numA.value + numB.value);
        } else if (op === '-') {
          stack.push(numA.value - numB.value);
        } else if (op === '*') {
          stack.push(numA.value * numB.value);
        } else if (op === '/') {
          stack.push(numB.value === 0 ? createError(ErrorCodes.DIVISION_BY_ZERO) : numA.value / numB.value);
        }
      } else if (t.type === 'compare') {
        const b = this._resolveToScalar(stack.pop(), context);
        const a = this._resolveToScalar(stack.pop(), context);
        if (typeof a === 'string' && a.startsWith('#')) { stack.push(a); continue; }
        if (typeof b === 'string' && b.startsWith('#')) { stack.push(b); continue; }
        stack.push(this._compare(a, b, t.value));
      } else if (t.type === 'fn') {
        stack.push(this._evalFunction(t.value, this._collectArgs(stack), context));
      }
    }

    if (!stack.length) return createError(ErrorCodes.FORMULA_ERROR);
    const final = stack[0];
    if (final && typeof final === 'object' && final.type === REF_RANGE_TYPE) {
      return this._resolveToScalar(final, context);
    }
    return final;
  }

  // ─── 公开 API ───────────────────────────────────────────

  /**
   * 解析公式为 RPN 数组（可缓存复用）
   */
  parse(formula) {
    return this.parser.parse(formula);
  }

  /**
   * 提取公式依赖
   */
  getDependencies(formula) {
    return this.parser.getDependencies(formula);
  }

  /**
   * 求值公式
   * @param {string} formula  — 以 '=' 开头的公式字符串
   * @param {Object} [context]
   * @param {string[]} [context.stack]  — 循环引用检测栈
   * @returns {*} 计算结果或错误字符串
   */
  evaluate(formula, context = {}) {
    if (!formula || !formula.startsWith('=')) return formula;
    try {
      const rpn = this.parser.parse(formula);
      if (!rpn) return createError(ErrorCodes.FORMULA_ERROR);
      return this.evaluateRPN(rpn, context);
    } catch (e) {
      // 语法解析异常（括号不配对等）→ 返回精确的 #SYNTAX!，便于用户定位输入错误
      if (e instanceof FormulaSyntaxError || e.code === ErrorCodes.SYNTAX_ERROR) {
        return createError(ErrorCodes.SYNTAX_ERROR);
      }
      if (e.message === '#CYCLE!') return createError(ErrorCodes.CIRCULAR_REFERENCE);
      return createError(ErrorCodes.FORMULA_ERROR);
    }
  }
}

// ─── 便捷导出 ─────────────────────────────────────────────

export { FormulaParser, ErrorCodes, FUNCTION_TYPES, PATTERNS, PRECEDENCE,
         colStrToIndex, indexToColStr, refToRC, rangeToRC, createError, FormulaSyntaxError };
export default FormulaRPNEvaluator;
