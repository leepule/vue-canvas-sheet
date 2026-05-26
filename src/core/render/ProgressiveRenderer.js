/**
 * 渐进式渲染器
 *
 * 优化策略：
 * 1. 分帧渲染：将大块渲染任务拆分成多个小任务
 * 2. 时间切片：每帧分配固定时间预算，超时延后
 * 3. 优先级调度：优先渲染可见区域
 * 4. 任务中断：支持中断和恢复渲染
 */

/**
 * 单优先级任务队列：head-pointer + tombstone 标记 + 单槽 pendingFront。
 *
 * 替代旧的 `[].push / .shift / .splice(index,1) / .unshift` 模式：
 * - push: O(1)
 * - shift: O(1) 摊还（跳过已 cancel 的 tombstone）
 * - unshift（任务未完成放回头部）: O(1)，专用 pendingFront 槽
 * - cancelById: O(1) 通过 idMap 标记
 * - cancelAll: O(n) 一次遍历
 */
class TaskQueue {
  constructor() {
    this.tasks = [];
    this.head = 0;
    this.pendingFront = null;       // 上一帧未完成、回放到队首的任务
    this.idMap = new Map();          // id -> task 引用，用于 O(1) cancelById
    this._activeCount = 0;           // 未被取消、未被消费、未被完成的任务数
  }

  get length() {
    return this._activeCount;
  }

  push(task) {
    this.tasks.push(task);
    this.idMap.set(task.id, task);
    this._activeCount++;
  }

  /** 将一个任务放回队首。仅供「任务在 _runFrame 中未跑完」时使用，最多一个槽。 */
  unshiftFront(task) {
    if (this.pendingFront && !this.pendingFront._cancelled) {
      // 极端情况下若上一个 pendingFront 尚未消费，按原始数组语义放回 tasks 队首
      this.tasks.unshift(this.pendingFront);
    }
    this.pendingFront = task;
    this.idMap.set(task.id, task);
    this._activeCount++;
  }

  /** 取下一个待执行任务，自动跳过 cancelled tombstone */
  shift() {
    if (this.pendingFront) {
      const t = this.pendingFront;
      this.pendingFront = null;
      if (t._cancelled) {
        // 已取消则直接跳过；activeCount 在 cancel 时已扣减
        return this.shift();
      }
      this.idMap.delete(t.id);
      this._activeCount--;
      return t;
    }

    while (this.head < this.tasks.length) {
      const t = this.tasks[this.head++];
      if (t._cancelled) continue; // tombstone
      this.idMap.delete(t.id);
      this._activeCount--;
      this._compactIfDrained();
      return t;
    }
    this._compactIfDrained();
    return null;
  }

  /** O(1) cancel by id；返回是否实际取消了一个尚未被消费的任务 */
  cancelById(id) {
    const t = this.idMap.get(id);
    if (!t || t._cancelled) return null;
    t._cancelled = true;
    this.idMap.delete(id);
    this._activeCount--;
    return t;
  }

  /** 对每个仍 active 的任务调用 cb，然后整体清空 */
  cancelAll(cb) {
    if (this.pendingFront && !this.pendingFront._cancelled) {
      this.pendingFront._cancelled = true;
      cb(this.pendingFront);
    }
    this.pendingFront = null;
    for (let i = this.head; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      if (!t._cancelled) {
        t._cancelled = true;
        cb(t);
      }
    }
    this.tasks.length = 0;
    this.head = 0;
    this.idMap.clear();
    this._activeCount = 0;
  }

  _compactIfDrained() {
    // 全部消费完毕：重置数组与 head，避免内存累积
    if (this.head >= this.tasks.length) {
      this.tasks.length = 0;
      this.head = 0;
    }
  }
}

/**
 * 任务优先级枚举
 */
export const Priority = {
  CRITICAL: 0,   // 冻结区域、活动单元格
  HIGH: 1,       // 可见区域
  NORMAL: 2,     // 缓冲区域
  LOW: 3         // 预加载区域
};

/**
 * 任务状态枚举 */
export const TaskState = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

/**
 * 渲染任务定义
 */
class RenderTask {
  /**
   * @param {Object} options
   * @param {string} options.id - 任务唯一标识
   * @param {number} options.priority - 优先级
   * @param {Function} options.execute - 执行函数，返回 { done: boolean, progress: number }
   * @param {Function} [options.onComplete] - 完成回调
   * @param {Function} [options.onCancel] - 取消回调
   * @param {number} [options.estimatedTime] - 预估执行时间(ms)
   */
  constructor(options) {
    this.id = options.id;
    this.priority = options.priority;
    this.execute = options.execute;
    this.onComplete = options.onComplete;
    this.onCancel = options.onCancel;
    this.estimatedTime = options.estimatedTime || 0;
    
    this.state = TaskState.PENDING;
    this.progress = 0;
    this.startTime = 0;
    this.elapsedTime = 0;
  }

