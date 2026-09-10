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
import { FormulaRPNEvaluator, createError, ErrorCodes } from '../core/data/FormulaRPNEvaluator.js';
import { isWasmFormulaSupported } from '../core/data/WasmFormulaSupport.js';

let wasmBridge = null;

// 数据类型标识（与 TransferableSerializer 保持一致）
const DataType = {
  NULL: 0, UNDEFINED: 1, BOOLEAN: 2, NUMBER: 3,
  STRING: 4, OBJECT: 5, ARRAY: 6, CELL_DATA: 7, FORMULA_BATCH: 8
};

// ========== 共享内存管理 (SharedArrayBuffer) ==========
let sharedBufferView = null; // 兼容旧格式
let sharedChunks = new Map(); // 新格式：chunkIdx -> Float64Array
let sharedContinuousView = null;
let sharedContinuousRows = 0;
let sharedContinuousCols = 0;
let sharedMaxRows = 100000;
let sharedMaxCols = 256;
let sharedChunkSize = 1024;
let sharedChunkCols = 256;
const EMPTY_VALUE = -Infinity;

function getSharedValue(r, c) {
  // 1. 优先检查连续视图（compact continuous 格式）
  if (sharedContinuousView) {
    if (
      r < 0 || r >= sharedContinuousRows ||
      c < 0 || c >= sharedContinuousCols
    ) return EMPTY_VALUE;
    return sharedContinuousView[r * sharedContinuousCols + c];
  }

  // 2. 优先检查连续视图 (旧格式)
  if (sharedBufferView) {
    if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return EMPTY_VALUE;
    return sharedBufferView[r * sharedMaxCols + c];
  }

  // 3. 检查分块视图 (新格式)
  if (sharedChunks.size > 0) {
    if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return EMPTY_VALUE;
    const chunkIdx = Math.floor(r / sharedChunkSize);
    const view = sharedChunks.get(chunkIdx);
    if (!view) return EMPTY_VALUE;
    
    const rowInChunk = r % sharedChunkSize;
    return view[rowInChunk * sharedChunkCols + c];
  }

  return EMPTY_VALUE;
}

function updateSharedChunks(data) {
  if (!data) return;

  if (data instanceof SharedArrayBuffer) {
    // 兼容旧格式
    sharedChunks.clear();
    sharedContinuousView = null;
    sharedContinuousRows = 0;
    sharedContinuousCols = 0;
    sharedBufferView = new Float64Array(data);
  } else {
    // 处理新格式
    sharedBufferView = null;
    sharedChunks.clear();
    sharedContinuousView = null;
    sharedContinuousRows = 0;
    sharedContinuousCols = 0;

    sharedMaxRows = data.maxRows || sharedMaxRows;
    sharedMaxCols = data.maxCols || sharedMaxCols;
    sharedChunkSize = data.chunkSize || 1024;
    sharedChunkCols = sharedMaxCols;

    if (data.continuousBuffer instanceof SharedArrayBuffer) {
      sharedContinuousView = new Float64Array(data.continuousBuffer);
      sharedContinuousRows = data.continuousRows || sharedMaxRows;
      sharedContinuousCols = data.continuousCols || sharedMaxCols;
    }

    if (!sharedContinuousView) {
      const firstBuffer = data.chunks ? Object.values(data.chunks)[0] : null;
      if (firstBuffer instanceof SharedArrayBuffer) {
        sharedChunkCols =
          data.chunkCols ||
          Math.floor(new Float64Array(firstBuffer).length / sharedChunkSize);
      }

      for (const idx in data.chunks || {}) {
        const buffer = data.chunks[idx];
        if (buffer instanceof SharedArrayBuffer) {
          sharedChunks.set(parseInt(idx, 10), new Float64Array(buffer));
        }
      }
    }
  }
}

// ========== Worker 消息处理 ==========

/** @type {FormulaRPNEvaluator|null} */
let evaluator = null;

/**
 * 创建/更新 Worker 端共享公式求值器实例。
 * 通过 getCellValue 回调桥接 Worker 的 dataProvider 模式到共享 RPN 引擎。
 */
function ensureEvaluator(dataProvider) {
  const getCellValue = (r, c, stack) => {
    const key = cellKey(r, c);
    // 循环引用检测由共享引擎内置的 _getCell 处理，此处仅提供原始值
    return dataProvider(key, stack);
  };

  if (evaluator) {
    // 更新 getCellValue 回调以使用新的 dataProvider
    evaluator._getCellValue = getCellValue;
  } else {
    evaluator = new FormulaRPNEvaluator({ getCellValue });
  }
}

/**
 * 处理单个公式计算
 */
