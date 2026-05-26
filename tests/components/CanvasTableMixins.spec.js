import CanvasTable from '@/components/designer/CanvasTable.vue';
import CanvasRenderMixin from '@/components/designer/mixins/CanvasRenderMixin';
import CanvasInteractionMixin from '@/components/designer/mixins/CanvasInteractionMixin';

describe('CanvasTable mixin 方法合并', () => {
  test('CanvasTable 不应覆盖 mixin 的 invalidate 和 scrollIntoView', () => {
    expect(CanvasTable.methods).not.toHaveProperty('invalidate');
    expect(CanvasTable.methods).not.toHaveProperty('scrollIntoView');
  });

  test('invalidate 应该失效虚拟滚动缓存并请求内容和选区重绘', () => {
    const context = {
      fullRedraw: false,
      dirtyRect: null,
      renderContentRequested: false,
      renderSelectionRequested: false,
      _virtualScrollManager: {
        invalidateCache: vi.fn()
      },
      invalidateCore: CanvasRenderMixin.methods.invalidateCore,
      render: vi.fn()
    };

    CanvasRenderMixin.methods.invalidate.call(context, { x: 10, y: 20, w: 30, h: 40 });

    expect(context._virtualScrollManager.invalidateCache).toHaveBeenCalledTimes(1);
    expect(context.dirtyRect).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(context.renderContentRequested).toBe(true);
    expect(context.renderSelectionRequested).toBe(true);
    expect(context.render).toHaveBeenCalledTimes(1);
  });

  test('scrollIntoView 应该优先使用 RAF 节流实现', () => {
    const context = {
      _throttledScrollIntoView: vi.fn(),
      _scrollIntoViewImpl: vi.fn()
    };

    CanvasInteractionMixin.methods.scrollIntoView.call(context, 3, 4);

    expect(context._throttledScrollIntoView).toHaveBeenCalledWith(3, 4);
    expect(context._scrollIntoViewImpl).not.toHaveBeenCalled();
  });

  test('_scrollIntoViewImpl 应该同步滚动条、更新编辑框并触发缓存失效渲染', () => {
    const context = {
      workbook: {
        freeze: { r: 0, c: 0 },
        getColPos: vi.fn(c => c * 100),
        getRowPos: vi.fn(r => r * 25),
        getColWidth: vi.fn(() => 100),
        getRowHeight: vi.fn(() => 25)
      },
      rowHeaderWidth: 40,
      colHeaderHeight: 24,
      width: 200,
      height: 100,
      scrollX: 0,
      scrollY: 0,
      $refs: {},
      syncScrollbars: vi.fn(),
      updateEditorPosition: vi.fn(),
      invalidate: vi.fn()
    };

    CanvasInteractionMixin.methods._scrollIntoViewImpl.call(context, 5, 3);

    expect(context.scrollX).toBe(240);
    expect(context.scrollY).toBe(74);
    expect(context.syncScrollbars).toHaveBeenCalledTimes(1);
    expect(context.updateEditorPosition).toHaveBeenCalledTimes(1);
    expect(context.invalidate).toHaveBeenCalledTimes(1);
  });
});