  /**
   * 重置任务状态以便重新执行
   */
  reset() {
    this.state = TaskState.PENDING;
    this.progress = 0;
    this.startTime = 0;
    this.elapsedTime = 0;
  }
}

/**
 * 渐进式渲染器核心类
 */
class ProgressiveRenderer {
  /**
   * @param {Object} options
   * @param {number} [options.frameBudget] - 每帧时间预算(ms)，默认 8ms
   * @param {number} [options.maxTasksPerFrame] - 每帧最大任务数，默认 10
   * @param {boolean} [options.useIdleCallback] - 是否使用 requestIdleCallback
   */
  constructor(options = {}) {
    this.frameBudget = options.frameBudget || 8; // 8ms 预算，保证 60fps
    this.maxTasksPerFrame = options.maxTasksPerFrame || 10;
    this.useIdleCallback = options.useIdleCallback !== false && typeof requestIdleCallback === 'function';
    
    // 任务队列（按优先级分组）
    this.taskQueues = new Map([
      [Priority.CRITICAL, new TaskQueue()],
      [Priority.HIGH, new TaskQueue()],
      [Priority.NORMAL, new TaskQueue()],
      [Priority.LOW, new TaskQueue()]
    ]);
    
    // 当前执行的任务
    this.currentTask = null;
    
    // 调度状态
    this.isScheduled = false;
    this.isPaused = false;
    this.frameId = null;
    
    // 统计信息
    this.stats = {
      tasksCompleted: 0,
      tasksCancelled: 0,
      totalFrames: 0,
      totalRenderTime: 0,
      avgFrameTime: 0
    };
    
    // 回调
    this.onFrameStart = null;
    this.onFrameEnd = null;
    this.onAllTasksComplete = null;
    
    // 绑定方法
    this._runFrame = this._runFrame.bind(this);
  }

  /**
   * 添加渲染任务
   * @param {Object} options - RenderTask 构造参数
   * @returns {string} 任务 ID
   */
  addTask(options) {
    const task = new RenderTask(options);
    const queue = this.taskQueues.get(task.priority);
    if (queue) {
      queue.push(task);
    }
    return task.id;
  }

  /**
   * 批量添加任务
   * @param {Array<Object>} tasks - 任务数组
   */
  addTasks(tasks) {
    for (const options of tasks) {
      this.addTask(options);
    }
  }

  /**
   * 取消指定任务（O(1) 通过 idMap 标记 tombstone）
   * @param {string} taskId - 任务 ID
   */
  cancelTask(taskId) {
    for (const queue of this.taskQueues.values()) {
      const task = queue.cancelById(taskId);
      if (task) {
        task.state = TaskState.CANCELLED;
        if (task.onCancel) task.onCancel();
        this.stats.tasksCancelled++;
        return;
      }
    }
  }

  /**
   * 取消所有任务
   * @param {number} [minPriority] - 最小优先级，取消此优先级及以下的任务
   */
  cancelAllTasks(minPriority = Priority.CRITICAL) {
    for (const [priority, queue] of this.taskQueues) {
      if (priority >= minPriority) {
        queue.cancelAll((task) => {
          task.state = TaskState.CANCELLED;
          if (task.onCancel) task.onCancel();
          this.stats.tasksCancelled++;
        });
      }
    }
  }

  /**
   * 清空所有任务
   */
  clearAll() {
    this.cancelAllTasks();
    this.currentTask = null;
  }

  /**
   * 暂停渲染
   */
  pause() {
    this.isPaused = true;
    if (this.currentTask) {
      this.currentTask.state = TaskState.PAUSED;
    }
  }

  /**
   * 恢复渲染
   */
  resume() {
    this.isPaused = false;
    if (!this.isScheduled && this._hasPendingTasks()) {
      this._scheduleNextFrame();
    }
  }

  /**
   * 开始调度
   */
  start() {
    if (this.isScheduled) return;
    this.isPaused = false;
    this._scheduleNextFrame();
  }

  /**
   * 停止调度
   */
  stop() {
    this.isScheduled = false;
    this.isPaused = true;
    if (this.frameId) {
      if (this.useIdleCallback) {
        cancelIdleCallback(this.frameId);
      } else {
        cancelAnimationFrame(this.frameId);
      }
      this.frameId = null;
    }
  }

