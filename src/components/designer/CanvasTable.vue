<template>
	<div class="vue-canvas-sheet-table-container" tabindex="0" @keydown="onKeyDownWrapper" ref="container"
		@mousedown="onMouseDownWrapper" @mouseup="handleMouseUp" @mousemove="handleThrottledMouseMove" @dblclick="handleDblClick"
		@wheel="handleWheel" @contextmenu="handleContextMenu" @dragover="handleDragOver" @dragleave="handleDragLeave"
		@drop="handleDrop">
		<canvas ref="gridCanvas" style="position: absolute; left: 0; top: 0; z-index: 1;"></canvas>
		<canvas ref="canvas" style="position: absolute; left: 0; top: 0; z-index: 2;"></canvas>
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
<script>
	import { debounce } from 'es-toolkit';
	import { TableTheme } from './config';
	import CanvasRenderMixin from './mixins/CanvasRenderMixin';
	import CanvasInteractionMixin from './mixins/CanvasInteractionMixin';
	import OffscreenRenderMixin from './mixins/OffscreenRenderMixin';
	import ProgressiveRenderMixin from './mixins/ProgressiveRenderMixin';
	import { Events } from '../../core/events/EventEmitter';

	// 默认行高（用于懒加载计算）
	const DEFAULT_ROW_HEIGHT = 25;

	export default {
		name: 'CanvasTable',
		mixins: [CanvasRenderMixin, CanvasInteractionMixin, OffscreenRenderMixin, ProgressiveRenderMixin],
		props: {
			workbook: Object,
			readOnly: {
				type: Boolean,
				default: false
			},
			version: {
				type: Number,
				default: 0
			},
			/**
			 * 数据控制器（用于懒加载）
			 */
			dataController: {
				type: Object,
				default: null
			}
		},
		data() {
			return {
				scrollX: 0,
				scrollY: 0,
				width: 0,
				height: 0,
				isDragging: false,
				isDraggingCol: false,
				isDraggingFill: false,
				isResizingCol: false,
				isResizingRow: false,
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

				// ARIA 范围缓存，避免重复重建
				_ariaStartRow: -1,
				_ariaEndRow: -1,
				_ariaStartCol: -1,
				_ariaEndCol: -1
			};
		},
		computed: {
			rowHeaderWidth() { 
				const rowCount = this.workbook ? this.workbook.rowCount : 0;
				// 根据行数位数动态调整宽度，每位约 8px，外加左右间距
				const digits = Math.max(2, String(rowCount).length);
				return Math.floor(Math.max(40, digits * 8 + 10));
			},
			colHeaderHeight() { return TableTheme.colHeaderHeight; },
			canMerge() {
				if (!this.workbook || !this.workbook.selection) return false;
				return this.workbook.allowsMerge(this.workbook.selection);
			},
			canUnmerge() {
				if (!this.workbook || !this.workbook.selection) return false;
				return this.workbook.allowsUnmerge(this.workbook.selection);
			},
			activeCellId() {
				if (!this.workbook || !this.workbook.activeCell) return '';
				return `cell-${this.workbook.activeCell.r}-${this.workbook.activeCell.c}`;
			}
		},

		watch: {
			workbook: {
				handler(newWb, oldWb) {
					if (oldWb && oldWb.requestRender) {
						delete oldWb.requestRender;
					}
					if (newWb !== oldWb) {
						this.setupWorkbookSubscription();
						if (newWb) {
							newWb.requestRender = () => {
								this.invalidate();
							};
						}
					}
					this.updateScrollbarSize();
					this.invalidate();
				},
				immediate: true
			},
			version() {
				this.updateScrollbarSize();
				this.invalidate();
			}
		},
		mounted() {
			this.initCanvas();
			
			// 初始化离屏渲染器（可选）
			// 如果支持 OffscreenCanvas，将使用 Worker 渲染
				const usingOffscreen = this.initOffscreenRenderer({
					enableWorker: true,
					timeout: 5000
				});
				if (!usingOffscreen && !this.ctx && this.$refs.canvas) {
					this.ctx = this.$refs.canvas.getContext('2d');
				}
			
			// 初始化渐进式渲染器
			this.initProgressiveRenderer();
			
			// 初始化节流/防抖方法
			if (this._initThrottledMethods) {
				this._initThrottledMethods();
			}
			
			this._handleResizeDebounced = debounce(() => {
				this.handleResize();
			}, 16);
			
			this._preloadTextMetricsDebounced = debounce(() => {
				this.preloadTextMetrics();
			}, 100);

			this.resizeObserver = new ResizeObserver(this._handleResizeDebounced);
			if (this.$refs.container) {
				this.resizeObserver.observe(this.$refs.container);
			}

			this.setupWorkbookSubscription();
			this.startAnimation();
			this.handleResize();
			this.updateScrollbarSize();
		},
		beforeUnmount() {
			// 清理 ResizeObserver
			if (this.resizeObserver) {
				this.resizeObserver.disconnect();
			}
			// 清理 workbook 订阅（旧版）
			if (this.workbookUnsub) {
				this.workbookUnsub();
				this.workbookUnsub = null;
			}
			// 清理新版事件订阅
			if (this._eventUnsubs) {
				this._eventUnsubs.forEach(unsub => unsub());
				this._eventUnsubs = null;
			}
			// 清理动画循环
			this.stopAnimation();
			// 清理离屏渲染器
			this.destroyOffscreenRenderer();
			// 清理渐进式渲染器
			this.destroyProgressiveRenderer();
			// 清理节流/防抖方法（同时通过 AbortController 解绑 drag 期 window 监听器）
			if (this._cleanupThrottledMethods) {
				this._cleanupThrottledMethods();
			}
			// 清理 workbook 上的 requestRender 回调，避免组件销毁后仍被外部调用
			if (this.workbook) {
				delete this.workbook.requestRender;
			}
			// 释放离屏网格缓存 canvas
			this._gridLayerCache = null;
		},
		methods: {
			invalidateSelection() {
				this.renderSelectionRequested = true;
				this.render();
			},
			invalidateAnimation() {
				this.renderAnimationRequested = true;
				this.render();
			},
			startAnimation() {
				// 优化：只在有复制范围时启动动画循环
				// 蚂蚁线动画只在 copyRange 存在时需要
				this._checkAnimationNeed();
			},
			
			/**
			 * 检查是否需要启动/停止动画
			 * @private
			 */
			_checkAnimationNeed() {
				const needAnimation = this.workbook && this.workbook.copyRange;
				
				if (needAnimation && !this.animationId) {
					// 需要动画且未启动，启动动画
					this._startAnimationLoop();
				} else if (!needAnimation && this.animationId) {
					// 不需要动画但正在运行，停止动画
					this.stopAnimation();
				}
			},
			
			/**
			 * 启动动画循环
			 * @private
			 */
			_startAnimationLoop() {
				const loop = () => {
					if (!this.workbook || !this.workbook.copyRange) {
						// 复制范围已清除，停止动画
						this.animationId = null;
						return;
					}
					// 只请求动画层重绘，不影响选区层
					this.invalidateAnimation();
					this.animationId = requestAnimationFrame(loop);
				};
				this.animationId = requestAnimationFrame(loop);
			},
			
			stopAnimation() {
				if (this.animationId) {
					cancelAnimationFrame(this.animationId);
					this.animationId = null;
				}
			},
			setupWorkbookSubscription() {
				// 清理旧订阅
				if (this.workbookUnsub) {
					this.workbookUnsub();
					this.workbookUnsub = null;
				}
				if (this._eventUnsubs) {
					this._eventUnsubs.forEach(unsub => unsub());
					this._eventUnsubs = [];
				}
				
				if (this.workbook) {
					this._eventUnsubs = [];
					
					// 使用新事件系统订阅选区变化
					this._eventUnsubs.push(
						this.workbook.on('selection-change', (payload) => {
							if (this.workbook.activeCell) {
								const { r, c } = this.workbook.activeCell;
								const cell = this.workbook.getCell(r, c);
								const val = cell ? (cell.f ? cell.f : (cell.v !== undefined ? cell.v : '')) : '';
								const address = this.workbook.getAddress(r, c);
								
								if (this.lastActiveRef !== address) {
									this.lastActiveRef = address;
									this.scrollIntoView(r, c);
								}
								
								this.$emit('selection-change', {
									r, c,
									val,
									address
								});
							}
						})
					);
					
					// 订阅结构变化（行列增删）
					this._eventUnsubs.push(
						this.workbook.on('structure-change', () => {
							this.updateScrollbarSize();
							this.updateEditorPosition();
							this.invalidate(null, { structural: true });
						})
					);
					
					// 订阅数据加载
					this._eventUnsubs.push(
						this.workbook.on('data-load', () => {
							this.updateScrollbarSize();
							this.updateEditorPosition();
							this.invalidate(null, { structural: true });
						})
					);

					// 订阅异步计算完成事件（增量计算引擎）
					this._eventUnsubs.push(
						this.workbook.on(Events.FORMULAS_CALCULATED, (payload) => {
							if (payload && payload.results && payload.results.length > 0) {
								// 计算所有变更单元格的包围盒，或者逐个标记失效
								// 这里我们逐个调用 invalidate，mixin 内部会自动合并为 dirtyRect
								payload.results.forEach(res => {
									const { r, c } = this.workbook._parseKey(res.cellId);
									const rect = this.getCellScreenRect(r, c);
									this.invalidate(rect, { content: true });
								});
							} else {
								this.invalidate(null, { content: true });
							}
						})
					);
					
					// 订阅通用变化事件（兼容旧版行为）
					this.workbookUnsub = this.workbook.subscribe((data) => {
						this.updateScrollbarSize();
						this.updateEditorPosition();

						if (data && data.type === 'selection') {
							// 纯选区/复制框变化：仅刷新 selection overlay 层，避免整表重渲
							this.invalidateSelection();
							return;
						}

						if (data && data.r !== undefined && data.c !== undefined) {
							// 局部重绘优化：只重绘受影响的单元格区域
							const rect = this.getCellScreenRect(data.r, data.c);
							this.invalidate(rect, { content: true });
						} else {
							// 结构性变化或全量变化，全量重绘
							this.invalidate(null, { structural: true });
						}
						
						// 检查是否需要启动/停止动画（copyRange 变化时）
						this._checkAnimationNeed();
					});
				}
			},
			initCanvas() {
				const canvas = this.$refs.canvas;
				const canUseOffscreen = typeof canvas.transferControlToOffscreen === 'function' &&
					typeof OffscreenCanvas !== 'undefined' &&
					typeof Worker !== 'undefined';

				const selectionCanvas = this.$refs.selectionCanvas;
				this.ctxSelection = selectionCanvas.getContext('2d');

				const animationCanvas = this.$refs.animationCanvas;
				this.ctxAnimation = animationCanvas.getContext('2d');

				const gridCanvas = this.$refs.gridCanvas;
				this.ctxGrid = gridCanvas.getContext('2d');

				const dpr = window.devicePixelRatio || 1;
				this.dpr = dpr;

				if (!canUseOffscreen) {
					this.ctx = canvas.getContext('2d');
				}
			},

			updateScrollbarSize() {
				if (!this.workbook) return;
				this.totalWidth = this.workbook.totalWidth + this.rowHeaderWidth;
				this.totalHeight = this.workbook.totalHeight + this.colHeaderHeight;
			},

			syncScrollbars() {
				this.isSyncingScroll = true;
				if (this.$refs.scrollH) this.$refs.scrollH.scrollLeft = this.scrollX;
				if (this.$refs.scrollV) this.$refs.scrollV.scrollTop = this.scrollY;
				this.isSyncingScroll = false;
			},

			onScrollH(e) {
				if (this.isSyncingScroll) return;
				const maxScrollX = Math.max(0, this.totalWidth - this.width);
				this.scrollX = Math.min(e.target.scrollLeft, maxScrollX);
				this.updateEditorPosition();
				this.invalidate();
				this._preloadTextMetricsDebounced();
			},

			/**
			 * 垂直滚动事件处理
			 * 支持懒加载模式
			 */
			onScrollV(e) {
				if (this.isSyncingScroll) return;
				const maxScrollY = Math.max(0, this.totalHeight - this.height);
				this.scrollY = Math.min(e.target.scrollTop, maxScrollY);

				// 先渲染，确保 canvas 立即响应滚动
				this.updateEditorPosition();
				this.invalidate();
				this._preloadTextMetricsDebounced();

				// 懒加载 fire-and-forget
				if (this.dataController && this.dataController._scrollLoader) {
					this.dataController.handleScroll(
						this.scrollY,
						this.height,
						this.totalHeight,
						DEFAULT_ROW_HEIGHT
					).catch(err => {
						console.error('Lazy load error:', err);
					});
				}
			},

			handleResize() {
				const container = this.$refs.container;
				if (!container) return;

				const { width, height } = container.getBoundingClientRect();
				this.width = width;
				this.height = height;

				const canvas = this.$refs.canvas;
				const dpr = this.dpr;

				// 如果使用离屏渲染，由 OffscreenRenderer 管理 Canvas 尺寸
				// 否则手动设置
				if (!this.isOffscreenActive) {
					if (!this.ctx) {
						this.ctx = canvas.getContext('2d');
					}
					canvas.width = width * dpr;
					canvas.height = height * dpr;
					canvas.style.width = width + 'px';
					canvas.style.height = height + 'px';
					if (this.ctx) {
						this.ctx.setTransform(1, 0, 0, 1, 0, 0);
						this.ctx.scale(dpr, dpr);
					}
				}

				const selectionCanvas = this.$refs.selectionCanvas;
				selectionCanvas.width = width * dpr;
				selectionCanvas.height = height * dpr;
				selectionCanvas.style.width = width + 'px';
				selectionCanvas.style.height = height + 'px';
				this.ctxSelection.setTransform(1, 0, 0, 1, 0, 0);
				this.ctxSelection.scale(dpr, dpr);

				const animationCanvas = this.$refs.animationCanvas;
				animationCanvas.width = width * dpr;
				animationCanvas.height = height * dpr;
				animationCanvas.style.width = width + 'px';
				animationCanvas.style.height = height + 'px';
				this.ctxAnimation.setTransform(1, 0, 0, 1, 0, 0);
				this.ctxAnimation.scale(dpr, dpr);

				const gridCanvas = this.$refs.gridCanvas;
				gridCanvas.width = width * dpr;
				gridCanvas.height = height * dpr;
				gridCanvas.style.width = width + 'px';
				gridCanvas.style.height = height + 'px';
				this.ctxGrid.setTransform(1, 0, 0, 1, 0, 0);
				this.ctxGrid.scale(dpr, dpr);
				this.renderGridRequested = true;

				// 通知离屏渲染器尺寸变化
				if (this.offscreenRenderer) {
					this.offscreenRenderer.resize(width, height).then((usingOffscreen) => {
						if (!usingOffscreen && !this.ctx && canvas) {
							this.ctx = canvas.getContext('2d');
							if (this.ctx) {
								this.ctx.setTransform(1, 0, 0, 1, 0, 0);
								this.ctx.scale(dpr, dpr);
							}
						}
					});
				}

				this.invalidate();
				this.updateEditorPosition();
			},

			/**
			 * 鼠标滚轮事件处理
			 * 支持懒加载模式
			 */
			handleWheel(e) {
				e.preventDefault();

				const dx = e.deltaX;
				const dy = e.deltaY;

				const maxScrollX = Math.max(0, this.totalWidth - this.width);
				const maxScrollY = Math.max(0, this.totalHeight - this.height);

				const newX = Math.max(0, Math.min(this.scrollX + dx, maxScrollX));
				const newY = Math.max(0, Math.min(this.scrollY + dy, maxScrollY));

				this.scrollX = newX;
				this.scrollY = newY;

				// 先渲染，确保 canvas 立即响应滚动
				this.syncScrollbars();
				this.updateEditorPosition();
				this.render();
				this._preloadTextMetricsDebounced();

				// 懒加载 fire-and-forget：数据到达后会触发额外渲染
				if (this.dataController && this.dataController._scrollLoader) {
					this.dataController.handleScroll(
						this.scrollY,
						this.height,
						this.totalHeight,
						DEFAULT_ROW_HEIGHT
					).catch(err => {
						console.error('Lazy load error:', err);
					});
				}
			},

			focus() {
				if (this.$refs.container) {
					this.$refs.container.focus();
				}
			},

			getColAt(x) {
				if (x < this.rowHeaderWidth) return -1;

				const freezeC = this.workbook.freeze.c || 0;
				let cx = this.rowHeaderWidth;

				const frozenWidth = this.workbook.getColPos(freezeC);
				if (x < cx + frozenWidth) {
					const idx = this.workbook.getColIndexAt(x - cx);
					// 边界限制：确保返回值在有效列范围内（0 到 colCount-1）
					return idx < this.workbook.colCount ? idx : -1;
				}

				const contentX = x - (cx + frozenWidth) + this.scrollX;
				const idx = this.workbook.getColIndexAt(contentX + frozenWidth);
				// 边界限制：必须 >= freezeC 且 < colCount
				if (idx < freezeC) return -1;
				return idx < this.workbook.colCount ? idx : -1;
			},

			getRowAt(y) {
				if (y < this.colHeaderHeight) return -1;

				const freezeR = this.workbook.freeze.r || 0;
				let cy = this.colHeaderHeight;

				const frozenHeight = this.workbook.getRowPos(freezeR);
				if (y < cy + frozenHeight) {
					const idx = this.workbook.getRowIndexAt(y - cy);
					// 边界限制：确保返回值在有效行范围内（0 到 rowCount-1）
					return idx < this.workbook.rowCount ? idx : -1;
				}

				const contentY = y - (cy + frozenHeight) + this.scrollY;
				const idx = this.workbook.getRowIndexAt(contentY + frozenHeight);
				// 边界限制：必须 >= freezeR 且 < rowCount
				if (idx < freezeR) return -1;
				return idx < this.workbook.rowCount ? idx : -1;
			},

			startEdit(r, c, initialValue = null) {
				if (this.readOnly) return;
				const merge = this.workbook.getMerge(r, c);
				let targetR = r;
				let targetC = c;
				if (merge) {
					targetR = merge.s.r;
					targetC = merge.s.c;
				}

				// 检查该单元格是否被他人锁定
				const isLockedFn = this.workbook.plugins.getSharedState('collaboration:isCellLocked');
				if (isLockedFn && isLockedFn(targetR, targetC)) {
					const lockInfoFn = this.workbook.plugins.getSharedState('collaboration:getCellLockInfo');
					const lockInfo = lockInfoFn ? lockInfoFn(targetR, targetC) : null;
					const userName = lockInfo ? lockInfo.userName : '其他用户';
					alert(`无法编辑：单元格正由用户 "${userName}" 编辑锁定中`);
					return;
				}

				// 主动对该单元格在本地及全网加锁
				const lockCellFn = this.workbook.plugins.getSharedState('collaboration:lockCell');
				if (lockCellFn) {
					lockCellFn(targetR, targetC);
				}

				const cell = this.workbook.getCell(targetR, targetC);
				this.editValue = initialValue !== null ? initialValue : (cell ? (cell.f || cell.v) : '');
				this.isEditing = true;
				this.editorVisible = true;
				this.editingCell = { r: targetR, c: targetC };

				// 如果有初始值（例如键盘直接敲击输入），立即广播草稿
				if (initialValue !== null) {
					const broadcastEditingFn = this.workbook.plugins.getSharedState('collaboration:broadcastEditing');
					if (broadcastEditingFn) {
						broadcastEditingFn(targetR, targetC, initialValue);
					}
				}

				this.updateEditorPosition();
				this.$nextTick(() => {
					if (this.$refs.editor) this.$refs.editor.focus();
				});
			},

			getCellScreenRect(r, c) {
				const wb = this.workbook;
				const merge = wb.getMerge(r, c);
				const targetR = merge ? merge.s.r : r;
				const targetC = merge ? merge.s.c : c;
				const freezeC = wb.freeze.c || 0;
				const freezeR = wb.freeze.r || 0;
				const frozenWidth = wb.getColPos(freezeC);
				const frozenHeight = wb.getRowPos(freezeR);
				const rowHeaderWidth = this.rowHeaderWidth;
				const colHeaderHeight = this.colHeaderHeight;

				const x = targetC < freezeC
					? rowHeaderWidth + wb.getColPos(targetC)
					: rowHeaderWidth + frozenWidth + wb.getColPos(targetC) - wb.getColPos(freezeC) - this.scrollX;
				const y = targetR < freezeR
					? colHeaderHeight + wb.getRowPos(targetR)
					: colHeaderHeight + frozenHeight + wb.getRowPos(targetR) - wb.getRowPos(freezeR) - this.scrollY;

				let w = wb.getColWidth(targetC);
				let h = wb.getRowHeight(targetR);
				if (merge) {
					w = 0;
					for (let mc = merge.s.c; mc <= merge.e.c; mc++) w += wb.getColWidth(mc);
					h = 0;
					for (let mr = merge.s.r; mr <= merge.e.r; mr++) h += wb.getRowHeight(mr);
				}

				return { x, y, w, h, r: targetR, c: targetC };
			},

			isEditorRectVisible(rect) {
				const wb = this.workbook;
				const freezeC = wb.freeze.c || 0;
				const freezeR = wb.freeze.r || 0;
				const frozenWidth = wb.getColPos(freezeC);
				const frozenHeight = wb.getRowPos(freezeR);
				const left = rect.c < freezeC ? this.rowHeaderWidth : this.rowHeaderWidth + frozenWidth;
				const top = rect.r < freezeR ? this.colHeaderHeight : this.colHeaderHeight + frozenHeight;
				const right = this.width - 14;
				const bottom = this.height - 14;

				return rect.x >= left &&
					rect.y >= top &&
					rect.x + rect.w <= right &&
					rect.y + rect.h <= bottom;
			},

			updateEditorPosition() {
				if (!this.isEditing || !this.editingCell || !this.workbook) return;
				const rect = this.getCellScreenRect(this.editingCell.r, this.editingCell.c);
				this.editorPos = {
					x: rect.x,
					y: rect.y,
					w: rect.w,
					h: rect.h
				};
				this.editorVisible = this.isEditorRectVisible(rect);
			},

			finishEdit() {
				if (!this.isEditing) return;
				this.isEditing = false;
				this.editorVisible = false;

				const { r, c } = this.editingCell || this.workbook.activeCell;

				let val = this.editValue;
				const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
				const num = parseFloat(cleanVal);
				if (!isNaN(num) && String(num) === cleanVal) val = num;

				this.workbook.setCell(r, c, { v: val });

				// 释放编辑锁
				const unlockCellFn = this.workbook.plugins.getSharedState('collaboration:unlockCell');
				if (unlockCellFn) {
					unlockCellFn(r, c);
				}

				this.editingCell = null;
				this.focus();
			},

			/**
			 * 自动调整列宽
			 * 使用采样策略优化大数据量表格的性能
			 * @param {number} c - 列索引
			 * @param {Object} options - 配置选项
			 * @param {number} options.sampleSize - 采样数量（默认100行）
			 * @param {boolean} options.includeFirst - 是否包含首行（默认true）
			 * @param {boolean} options.includeLast - 是否包含末行（默认true）
			 */
			autoFitColumn(c, options = {}) {
				if (!this.ctx || !this.workbook) return;

				const {
					sampleSize = 100,
					includeFirst = true,
					includeLast = true
				} = options;

				let maxW = 0;
				const PADDING = 10;
				const MIN_W = 50;
				const rowCount = this.workbook.rowCount;

				// 测量表头
				this.ctx.font = `${this.tableTheme.headerFontSize} ${this.tableTheme.fontFamily}`;
				const headerText = String.fromCharCode(65 + c);
				maxW = Math.max(maxW, this.ctx.measureText(headerText).width);

				this.ctx.font = `${this.tableTheme.fontSize} ${this.tableTheme.fontFamily}`;

				// 采样策略：对于大数据量使用采样而非全量遍历
				if (rowCount <= sampleSize) {
					// 数据量小，全量遍历
					for (let r = 0; r < rowCount; r++) {
						const cell = this.workbook.getCell(r, c);
						if (cell && cell.v) {
							const val = String(cell.v);
							const w = this.ctx.measureText(val).width;
							maxW = Math.max(maxW, w);
						}
					}
				} else {
					// 数据量大，使用采样策略
					const sampledRows = new Set();
					
					// 始终采样首行
					if (includeFirst) sampledRows.add(0);
					
					// 始终采样末行
					if (includeLast) sampledRows.add(rowCount - 1);
					
					// 均匀采样中间行
					const step = Math.floor(rowCount / (sampleSize - 2));
					for (let i = 1; i < sampleSize - 2; i++) {
						sampledRows.add(i * step);
					}
					
					// 采样可见区域（如果有滚动）
					if (this.scrollY > 0 || this.height > 0) {
						const startR = this.workbook.getRowIndexAt(this.scrollY);
						const endR = this.workbook.getRowIndexAt(this.scrollY + this.height);
						for (let r = Math.max(0, startR); r <= Math.min(rowCount - 1, endR); r++) {
							sampledRows.add(r);
						}
					}
					
					// 测量采样行
					for (const r of sampledRows) {
						if (r < 0 || r >= rowCount) continue;
						const cell = this.workbook.getCell(r, c);
						if (cell && cell.v) {
							const val = String(cell.v);
							const w = this.ctx.measureText(val).width;
							maxW = Math.max(maxW, w);
						}
					}
				}

				const newWidth = Math.max(MIN_W, maxW + PADDING);

				const oldW = this.workbook.getColWidth(c);
				if (Math.abs(newWidth - oldW) > 1) {
					this.workbook.history.execute({
						type: 'set-col-width',
						c: c,
						oldValue: oldW,
						newValue: newWidth
					});
				}
			},

			/**
			 * 异步预取文本测量结果
			 */
			async preloadTextMetrics() {
				if (!this.offscreenRenderer || !this.offscreenRenderer.isUsingWorker()) return;
				
				const range = this._getVisibleRange();
				if (!range) return;
				
				// 扩大扫描范围（缓冲区）
				const preloadRange = {
					startRow: Math.max(0, range.startRow - 10),
					endRow: Math.min(this.workbook.rowCount - 1, range.endRow + 30),
					startCol: Math.max(0, range.startCol - 5),
					endCol: Math.min(this.workbook.colCount - 1, range.endCol + 10)
				};
				
				const items = this._scanPreloadText(preloadRange);
				if (items.length === 0) return;
				
				try {
					const widths = await this.offscreenRenderer.measureTextBatch(items);
					if (widths && widths.length === items.length) {
						const resultPool = {};
						items.forEach((item, i) => {
							resultPool[item.key] = widths[i];
						});
						this.importMeasuredMetrics(resultPool);
					}
				} catch (err) {
					console.warn('Preload text metrics failed:', err);
				}
			},
			
			onKeyDownWrapper(e) {
				if (this.readOnly) return;
				this.handleKeyDown(e);
			},

			onMouseDownWrapper(e) {
				if (this.contextMenuVisible) {
					this.contextMenuVisible = false;
				}
				if (e.target.classList.contains('vue-canvas-sheet-scrollbar-h') ||
					e.target.classList.contains('vue-canvas-sheet-scrollbar-v') ||
					e.target.classList.contains('vue-canvas-sheet-scrollbar-spacer')) {
					return;
				}
				if (this.readOnly) return;
				this.handleMouseDown(e);
			},

			handleContextMenu(e) {
				e.preventDefault();
				if (this.readOnly) return;

				const rect = this.$refs.canvas.getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;

				this.contextMenuPos = { x: x, y: y };

				const c = this.getColAt(x);
				const r = this.getRowAt(y);
				this.contextMenuTarget = { r, c };
				this.contextMenuVisible = true;
			},

			handleMenuAction(action) {
				if (this.readOnly) return;
				this.contextMenuVisible = false;
				const { r, c } = this.contextMenuTarget || {};

				const targetR = r !== -1 ? r : (this.workbook.activeCell?.r ?? 0);
				const targetC = c !== -1 ? c : (this.workbook.activeCell?.c ?? 0);

				switch (action) {
					case 'insertRow': this.workbook.insertRow(targetR); break;
					case 'deleteRow':
						if (this.isRangeLocked && this.isRangeLocked(targetR, 0, targetR, this.workbook.colCount - 1)) {
							alert('操作被拦截：所删行包含他人正在编辑锁定的单元格，无法删除。');
							return;
						}
						this.workbook.deleteRow(targetR);
						break;
					case 'insertColumn': this.workbook.insertColumn(targetC); break;
					case 'deleteColumn': 
						if (this.isRangeLocked && this.isRangeLocked(0, targetC, this.workbook.rowCount - 1, targetC)) {
							alert('操作被拦截：所删列包含他人正在编辑锁定的单元格，无法删除。');
							return;
						}
						this.workbook.deleteColumn(targetC); 
						this.$emit('column-deleted', targetC);
						break;
					case 'merge':
						this.workbook.mergeCells(this.workbook.selection);
						break;
					case 'unmerge':
						this.workbook.unmergeCells(this.workbook.selection);
						break;
					case 'clear':
						if (this.isSelectionLocked && this.isSelectionLocked()) {
							alert('操作被拦截：所选区域包含他人正在编辑锁定的单元格，无法清除。');
							return;
						}
						this.workbook.clearContent(this.workbook.selection);
						break;
					case 'copy':
						this.handleCopy();
						break;
					case 'paste':
						this.handlePaste();
						break;
				}
			},

			cancelEdit() {
				this.isEditing = false;
				this.editorVisible = false;
				if (this.editingCell) {
					const unlockCellFn = this.workbook.plugins.getSharedState('collaboration:unlockCell');
					if (unlockCellFn) {
						unlockCellFn(this.editingCell.r, this.editingCell.c);
					}
				}
				this.focus();
			},

			handleEditorInput(e) {
				const broadcastEditingFn = this.workbook.plugins.getSharedState('collaboration:broadcastEditing');
				if (broadcastEditingFn && this.editingCell) {
					broadcastEditingFn(this.editingCell.r, this.editingCell.c, this.editValue);
				}
			},

			async handleCopy() {
				const sel = this.workbook.selection;
				let text = '';

				for (let r = sel.s.r; r <= sel.e.r; r++) {
					const rowData = [];
					for (let c = sel.s.c; c <= sel.e.c; c++) {
						const cell = this.workbook.getCell(r, c);
						let val = cell ? (cell.v !== undefined ? cell.v : '') : '';
						rowData.push(val);
					}
					text += rowData.join('\t') + (r < sel.e.r ? '\n' : '');
				}

				try {
					await navigator.clipboard.writeText(text);
					this.workbook.setCopyRange(sel);
				} catch (err) {
					console.error('Failed to copy', err);
				}
			},

			async handlePaste() {
				if (this.readOnly) return;
				try {
					const text = await navigator.clipboard.readText();
					if (!text) return;

					const rows = text.split(/\r?\n/);
					const startR = this.workbook.activeCell.r;
					const startC = this.workbook.activeCell.c;

					// 预计算粘贴覆盖的范围，拦截被他人锁定的单元格修改
					let maxCols = 0;
					rows.forEach((rowStr, i) => {
						if (i === rows.length - 1 && rowStr === '') return;
						const cols = rowStr.split('\t');
						maxCols = Math.max(maxCols, cols.length);
					});
					const endR = Math.min(this.workbook.rowCount - 1, startR + rows.length - 1);
					const endC = Math.min(this.workbook.colCount - 1, startC + maxCols - 1);

					if (this.isRangeLocked && this.isRangeLocked(startR, startC, endR, endC)) {
						alert('操作被拦截：粘贴的目标区域包含他人正在编辑的锁定单元格，无法粘贴。');
						return;
					}

					this.workbook.history.startBatch();

					rows.forEach((rowStr, i) => {
						if (i === rows.length - 1 && rowStr === '') return;
						const cols = rowStr.split('\t');
						cols.forEach((val, j) => {
							const r = startR + i;
							const c = startC + j;
							if (r < this.workbook.rowCount && c < this.workbook.colCount) {
								let v = val;
								const num = parseFloat(val);
								if (!isNaN(num) && isFinite(val) && String(val).trim() !== '') {
									v = num;
								}
								this.workbook.setCell(r, c, { v });
							}
						});
					});

					this.workbook.history.endBatch();
					this.workbook.clearCopyRange();
				} catch (err) {
					console.error('Failed to paste:', err);
				}
			},

			handleDragOver(e) {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'copy';

				const rect = this.$refs.canvas.getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;
				const c = this.getColAt(x);
				const r = this.getRowAt(y);

				if (r >= 0 && c >= 0) {
					if (!this.dragOverCell || this.dragOverCell.r !== r || this.dragOverCell.c !== c) {
						this.dragOverCell = { r, c };
						this.render();
					}
				} else {
					if (this.dragOverCell) {
						this.dragOverCell = null;
						this.render();
					}
				}
			},

			handleDragLeave() {
				if (this.dragOverCell) {
					this.dragOverCell = null;
					this.render();
				}
			},

			handleDrop(e) {
				this.dragOverCell = null;
				this.render();

				if (this.readOnly) return;
				e.preventDefault();

				try {
					const json = e.dataTransfer.getData('application/json');
					if (!json) return;

					const payload = JSON.parse(json);
					if (payload.type === 'field' && payload.data) {
						const rect = this.$refs.canvas.getBoundingClientRect();
						const x = e.clientX - rect.left;
						const y = e.clientY - rect.top;

						const c = this.getColAt(x);
						const r = this.getRowAt(y);

						if (r >= 0 && c >= 0) {
							const field = payload.data;
							this.$emit('drop-field', {
								field: field,
								row: r,
								col: c
							});
							this.$refs.container.focus();
						}
					}
				} catch (err) {
					console.error('Drop error:', err);
				}
			},

			isSelected(r, c) {
				if (!this.workbook || !this.workbook.selection) return false;
				const sel = this.workbook.selection;
				return r >= sel.s.r && r <= sel.e.r && c >= sel.s.c && c <= sel.e.c;
			},

			getCellValue(r, c) {
				const cell = this.workbook.getCell(r, c);
				return cell ? (cell.v !== undefined ? cell.v : '') : '';
			}
		}
	};
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
