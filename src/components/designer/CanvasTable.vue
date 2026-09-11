<template>
	<div class="vue-canvas-sheet-table-container" tabindex="0" @keydown="onKeyDownWrapper" ref="container"
		@mousedown="onMouseDownWrapper" @mouseup="handleMouseUp" @mousemove="handleThrottledMouseMove" @dblclick="handleDblClick"
		@wheel="handleWheel" @contextmenu="handleContextMenu" @dragover="handleDragOver" @dragleave="handleDragLeave"
		@drop="handleDrop">
		<canvas ref="gridCanvas" style="position: absolute; left: 0; top: 0; z-index: 1;"></canvas>
		<canvas ref="canvas" :key="canvasKey" style="position: absolute; left: 0; top: 0; z-index: 2;"></canvas>
		<canvas ref="selectionCanvas" style="position: absolute; left: 0; top: 0; z-index: 3; pointer-events: none;"></canvas>
		<canvas ref="animationCanvas" style="position: absolute; left: 0; top: 0; z-index: 4; pointer-events: none;"></canvas>
		<div v-if="isEditing" class="vue-canvas-sheet-cell-editor" :style="{
          left: editorPos.x + 'px',
          top: editorPos.y + 'px',
          width: editorPos.w + 'px',
          height: editorPos.h + 'px',
          font: tableTheme.fontSize + ' ' + tableTheme.fontFamily,
          visibility: editorVisible ? 'visible' : 'hidden'
      }">
			<input v-model="editValue" ref="editor" @input="handleEditorInput" @blur="finishEdit" @keydown.enter="finishEdit"
				@keydown.esc="cancelEdit" />
		</div>
		<div v-if="contextMenuVisible" class="vue-canvas-sheet-context-menu"
			:style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }" @mousedown.stop>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('insertRow')">插入行</div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('deleteRow')">删除行</div>
			<div class="vue-canvas-sheet-divider"></div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('insertColumn')">插入列</div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('deleteColumn')">删除列</div>
			<div class="vue-canvas-sheet-divider"></div>
			<div class="vue-canvas-sheet-menu-item" v-if="canMerge" @click="handleMenuAction('merge')">合并单元格</div>
			<div class="vue-canvas-sheet-menu-item" v-if="canUnmerge" @click="handleMenuAction('unmerge')">取消合并</div>
			<div class="vue-canvas-sheet-divider"></div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('clear')">清空内容</div>
			<div class="vue-canvas-sheet-divider"></div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('copy')">复制</div>
			<div class="vue-canvas-sheet-menu-item" @click="handleMenuAction('paste')">粘贴</div>
		</div>
		<div class="vue-canvas-sheet-scrollbar-h" ref="scrollH" @scroll="onScrollH">
			<div class="vue-canvas-sheet-scrollbar-spacer" :style="{ width: totalWidth + 'px', height: '1px' }"></div>
		</div>
		<div class="vue-canvas-sheet-scrollbar-v" ref="scrollV" @scroll="onScrollV">
			<div class="vue-canvas-sheet-scrollbar-spacer" :style="{ height: totalHeight + 'px', width: '1px' }"></div>
		</div>

		<!-- 辅助功能层 (Accessibility Layer) -->
		<div class="vue-canvas-sheet-accessibility-layer"
			role="grid"
			:aria-rowcount="totalRowCount"
			:aria-colcount="totalColCount"
			:aria-multiselectable="true"
			:aria-activedescendant="activeCellId"
			ref="ariaGrid"
			style="position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: hidden; opacity: 0; pointer-events: none;">
			<div v-for="row in ariaRows" :key="row.index" role="row" :aria-rowindex="row.index + 1">
				<div v-for="col in ariaCols" :key="col.index"
					role="gridcell"
					:id="'cell-' + row.index + '-' + col.index"
					:aria-colindex="col.index + 1"
					:aria-selected="isSelected(row.index, col.index)"
					tabindex="-1">
					{{ getCellValue(row.index, col.index) }}
				</div>
			</div>
		</div>
	</div>
