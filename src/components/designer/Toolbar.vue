<template>
	<div class="vue-canvas-sheet-toolbar" ref="toolbarContainer">
		<ToolbarGroup v-if="isToolbarVisible('history')" label="撤销" icon="undo" :compact="toolbarGroups.history.compact">
			<button class="vue-canvas-sheet-tool-btn" title="撤销" @click="$emit('command', { type: 'undo' })">
				<SvgIcon name="undo" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" title="重做" @click="$emit('command', { type: 'redo' })">
				<SvgIcon name="redo" />
			</button>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('cells')" label="单元格" icon="merge-cells" :compact="toolbarGroups.cells.compact">
			<button class="vue-canvas-sheet-tool-btn" :class="{ active: canUnmerge }" :disabled="!canMerge && !canUnmerge" @click="$emit('command', { type: canUnmerge ? 'unmerge' : 'merge' })" :title="canUnmerge ? '拆分' : '合并'">
				<SvgIcon name="merge-cells" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :disabled="!canClear" @click="$emit('command', { type: 'clear' })" title="清除">
				<SvgIcon name="clear-formatting" />
			</button>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('font')" label="字体" icon="bold" :compact="toolbarGroups.font.compact" :popover-width="280">
			<select class="native-select font-size-select" :value="activeStyle.fontSize || 13" @change="val => $emit('command', { type: 'apply-style', payload: { key: 'fontSize', value: Number(val.target.value) } })">
				<option v-for="size in [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30]" :key="size" :value="size">{{ size }}</option>
			</select>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.fw === 'bold' || activeStyle.bold}"
				@click="$emit('command', { type: 'toggle-style', payload: { key: 'bold', value: true } })" title="加粗">
				<SvgIcon name="bold" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.fs === 'italic' || activeStyle.italic}"
				@click="$emit('command', { type: 'toggle-style', payload: { key: 'italic', value: true } })" title="斜体">
				<SvgIcon name="italic" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.td === 'line-through'}"
				@click="$emit('command', { type: 'toggle-style', payload: { key: 'td', value: 'line-through' } })" title="删除线">
				<SvgIcon name="strike-through" />
			</button>
			<div class="color-picker-wrapper">
				<input type="color" class="native-color-picker" :value="activeStyle.color || '#000000'" @input="val => $emit('command', { type: 'apply-style', payload: { key: 'color', value: val.target.value } })" />
				<span class="color-underline" :style="{backgroundColor: activeStyle.color || '#000000'}"></span>
			</div>
			<div class="color-picker-wrapper">
				<input type="color" class="native-color-picker" :value="activeStyle.bg || activeStyle.bgcolor || '#ffffff'" @input="val => $emit('command', { type: 'apply-style', payload: { key: 'bg', value: val.target.value } })" />
				<span class="color-underline" :style="{backgroundColor: activeStyle.bg || activeStyle.bgcolor || '#ffffff'}"></span>
			</div>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('alignment')" label="对齐" icon="align-left" :compact="toolbarGroups.alignment.compact">
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.align === 'left'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'align', value: 'left' } })" title="左对齐">
				<SvgIcon name="align-left" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.align === 'center'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'align', value: 'center' } })" title="居中">
				<SvgIcon name="align-center" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.align === 'right'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'align', value: 'right' } })" title="右对齐">
				<SvgIcon name="align-right" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.valign === 'top'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'valign', value: 'top' } })" title="顶端对齐">
				<SvgIcon name="align-top" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.valign === 'middle'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'valign', value: 'middle' } })" title="垂直居中">
				<SvgIcon name="align-middle" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.valign === 'bottom'}"
				@click="$emit('command', { type: 'apply-style', payload: { key: 'valign', value: 'bottom' } })" title="底端对齐">
				<SvgIcon name="align-bottom" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" :class="{active: activeStyle.wrap}" @click="$emit('command', { type: 'toggle-style', payload: { key: 'wrap', value: true } })"
				title="换行">
				<SvgIcon name="text-wrap" />
			</button>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('numbers')" label="数字" icon="percent" :compact="toolbarGroups.numbers.compact">
			<button class="vue-canvas-sheet-tool-btn" title="千分位" @click="$emit('command', { type: 'format', payload: 'comma' })">
				<SvgIcon name="numbered-list" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" title="百分比" @click="$emit('command', { type: 'format', payload: 'percent' })">
				<SvgIcon name="percent" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" title="增加小数位" @click="$emit('command', { type: 'decimals', payload: 1 })">
				<SvgIcon name="decimal-increase" />
			</button>
			<button class="vue-canvas-sheet-tool-btn" title="减少小数位" @click="$emit('command', { type: 'decimals', payload: -1 })">
				<SvgIcon name="decimal-decrease" />
			</button>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('table')" label="表格" icon="border-all" :compact="toolbarGroups.table.compact">
			<div class="popover-wrapper">
				<button class="vue-canvas-sheet-tool-btn" title="主题" @click.stop="togglePopover('theme')">
					<SvgIcon name="color-palette" />
				</button>
				<div class="popover-content vue-canvas-sheet-toolbar-popover" v-if="showThemeMenu" @click.stop>
					<div class="vue-canvas-sheet-theme-menu">
						<div class="vue-canvas-sheet-theme-item" v-for="(theme, index) in themes" :key="index"
							@click="$emit('command', { type: 'apply-theme', payload: theme }); showThemeMenu = false" :title="theme.name">
							<div class="vue-canvas-sheet-theme-preview">
								<div class="vue-canvas-sheet-preview-row" :style="{ background: theme.header.bg, height: '12px' }">
								</div>
								<div class="vue-canvas-sheet-preview-row" :style="{ background: theme.bodyEven.bg, height: '12px' }">
								</div>
								<div class="vue-canvas-sheet-preview-row" :style="{ background: theme.bodyOdd.bg, height: '12px' }">
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
			<div class="popover-wrapper">
				<button class="vue-canvas-sheet-tool-btn" title="边框" @click.stop="togglePopover('border')">
					<SvgIcon name="border-all" />
				</button>
				<div class="popover-content vue-canvas-sheet-toolbar-popover" v-if="showBorderMenu" @click.stop>
					<div class="vue-canvas-sheet-border-menu">
						<div class="border-palette">
							<button @click="applyBorder('all')" title="全边框"><SvgIcon name="border-all" /></button>
							<button @click="applyBorder('outer')" title="外边框"><SvgIcon name="border-outline" /></button>
							<button @click="applyBorder('none')" title="无边框"><SvgIcon name="border-none" /></button>
						</div>
						<div style="margin-top: 10px; display: flex; justify-content: center;">
							<input type="color" class="native-color-picker" :value="borderColor" @input="borderColor = $event.target.value" />
						</div>
					</div>
				</div>
			</div>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('freeze')" label="冻结" icon="pin" :compact="toolbarGroups.freeze.compact">
			<div class="popover-wrapper">
				<button class="vue-canvas-sheet-tool-btn" title="冻结窗格" @click.stop="togglePopover('freeze')">
					<SvgIcon name="pin" />
				</button>
				<div class="popover-content vue-canvas-sheet-toolbar-popover vue-canvas-sheet-freeze-popover" v-if="showFreezeMenu" @click.stop style="width: 200px;">
					<div class="vue-canvas-sheet-freeze-menu">
						<div class="freeze-menu-item" @click="$emit('command', { type: 'freeze-pane' }); showFreezeMenu = false">
							<SvgIcon name="pin" />
							<span>冻结窗格 (当前选中)</span>
						</div>
						<div class="freeze-menu-item" @click="$emit('command', { type: 'freeze-top' }); showFreezeMenu = false">
							<SvgIcon name="border-top" />
							<span>冻结首行</span>
						</div>
						<div class="freeze-menu-item" @click="$emit('command', { type: 'freeze-first-col' }); showFreezeMenu = false">
							<SvgIcon name="border-left" />
							<span>冻结首列</span>
						</div>
						<div class="freeze-menu-item" @click="$emit('command', { type: 'unfreeze' }); showFreezeMenu = false">
							<SvgIcon name="close" />
							<span>取消冻结</span>
						</div>
						<div class="freeze-divider"></div>
						<div class="freeze-custom">
							<div class="border-top">
								<span>行</span>
								<input type="number" class="native-number-input" :value="freezeRowCount" min="0" max="10" @change="$emit('update:freezeRowCount', Number($event.target.value))" />
							</div>
							<div class="border-top">
								<span>列</span>
								<input type="number" class="native-number-input" :value="freezeColCount" min="0" max="10" @change="$emit('update:freezeColCount', Number($event.target.value))" />
							</div>
						</div>
					</div>
				</div>
			</div>
		</ToolbarGroup>
		<ToolbarGroup v-if="isToolbarVisible('data')" label="数据" icon="find" :compact="toolbarGroups.data.compact">
			<button class="vue-canvas-sheet-tool-btn" @click="$emit('command', { type: 'toggle-find-dialog' })" title="查找">
				<SvgIcon name="find" />
			</button>
		</ToolbarGroup>
		<slot name="toolbar-end"></slot>
		<ToolbarGroup v-if="$slots['toolbar-end-group']" label="更多" icon="menu" :compact="customGroupCompact">
			<slot name="toolbar-end-group"></slot>
		</ToolbarGroup>
	</div>
