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

  get_grid_cols() {
    return 4;
  }

  // 模拟 Rust evaluate_group 的降级行为：
  // 数值单元返回真实数值，非数值单元在 numeric_results 中以 NaN 占位，
  // 并在 non_numeric_results 中携带正确的字符串/错误值。
  evaluate_group(rows, cols, formula, ids) {
    const numeric_results = new Float64Array(rows.length);
    const non_numeric_results = {};
    for (let i = 0; i < rows.length; i++) {
      if (formula === '=BAD') {
        numeric_results[i] = NaN;
        non_numeric_results[ids[i]] = '#VALUE!';
      } else {
        numeric_results[i] = 42 + i;
      }
    }
    return { numeric_results, non_numeric_results };
  }
}

class CrashingFormulaEngine extends FakeFormulaEngine {
  evaluate_group() {
    throw new Error('group evaluation failed');
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

  test('降级路径（无共享内存）下数值结果应通过返回值交付而非被丢弃', async () => {
    const bridge = new WasmBridge({
      wasmLoader: async () => ({
        default: async () => {},
        FormulaEngine: FakeFormulaEngine
      })
    });

    await bridge.init();
    // 未调用 bindSharedMemory，sharedView 为 undefined（模拟无 SharedArrayBuffer 环境）
    expect(bridge.sharedView).toBeUndefined();

    const grouped = new Map([
      ['=A1+B1', { rows: [0, 1], cols: [2, 3], ids: ['c1', 'c2'] }]
    ]);

    const results = bridge.evaluateGroups(grouped);

    // 数值结果必须出现在返回值中，不能被静默丢弃
    expect(results.c1).toBe(42);
    expect(results.c2).toBe(43);
  });

  test('重新绑定共享内存后 sharedView 应同步更新到新缓冲区', async () => {
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

    // 初始绑定：小缓冲区
    const sabSmall = new SharedArrayBuffer(8 * 4); // 4 个 Float64
    expect(bridge.bindSharedMemory(sabSmall, 2, 2)).toBe(true);
    const initialView = bridge.sharedView;
    expect(initialView).not.toBeNull();
    expect(initialView.buffer).toBe(sabSmall);

    // 模拟扩容：更大的缓冲区
    const sabLarge = new SharedArrayBuffer(8 * 16); // 16 个 Float64
    bridge.rebindSharedMemory(sabLarge, 4, 4);

    // 关键断言：sharedView 必须引用新的 SharedArrayBuffer，而非旧的
    const rebindView = bridge.sharedView;
    expect(rebindView).not.toBeNull();
    expect(rebindView.buffer).not.toBe(sabSmall);
    expect(rebindView.buffer).toBe(sabLarge);

    // 执行 evaluateGroups 验证写入新缓冲区的新 sharedView
    const grouped = new Map([
      ['=A1+B1', { rows: [0, 1], cols: [2, 3], ids: ['c1', 'c2'] }]
    ]);

    const results = bridge.evaluateGroups(grouped);

    // 结果应写入新的 sharedView（索引 0*4+2=2 和 1*4+3=7）
    expect(rebindView[2]).toBe(42);
    expect(rebindView[7]).toBe(43);
    // 非数值错误消息仍通过返回值交付
    expect(results.c1).toBeUndefined();
  });

  test('降级路径下非数值占位 NaN 不应覆盖正确的错误结果', async () => {
    const bridge = new WasmBridge({
      wasmLoader: async () => ({
        default: async () => {},
        FormulaEngine: FakeFormulaEngine
      })
    });

    await bridge.init();

    const grouped = new Map([
      ['=BAD', { rows: [0], cols: [0], ids: ['e1'] }]
    ]);

    const results = bridge.evaluateGroups(grouped);

    // 非数值单元应保留 non_numeric_results 中的正确值，而非被 NaN/'#VALUE!' 逻辑污染
    expect(results.e1).toBe('#VALUE!');
  });

  test('分组执行异常时应返回 null 触发调用方 JS 回退', async () => {
    const bridge = new WasmBridge({
      wasmLoader: async () => ({
        default: async () => {},
        FormulaEngine: CrashingFormulaEngine
      })
    });

    await bridge.init();

    const grouped = new Map([
      ['=1+1', { rows: [0], cols: [0], ids: ['0-0'] }]
    ]);

    expect(bridge.evaluateGroups(grouped)).toBeNull();
  });
});