</template>
<script setup>
import { ref, reactive, computed, toRefs, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { debounce } from 'es-toolkit';
import { TableTheme } from './config';
import { Events } from '../../core/events/EventEmitter';

import useOffscreenRender from './hooks/useOffscreenRender';
import useProgressiveRender from './hooks/useProgressiveRender';
import useCanvasRender from './hooks/useCanvasRender';
import useCanvasInteraction from './hooks/useCanvasInteraction';

// 默认行高（用于懒加载计算）
const DEFAULT_ROW_HEIGHT = 25;

function getDevicePixelRatio() {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

const props = defineProps({
  workbook: Object,
  readOnly: {
    type: Boolean,
    default: false
  },
  version: {
    type: Number,
    default: 0
  },
  dataController: {
    type: Object,
    default: null
  }
});

const emit = defineEmits([
  'selection-change',
  'column-deleted',
  'drop-field',
  'trigger-find',
  'progressive-render-complete'
]);

// DOM elements refs
const container = ref(null);
const gridCanvas = ref(null);
const canvas = ref(null);
const selectionCanvas = ref(null);
const animationCanvas = ref(null);
const scrollH = ref(null);
const scrollV = ref(null);
const ariaGrid = ref(null);
const editor = ref(null);

// 内容层 canvas 的重建 key：worker 降级且 canvas 控制权已转移时，自增此 key 让 Vue
// 重建出全新 canvas 元素（旧元素已转移给 worker，无法在主线程重获 2D context）。
const canvasKey = ref(0);

// Reactive state
const state = reactive({
  scrollX: 0,
  scrollY: 0,
  width: 0,
  height: 0,
  isDragging: false,
  isDraggingCol: false,
  isDraggingFill: false,
  isResizingCol: false,
  isResizingRow: false,
  isSelectingCol: false,
  isSelectingRow: false,
  dragColStartIndex: -1,
  dragRowStartIndex: -1,
  dragColIndex: -1,
  dropColIndex: -1,
  resizeCursor: '',
  hoverResizeIndex: -1,
  resizingIndex: -1,
  resizingStartSize: 0,
  resizingStartPos: 0,
  fillHandleRect: null,
  fillStartRange: null,
  fillTargetRange: null,
  isEditing: false,
  editorVisible: false,
  editValue: '',
  editingCell: null,
  editorPos: { x: 0, y: 0, w: 0, h: 0 },
  pendingRender: false,
  tableTheme: TableTheme,
  contextMenuVisible: false,
  contextMenuPos: { x: 0, y: 0 },
  contextMenuTarget: null,
  dragOverCell: null,
  totalWidth: 0,
  totalHeight: 0,
  isSyncingScroll: false,

  dirtyRect: null,
  fullRedraw: true,
  renderContentRequested: true,
  renderSelectionRequested: true,
  renderAnimationRequested: false,
  renderGridRequested: true,
  lastActiveRef: null,

  // 辅助功能数据
  ariaRows: [],
  ariaCols: [],
  totalRowCount: 0,
  totalColCount: 0,

  // ARIA 范围缓存
  _ariaStartRow: -1,
  _ariaEndRow: -1,
  _ariaStartCol: -1,
  _ariaEndCol: -1,

  // Canvas contexts
  ctx: null,
  ctxSelection: null,
  ctxAnimation: null,
  ctxGrid: null,
  dpr: getDevicePixelRatio(),

  // 动画 & 订阅相关
  animationId: null,
  workbookUnsub: null,
  _eventUnsubs: []
});

// Computed properties
const rowHeaderWidth = computed(() => {
  const rowCount = props.workbook ? props.workbook.rowCount : 0;
  const digits = Math.max(2, String(rowCount).length);
  return Math.floor(Math.max(40, digits * 8 + 10));
});

const colHeaderHeight = computed(() => TableTheme.colHeaderHeight);

const canMerge = computed(() => {
  if (!props.workbook || !props.workbook.selection) return false;
  return props.workbook.mergeManager.allowsMerge(props.workbook.selection);
});

const canUnmerge = computed(() => {
  if (!props.workbook || !props.workbook.selection) return false;
  return props.workbook.mergeManager.allowsUnmerge(props.workbook.selection);
});

const activeCellId = computed(() => {
  if (!props.workbook || !props.workbook.activeCell) return '';
  return `cell-${props.workbook.activeCell.r}-${props.workbook.activeCell.c}`;
});

const isOffscreenActive = computed(() => {
  return state.useOffscreen && state.offscreenRenderer && state.offscreenRenderer.isUsingWorker();
});

// Setup unified tableContext
const tableContext = {
  props,
  emit,
  state,
  refs: {
    container,
    gridCanvas,
    canvas,
    selectionCanvas,
    animationCanvas,
    scrollH,
    scrollV,
    ariaGrid,
    editor
  },
  computed: {
    rowHeaderWidth,
    colHeaderHeight,
    canMerge,
    canUnmerge,
    activeCellId,
    isOffscreenActive
  },
  methods: {}
};

// Initialize hooks
const offscreenRender = useOffscreenRender(tableContext);
Object.assign(tableContext.methods, offscreenRender);

// Export offscreen variables to state so they are reactive in context
state.useOffscreen = offscreenRender.useOffscreen;
state.offscreenRenderer = offscreenRender.offscreenRenderer;
state.offscreenEnabled = offscreenRender.offscreenEnabled;

const progressiveRender = useProgressiveRender(tableContext);
Object.assign(tableContext.methods, progressiveRender);

// Export progressive state to context state
state.progressiveRenderer = progressiveRender.progressiveRenderer;
state.progressiveEnabled = progressiveRender.progressiveEnabled;
state.progressiveState = progressiveRender.progressiveState;
state.collectedCellData = progressiveRender.collectedCellData;

const canvasRender = useCanvasRender(tableContext);
Object.assign(tableContext.methods, canvasRender);

const canvasInteraction = useCanvasInteraction(tableContext);
Object.assign(tableContext.methods, canvasInteraction);

// Add component-level methods to tableContext.methods
Object.assign(tableContext.methods, {
  focus,
  syncScrollbars,
  updateScrollbarSize,
  isSelected,
  getCellValue,
  invalidateSelection,
  invalidateAnimation,
  startAnimation,
  stopAnimation,
  setupWorkbookSubscription,
  handleResize,
  rebuildContentCanvas,
  preloadTextMetrics
});

// Component methods (for template & local use)
function focus() {
  if (container.value) {
    container.value.focus();
  }
}

function syncScrollbars() {
  state.isSyncingScroll = true;
  if (scrollH.value) scrollH.value.scrollLeft = state.scrollX;
  if (scrollV.value) scrollV.value.scrollTop = state.scrollY;
  state.isSyncingScroll = false;
}

function updateScrollbarSize() {
  if (!props.workbook) return;
  state.totalWidth = props.workbook.totalWidth + rowHeaderWidth.value;
  state.totalHeight = props.workbook.totalHeight + colHeaderHeight.value;
}

function isSelected(r, c) {
  if (!props.workbook || !props.workbook.selection) return false;
  const sel = props.workbook.selection;
  return r >= sel.s.r && r <= sel.e.r && c >= sel.s.c && c <= sel.e.c;
}

function getCellValue(r, c) {
  const cell = props.workbook.getCell(r, c);
  return cell ? (cell.v !== undefined ? cell.v : '') : '';
}

function invalidateSelection() {
  state.renderSelectionRequested = true;
  tableContext.methods.render();
}

function invalidateAnimation() {
  state.renderAnimationRequested = true;
  tableContext.methods.render();
}

function _checkAnimationNeed() {
  const needAnimation = props.workbook && props.workbook.copyRange;

  if (needAnimation && !state.animationId) {
    _startAnimationLoop();
  } else if (!needAnimation && state.animationId) {
    stopAnimation();
  }
}

function _startAnimationLoop() {
  const loop = () => {
    if (!props.workbook || !props.workbook.copyRange) {
      state.animationId = null;
      return;
    }
    invalidateAnimation();
    state.animationId = requestAnimationFrame(loop);
  };
  state.animationId = requestAnimationFrame(loop);
}

function startAnimation() {
  _checkAnimationNeed();
}

function stopAnimation() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }
}