  /**
   * 检查是否有待处理任务
   * @returns {boolean}
   */
  _hasPendingTasks() {
    for (const queue of this.taskQueues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  /**
   * 获取下一个待执行任务
   * @returns {RenderTask|null}
   */
  _getNextTask() {
    // 按优先级顺序查找
    for (const queue of this.taskQueues.values()) {
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }

  /**
   * 调度下一帧
   */
  _scheduleNextFrame() {
    if (this.isScheduled || this.isPaused || !this._hasPendingTasks()) {
      return;
    }
    
    this.isScheduled = true;
    
    if (this.useIdleCallback) {
      this.frameId = requestIdleCallback(this._runFrame, {
        timeout: this.frameBudget * 2
      });
    } else {
      this.frameId = requestAnimationFrame(this._runFrame);
    }
  }

  /**
   * 执行一帧渲染
   * @param {IdleDeadline|number} deadline - 空闲截止时间或时间戳
   */
  _runFrame(deadline) {
    this.isScheduled = false;
    this.frameId = null;
    
    if (this.isPaused) return;
    
    const frameStart = performance.now();
    let remainingTime = this.frameBudget;
    
    // 计算 remainingTime
    if (typeof deadline === 'object' && deadline.timeRemaining) {
      remainingTime = Math.min(deadline.timeRemaining(), this.frameBudget);
    }
    
    // 帧开始回调
    if (this.onFrameStart) {
      this.onFrameStart(remainingTime);
    }
    
    let tasksExecuted = 0;
    
    // 执行任务直到时间用完或达到最大任务数
    while (remainingTime > 0 && tasksExecuted < this.maxTasksPerFrame && !this.isPaused) {
      // 获取下一个任务
      if (!this.currentTask) {
        this.currentTask = this._getNextTask();
      }
      
      if (!this.currentTask) {
        // 没有更多任务
        break;
      }
      
      const task = this.currentTask;
      task.state = TaskState.RUNNING;
      task.startTime = performance.now();
      
      try {
        // 执行任务
        const result = task.execute({
          remainingTime,
          progress: task.progress
        });
        
        if (result && result.done) {
          // 任务完成
          task.state = TaskState.COMPLETED;
          task.progress = 1;
          this.stats.tasksCompleted++;
          
          if (task.onComplete) {
            task.onComplete();
          }
          this.currentTask = null;
        } else {
          // 任务未完成，更新进度
          task.progress = result ? result.progress : task.progress;
          task.elapsedTime += performance.now() - task.startTime;
          
          // 将任务重新放回队列（保持优先级）
          const queue = this.taskQueues.get(task.priority);
          if (queue) {
            queue.unshiftFront(task);
          }
          this.currentTask = null;
        }
      } catch (error) {
        console.error(`[ProgressiveRenderer] Task ${task.id} error:`, error);
        task.state = TaskState.CANCELLED;
        this.stats.tasksCancelled++;
        this.currentTask = null;
      }
      
      tasksExecuted++;
      
      // 更新剩余时间
      const elapsed = performance.now() - frameStart;
      remainingTime = this.frameBudget - elapsed;
    }
    
    // 更新统计
    const frameTime = performance.now() - frameStart;
    this.stats.totalFrames++;
    this.stats.totalRenderTime += frameTime;
    this.stats.avgFrameTime = this.stats.totalRenderTime / this.stats.totalFrames;
    
    // 帧结束回调
    if (this.onFrameEnd) {
      this.onFrameEnd(frameTime, tasksExecuted);
    }
    
    // 检查是否还有待处理任务
    if (this._hasPendingTasks() && !this.isPaused) {
      this._scheduleNextFrame();
    } else if (!this._hasPendingTasks()) {
      // 所有任务完成
      if (this.onAllTasksComplete) {
        this.onAllTasksComplete();
      }
    }
  }

  /**
   * 获取统计信息
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      pendingTasks: this._countPendingTasks(),
      isPaused: this.isPaused,
      isScheduled: this.isScheduled
    };
  }

  /**
   * 统计待处理任务数量
   * @returns {number}
   */
  _countPendingTasks() {
    let count = 0;
    for (const queue of this.taskQueues.values()) {
      count += queue.length;
    }
    return count;
  }

  /**
   * 销毁渲染器
   */
  destroy() {
    this.stop();
    this.clearAll();
    this.onFrameStart = null;
    this.onFrameEnd = null;
    this.onAllTasksComplete = null;
  }
}

/**
 * 渲染任务生成器
 * 用于将大区域渲染拆分成小任务
 */
class RenderTaskGenerator {
  /**
   * 生成行片渲染任务
   * @param {Object} options
   * @param {number} options.startRow - 起始行
   * @param {number} options.endRow - 结束行
   * @param {number} options.startCol - 起始列
   * @param {number} options.endCol - 结束列
   * @param {number} options.rowsPerTask - 每个任务的行数
   * @param {number} options.priority - 基础优先级
   * @param {Function} options.renderFn - 渲染函数 (rowStart, rowEnd) => void
   * @returns {Array<RenderTask>}
   */
  static generateRowTasks(options) {
    const {
      startRow,
      endRow,
      startCol,
      endCol,
      rowsPerTask = 5,
      priority = Priority.NORMAL,
      renderFn
    } = options;
    
    const tasks = [];
    let taskId = 0;
    
    for (let r = startRow; r <= endRow; r += rowsPerTask) {
      const rowEnd = Math.min(r + rowsPerTask - 1, endRow);
      
      tasks.push({
        id: `row-task-${taskId++}`,
        priority,
        estimatedTime: 2, // 预估 2ms
        execute: (context) => {
          renderFn(r, rowEnd, startCol, endCol);
          return { done: true, progress: 1 };
        }
      });
    }
    
    return tasks;
  }

  /**
   * 生成区域渲染任务
   * @param {Object} options
   * @param {Object} options.range - 渲染范围 { startRow, endRow, startCol, endCol }
   * @param {number} options.chunkSize - 分块大小
   * @param {number} options.priority - 优先级
   * @param {Function} options.renderFn - 渲染函数
   * @returns {Array<RenderTask>}
   */
  static generateChunkTasks(options) {
    const {
      range,
      chunkSize = 10,
      priority = Priority.NORMAL,
      renderFn
    } = options;
    
    const tasks = [];
    let taskId = 0;
    
    for (let r = range.startRow; r <= range.endRow; r += chunkSize) {
      for (let c = range.startCol; c <= range.endCol; c += chunkSize) {
        const rowEnd = Math.min(r + chunkSize - 1, range.endRow);
        const colEnd = Math.min(c + chunkSize - 1, range.endCol);
        
        // 根据位置调整优先级（靠近可见区域更高）
        const distanceFromVisible = Math.max(
          Math.abs(r - range.exactStartRow),
          Math.abs(c - range.exactStartCol)
        );
        const adjustedPriority = Math.min(priority + Math.floor(distanceFromVisible / chunkSize), Priority.LOW);
        
        tasks.push({
          id: `chunk-task-${taskId++}`,
          priority: adjustedPriority,
          estimatedTime: 1,
          execute: (context) => {
            renderFn(r, rowEnd, c, colEnd);
            return { done: true, progress: 1 };
          }
        });
      }
    }
    
    return tasks;
  }

  /**
   * 生成渐进式数据收集任务
   * 用于大量单元格数据的收集
   * @param {Object} options
   * @param {number} options.startRow - 起始行
   * @param {number} options.endRow - 结束行
   * @param {number} options.startCol - 起始列
   * @param {number} options.endCol - 结束列
   * @param {number} options.batchSize - 每批处理的单元格数
   * @param {Function} options.processFn - 处理函数 (r, c) => cellData
   * @param {Function} options.onBatch - 批次完成回调 (batch) => void
   * @returns {Array<RenderTask>}
   */
  static generateDataCollectionTasks(options) {
    const {
      startRow,
      endRow,
      startCol,
      endCol,
      batchSize = 100,
      processFn,
      onBatch
    } = options;
    
    const tasks = [];
    let taskId = 0;
    let currentBatch = [];
    
    tasks.push({
      id: `collect-task-${taskId}`,
      priority: Priority.HIGH,
      estimatedTime: 0,
      execute: (context) => {
        const startTime = performance.now();
        let processed = 0;
        
        for (let r = startRow; r <= endRow && processed < batchSize; r++) {
          for (let c = startCol; c <= endCol && processed < batchSize; c++) {
            const cellData = processFn(r, c);
            if (cellData) {
              currentBatch.push(cellData);
            }
            processed++;
          }
        }
        
        // 检查是否完成
        const totalCells = (endRow - startRow + 1) * (endCol - startCol + 1);
        const progress = processed / totalCells;
        
        if (currentBatch.length > 0 && onBatch) {
          onBatch(currentBatch);
          currentBatch = [];
        }
        
        return { done: progress >= 1, progress };
      }
    });
    
    return tasks;
  }
}

/**
 * 创建渐进式渲染器实例
 * @param {Object} options
 * @returns {ProgressiveRenderer}
 */
export function createProgressiveRenderer(options = {}) {
  return new ProgressiveRenderer(options);
}

export { ProgressiveRenderer, RenderTaskGenerator, TaskQueue as __TaskQueueForTest };