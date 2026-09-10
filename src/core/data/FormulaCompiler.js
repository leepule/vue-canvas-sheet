/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 *
 * 公式引用归一化器
 *
 * 将 A1 风格单元格引用转换为 R1C1 相对引用格式，供 WASM 引擎批量求值时
 * 做公式分组去重（相同 R1C1 归一化形式的公式可复用同一次 AST 解析）。
 *
 * 安全性：本模块不使用 eval / new Function 等动态代码执行，纯字符串解析。
 * 实际公式求值由 FormulaRPNEvaluator（JS 解释器）或 WASM 引擎完成。
 */

/**
 * 公式引用归一化器
 * 将 Excel 公式中的 A1 引用转换为 R1C1 相对引用格式
 */
export class FormulaCompiler {
  constructor(maxCacheSize = 500) {
    this.cache = new Map();
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * LRU 驱逐：缓存满时删除最久未使用的条目
   * @private
   */
  _evict() {
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 将公式转化为 R1C1 相对引用格式 (归一化)
   * @param {string} formula - 以 '=' 开头的公式字符串
   * @param {Object} [context] - 用于解析引用的上下文 (需提供 _refToRC / _rangeRefToBounds)
   * @param {number} [baseR=0] - 基准行
   * @param {number} [baseC=0] - 基准列
   * @returns {string} R1C1 归一化后的公式字符串
   */
  toR1C1(formula, context, baseR = 0, baseC = 0) {
    return this._normalizeToR1C1(formula, context, baseR, baseC).r1c1;
  }

  /**
   * 清空归一化缓存
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * 将公式标准化为 R1C1 格式作为缓存键，同时返回 tokens 避免重复分词
   * @private
   * @returns {{ r1c1: string, tokens: Array }}
   */
  _normalizeToR1C1(formula, context, baseR, baseC) {
    if (!context) return { r1c1: formula, tokens: this._tokenize(formula) };

    const expr = formula.startsWith('=') ? formula : formula;
    const cacheKey = expr + '\0' + baseR + '\0' + baseC;

    // 快速路径：命中缓存
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      // LRU：命中时移到末尾
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    const tokens = this._tokenize(formula);
    let r1c1 = '';

    for (const token of tokens) {
      if (token.type === 'REF') {
        if (token.value.includes(':')) {
          const range = context._rangeRefToBounds(token.value);
          if (range) {
            r1c1 += `R[${range.startR - baseR}]C[${range.startC - baseC}]:R[${range.endR - baseR}]C[${range.endC - baseC}]`;
          } else {
            r1c1 += token.value;
          }
        } else {
          const coords = context._refToRC(token.value);
          if (coords) {
            r1c1 += `R[${coords.r - baseR}]C[${coords.c - baseC}]`;
          } else {
            r1c1 += token.value;
          }
        }
      } else {
        r1c1 += token.value;
      }
    }

    const result = { r1c1, tokens };
    this._evict();
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * 词法分析器 (Lexer)
   * 精简版：仅区分 REF（单元格引用）与其他 token 类型，
   * 不再区分函数白名单/错误 token（这些仅在旧 compile() 路径中使用）。
   * @private
   */
  _tokenize(formula) {
    const code = formula.startsWith('=') ? formula.substring(1) : formula;
    const tokens = [];
    let i = 0;
    const len = code.length;

    while (i < len) {
      const charCode = code.charCodeAt(i);

      // 空白字符: \s (32=space, 9=tab, 10=lf, 13=cr)
      if (charCode === 32 || charCode === 9 || charCode === 10 || charCode === 13) {
        i++;
        continue;
      }

      // 比较运算符: <>, <=, >=
      const compare = code.substring(i, i + 2);
      if (compare === '<>' || compare === '<=' || compare === '>=') {
        tokens.push({ type: 'OP', value: compare });
        i += 2;
        continue;
      }

      // 运算符和分隔符: +-*/(), <>=
      if (charCode === 43 || charCode === 45 || charCode === 42 || charCode === 47 ||
          charCode === 40 || charCode === 41 || charCode === 44 ||
          charCode === 60 || charCode === 61 || charCode === 62) {
        tokens.push({ type: 'OP', value: code[i] });
        i++;
        continue;
      }

      // 数字: [0-9.] (48-57, 46)
      if ((charCode >= 48 && charCode <= 57) || charCode === 46) {
        let num = '';
        while (i < len) {
          const c = code.charCodeAt(i);
          if ((c >= 48 && c <= 57) || c === 46) {
            num += code[i++];
          } else {
            break;
          }
        }
        tokens.push({ type: 'NUM', value: num });
        continue;
      }

      // 字符串: "..."
      if (charCode === 34) { // '"'
        let str = '';
        i++; // skip open quote
        while (i < len) {
          const c = code[i];
          if (c === '"') {
            if (i + 1 < len && code[i + 1] === '"') {
              str += '"';
              i += 2;
            } else {
              i++; // skip close quote
              break;
            }
          } else {
            str += c;
            i++;
          }
        }
        tokens.push({ type: 'STR', value: str });
        continue;
      }

      // 布尔值: TRUE/FALSE
      const remaining = code.substring(i).toUpperCase();
      if (remaining.startsWith('TRUE') && !/[A-Z0-9]/.test(remaining[4] || '')) {
        tokens.push({ type: 'BOOL', value: true });
        i += 4;
        continue;
      }
      if (remaining.startsWith('FALSE') && !/[A-Z0-9]/.test(remaining[5] || '')) {
        tokens.push({ type: 'BOOL', value: false });
        i += 5;
        continue;
      }

      // 标识符（函数名）或单元格引用: [A-Za-z$]
      if ((charCode >= 65 && charCode <= 90) || charCode === 36 ||
          (charCode >= 97 && charCode <= 122)) {
        let str = '';
        while (i < len) {
          const c = code.charCodeAt(i);
          // [A-Za-z0-9$:] (65-90, 97-122, 48-57, 36, 58)
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
              (c >= 48 && c <= 57) || c === 36 || c === 58) {
            str += code[i++];
          } else {
            break;
          }
        }

        // 预查下一个非空字符是否为左括号 → 函数调用（无需白名单）
        let nextIdx = i;
        while (nextIdx < len) {
          const c = code.charCodeAt(nextIdx);
          if (c === 32 || c === 9 || c === 10 || c === 13) nextIdx++;
          else break;
        }

        if (nextIdx < len && code.charCodeAt(nextIdx) === 40) { // '('
          // 函数名：直接保留（WASM/FormulaRPNEvaluator 各自做安全校验）
          tokens.push({ type: 'IDENT', value: str.toUpperCase() });
        } else {
          // 单元格引用
          tokens.push({ type: 'REF', value: str.toUpperCase() });
        }
        continue;
      }

      i++;
    }
    return tokens;
  }
}

export const formulaCompiler = new FormulaCompiler();
