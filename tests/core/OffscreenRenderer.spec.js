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
          if (message.type === 'ping') {
            this.listeners.message.forEach(listener => listener({
              data: {
                id: message.id,
                success: true,
                hasOffscreenCanvas: true
              }
            }));
            return;
          }

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
    expect(renderer.worker.messages.map(message => message.type)).toEqual(['ping', 'init']);
    expect(renderer.worker.messages[1].data.canvas).toBe(offscreen);

    renderer.destroy();
  });
});
