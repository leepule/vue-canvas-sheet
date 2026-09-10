import { OffscreenRenderer, isOffscreenCanvasSupported } from '@/core/render/OffscreenRenderer';


describe('OffscreenRenderer', () => {
  let originalTransfer;
  let originalWorker;

  beforeEach(() => {
    originalTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    originalWorker = global.Worker;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransfer;
    global.Worker = originalWorker;
  });

  test('应该要求 canvas 支持 transferControlToOffscreen', () => {
    HTMLCanvasElement.prototype.transferControlToOffscreen = undefined;

    expect(isOffscreenCanvasSupported()).toBe(false);
  });

  test('初始化时不应该提前获取 2d context 或转移 canvas', () => {
    class ReadyWorker {
      constructor() {
        this.listeners = { message: [], error: [] };
      }

      addEventListener(type, listener) {
        this.listeners[type].push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners[type] = this.listeners[type].filter(item => item !== listener);
      }

      terminate() {}
    }

    const canvas = document.createElement('canvas');
    const getContextSpy = vi.spyOn(canvas, 'getContext');
    const transferSpy = vi.fn(() => ({ getContext: vi.fn() }));
    HTMLCanvasElement.prototype.transferControlToOffscreen = transferSpy;
    global.Worker = ReadyWorker;

    const renderer = new OffscreenRenderer({ canvas, theme: {}, enableWorker: true });

    expect(renderer.isUsingWorker()).toBe(true);
    expect(getContextSpy).not.toHaveBeenCalled();
    expect(transferSpy).not.toHaveBeenCalled();

    renderer.destroy();
  });

  test('首次尺寸同步时应该把主 canvas 转移给 worker', async () => {
    class ReadyWorker {
      constructor() {
        this.listeners = { message: [], error: [] };
        this.messages = [];
      }

      addEventListener(type, listener) {
        this.listeners[type].push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners[type] = this.listeners[type].filter(item => item !== listener);
      }

      postMessage(message) {
        this.messages.push(message);
        setTimeout(() => {
          this.listeners.message.forEach(listener => listener({
            data: {
              id: message.id,
              success: true
            }
          }));
        }, 0);
      }

      terminate() {}
    }

    const canvas = document.createElement('canvas');
    const offscreen = { getContext: vi.fn() };
    const transferSpy = vi.fn(() => offscreen);
    HTMLCanvasElement.prototype.transferControlToOffscreen = transferSpy;
    global.Worker = ReadyWorker;

    const renderer = new OffscreenRenderer({ canvas, theme: {}, enableWorker: true });
    const result = await renderer.resize(320, 200);

    expect(result).toBe(true);
    expect(transferSpy).toHaveBeenCalledTimes(1);
    // ping 已合并进 init：冷启动只发一次消息，OffscreenCanvas 随 init 一并 transfer
    expect(renderer.worker.messages.map(message => message.type)).toEqual(['init']);
    expect(renderer.worker.messages[0].data.canvas).toBe(offscreen);

    renderer.destroy();
  });

  test('降级到主线程时如果控制权已转移，应该发出重建信号而不直接操作 DOM', async () => {
    class ReadyWorker {
      constructor() {
        this.listeners = { message: [], error: [] };
      }
      addEventListener(type, listener) {
        this.listeners[type].push(listener);
      }
      removeEventListener(type, listener) {
        this.listeners[type] = this.listeners[type].filter(item => item !== listener);
      }
      postMessage(message) {
        setTimeout(() => {
          this.listeners.message.forEach(listener => listener({
            data: { id: message.id, success: true }
          }));
        }, 0);
      }
      terminate() {}
    }

    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    const replaceChildSpy = vi.spyOn(parent, 'replaceChild');

    const offscreen = { getContext: vi.fn() };
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn(() => offscreen);
    global.Worker = ReadyWorker;

    let fallbackArgs = null;
    const onFallback = vi.fn((err, info) => {
      fallbackArgs = { err, info };
    });

    const renderer = new OffscreenRenderer({ canvas, theme: {}, enableWorker: true, onFallback });

    // 首次 resize，触发 canvasTransferred
    await renderer.resize(320, 200);
    expect(renderer.canvasTransferred).toBe(true);
    const oldCanvas = renderer.canvas;

    // 触发强制降级
    renderer.forceFallback();

    // 验证状态
    expect(renderer.isUsingWorker()).toBe(false);

    // 不应直接操作 DOM：旧 canvas 仍在原位，未被替换
    expect(replaceChildSpy).not.toHaveBeenCalled();
    expect(renderer.canvas).toBe(oldCanvas);
    expect(parent.contains(oldCanvas)).toBe(true);

    // 控制权已转移，无法就地获取 context，应等待 Vue 层回挂
    expect(renderer.ctx).toBeNull();

    // onFallback 应收到结构化的重建信号
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(fallbackArgs.info).toEqual({ needsCanvasRebuild: true });

    renderer.destroy();
  });

  test('attachCanvas 应回挂新的 canvas 元素并取得 2d context', () => {
    const renderer = new OffscreenRenderer({ canvas: document.createElement('canvas'), theme: {}, enableWorker: false });
    renderer.canvasTransferred = true;
    renderer.ctx = null;
    renderer.mainCtx = null;

    const newCanvas = document.createElement('canvas');
    const fakeCtx = { fillRect: vi.fn() };
    vi.spyOn(newCanvas, 'getContext').mockReturnValue(fakeCtx);

    const ctx = renderer.attachCanvas(newCanvas);

    expect(renderer.canvas).toBe(newCanvas);
    expect(renderer.canvasTransferred).toBe(false);
    expect(ctx).toBe(fakeCtx);
    expect(renderer.ctx).toBe(fakeCtx);
    expect(renderer.mainCtx).toBe(fakeCtx);

    renderer.destroy();
  });
});
