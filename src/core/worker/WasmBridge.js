/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * WASM 公式引擎桥接层
 * 
 * 负责：
 * 1. 异步加载 WASM 模块
 * 2. 绑定 SharedArrayBuffer
 * 3. 调度求值请求
 */
export class WasmBridge {
  constructor(options = {}) {
    this.engine = null;
    this.isLoaded = false;
    this.loadPromise = null;
    this.sharedMemoryEnabled = false;
    this.fallbackReason = null;
    this.lastError = null;
    
    // 灵活的加载选项
    this.wasmLoader = options.wasmLoader || (() => import('../../wasm/pkg/table_wasm_engine.js'));

    this.wasmUrl = options.wasmUrl || null;
    this.wasmBinary = options.wasmBinary || null;
  }

  /**
   * 初始化并加载 WASM
   */
  async init() {
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        this.fallbackReason = null;
        this.lastError = null;
        
        // 1. 获取胶水代码模块
        const wasm = await this.wasmLoader();
        
        // 2. 确定输入源 (优先级: 二进制 > 显式URL > 默认行为)
        let input = undefined;
        if (this.wasmBinary) {
          input = this.wasmBinary;
        } else if (this.wasmUrl) {
          input = this.wasmUrl;
        }

        // 3. 执行 WASM 实例化 (wasm-pack 生成的默认导出是 init 函数)
        // 在 Vite 环境下，如果不传 input，它会尝试 fetch('table_wasm_engine_bg.wasm')
        await wasm.default(input);
        
        this.engine = new wasm.FormulaEngine();
        this.isLoaded = true;
        this.sharedMemoryEnabled = false;
        console.log('WASM Formula Engine Loaded');
        return true;
      } catch (err) {
        this.engine = null;
        this.isLoaded = false;
        this.sharedMemoryEnabled = false;
        this.lastError = err;
        this.fallbackReason = this._formatFallbackReason(err);
        console.warn(`[WasmBridge] ${this.fallbackReason}`);
        return false;
      }
    })();

    return this.loadPromise;
  }

  /**
   * 绑定共享内存
   */
  bindSharedMemory(sab, rows, cols) {
    if (!this.isLoaded || !this.engine) {
      this.sharedMemoryEnabled = false;
      if (!this.fallbackReason) {
        this.fallbackReason = 'WASM engine is not loaded; shared memory binding skipped.';
      }
      return false;
    }

    if (typeof globalThis.SharedArrayBuffer === 'undefined' || !(sab instanceof globalThis.SharedArrayBuffer)) {
      this.sharedMemoryEnabled = false;
      this.fallbackReason = 'SharedArrayBuffer is unavailable. Enable cross-origin isolation with COOP/COEP headers.';
      return false;
    }

    try {
      this.engine.init_shared_memory(sab, rows, cols);
      this.sharedView = new Float64Array(sab); // 关键修复：绑定本地视图以便写回结果
      this.sharedMemoryEnabled = true;
      this.fallbackReason = null;
      return true;
    } catch (err) {
      this.sharedMemoryEnabled = false;
      this.lastError = err;
      this.fallbackReason = `Shared memory binding failed: ${err?.message || String(err)}`;
      console.warn(`[WasmBridge] ${this.fallbackReason}`);
      return false;
    }
  }

  markSharedMemoryUnavailable(reason) {
    this.sharedMemoryEnabled = false;
    this.fallbackReason = reason;
  }

  /**
   * 执行快速聚合
   */
  sum(r1, c1, r2, c2) {
    if (!this.isLoaded) return null; // 触发 JS 降级
    return this.engine.fast_sum(r1, c1, r2, c2);
  }

  avg(r1, c1, r2, c2) {
    if (!this.isLoaded) return null;
    return this.engine.fast_avg(r1, c1, r2, c2);
  }

  /**
   * 通用求值接口（未来扩展）
   */
  evaluate(formula) {
    if (!this.isLoaded || !this.engine) {
      console.warn('WASM engine not ready for evaluation');
      return '#WAIT!';
    }
    try {
      return this.engine.evaluate(formula);
    } catch (err) {
      console.error('[WasmBridge] Evaluation Crash:', err);
      return '#WASM_ERR: ' + (err.message || err);
    }
  }

  /**
   * 向量化分组计算 (Vectorized Execution)
   * 消除 JS 与 WASM 之间的字符串跨界拷贝开销
   */
  evaluateGroups(groupedTasks) {
    if (!this.isLoaded || !this.engine) return {};

    let allNonNumeric = {};
    const gridCols = this.engine.get_grid_cols();

    try {
      for (const [formula, group] of groupedTasks.entries()) {
        const rows = new Uint32Array(group.rows);
        const cols = new Uint32Array(group.cols);
        const ids = group.ids;
        
        const { numeric_results, non_numeric_results } = this.engine.evaluate_group(rows, cols, formula, ids);
        
        // 合并所有非数字/错误结果返回给主线程
        Object.assign(allNonNumeric, non_numeric_results);
        
        // 利用线性 SharedArrayBuffer 批量写回数字结果，实现极速零拷贝刷新
        if (this.sharedView) {
          const len = rows.length;
          for (let i = 0; i < len; i++) {
            const val = numeric_results[i];
            if (!isNaN(val)) {
              const idx = rows[i] * gridCols + cols[i];
              if (idx < this.sharedView.length) {
                this.sharedView[idx] = val;
              }
            }
          }
        }
      }
      return allNonNumeric;
    } catch (err) {
      console.error('[WasmBridge] Group Evaluation Crash:', err);
      return {};
    }
  }


  getStatus() {
    return {
      wasmLoaded: this.isLoaded,
      sharedMemoryEnabled: this.sharedMemoryEnabled,
      fallbackReason: this.fallbackReason,
      hasEngine: !!this.engine,
      crossOriginIsolated: typeof globalThis.crossOriginIsolated !== 'undefined' ? globalThis.crossOriginIsolated : false,
      sharedArrayBufferAvailable: typeof globalThis.SharedArrayBuffer !== 'undefined'
    };
  }

  _formatFallbackReason(err) {
    const message = err?.message || String(err);
    if (/Failed to fetch|fetch|404|Cannot find module|not found/i.test(message)) {
      return `WASM engine failed to load. Build it with "npm run build:wasm" and ensure wasm assets are published. Original error: ${message}`;
    }
    return `WASM engine failed to initialize; using JS fallback. Original error: ${message}`;
  }
}

// 单例模式
export const wasmBridge = new WasmBridge();
