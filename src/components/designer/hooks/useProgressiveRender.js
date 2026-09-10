import { ref, reactive } from 'vue';
import {
  createProgressiveRenderer,
  Priority
} from '../../../core/render/ProgressiveRenderer';
import { calcMergeSize } from '../utils/cellUtils';

// 渐进式渲染配置
const PROGRESSIVE_CONFIG = {
  frameBudget: 8,
  maxTasksPerFrame: 5,
  rowsPerChunk: 10,
  colsPerChunk: 10,
  enableThreshold: 1000,
  useIdleCallback: true
};

export default function useProgressiveRender(tableContext) {
  const progressiveRenderer = ref(null);
  const progressiveEnabled = ref(false);
  const progressiveState = reactive({
    isRendering: false,
    progress: 0,
    phase: 'idle' // idle, collecting, rendering, complete
  });

  const collectedCellData = reactive({
    backgrounds: {},
    gridLines: [],
    texts: [],
    borders: {}
  });

  function _clearCollectedData() {
    collectedCellData.backgrounds = {};
    collectedCellData.gridLines = [];
    collectedCellData.texts = [];
    collectedCellData.borders = {};
  }

  /**
   * 初始化渐进式渲染器
   */
  function initProgressiveRenderer() {
    if (progressiveRenderer.value) {
      progressiveRenderer.value.destroy();
    }

    progressiveRenderer.value = createProgressiveRenderer({
      frameBudget: PROGRESSIVE_CONFIG.frameBudget,
      maxTasksPerFrame: PROGRESSIVE_CONFIG.maxTasksPerFrame,
      useIdleCallback: PROGRESSIVE_CONFIG.useIdleCallback
    });

    progressiveRenderer.value.onFrameStart = (remainingTime) => {
      // 可以在这里做一些帧前准备工作
    };

    progressiveRenderer.value.onFrameEnd = (frameTime, tasksExecuted) => {
      if (frameTime > PROGRESSIVE_CONFIG.frameBudget * 1.5) {
        console.warn(`[ProgressiveRender] Frame time ${frameTime.toFixed(2)}ms exceeded budget`);
      }
    };

    progressiveRenderer.value.onAllTasksComplete = () => {
      progressiveState.isRendering = false;
      progressiveState.phase = 'complete';
      progressiveState.progress = 1;

      // 触发完成事件
      tableContext.emit('progressive-render-complete');
    };
  }

  /**
   * 销毁渐进式渲染器
   */
  function destroyProgressiveRenderer() {
    if (progressiveRenderer.value) {
      progressiveRenderer.value.destroy();
      progressiveRenderer.value = null;
    }
    _clearCollectedData();
  }

  /**
   * 检查是否应该启用渐进式渲染
   */
  function shouldUseProgressiveRender() {
    if (!tableContext.props.workbook) return false;

    const visibleRange = tableContext.methods._getVisibleRange();
    if (!visibleRange) return false;

    const bodyCells = (visibleRange.exactEndRow - visibleRange.exactStartRow + 1) *
                      (visibleRange.exactEndCol - visibleRange.exactStartCol + 1);

    const freezeCells = Math.max(0, visibleRange.freezeEndRow + 1) *
                        Math.max(0, visibleRange.freezeEndCol + 1);

    const totalCells = bodyCells + freezeCells;

    return totalCells > PROGRESSIVE_CONFIG.enableThreshold;
  }

  /**
   * 开始渐进式渲染
   */
  function startProgressiveRender() {
    if (!progressiveRenderer.value) {
      initProgressiveRenderer();
    }

    progressiveRenderer.value.stop();
    progressiveRenderer.value.clearAll();
    _clearCollectedData();

    if (tableContext.state.ctx) {
      tableContext.state.ctx.clearRect(0, 0, tableContext.state.width, tableContext.state.height);
    }

    progressiveState.isRendering = true;
    progressiveState.phase = 'collecting';
    progressiveState.progress = 0;

    const visibleRange = tableContext.methods._getVisibleRange();
    if (!visibleRange) return;

    const tasks = _generateRenderTasks(visibleRange);
    progressiveRenderer.value.addTasks(tasks);
    progressiveRenderer.value.start();
  }

  /**
   * 停止渐进式渲染
   */
  function stopProgressiveRender() {
    if (progressiveRenderer.value) {
      progressiveRenderer.value.stop();
    }
    progressiveState.isRendering = false;
    progressiveState.phase = 'idle';
  }

  /**
   * 暂停渐进式渲染
   */
  function pauseProgressiveRender() {
    if (progressiveRenderer.value) {
      progressiveRenderer.value.pause();
    }
  }

  /**
   * 恢复渐进式渲染
   */
  function resumeProgressiveRender() {
    if (progressiveRenderer.value) {
      progressiveRenderer.value.resume();
    }
  }

  /**
   * 生成渲染任务
   */
  function _generateRenderTasks(visibleRange) {
    const tasks = [];
    const wb = tableContext.props.workbook;

    const {
      freezeR, freezeC,
      startRow, endRow, startCol, endCol,
      freezeEndRow, freezeEndCol,
      bodyStartX, bodyStartY,
      frozenWidth, frozenHeight
    } = visibleRange;

    const RW = Math.floor(tableContext.computed.rowHeaderWidth.value);
    const CH = Math.floor(tableContext.computed.colHeaderHeight.value);

    const vyBody = CH + wb.getRowPos(startRow) - tableContext.state.scrollY;
    const vxBody = RW + wb.getColPos(startCol) - tableContext.state.scrollX;

    // 1. 冻结区域任务（最高优先级）
    if (freezeR > 0 && freezeC > 0) {
      tasks.push(_createAreaRenderTask({
        id: 'freeze-corner',
        priority: Priority.CRITICAL,
        startRow: 0,
        endRow: freezeEndRow,
        startCol: 0,
        endCol: freezeEndCol,
        offsetX: RW,
        offsetY: CH,
        clipRect: {
          x: RW,
          y: CH,
          w: frozenWidth,
          h: frozenHeight
        },
        fillBg: true
      }));
    }

    // 2. 冻结行任务
    if (freezeR > 0) {
      tasks.push(_createAreaRenderTask({
        id: 'freeze-top',
        priority: Priority.CRITICAL,
        startRow: 0,
        endRow: freezeEndRow,
        startCol,
        endCol,
        offsetX: vxBody,
        offsetY: CH,
        clipRect: {
          x: bodyStartX,
          y: CH,
          w: tableContext.state.width - bodyStartX,
          h: frozenHeight
        },
        fillBg: true
      }));
    }

    // 3. 冻结列任务
    if (freezeC > 0) {
      tasks.push(_createAreaRenderTask({
        id: 'freeze-left',
        priority: Priority.CRITICAL,
        startRow,
        endRow,
        startCol: 0,
        endCol: freezeEndCol,
        offsetX: RW,
        offsetY: vyBody,
        clipRect: {
          x: RW,
          y: bodyStartY,
          w: frozenWidth,
          h: tableContext.state.height - bodyStartY
        },
        fillBg: true
      }));
    }

    // 4. 主体区域任务（按行分块）
    const rowsPerChunk = PROGRESSIVE_CONFIG.rowsPerChunk;
    let taskId = 0;

    for (let r = startRow; r <= endRow; r += rowsPerChunk) {
      const chunkEndRow = Math.min(r + rowsPerChunk - 1, endRow);
      const centerRow = (startRow + endRow) / 2;
      const distance = Math.abs(r - centerRow);
      const priority = distance < rowsPerChunk * 2 ? Priority.HIGH : Priority.NORMAL;

      tasks.push(_createAreaRenderTask({
        id: `body-chunk-${taskId++}`,
        priority,
        startRow: r,
        endRow: chunkEndRow,
        startCol,
        endCol,
        offsetX: vxBody,
        offsetY: CH + wb.getRowPos(r) - tableContext.state.scrollY,
        clipRect: {
          x: bodyStartX,
          y: bodyStartY,
          w: tableContext.state.width - bodyStartX,
          h: tableContext.state.height - bodyStartY
        }
      }));
    }

    return tasks;
  }

  /**
   * 创建区域渲染任务
   */
  function _createAreaRenderTask(options) {
    const {
      id,
      priority,
      startRow,
      endRow,
      startCol,
      endCol,
      offsetX,
      offsetY,
      clipRect,
      fillBg
    } = options;

    return {
      id,
      priority,
      estimatedTime: 2,
      execute: (context) => {
        _renderAreaProgressive(
          startRow, endRow, startCol, endCol, offsetX, offsetY, clipRect, fillBg
        );
        return { done: true, progress: 1 };
      }
    };
  }

  /**
   * 渐进式区域渲染
   */
  function _renderAreaProgressive(startRow, endRow, startCol, endCol, offsetX, offsetY, clipRect = null, fillBg = false) {
    const ctx = tableContext.state.ctx;
    const wb = tableContext.props.workbook;
    const W = tableContext.state.width;
    const H = tableContext.state.height;

    if (!ctx) return;

    const cellDataList = [];
    const borderBatch = {};

    ctx.save();
    if (clipRect) {
      ctx.beginPath();
      ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
      ctx.clip();

      if (fillBg) {
        ctx.fillStyle = (tableContext.state.tableTheme && tableContext.state.tableTheme.cellBg) || '#ffffff';
        ctx.fillRect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
      }
    }

    let vy = offsetY;
    for (let r = startRow; r <= endRow; r++) {
      const h = wb.getRowHeight(r);
      if (vy + h > 0 && vy < H) {
        let cx = offsetX;
        for (let c = startCol; c <= endCol; c++) {
          const w = wb.getColWidth(c);
          if (cx + w > 0 && cx < W) {
            const merge = wb.getMerge(r, c);
            if (merge) {
              if (merge.s.r === r && merge.s.c === c) {
                const { mw, mh } = calcMergeSize(wb, merge, r, c);
                cellDataList.push(tableContext.methods.collectCellData(r, c, cx, vy, mw, mh));
                tableContext.methods.drawCellBorders(ctx, r, c, cx, vy, mw, mh, borderBatch);
              }
            } else {
              cellDataList.push(tableContext.methods.collectCellData(r, c, cx, vy, w, h));
              tableContext.methods.drawCellBorders(ctx, r, c, cx, vy, w, h, borderBatch);
            }
          }
          cx += w;
          if (cx > W) break;
        }
      }
      vy += h;
      if (vy > H) break;
    }

    if (cellDataList.length > 0) {
      tableContext.methods.drawCellsBatched(ctx, cellDataList);
      tableContext.methods._drawBatchedBorders(ctx, borderBatch);
    }

    ctx.restore();
  }

  return {
    progressiveRenderer,
    progressiveEnabled,
    progressiveState,
    collectedCellData,
    initProgressiveRenderer,
    destroyProgressiveRenderer,
    shouldUseProgressiveRender,
    startProgressiveRender,
    stopProgressiveRender,
    pauseProgressiveRender,
    resumeProgressiveRender,
    _generateRenderTasks,
    _createAreaRenderTask,
    _renderAreaProgressive,
    _clearCollectedData
  };
}