function setupWorkbookSubscription() {
  if (state.workbookUnsub) {
    state.workbookUnsub();
    state.workbookUnsub = null;
  }
  if (state._eventUnsubs) {
    state._eventUnsubs.forEach(unsub => unsub());
    state._eventUnsubs = [];
  }

  if (props.workbook) {
    state._eventUnsubs = [];

    state._eventUnsubs.push(
      props.workbook.on('selection-change', (payload) => {
        if (props.workbook.activeCell) {
          const { r, c } = props.workbook.activeCell;
          const cell = props.workbook.getCell(r, c);
          const val = cell ? (cell.f ? cell.f : (cell.v !== undefined ? cell.v : '')) : '';
          const address = props.workbook.getAddress(r, c);

          if (state.lastActiveRef !== address) {
            state.lastActiveRef = address;
            tableContext.methods.scrollIntoView(r, c);
          }

          emit('selection-change', {
            r, c,
            val,
            address
          });
        }
      })
    );

    state._eventUnsubs.push(
      props.workbook.on('structure-change', () => {
        updateScrollbarSize();
        tableContext.methods.updateEditorPosition();
        tableContext.methods.invalidate(null, { structural: true });
      })
    );

    state._eventUnsubs.push(
      props.workbook.on('data-load', () => {
        updateScrollbarSize();
        tableContext.methods.updateEditorPosition();
        tableContext.methods.invalidate(null, { structural: true });
      })
    );

    state._eventUnsubs.push(
      props.workbook.on(Events.FORMULAS_CALCULATED, (payload) => {
        if (payload && payload.results && payload.results.length > 0) {
          payload.results.forEach(res => {
            const { r, c } = props.workbook.parseKey(res.cellId);
            const rect = tableContext.methods.getCellScreenRect(r, c);
            tableContext.methods.invalidate(rect, { content: true });
          });
        } else {
          tableContext.methods.invalidate(null, { content: true });
        }
      })
    );

    state.workbookUnsub = props.workbook.on(Events.CHANGE, (data) => {
      updateScrollbarSize();
      tableContext.methods.updateEditorPosition();

      if (data && data.type === 'selection') {
        invalidateSelection();
        return;
      }

      if (data && data.r !== undefined && data.c !== undefined) {
        const rect = tableContext.methods.getCellScreenRect(data.r, data.c);
        tableContext.methods.invalidate(rect, { content: true });
      } else {
        tableContext.methods.invalidate(null, { structural: true });
      }

      _checkAnimationNeed();
    });
  }
}

