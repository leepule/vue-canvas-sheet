import { WasmBridge } from '@/core/worker/WasmBridge';

class FakeFormulaEngine {
  constructor() {
    this.sharedMemory = null;
  }

  init_shared_memory(sab, rows, cols) {
    this.sharedMemory = { sab, rows, cols };
  }

  fast_sum() {
    return 1;
  }

  fast_avg() {
    return 1;
  }

  evaluate() {
    return 1;
  }
}

describe('WasmBridge', () => {
  test('加载成功后应该暴露 wasmLoaded 状态', async () => {
    const bridge = new WasmBridge({
      wasmLoader: async () => ({
        default: async () => {},
        FormulaEngine: FakeFormulaEngine
      })
    });

    await expect(bridge.init()).resolves.toBe(true);

    expect(bridge.getStatus()).toMatchObject({
      wasmLoaded: true,
      sharedMemoryEnabled: false,
      fallbackReason: null,
      hasEngine: true
    });
  });

  test('加载失败后应该保留明确 fallback reason', async () => {
    const bridge = new WasmBridge({
      wasmLoader: async () => {
        throw new Error('Cannot find module ../wasm/pkg/table_wasm_engine.js');
      }
    });

    await expect(bridge.init()).resolves.toBe(false);

    expect(bridge.getStatus()).toMatchObject({
      wasmLoaded: false,
      sharedMemoryEnabled: false,
      hasEngine: false
    });
    expect(bridge.getStatus().fallbackReason).toContain('npm run build:wasm');
  });

  test('绑定共享内存成功后应该暴露 sharedMemoryEnabled', async () => {
    if (typeof SharedArrayBuffer === 'undefined') {
      return;
    }

    const bridge = new WasmBridge({
      wasmLoader: async () => ({
        default: async () => {},
        FormulaEngine: FakeFormulaEngine
      })
    });

    await bridge.init();
    const sab = new SharedArrayBuffer(8);

    expect(bridge.bindSharedMemory(sab, 1, 1)).toBe(true);
    expect(bridge.getStatus().sharedMemoryEnabled).toBe(true);
  });
});
