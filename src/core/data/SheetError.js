/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 表格错误处理模块
 *
 * 提供统一的错误处理机制：
 * 1. SheetError - 自定义错误类，包含错误码和详情
 * 2. ErrorCodes - 标准化错误码常量
 * 3. ErrorHandler - 全局错误处理器，支持事件通知
 */
import { RingBuffer } from '../utils/Queues.js';

/**
 * 错误码常量
 * @enum {string}
 */
export const ErrorCodes = {
  // 公式相关错误
  FORMULA_ERROR: 'FORMULA_ERROR',           // 通用公式错误
  FORMULA_SYNTAX: 'FORMULA_SYNTAX',         // 公式语法错误
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',     // 除零错误
  INVALID_REFERENCE: 'INVALID_REFERENCE',   // 无效引用
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE', // 循环引用
  UNKNOWN_FUNCTION: 'UNKNOWN_FUNCTION',     // 未知函数
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',     // 无效参数
  VALUE_ERROR: 'VALUE_ERROR',               // 值错误
  NUM_ERROR: 'NUM_ERROR',                   // 数值错误（如负数开平方）
  
  // 数据操作错误
  CELL_NOT_FOUND: 'CELL_NOT_FOUND',         // 单元格未找到
  INVALID_RANGE: 'INVALID_RANGE',           // 无效范围
  MERGE_ERROR: 'MERGE_ERROR',               // 合并错误
  DATA_LOAD_ERROR: 'DATA_LOAD_ERROR',       // 数据加载错误
  
  // 文件操作错误
  FILE_READ_ERROR: 'FILE_READ_ERROR',       // 文件读取错误
  FILE_WRITE_ERROR: 'FILE_WRITE_ERROR',     // 文件写入错误
  INVALID_FORMAT: 'INVALID_FORMAT',         // 格式无效
  
  // 通用错误
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',           // 未知错误
  OPERATION_FAILED: 'OPERATION_FAILED'      // 操作失败
};

/**
 * Excel 风格的错误值映射
 * @type {Object<string, string>}
 */
export const ExcelErrorValues = {
  [ErrorCodes.DIVISION_BY_ZERO]: '#DIV/0!',
  [ErrorCodes.VALUE_ERROR]: '#VALUE!',
  [ErrorCodes.INVALID_REFERENCE]: '#REF!',
  [ErrorCodes.UNKNOWN_FUNCTION]: '#NAME?',
  [ErrorCodes.NUM_ERROR]: '#NUM!',
  [ErrorCodes.CIRCULAR_REFERENCE]: '#CYCLE!',
  [ErrorCodes.FORMULA_ERROR]: '#ERROR!',
  [ErrorCodes.INVALID_ARGUMENT]: '#VALUE!',
  [ErrorCodes.FORMULA_SYNTAX]: '#ERROR!'
};

/**
 * 错误消息模板
 * @type {Object<string, string>}
 */
export const ErrorMessages = {
  [ErrorCodes.FORMULA_ERROR]: '公式计算错误',
  [ErrorCodes.FORMULA_SYNTAX]: '公式语法错误: {detail}',
  [ErrorCodes.DIVISION_BY_ZERO]: '除数不能为零',
  [ErrorCodes.INVALID_REFERENCE]: '无效的单元格引用: {ref}',
  [ErrorCodes.CIRCULAR_REFERENCE]: '检测到循环引用: {cells}',
  [ErrorCodes.UNKNOWN_FUNCTION]: '未知函数: {fn}',
  [ErrorCodes.INVALID_ARGUMENT]: '函数参数无效: {detail}',
  [ErrorCodes.VALUE_ERROR]: '值类型错误: {detail}',
  [ErrorCodes.NUM_ERROR]: '数值错误: {detail}',
  [ErrorCodes.CELL_NOT_FOUND]: '单元格不存在: {cell}',
  [ErrorCodes.INVALID_RANGE]: '无效的范围: {range}',
  [ErrorCodes.MERGE_ERROR]: '合并单元格失败: {detail}',
  [ErrorCodes.DATA_LOAD_ERROR]: '数据加载失败: {detail}',
  [ErrorCodes.FILE_READ_ERROR]: '文件读取失败: {detail}',
  [ErrorCodes.FILE_WRITE_ERROR]: '文件写入失败: {detail}',
  [ErrorCodes.INVALID_FORMAT]: '文件格式无效: {detail}',
  [ErrorCodes.UNKNOWN_ERROR]: '未知错误',
  [ErrorCodes.OPERATION_FAILED]: '操作失败: {operation}'
};

