<template>
	<div class="vue-canvas-sheet-formula-bar">
		<div class="cell-address">{{ address }}</div>
		<div class="formula-icon">fx</div>
		<div class="formula-input-wrapper">
			<input ref="input" v-model="internalValue" :disabled="disabled" :placeholder="disabled ? '🔒 单元格已被他人锁定，无法编辑' : ''" @input="handleInput" @keydown.enter="handleEnter" />
		</div>
	</div>
</template>
<script>
	export default {
		name: 'FormulaBar',
		emits: ['input', 'input-start', 'confirm'],
		props: {
			address: {
				type: String,
				default: ''
			},
			value: {
				type: [String, Number],
				default: ''
			},
			disabled: {
				type: Boolean,
				default: false
			}
		},
		data() {
			return {
				internalValue: this.value,
				timer: null
			};
		},
		watch: {
			value(val) {
				this.internalValue = val;
			}
		},
		methods: {
			handleInput(e) {
				this.internalValue = e.target.value;
				this.$emit('input', this.internalValue);
				this.$emit('input-start');
			},
			handleEnter() {
				if (this.timer) clearTimeout(this.timer);
				this.$emit('confirm', this.internalValue);
			},
			focus() {
				this.$refs.input.focus();
			}
		}
	};
</script>
<style scoped lang="scss">
	.vue-canvas-sheet-formula-bar {
		height: 30px;
		background: #f8f8f9;
		border-bottom: 1px solid #e1e1e1;
		display: flex;
		align-items: center;
		padding: 0 5px;
		font-size: 13px;
		width: 100%;
		flex-shrink: 0;
		box-sizing: border-box;

		.cell-address {
			min-width: 50px;
			padding: 0 8px;
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

			&:disabled {
				background: #f1f2f3;
				color: #999;
				cursor: not-allowed;
				border-color: #e4e7ed;
			}
		}
	}
</style>