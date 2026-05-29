/**
 * 公式计算 Web Worker
 *
 * 在后台线程中执行公式计算，避免阻塞主线程 UI
 *
 * 支持的操作：
 * - 'evaluate': 计算单个公式
 * - 'evaluateBatch': 批量计算多个公式
 * - 'recalcAll': 重新计算所有公式（带拓扑排序）
 *
 * 支持 Transferable Objects 实现零拷贝数据传输
 */

import { BufferWriter, BufferReader, deserializeCellData } from '../core/worker/TransferableSerializer.js';
import { cellKey, parseCellKey } from '../core/data/CellKey.js';

let wasmBridge = null;

// ========== 常量定义 ==========

// 数据类型标识（与 TransferableSerializer 保持一致）
const DataType = {
  NULL: 0,
  UNDEFINED: 1,
  BOOLEAN: 2,
  NUMBER: 3,
  STRING: 4,
  OBJECT: 5,
  ARRAY: 6,
  CELL_DATA: 7,
  FORMULA_BATCH: 8
};

const PATTERNS = [
  { type: 'fn', regex: /^[A-Z]+(?=\()/ },
  { type: 'range', regex: /^[A-Z]+[0-9]+:[A-Z]+[0-9]+/ },
  { type: 'cell', regex: /^[A-Z]+[0-9]+/ },
  { type: 'string', regex: /^"([^"]*)"/ },
  { type: 'boolean', regex: /^(TRUE|FALSE)(?![A-Z0-9])/i },
  { type: 'number', regex: /^\d+(\.\d+)?/ },
  { type: 'op', regex: /^[\+\-\*\/]/ },
  { type: 'compare', regex: /^(<>|<=|>=|[<>=])/ },
  { type: 'lparen', regex: /^\(/ },
  { type: 'rparen', regex: /^\)/ },
  { type: 'comma', regex: /^,/ },
  { type: 'ws', regex: /^\s+/ }
];

const PRECEDENCE = {
  '+': 1, '-': 1,
  '*': 2, '/': 2,
  '=': 0, '<': 0, '>': 0, '<=': 0, '>=': 0, '<>': 0
};

