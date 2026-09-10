# 包导出总览（API Overview）

> `vue-canvas-sheet` 对外暴露的完整 API 清单，按三个入口组织。每一项均与源码、类型定义和专题文档交叉链接。

- 包名：`vue-canvas-sheet`
- 类型定义：[types/index.d.ts](../types/index.d.ts) ｜ [types/core.d.ts](../types/core.d.ts) ｜ [types/render.d.ts](../types/render.d.ts)
- 相关文档：[使用文档](./USAGE.md) ｜ [Workbook API](./WORKBOOK_API.md) ｜ [插件开发](./PLUGIN_DEVELOPMENT.md) ｜ [公式](./FORMULAS.md)

---

## 入口一览

包通过 `package.json` 的 `exports` 暴露三个子路径，分别对应不同使用层级：

| 入口 | 源码 | 产物 | 适用场景 |
|------|------|------|---------|
| `vue-canvas-sheet` | [src/index.js](../src/index.js) | `dist/designer.es.js` | 开箱即用的 Vue 组件 + 引擎 + 插件 |
| `vue-canvas-sheet/core` | [src/core/index.js](../src/core/index.js) | `dist/core.es.js` | 仅需无头（headless）数据引擎 |
| `vue-canvas-sheet/render` | [src/core/render/index.js](../src/core/render/index.js) | `dist/render.es.js` | 自定义渲染层 / 复用渲染工具 |

```js
// 1) 主入口：组件 + 引擎 + 插件
import TableDesigner, { Workbook, createAutoSavePlugin } from 'vue-canvas-sheet';

// 2) core：无头引擎
import { Workbook, EventEmitter, PluginRegistry } from 'vue-canvas-sheet/core';

// 3) render：渲染工具
import { createProgressiveRenderer, measureTextWidth } from 'vue-canvas-sheet/render';
```

> 三个入口分别使用 `types/index.d.ts`、`types/core.d.ts` 和 `types/render.d.ts`，与 `package.json#exports` 一一对应。

---

## 一、主入口 `vue-canvas-sheet`

源码：[src/index.js](../src/index.js)

