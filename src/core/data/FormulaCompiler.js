/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 高性能公式编译器
 * 将 Excel 公式字符串编译为可执行的 JavaScript 函数
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
   * 编译公式
   * @param {string} formula
   * @param {Object} [context] - 用于解析引用的上下文 (Workbook 实例)
   * @param {number} [baseR=0] - 基准行 (编译时的参考坐标)
   * @param {number} [baseC=0] - 基准列 (编译时的参考坐标)
   * @returns {Function} 编译后的执行函数
   */
  compile(formula, context, baseR = 0, baseC = 0) {
    // 快速路径：按原始公式 + 位置直接查缓存，跳过 tokenization
    const rawKey = formula + '\0' + baseR + '\0' + baseC;
    if (this.cache.has(rawKey)) {
      // LRU：命中时移到末尾
      const fn = this.cache.get(rawKey);
      this.cache.delete(rawKey);
      this.cache.set(rawKey, fn);
      return fn;
    }

    // 慢路径：R1C1 归一化作为缓存键，支持跨单元格去重
    const { r1c1, tokens } = this._normalizeToR1C1(formula, context, baseR, baseC);
    if (this.cache.has(r1c1)) {
      const fn = this.cache.get(r1c1);
      // LRU：命中时移到末尾
      this.cache.delete(r1c1);
      this.cache.set(r1c1, fn);
      this.cache.set(rawKey, fn); // 回填快速路径
      return fn;
    }

    const expression = this._buildExpression(tokens, context, baseR, baseC);

    try {
      const compiledFn = new Function('ctx', 'baseR', 'baseC', `try { return ${expression}; } catch(e) { return "#ERROR!"; }`);
      this._evict();
      this.cache.set(r1c1, compiledFn);
      this._evict();
      this.cache.set(rawKey, compiledFn);
      return compiledFn;
    } catch (e) {
      console.error('Formula Compile Error:', e, expression);
      return () => '#ERROR!';
    }
  }

  /**
   * 将公式转化为 R1C1 相对引用格式 (归一化)
   */
  toR1C1(formula, context, baseR, baseC) {
    return this._normalizeToR1C1(formula, context, baseR, baseC).r1c1;
  }

  /**
   * 将公式标准化为 R1C1 格式作为缓存键，同时返回 tokens 避免重复分词
   * @private
   * @returns {{ r1c1: string, tokens: Array }}
   */
  _normalizeToR1C1(formula, context, baseR, baseC) {
    if (!context) return { r1c1: formula, tokens: this._tokenize(formula) };
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
    return { r1c1, tokens };
  }

  /**
   * 清空编译缓存
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * 词法分析器 (Lexer)
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
      // (43=+, 45=-, 42=*, 47=/, 40=(, 41=), 44=,, 60=<, 61==, 62=>)
      if (charCode === 43 || charCode === 45 || charCode === 42 || charCode === 47 || charCode === 40 || charCode === 41 || charCode === 44 || charCode === 60 || charCode === 61 || charCode === 62) {
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
              // 处理转义引号 ""
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

      // 函数名或引用: [A-Z] (65-90) 或 $ (36)
      if ((charCode >= 65 && charCode <= 90) || charCode === 36 || (charCode >= 97 && charCode <= 122)) {
        let str = '';
        while (i < len) {
          const c = code.charCodeAt(i);
          // [A-Za-z0-9$:] (65-90, 97-122, 48-57, 36, 58)
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 36 || c === 58) {
            str += code[i++];
          } else {
            break;
          }
        }
        
        // 预查下一个非空字符是否为左括号
        let nextIdx = i;
        while (nextIdx < len) {
          const c = code.charCodeAt(nextIdx);
          if (c === 32 || c === 9 || c === 10 || c === 13) nextIdx++;
          else break;
        }
        
        if (nextIdx < len && code.charCodeAt(nextIdx) === 40) { // '('
          tokens.push({ type: 'FUNC', value: str.toUpperCase() });
        } else {
          tokens.push({ type: 'REF', value: str.toUpperCase() });
        }
        continue;
      }

      i++;
    }
    return tokens;
  }

  /**
   * 生成 JS 表达式
   * @private
   * @param {Array} tokens 
   * @param {Object} [context] 
   * @param {number} [baseR=0]
   * @param {number} [baseC=0]
   */
  _buildExpression(tokens, context, baseR = 0, baseC = 0) {
    // 使用 parts.push() + join 替代循环内 += 字符串拼接，
    // 长公式时显著减少中间字符串分配
    const parts = [];
    for (const token of tokens) {
      switch (token.type) {
        case 'NUM':
          parts.push(String(token.value));
          break;
        case 'STR':
          parts.push(`'${token.value.replace(/'/g, "\\'")}'`);
          break;
        case 'BOOL':
          parts.push(token.value ? 'true' : 'false');
          break;
        case 'FUNC':
          parts.push(`ctx.${token.value.toLowerCase()}`);
          break;
        case 'REF':
          if (token.value.includes(':')) {
            const range = context && typeof context._rangeRefToBounds === 'function'
              ? context._rangeRefToBounds(token.value)
              : null;

            if (range) {
              const dr1 = range.startR - baseR;
              const dc1 = range.startC - baseC;
              const dr2 = range.endR - baseR;
              const dc2 = range.endC - baseC;
              parts.push(`ctx.r(baseR + ${dr1}, baseC + ${dc1}, baseR + ${dr2}, baseC + ${dc2})`);
            } else {
              parts.push(`ctx.range('${token.value}')`);
            }
          } else {
            const coords = context && typeof context._refToRC === 'function'
              ? context._refToRC(token.value)
              : null;

            if (coords) {
              const dr = coords.r - baseR;
              const dc = coords.c - baseC;
              parts.push(`ctx.v(baseR + ${dr}, baseC + ${dc})`);
            } else {
              parts.push(`ctx.val('${token.value}')`);
            }
          }
          break;
        case 'OP': {
          const op = token.value;
          if (op === '=') parts.push(' === ');
          else if (op === '<>') parts.push(' !== ');
          else if (op === '<=' || op === '>=' || op === '<' || op === '>') parts.push(` ${op} `);
          else if ('+-*/'.includes(op)) parts.push(` ${op} `);
          else if (op === ',') parts.push(', ');
          else parts.push(op);
          break;
        }
      }
    }
    return parts.join('');
  }
}

export const formulaCompiler = new FormulaCompiler();