const FUNCTION_TYPES = {
  AGGREGATE: ['SUM', 'AVERAGE', 'MAX', 'MIN', 'COUNT', 'COUNTA'],
  MATH: ['ROUND', 'ABS', 'INT', 'MOD', 'POWER', 'SQRT', 'CEILING', 'FLOOR'],
  TEXT: ['CONCAT', 'LEFT', 'RIGHT', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'SUBSTITUTE'],
  LOGIC: ['IF', 'AND', 'OR', 'NOT'],
  DATE: ['TODAY', 'NOW', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DATE', 'DATEDIF']
};

// 错误类型
const ErrorCodes = {
  FORMULA_ERROR: 'FORMULA_ERROR',
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
  UNKNOWN_FUNCTION: 'UNKNOWN_FUNCTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  VALUE_ERROR: 'VALUE_ERROR',
  NUM_ERROR: 'NUM_ERROR'
};

// ========== 共享内存管理 (SharedArrayBuffer) ==========
let sharedBufferView = null; // 兼容旧格式
let sharedChunks = new Map(); // 新格式：chunkIdx -> Float64Array
let sharedMaxRows = 100000;
let sharedMaxCols = 256;
let sharedChunkSize = 1024;
const EMPTY_VALUE = -Infinity;

function getSharedValue(r, c) {
  // 1. 优先检查连续视图 (旧格式或已转换格式)
  if (sharedBufferView) {
    if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return EMPTY_VALUE;
    return sharedBufferView[r * sharedMaxCols + c];
  }

  // 2. 检查分块视图 (新格式)
  if (sharedChunks.size > 0) {
    if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return EMPTY_VALUE;
    const chunkIdx = Math.floor(r / sharedChunkSize);
    const view = sharedChunks.get(chunkIdx);
    if (!view) return EMPTY_VALUE;
    
    const rowInChunk = r % sharedChunkSize;
    return view[rowInChunk * sharedMaxCols + c];
  }

  return EMPTY_VALUE;
}

function updateSharedChunks(data) {
  if (!data) return;

  if (data instanceof SharedArrayBuffer) {
    // 兼容旧格式
    sharedBufferView = new Float64Array(data);
  } else if (data.chunks) {
    // 处理新格式
    sharedMaxRows = data.maxRows || sharedMaxRows;
    sharedMaxCols = data.maxCols || sharedMaxCols;
    sharedChunkSize = data.chunkSize || 1024;

    for (const idx in data.chunks) {
      const buffer = data.chunks[idx];
      if (buffer instanceof SharedArrayBuffer) {
        sharedChunks.set(parseInt(idx, 10), new Float64Array(buffer));
      }
    }
  }
}

// ========== 工具函数 ==========

/**
 * 创建 Excel 风格错误值
 */
function createError(code, message) {
  const errorMap = {
    [ErrorCodes.DIVISION_BY_ZERO]: '#DIV/0!',
    [ErrorCodes.CIRCULAR_REFERENCE]: '#CYCLE!',
    [ErrorCodes.UNKNOWN_FUNCTION]: '#NAME?',
    [ErrorCodes.INVALID_ARGUMENT]: '#VALUE!',
    [ErrorCodes.NUM_ERROR]: '#NUM!',
    [ErrorCodes.FORMULA_ERROR]: '#ERROR!',
    [ErrorCodes.VALUE_ERROR]: '#VALUE!'
  };
  return errorMap[code] || '#ERROR!';
}

/**
 * 列索引转列名 (0 -> A, 1 -> B, ...)
 */
function indexToColStr(index) {
  let str = '';
  let n = index + 1;
  while (n > 0) {
    let m = (n - 1) % 26;
    str = String.fromCharCode(65 + m) + str;
    n = Math.floor((n - m) / 26);
  }
  return str;
}

/**
 * 列名转列索引 (A -> 0, B -> 1, ...)
 */
function colStrToIndex(str) {
  let val = 0;
  for (let i = 0; i < str.length; i++) {
    val *= 26;
    val += str.charCodeAt(i) - 64;
  }
  return val - 1;
}

/**
 * 单元格引用转行列索引
 */
function refToRC(ref) {
  const letter = ref.match(/[A-Z]+/)[0];
  const num = ref.match(/[0-9]+/)[0];
  const c = colStrToIndex(letter);
  const r = parseInt(num, 10) - 1;
  return { r, c };
}

/**
 * 范围引用转行列索引
 */
function rangeToRC(range) {
  const parts = range.split(':');
  return {
    start: refToRC(parts[0]),
    end: refToRC(parts[1])
  };
}

// ========== 公式解析器 ==========

class FormulaWorkerParser {
  constructor() {
    this.rpnCache = new Map();
    this.MAX_CACHE_SIZE = 500;
  }

  /**
   * 词法分析
   */
  tokenize(expr) {
    const tokens = [];
    let i = 0;
    const len = expr.length;

    while (i < len) {
      let matched = false;
      const remaining = expr.substring(i);

      for (let j = 0; j < PATTERNS.length; j++) {
        const { type, regex } = PATTERNS[j];
        const match = remaining.match(regex);
        if (match) {
          if (type !== 'ws') {
            if (type === 'string') {
              tokens.push({ type, value: match[1] !== undefined ? match[1] : match[0] });
            } else if (type === 'boolean') {
              tokens.push({ type, value: match[0].toUpperCase() });
            } else {
              tokens.push({ type, value: match[0] });
            }
          }
          i += match[0].length;
          matched = true;
          break;
        }
      }

      if (!matched) {
        i++;
      }
    }
    return tokens;
  }

  /**
   * 调度场算法：中缀转后缀
   */
  shuntingYard(tokens) {
    const outputQueue = [];
    const operatorStack = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokenType = token.type;

      if (tokenType === 'number' || tokenType === 'cell' || tokenType === 'range' ||
          tokenType === 'string' || tokenType === 'boolean') {
        outputQueue.push(token);
      } else if (tokenType === 'fn') {
        token.value = token.value.toUpperCase();
        operatorStack.push(token);
      } else if (tokenType === 'comma') {
        while (operatorStack.length && operatorStack[operatorStack.length - 1].type !== 'lparen') {
          outputQueue.push(operatorStack.pop());
        }
      } else if (tokenType === 'op' || tokenType === 'compare') {
        const tokenValue = token.value;
        while (operatorStack.length) {
          const top = operatorStack[operatorStack.length - 1];
          if ((top.type === 'op' || top.type === 'compare') &&
              PRECEDENCE[top.value] >= PRECEDENCE[tokenValue]) {
            outputQueue.push(operatorStack.pop());
          } else {
            break;
          }
        }
        operatorStack.push(token);
      } else if (tokenType === 'lparen') {
        operatorStack.push(token);
      } else if (tokenType === 'rparen') {
        while (operatorStack.length && operatorStack[operatorStack.length - 1].type !== 'lparen') {
          outputQueue.push(operatorStack.pop());
        }
        operatorStack.pop();
        if (operatorStack.length && operatorStack[operatorStack.length - 1].type === 'fn') {
          outputQueue.push(operatorStack.pop());
        }
      }
    }

    while (operatorStack.length) {
      outputQueue.push(operatorStack.pop());
    }

    return outputQueue;
  }

  /**
   * 解析公式并缓存 RPN
   */
  parse(formula) {
    if (!formula || !formula.startsWith('=')) {
      return null;
    }

    const expression = formula.substring(1);
    const cacheKey = expression.toUpperCase();

    if (this.rpnCache.has(cacheKey)) {
      return this.rpnCache.get(cacheKey);
    }

    const tokens = this.tokenize(expression);
    if (!tokens.length) {
      return null;
    }

    const rpn = this.shuntingYard(tokens);

    // 缓存管理
    if (this.rpnCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.rpnCache.keys().next().value;
      this.rpnCache.delete(firstKey);
    }
    this.rpnCache.set(cacheKey, rpn);

    return rpn;
  }

  /**
   * 从公式中提取依赖
   * @returns {Set<string>} 单元格键格式的依赖集合
   */
  getDependencies(formula) {
    if (!formula || !formula.startsWith('=')) return new Set();

    const expression = formula.substring(1).toUpperCase();
    const tokens = this.tokenize(expression);
    const dependencies = new Set();

    tokens.forEach(token => {
      if (token.type === 'cell') {
        const { r, c } = refToRC(token.value);
        dependencies.add(cellKey(r, c));
      } else if (token.type === 'range') {
        const { start, end } = rangeToRC(token.value);
        const startR = Math.min(start.r, end.r);
        const endR = Math.max(start.r, end.r);
        const startC = Math.min(start.c, end.c);
        const endC = Math.max(start.c, end.c);
        for (let i = startR; i <= endR; i++) {
          for (let j = startC; j <= endC; j++) {
            dependencies.add(cellKey(i, j));
          }
        }
      }
    });

    return dependencies;
  }
}