function initCanvas() {
  const canvasEl = canvas.value;
  const canUseOffscreen = typeof canvasEl.transferControlToOffscreen === 'function' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof Worker !== 'undefined';

  state.ctxSelection = selectionCanvas.value.getContext('2d');
  state.ctxAnimation = animationCanvas.value.getContext('2d');
  state.ctxGrid = gridCanvas.value.getContext('2d');

  const dpr = getDevicePixelRatio();
  state.dpr = dpr;

  if (!canUseOffscreen) {
    state.ctx = canvasEl.getContext('2d');
  }
}

function handleResize() {
  const containerEl = container.value;
  if (!containerEl) return;

  const { width, height } = containerEl.getBoundingClientRect();
  state.width = width;
  state.height = height;

  const canvasEl = canvas.value;
  const dpr = getDevicePixelRatio();
  state.dpr = dpr;

  if (!isOffscreenActive.value) {
    if (!state.ctx) {
      state.ctx = canvasEl.getContext('2d');
    }
    canvasEl.width = width * dpr;
    canvasEl.height = height * dpr;
    canvasEl.style.width = width + 'px';
    canvasEl.style.height = height + 'px';
    if (state.ctx) {
      state.ctx.setTransform(1, 0, 0, 1, 0, 0);
      state.ctx.scale(dpr, dpr);
    }
  }

  const selectionCanvasEl = selectionCanvas.value;
  selectionCanvasEl.width = width * dpr;
  selectionCanvasEl.height = height * dpr;
  selectionCanvasEl.style.width = width + 'px';
  selectionCanvasEl.style.height = height + 'px';
  state.ctxSelection.setTransform(1, 0, 0, 1, 0, 0);
  state.ctxSelection.scale(dpr, dpr);

  const animationCanvasEl = animationCanvas.value;
  animationCanvasEl.width = width * dpr;
  animationCanvasEl.height = height * dpr;
  animationCanvasEl.style.width = width + 'px';
  animationCanvasEl.style.height = height + 'px';
  state.ctxAnimation.setTransform(1, 0, 0, 1, 0, 0);
  state.ctxAnimation.scale(dpr, dpr);

  const gridCanvasEl = gridCanvas.value;
  gridCanvasEl.width = width * dpr;
  gridCanvasEl.height = height * dpr;
  gridCanvasEl.style.width = width + 'px';
  gridCanvasEl.style.height = height + 'px';
  state.ctxGrid.setTransform(1, 0, 0, 1, 0, 0);
  state.ctxGrid.scale(dpr, dpr);
  state.renderGridRequested = true;

  if (tableContext.methods.offscreenRenderer && tableContext.methods.offscreenRenderer.value) {
    tableContext.methods.offscreenRenderer.value.resize(width, height, dpr).then((usingOffscreen) => {
      if (!usingOffscreen && !state.ctx && canvasEl) {
        state.ctx = canvasEl.getContext('2d');
        if (state.ctx) {
          state.ctx.setTransform(1, 0, 0, 1, 0, 0);
          state.ctx.scale(dpr, dpr);
        }
      }
    });
  }

  tableContext.methods.invalidate();
  tableContext.methods.updateEditorPosition();
}