/**
 * 表格错误类
 * @extends Error
 */
export class SheetError extends Error {
  /**
   * @param {string} code - 错误码（使用 ErrorCodes 常量）
   * @param {string} [message] - 错误消息（可选，默认使用模板）
   * @param {Object} [details] - 错误详情
   */
  constructor(code, message, details = {}) {
    // 如果未提供消息，使用模板生成
    if (!message) {
      const template = ErrorMessages[code] || ErrorMessages[ErrorCodes.UNKNOWN_ERROR];
      message = template.replace(/\{(\w+)\}/g, (match, key) => {
        return details[key] !== undefined ? String(details[key]) : match;
      });
    }
    
    super(message);
    this.name = 'SheetError';
    this.code = code;
    this.details = details;
    this.excelValue = ExcelErrorValues[code] || '#ERROR!';
    
    // 保持正确的堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SheetError);
    }
  }

  /**
   * 转换为 Excel 风格的错误值
   * @returns {string} Excel 错误值（如 #DIV/0!）
   */
  toExcelValue() {
    return this.excelValue;
  }

  /**
   * 转换为 JSON 格式
   * @returns {Object} JSON 对象
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      excelValue: this.excelValue
    };
  }

  /**
   * 从错误对象创建 SheetError
   * @param {Error} error - 原始错误
   * @param {string} [code] - 错误码
   * @param {Object} [details] - 详情
   * @returns {SheetError}
   */
  static from(error, code = ErrorCodes.UNKNOWN_ERROR, details = {}) {
    if (error instanceof SheetError) {
      return error;
    }
    return new SheetError(code, error.message, {
      ...details,
      originalError: error.name,
      stack: error.stack
    });
  }

  /**
   * 判断是否为 Excel 错误值
   * @param {*} value - 要检查的值
   * @returns {boolean}
   */
  static isExcelError(value) {
    if (typeof value !== 'string') return false;
    return /^#(DIV\/0!|VALUE!|REF!|NAME\?|NUM!|CYCLE!|ERROR!|N\/A|OP!)$/.test(value) || value.startsWith('#ERR:');
  }

  /**
   * 创建除零错误
   * @returns {SheetError}
   */
  static divisionByZero() {
    return new SheetError(ErrorCodes.DIVISION_BY_ZERO);
  }

  /**
   * 创建值错误
   * @param {string} [detail] - 详情
   * @returns {SheetError}
   */
  static valueError(detail = '') {
    return new SheetError(ErrorCodes.VALUE_ERROR, null, { detail });
  }

  /**
   * 创建循环引用错误
   * @param {string} cells - 涉及的单元格
   * @returns {SheetError}
   */
  static circularReference(cells) {
    return new SheetError(ErrorCodes.CIRCULAR_REFERENCE, null, { cells });
  }

  /**
   * 创建未知函数错误
   * @param {string} fn - 函数名
   * @returns {SheetError}
   */
  static unknownFunction(fn) {
    return new SheetError(ErrorCodes.UNKNOWN_FUNCTION, null, { fn });
  }

  /**
   * 创建无效引用错误
   * @param {string} ref - 引用
   * @returns {SheetError}
   */
  static invalidReference(ref) {
    return new SheetError(ErrorCodes.INVALID_REFERENCE, null, { ref });
  }
}

/**
 * 全局错误处理器
 */