// ========== 公式计算器 ==========

class FormulaWorkerEvaluator {
  constructor(dataProvider) {
    this.dataProvider = dataProvider;
    this.parser = new FormulaWorkerParser();
  }

  /**
   * 获取单元格值
   */
  getCellFromData(r, c, stack = []) {
    const key = cellKey(r, c);
    if (stack.includes(key)) {
      throw new Error('#CYCLE!');
    }
    return this.dataProvider(key, stack);
  }

  /**
   * 解析单元格值为合适类型
   */
  parseCellValue(val) {
    if (val === null || val === undefined || val === '') {
      return '';
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      return val;
    }
    const str = String(val);
    const cleanStr = str.replace(/,/g, '');
    const n = parseFloat(cleanStr);
    if (!isNaN(n) && str.trim() !== '') {
      return n;
    }
    return str;
  }

  /**
   * 将值解析为标量
   */
  resolveToScalar(val, context) {
    if (val === null || val === undefined) {
      return 0;
    }
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
      return val;
    }
    if (val && typeof val === 'object' && val.type === 'REF_RANGE') {
      let firstVal = null;
      let found = false;
      this.iterateRange(val.ref, context, (v) => {
        if (!found) {
          firstVal = this.parseCellValue(v);
          found = true;
        }
      });
      return firstVal !== null ? firstVal : 0;
    }
    return 0;
  }

  /**
   * 遍历范围
   */
  iterateRange(rangeRef, context, callback) {
    const { start, end } = rangeToRC(rangeRef);
    const startR = Math.min(start.r, end.r);
    const endR = Math.max(start.r, end.r);
    const startC = Math.min(start.c, end.c);
    const endC = Math.max(start.c, end.c);

    const stack = context?.stack || [];

    for (let i = startR; i <= endR; i++) {
      for (let j = startC; j <= endC; j++) {
        const val = this.getCellFromData(i, j, stack);
        callback(val);
      }
    }
  }

  /**
   * 收集函数参数
   */
  collectArgs(stack) {
    // 反向 pop 入 args 后一次 reverse，等价旧实现但是 O(n)；
    // 旧实现 args.unshift 在长参数列表（如 SUM(a,b,...,zz)）下是 O(n²)。
    const args = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top && typeof top === 'object' && top.type === 'ARGS') {
        stack.pop();
        break;
      }
      args.push(stack.pop());
    }
    args.reverse();
    return args;
  }

  /**
   * 比较运算
   */
  compare(a, b, op) {
    const typeA = typeof a;
    const typeB = typeof b;

    if (typeA === 'string' && typeB === 'string') {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }

    switch (op) {
      case '=': return a === b;
      case '<>': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: return false;
    }
  }

  /**
   * 计算函数
   */
  evaluateFunction(fnName, args, context) {
    if (FUNCTION_TYPES.AGGREGATE.includes(fnName)) {
      return this.evalAggregate(fnName, args, context);
    }
    if (FUNCTION_TYPES.MATH.includes(fnName)) {
      return this.evalMath(fnName, args, context);
    }
    if (FUNCTION_TYPES.TEXT.includes(fnName)) {
      return this.evalText(fnName, args, context);
    }
    if (FUNCTION_TYPES.LOGIC.includes(fnName)) {
      return this.evalLogic(fnName, args, context);
    }
    if (FUNCTION_TYPES.DATE.includes(fnName)) {
      return this.evalDate(fnName, args, context);
    }

    return createError(ErrorCodes.UNKNOWN_FUNCTION);
  }

  /**
   * 聚合函数
   */
  evalAggregate(fnName, args, context) {
    let result = 0;
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let countA = 0;

    const processRange = (rangeRef) => {
      this.iterateRange(rangeRef, context, (val) => {
        const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
        const numVal = parseFloat(cleanVal);
        if (!isNaN(numVal)) {
          if (fnName === 'SUM' || fnName === 'AVERAGE') result += numVal;
          if (fnName === 'MAX') max = Math.max(max, numVal);
          if (fnName === 'MIN') min = Math.min(min, numVal);
          count++;
        }
        if (val !== null && val !== undefined && val !== '') {
          countA++;
        }
      });
    };

    const processValue = (val) => {
      const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
      const numVal = parseFloat(cleanVal);
      if (!isNaN(numVal)) {
        if (fnName === 'SUM' || fnName === 'AVERAGE') result += numVal;
        if (fnName === 'MAX') max = Math.max(max, numVal);
        if (fnName === 'MIN') min = Math.min(min, numVal);
        count++;
      }
      if (val !== null && val !== undefined && val !== '') {
        countA++;
      }
    };

    for (const arg of args) {
      if (arg && typeof arg === 'object' && arg.type === 'REF_RANGE') {
        processRange(arg.ref);
      } else {
        processValue(arg);
      }
    }

    switch (fnName) {
      case 'SUM': return result;
      case 'AVERAGE':
        if (count === 0) return createError(ErrorCodes.DIVISION_BY_ZERO);
        return result / count;
      case 'MAX': return count === 0 ? 0 : max;
      case 'MIN': return count === 0 ? 0 : min;
      case 'COUNT': return count;
      case 'COUNTA': return countA;
      default: return 0;
    }
  }

  /**
   * 数学函数
   */
  evalMath(fnName, args, context) {
    if (args.length === 0) {
      return createError(ErrorCodes.INVALID_ARGUMENT);
    }

    const getNum = (arg) => {
      if (arg && typeof arg === 'object' && arg.type === 'REF_RANGE') {
        return this.resolveToScalar(arg, context);
      }
      if (typeof arg === 'string' && arg.startsWith('#')) {
        throw new Error(arg);
      }
      const cleanArg = typeof arg === 'string' ? arg.replace(/,/g, '') : arg;
      const n = parseFloat(cleanArg);
      if (isNaN(n)) {
        throw new Error(`无法将 "${arg}" 转换为数字`);
      }
      return n;
    };

    try {
      switch (fnName) {
        case 'ROUND': {
          if (args.length < 1) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]);
          const digits = args.length > 1 ? Math.floor(getNum(args[1])) : 0;
          const factor = Math.pow(10, digits);
          return Math.round(num * factor) / factor;
        }
        case 'ABS': {
          const num = getNum(args[0]);
          return Math.abs(num);
        }
        case 'INT': {
          const num = getNum(args[0]);
          return Math.floor(num);
        }
        case 'MOD': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]);
          const divisor = getNum(args[1]);
          if (divisor === 0) return createError(ErrorCodes.DIVISION_BY_ZERO);
          return num - divisor * Math.floor(num / divisor);
        }
        case 'POWER': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const base = getNum(args[0]);
          const exponent = getNum(args[1]);
          return Math.pow(base, exponent);
        }
        case 'SQRT': {
          const num = getNum(args[0]);
          if (num < 0) return createError(ErrorCodes.NUM_ERROR);
          return Math.sqrt(num);
        }
        case 'CEILING': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]);
          const significance = getNum(args[1]);
          if (significance === 0) return 0;
          return Math.ceil(num / significance) * significance;
        }
        case 'FLOOR': {
          if (args.length < 2) return createError(ErrorCodes.VALUE_ERROR);
          const num = getNum(args[0]);
          const significance = getNum(args[1]);
          if (significance === 0) return 0;
          return Math.floor(num / significance) * significance;
        }
        default:
          return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  /**
   * 文本函数
   */
  evalText(fnName, args, context) {
    const getStr = (arg) => {
      if (arg && typeof arg === 'object' && arg.type === 'REF_RANGE') {
        arg = this.resolveToScalar(arg, context);
      }
      if (typeof arg === 'string' && arg.startsWith('#')) {
        throw new Error(arg);
      }
      return String(arg ?? '');
    };

    const requireArgs = (minCount) => {
      if (args.length < minCount) {
        throw new Error(`${fnName} 至少需要 ${minCount} 个参数`);
      }
    };

    try {
      switch (fnName) {
        case 'CONCAT':
          return args.map(arg => getStr(arg)).join('');
        case 'LEFT': {
          requireArgs(1);
          const str = getStr(args[0]);
          const numChars = args.length > 1 ? Math.floor(parseFloat(args[1]) || 0) : 1;
          return str.substring(0, Math.max(0, numChars));
        }
        case 'RIGHT': {
          requireArgs(1);
          const str = getStr(args[0]);
          const numChars = args.length > 1 ? Math.floor(parseFloat(args[1]) || 0) : 1;
          const len = str.length;
          return str.substring(Math.max(0, len - numChars));
        }
        case 'LEN': {
          requireArgs(1);
          return getStr(args[0]).length;
        }
        case 'UPPER': {
          requireArgs(1);
          return getStr(args[0]).toUpperCase();
        }
        case 'LOWER': {
          requireArgs(1);
          return getStr(args[0]).toLowerCase();
        }
        case 'TRIM': {
          requireArgs(1);
          return getStr(args[0]).trim();
        }
        case 'SUBSTITUTE': {
          requireArgs(3);
          const text = getStr(args[0]);
          const oldText = getStr(args[1]);
          const newText = getStr(args[2]);
          const instanceNum = args.length > 3 ? Math.floor(parseFloat(args[3]) || 0) : 0;

          if (instanceNum === 0) {
            return text.split(oldText).join(newText);
          } else {
            let count = 0;
            let result = '';
            for (let i = 0; i < text.length; i++) {
              if (text.substring(i, i + oldText.length) === oldText) {
                count++;
                if (count === instanceNum) {
                  result += newText;
                  i += oldText.length - 1;
                  continue;
                }
              }
              result += text[i];
            }
            return result;
          }
        }
        default:
          return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  /**
   * 逻辑函数
   */
  evalLogic(fnName, args, context) {
    const toBool = (val) => {
      if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
      if (typeof val === 'boolean') return val;
      if (typeof val === 'number') return val !== 0;
      if (typeof val === 'string') {
        const upper = val.toUpperCase();
        if (upper === 'TRUE') return true;
        if (upper === 'FALSE') return false;
        return val !== '';
      }
      return Boolean(val);
    };

    const requireArgs = (minCount) => {
      if (args.length < minCount) {
        throw new Error(`${fnName} 至少需要 ${minCount} 个参数`);
      }
    };

    try {
      switch (fnName) {
        case 'IF': {
          requireArgs(2);
          const condition = toBool(args[0]);
          return condition ? args[1] : (args.length > 2 ? args[2] : false);
        }
        case 'AND': {
          requireArgs(1);
          for (const arg of args) {
            if (!toBool(arg)) return false;
          }
          return true;
        }
        case 'OR': {
          requireArgs(1);
          for (const arg of args) {
            if (toBool(arg)) return true;
          }
          return false;
        }
        case 'NOT': {
          requireArgs(1);
          return !toBool(args[0]);
        }
        default:
          return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  /**
   * 日期函数
   */
  evalDate(fnName, args, context) {
    const parseDate = (val) => {
      if (typeof val === 'string' && val.startsWith('#')) throw new Error(val);
      if (val instanceof Date) return val;
      if (typeof val === 'number') {
        return new Date((val - 25569) * 86400 * 1000);
      }
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    const toExcelDate = (date) => {
      return Math.floor((date.getTime() / 86400000) + 25569);
    };

    const requireArgs = (minCount) => {
      if (args.length < minCount) {
        throw new Error(`${fnName} 至少需要 ${minCount} 个参数`);
      }
    };

    try {
      switch (fnName) {
        case 'TODAY': {
          const now = new Date();
          return toExcelDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        }
        case 'NOW': {
          const now = new Date();
          const datePart = toExcelDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
          const timePart = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
          return datePart + timePart;
        }
        case 'YEAR': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getFullYear();
        }
        case 'MONTH': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getMonth() + 1;
        }
        case 'DAY': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getDate();
        }
        case 'HOUR': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getHours();
        }
        case 'MINUTE': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getMinutes();
        }
        case 'SECOND': {
          requireArgs(1);
          const date = parseDate(args[0]);
          if (!date) return createError(ErrorCodes.VALUE_ERROR);
          return date.getSeconds();
        }
        case 'DATE': {
          requireArgs(3);
          const year = Math.floor(parseFloat(args[0]) || 0);
          const month = Math.floor(parseFloat(args[1]) || 0) - 1;
          const day = Math.floor(parseFloat(args[2]) || 0);
          const date = new Date(year, month, day);
          return toExcelDate(date);
        }
        case 'DATEDIF': {
          requireArgs(3);
          const startDate = parseDate(args[0]);
          const endDate = parseDate(args[1]);
          const unit = String(args[2]).toUpperCase();

          if (!startDate || !endDate) return createError(ErrorCodes.VALUE_ERROR);

          switch (unit) {
            case 'Y': {
              let years = endDate.getFullYear() - startDate.getFullYear();
              if (endDate.getMonth() < startDate.getMonth() ||
                  (endDate.getMonth() === startDate.getMonth() && endDate.getDate() < startDate.getDate())) {
                years--;
              }
              return years;
            }
            case 'M': {
              const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 +
                            endDate.getMonth() - startDate.getMonth();
              if (endDate.getDate() < startDate.getDate()) {
                return months - 1;
              }
              return months;
            }
            case 'D': {
              return Math.floor((endDate - startDate) / 86400000);
            }
            case 'YM': {
              let months = endDate.getMonth() - startDate.getMonth();
              if (endDate.getDate() < startDate.getDate()) {
                months--;
              }
              return months < 0 ? months + 12 : months;
            }
            case 'YD': {
              const start = new Date(startDate);
              const end = new Date(endDate);
              start.setFullYear(endDate.getFullYear());
              if (start > end) {
                start.setFullYear(endDate.getFullYear() - 1);
              }
              return Math.floor((end - start) / 86400000);
            }
            case 'MD': {
              let days = endDate.getDate() - startDate.getDate();
              return days < 0 ? days + 32 : days;
            }
            default:
              return createError(ErrorCodes.VALUE_ERROR);
          }
        }
        default:
          return createError(ErrorCodes.UNKNOWN_FUNCTION);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('#')) return e.message;
      return createError(ErrorCodes.VALUE_ERROR);
    }
  }

  /**
   * 计算 RPN 表达式
   */
  evaluateRPN(rpn, context) {
    const stack = [];
    const REF_RANGE_TYPE = 'REF_RANGE';

    for (let i = 0; i < rpn.length; i++) {
      const token = rpn[i];
      const tokenType = token.type;

      if (tokenType === 'number') {
        stack.push(parseFloat(token.value) || 0);
      } else if (tokenType === 'string') {
        stack.push(token.value);
      } else if (tokenType === 'boolean') {
        stack.push(token.value === 'TRUE');
      } else if (tokenType === 'cell') {
        const { r, c } = refToRC(token.value);
        const val = this.getCellFromData(r, c, context?.stack || []);
        stack.push(this.parseCellValue(val));
      } else if (tokenType === 'range') {
        stack.push({ type: REF_RANGE_TYPE, ref: token.value.toUpperCase() });
      } else if (tokenType === 'op') {
        const b = this.resolveToScalar(stack.pop(), context);
        const a = this.resolveToScalar(stack.pop(), context);
        
        if (typeof a === 'string' && a.startsWith('#')) { stack.push(a); continue; }
        if (typeof b === 'string' && b.startsWith('#')) { stack.push(b); continue; }

        const op = token.value;
        if (op === '+') {
          if (typeof a === 'string' || typeof b === 'string') {
            stack.push(String(a) + String(b));
          } else {
            stack.push(a + b);
          }
        } else if (op === '-') stack.push(a - b);
        else if (op === '*') stack.push(a * b);
        else if (op === '/') {
          if (b === 0) {
            return createError(ErrorCodes.DIVISION_BY_ZERO);
          }
          stack.push(a / b);
        }
      } else if (tokenType === 'compare') {
        const b = this.resolveToScalar(stack.pop(), context);
        const a = this.resolveToScalar(stack.pop(), context);
        
        if (typeof a === 'string' && a.startsWith('#')) { stack.push(a); continue; }
        if (typeof b === 'string' && b.startsWith('#')) { stack.push(b); continue; }
        
        stack.push(this.compare(a, b, token.value));
      } else if (tokenType === 'fn') {
        const args = this.collectArgs(stack);
        const fnName = token.value;
        stack.push(this.evaluateFunction(fnName, args, context));
      }
    }

    if (stack.length === 0) {
      return createError(ErrorCodes.FORMULA_ERROR);
    }

    const final = stack[0];
    if (final && typeof final === 'object' && final.type === REF_RANGE_TYPE) {
      return this.resolveToScalar(final, context);
    }

    return final;
  }

  /**
   * 计算单个公式
   */
  evaluate(formula, context = {}) {
    if (!formula || !formula.startsWith('=')) return formula;

    try {
      const rpn = this.parser.parse(formula);
      if (!rpn) {
        return createError(ErrorCodes.FORMULA_ERROR);
      }
      return this.evaluateRPN(rpn, context);
    } catch (e) {
      if (e.message === '#CYCLE!') {
        return createError(ErrorCodes.CIRCULAR_REFERENCE);
      }
      return createError(ErrorCodes.FORMULA_ERROR);
    }
  }
}

// ========== Worker 消息处理 ==========

let evaluator = null;

/**
 * 初始化计算器
 */
function initEvaluator(dataProvider) {
  evaluator = new FormulaWorkerEvaluator(dataProvider);
}

/**
 * 处理单个公式计算
 */
function handleEvaluate(task) {
  const { formula, cellId, context } = task;

  // WASM 路径加速尝试
  if (wasmBridge && wasmBridge.isLoaded) {
    // 逻辑：如果公式属于高性能算子，则调用 WASM
  }

  let result = evaluator.evaluate(formula, context);
  if (typeof result === 'number' && isNaN(result)) {
    result = createError(ErrorCodes.VALUE_ERROR);
  }
  return { cellId, result };
}

/**
 * 处理批量公式计算
 */
function handleEvaluateBatch(task) {
  const { formulas, data } = task;
  const results = {};

  // 创建数据提供者
  const dataProvider = (key, stack) => {
    // 1. 优先从共享内存读取
    const { r, c } = parseCellKey(key);
    const sharedVal = getSharedValue(r, c);
    
    if (sharedVal !== EMPTY_VALUE) {
      if (isNaN(sharedVal)) {
        // 非数字标识（NaN），回退到普通对象读取字符串或检查公式
      } else {
        return sharedVal;
      }
    }

    // 2. 回退到普通对象
    const cell = data[key];
    if (!cell) return null;
    if (cell.f && (cell.dirty || cell.v === undefined)) {
      // 需要递归计算
      if (stack.includes(key)) {
        throw new Error('#CYCLE!');
      }
      const newStack = [...stack, key];
      const result = evaluator.evaluate(cell.f, { stack: newStack });
      return result;
    }
    return cell.v;
  };

  // 初始化计算器
  initEvaluator(dataProvider);

  // 按拓扑顺序计算
  const sortedFormulas = topologicalSort(formulas, data, evaluator.parser);

  for (const { cellId, formula } of sortedFormulas) {
    let result = evaluator.evaluate(formula, { stack: [cellId] });
    if (typeof result === 'number' && isNaN(result)) {
      result = createError(ErrorCodes.VALUE_ERROR);
    }
    results[cellId] = result;
    // 更新数据以供后续公式使用
    if (data[cellId]) {
      data[cellId].v = result;
      data[cellId].dirty = false;
    }
  }

  return results;
}

/**
 * 拓扑排序
 */
function topologicalSort(formulas, data, parser) {
  if (!parser) parser = new FormulaWorkerParser();
  const cellMap = new Map();
  const inDegree = new Map();
  const reverseDeps = new Map(); // 逆向依赖映射: A -> [B, C] 表示 B 和 C 都依赖 A
  const result = [];

  // 1. 初始化并预存公式键
  const formulaKeys = new Set();
  for (const fc of formulas) {
    cellMap.set(fc.cellId, fc);
    inDegree.set(fc.cellId, 0);
    formulaKeys.add(fc.cellId);
  }

  // 2. 构建依赖图并计算入度
  for (const fc of formulas) {
    const deps = parser.getDependencies(fc.formula);
    for (const depId of deps) {
      if (formulaKeys.has(depId)) {
        // 记录入度: fc.cellId 依赖于 depId
        inDegree.set(fc.cellId, inDegree.get(fc.cellId) + 1);
        
        // 记录逆向依赖: 谁依赖了 depId
        if (!reverseDeps.has(depId)) {
          reverseDeps.set(depId, new Set());
        }
        reverseDeps.get(depId).add(fc.cellId);
      }
    }
  }

  // 3. Kahn 算法 (基于逆向映射优化)
  const queue = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) {
      queue.push(cellMap.get(key));
    }
  }

  let head = 0;
  while (head < queue.length) {
    const fc = queue[head++];
    result.push(fc);

    // 核心优化: 仅遍历依赖于当前单元格的公式
    const dependents = reverseDeps.get(fc.cellId);
    if (dependents) {
      for (const depId of dependents) {
        if (inDegree.has(depId)) {
          const newDegree = inDegree.get(depId) - 1;
          inDegree.set(depId, newDegree);
          if (newDegree === 0) {
            queue.push(cellMap.get(depId));
          }
        }
      }
    }
  }

  // 4. 环检测处理
  if (result.length < formulas.length) {
    const resultKeys = new Set(result.map(fc => fc.cellId));
    for (const fc of formulas) {
      if (!resultKeys.has(fc.cellId)) {
        result.push(fc);
      }
    }
  }

  return result;
}

