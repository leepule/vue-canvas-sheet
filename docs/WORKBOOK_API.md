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
| `sheetName` | `string` | `'Sheet1'` | 初始工作表名称 |

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
| `dataVersion` | `number` | r/w | 原有渲染与搜索版本，可能随工作表恢复；内容冲突检测使用 `getContentRevision()` |
| `fieldMap` | `Object` | r/w | 字段映射 |
| `headerDepth` | `number` | r/w | 表头深度 |
| `dependencyMap` | `Map` | r/w | 公式依赖映射 |
| `reverseDependencyMap` | `Map` | r/w | 反向依赖映射 |
| `totalWidth` | `number` | r | 表格总宽度（像素，兼容代理；推荐使用 `layoutEngine.totalWidth`） |
| `totalHeight` | `number` | r | 表格总高度（像素，兼容代理；推荐使用 `layoutEngine.totalHeight`） |
| `search` | `SearchEngine` | r | 搜索引擎实例（`searchEngine` 别名） |
| `sheetName` | `string` | r/w | 当前工作表名称；写入等价于重命名当前表 |
| `activeSheetId` | `string` | r | 当前工作表 ID |
| `plugins` | `PluginRegistry` | r | 插件注册中心 |
| `history` | `HistoryManager` | r | 历史管理器 |
| `clipboard` | `ClipboardManager` | r | 剪贴板管理器 |
| `errorHandler` | `ErrorHandler` | r | 错误处理器 |
| `layoutEngine` | `LayoutEngine` | r | 布局引擎实例 |
| `mergeManager` | `MergeManager` | r | 合并单元格管理器 |
| `styleManager` | `StyleManager` | r | 样式管理器 |
| `sheetStructure` | `SheetStructure` | r | 行列结构管理器 |

### 多工作表

```js
const sheetId = wb.addSheet('明细');       // 默认创建后立即切换
wb.switchSheet('总表');                    // 支持按 ID 或名称切换
wb.sheetName = '汇总';                     // 重命名当前工作表
wb.renameSheet('明细', '数据');            // 按 ID 或名称重命名
wb.deleteSheet('数据');                    // 按 ID 或名称删除，至少保留一张表
wb.getSheets();                            // [{ id, name, isActive }]
```

每个工作表独立保存单元格、样式、行列尺寸、合并、冻结与选区状态。切换或删除当前表时会重建公式依赖图并清空当前历史栈；跨工作表公式引用（如 `=Sheet2!A1`）暂不支持。多 Sheet 场景下 IndexedDB 自动保存会写入完整 Workbook 快照，恢复时优先使用该快照。

---

## 3. 数据读写

### `getContentRevision() → number`
返回当前 Workbook 实例的内容修订号，从 `0` 开始。单元格值、公式、样式、合并、行列结构、尺寸、冻结、批注、工作表增删改名及数据加载都会推进版本。撤销、重做也产生新版本，不恢复历史版本号。

修订号不进入 JSON 或单个 Sheet 的状态，不复用 `dataVersion`。选区、滚动、复制、保存状态、公式结果缓存回填和单纯切表不作为内容编辑。新 Workbook 实例重新从 `0` 开始，不能仅凭修订号识别不同文档。

公开写入方法、持久化配置 setter、管理器写入、矩阵写入方法及 Store 持久字段均纳入跟踪；读取 API 返回的单元格对象仍是原有引用，不应绕过写入 API 直接赋值其字段。原有低层矩阵接口仍不替代 Workbook 的历史、公式依赖和持久化处理。

同值写入可保守地产生新版本；修订号用于判定旧快照是否失效，不等同于撤销栈长度或精确的数据差异数量。

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

### `applyCellPatch(patch)`
受控原子批量写入。适用于已经完成预览和确认的补丁，不替代 `bulkSetCells()` 的普通批量编辑语义。

```js
const revision = wb.getContentRevision();

const result = wb.applyCellPatch({
  mutationId: 'ai-run-1-apply',
  sheetId: wb.activeSheetId,
  expectedRevision: revision,
  changes: [
    { r: 1, c: 2, before: null, after: { f: '=A2*B2' } },
    { r: 2, c: 2, before: null, after: { f: '=A3*B3' } }
  ]
});
```

`after: null` 表示删除单元格；`after` 采用完整替换语义，只允许 `v`、`f`、`s`、`m` 字段。写入前会检查只读状态、当前 Sheet、修订号、坐标、重复目标、旧值前置条件、补丁大小和公式白名单。成功只记录一条 `batch-set-cell` 历史，推进一次内容修订号，并返回：

```js
{
  mutationId: 'ai-run-1-apply',
  previousRevision: revision,
  revision: revision + 1,
  changedCells: 2
}
```