</template>

<script>
import { cloneDeep } from 'es-toolkit';
import ToolbarGroup from "./ToolbarGroup.vue";
import SvgIcon from "./icons/SvgIcon.vue";
import { defaultToolbarGroups } from './config/toolbar';
import { DefaultThemes } from "./themes";

export default {
	name: "Toolbar",
	emits: ['command', 'update:freezeRowCount', 'update:freezeColCount'],
	components: {
		ToolbarGroup,
		SvgIcon
	},
	props: {
		activeStyle: {
			type: Object,
			default: () => ({})
		},
		canMerge: Boolean,
		canUnmerge: Boolean,
		canClear: Boolean,
		freezeRowCount: {
			type: Number,
			default: 0
		},
		freezeColCount: {
			type: Number,
			default: 0
		},
		toolbar: {
			type: Array,
			default: () => []
		}
	},
	data() {
		return {
			toolbarGroups: cloneDeep(defaultToolbarGroups),
			themes: DefaultThemes,
			showBorderMenu: false,
			showThemeMenu: false,
			showFreezeMenu: false,
			borderColor: '#000000',
			customGroupCompact: false,
		};
	},
	mounted() {
		this.naturalWidths = {};
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(this.handleResizeThrottled);
			this.resizeObserver.observe(this.$refs.toolbarContainer);
		} else {
			window.addEventListener('resize', this.handleResizeThrottled);
		}
		document.addEventListener('click', this.closeAllPopovers);
		document.addEventListener('close-all-popovers', this.handleCloseAllPopoversEvent);
		this.$nextTick(() => this.handleResize());
	},
	beforeUnmount() {
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		} else {
			window.removeEventListener('resize', this.handleResizeThrottled);
		}
		document.removeEventListener('click', this.closeAllPopovers);
		document.removeEventListener('close-all-popovers', this.handleCloseAllPopoversEvent);
	},
	methods: {
		closeAllPopovers() {
			this.showBorderMenu = false;
			this.showThemeMenu = false;
			this.showFreezeMenu = false;
		},
		handleCloseAllPopoversEvent(e) {
			if (e.detail !== this) {
				this.closeAllPopovers();
			}
		},
		togglePopover(name) {
			const map = { theme: 'showThemeMenu', border: 'showBorderMenu', freeze: 'showFreezeMenu' };
			const target = map[name];
			if (!target) return;

			if (!this[target]) {
				document.dispatchEvent(new CustomEvent('close-all-popovers', { detail: this }));
			}

			Object.values(map).forEach(key => {
				if (key !== target) this[key] = false;
			});
			this[target] = !this[target];
		},
		isToolbarVisible(key) {
			return this.toolbar.includes(key);
		},
		handleResizeThrottled() {
				if (this._ticking) return;
				this._ticking = true;
				requestAnimationFrame(() => {
						this.handleResize();
						this._ticking = false;
				});
		},
		handleResize() {
			const container = this.$refs.toolbarContainer;
			if (!container) return;

			const visibleKeys = Object.keys(this.toolbarGroups).filter(this.isToolbarVisible);
			const hasCustomGroup = !!this.$slots['toolbar-end-group'];

			// Cache natural widths from currently non-compact groups. Once cached,
			// a group's width is stable (content doesn't change), so previously-compact
			// groups reuse their initial-mount measurement.
			const els = container.querySelectorAll('.vue-canvas-sheet-tool-group-wrapper');
			visibleKeys.forEach((k, i) => {
				if (els[i] && !this.toolbarGroups[k].compact) {
					this.naturalWidths[k] = els[i].offsetWidth;
				}
			});

			// Cache custom group natural width
			if (hasCustomGroup) {
				const customEl = els[els.length - 1];
				if (customEl && !this.customGroupCompact) {
					this.naturalWidths['custom'] = customEl.offsetWidth;
				}
			}

			const containerWidth = container.clientWidth;
			const COMPACT_WIDTH = 60;
			const SAFETY = 12;

			const naturalOf = (k) => this.naturalWidths[k] || (this.toolbarGroups[k]?.minWidth + 17 || COMPACT_WIDTH);

			// Compact lowest-priority (highest priority number) groups first
			const sortedByPriorityDesc = [...visibleKeys].sort((a, b) =>
				this.toolbarGroups[b].priority - this.toolbarGroups[a].priority);

			let total = visibleKeys.reduce((s, k) => s + naturalOf(k), 0);
			if (hasCustomGroup) {
				total += this.naturalWidths['custom'] || COMPACT_WIDTH;
			}

			const newStates = {};
			visibleKeys.forEach(k => { newStates[k] = false; });
			let newCustomCompact = false;

			// First compact built-in groups
			for (const k of sortedByPriorityDesc) {
				if (total <= containerWidth - SAFETY) break;
				newStates[k] = true;
				total -= (naturalOf(k) - COMPACT_WIDTH);
			}

			// Then compact custom group if still overflowing
			if (hasCustomGroup && total > containerWidth - SAFETY) {
				newCustomCompact = true;
				total -= ((this.naturalWidths['custom'] || COMPACT_WIDTH) - COMPACT_WIDTH);
			}

			visibleKeys.forEach(k => {
				if (this.toolbarGroups[k].compact !== newStates[k]) {
					this.toolbarGroups[k].compact = newStates[k];
				}
			});

			this.customGroupCompact = newCustomCompact;
		},
		applyBorder(type) {
			this.$emit('command', { type: 'apply-border', payload: { type, color: this.borderColor } });
			this.showBorderMenu = false;
		}
	}
};
</script>

