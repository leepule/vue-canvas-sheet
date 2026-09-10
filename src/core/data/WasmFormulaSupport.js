/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

const TOKEN_PATTERN = /\s*(\d+(?:\.\d+)?|[()+\-*/])\s*/gy;
const BINARY_OPERATORS = new Set(['+', '-', '*', '/']);

function tokenizeNumericExpression(expression) {
  const tokens = [];
  let cursor = 0;

  while (cursor < expression.length) {
    TOKEN_PATTERN.lastIndex = cursor;
    const tokenMatch = TOKEN_PATTERN.exec(expression);
    if (!tokenMatch || tokenMatch.index !== cursor) return null;
    tokens.push(tokenMatch[1]);
    cursor = TOKEN_PATTERN.lastIndex;
  }

  return tokens;
}

function isNumberToken(token) {
  return /^\d+(?:\.\d+)?$/.test(token);
}

function hasValidNumericSyntax(tokens) {
  let expectOperand = true;
  let parenthesisDepth = 0;

  for (const token of tokens) {
    if (expectOperand) {
      if (isNumberToken(token)) {
        expectOperand = false;
      } else if (token === '(') {
        parenthesisDepth++;
      } else {
        return false;
      }
      continue;
    }

    if (BINARY_OPERATORS.has(token)) {
      expectOperand = true;
    } else if (token === ')' && parenthesisDepth > 0) {
      parenthesisDepth--;
    } else {
      return false;
    }
  }

  return tokens.length > 0 && !expectOperand && parenthesisDepth === 0;
}

/**
 * 仅允许已通过 JS/WASM parity 验证的纯数字二元算术。
 * 引用、函数、字符串、布尔值、比较和一元负号在语义统一前固定走 JS。
 */
export function isWasmFormulaSupported(formula) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return false;
  const tokens = tokenizeNumericExpression(formula.slice(1));
  return tokens !== null && hasValidNumericSyntax(tokens);
}
