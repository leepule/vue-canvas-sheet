# 🚀 Vue Canvas Sheet

[![npm version](https://img.shields.io/badge/npm-v0.1.0-blue.svg)](https://www.npmjs.com/package/vue-canvas-sheet)
[![Vue 3](https://img.shields.io/badge/Vue-3.5%2B-brightgreen.svg)](https://vuejs.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Engine: WASM](https://img.shields.io/badge/Engine-Rust%20%2B%20WASM-blueviolet.svg)](https://webassembly.org/)
[![English](https://img.shields.io/badge/Docs-English-red.svg)](./readme.md)

> 一款基于 Canvas 渲染、Rust + WASM 向量化公式引擎驱动的高性能 Vue 3 表格组件。专为**百万级单元格**场景设计，在 Web 上交付接近原生 Excel 的操作体验。

[**English**](./readme.md) · [**使用文档**](./docs/USAGE.md) · [**在线 Demo**](./samples/basic-usage)

---

## ✨ 核心亮点

- **⚡ Canvas 集群渲染** —— 纯 Canvas 2D 管线，10W+ 行数据下保持 60 FPS 滚动，零 DOM 渲染开销。
- **🦀 Rust + WASM 引擎** —— 公式向量化执行，5W 个复杂公式重算耗时 **< 50ms**。
- **🧵 Worker + SharedArrayBuffer** —— 计算线程与 UI 线程彻底解耦，大数据更新时界面依然响应如飞。
- **💾 IndexedDB 持久化** —— 基于 diff 的增量保存，启用 `enable-persistence` 即可秒开历史数据。
- **🧩 Headless 友好** —— `Workbook` 可在 Node.js / Web Worker 中独立运行，UI 层与核心层完全解耦。
- **🤝 实时协同** —— 内置协同插件，支持光标同步、选区共享、单元格锁定（基于 WebSocket）。
- **📥 导入 / 导出** —— 通过专用插件支持 `.xlsx / .xls / .csv / .tsv / .json` 双向转换（Excel 导出走 Worker，不阻塞主线程）。
- **🌈 Excel 级特性** —— 100+ 公式、单元格合并、冻结窗格、条件格式、公式栏、撤销重做、查找替换。

---

## 📊 性能表现 (Benchmark)

| 测试项目 (50,000 行 / 200,000 单元格) | 耗时 | 备注 |
| :--- | :--- | :--- |
| 数据初始化加载 (`setData`) | **~200ms** | 含 5W 个动态公式的解析与注入 |
| 向量化全量重算 (WASM) | **~48ms** | SIMD 风格执行，规避 JS 串行开销 |
| 首帧渲染 | **~16ms** | Canvas 硬件加速，60 FPS 滚动 |

---

## 📦 安装

```bash
npm install vue-canvas-sheet
# 或
pnpm add vue-canvas-sheet
# 或
yarn add vue-canvas-sheet
```

> Rust/WASM 引擎已预构建并随包发布，无需额外的工具链。

Peer 依赖：`vue ^3.5.0`。

---

## 🚀 快速开始

```vue
<template>
  <div style="height: 600px; width: 100%;">
    <TableDesigner
      ref="table"
      :initial-data="initialData"
      enable-persistence
      sheet-id="my-demo-sheet"
    />
  </div>
</template>

<script setup>
import { TableDesigner } from 'vue-canvas-sheet';
import 'vue-canvas-sheet/dist/style.css';

const initialData = [
  ['名称',     '单价', '数量', '总价'],
  ['产品 A',   10,    5,      { f: '=B2*C2' }],
  ['产品 B',   20,    3,      { f: '=B3*C3' }],
  ['合计',     { f: '=SUM(B2:B3)' }, { f: '=SUM(C2:C3)' }, { f: '=SUM(D2:D3)' }],
];
</script>
```

> `TableDesigner` 会撑满父容器，请确保父容器具有显式 `height`。

---

## 🧩 插件体系

所有插件均以工厂函数形式从包根导出：

```js
import {
  TableDesigner,
  createSelectionHistoryPlugin,
  createAutoSavePlugin,
  createExportPlugin,
  createImportPlugin,
  createCollaborativeCursorPlugin,
  createRealtimeCollaborationPlugin,
} from 'vue-canvas-sheet';
```

| 插件 | 用途 |
| --- | --- |
| `SelectionHistoryPlugin` | 选区前进 / 后退 |
| `AutoSavePlugin` | 事件驱动或定时自动保存（IndexedDB / localStorage） |
| `ExportPlugin` | 导出 `.xlsx`（Worker）/`.csv`/`.json` |
| `ImportPlugin` | 导入 `.xlsx / .xls / .csv / .tsv / .json` |
| `CollaborativeCursorPlugin` | 渲染远端用户光标与选区 |
| `RealtimeCollaborationPlugin` | 通过 WebSocket 同步编辑、选区与单元格锁 |

```vue
<TableDesigner :plugins="[historyPlugin, exportPlugin]" :initial-data="data" />
```

仓库内含参考 WebSocket 服务器，执行 `npm run collab:server` 即可在本地体验协同功能。

---

## 🛠 Workbook API（节选）

通过组件 ref 获取底层 `Workbook` 实例：

```js
const wb = tableRef.value.workbook;

// 单元格
wb.setCell(0, 0, { v: 100 });
wb.setCell(0, 1, { f: '=A1*2' });
const cell  = wb.getCell(0, 1);
const value = wb.getCellValue(0, 1);

// 选区与样式
wb.setSelection(0, 0, 5, 5);
wb.setStyle(range, { bold: true, color: '#f00' });
wb.setBorder(range, 'all', '#000', 'solid');

// 结构操作
wb.mergeCells(range);
wb.setFreeze(1, 1);
wb.undo();  wb.redo();

// 计算引擎
wb.enableWorker();
wb.recalcAll({ useWorker: true });
wb.getSystemReport();

// 事件订阅
const off = wb.on('cell-change', (changes) => { /* ... */ });
off();
```

完整 API 参见 [docs/USAGE.md](./docs/USAGE.md)。

---

## ⚡ 性能调优

**大数据集 + 主线程向量化** —— 跳过 Worker 序列化开销：

```js
table.value.workbook.recalcAll({ useWorker: false });
```

**懒加载** 适用于 5W+ 行：

```vue
<TableDesigner
  :initial-data="data"
  :lazy-load="{ enabled: true, pageSize: 100, maxCachedPages: 10, preloadPages: 1 }"
/>
```

**启用 `SharedArrayBuffer`** —— 生产环境配置以下响应头即可激活多线程 WASM：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

未配置 COOP/COEP 时引擎会自动降级到主线程计算，可调用 `wb.getSystemReport()` 查看当前运行状态。

---

## 📁 多入口导出

```js
import { TableDesigner, Workbook, SvgIcon } from 'vue-canvas-sheet';
import { Workbook }   from 'vue-canvas-sheet/core';    // 仅 headless 内核
import { Renderer }   from 'vue-canvas-sheet/render';  // 仅 Canvas 渲染器
```

---

## 🧪 本地开发

```bash
npm install
npm run dev            # 开发服务器 (vite)
npm run demo           # 运行 samples/basic-usage
npm run test           # 单元测试 (vitest)
npm run benchmark      # 性能基准
npm run build          # 构建 WASM + JS 产物
npm run collab:server  # 启动协同参考服务器
```

---

## 📄 开源协议

[Apache License 2.0](./LICENSE) —— Copyright © 2026-Present, Lee & Vue-Canvas-Sheet Team.