function handleEvaluate(task) {
  const { formula, cellId, context } = task;

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
  ensureEvaluator(dataProvider);

  // 按拓扑顺序计算
  const sortedFormulas = topologicalSort(formulas, data, evaluator.parser);

  for (const { cellId, formula, hasCycle } of sortedFormulas) {
    let result;
    if (hasCycle) {
      result = '#CYCLE!';
    } else {
      try {
        result = evaluator.evaluate(formula, { stack: [cellId] });
        if (typeof result === 'number' && isNaN(result)) {
          result = createError(ErrorCodes.VALUE_ERROR);
        }
      } catch (e) {
        // 防御性捕获：当局部拓扑排序因缺少全局依赖图而漏检环时，
        // RPN 求值器会通过栈检测发现环引用并抛出 #CYCLE! 异常。
        if (e.message === '#CYCLE!') {
          result = '#CYCLE!';
        } else {
          result = createError(ErrorCodes.FORMULA_ERROR);
        }
      }
    }
    results[cellId] = result;
    // 关键修复：非数字结果（如 #CYCLE!）必须在 SharedArrayBuffer 中
    // 写入 EMPTY_VALUE（-Infinity），防止主线程 getCellValue 读取到
    // WASM 引擎残留的默认值 0.0，导致渲染层显示 0 而非错误字符串。
    if (typeof result !== 'number' || isNaN(result)) {
      const { r, c } = parseCellKey(cellId);
      setSharedValue(r, c, EMPTY_VALUE);
    }
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
  if (!parser) parser = new FormulaRPNEvaluator({ getCellValue: () => null }).parser;
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
        fc.hasCycle = true;
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

/**
 * Worker 端 WASM 共享内存绑定 / 重新绑定
 *
 * 当 sharedChunks 包含 continuousBuffer（连续缓冲区）时，优先使用其绑定 WASM；
 * 兼容旧格式直接传入 SharedArrayBuffer 实例的场景。
 *
 * 每次主线程发送消息时都会调用此函数：
 * - WASM 已加载：立即 re-bind（缓冲区扩容后 continuousBuffer 指向新 SAB）
 * - WASM 未加载：跳过（由异步初始化路径处理首次绑定）
 */
function tryBindWasmMemory(sharedChunks) {
  if (!wasmBridge || !wasmBridge.isLoaded) return;

  if (sharedChunks && sharedChunks.continuousBuffer instanceof SharedArrayBuffer) {
    // 新格式：从序列化对象中获取连续缓冲区
    wasmBridge.rebindSharedMemory(
      sharedChunks.continuousBuffer,
      sharedChunks.continuousRows || sharedMaxRows,
      sharedChunks.continuousCols || sharedMaxCols
    );
  } else if (sharedChunks instanceof SharedArrayBuffer) {
    // 旧格式兼容：直接传入 SharedArrayBuffer
    wasmBridge.bindSharedMemory(sharedChunks, sharedMaxRows, sharedMaxCols);
  }
}

function postWasmInitFailed(error, phase = 'wasm-bridge') {
  const message = error?.message || String(error || 'Unknown WASM initialization error');
  console.warn('WASM bridge loading skipped:', error);
  self.postMessage({
    type: 'init-failed',
    subsystem: 'wasm',
    phase,
    error: message,
    fallback: 'js'
  });
}

self.onmessage = function(e) {
  const { type, taskId, useTransferable, buffer, sharedChunks, sharedRows, sharedCols, ...task } = e.data;

  if (sharedRows) sharedMaxRows = sharedRows;
  if (sharedCols) sharedMaxCols = sharedCols;

  // 更新共享内存分块视图 + WASM 绑定/重新绑定
  if (sharedChunks) {
    updateSharedChunks(sharedChunks);

    // 同步路径：WASM 已加载 → 立即重新绑定（处理缓冲区扩容后的 rebind）
    tryBindWasmMemory(sharedChunks);

    // 异步路径：首次加载 WASM 桥接
    if (!wasmBridge) {
      import('../core/worker/WasmBridge.js').then(m => {
        wasmBridge = new m.WasmBridge();
        return wasmBridge.init();
      }).then((loaded) => {
        if (!loaded) {
          const status = wasmBridge?.getStatus ? wasmBridge.getStatus() : {};
          throw new Error(status.fallbackReason || 'WASM bridge initialization returned false');
        }
        tryBindWasmMemory(sharedChunks);
      }).catch(err => postWasmInitFailed(err));
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

  ensureEvaluator(dataProvider);

  // 2. 拓扑排序
  const sortedFormulas = topologicalSort(formulas, data, evaluator.parser);
  
  // 3. 顺序计算
  for (const fc of sortedFormulas) {
    const { cellId, formula, hasCycle } = fc;
    let result;

    if (hasCycle) {
      result = '#CYCLE!';
    } else if (wasmBridge && wasmBridge.isLoaded && isWasmFormulaSupported(formula)) {
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
        // 数字结果优先写共享内存；目标越界时回退到 results 传输。
        if (!setSharedValue(r, c, result)) {
            results[cellId] = result;
        }
    } else {
        // 非数字结果不能写入 Float64 共享内存，走 results 传输。
        results[cellId] = result;
        setSharedValue(r, c, EMPTY_VALUE);
    }
    
    // 更新本地数据引用，供后续公式依赖使用
    if (data[cellId]) {
      data[cellId].v = result;
    }
  }

  return results;
}

function setSharedValue(r, c, val) {
  if (r < 0 || r >= sharedMaxRows || c < 0 || c >= sharedMaxCols) return false;

  // 优先 compact continuous 视图
  if (sharedContinuousView) {
    if (
      r >= sharedContinuousRows ||
      c >= sharedContinuousCols
    ) return false;
    sharedContinuousView[r * sharedContinuousCols + c] = val;
    return true;
  }

  // 兼容旧连续视图
  if (sharedBufferView) {
    sharedBufferView[r * sharedMaxCols + c] = val;
    return true;
  }

  // 分块视图
  if (sharedChunks.size > 0) {
    const chunkIdx = Math.floor(r / sharedChunkSize);
    const view = sharedChunks.get(chunkIdx);
    if (!view) return false;
    view[(r % sharedChunkSize) * sharedChunkCols + c] = val;
    return true;
  }

  return false;
}
