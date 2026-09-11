import { describe, expect, it, vi } from 'vitest';
import useCanvasRender from '../../src/components/designer/hooks/useCanvasRender.js';

describe('useCanvasRender 渐进渲染滚动', () => {
  it('滚动触发全量重绘时应中断旧渐进任务并按新位置重启', () => {
    const calls = [];
    const tableContext = {
      props: {
        workbook: {}
      },
      state: {
        ctx: {},
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 200,
        tableTheme: {},
        pendingRender: false,
        fullRedraw: true,
        dirtyRect: null,
        renderContentRequested: true,
        renderGridRequested: true,
        renderSelectionRequested: false,
        renderAnimationRequested: false,
        progressiveState: {
          isRendering: true
        }
      },
      computed: {
        rowHeaderWidth: { value: 40 },
        colHeaderHeight: { value: 30 },
        isOffscreenActive: { value: false }
      },
      methods: {
        stopProgressiveRender: vi.fn(() => {
          calls.push('stop');
          tableContext.state.progressiveState.isRendering = false;
        }),
        _renderGrid: vi.fn(() => {
          calls.push('grid');
        }),
        shouldUseWorkerRender: vi.fn(() => false),
        shouldUseProgressiveRender: vi.fn(() => true),
        startProgressiveRender: vi.fn(() => {
          calls.push('start');
        }),
        _renderSelection: vi.fn(),
        _renderAnimation: vi.fn()
      }
    };
    const renderFrame = vi.fn((callback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', renderFrame);

    try {
      const { render } = useCanvasRender(tableContext);
      render();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toEqual(['stop', 'start']);
    expect(tableContext.methods.stopProgressiveRender).toHaveBeenCalledTimes(1);
    expect(tableContext.methods.startProgressiveRender).toHaveBeenCalledTimes(1);
    expect(tableContext.state.renderContentRequested).toBe(false);
  });
});
