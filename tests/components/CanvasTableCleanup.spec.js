import { createApp, nextTick } from 'vue';
import CanvasTable from '@/components/designer/CanvasTable.vue';

describe('CanvasTable 异步任务清理', () => {
  let app;
  let mountPoint;
  let originalDpr;
  let originalMatchMedia;
  let originalResizeObserver;
  let originalGetBoundingClientRect;
  let mediaQueries;
  let resizeObservers;

  beforeEach(() => {
    originalDpr = window.devicePixelRatio;
    originalMatchMedia = window.matchMedia;
    originalResizeObserver = globalThis.ResizeObserver;
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    mediaQueries = [];
    resizeObservers = [];

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1
    });

    window.matchMedia = vi.fn((query) => {
      const listeners = new Set();
      const mediaQuery = {
        media: query,
        matches: true,
        addEventListener: vi.fn((type, listener) => {
          if (type === 'change') listeners.add(listener);
        }),
        removeEventListener: vi.fn((type, listener) => {
          if (type === 'change') listeners.delete(listener);
        })
      };
      mediaQueries.push(mediaQuery);
      return mediaQuery;
    });

    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        resizeObservers.push(this);
      }

      observe() {}
      disconnect() {}
    };

    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 320,
      height: 200,
      top: 0,
      left: 0,
      right: 320,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }));

    mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);
  });

  afterEach(() => {
    if (app) {
      app.unmount();
      app = null;
    }
    mountPoint?.remove();
    vi.useRealTimers();

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: originalDpr
    });
    window.matchMedia = originalMatchMedia;
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  test('卸载时应移除 DPR 媒体查询监听', async () => {
    app = createApp(CanvasTable, { workbook: null, readOnly: true });
    app.mount(mountPoint);
    await nextTick();

    const mediaQuery = mediaQueries[0];
    app.unmount();
    app = null;

    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  test('卸载时应取消待执行的 resize debounce 和绘制 rAF', async () => {
    vi.useFakeTimers();
    const workbook = {
      totalWidth: 640,
      totalHeight: 400,
      on: vi.fn(() => vi.fn()),
      setRenderScheduler: vi.fn()
    };
    const cancelAnimationFrameSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

    app = createApp(CanvasTable, { workbook, readOnly: true });
    app.mount(mountPoint);
    await nextTick();

    const rectCallCount = HTMLElement.prototype.getBoundingClientRect.mock.calls.length;
    resizeObservers[0].callback();

    app.unmount();
    app = null;
    vi.advanceTimersByTime(200);

    expect(cancelAnimationFrameSpy).toHaveBeenCalled();
    expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(rectCallCount);
  });

  test('异步同步滚动事件只应忽略匹配的目标位置', async () => {
    const dataController = {
      _scrollLoader: true,
      handleScroll: vi.fn().mockResolvedValue(undefined)
    };

    app = createApp(CanvasTable, { workbook: null, dataController, readOnly: true });
    app.mount(mountPoint);
    await nextTick();

    const container = mountPoint.querySelector('.vue-canvas-sheet-table-container');
    const scrollV = mountPoint.querySelector('.vue-canvas-sheet-scrollbar-v');

    container.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 20, bubbles: true, cancelable: true }));
    const callsAfterWheel = dataController.handleScroll.mock.calls.length;

    scrollV.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(dataController.handleScroll).toHaveBeenCalledTimes(callsAfterWheel);

    scrollV.scrollTop = 30;
    scrollV.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(dataController.handleScroll).toHaveBeenCalledTimes(callsAfterWheel + 1);
  });
});