/**
 * 重建内容层 canvas（worker 降级且 canvas 控制权已转移时调用）
 *
 * 通过自增 canvasKey 让 Vue 销毁旧 canvas、挂载全新元素，再把新元素回挂到渲染器并
 * 恢复尺寸/DPR 变换。全程不直接操作 DOM，避免破坏 Vue 的 VNode 树。
 */
async function rebuildContentCanvas() {
  canvasKey.value++;
  await nextTick();

  const canvasEl = canvas.value;
  if (!canvasEl) return;

  const renderer = state.offscreenRenderer && state.offscreenRenderer.value;
  if (renderer && typeof renderer.attachCanvas === 'function') {
    state.ctx = renderer.attachCanvas(canvasEl);
  } else {
    state.ctx = canvasEl.getContext('2d');
  }

  // 复用 handleResize 的尺寸/DPR 设置逻辑，恢复新 canvas 的绘制坐标系
  const dpr = state.dpr;
  canvasEl.width = state.width * dpr;
  canvasEl.height = state.height * dpr;
  canvasEl.style.width = state.width + 'px';
  canvasEl.style.height = state.height + 'px';
  if (state.ctx) {
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.scale(dpr, dpr);
  }

  tableContext.methods.invalidate(null, { structural: true });
}

function handleWheel(e) {
  e.preventDefault();

  const dx = e.deltaX;
  const dy = e.deltaY;

  const maxScrollX = Math.max(0, state.totalWidth - state.width);
  const maxScrollY = Math.max(0, state.totalHeight - state.height);

  const newX = Math.max(0, Math.min(state.scrollX + dx, maxScrollX));
  const newY = Math.max(0, Math.min(state.scrollY + dy, maxScrollY));

  state.scrollX = newX;
  state.scrollY = newY;

  syncScrollbars();
  tableContext.methods.updateEditorPosition();
  tableContext.methods.render();
  _preloadTextMetricsDebounced();

  if (props.dataController && props.dataController._scrollLoader) {
    props.dataController.handleScroll(
      state.scrollY,
      state.height,
      state.totalHeight,
      DEFAULT_ROW_HEIGHT
    ).catch(err => {
      console.error('Lazy load error:', err);
    });
  }
}

function preloadTextMetrics() {
  // 防止自引用：当 hooks 未提供实现时，仅执行基础字体预热
  const ctx = tableContext.state?.ctx;
  if (!ctx) return;

  // 预测量两种最常用字体的基线，预热 canvas 字体缓存
  const theme = tableContext.state.tableTheme || {};
  try {
    ctx.font = `${theme.fontSize || '14px'} ${theme.fontFamily || 'sans-serif'}`;
    ctx.measureText('0');
    ctx.font = `${theme.headerFontSize || '14px'} ${theme.fontFamily || 'sans-serif'}`;
    ctx.measureText('0');
  } catch (_) {
    // canvas 上下文不可用时静默忽略
  }
}

