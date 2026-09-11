import { createApp, nextTick } from 'vue';
import CanvasTable from '@/components/designer/CanvasTable.vue';
import { Workbook } from '@/core/Workbook';

describe('CanvasTable 滚轮渲染', () => {
  let app;
  let mountPoint;
  let originalGetContext;
  let originalResizeObserver;
  let contentClearCount;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalResizeObserver = globalThis.ResizeObserver;
    contentClearCount = 0;

    HTMLCanvasElement.prototype.getContext = vi.fn(function(contextId) {
      if (contextId !== '2d') return null;
      const canvas = this;
      return {
        canvas,
        clearRect: vi.fn((x, y, width, height) => {
          if (canvas.dataset.layer === 'content') contentClearCount++;
        }),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn(() => ({ width: 10 })),
        drawImage: vi.fn(),
        setTransform: vi.fn(),
        scale: vi.fn(),
        setLineDash: vi.fn()
      };
    });

    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);
  });

  afterEach(() => {
    if (app) {
      app.unmount();
      app = null;
    }
    mountPoint.remove();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test('鼠标滚轮滚动后应立即请求内容层重绘', async () => {
    const workbook = new Workbook({ enableWasm: false });
    app = createApp(CanvasTable, { workbook, readOnly: true });
    app.mount(mountPoint);
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 32));

    const container = mountPoint.querySelector('.vue-canvas-sheet-table-container');
    const contentCanvas = container.querySelectorAll('canvas')[1];
    contentCanvas.dataset.layer = 'content';
    const before = contentClearCount;

    container.dispatchEvent(new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: 20,
      bubbles: true,
      cancelable: true
    }));
    await new Promise(resolve => setTimeout(resolve, 32));

    expect(contentClearCount).toBeGreaterThan(before);
  });
});
