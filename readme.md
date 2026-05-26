# 🚀 Vue Canvas Sheet

[![npm version](https://img.shields.io/badge/npm-v0.1.0-blue.svg)](https://www.npmjs.com/package/vue-canvas-sheet)
[![Vue 3](https://img.shields.io/badge/Vue-3.5%2B-brightgreen.svg)](https://vuejs.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Engine: WASM](https://img.shields.io/badge/Engine-Rust%20%2B%20WASM-blueviolet.svg)](https://webassembly.org/)
[![中文文档](https://img.shields.io/badge/Docs-中文-red.svg)](./README_zh.md)

> A high-performance, Canvas-rendered Vue 3 spreadsheet component, backed by a Rust + WASM vectorized formula engine. Built for **million-cell** workloads with an Excel-grade UX on the web.

[**中文文档**](./README_zh.md) · [**Usage Guide**](./docs/USAGE.md) · [**Live Demo**](./samples/basic-usage)

---

## ✨ Highlights

- **⚡ Canvas Cluster Rendering** — Pure Canvas 2D pipeline, 60 FPS scrolling at 100k+ rows with zero DOM overhead.
- **🦀 Rust + WASM Engine** — Vectorized formula execution; recalculates 50k complex formulas in **< 50 ms**.
- **🧵 Worker + SharedArrayBuffer** — Calculation lives off the UI thread; the interface stays responsive under heavy load.
- **💾 IndexedDB Persistence** — Diff-based incremental save with instant "cold start" reload via `enable-persistence`.
- **🧩 Headless-Friendly Core** — `Workbook` runs standalone in Node.js or Web Workers; UI and core are fully decoupled.
- **🤝 Realtime Collaboration** — Built-in plugin for shared cursors, selection sync, and per-cell edit locks over WebSocket.
- **📥 Import / Export** — `.xlsx / .xls / .csv / .tsv / .json` round-trip via dedicated plugins (Excel export runs in a worker).
- **🌈 Excel-Grade Features** — 100+ formulas, merged cells, frozen panes, conditional formatting, formula bar, undo/redo, find & replace.

---

## 📊 Benchmarks

| Workload (50,000 rows / 200,000 cells) | Time | Notes |
| :--- | :--- | :--- |
| Initial load (`setData`) | **~200 ms** | Includes parsing 50k dynamic formulas |
| Full vectorized recalc (WASM) | **~48 ms** | SIMD-style execution, bypasses JS overhead |
| First paint | **~16 ms** | Hardware-accelerated Canvas, 60 FPS scroll |

---

## 📦 Install

```bash
npm install vue-canvas-sheet
# or
pnpm add vue-canvas-sheet
# or
yarn add vue-canvas-sheet
```

> The Rust/WASM engine is pre-built and shipped with the package — no extra toolchain required.

Peer dependency: `vue ^3.5.0`.

---

## 🚀 Quick Start

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
  ['Name',      'Price', 'Qty', 'Total'],
  ['Product A', 10,      5,     { f: '=B2*C2' }],
  ['Product B', 20,      3,     { f: '=B3*C3' }],
  ['Total',     { f: '=SUM(B2:B3)' }, { f: '=SUM(C2:C3)' }, { f: '=SUM(D2:D3)' }],
];
</script>
```

> `TableDesigner` fills its parent — make sure the parent has an explicit height.

---

## 🧩 Plugins

All plugins are factory functions exported from the package root.

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

| Plugin | Purpose |
| --- | --- |
| `SelectionHistoryPlugin` | Forward/back navigation across selection history |
| `AutoSavePlugin` | Event-driven or interval autosave to IndexedDB / localStorage |
| `ExportPlugin` | Export to `.xlsx` (worker-backed), `.csv`, `.json` |
| `ImportPlugin` | Import `.xlsx / .xls / .csv / .tsv / .json` |
| `CollaborativeCursorPlugin` | Render remote users' cursors and selections |
| `RealtimeCollaborationPlugin` | Sync edits, selections, and per-cell locks via WebSocket |

```vue
<TableDesigner :plugins="[historyPlugin, exportPlugin]" :initial-data="data" />
```

A reference WebSocket server is included — run `npm run collab:server` to try collaboration locally.

---

## 🛠 Workbook API (excerpt)

Grab the underlying `Workbook` from the component ref:

```js
const wb = tableRef.value.workbook;

// Cells
wb.setCell(0, 0, { v: 100 });
wb.setCell(0, 1, { f: '=A1*2' });
const cell  = wb.getCell(0, 1);
const value = wb.getCellValue(0, 1);

// Selection & styling
wb.setSelection(0, 0, 5, 5);
wb.setStyle(range, { bold: true, color: '#f00' });
wb.setBorder(range, 'all', '#000', 'solid');

// Structure
wb.mergeCells(range);
wb.setFreeze(1, 1);
wb.undo();  wb.redo();

// Engine
wb.enableWorker();
wb.recalcAll({ useWorker: true });
wb.getSystemReport();

// Events
const off = wb.on('cell-change', (changes) => { /* ... */ });
off();
```

See [docs/USAGE.md](./docs/USAGE.md) for the complete reference.

---

## ⚡ Performance Tips

**Large dataset, main-thread vectorized mode** — skip worker serialization overhead:

```js
table.value.workbook.recalcAll({ useWorker: false });
```

**Lazy loading** for 50k+ rows:

```vue
<TableDesigner
  :initial-data="data"
  :lazy-load="{ enabled: true, pageSize: 100, maxCachedPages: 10, preloadPages: 1 }"
/>
```

**Enable `SharedArrayBuffer`** in production by serving these headers (required for multi-threaded WASM):

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The engine gracefully falls back to main-thread execution when COOP/COEP is absent — call `wb.getSystemReport()` to inspect the current state.

---

## 📁 Package Exports

```js
import { TableDesigner, Workbook, SvgIcon } from 'vue-canvas-sheet';
import { Workbook }   from 'vue-canvas-sheet/core';    // headless core only
import { Renderer }   from 'vue-canvas-sheet/render';  // canvas renderer only
```

---

## 🧪 Development

```bash
npm install
npm run dev            # dev server (vite)
npm run demo           # run samples/basic-usage
npm run test           # unit tests (vitest)
npm run benchmark      # performance benchmarks
npm run build          # build WASM + JS bundle
npm run collab:server  # reference collaboration server
```

---

## 📄 License

[Apache License 2.0](./LICENSE) — Copyright © 2026-Present, Lee & Vue-Canvas-Sheet Team.
