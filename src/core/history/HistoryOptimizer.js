/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
export class HistoryOptimizer {
  constructor(historyManager) {
    this.history = historyManager;

    // 压缩配置
    this.config = {
      memoryThreshold: 5 * 1024 * 1024,  // 5MB内存阈值
      compressionThreshold: 50,             // 压缩阈值（条目数）
      minMergeInterval: 100,                // 最小合并间隔(ms)
      maxMergeWindow: 2000                  // 最大合并窗口(ms)
    };

    // 增量内存追踪（O(1) 查询，避免每次全量扫描）
    this.memoryUsage = 0;
    this.lastMemoryCheck = 0;

    // 合并策略映射
    this.mergeStrategies = new Map([
      ['set-cell', this._mergeSetCell.bind(this)],
      ['batch-set-cell', this._mergeBatchSetCell.bind(this)],
      ['set-col-width', this._mergeNumeric.bind(this)],
      ['set-row-height', this._mergeNumeric.bind(this)]
    ]);
  }

  // ─── 增量内存追踪 API ───────────────────────────────────

  /**
   * 命令入栈时调用：累加估算大小
   */
  trackPush(cmd) {
    this.memoryUsage += this._estimateCommandSize(cmd);
  }

  /**
   * 命令出栈时调用：扣减估算大小
   */
  trackRemove(cmd) {
    this.memoryUsage -= this._estimateCommandSize(cmd);
    if (this.memoryUsage < 0) this.memoryUsage = 0;
  }

  /**
   * 整个栈清空时调用：扣减栈内所有命令的大小
   */
  trackClearStack(stack) {
    for (const cmd of stack) {
      this.memoryUsage -= this._estimateCommandSize(cmd);
    }
    if (this.memoryUsage < 0) this.memoryUsage = 0;
  }

  // ─── 压缩入口 ───────────────────────────────────────────

  /**
   * 智能压缩历史记录
   */
  compressHistory() {
    const now = Date.now();

    // O(1) 内存检查（增量追踪，无需遍历）
    if (this.memoryUsage > this.config.memoryThreshold) {
      this._compressByMemory();
      return;
    }

    // 检查条目数量
    if (this.history.undoStack.length > this.config.compressionThreshold) {
      this._compressBySize();
    }

    // 定期压缩（每30秒）
    if (now - this.lastMemoryCheck > 30000) {
      this._optimizeMemory();
      this.lastMemoryCheck = now;
    }
  }

  // ─── 估算逻辑 ───────────────────────────────────────────

  /**
   * 估算命令大小（字节）
   */
  _estimateCommandSize(cmd) {
    let size = 100; // 基础开销

    if (cmd.oldValue) {
      size += this._estimateValueSize(cmd.oldValue);
    }
    if (cmd.newValue) {
      size += this._estimateValueSize(cmd.newValue);
    }
    if (cmd.changes) {
      size += cmd.changes.length * 200; // 每个变更约200字节
    }
    if (cmd.cmds) {
      for (const subCmd of cmd.cmds) {
        size += this._estimateCommandSize(subCmd);
      }
    }

    return size;
  }

