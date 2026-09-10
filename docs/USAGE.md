# Vue Canvas Sheet 使用文档

> 一个基于 Canvas 渲染、使用共享 JS 公式引擎并为已验证纯数字算术提供 WASM 加速的 Vue 3 表格组件。

- 包名：`vue-canvas-sheet`
- 当前版本：`0.1.0`
- 协议：Apache-2.0
- Vue 版本要求：`vue ^3.5.0`

> 相关文档：[包导出总览](./API_OVERVIEW.md) ｜ [Workbook API](./WORKBOOK_API.md) ｜ [插件开发](./PLUGIN_DEVELOPMENT.md) ｜ [公式](./FORMULAS.md)

---

## 目录

1. [安装](#1-安装)
2. [快速开始](#2-快速开始)
3. [组件 Props](#3-组件-props)
4. [组件方法与插槽](#4-组件方法与插槽)
5. [Workbook API](#5-workbook-api)
6. [数据格式](#6-数据格式)
7. [插件系统](#7-插件系统)
8. [大数据与懒加载](#8-大数据与懒加载)
9. [持久化（秒开）](#9-持久化秒开)
10. [实时协同](#10-实时协同)
11. [导入 / 导出](#11-导入--导出)
12. [常见问题](#12-常见问题)

---

## 1. 安装

```bash
npm install vue-canvas-sheet
# 或
yarn add vue-canvas-sheet
```

WASM 计算引擎已经预构建并随包发布，无需额外的工具链。

---

## 2. 快速开始

```vue
<template>
  <div style="height: 100vh">
    <TableDesigner :initial-data="data" />
  </div>
</template>

<script setup>
import { TableDesigner } from 'vue-canvas-sheet';

const data = [
  ['类别', '数值1', '数值2', '合计'],
  ['苹果', 10, 20, { f: '=B2+C2' }],
  ['香蕉', 30, 40, { f: '=B3+C3' }],
  ['总计', { f: '=SUM(B2:B3)' }, { f: '=SUM(C2:C3)' }, { f: '=SUM(D2:D3)' }],
];
</script>
```

注意：`TableDesigner` 会撑满父容器的高度，请确保父容器有显式 `height`。

---

## 3. 组件 Props

| 名称 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `initialData` | `Array \| Object` | `null` | 初始数据。按引用变更会自动重载。 |
| `reloadKey` | `String \| Number \| Boolean` | `null` | 显式重载标记。当数据原地修改时，可通过变更此值触发重载，避免深比较。 |
| `columns` | `Array` | `[]` | 列定义（含表头、字段映射等），具体结构见下方说明。 |
| `readOnly` | `Boolean` | `false` | 只读模式，隐藏工具栏并禁止编辑。 |
| `loading` | `Boolean` | `false` | 是否显示内置加载遮罩。 |
| `plugins` | `Array` | `[]` | 要装载的插件列表（见 [插件系统](#7-插件系统)）。 |
| `toolbar` | `Array<String>` | `['history','cells','font','alignment','numbers','table','freeze','data']` | 工具栏分组开关。从数组中移除某组即可隐藏。 |
| `lazyLoad` | `Object` | `{ enabled: false }` | 懒加载配置，详见 [懒加载](#8-大数据与懒加载)。 |
| `enablePersistence` | `Boolean` | `false` | 启用 IndexedDB diff 持久化，实现秒开。 |
| `sheetId` | `String` | `'default'` | 持久化指纹。多个表实例需用不同 `sheetId` 隔离存储。 |

### `columns` 字段示例

```js
const columns = [
  { title: '姓名', field: 'name', width: 120 },
  { title: '年龄', field: 'age', width: 80, type: 'number' },
  { title: '入职时间', field: 'hireDate', width: 140, type: 'date' },
];
```

---

## 4. 组件方法与插槽

### 实例方法

通过 `ref` 拿到组件实例后可调用：

| 方法 | 说明 |
| --- | --- |
| `setData(data)` | 重设全部数据并触发渲染。 |
| `setColumns(columns)` | 重设列定义。 |
| `renderPage()` | 主动触发一次重绘。 |
| `triggerUpdate()` | 强制刷新 UI（递增 `uiVersion`）。 |

```vue
<template>
  <TableDesigner ref="table" :initial-data="data" />
</template>

<script setup>
import { ref, onMounted } from 'vue';
const table = ref(null);

onMounted(() => {
  // 直接访问 Workbook 实例进行底层操作
  const wb = table.value.workbook;
  wb.setCell(0, 0, { v: 'Hello' });
});
</script>
```

### 插槽

| 名称 | 说明 |
| --- | --- |
| `toolbar-end` | 工具栏最右侧的扩展区（独立分组）。 |
| `toolbar-end-group` | 工具栏最右侧的图标按钮组（合并展示）。 |

```vue
<TableDesigner :initial-data="data">
  <template #toolbar-end-group>
    <button class="vue-canvas-sheet-tool-btn" @click="onExport">
      <SvgIcon name="download" />
    </button>
  </template>
</TableDesigner>
```

---

## 5. Workbook API

`Workbook` 是组件背后的核心模型，可通过 `tableRef.workbook` 拿到。

### 单元格操作

```js
wb.setCell(r, c, { v: 100 });                // 写入纯值
wb.setCell(r, c, { v: 0, f: '=A1+B1' });     // 写入公式
wb.getCell(r, c);                            // 读取单元格 { v, f, s, ... }
wb.getCellValue(r, c);                       // 计算后的值
wb.getStyle(r, c);                           // 获取样式
```

### 选区与样式

```js
wb.setSelection(r1, c1, r2, c2);
wb.setStyle(range, { bold: true, color: '#f00' });
wb.setBorder(range, 'all', '#000', 'solid');
wb.setFormat(range, '0.00%');
wb.setDecimals(range, +1);                    // 增/减小数位数
```

### 合并 / 清除 / 撤销

```js
wb.mergeCells(range);
wb.unmergeCells(range);
wb.clearCells(range);
wb.undo();
wb.redo();
```

### 冻结窗格

```js
wb.setFreeze(freezeRowCount, freezeColCount);
```

### 计算引擎

```js
wb.enableWorker();                  // 启用 Web Worker 多线程
wb.recalcAll({ useWorker: true });  // 全量重算
wb.formulaEvaluator.recalcDirty();  // 只算脏单元格
wb.getSystemReport();               // 引擎诊断报告（WASM/线程/缓存等）
```

### 事件订阅

```js
const off = wb.on('selection-change', (sel) => { /* ... */ });
wb.on('cell-change', (changes) => { /* ... */ });
wb.on('data-load', () => { /* ... */ });
wb.on('lock-change', () => { /* ... */ });
off();                              // 取消订阅
```

### 查找替换

```js
wb.search.find('keyword', startCell, { caseSensitive: false, wrapAround: true });
wb.search.findAll('keyword', { caseSensitive: true });
wb.search.replaceAt('old', 'new', { r: 0, c: 0 });
wb.search.replaceAll('old', 'new');
```

---

## 6. 数据格式

`initialData` 支持二维数组形式，单元格可以是：

| 形式 | 示例 | 含义 |
| --- | --- | --- |
| 标量 | `10`、`'文本'`、`true` | 纯值。 |
| 对象 | `{ v: 10 }` | 显式带值。 |
| 公式 | `{ f: '=SUM(A1:A3)' }` | 公式单元格，值会自动计算。 |
| 富对象 | `{ v: 10, f: '=A1+1', s: { bold: true } }` | 同时含值、公式与样式。 |

```js
const data = [
  ['Header A', 'Header B', 'Header C'],
  [1, 2, { f: '=A2+B2' }],
  [{ v: 3, s: { color: 'red' } }, 4, { f: '=A3+B3' }],
];
```

---

## 7. 插件系统

> 想自己开发插件？请参阅 [插件开发文档（PLUGIN_DEVELOPMENT.md）](./PLUGIN_DEVELOPMENT.md)，内含架构、生命周期、钩子系统、共享状态与完整示例。

库内置的插件位于 `vue-canvas-sheet` 命名空间，全部以 `create<Name>Plugin(options)` 工厂函数提供。

```js
import {
  createSelectionHistoryPlugin,
  createAutoSavePlugin,
  createExportPlugin,
  createImportPlugin,
  createCollaborativeCursorPlugin,
  createRealtimeCollaborationPlugin,
} from 'vue-canvas-sheet';
```

将插件实例放入 `plugins` prop：

```vue
<TableDesigner :plugins="[historyPlugin, exportPlugin]" :initial-data="data" />
```

### 7.1 SelectionHistoryPlugin（选区前进/后退）

```js
const historyPlugin = createSelectionHistoryPlugin({ maxSize: 50 });

historyPlugin.canGoBack();
historyPlugin.canGoForward();
historyPlugin.goBack();
historyPlugin.goForward();
```

### 7.2 AutoSavePlugin（自动保存）

```js
const autoSave = createAutoSavePlugin({
  backend: 'indexedDB',          // 或 'localStorage'
  sheetId: 'my-sheet',
  interval: 5000,                // 定时保存，0 表示禁用
  eventDriven: true,             // 单元格变化即触发（带防抖）
  debounce: 1000,
  events: ['cell-change', 'data-load', 'structure-change'],
});
```

### 7.3 ExportPlugin（导出）

```js
const exportPlugin = createExportPlugin({ defaultFileName: 'data' });

exportPlugin.exportExcel({ fileName: 'data.xlsx' });
exportPlugin.exportJSON({ fileName: 'data.json' });
exportPlugin.exportCSV({ fileName: 'data.csv' });
```

CSV 导出默认防护以 `=`、`+`、`-` 或 `@` 开头的文本（包括前导空白或控制字符），避免被桌面表格软件当作公式执行。仅对可信数据显式使用 `exportPlugin.exportCSV({ allowFormulas: true })` 保留公式语义。数值类型的负数不会被改写。

Excel 导出对大表使用 Web Worker，避免阻塞主线程。

### 7.4 ImportPlugin（导入）

```js
const importPlugin = createImportPlugin({
  onComplete: (result) => console.log('导入完成', result),
  onError:    (err)    => alert('导入失败：' + err.message),
});

// 在 <input type="file"> 的 change 中：
importPlugin.importFile(file);
```

支持 `.xlsx / .xls / .csv / .tsv / .json`。

### 7.5 CollaborativeCursorPlugin + RealtimeCollaborationPlugin

`RealtimeCollaborationPlugin` 依赖 `CollaborativeCursorPlugin`，要按顺序装载：

```js
const cursorPlugin = createCollaborativeCursorPlugin({ expireTime: 15000 });
const collabPlugin = createRealtimeCollaborationPlugin({
  serverUrl: 'ws://localhost:3030',
  roomId:    'room-1',
  userId:    'lee',
  userName:  '李雷',
  userColor: '#3498db',
});

const plugins = [cursorPlugin, collabPlugin];
```

仓库内含 `scripts/collab-server.mjs`，本地可用 `npm run collab:server` 启动测试服务器。

---

## 8. 大数据与懒加载

对几万行以上的数据集，开启 `lazyLoad`：

```vue
<TableDesigner
  :initial-data="data"
  :lazy-load="{
    enabled: true,
    pageSize: 100,
    maxCachedPages: 10,
    preloadPages: 1,
  }"
/>
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用。 |
| `pageSize` | `100` | 每页行数。 |
| `maxCachedPages` | `10` | 最多缓存的页数（超过会回收）。 |
| `preloadPages` | `1` | 视口外预加载的页数。 |

如果数据已全在内存中，公式计算仍可走 Worker：

```js
wb.enableWorker();
wb.recalcAll({ useWorker: true });
```

---

## 9. 持久化（秒开）

```vue
<TableDesigner enable-persistence sheet-id="dashboard-2026" :initial-data="data" />
```

- 启用后内部使用 IndexedDB 的 diff 持久化路径。
- `sheetId` 必须唯一，不同表用不同 ID，避免相互覆盖。
- 与 `AutoSavePlugin` 可共存：组件自身负责 diff 写入，插件负责事件 / 定时调度。

---

## 10. 实时协同

协同需要一个 WebSocket 服务器作为消息中转。最小客户端代码：

```js
import {
  TableDesigner,
  createCollaborativeCursorPlugin,
  createRealtimeCollaborationPlugin,
} from 'vue-canvas-sheet';

const plugins = [
  createCollaborativeCursorPlugin(),
  createRealtimeCollaborationPlugin({
    serverUrl: 'ws://your-host:3030',
    roomId: 'room-A',
    userId: currentUser.id,
    userName: currentUser.name,
    userColor: '#3498db',
  }),
];
```

特性：

- 选区与光标实时同步。
- 单元格编辑会自动加锁，防止并发覆盖。
- 单元格被他人锁定时，公式栏输入会被拦截并提示。

`fieldNames` 选项可重命名传输字段，便于对接已有的协同协议。

---

## 11. 导入 / 导出

最常用的组合方式（与 Demo 一致）：

```vue
<TableDesigner :plugins="[exportPlugin, importPlugin]" :initial-data="data">
  <template #toolbar-end-group>
    <button class="vue-canvas-sheet-tool-btn" @click="onExportXlsx">
      <SvgIcon name="document-xls" />
    </button>
    <button class="vue-canvas-sheet-tool-btn" @click="onImport">
      <SvgIcon name="upload" />
    </button>
    <input ref="fileInput" type="file" style="display:none"
           accept=".json,.xlsx,.xls,.csv,.tsv"
           @change="onFileChange" />
  </template>
</TableDesigner>
```

```js
function onExportXlsx() {
  exportPlugin.exportExcel({ fileName: 'data.xlsx' });
}
function onImport() {
  fileInput.value?.click();
}
function onFileChange(e) {
  const file = e.target.files[0];
  if (file) {
    importPlugin.importFile(file);
    e.target.value = '';
  }
}
```

---

## 12. 常见问题

### Q: 公式没有自动计算？
确保启用了 Worker：`tableRef.workbook.enableWorker()`。或主动 `wb.recalcAll({ useWorker: true })`。

### Q: 切换数据后界面没更新？
按引用替换 `initialData` 即可；如果是原地修改同一份数据，请变更 `reloadKey` 触发显式重载。

### Q: WASM 提示未启用 SharedArrayBuffer？
浏览器需要跨源隔离环境（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`）。引擎会自动降级到主线程计算，但性能会下降。可用 `wb.getSystemReport()` 查看当前状态。

### Q: 大数据加载非常慢？
- 开启懒加载（`lazyLoad.enabled = true`）。
- 启用 Worker：`wb.enableWorker()`。
- 用 `recalcAll({ useWorker: true })` 替代逐 cell 触发计算。

### Q: 自定义工具栏？
通过 `toolbar` prop 控制内置分组，再用 `toolbar-end` / `toolbar-end-group` 插槽追加自己的按钮。

---

更多示例可参考 `samples/basic-usage/`。运行 `npm run demo` 即可在本地查看完整 Demo。
