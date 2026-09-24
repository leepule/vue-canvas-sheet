/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

// WASM 二进制的地址。主线程把它传给 formula Worker，Worker 内不解析任何路径。
// 使用方打包器会把它和 vue-canvas-sheet/wasm 胶水里的 .wasm 引用处理成同一个资源。
export default new URL('./pkg/table_wasm_engine_bg.wasm', import.meta.url).href;