| 导出 | 类型 | 说明 |
|------|------|------|
| `TableDesigner` | Vue 组件 | **默认导出**，开箱即用的表格设计器（含工具栏、编辑、导入导出 UI） |
| `SvgIcon` | Vue 组件 | 图标组件 |
| `Workbook` | class | 核心数据引擎（详见 [Workbook API](./WORKBOOK_API.md)） |
| 全部内置插件 | — | `export * from './plugins'`，见[第四节](#四内置插件) |

### `TableDesigner` Props

| Prop | 类型 | 默认 | 说明 |
|------|------|:---:|------|
| `loading` | `boolean` | `false` | 加载态 |
| `initialData` | `object \| any[] \| null` | `null` | 初始数据（按引用变化触发重载） |
| `reloadKey` | `string \| number \| boolean \| null` | `null` | 显式重载标记（原地改数据时使用） |
| `columns` | `any[]` | `[]` | 列定义（支持多级表头） |
| `readOnly` | `boolean` | `false` | 只读模式 |
| `plugins` | `PluginInterface[]` | `[]` | 注入的插件实例 |
| `toolbar` | `string[]` | `['history','cells','font','alignment','numbers','table','freeze','data']` | 工具栏分组 |
| `lazyLoad` | `LazyLoadConfig` | `{ enabled: false }` | 懒加载配置（`pageSize`/`maxCachedPages`/`preloadPages`） |
| `enablePersistence` | `boolean` | `false` | 启用持久化（秒开） |
| `sheetId` | `string` | `'default'` | 工作表 ID（持久化指纹） |

> 组件用法、插槽、ref 方法详见 [使用文档 §3–4](./USAGE.md)。

---

## 二、`vue-canvas-sheet/core`

源码：[src/core/index.js](../src/core/index.js)

| 导出 | 类型 | 说明 |
|------|------|------|
| `Workbook` | class | 核心数据引擎，承载数据/样式/合并/公式/历史/选区/持久化等。完整方法见 [Workbook API](./WORKBOOK_API.md) |
| `Store` | class | 单一状态容器：`getState` / `setState` / `subscribe` / `select` / `beginBatch` / `endBatch` |
| `StoreManager` | class | 多 Store 管理：`getStore` / `addStore` / `subscribe` / `destroy` |
| `EventEmitter` | class | 事件发射器：`on` / `off` / `once` / `emit` / `emitThrottled` / `emitDedup` / `emitBatch` / `clear` / `listenerCount` |
| `PluginRegistry` | class | 插件注册中心，详见 [插件开发 §8](./PLUGIN_DEVELOPMENT.md) |
| `createPlugin` | function | 插件工厂：`createPlugin(name, definition)` |
| `HookTypes` | const | 钩子类型枚举 |
| `SharedValueStore` | class | 基于 `SharedArrayBuffer` 的数值存储（WASM 零拷贝） |

```js
import { Workbook, EventEmitter, createPlugin, HookTypes } from 'vue-canvas-sheet/core';

const wb = new Workbook();
const bus = new EventEmitter();
```

> `Store` / `EventEmitter` / `SharedValueStore` 多为引擎内部协作组件，进阶定制或自建渲染层时可直接使用。

---

## 三、`vue-canvas-sheet/render`

源码：[src/core/render/index.js](../src/core/render/index.js)

### 渲染器

| 导出 | 类型 | 说明 |
|------|------|------|
| `OffscreenRenderer` | class | 离屏 Canvas 渲染器 |
| `createOffscreenRenderer(options)` | function | 创建离屏渲染器 |
| `isOffscreenCanvasSupported()` | function | 检测 `OffscreenCanvas` 支持 |
| `createProgressiveRenderer(options)` | function | 创建渐进式渲染器（按优先级分帧渲染） |
| `Priority` | const | 渲染优先级：`CRITICAL(0)` / `HIGH(1)` / `NORMAL(2)` / `LOW(3)` |
| `TaskState` | const | 任务状态：`PENDING` / `RUNNING` / `PAUSED` / `COMPLETED` / `CANCELLED` |

### 文本布局工具（`TextLayout`）

源码：[src/core/render/TextLayout.js](../src/core/render/TextLayout.js)

| 导出 | 类型 | 说明 |
|------|------|------|
| `LRUCache` | class | LRU 缓存（文本测量/位图缓存底层） |
| `measureTextWidth(ctx, text, font, options?)` | function | 测量文本宽度 |
| `wrapTextByWidth(text, availableWidth, font, measureText, cache?, options?)` | function | 按宽度换行 |
| `getWrappedTextLayout(options)` | function | 计算多行文本布局 |
| `getSingleLineTextLayout(options)` | function | 计算单行文本布局 |
| `parseFontSize(fontOrSize, fallback?)` | function | 解析字号 |
| `isNumberLikeText(text)` | function | 判断是否数字样式文本 |
| `makeTextCacheKey` / `makeTextBitmapCacheKey` / `makeWrappedTextCacheKey` | function | 生成缓存键 |
| `canCacheTextBitmap(text, style)` | function | 是否可缓存位图 |
| `getTextBitmapSize(textWidth, font, options?)` | function | 计算位图尺寸 |
| `getLineStartX` / `getBitmapDrawPosition` / `getSingleLineDecoration` | function | 绘制坐标/装饰线辅助 |

```js
import { createProgressiveRenderer, Priority, measureTextWidth } from 'vue-canvas-sheet/render';
```

---

## 四、内置插件

随主入口 `vue-canvas-sheet` 导出（`export * from './plugins'`）。每个插件均提供 **类** 与 **`createXxxPlugin(options)` 工厂** 两种导出。源码：[src/plugins/](../src/plugins/)

| 插件类 | 工厂函数 | `name` | 说明 | 关键选项 |
|--------|---------|--------|------|---------|
| `AutoSavePlugin` | `createAutoSavePlugin` | `AutoSave` | 自动保存到 IndexedDB diff（localStorage 降级） | `backend` / `interval` / `debounce` / `events` / `sheetId` |
| `SelectionHistoryPlugin` | `createSelectionHistoryPlugin` | `SelectionHistory` | 选区历史前进/后退 | `maxSize` |
| `ExportPlugin` | `createExportPlugin` | `Export` | 导出 Excel / JSON / CSV | `defaultFileName` / `useWorker` / `onProgress` |
| `ImportPlugin` | `createImportPlugin` | `Import` | 导入文件 / JSON | `batchSize` / `onProgress` |
| `CollaborativeCursorPlugin` | `createCollaborativeCursorPlugin` | `CollaborativeCursor` | 协同光标显示 | `expireTime` |
| `RealtimeCollaborationPlugin` | `createRealtimeCollaborationPlugin` | `RealtimeCollaboration` | 实时协同编辑（WebSocket） | `serverUrl` / `roomId` / `userId` / `userName` |

```js
import {
  createAutoSavePlugin,
  createExportPlugin,
  createRealtimeCollaborationPlugin,
} from 'vue-canvas-sheet';

workbook.usePlugin(createAutoSavePlugin({ interval: 5000 }));
```

> 插件的生命周期、钩子、共享状态及自定义插件开发，详见 [插件开发文档](./PLUGIN_DEVELOPMENT.md)。

---

## 五、TypeScript 类型

类型声明按运行时入口隔离：

- [types/index.d.ts](../types/index.d.ts)：`TableDesigner`、`SvgIcon`、`Workbook` 和内置插件。
- [types/core.d.ts](../types/core.d.ts)：`Workbook`、`SelectionManager`、`Store`、`EventEmitter`、`PluginRegistry` 与 `SharedValueStore`。
- [types/render.d.ts](../types/render.d.ts)：`OffscreenRenderer`、渐进渲染器和 `TextLayout` 工具。

```ts
import type { Workbook, Cell, Range, PluginInterface } from 'vue-canvas-sheet';
```