// Debounce methods
let _handleResizeDebounced = null;
let _preloadTextMetricsDebounced = null;
let resizeObserver = null;
let dprMediaQuery = null;
let dprMediaQueryListener = null;

function removeDprMediaQueryListener() {
  if (!dprMediaQuery || !dprMediaQueryListener) return;

  if (typeof dprMediaQuery.removeEventListener === 'function') {
    dprMediaQuery.removeEventListener('change', dprMediaQueryListener);
  } else if (typeof dprMediaQuery.removeListener === 'function') {
    dprMediaQuery.removeListener(dprMediaQueryListener);
  }

  dprMediaQuery = null;
  dprMediaQueryListener = null;
}

function setupDprMediaQuery() {
  removeDprMediaQueryListener();

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  const dpr = getDevicePixelRatio();
  dprMediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
  dprMediaQueryListener = () => {
    handleResize();
    setupDprMediaQuery();
  };

  if (typeof dprMediaQuery.addEventListener === 'function') {
    dprMediaQuery.addEventListener('change', dprMediaQueryListener);
  } else if (typeof dprMediaQuery.addListener === 'function') {
    dprMediaQuery.addListener(dprMediaQueryListener);
  }
}

onMounted(() => {
  initCanvas();

  const usingOffscreen = tableContext.methods.initOffscreenRenderer({
    enableWorker: true,
    timeout: 5000
  });
  if (!usingOffscreen && !state.ctx && canvas.value) {
    state.ctx = canvas.value.getContext('2d');
  }

  tableContext.methods.initProgressiveRenderer();

  if (tableContext.methods._initThrottledMethods) {
    tableContext.methods._initThrottledMethods();
  }

  _handleResizeDebounced = debounce(() => {
    handleResize();
  }, 16);

  _preloadTextMetricsDebounced = debounce(() => {
    preloadTextMetrics();
  }, 100);

  resizeObserver = new ResizeObserver(_handleResizeDebounced);
  if (container.value) {
    resizeObserver.observe(container.value);
  }

  setupWorkbookSubscription();
  startAnimation();
  handleResize();
  setupDprMediaQuery();
  updateScrollbarSize();
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  removeDprMediaQueryListener();
  if (state.workbookUnsub) {
    state.workbookUnsub();
    state.workbookUnsub = null;
  }
  if (state._eventUnsubs) {
    state._eventUnsubs.forEach(unsub => unsub());
    state._eventUnsubs = null;
  }

  stopAnimation();
  tableContext.methods.destroyOffscreenRenderer();
  tableContext.methods.destroyProgressiveRenderer();

  if (tableContext.methods.cleanupCanvasRender) {
    tableContext.methods.cleanupCanvasRender();
  }
  if (tableContext.methods._cleanupThrottledMethods) {
    tableContext.methods._cleanupThrottledMethods();
  }
  if (props.workbook) {
    props.workbook.setRenderScheduler(null);
  }
});

// Watchers
watch(() => props.workbook, (newWb, oldWb) => {
  if (oldWb) {
    oldWb.setRenderScheduler(null);
  }
  if (newWb !== oldWb) {
    setupWorkbookSubscription();
    if (newWb) {
      newWb.setRenderScheduler(() => {
        tableContext.methods.invalidate();
      });
    }
  }
  updateScrollbarSize();
  tableContext.methods.invalidate();
}, { immediate: true });

watch(() => props.version, () => {
  updateScrollbarSize();
  tableContext.methods.invalidate();
});

