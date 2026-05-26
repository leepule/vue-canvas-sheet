<template>
	<div class="vue-canvas-sheet" ref="tableDesigner">
		<Toolbar v-if="!readOnly" :active-style="activeStyle" :can-merge="canMerge" :can-unmerge="canUnmerge"
			:can-clear="canClear" v-model:freeze-row-count="freezeRowCount" v-model:freeze-col-count="freezeColCount"
			:toolbar="toolbar" @command="handleToolbarCommand">
			<template #toolbar-end>
				<slot name="toolbar-end"></slot>
			</template>
			<template #toolbar-end-group>
				<slot name="toolbar-end-group"></slot>
			</template>
		</Toolbar>
		<FormulaBar :address="activeCellAddress" :value="activeCellValue" :disabled="isFormulaBarDisabled" @input="handleFormulaInput"
			@input-start="isFormulaBarDirty = true" @confirm="handleFormulaEnter" />
		<div class="vue-canvas-sheet-body">
			<div class="vue-canvas-sheet-table-container">
				<CanvasTable ref="canvasTable" :workbook="currentWorkbook" :version="uiVersion" :read-only="readOnly"
					:data-controller="dataController" @drop-field="handleDropField"
					@trigger-find="showFindDialog = true" @selection-change="handleSelectionChange" @column-deleted="handleColumnDeleted" />
				
				<!-- 内置 Loading 遮罩层 -->
				<div v-if="loading" class="vue-canvas-sheet-loading-overlay">
					<div class="loading-content">
						<div class="loading-spinner"></div>
						<div class="loading-text">正在处理数据...</div>
					</div>
				</div>
			</div>
			<div v-if="showFindDialog" class="vue-canvas-sheet-find-dialog">
					<div class="find-dialog-header">
						<span>查找和替换</span>
						<span class="close-btn" @click="showFindDialog = false">×</span>
					</div>
					<div class="find-dialog-row">
						<label>查找内容:</label>
						<input type="text" class="find-input" v-model="findText" @keydown.enter="handleFind" placeholder="请输入查找内容" />
					</div>
					<div class="find-dialog-row">
						<label>替换为:</label>
						<input type="text" class="find-input" v-model="replaceText" placeholder="请输入替换内容" />
					</div>
					<div class="find-dialog-options">
						<label class="checkbox-label">
							<input type="checkbox" v-model="findOptions.caseSensitive" />
							<span>区分大小写</span>
						</label>
						<label class="checkbox-label">
							<input type="checkbox" v-model="findOptions.wholeWord" />
							<span>全词匹配</span>
						</label>
					</div>
					<div class="match-info" v-if="matchCount > 0">
						<span>找到 {{ matchCount }} 个匹配</span>
						<span v-if="currentMatchIndex > 0">（第 {{ currentMatchIndex }} 个）</span>
					</div>
					<div class="find-dialog-actions">
						<button class="action-btn" @click="handleFindPrevious" title="查找上一个">上一个</button>
						<button class="action-btn primary" @click="handleFind" title="查找下一个">下一个</button>
						<button class="action-btn" @click="handleFindAll" title="查找全部">查找全部</button>
						<button class="action-btn" @click="handleReplace" title="替换当前">替换</button>
						<button class="action-btn" @click="handleReplaceAll" title="全部替换">全部替换</button>
					</div>
				</div>
		</div>
	</div>