// ========== Transferable 序列化辅助 ==========

// BufferWriter, BufferReader, deserializeCellData 均从 TransferableSerializer 统一导入

/**
 * 反序列化公式批量计算请求（复用 TransferableSerializer.deserializeCellData）
 */
function deserializeFormulaBatch(buffer) {
  const reader = new BufferReader(buffer);

  const magic = reader.readUint32();
  if (magic !== 0x464F524D) { // "FORM"
    throw new Error('Invalid formula batch data');
  }

  const formulaCount = reader.readUint32();
  const formulas = [];
  for (let i = 0; i < formulaCount; i++) {
    const cellId = reader.readString();
    const formula = reader.readString();
    formulas.push({ cellId, formula });
  }

  const dataCount = reader.readUint32();
  const data = {};
  for (let i = 0; i < dataCount; i++) {
    const { key, cell } = deserializeCellData(reader);
    const { r, c } = parseCellKey(key);
    if (r < 0 || c < 0) continue;
    data[cellKey(r, c)] = cell;
  }

  return { formulas, data };
}

/**
 * 序列化公式计算结果（使用 Transferable）
 */
function serializeResultsTransferable(results) {
  const writer = new BufferWriter();

  // 写入魔数标识
  writer.writeUint32(0x52455354); // "REST"

  // 写入结果数量
  const keys = Object.keys(results);
  writer.writeUint32(keys.length);

  // 写入结果
  for (const cellId of keys) {
    writer.writeString(String(cellId));

    // 写入结果值
    const value = results[cellId];
    if (value === null) {
      writer.writeUint8(DataType.NULL);
    } else if (value === undefined) {
      writer.writeUint8(DataType.UNDEFINED);
    } else if (typeof value === 'boolean') {
      writer.writeUint8(DataType.BOOLEAN);
      writer.writeUint8(value ? 1 : 0);
    } else if (typeof value === 'number') {
      writer.writeUint8(DataType.NUMBER);
      writer.writeFloat64(value);
    } else {
      writer.writeUint8(DataType.STRING);
      writer.writeString(String(value));
    }
  }

  return writer.getTransferable();
}