// Template Event Handlers (redirected to tableContext.methods)
const onKeyDownWrapper = (e) => tableContext.methods.handleKeyDown(e);
const onMouseDownWrapper = (e) => {
  if (state.contextMenuVisible) {
    state.contextMenuVisible = false;
  }
  if (e.target.classList.contains('vue-canvas-sheet-scrollbar-h') ||
    e.target.classList.contains('vue-canvas-sheet-scrollbar-v') ||
    e.target.classList.contains('vue-canvas-sheet-scrollbar-spacer')) {
    return;
  }
  if (props.readOnly) return;
  tableContext.methods.handleMouseDown(e);
};
const handleMouseUp = (e) => tableContext.methods.handleMouseUp(e);
const handleThrottledMouseMove = (e) => tableContext.methods.handleThrottledMouseMove(e);
const handleDblClick = (e) => tableContext.methods.handleDblClick(e);
const handleContextMenu = (e) => tableContext.methods.handleContextMenu(e);
const handleMenuAction = (action) => tableContext.methods.handleMenuAction(action);
const handleEditorInput = (e) => tableContext.methods.handleEditorInput(e);
const finishEdit = () => tableContext.methods.finishEdit();
const cancelEdit = () => tableContext.methods.cancelEdit();
const handleDragOver = (e) => tableContext.methods.handleDragOver(e);
const handleDragLeave = () => tableContext.methods.handleDragLeave();
const handleDrop = (e) => tableContext.methods.handleDrop(e);
const onScrollH = (e) => onScrollHImpl(e);
const onScrollV = (e) => onScrollVImpl(e);

// Scrollers mapping
function onScrollHImpl(e) {
  if (state.isSyncingScroll) return;
  const maxScrollX = Math.max(0, state.totalWidth - state.width);
  state.scrollX = Math.min(e.target.scrollLeft, maxScrollX);
  tableContext.methods.updateEditorPosition();
  tableContext.methods.invalidate();
  _preloadTextMetricsDebounced();
}

function onScrollVImpl(e) {
  if (state.isSyncingScroll) return;
  const maxScrollY = Math.max(0, state.totalHeight - state.height);
  state.scrollY = Math.min(e.target.scrollTop, maxScrollY);

  tableContext.methods.updateEditorPosition();
  tableContext.methods.invalidate();
  _preloadTextMetricsDebounced();

  if (props.dataController && props.dataController._scrollLoader) {
    props.dataController.handleScroll(
      state.scrollY,
      state.height,
      state.totalHeight,
      DEFAULT_ROW_HEIGHT
    ).catch(err => {
      console.error('Lazy load error:', err);
    });
  }
}

// Convert state to refs for easy template usage
const {
  scrollX,
  scrollY,
  width,
  height,
  isDragging,
  isEditing,
  editorVisible,
  editValue,
  editorPos,
  tableTheme,
  contextMenuVisible,
  contextMenuPos,
  totalWidth,
  totalHeight,
  totalRowCount,
  totalColCount,
  ariaRows,
  ariaCols
} = toRefs(state);

defineExpose({ focus });
</script>
<style scoped lang="scss">
	.vue-canvas-sheet {
		&-table-container {
			position: relative;
			width: 100%;
			height: 100%;
			overflow: hidden;
			outline: none;
		}

		&-cell-editor {
			position: absolute;
			z-index: 100;
			box-shadow: 0 0 4px rgba(0, 0, 0, 0.2);

			input {
				width: 100%;
				height: 100%;
				border: 2px solid #409eff;
				padding: 0 4px;
				box-sizing: border-box;
				outline: none;
				font-family: inherit;
				font-size: inherit;
			}
		}

		&-context-menu {
			position: absolute;
			background: #fff;
			border: 1px solid #dcdfe6;
			box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
			z-index: 200;
			min-width: 150px;
			padding: 5px 0;
			border-radius: 4px;
		}

		&-menu-item {
			padding: 8px 15px;
			font-size: 13px;
			color: #606266;
			cursor: pointer;

			&:hover {
				background: #ecf5ff;
				color: #409eff;
			}
		}

		&-divider {
			height: 1px;
			background: #ebeef5;
			margin: 5px 0;
		}

		&-scrollbar-h {
			position: absolute;
			bottom: 0;
			left: 0;
			right: 14px;
			height: 14px;
			overflow-x: scroll;
			overflow-y: hidden;
			z-index: 10;
			background: #f5f5f5;

			&::after {
				content: '';
				position: absolute;
				right: -14px;
				bottom: 0;
				width: 14px;
				height: 14px;
				background: #f5f5f5;
				z-index: 100;
			}
		}

		&-scrollbar-v {
			position: absolute;
			top: 0;
			right: 0;
			bottom: 14px;
			width: 14px;
			overflow-x: hidden;
			overflow-y: scroll;
			z-index: 10;
			background: #f5f5f5;
		}

		&-scrollbar-spacer {
			display: block;
			position: relative;
		}
	}
</style>