</template>
<script>
	import { markRaw } from 'vue';
	import Toolbar from "./Toolbar.vue";
	import CanvasTable from "./CanvasTable.vue";
	import FormulaBar from "./FormulaBar.vue";
	import { Workbook } from "../../core/Workbook";
	import { ThemeHelper } from "./ThemeHelper";
	import { cloneCell } from '@/core/utils/Clipboard';
	import { DataController } from "./controller/DataController";

	export default {
		name: "TableDesigner",
		components: {
			CanvasTable,
			FormulaBar,
			Toolbar
		},
		data() {
			return {
				uiVersion: 0, // Manual reactivity trigger

				showFindDialog: false,
				findText: '',
				replaceText: '',
				findOptions: {
					caseSensitive: false,
					wholeWord: false
				},
				matchCount: 0,
				currentMatchIndex: 0,
				allMatches: [],

				activeCellAddress: '',
				activeCellValue: '',
				activeStyle: {},
				freezeRowCount: 0,
				freezeColCount: 0,

				isFormulaBarDirty: false,
				lastActiveCell: null,
				originalCellData: {},
				dataController: null,
			};
		},
		computed: {
			canMerge() {
				return this.uiVersion >= 0 && this.workbook && this.workbook.selection && this.workbook.allowsMerge(this.workbook.selection);
			},
			canUnmerge() {
				return this.uiVersion >= 0 && this.workbook && this.workbook.selection && this.workbook.allowsUnmerge(this.workbook.selection);
			},
			canClear() {
				return this.uiVersion >= 0 && !!(this.workbook && this.workbook.selection);
			},
			currentWorkbook() {
				void this.uiVersion;
				return this.workbook;
			},
			isFormulaBarDisabled() {
				void this.uiVersion;
				if (!this.workbook) return false;
				const active = this.workbook.activeCell;
				if (!active) return false;
				const isLockedFn = this.workbook.plugins.getSharedState('collaboration:isCellLocked');
				if (isLockedFn) {
					return isLockedFn(active.r, active.c);
				}
				return false;
			}
		},
		methods: {
			handleToolbarCommand({ type, payload }) {
				// 如果还没有选区（用户未点击单元格），自动选中 A1
				if (!this.workbook.selection) {
					this.workbook.setSelection(0, 0, 0, 0);
				}
				switch (type) {
					case 'undo': this.handleUndo(); break;
					case 'redo': this.handleRedo(); break;
					case 'merge': this.handleMerge(); break;
					case 'unmerge': this.handleUnmerge(); break;
					case 'clear': this.handleClear(); break;
					case 'apply-style': this.handleApplyStyle(payload.key, payload.value); break;
					case 'toggle-style': this.handleToggleStyle(payload.key, payload.value); break;
					case 'format': this.handleFormat(payload); break;
					case 'decimals': this.handleDecimals(payload); break;
					case 'apply-theme': this.applyTheme(payload); break;
					case 'apply-border': this.handleApplyBorder(payload); break;
					case 'toggle-find-dialog': this.showFindDialog = !this.showFindDialog; break;
					case 'export': this.handleExportCommand(payload); break;
					case 'import-file': this.handleImportFile(payload); break;
					case 'freeze-pane': this.handleFreezePane(); break;
					case 'freeze-top': this.handleFreezeTopRow(); break;
					case 'freeze-first-col': this.handleFreezeFirstCol(); break;
					case 'unfreeze': this.handleUnfreeze(); break;
				}
			},

			triggerUpdate() {
				this.uiVersion++;
			},
			handleFreeze() {
				if (!this.workbook) return;
				this.workbook.setFreeze(this.freezeRowCount, this.freezeColCount);
				this.$refs.canvasTable.focus();
			},
			handleFreezePane() {
				if (!this.workbook || !this.workbook.activeCell) return;
				const { r, c } = this.workbook.activeCell;
				this.freezeRowCount = r;
				this.freezeColCount = c;
				this.handleFreeze();
			},
			handleFreezeTopRow() {
				this.freezeRowCount = 1;
				this.freezeColCount = 0;
				this.handleFreeze();
			},
			handleFreezeFirstCol() {
				this.freezeRowCount = 0;
				this.freezeColCount = 1;
				this.handleFreeze();
			},
			handleUnfreeze() {
				this.freezeRowCount = 0;
				this.freezeColCount = 0;
				this.handleFreeze();
			},
			handleApplyStyle(key, val) {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.setStyle(this.workbook.selection, { [key]: val });
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleToggleStyle(key, value) {
				if (!this.workbook || !this.workbook.selection) return;

				const { r, c } = this.workbook.activeCell;
				const currentStyle = this.workbook.getStyle(r, c);

				const val = currentStyle[key] === value ? undefined : value;

				this.workbook.setStyle(this.workbook.selection, { [key]: val });

				this.activeStyle[key] = val;
				this.triggerUpdate();

				this.$refs.canvasTable.focus();
			},
			handleUndo() {
				if (this.workbook) {
					this.workbook.undo();
					this.triggerUpdate();
				}
			},
			handleRedo() {
				if (this.workbook) {
					this.workbook.redo();
					this.triggerUpdate();
				}
			},
			handleMerge() {
				if (!this.workbook || !this.workbook.selection) return;
				const sel = this.workbook.selection;
				if (sel.s.r === sel.e.r && sel.s.c === sel.e.c) return;
				this.workbook.mergeCells(sel);
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleUnmerge() {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.unmergeCells(this.workbook.selection);
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleClear() {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.clearCells(this.workbook.selection);
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			applyTheme(theme) {
				if (!this.workbook) return;
				const range = this.workbook.selection;
				ThemeHelper.applyTheme(this.workbook, range, theme);
				this.triggerUpdate();
			},
			handleApplyBorder({ type, color }) {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.setBorder(this.workbook.selection, type, color, 'solid');
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleFormat(fmt) {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.setFormat(this.workbook.selection, fmt);
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleDecimals(delta) {
				if (!this.workbook || !this.workbook.selection) return;
				this.workbook.setDecimals(this.workbook.selection, delta);
				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
			handleExportCommand(command) {
				if (!this.workbook) return;
				const exportFn = this.workbook.plugins.getSharedState('export:' + command);
				if (exportFn) {
					exportFn();
				} else {
					console.warn('[TableDesigner] Export plugin not registered for:', command);
				}
			},
			handleImportFile(file) {
				if (!this.workbook) return;
				const importFn = this.workbook.plugins.getSharedState('import:file');
				if (importFn) {
					importFn(file);
				} else {
					console.warn('[TableDesigner] Import plugin not registered');
				}
			},

			/**
			 * 更新匹配计数
			 * @private
			 */
			_updateMatchCount() {
				if (!this.findText) {
					this.matchCount = 0;
					this.currentMatchIndex = 0;
					this.allMatches = [];
					return;
				}
				this.allMatches = this.workbook.search.findAll(this.findText, this.findOptions);
				this.matchCount = this.allMatches.length;
				
				// 计算当前匹配索引
				if (this.allMatches.length > 0 && this.workbook.activeCell) {
					const { r, c } = this.workbook.activeCell;
					const idx = this.allMatches.findIndex(m => m.r === r && m.c === c);
					this.currentMatchIndex = idx >= 0 ? idx + 1 : 0;
				} else {
					this.currentMatchIndex = 0;
				}
			},

			/**
			 * 查找下一个匹配
			 */
			handleFind() {
				if (!this.findText) return;
				
				const startFrom = this.workbook.activeCell || { r: 0, c: 0 };
				const res = this.workbook.search.find(this.findText, startFrom, {
					...this.findOptions,
					wrapAround: true
				});
				
				if (res) {
					this.workbook.setSelection(res.r, res.c, res.r, res.c);
					this.$refs.canvasTable.scrollIntoView(res.r, res.c);
					this._updateMatchCount();
				} else {
					this.matchCount = 0;
					this.currentMatchIndex = 0;
				}
			},

			/**
			 * 查找上一个匹配
			 */
			handleFindPrevious() {
				if (!this.findText) return;
				
				const startFrom = this.workbook.activeCell || { r: 0, c: 0 };
				const res = this.workbook.search.findPrevious(this.findText, startFrom, {
					...this.findOptions,
					wrapAround: true
				});
				
				if (res) {
					this.workbook.setSelection(res.r, res.c, res.r, res.c);
					this.$refs.canvasTable.scrollIntoView(res.r, res.c);
					this._updateMatchCount();
				} else {
					this.matchCount = 0;
					this.currentMatchIndex = 0;
				}
			},

			/**
			 * 查找全部匹配并显示
			 */
			handleFindAll() {
				if (!this.findText) return;
				
				this.allMatches = this.workbook.search.findAll(this.findText, this.findOptions);
				this.matchCount = this.allMatches.length;
				
				if (this.allMatches.length > 0) {
					const first = this.allMatches[0];
					this.workbook.setSelection(first.r, first.c, first.r, first.c);
					this.$refs.canvasTable.scrollIntoView(first.r, first.c);
					this.currentMatchIndex = 1;
				} else {
					this.currentMatchIndex = 0;
				}
			},

			/**
			 * 替换当前匹配并查找下一个
			 */
			handleReplace() {
				if (!this.findText) return;
				
				const cell = this.workbook.activeCell;
				if (!cell) {
					this.handleFind();
					return;
				}
				
				// 使用 replaceAt 替换当前单元格
				const success = this.workbook.search.replaceAt(
					this.findText,
					this.replaceText,
					{ r: cell.r, c: cell.c },
					this.findOptions
				);
				
				if (success) {
					this.triggerUpdate();
				}
				
				// 查找下一个
				this.handleFind();
			},

			/**
			 * 替换所有匹配
			 */
			handleReplaceAll() {
				if (!this.findText) return;
				
				const count = this.workbook.search.replaceAll(this.findText, this.replaceText, this.findOptions);
				this.triggerUpdate();
				this.matchCount = 0;
				this.currentMatchIndex = 0;
				this.allMatches = [];
			},
			renderPage() {
				if (this.dataController) {
					this.dataController.renderPage();
				}
			},

			setData(data) {
				if (this.dataController) {
					this.dataController.setInitialData(data);
					this.dataController.renderPage();
				}
			},
			setColumns(columns) {
				if (this.workbook) {
					this.workbook.setColumns(columns);
				}
			},
			handleDropField(payload) {
				const { field, row, col } = payload;
				if (!this.dataController) return;

				this.dataController.addBinding(field, row, col);
			},
			handleColumnDeleted(colIndex) {
				if (this.dataController) {
					this.dataController.removeColumn(colIndex);
				}
			},
			handleSelectionChange({ r, c, val, address }) {
				if (this.isFormulaBarDirty && this.lastActiveCell) {
					this.isFormulaBarDirty = false;

					const { r: lr, c: lc } = this.lastActiveCell;

					// 拦截被他人锁定的单元格修改，保证数据一致性
					const isLockedFn = this.workbook.plugins.getSharedState('collaboration:isCellLocked');
					if (!(isLockedFn && isLockedFn(lr, lc))) {
						let v = this.activeCellValue;
						const strVal = String(v);
						if (!isNaN(Number(v)) && strVal !== '') {
							v = Number(v);
						}

						const newVal = { v };
						if (strVal.startsWith('=')) {
							newVal.f = strVal;
						}

						this.workbook.setCell(lr, lc, newVal, this.originalCellData);
					}

					// 解锁旧的编辑锁
					const unlockCellFn = this.workbook.plugins.getSharedState('collaboration:unlockCell');
					if (unlockCellFn) {
						unlockCellFn(lr, lc);
					}
				}

				this.activeCellAddress = address;
				this.activeCellValue = val;
				this.lastActiveCell = { r, c };
				this.isFormulaBarDirty = false;

				const cell = this.workbook.getCell(r, c);
				this.originalCellData = cell ? cloneCell(cell) : {};
				this.activeStyle = cell ? cell.s || {} : {};
				
				this.triggerUpdate();
			},
			handleFormulaInput(val) {
				this.activeCellValue = val;
				this.isFormulaBarDirty = true;

				if (this.workbook && this.workbook.activeCell) {
					const { r, c } = this.workbook.activeCell;

					// 对公式栏输入自动加锁，避免他人并发冲突
					const lockCellFn = this.workbook.plugins.getSharedState('collaboration:lockCell');
					if (lockCellFn) {
						lockCellFn(r, c);
					}

					// 广播打字草稿
					const broadcastEditingFn = this.workbook.plugins.getSharedState('collaboration:broadcastEditing');
					if (broadcastEditingFn) {
						broadcastEditingFn(r, c, val);
					}
				}
			},
			handleFormulaEnter(val) {
				if (!this.workbook || !this.workbook.activeCell) return;

				const { r, c } = this.workbook.activeCell;

				// 拦截被他人锁定的单元格修改，并自动还原输入框显示值
				const isLockedFn = this.workbook.plugins.getSharedState('collaboration:isCellLocked');
				if (isLockedFn && isLockedFn(r, c)) {
					const lockInfoFn = this.workbook.plugins.getSharedState('collaboration:getCellLockInfo');
					const lockInfo = lockInfoFn ? lockInfoFn(r, c) : null;
					const userName = lockInfo ? lockInfo.userName : '其他用户';
					alert(`无法编辑：单元格正由用户 "${userName}" 编辑锁定中`);
					this.isFormulaBarDirty = false;
					const cell = this.workbook.getCell(r, c);
					this.activeCellValue = cell ? (cell.f || cell.v) : '';
					return;
				}

				this.activeCellValue = val;

				let v = val;
				const strVal = String(val);
				if (!isNaN(Number(val)) && strVal !== '') {
					v = Number(val);
				}

				const newVal = { v };
				if (strVal.startsWith('=')) {
					newVal.f = strVal;
				}

				this.workbook.setCell(r, c, newVal, this.originalCellData);
				this.isFormulaBarDirty = false;

				// 敲回车提交后解锁单元格
				const unlockCellFn = this.workbook.plugins.getSharedState('collaboration:unlockCell');
				if (unlockCellFn) {
					unlockCellFn(r, c);
				}

				const cell = this.workbook.getCell(r, c);
				this.originalCellData = cell ? cloneCell(cell) : {};

				this.triggerUpdate();
				this.$refs.canvasTable.focus();
			},
		},
		props: {
			loading: {
				type: Boolean,
				default: false
			},
			initialData: {
				type: [Object, Array],
				default: null
			},
			/**
			 * 显式数据重载标记。
			 * initialData 按引用变化触发重载；如果调用方原地修改同一份数据，
			 * 可以变更 reloadKey 来主动重载，避免组件内部做大对象深比较。
			 */
			reloadKey: {
				type: [String, Number, Boolean],
				default: null
			},
			columns: {
				type: Array,
				default: () => []
			},
			readOnly: {
				type: Boolean,
				default: false
			},
			plugins: {
				type: Array,
				default: () => []
			},
			toolbar: {
				type: Array,
				default: () => ['history', 'cells', 'font', 'alignment', 'numbers', 'table', 'freeze', 'data']
			},
			/**
			 * 懒加载配置
			 * @property {boolean} enabled - 是否启用懒加载
			 * @property {number} pageSize - 每页数据量
			 * @property {number} maxCachedPages - 最大缓存页数
			 * @property {number} preloadPages - 预加载页数
			 */
			lazyLoad: {
				type: Object,
				default: () => ({ enabled: false })
			},
			/**
			 * 是否启用持久化存储（秒开能力）
			 */
			enablePersistence: {
				type: Boolean,
				default: false
			},
			/**
			 * 工作表 ID（用于持久化指纹识别）
			 */
			sheetId: {
				type: String,
				default: 'default'
			}
		},
		watch: {
			initialData: {
				handler(val, oldVal) {
					if (val === oldVal) return;

					this.setData(val);
				},
			},
			reloadKey(val, oldVal) {
				if (val === oldVal) return;

				this.setData(this.initialData);
			},
			columns: {
				handler(val) {
					this.setColumns(val);
					if (this.initialData) {
						this.setData(this.initialData);
					}
				},
				deep: true
			},
			// 监听查找文本变化，更新匹配计数
			findText() {
				this._updateMatchCount();
			},
			// 监听查找选项变化
			findOptions: {
				handler() {
					this._updateMatchCount();
				},
				deep: true
			},
			readOnly(val) {
				if (this.workbook) {
					this.workbook.readOnly = val;
				}
			},
			freezeRowCount() {
				this.handleFreeze();
			},
			freezeColCount() {
				this.handleFreeze();
			}
		},
		created() {
			this.workbook = markRaw(new Workbook({
				enablePersistence: this.enablePersistence,
				sheetId: this.sheetId
			}));
			this.workbook.readOnly = this.readOnly;
			this.workbook.enableWorker();
			
			// 创建数据控制器，传入懒加载配置
			this.dataController = markRaw(new DataController(this.workbook, () => {
				this.triggerUpdate();
			}, {
				lazyLoad: this.lazyLoad && this.lazyLoad.enabled,
				pageSize: this.lazyLoad && this.lazyLoad.pageSize || 100,
				maxCachedPages: this.lazyLoad && this.lazyLoad.maxCachedPages || 10,
				preloadPages: this.lazyLoad && this.lazyLoad.preloadPages || 1
			}));

			if (this.plugins && this.plugins.length > 0) {
				this.plugins.forEach(plugin => {
					this.workbook.plugins.add(plugin);
				});
			}

			this._unsubLockChange = this.workbook.on('lock-change', () => {
				this.triggerUpdate();
			});

			if (this.columns && this.columns.length > 0) {
				this.workbook.setColumns(this.columns);
			}

			if (this.initialData) {
				this.dataController.setInitialData(this.initialData);
				this.dataController.renderPage();
			}
		},
		beforeUnmount() {
			if (this._unsubLockChange) {
				this._unsubLockChange();
			}
			// 清理数据控制器
			if (this.dataController) {
				this.dataController.destroy();
			}
		}
	};
</script>
<style scoped lang="scss">
	.vue-canvas-sheet {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		font-family: Inter, "Segoe UI", sans-serif;

		&-find-dialog {
			position: absolute;
			top: 50px;
			right: 30px;
			width: 340px;
			background: #ffffff;
			border: 1px solid #ebeef5;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
			border-radius: 8px;
			padding: 20px;
			z-index: 9999;
			display: flex;
			flex-direction: column;
			gap: 16px;
			font-size: 14px;
			color: #303133;

			.find-dialog-header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				font-weight: 600;
				font-size: 16px;
				margin-bottom: 4px;
				color: #1f2f3d;

				.close-btn {
					cursor: pointer;
					font-size: 20px;
					line-height: 1;
					color: #909399;
					transition: color 0.2s;

					&:hover {
						color: #f56c6c;
					}
				}
			}

			.find-dialog-row {
				display: flex;
				align-items: center;
				gap: 12px;

				label {
					width: 65px;
					color: #606266;
					text-align: right;
					flex-shrink: 0;
				}

				.find-input {
					flex: 1;
					padding: 0 10px;
					height: 32px;
					border: 1px solid #dcdfe6;
					border-radius: 4px;
					outline: none;
					color: #606266;
					transition: border-color 0.2s, box-shadow 0.2s;

					&::placeholder {
						color: #c0c4cc;
					}

					&:focus {
						border-color: #409eff;
						box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
					}
				}
			}

			.find-dialog-options {
				display: flex;
				gap: 20px;
				padding-left: 77px;

				.checkbox-label {
					display: flex;
					align-items: center;
					gap: 6px;
					cursor: pointer;
					font-size: 13px;
					color: #606266;
					user-select: none;

					input[type="checkbox"] {
						cursor: pointer;
						margin: 0;
						width: 14px;
						height: 14px;
						accent-color: #409eff;
					}

					&:hover {
						color: #409eff;
					}
				}
			}

			.match-info {
				padding: 8px 12px;
				background: #f0f9eb;
				border: 1px solid #e1f3d8;
				border-radius: 4px;
				font-size: 13px;
				color: #67c23a;
				display: flex;
				align-items: center;
				gap: 4px;
			}

			.find-dialog-actions {
				display: flex;
				flex-wrap: wrap;
				justify-content: flex-end;
				gap: 10px;
				margin-top: 4px;

				.action-btn {
					padding: 0 12px;
					height: 28px;
					border: 1px solid #dcdfe6;
					background: #fff;
					cursor: pointer;
					border-radius: 4px;
					color: #606266;
					font-size: 13px;
					transition: all 0.2s;
					display: inline-flex;
					align-items: center;
					justify-content: center;

					&:hover {
						color: #409eff;
						border-color: #c6e2ff;
						background-color: #ecf5ff;
					}

					&:active {
						border-color: #3a8ee6;
						outline: none;
					}

					&.primary {
						background-color: #409eff;
						border-color: #409eff;
						color: #fff;

						&:hover {
							background: #66b1ff;
							border-color: #66b1ff;
						}

						&:active {
							background: #3a8ee6;
							border-color: #3a8ee6;
						}
					}
				}
			}
		}

		&-formula-bar {
			height: 30px;
			background: #f8f8f9;
			border-bottom: 1px solid #e1e1e1;
			display: flex;
			align-items: center;
			padding: 0 5px;
			font-size: 13px;
			width: 100%;
			flex-shrink: 0;

			.cell-address {
				width: 40px;
				text-align: center;
				border-right: 1px solid #ddd;
				margin-right: 5px;
				color: #666;
				font-weight: bold;
			}

			.formula-icon {
				margin-right: 5px;
				color: #999;
				font-style: italic;
				font-family: serif;
			}

			.formula-input-wrapper {
				flex: 1;
				height: 24px;
			}

			input {
				width: 100%;
				height: 100%;
				border: 1px solid #ddd;
				padding: 0 5px;
				box-sizing: border-box;
				outline: none;

				&:focus {
					border-color: #409eff;
				}
			}
		}

		&-body {
			flex: 1;
			display: flex;
			overflow: hidden;
			position: relative;
		}

		&-table-container {
			flex: 1;
			position: relative;
			overflow: hidden;
		}

		&-loading-overlay {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background: rgba(255, 255, 255, 0.7);
			backdrop-filter: blur(2px);
			z-index: 1000;
			display: flex;
			align-items: center;
			justify-content: center;

			.loading-content {
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 12px;
			}

			.loading-spinner {
				width: 40px;
				height: 40px;
				border: 3px solid #f3f3f3;
				border-top: 3px solid #409eff;
				border-radius: 50%;
				animation: spin 1s linear infinite;
			}

			.loading-text {
				color: #409eff;
				font-size: 14px;
				font-weight: 500;
				text-shadow: 0 1px 2px rgba(255,255,255,0.8);
			}
		}

	}

	@keyframes spin {
		0% { transform: rotate(0deg); }
		100% { transform: rotate(360deg); }
	}
</style>