// ========== Worker 入口 ==========

self.onmessage = function(e) {
  const { type, taskId, useTransferable, buffer, sharedChunks, sharedRows, sharedCols, ...task } = e.data;
  
  if (sharedRows) sharedMaxRows = sharedRows;
  if (sharedCols) sharedMaxCols = sharedCols;

  // 更新共享内存
  if (sharedChunks) {
    updateSharedChunks(sharedChunks);
    
    // 异步加载 WASM 桥接
    if (!wasmBridge) {
      import('../core/worker/WasmBridge.js').then(m => {
        wasmBridge = m.wasmBridge;
        wasmBridge.init().then(() => {
          if (sharedChunks instanceof SharedArrayBuffer) {
             wasmBridge.bindSharedMemory(sharedChunks, sharedMaxRows, sharedMaxCols);
          }
        });
      }).catch(err => console.warn('WASM bridge loading skipped:', err));
    }
  }
  const startTime = performance.now();

  try {
    let result;
    let resultBuffer;

    switch (type) {
      case 'evaluate':
        result = handleEvaluate(task);
        break;
      case 'evaluateBatch':
        if (useTransferable && buffer) {
          // 使用 Transferable 反序列化
          const { formulas, data } = deserializeFormulaBatch(buffer);
          result = handleEvaluateBatch({ formulas, data });
          // 序列化结果
          resultBuffer = serializeResultsTransferable(result);
        } else {
          // 兼容旧格式
          result = handleEvaluateBatch(task);
        }
        break;
      case 'recalcAll':
        result = handleRecalcAll(task);
        break;
      case 'init':
        // 初始化 Worker
        result = { initialized: true };
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    const endTime = performance.now();

    // 如果有 Transferable 结果，使用零拷贝传输
    if (resultBuffer) {
      self.postMessage({
        type: 'result',
        taskId,
        success: true,
        useTransferable: true,
        buffer: resultBuffer,
        duration: endTime - startTime
      }, [resultBuffer]);
    } else {
      self.postMessage({
        type: 'result',
        taskId,
        success: true,
        result,
        duration: endTime - startTime
      });
    }
  } catch (error) {
    self.postMessage({
      type: 'result',
      taskId,
      success: false,
      error: error.message
    });
  }
};

// Worker 就绪
self.postMessage({ type: 'ready' });

/**
 * 处理全量重算
 */
function handleRecalcAll(task) {
  const { formulas, data } = task;
  const results = {};
  
  // 1. 初始化数据提供者
  const dataProvider = (key, stack) => {
    const { r, c } = parseCellKey(key);
    const sharedVal = getSharedValue(r, c);
    
    if (sharedVal !== EMPTY_VALUE && !isNaN(sharedVal)) {
      return sharedVal;
    }

    const cell = data[key];
    if (!cell) return null;
    return cell.v;
  };

  initEvaluator(dataProvider);

  // 2. 拓扑排序
  const sortedFormulas = topologicalSort(formulas, data, evaluator.parser);
  
  // 3. 顺序计算
  for (const fc of sortedFormulas) {
    const { cellId, formula } = fc;
    let result;

    // 尝试 WASM 加速 (如果适用)
    if (wasmBridge && wasmBridge.isLoaded && isWasmFastPathSupported(formula)) {
        try {
            const wasmResult = wasmBridge.evaluate(formula);
            if ((typeof wasmResult === 'number' && !isNaN(wasmResult)) || (typeof wasmResult === 'string' && !wasmResult.startsWith('#'))) {
                result = wasmResult;
            } else {
                result = evaluator.evaluate(formula, { stack: [cellId] });
            }
        } catch (e) {
            result = evaluator.evaluate(formula, { stack: [cellId] });
        }
    } else {
        result = evaluator.evaluate(formula, { stack: [cellId] });
    }
    
    if (typeof result === 'number' && isNaN(result)) {
        result = createError(ErrorCodes.VALUE_ERROR);
    }
    
    // 4. 写回结果
    const { r, c } = parseCellKey(cellId);
    if (typeof result === 'number' && !isNaN(result)) {
        // 如果是数字且非 NaN，直接更新共享内存，减少消息传输体积
        setSharedValue(r, c, result);
    } else {
        // 否则记录到结果集返回 (包括错误字符串和 NaN 转换后的错误)
        results[cellId] = result;
    }
    
    // 更新本地数据引用，供后续公式依赖使用
    if (data[cellId]) {
      data[cellId].v = result;
    }
  }

  return results;
}

function isWasmFastPathSupported(formula) {
    // 简单数学公式优先走 WASM
    return !formula.includes('"') && !formula.includes('CONCAT');
}

function setSharedValue(r, c, val) {
  if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return;

  // 优先连续视图
  if (sharedBufferView) {
    sharedBufferView[r * sharedMaxCols + c] = val;
    return;
  }

  // 分块视图
  if (sharedChunks.size > 0) {
    const chunkIdx = Math.floor(r / sharedChunkSize);
    const view = sharedChunks.get(chunkIdx);
    if (!view) return;
    view[(r % sharedChunkSize) * sharedMaxCols + c] = val;
  }
}
