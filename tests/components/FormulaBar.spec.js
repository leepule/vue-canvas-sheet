import { describe, it, expect, vi, beforeEach } from 'vitest';

// 直接导入组件的 <script> 部分测试逻辑（不依赖 Vue Test Utils mount）
import FormulaBarComponent from '../../src/components/designer/FormulaBar.vue';

describe('FormulaBar', () => {
  let vm;

  beforeEach(() => {
    const options = FormulaBarComponent;
    // data() 内引用 this.value（prop），提供上下文
    const ctx = { value: '' };
    const data = (typeof options.data === 'function') ? options.data.call(ctx) : { ...options.data };
    vm = {
      ...data,
      ...options.methods,
      $emit: vi.fn(),
      $refs: { input: { focus: vi.fn() } }
    };
  });

  describe('data 初始化', () => {
    it('internalValue 默认值应为 ""', () => {
      expect(vm.internalValue).toBe('');
    });
  });

  describe('handleInput', () => {
    it('应更新 internalValue 并发出 input 与 input-start 事件', () => {
      vm.handleInput({ target: { value: '=SUM(A1:A3)' } });
      expect(vm.internalValue).toBe('=SUM(A1:A3)');
      expect(vm.$emit).toHaveBeenCalledWith('input', '=SUM(A1:A3)');
      expect(vm.$emit).toHaveBeenCalledWith('input-start');
    });
  });

  describe('handleEnter', () => {
    it('应发出 confirm 事件并传递当前值', () => {
      vm.internalValue = '=A1+B1';
      vm.handleEnter();
      expect(vm.$emit).toHaveBeenCalledWith('confirm', '=A1+B1');
    });

    it('已有定时器时应先清除', () => {
      const clearSpy = vi.fn();
      vm.timer = { _id: 1 };
      const origClear = clearTimeout;
      global.clearTimeout = vi.fn();
      vm.internalValue = '42';
      vm.handleEnter();
      expect(global.clearTimeout).toHaveBeenCalled();
      global.clearTimeout = origClear;
    });
  });

  describe('focus', () => {
    it('应调用 input 元素的 focus', () => {
      vm.focus();
      expect(vm.$refs.input.focus).toHaveBeenCalled();
    });
  });

  describe('disabled prop', () => {
    it('disabled 默认值应为 false', () => {
      expect(FormulaBarComponent.props.disabled.default).toBe(false);
    });
  });
});