同一实例内使用相同 `mutationId` 重放完全相同的内容会返回原结果；相同 ID 携带不同内容会拒绝。写入阶段任一单元格失败时，会恢复矩阵、公式依赖、共享值、脏标记、历史栈和 `dataVersion`，不产生 `mutation-committed` 事件。

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

> 以下 Workbook 方法为向后兼容代理。新代码推荐直接调用 `wb.styleManager.*`。

| 方法 | 说明 |
|------|------|
| `setStyle(range, style)` | 设置范围样式 |
| `setBorder(range, type, color, style?)` | 设置边框，`style` 默认 `'solid'` |
| `setFormat(range, fmt)` | 设置数字格式 |
| `setDecimals(range, delta)` | 增减小数位 |
| `clearContent(range)` | 清除范围内容（保留样式） |

---

## 6. 合并单元格

> 以下 Workbook 方法为向后兼容代理。新代码推荐直接调用 `wb.mergeManager.*`。

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

> `insertRow`、`deleteRow`、`insertColumn`、`deleteColumn`、`fillAuto` 为向后兼容代理。新代码推荐直接调用 `wb.sheetStructure.*`；`moveColumn`、行高列宽和冻结 API 仍保留在 Workbook 上。

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
| `rebuildDependencyMap()` | — | 重建全表公式依赖图 |
| `getCalculationStats() → Object\|null` | 计算引擎缓存统计 |
| `resetCalculationStats()` | — | 重置计算统计 |
| `registerFunction(name, fn)` | `Workbook` | 注册自定义公式函数，并重算正在使用它的公式 |
| `unregisterFunction(name)` | `boolean` | 注销自定义函数 |
| `hasRegisteredFunction(name)` | `boolean` | 判断函数是否已注册 |
| `getRegisteredFunctions()` | `string[]` | 获取全部自定义函数名 |
| `inspectFormula(formula)` | `Object` | 静态检查公式语法、函数白名单和引用；不执行公式 |
| `translateFormula(formula, options)` | `string` | 按 `from`/`to` 目标位置平移相对 A1 引用 |

> 公式语法见 [FORMULAS.md](./FORMULAS.md)。`recalcAll` 在启用 Worker 时返回 `Promise`。

```js
wb.registerFunction('DOUBLE', value => value * 2);
wb.registerFunction('SUM_MATRIX', matrix =>
  matrix.flat().reduce((sum, value) => sum + value, 0)
);

wb.setCell(0, 0, { v: 21 });
wb.setCell(0, 1, { v: '=DOUBLE(A1)' });       // 42
wb.setCell(0, 2, { v: '=SUM_MATRIX(A1:A2)' }); // 范围以二维数组传入
```

函数名大小写不敏感，可使用字母、数字和下划线；不能覆盖内置函数。函数返回
`number`、`string`、`boolean` 或 `null`，异常会转换为 `#ERROR!`。自定义函数只在
主线程执行；包含自定义函数的公式批次会自动绕过 Worker/WASM。

`inspectFormula()` 面向 AI 计划预检，只返回 `{ valid, functions, references, errors }`。
M1 只放行基础四则和 `SUM`、`AVERAGE`、`MIN`、`MAX`、`COUNT`、`ROUND`、`IF`，并拒绝
跨 Sheet 引用、绝对/混合引用、越界引用、未知或未开放函数、`NOW`/`TODAY` 以及自定义
函数。它不代表授权检查或循环依赖检查通过。

`translateFormula(formula, { from, to })` 只平移当前 Sheet 的相对 A1 单元格和范围引用，
保留空白与字符串字面量；检查失败会抛出 `FormulaInspectionError`，不会返回部分翻译结果。

```js
wb.inspectFormula('=A2*B2');
// { valid: true, functions: [], references: [...], errors: [] }

wb.translateFormula('=A2*B2', {
  from: { r: 1, c: 2 },
  to: { r: 2, c: 2 }
});
// '=A3*B3'
```

细粒度公式操作位于 `workbook.formulaEvaluator`：

| 方法 | 说明 |
|------|------|
| `recalcDirty()` | 增量重算脏单元格及其依赖 |
| `triggerRecalc(r, c)` | 触发某单元格及其依赖重算 |
| `evaluateFormula(formula, r, c, stack?)` | 求值单个公式 |
| `getDependencies(formula)` | 解析公式引用的单元格与范围依赖 |
| `inspectFormula(formula)` | 静态检查 AI 计划公式 |
| `translateFormula(formula, options)` | 平移相对 A1 引用 |
| `registerFunction(name, fn)` / `unregisterFunction(name)` | 管理当前求值器的自定义函数 |

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
导出当前工作簿为纯对象：`{ rowCount, colCount, rowHeights, colWidths, data, merges, freeze, sheetName, activeSheetId, sheets }`。`sheets` 中包含所有工作表的状态快照。

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
订阅事件并返回取消订阅函数。常用事件包括 `mutation-committed`、`cell-change`、`selection-change`、`data-load`、`structure-change`、`style-change`、`merge-change`、`freeze-change`、`save-status`、`error` 和 `change`。

