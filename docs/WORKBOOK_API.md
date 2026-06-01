# Workbook API 参考

> `Workbook` 是 `vue-canvas-sheet` 的核心数据引擎，承载单元格数据、样式、合并、公式计算、历史记录、选区、持久化、Web Worker、性能监控与插件系统。本文档列出 `Workbook` 对外暴露的全部属性与方法。

- 源码：[src/core/Workbook.js](../src/core/Workbook.js)
- 导入：

```js
import { Workbook } from 'vue-canvas-sheet/core';

const wb = new Workbook({ enablePersistence: false, sheetId: 'default' });
```

> 约定：以下成员均为公开 API。以 `_` 开头的成员为内部实现，本文档不收录（除少数对外可用的代理 getter 已注明）。范围对象统一为 `Range = { s: { r, c }, e: { r, c } }`；单元格对象为 `Cell = { v?, f?, m?, s?, dirty? }`（`v` 值、`f` 公式、`m` 格式化文本、`s` 样式）。

---

## 目录

1. [构造函数](#1-构造函数)
2. [属性（getter / setter）](#2-属性getter--setter)
3. [数据读写](#3-数据读写)
4. [范围遍历](#4-范围遍历)
5. [样式与格式](#5-样式与格式)
6. [合并单元格](#6-合并单元格)
7. [行列结构](#7-行列结构)
8. [选区与剪贴板](#8-选区与剪贴板)
9. [公式与计算](#9-公式与计算)
10. [历史记录（撤销/重做）](#10-历史记录撤销重做)
11. [序列化](#11-序列化)
12. [查找替换](#12-查找替换)
13. [事件与订阅](#13-事件与订阅)
14. [插件](#14-插件)
15. [Web Worker](#15-web-worker)
16. [WASM](#16-wasm)
17. [性能监控](#17-性能监控)
18. [Store 状态管理](#18-store-状态管理)
19. [对象池](#19-对象池)
20. [持久化](#20-持久化)
21. [布局与坐标](#21-布局与坐标)
22. [错误处理](#22-错误处理)
23. [生命周期](#23-生命周期)

---

## 1. 构造函数

```js
new Workbook(options?)
```

| 选项 | 类型 | 默认 | 说明 |
|------|------|:---:|------|
| `enablePersistence` | `boolean` | `false` | 是否启用持久化 |
| `sheetId` | `string` | `'default'` | 工作表 ID（持久化键） |

构造时会自动创建：插件注册中心（`plugins`）、历史管理器（`history`）、搜索引擎（`searchEngine` / `search`）、剪贴板（`clipboard`）、事件发射器、错误处理器（`errorHandler`）、性能监控器与对象池。

---

## 2. 属性（getter / setter）

通过 getter/setter 代理到内部 Store，可直接读写。

| 属性 | 类型 | 读写 | 说明 |
|------|------|:---:|------|
| `data` | `Object` | r/w | 单元格数据（稀疏存储） |
| `rowCount` | `number` | r/w | 行数（只读模式下按实际数据边界返回） |
| `colCount` | `number` | r/w | 列数（只读模式下按实际数据边界返回） |
| `readOnly` | `boolean` | r/w | 只读模式 |
| `colWidths` | `Object` | r/w | 列宽映射 `{ [col]: width }` |
| `rowHeights` | `Object` | r/w | 行高映射 `{ [row]: height }` |
| `defaultColWidth` | `number` | r/w | 默认列宽 |
| `defaultRowHeight` | `number` | r/w | 默认行高 |
| `merges` | `Range[]` | r/w | 合并单元格列表 |
| `mergeMap` | `Object` | r/w | 合并单元格索引 |
| `selection` | `Range` | r/w | 当前选区 |
| `activeCell` | `{r,c}` | r/w | 活动单元格 |
| `copyRange` | `Range\|null` | r/w | 复制范围 |
| `freeze` | `{r,c}` | r/w | 冻结行列数 |
| `dataVersion` | `number` | r/w | 数据版本号（每次写入自增） |
| `fieldMap` | `Object` | r/w | 字段映射 |
| `headerDepth` | `number` | r/w | 表头深度 |
| `dependencyMap` | `Map` | r/w | 公式依赖映射 |
| `reverseDependencyMap` | `Map` | r/w | 反向依赖映射 |
| `totalWidth` | `number` | r | 表格总宽度（像素，代理 LayoutEngine） |
| `totalHeight` | `number` | r | 表格总高度（像素，代理 LayoutEngine） |
| `search` | `SearchEngine` | r | 搜索引擎实例（`searchEngine` 别名） |
| `plugins` | `PluginRegistry` | r | 插件注册中心 |
| `history` | `HistoryManager` | r | 历史管理器 |
| `clipboard` | `ClipboardManager` | r | 剪贴板管理器 |
| `errorHandler` | `ErrorHandler` | r | 错误处理器 |

---

## 3. 数据读写

### `setData(data)`
设置整表数据（带性能监控）。`data` 可为数组或对象。

### `setColumns(columns)`
设置列定义（支持多级表头，自动生成表头合并）。

### `getCell(r, c) → Cell | null`
获取单元格数据对象，不存在返回 `null`。

### `getStyle(r, c) → CellStyle`
获取单元格样式对象，无样式返回 `{}`。

### `setCell(r, c, val, optOldValue?)`
设置单个单元格（**带历史记录**）。`val` 为 `Partial<Cell>`，如 `{ v: 'Hello' }` 或 `{ v: '=A1+1' }`（以 `=` 开头自动识别为公式）。传 `null`/`undefined` 清空单元格。

```js
wb.setCell(0, 0, { v: 'Hello' });
wb.setCell(1, 0, { v: '=SUM(A1:A10)' });
wb.setCell(0, 0, null); // 清空
```

### `bulkSetCells(updates)`
批量设置单元格。`updates` 为 `Array<{ r, c, val: Partial<Cell> }>`，性能优于逐个 `setCell`。

### `getCellValue(r, c, stack?) → any`
获取单元格**计算后**的值（公式单元格会触发计算 / 从共享内存读取结果）。区别于 `getCell` 返回原始对象。

---

## 4. 范围遍历

### `iterateRange(range, callback)`
遍历范围内每个单元格，`callback(r, c, cell)`。

### `collectRange(range, callback) → Array`
遍历并收集 `callback(r, c, cell)` 的返回值为数组。

```js
const values = wb.collectRange(
  { s: { r: 0, c: 0 }, e: { r: 9, c: 0 } },
  (r, c, cell) => cell?.v
);
```

---

## 5. 样式与格式

| 方法 | 说明 |
|------|------|
| `setStyle(range, style)` | 设置范围样式 |
| `setBorder(range, type, color, style?)` | 设置边框，`style` 默认 `'solid'` |
| `setFormat(range, fmt)` | 设置数字格式 |
| `setDecimals(range, delta)` | 增减小数位 |
| `clearContent(range)` | 清除范围内容（保留样式） |

---

## 6. 合并单元格

| 方法 | 返回 | 说明 |
|------|------|------|
| `mergeCells(range)` | — | 合并范围 |
| `unmergeCells(range)` | — | 取消合并 |
| `addMerge(range)` | — | 添加合并记录（底层） |
| `removeMerge(range)` | — | 移除合并记录（底层） |
| `getMerge(r, c)` | `Range\|null` | 获取包含该单元格的合并区 |
| `getIntersectingMerges(range)` | `Range[]` | 获取与范围相交的合并区 |
| `allowsMerge(range)` | `boolean` | 是否允许合并 |
| `allowsUnmerge(range)` | `boolean` | 是否允许取消合并 |

---

## 7. 行列结构

| 方法 | 说明 |
|------|------|
| `insertRow(rowIndex)` | 插入行 |
| `deleteRow(rowIndex)` | 删除行 |
| `insertColumn(colIndex)` | 插入列 |
| `deleteColumn(colIndex)` | 删除列 |
| `moveColumn(fromC, toC)` | 移动列（带历史记录） |
| `fillAuto(sourceRange, targetRange)` | 自动填充 |
| `getColWidth(c) → number` | 获取列宽 |
| `setColWidth(c, w)` | 设置列宽（带历史记录） |
| `getRowHeight(r) → number` | 获取行高 |
| `setRowHeight(r, h)` | 设置行高（带历史记录） |
| `setFreeze(r, c)` | 设置冻结窗格（冻结 `r` 行、`c` 列） |

---

## 8. 选区与剪贴板

| 方法 | 说明 |
|------|------|
| `setSelection(startR, startC, endR, endC)` | 设置选区（自动吸附合并单元格，更新 `activeCell`，触发 `selection-change`） |
| `setCopyRange(range)` | 设置复制范围（虚线框） |
| `clearCopyRange()` | 清除复制范围 |
| `copy(range)` | 复制范围到剪贴板 |
| `paste(range)` | 粘贴到范围 |
| `clearCells(range)` | 清除范围单元格（带批量历史记录） |

```js
wb.setSelection(0, 0, 4, 3); // 选中 A1:D5
wb.copy(wb.selection);
wb.paste({ s: { r: 10, c: 0 }, e: { r: 10, c: 0 } });
```

---

## 9. 公式与计算

| 方法 | 返回 | 说明 |
|------|------|------|
| `recalcAll(options?)` | `Promise<void>\|void` | 重算所有公式（拓扑排序）。`options.useWorker` 控制是否走 Worker |
| `recalcDirty()` | — | 增量重算：仅脏单元格及其依赖 |
| `triggerRecalc(r, c, stack?)` | — | 触发某单元格及其依赖重算 |
| `evaluateFormula(formula, r, c, stack?)` | `any` | 求值单个公式 |
| `getDependencies(formula) → string[]` | 解析公式引用的依赖单元格 |
| `rebuildDependencyMap()` | — | 重建全表公式依赖图 |
| `getCalculationStats() → Object\|null` | 计算引擎缓存统计 |
| `resetCalculationStats()` | — | 重置计算统计 |

> 公式语法见 [FORMULAS.md](./FORMULAS.md)。`recalcAll` 在启用 Worker 时返回 `Promise`。

---

## 10. 历史记录（撤销/重做）

| 方法 | 说明 |
|------|------|
| `undo()` | 撤销上一步 |
| `redo()` | 重做 |
| `applyCommand(cmd, isUndo)` | 应用命令（历史系统内部使用，支持 `set-cell`/`batch-set-cell`/`move-column`/`set-col-width` 等） |

> 更细粒度的批处理用 `history.startBatch()` / `history.execute(cmd)` / `history.endBatch()`（见 `this.history`）。

---

## 11. 序列化

### `toJSON() → Object`
导出工作簿为纯对象：`{ rowCount, colCount, rowHeights, colWidths, data, merges, freeze }`。

### `fromJSON(json)`
从 `toJSON` 的结构恢复工作簿（会清空历史、重建依赖图与合并索引）。

```js
const snapshot = wb.toJSON();
localStorage.setItem('sheet', JSON.stringify(snapshot));
// ...
wb.fromJSON(JSON.parse(localStorage.getItem('sheet')));
```

---

## 12. 查找替换

| 方法 | 返回 | 说明 |
|------|------|------|
| `find(query, startFrom?)` | 匹配结果 | 从 `startFrom`（默认 `{r:0,c:0}`）开始查找 |
| `replaceAll(query, replaceText)` | 替换数量 | 全部替换 |

---

## 13. 事件与订阅

### `on(event, callback) → unsubscribe`
订阅事件，返回取消订阅函数。`event` 取自 `Events` 常量（`cell-change`、`selection-change`、`data-load`、`structure-change`、`style-change`、`merge-change`、`freeze-change`、`history-change`、`save-status`、`error`、`change`）。

### `off(event, callback)`
取消订阅。

### `once(event, callback) → unsubscribe`
一次性订阅。

### `subscribe(fn) → unsubscribe`
旧版通用监听（向后兼容），任何变更都会回调。

### `notify(data?)`
手动触发变更通知。

```js
const unsub = wb.on('cell-change', ({ r, c, oldValue, newValue }) => {
  console.log(`(${r},${c}) ${oldValue} → ${newValue}`);
});
unsub();
```

> 事件 payload 结构与插件钩子一致，详见 [插件开发文档 §5](./PLUGIN_DEVELOPMENT.md#5-事件与钩子数据)。

---

## 14. 插件

| 方法 | 返回 | 说明 |
|------|------|------|
| `usePlugin(plugin, options?)` | `Workbook` | 注册插件（链式） |
| `unusePlugin(name)` | `boolean` | 卸载插件 |
| `getPlugin(name)` | `Plugin\|undefined` | 获取插件实例 |

> 完整插件系统见 [插件开发文档](./PLUGIN_DEVELOPMENT.md)。

---

## 15. Web Worker

| 方法 | 返回 | 说明 |
|------|------|------|
| `enableWorker(options?)` | `Workbook` | 启用 Worker 公式计算。`options.timeout` 默认 60000ms |
| `disableWorker()` | — | 禁用 Worker |
| `isWorkerEnabled()` | `boolean` | Worker 是否启用 |
| `getWorkerStats()` | `Object\|null` | Worker 统计信息 |

```js
wb.enableWorker({ timeout: 30000 });
await wb.recalcAll(); // 走 Worker 异步计算
```

---

## 16. WASM

### `initWasm() → Promise<void>`
初始化 WASM 计算引擎并绑定共享内存（需要环境支持 `SharedArrayBuffer`，即配置 COOP/COEP 响应头）。

---

## 17. 性能监控

| 方法 | 返回 | 说明 |
|------|------|------|
| `enablePerformanceMonitoring(options?)` | — | 启用监控，`options.thresholds` 设置各指标阈值告警 |
| `disablePerformanceMonitoring()` | — | 禁用监控 |
| `getPerformanceReport()` | `Object` | 生成性能报告 |
| `getPerformanceMonitor()` | `PerformanceMonitor` | 获取监控器实例 |
| `exportPerformanceJSON()` | `string` | 导出 JSON |
| `exportPerformanceCSV()` | `string` | 导出 CSV |
| `printPerformanceSummary()` | — | 控制台打印摘要 |
| `getSystemReport()` | `Object` | 系统级报告 |

---

## 18. Store 状态管理

| 方法 | 返回 | 说明 |
|------|------|------|
| `subscribeData(listener) → unsub` | 订阅数据 Store 变化 |
| `subscribeSelection(listener) → unsub` | 订阅选区 Store 变化 |
| `subscribeUI(listener) → unsub` | 订阅 UI Store 变化 |
| `select(storeName, selector, listener) → unsub` | 选择器订阅（仅选择结果变化时触发），`storeName` 为 `'data'`/`'selection'`/`'ui'` |
| `beginBatchUpdate()` | — | 开始批量更新（延迟通知） |
| `endBatchUpdate()` | — | 结束批量更新（触发通知） |
| `getStoreManager() → StoreManager` | 获取 Store 管理器 |
| `getStore(name) → Store\|undefined` | 获取指定 Store |

```js
wb.beginBatchUpdate();
for (let i = 0; i < 1000; i++) wb.setCell(i, 0, { v: i });
wb.endBatchUpdate(); // 仅通知一次
```

---

## 19. 对象池

| 方法 | 返回 | 说明 |
|------|------|------|
| `warmupPool(cellCount?)` | — | 预热单元格对象池，默认 1000 |
| `getPoolStats()` | `Object` | 池统计信息 |
| `getPoolManager()` | `PoolManager` | 获取池管理器 |

---

## 20. 持久化

| 方法 | 返回 | 说明 |
|------|------|------|
| `enablePersistenceStorage(options?)` | — | 启用持久化存储（IndexedDB），`options.sheetId` 指定键 |
| `persist(sheetId?)` | `Promise` | 全量持久化，默认 `'default'` |
| `loadFromStorage(sheetId?)` | `Promise` | 从存储加载 |
| `savePendingChanges(sheetId)` | `Promise` | 保存增量（diff）变更 |
| `flushPersistence()` | `Promise` | 立即落盘待写入数据 |

> `AutoSavePlugin` 即基于这些方法实现自动保存。

---

## 21. 布局与坐标

| 方法 | 返回 | 说明 |
|------|------|------|
| `getRowPos(r) → number` | 行的 Y 坐标（像素） |
| `getColPos(c) → number` | 列的 X 坐标（像素） |
| `getRowIndexAt(y) → number` | 根据 Y 坐标定位行索引 |
| `getColIndexAt(x) → number` | 根据 X 坐标定位列索引 |
| `getFrozenSize() → Object` | 冻结区域尺寸 |
| `getLayoutVersion() → number` | 布局版本号 |
| `getAddress(r, c) → string` | 行列索引转 A1 地址（如 `B3`） |

```js
wb.getAddress(2, 1); // → 'B3'
```

---

## 22. 错误处理

| 方法 | 返回 | 说明 |
|------|------|------|
| `getErrorHistory(limit?)` | `Array` | 获取错误历史 |
| `clearErrorHistory()` | — | 清空错误历史 |
| `safeExecute(fn, defaultValue, context?)` | `any` | 安全执行，出错时返回默认值并触发错误事件 |

---

## 23. 生命周期

### `destroy()`
销毁工作簿，清理全部资源：持久化定时器、布局引擎、合并管理器、插件系统、事件监听、Store 订阅、性能监控器、Worker、对象池。**组件卸载时务必调用，避免内存泄漏。**

```js
onUnmounted(() => {
  wb.destroy();
});
```

---

## 附：典型使用流程

```js
import { Workbook } from 'vue-canvas-sheet/core';

const wb = new Workbook();

// 1. 加载数据
wb.setData([
  { name: '张三', score: 90 },
  { name: '李四', score: 85 }
]);

// 2. 写入与公式
wb.setCell(2, 1, { v: '=SUM(B1:B2)' });
wb.recalcAll();
console.log(wb.getCellValue(2, 1)); // 175

// 3. 样式与合并
wb.setStyle({ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }, { bold: true });
wb.mergeCells({ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } });

// 4. 监听变化
const unsub = wb.on('cell-change', (e) => console.log(e));

// 5. 持久化
const json = wb.toJSON();

// 6. 销毁
unsub();
wb.destroy();
```