  _estimateValueSize(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'string') return val.length * 2; // UTF-16
    if (typeof val === 'number') return 8;
    if (typeof val === 'boolean') return 1;
    if (typeof val === 'object') return JSON.stringify(val).length * 2;
    return 100;
  }

  // ─── 内部压缩方法 ───────────────────────────────────────

  /**
   * 清空 redo 栈并追踪内存扣减
   */
  _clearRedoStack() {
    this.trackClearStack(this.history.redoStack);
    this.history.redoStack.clear();
  }

  /**
   * 基于内存压缩：保留最近 50 条，逐个 shift 并追踪扣减
   */
  _compressByMemory() {
    while (this.history.undoStack.length > 50) {
      const removed = this.history.undoStack.shift();
      this.trackRemove(removed);
    }
    this._clearRedoStack();
  }

  /**
   * 基于大小压缩（智能合并）
   */
  _compressBySize() {
    const undoStack = this.history.undoStack;
    const target = Math.floor(undoStack.length * 0.6);
    const compressed = [];

    let i = 0;
    while (i < undoStack.length && compressed.length < target) {
      const cmd = undoStack.get(i);
      const merged = this._tryCompressCommand(cmd, i);

      if (merged) {
        compressed.push(merged);
        i += this._getMergedCount(cmd, i);
      } else {
        compressed.push(cmd);
        i++;
      }
    }

    // 先扣减旧栈内存，再整体替换，最后累加新栈内存
    this.trackClearStack(undoStack);
    undoStack.replace(compressed);
    for (const cmd of compressed) this.trackPush(cmd);

    this._clearRedoStack();
  }

  /**
   * 尝试压缩单个命令
   */
  _tryCompressCommand(cmd, index) {
    const strategy = this.mergeStrategies.get(cmd.type);
    if (!strategy) return null;

    const undoStack = this.history.undoStack;
    const lookAhead = Math.min(10, undoStack.length - index - 1);
    const candidates = [cmd, ...undoStack.slice(index + 1, index + 1 + lookAhead)];

    return strategy(candidates);
  }
  
  /**
   * 合并set-cell命令（优化版本）
   */
  _mergeSetCell(candidates) {
    if (candidates.length < 2) return null;
    
    const first = candidates[0];
    const merged = {
      type: 'set-cell',
      r: first.r,
      c: first.c,
      oldValue: first.oldValue,
      newValue: first.newValue,
      mergedCount: 1
    };
    
    // 检查是否可以合并（同一单元格，短时间内）
    for (let i = 1; i < candidates.length; i++) {
      const cmd = candidates[i];
      if (cmd.type !== 'set-cell') break;
      if (cmd.r !== first.r || cmd.c !== first.c) break;
      
      merged.newValue = cmd.newValue;
      merged.mergedCount++;
    }
    
    return merged.mergedCount > 1 ? merged : null;
  }
  
  /**
   * 合并批量设置单元格
   */
  _mergeBatchSetCell(candidates) {
    // 合并相邻的batch-set-cell命令
    const batches = candidates.filter(c => c.type === 'batch-set-cell');
    if (batches.length < 2) return null;
    
    const allChanges = [];
    for (const batch of batches) {
      allChanges.push(...batch.changes);
    }
    
    return {
      type: 'batch-set-cell',
      changes: allChanges
    };
  }
  
  /**
   * 合并数值类型命令（行高、列宽等）
   */
  _mergeNumeric(candidates) {
    if (candidates.length < 2) return null;
    
    const first = candidates[0];
    const sameType = candidates.every(c => c.type === first.type && c.c === first.c);
    
    if (!sameType) return null;
    
    // 只保留最新的值，最早的旧值
    return {
      type: first.type,
      c: first.c,
      oldValue: first.oldValue,
      newValue: candidates[candidates.length - 1].newValue
    };
  }
  
  _getMergedCount(cmd, index) {
    const strategy = this.mergeStrategies.get(cmd.type);
    if (!strategy) return 1;

    const candidates = [cmd, ...this.history.undoStack.slice(index + 1, index + 11)];
    const merged = strategy(candidates);
    return merged ? merged.mergedCount || 1 : 1;
  }

  /**
   * 优化内存使用
   */
  _optimizeMemory() {
    // 清理redo栈（超过10条就清空）
    if (this.history.redoStack.length > 10) {
      this._clearRedoStack();
    }

    // 深度克隆大型命令，释放引用
    const undoStack = this.history.undoStack;
    for (let i = 0; i < undoStack.length; i++) {
      const cmd = undoStack.get(i);
      if (cmd.changes && cmd.changes.length > 100) {
        // 保留引用但标记为可压缩
        cmd._compressible = true;
      }
    }
  }
}