### `off(event, callback)`
取消订阅。

### `once(event, callback) → unsubscribe`
一次性订阅。

### `notify(data?)`
手动触发变更通知。

```js
const unsub = wb.on('cell-change', ({ r, c, oldValue, newValue }) => {
  console.log(`(${r},${c}) ${oldValue} → ${newValue}`);
});
unsub();
```

> 事件 payload 结构与插件钩子一致，详见 [插件开发文档 §5](./PLUGIN_DEVELOPMENT.md#5-事件与钩子数据)。

### `mutation-committed`
一个同步内容修改批次结束后触发，批次内只推进一次修订号。事件发生时数据和本次操作的历史记录已经可读取；在事件监听器中再次写入产生的提交仍按版本顺序派发。`skipEvent` 只跳过旧的 `cell-change`，`skipHistory` 只跳过历史记录，二者都不会跳过内容版本。

```js
wb.on('mutation-committed', event => {
  console.log(event.previousRevision, event.revision, event.sheetIds);
});
```

| 字段 | 说明 |
| --- | --- |
| `type` | 固定为 `mutation-committed` |
| `mutationId` | 当前实例内唯一，例如 `mutation-18`；不是跨实例的文档标识 |
| `previousRevision` / `revision` | 本次提交前后的修订号 |
| `sheetId` / `sheetIds` | 受影响的 Sheet；跨表批次中 `sheetId` 为 `null`，完整集合在 `sheetIds` |
| `source` | `edit`、`style`、`structure`、`comment`、`import`、`undo` 或 `redo`；嵌套批次使用最外层来源 |
| `changedCells` | 去重后的已触及坐标数；整表替换或无法精确计数的结构修改为 `null`，纯配置修改可为 `0` |

这是内容版本通知，不是事务成功或落盘成功承诺。原有非原子写入接口若中途失败但已修改部分内容，仍推进版本；已成功回滚的 JSON 导入不推进版本。确认写入仍需另行实现原子补丁与失败恢复。

应用应独立维护 `documentEpoch`：在更换 Workbook、导入、重新加载或存储恢复开始前更新 epoch，并在切换 Sheet 时通过既有 `sheet-change` 事件使旧任务失效。`source: 'import'` 的内容提交及 `data-load` 可作为重载完成后的补充失效通知。分帧导入须在开始前失效旧任务，不能等所有分片结束后才处理，也不能将 revision 当作 epoch。

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
try {
  for (let i = 0; i < 1000; i++) wb.setCell(i, 0, { v: i });
} finally {
  wb.endBatchUpdate();
}
```

Store 批次、`history.startBatch()` / `endBatch()` 均支持嵌套，内容版本在最外层结束时提交一次；已有细粒度事件保持原契约，不全部合并。必须成对调用并用 `finally` 关闭，不跨 `await` 持有批次。现有分帧导入按每个实际写入批次更新版本，期间发生的其他编辑也正常更新版本。

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
| `enablePersistenceStorage(options?)` | `PersistenceStorage` | 启用并返回持久化存储（IndexedDB），`options.sheetId` 指定键 |
| `persist(sheetId?)` | `Promise` | 全量持久化，默认 `'default'` |
| `loadFromStorage(sheetId?)` | `Promise` | 从存储加载 |
| `savePendingChanges(sheetId?)` | `Promise` | 保存增量（diff）变更 |
| `flushPersistence()` | `Promise` | 立即落盘待写入数据 |

> `AutoSavePlugin` 即基于这些方法实现自动保存。

---

## 21. 布局与坐标

> 以下布局查询方法为向后兼容代理。新代码推荐直接调用 `wb.layoutEngine.*`。

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

### `close()`

异步保存所有待持久化变更，然后释放 Workbook 资源。启用持久化后，`close()` 是标准关闭方式；Promise 完成前存储连接不会关闭。如果保存失败，Promise 会拒绝，Workbook 保持可用，调用方可以提示用户或重试。

```js
try {
  // 使用 Workbook
} finally {
  await wb.close();
}
```

Vue 组件卸载时应显式处理关闭失败：

```js
onUnmounted(() => {
  void wb.close().catch((error) => {
    console.error('Workbook 保存失败', error);
  });
});
```

### `destroy()`

同步强制销毁工作簿并清理全部资源，但不会等待持久化写入。存在待保存单元格、布局配置或正在执行的保存任务时会输出警告，未落盘内容可能丢失。

仅在未启用持久化或明确需要放弃待保存数据时调用：

```js
wb.destroy();
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

// 5. 启用持久化并写入数据
wb.enablePersistenceStorage({ sheetId: 'scores' });
wb.setCell(3, 0, { v: '王五' });

// 6. 先保存，再释放资源
unsub();
await wb.close();
```