<style scoped lang="scss">
	.vue-canvas-sheet-toolbar {
		height: 42px;
		background: #fff;
		border-bottom: 1px solid #e1e1e1;
		display: flex;
		align-items: center;
		padding: 0 8px;

		.native-select {
			height: 24px;
			line-height: 24px;
			font-size: 12px;
			border: 1px solid #dcdfe6;
			border-radius: 2px;
			outline: none;
			background: #fff;
			color: #606266;
			cursor: pointer;
			padding: 0 4px;
		}

		.font-size-select {
			width: 55px;
		}

		.native-number-input {
			width: 70px;
			height: 28px;
			border: 1px solid #dcdfe6;
			border-radius: 4px;
			font-size: 13px;
			color: #606266;
			outline: none;
			padding: 0 8px;

			&:focus {
				border-color: #409eff;
			}
		}

		.native-color-picker {
			width: 28px;
			height: 28px;
			padding: 2px;
			border: 1px solid #ccc;
			border-radius: 2px;
			cursor: pointer;
			background: none;

			&::-webkit-color-swatch-wrapper {
				padding: 0;
			}

			&::-webkit-color-swatch {
				border: none;
				border-radius: 1px;
			}
		}

		.vue-canvas-sheet-tool-btn {
			margin: 2px;
		}
	}

	.popover-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.popover-content {
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		margin-top: 8px;
		background: #fff;
		border: 1px solid #e4e7ed;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 2000;
		padding: 12px;
	}

	.export-menu {
		padding: 4px 0;
		min-width: 160px;
	}

	.export-menu-item {
		padding: 6px 16px;
		font-size: 13px;
		color: #606266;
		cursor: pointer;
		white-space: nowrap;

		&:hover {
			background: #f5f7fa;
			color: #409eff;
		}
	}

	.vue-canvas-sheet-divider {
		width: 1px;
		height: 20px;
		background: #e1e1e1;
		margin: 0 10px;
	}

	:deep(.vue-canvas-sheet-tool-btn) {
		border: 1px solid transparent;
		background: none;
		min-width: 26px;
		height: 26px;
		border-radius: 4px;
		cursor: pointer;
		color: #444;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 2px;
		transition: all 0.1s;
		position: relative;

		&:hover:not(:disabled) {
			background: #f0f0f0;
			color: #000;
		}

		&:active:not(:disabled),
		&.active {
			background: #e6e6e6;
			color: #000;
			font-weight: bold;
		}

		&:disabled {
			color: #c0c4cc;
			cursor: not-allowed;
			background: none;
		}
	}

	.vue-canvas-sheet-theme-menu {
		width: 300px;
		max-height: 400px;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 8px;
		padding: 5px;
	}

	.vue-canvas-sheet-border-menu {
		width: 140px;
		padding: 5px;
	}

	.vue-canvas-sheet-theme-item {
		cursor: pointer;
		border: 1px solid #e0e0e0;
		border-radius: 2px;
		overflow: hidden;
		transition: all 0.2s;

		&:hover {
			transform: scale(1.05);
			box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
			border-color: #409eff;
		}
	}

	.vue-canvas-sheet-theme-preview {
		display: flex;
		flex-direction: column;
		height: 36px;
		width: 100%;
	}

	.vue-canvas-sheet-preview-row {
		flex: 1;
	}

	.color-picker-wrapper {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0 2px;
	}

	.color-underline {
		position: absolute;
		bottom: 3px;
		width: 18px;
		height: 3px;
		border-radius: 1px;
		z-index: 10;
		pointer-events: none;
	}

	.vue-canvas-sheet-freeze-menu {
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.freeze-menu-item {
		display: flex;
		align-items: center;
		padding: 5px 10px;
		cursor: pointer;
		border-radius: 4px;
		transition: background 0.2s;
		color: #606266;
		font-size: 13px;

		&:hover {
			background: #f5f7fa;
			color: #409eff;
		}

		.vue-canvas-sheet-svg-icon {
			font-size: 16px;
		}
	}

	.freeze-divider {
		height: 1px;
		background: #eee;
		margin: 5px 0;
	}

	.freeze-custom {
		padding: 5px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.freeze-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 13px;
		color: #606266;
	}

	.border-palette {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 5px;

		button {
			width: 30px;
			height: 30px;
			border: 1px solid #eee;
			background: #fff;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 14px;

			&:hover {
				background: #f0f0f0;
			}
		}
	}
</style>