export class ErrorHandler {
  /**
   * @param {Object} options - 配置选项
   * @param {EventEmitter} [options.eventEmitter] - 事件发射器
   * @param {Function} [options.onError] - 错误回调
   * @param {boolean} [options.logToConsole=true] - 是否输出到控制台
   */
  constructor(options = {}) {
    this.eventEmitter = options.eventEmitter;
    this.onError = options.onError;
    this.logToConsole = options.logToConsole !== false;
    this.maxHistorySize = 100;
    this.errorHistory = new RingBuffer(this.maxHistorySize);
  }

  /**
   * 处理错误
   * @param {Error|SheetError} error - 错误对象
   * @param {Object} [context] - 错误上下文
   * @returns {SheetError} 处理后的错误
   */
  handle(error, context = {}) {
    // 转换为 SheetError
    const sheetError = error instanceof SheetError 
      ? error 
      : SheetError.from(error, ErrorCodes.UNKNOWN_ERROR, context);

    // 记录到历史
    this._addToHistory(sheetError, context);

    // 输出到控制台
    if (this.logToConsole) {
      this._logError(sheetError, context);
    }

    // 触发事件
    if (this.eventEmitter) {
      this.eventEmitter.emit('error', {
        error: sheetError,
        context,
        timestamp: Date.now()
      });
    }

    // 调用回调
    if (this.onError) {
      try {
        this.onError(sheetError, context);
      } catch (e) {
        console.error('Error in error handler callback:', e);
      }
    }

    return sheetError;
  }

  /**
   * 包装函数，自动捕获错误
   * @param {Function} fn - 要包装的函数
   * @param {Object} [defaultContext] - 默认上下文
   * @returns {Function} 包装后的函数
   */
  wrap(fn, defaultContext = {}) {
    return (...args) => {
      try {
        const result = fn(...args);
        // 处理 Promise 返回值
        if (result && typeof result.then === 'function') {
          return result.catch(err => {
            throw this.handle(err, { ...defaultContext, args });
          });
        }
        return result;
      } catch (err) {
        throw this.handle(err, { ...defaultContext, args });
      }
    };
  }

  /**
   * 安全执行函数，错误时返回默认值
   * @param {Function} fn - 要执行的函数
   * @param {*} defaultValue - 错误时的默认值
   * @param {Object} [context] - 错误上下文
   * @returns {*} 函数结果或默认值
   */
  safeExecute(fn, defaultValue, context = {}) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        return result.catch(() => defaultValue);
      }
      return result;
    } catch (err) {
      this.handle(err, context);
      return defaultValue;
    }
  }

  /**
   * 添加错误到历史记录
   * @private
   */
  _addToHistory(error, context) {
    // RingBuffer 已自带容量上限淘汰
    this.errorHistory.push({
      error: error.toJSON(),
      context,
      timestamp: Date.now()
    });
  }

  /**
   * 输出错误到控制台
   * @private
   */
  _logError(error, context) {
    const prefix = `[SheetError ${error.code}]`;
    const contextStr = Object.keys(context).length > 0 
      ? ` Context: ${JSON.stringify(context)}` 
      : '';
    
    console.error(`${prefix} ${error.message}${contextStr}`);
    
    if (error.details && Object.keys(error.details).length > 0) {
      console.error('Details:', error.details);
    }
  }

  /**
   * 获取错误历史
   * @param {number} [limit] - 限制数量
   * @returns {Array} 错误历史
   */
  getHistory(limit) {
    if (limit) {
      return this.errorHistory.lastN(limit);
    }
    return this.errorHistory.toArray();
  }

  /**
   * 清空错误历史
   */
  clearHistory() {
    this.errorHistory.clear();
  }
}

// 创建默认错误处理器实例
export const defaultErrorHandler = new ErrorHandler();

/**
 * 便捷方法：处理错误
 * @param {Error} error - 错误对象
 * @param {Object} [context] - 上下文
 * @returns {SheetError}
 */
export function handleError(error, context) {
  return defaultErrorHandler.handle(error, context);
}

/**
 * 便捷方法：安全执行
 * @param {Function} fn - 函数
 * @param {*} defaultValue - 默认值
 * @param {Object} [context] - 上下文
 * @returns {*}
 */
export function safeExecute(fn, defaultValue, context) {
  return defaultErrorHandler.safeExecute(fn, defaultValue, context);
}