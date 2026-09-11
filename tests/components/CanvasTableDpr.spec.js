import { createApp, nextTick } from 'vue';
import CanvasTable from '@/components/designer/CanvasTable.vue';

describe('CanvasTable DPR 更新', () => {
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
        }),
        dispatchChange() {
          listeners.forEach(listener => listener({ media: query, matches: true }));
        }
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

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: originalDpr
    });
    window.matchMedia = originalMatchMedia;
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  test('DPR 变化后应重新设置所有 Canvas 的物理尺寸', async () => {
    app = createApp(CanvasTable, { workbook: null, readOnly: true });
    app.mount(mountPoint);
    await nextTick();

    const canvases = [...mountPoint.querySelectorAll('canvas')];
    expect(canvases).toHaveLength(4);
    expect(canvases.every(canvas => canvas.width === 320 && canvas.height === 200)).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(resolution: 1dppx)');

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2
    });
    mediaQueries[0].dispatchChange();

    expect(canvases.every(canvas => canvas.width === 640 && canvas.height === 400)).toBe(true);
    expect(window.matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');
  });

});
