# Vue Canvas Sheet 插件开发文档

> 面向 `vue-canvas-sheet` 的插件系统开发指南。介绍插件架构、生命周期、钩子系统、共享状态、最佳实践，并提供从零编写、调试、发布插件的完整示例。

- 包名：`vue-canvas-sheet`
- 协议：Apache-2.0
- 核心文件：
  - 注册中心：[src/core/plugin/PluginRegistry.js](../src/core/plugin/PluginRegistry.js)
  - 优化器：[src/core/plugin/PluginOptimizer.js](../src/core/plugin/PluginOptimizer.js)
  - 内置插件：[src/plugins/](../src/plugins/)

---

## 目录

1. [架构概览](#1-架构概览)
2. [插件接口规范](#2-插件接口规范)
3. [生命周期](#3-生命周期)
4. [钩子系统](#4-钩子系统)
5. [事件与钩子数据](#5-事件与钩子数据)
6. [共享状态与插件间通信](#6-共享状态与插件间通信)
7. [依赖管理](#7-依赖管理)
8. [注册、卸载与查询 API](#8-注册卸载与查询-api)
9. [编写第一个插件](#9-编写第一个插件)
10. [进阶：懒加载与性能优化](#10-进阶懒加载与性能优化)
11. [内置插件参考](#11-内置插件参考)
12. [最佳实践](#12-最佳实践)
13. [调试与排错](#13-调试与排错)
14. [发布插件](#14-发布插件)

---

## 1. 架构概览

插件系统由 `Workbook` 持有的 **`PluginRegistry`（注册中心）** 驱动。每个 `Workbook` 实例都会在构造时创建一个独立的注册中心：

```
Workbook
 ├─ this.plugins  ← PluginRegistry 实例
 │    ├─ plugins:      Map<name, plugin>      已注册插件
 │    ├─ hooks:        Map<hookType, Set<fn>> 钩子监听器
 │    ├─ sharedState:  Map<key, any>          插件间共享数据
 │    └─ optimizer:    PluginOptimizer        钩子性能监控/重排
 └─ _emit(event, payload) ──→ plugins.trigger(event, payload)
```

数据流：

1. 用户调用 `workbook.usePlugin(plugin)` 注册插件。
2. 注册中心校验名称、依赖，绑定钩子，调用 `onInit`。
3. 工作簿就绪后 `onMounted` 被调用，插件开始监听事件。
4. 工作簿内部状态变化（编辑单元格、改选区等）时调用 `_emit`，注册中心同步触发对应钩子。
5. 卸载时调用 `onUnmount`，插件需自行清理副作用。

> 关键点：`workbook._emit(event, payload)` 同时驱动 **事件系统**（`workbook.on`）和 **插件钩子**（`plugin.hooks`）。两者接收到的数据一致，区别在于使用方式（见 [第 4 节](#4-钩子系统)）。

---

## 2. 插件接口规范

插件是一个普通对象或类实例，遵循 `PluginInterface`：

| 属性 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `name` | `string` | ✅ | 插件唯一名称，重复注册会抛错 |
| `version` | `string` | | 版本号，建议遵循 semver |
| `description` | `string` | | 插件描述 |
| `dependencies` | `string[]` | | 依赖的其他插件名称，未满足时注册抛错 |
| `hooks` | `Object<HookType, Function>` | | 钩子映射，注册时自动 `bind(plugin)` |
| `onInit(workbook, registry)` | `Function` | | 注册时调用（最早时机） |
| `onMounted(workbook, registry)` | `Function` | | 挂载时调用（工作簿就绪后） |
| `onUnmount()` | `Function` | | 卸载时调用，清理副作用 |
| `onError(error, workbook)` | `Function` | | 插件内部错误处理 |

两种等价写法：

**类写法（推荐，内置插件均采用）：**

```js
export class MyPlugin {
  name = 'MyPlugin';
  version = '1.0.0';
  description = '我的插件';
  dependencies = [];

  constructor(options = {}) {
    this.options = options;
  }

  onInit(workbook, registry) { /* ... */ }
  onMounted(workbook, registry) { /* ... */ }
  onUnmount() { /* ... */ }
}

export function createMyPlugin(options) {
  return new MyPlugin(options);
}
```

**工厂函数写法（`createPlugin`）：**

```js
import { createPlugin } from 'vue-canvas-sheet/core';

const myPlugin = createPlugin('MyPlugin', {
  version: '1.0.0',
  description: '我的插件',
  hooks: {
    'cell-change': function (data) {
      console.log('单元格变更', data);
    }
  },
  onMounted(workbook, registry) { /* ... */ }
});
```

> 约定：每个内置插件都同时导出 `XxxPlugin` 类与 `createXxxPlugin(options)` 工厂函数。建议你的插件也遵循这一约定，方便使用者按需选择。

---

## 3. 生命周期

完整生命周期及触发的内部钩子：

```
register(plugin)
   │
   ├─ 校验 name / dependencies
   ├─ 触发钩子 before-init
   ├─ plugins.set(name, plugin)
   ├─ 绑定 plugin.hooks → registry.on(...)
   ├─ plugin.onInit(workbook, registry)      ← ① 初始化
   ├─ 触发钩子 after-init
   └─ 若已 init 且 autoMount → _mountPlugin
            │
            ├─ 触发钩子 before-mount
            ├─ plugin.onMounted(workbook, registry)   ← ② 挂载
            ├─ plugin._mounted = true
            └─ 触发钩子 after-mount

unregister(name)
   ├─ 检查是否被其他插件依赖
   ├─ 触发钩子 before-unmount
   ├─ plugin.onUnmount()                      ← ③ 卸载
   ├─ 解绑 plugin.hooks
   ├─ plugins.delete(name)
   └─ 触发钩子 after-unmount
```

### `onInit` vs `onMounted`

| | `onInit` | `onMounted` |
|---|---|---|
| 时机 | 插件注册的瞬间 | 工作簿就绪后（`registry._initialized === true`） |
| 入参 | `(workbook, registry)` | `(workbook, registry)` |
| 适合做 | 注册共享状态 API、读取选项、占位 | 绑定事件监听、启动定时器、访问工作簿数据 |
| 注意 | 此时工作簿数据可能尚未加载 | 真正开始“工作”的地方 |

> 注册顺序说明：若插件在 `workbook` 初始化（`this.plugins.init()`，见 [Workbook.js:265](../src/core/Workbook.js#L265)）**之后** 注册，且 `autoMount` 为 `true`（默认），则 `onInit` 后会立即 `onMounted`。若在初始化前注册，则需等到 `init()` 或显式 `mountAll()` 时挂载。

### `onUnmount` 必须清理的内容

`PluginRegistry` 会自动解绑通过 `plugin.hooks` 注册的钩子，但 **不会** 清理你在 `onMounted` 中手动建立的副作用。你必须在 `onUnmount` 中自行清理：

- `workbook.on(...)` 返回的取消订阅函数
- `setInterval` / `setTimeout` 定时器
- `setSharedState` 写入的共享状态
- DOM 监听器、WebSocket 连接等外部资源

---

## 4. 钩子系统

有两种监听工作簿变化的方式，二者数据一致，按需选择：

### 方式 A：`hooks` 映射（声明式）

在插件上声明 `hooks` 对象，注册中心会自动绑定与解绑：

```js
export class LoggerPlugin {
  name = 'Logger';
  hooks = {
    'cell-change': function (data) {
      // this 已被 bind 到插件实例
      console.log(`[${this.name}]`, data.r, data.c, data.newValue);
    },
    'selection-change': function (data) {
      console.log('选区', data.selection);
    }
  };
}
```

- 钩子函数中的 `this` 自动指向插件实例。
- 卸载时自动解绑，无需手动清理。
- 若钩子函数 **返回非 `undefined` 值**，该返回值会替换 `data` 传给后续钩子（支持数据加工链，见下文）。

### 方式 B：`workbook.on(event, handler)`（命令式）

在 `onMounted` 中订阅事件，返回取消订阅函数：

```js
onMounted(workbook, registry) {
  this._unsub = workbook.on('cell-change', (data) => {
    this._handle(data);
  });
}
onUnmount() {
  this._unsub?.();
}
```

- 更灵活，可在运行时动态订阅/退订。
- **必须** 在 `onUnmount` 中手动取消订阅。

### 数据加工链（仅 `hooks` 方式 + `trigger` 返回值）

`_triggerHook` 会顺序执行同一钩子下的所有处理器，若处理器返回值非 `undefined`，则作为新的 `data` 传给下一个处理器，并最终由 `trigger` 返回：

```js
hooks = {
  'cell-change': function (data) {
    // 加工数据后返回，影响后续钩子接收到的内容
    return { ...data, newValue: String(data.newValue).trim() };
  }
};
```

> 注意：内置 `_emit` 路径不会回写工作簿状态——加工链只影响后续 **钩子** 收到的数据，不会改变单元格的真实值。若需修改真实值，请调用工作簿的写 API（如 `workbook.setCell(r, c, { v })`）。

---

## 5. 事件与钩子数据

钩子类型定义见 [PluginRegistry.js](../src/core/plugin/PluginRegistry.js) 的 `HookTypes`，事件名定义见 [EventEmitter.js](../src/core/events/EventEmitter.js) 的 `Events`，二者字符串一致。

### 生命周期钩子（由注册中心内部触发）

| 钩子类型 | 常量 | 触发数据 |
|---------|------|---------|
| `before-init` | `HookTypes.BEFORE_INIT` | `{ plugin }` |
| `after-init` | `HookTypes.AFTER_INIT` | `{ plugin }` 或 `{ registry }` |
| `before-mount` | `HookTypes.BEFORE_MOUNT` | `{ plugin }` |
| `after-mount` | `HookTypes.AFTER_MOUNT` | `{ plugin }` |
| `before-unmount` | `HookTypes.BEFORE_UNMOUNT` | `{ plugin }` |
| `after-unmount` | `HookTypes.AFTER_UNMOUNT` | `{ plugin: { name } }` |
| `error` | `HookTypes.ERROR` | `{ pluginName, error, timestamp }` |

### 业务事件钩子（由 `workbook._emit` 触发）

| 钩子类型 | 触发时机 | 数据结构（payload） |
|---------|---------|---------|
| `cell-change` | 单元格值变化 | `{ r, c, oldValue, newValue }` |
| `selection-change` | 选区/活动单元格变化 | `{ selection, activeCell }` |
| `data-load` | 批量加载/清空数据 | `{ action: 'setData'\|'clear', count }` |
| `structure-change` | 行列结构变化 | `{ action: 'setColumns', count }` |
| `style-change` | 样式变化 | 视具体操作而定 |
| `merge-change` | 合并单元格变化 | 视具体操作而定 |
| `freeze-change` | 冻结行列变化 | `{ r, c }` |
| `history-change` | 撤销/重做栈变化 | 视具体操作而定 |
| `save-status` | 保存状态变化（AutoSave 等发出） | `{ status, backend, key, ... }` |

> 数据结构以 `Workbook.js` 中对应 `_emit` 调用为准，例如 `cell-change` 见 [Workbook.js:969](../src/core/Workbook.js#L969)，`selection-change` 见 [Workbook.js:2354](../src/core/Workbook.js#L2354)。新增字段以源码为准。

---

## 6. 共享状态与插件间通信

注册中心提供一个跨插件的键值存储，用于插件间共享数据或暴露 API：

```js
// 写入
registry.setSharedState('myPlugin:api', () => this.doSomething());
registry.setSharedState('myPlugin:config', { enabled: true });

// 读取（带默认值）
const api = registry.getSharedState('myPlugin:api');
const cfg = registry.getSharedState('myPlugin:config', {});

// 删除（卸载时务必清理）
registry.deleteSharedState('myPlugin:api');
```

**典型用法**：将插件能力暴露给 UI 或其他插件。例如 `SelectionHistoryPlugin` 在 `onInit` 中注册可调用接口，外部通过共享状态拿到函数直接调用：

```js
// 插件内
registry.setSharedState('selectionHistory:goBack', () => this.goBack());

// 外部 / UI
const goBack = workbook.plugins.getSharedState('selectionHistory:goBack');
goBack?.();
```

> 命名约定：使用 `插件名:键` 的命名空间格式（如 `autosave:status`、`selectionHistory:canGoBack`），避免键冲突。

---

## 7. 依赖管理

通过 `dependencies` 声明对其他插件的依赖。注册时若依赖未注册，会抛错：

```js
export class AdvancedExportPlugin {
  name = 'AdvancedExport';
  dependencies = ['Export'];   // 必须先注册 Export 插件
}
```

- 注册顺序很重要：**先注册被依赖的插件**。
- 卸载保护：若插件 B 依赖 A，则在 B 卸载前无法卸载 A，`unregister('A')` 会返回 `false` 并打印警告。
- 查询依赖关系：`registry._getDependents(name)` 返回依赖某插件的插件列表（内部方法）。

---

## 8. 注册、卸载与查询 API

### 通过 Workbook（推荐）

```js
workbook.usePlugin(plugin, options);   // 注册，返回 workbook 支持链式
workbook.unusePlugin(name);            // 卸载，返回 boolean
workbook.getPlugin(name);              // 获取插件实例
```

```js
workbook
  .usePlugin(createAutoSavePlugin({ interval: 5000 }))
  .usePlugin(createSelectionHistoryPlugin());
```

### 通过 PluginRegistry（更细粒度）

```js
const registry = workbook.plugins;

registry.register(plugin, { autoMount: true }); // 注册
registry.unregister(name);                       // 卸载
registry.get(name);                              // 获取实例
registry.has(name);                              // 是否已注册
registry.isMounted(name);                        // 是否已挂载
registry.mountAll();                             // 挂载所有
registry.getPluginInfo();                        // 列出所有插件信息
registry.destroy();                              // 卸载全部并清理
```

`getPluginInfo()` 返回：

```js
[
  { name: 'AutoSave', version: '2.1.0', description: '...', mounted: true, dependencies: [] }
]
```

### 注册选项

| 选项 | 默认 | 说明 |
|------|:---:|------|
| `autoMount` | `true` | 注册后若工作簿已初始化则立即挂载 |

---

## 9. 编写第一个插件

下面实现一个 **单元格编辑日志插件**，记录所有单元格变更并提供查询接口。

```js
// src/plugins/CellChangeLogPlugin.js

/**
 * 单元格变更日志插件
 * 记录所有 cell-change，提供历史查询与导出，并通过共享状态暴露 API。
 */
export class CellChangeLogPlugin {
  name = 'CellChangeLog';
  version = '1.0.0';
  description = '记录所有单元格变更历史';
  dependencies = [];

  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this._log = [];
    this._unsubs = [];
    this._workbook = null;
    this._registry = null;
  }

  // ① 最早时机：暴露 API，读取配置
  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
    registry.setSharedState('cellChangeLog:getLog', () => this.getLog());
    registry.setSharedState('cellChangeLog:clear', () => this.clear());
  }

  // ② 工作簿就绪：绑定监听
  onMounted(workbook) {
    const unsub = workbook.on('cell-change', (data) => this._record(data));
    this._unsubs.push(unsub);
  }

  _record({ r, c, oldValue, newValue }) {
    this._log.push({ r, c, oldValue, newValue, t: Date.now() });
    if (this._log.length > this.maxSize) this._log.shift();
  }

  getLog() {
    return [...this._log];
  }

  clear() {
    this._log = [];
  }

  // ③ 卸载：清理所有副作用
  onUnmount() {
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    this._registry?.deleteSharedState('cellChangeLog:getLog');
    this._registry?.deleteSharedState('cellChangeLog:clear');
    this._log = [];
  }

  // 插件内部错误处理（可选）
  onError(error) {
    console.error('[CellChangeLog] 错误:', error);
  }
}

export function createCellChangeLogPlugin(options = {}) {
  return new CellChangeLogPlugin(options);
}
```

使用：

```js
import { createCellChangeLogPlugin } from 'vue-canvas-sheet/plugins'; // 或本地路径

workbook.usePlugin(createCellChangeLogPlugin({ maxSize: 500 }));

// 编辑若干单元格后
const getLog = workbook.plugins.getSharedState('cellChangeLog:getLog');
console.table(getLog());

// 卸载
workbook.unusePlugin('CellChangeLog');
```

---

## 10. 进阶：懒加载与性能优化

注册中心内置 [PluginOptimizer](../src/core/plugin/PluginOptimizer.js)，提供钩子性能监控、热点钩子重排与插件懒加载。

### 懒加载

若插件定义了 `lazyLoad()` 方法，可延迟其重资源初始化：

```js
export class HeavyPlugin {
  name = 'Heavy';
  async lazyLoad() {
    this._engine = await import('./heavy-engine.js'); // 按需加载大依赖
  }
}

// 触发懒加载
await workbook.plugins.optimizer.lazyLoad('Heavy');
await workbook.plugins.optimizer.batchLazyLoad(['Heavy', 'Other']);
```

### 钩子性能监控与重排

每个通过 `registry.on` 注册的钩子都会被 `optimizer.monitorHook` 包装，统计调用次数与平均耗时。

```js
// 触发热点钩子重排（将快速处理器排到前面）
workbook.plugins.optimizeHooks();

// 获取性能报告
const report = workbook.plugins.getPerformanceReport();
// {
//   hooks: { 'cell-change': { count, totalTime, avgTime }, ... },
//   summary: { totalCalls, totalTime, slowestHooks: [{ name, avgTime }] }
// }
```

判定为“热点钩子”的条件：每分钟触发 > 100 次且平均耗时 > 1ms（见 [PluginOptimizer.js:33](../src/core/plugin/PluginOptimizer.js#L33)）。

> 编写高频钩子（如 `cell-change`、`selection-change`）时，务必保持处理器轻量，避免同步重计算；必要的重活应防抖/节流或丢到 `requestIdleCallback` / Worker。

---

## 11. 内置插件参考

位于 [src/plugins/](../src/plugins/)，均从 [src/plugins/index.js](../src/plugins/index.js) 导出（类 + `createXxx` 工厂）：

| 插件 | name | 说明 | 关键选项 |
|------|------|------|---------|
| [AutoSavePlugin](../src/plugins/AutoSavePlugin.js) | `AutoSave` | 自动保存到 IndexedDB diff（localStorage 降级） | `backend`、`interval`、`debounce`、`events`、`sheetId` |
| [SelectionHistoryPlugin](../src/plugins/SelectionHistoryPlugin.js) | `SelectionHistory` | 选区历史前进/后退 | `maxSize` |
| [CollaborativeCursorPlugin](../src/plugins/CollaborativeCursorPlugin.js) | `CollaborativeCursor` | 协同光标显示 | — |
| [RealtimeCollaborationPlugin](../src/plugins/RealtimeCollaborationPlugin.js) | `RealtimeCollaboration` | 实时协同编辑 | — |
| [ExportPlugin](../src/plugins/ExportPlugin.js) | `Export` | 导出 xlsx/csv 等 | — |
| [ImportPlugin](../src/plugins/ImportPlugin.js) | `Import` | 导入 xlsx/csv 等 | — |

建议把内置插件当作模板。`AutoSavePlugin` 是“事件驱动 + 定时 + 防抖 + 共享状态 + 错误降级”的完整范例；`SelectionHistoryPlugin` 是“监听单一事件 + 暴露 API”的最小范例。

---

## 12. 最佳实践

1. **`name` 全局唯一**：使用有辨识度的名称，避免与内置插件（`AutoSave`、`Export` 等）冲突。
2. **职责单一**：一个插件只做一件事，跨插件协作用 `dependencies` + 共享状态。
3. **`onInit` 轻、`onMounted` 重**：`onInit` 只做注册/读配置；真正访问工作簿数据、绑监听放在 `onMounted`。
4. **对称清理**：`onMounted` 中每建立一个副作用，`onUnmount` 中就要有对应的清理（订阅、定时器、共享状态、连接）。
5. **共享状态加命名空间**：`插件名:键`，卸载时全部 `deleteSharedState`。
6. **高频钩子保持轻量**：`cell-change`/`selection-change` 处理器中避免重计算，使用防抖/节流。
7. **防重入**：会回写工作簿（如 `setSelection`）的插件要用标志位防止事件循环（参考 `SelectionHistoryPlugin._isNavigating`）。
8. **错误隔离**：钩子内部错误会被注册中心 `try/catch` 吞掉并打印；关键路径自行 `try/catch` 并实现 `onError`。
9. **导出工厂函数**：同时导出类与 `createXxxPlugin(options)`。
10. **版本号**：填写 `version`，便于 `getPluginInfo()` 排查。

---

## 13. 调试与排错

| 现象 | 原因 | 解决 |
|------|------|------|
| `Plugin must have a name property` | 缺少 `name` | 补充唯一 `name` |
| `Plugin "X" is already registered` | 重复注册 | 先 `unusePlugin('X')` 或改名 |
| `Plugin "X" requires plugins: Y` | 依赖未注册 | 先注册依赖 `Y` |
| `Cannot unregister "X", required by: Z` | 被其他插件依赖 | 先卸载依赖方 `Z` |
| 钩子不触发 | 在 `onInit` 而非 `onMounted` 绑定，或工作簿未 `init` | 改到 `onMounted`；确认 `workbook` 已就绪 |
| 卸载后仍有回调 | 未清理 `workbook.on` 订阅/定时器 | 在 `onUnmount` 中清理 |

排查工具：

```js
workbook.plugins.getPluginInfo();        // 已注册插件与挂载状态
workbook.plugins.isMounted('MyPlugin');  // 是否已挂载
workbook.plugins.getPerformanceReport(); // 钩子性能
workbook.getErrorHistory();              // 工作簿错误历史
```

---

## 14. 发布插件

### 作为独立 npm 包

1. 插件包 `peerDependencies` 声明 `"vue-canvas-sheet": "^x.y.z"`，避免重复打包核心。
2. 仅 `import` 类型/常量（如 `createPlugin`、`HookTypes`）来自 `vue-canvas-sheet/core`，运行时通过传入的 `workbook`/`registry` 操作，不要硬依赖内部路径。
3. 同时导出类与工厂函数，并提供 `.d.ts` 类型（可参考 [types/index.d.ts](../types/index.d.ts)）。

```js
// my-sheet-plugin/index.js
import { HookTypes } from 'vue-canvas-sheet/core';
export class MyPlugin { /* ... */ }
export function createMyPlugin(options) { return new MyPlugin(options); }
```

使用方：

```js
import { Workbook } from 'vue-canvas-sheet/core';
import { createMyPlugin } from 'my-sheet-plugin';

const wb = new Workbook(/* ... */);
wb.usePlugin(createMyPlugin({ /* options */ }));
```

### 贡献到本仓库

1. 新增文件 `src/plugins/MyPlugin.js`，遵循类 + 工厂的约定。
2. 在 [src/plugins/index.js](../src/plugins/index.js) 中导出。
3. 在 `tests/` 下补充单测（`npm test`）。
4. 更新本文档「内置插件参考」表格。

---

## 附：最小可运行示例

```js
import { Workbook } from 'vue-canvas-sheet/core';

const wb = new Workbook();

wb.usePlugin({
  name: 'HelloPlugin',
  version: '1.0.0',
  hooks: {
    'cell-change'(data) {
      console.log(`单元格 (${data.r}, ${data.c}) 由 ${data.oldValue} → ${data.newValue}`);
    }
  },
  onMounted(workbook) {
    console.log('HelloPlugin 已挂载');
  },
  onUnmount() {
    console.log('HelloPlugin 已卸载');
  }
});

wb.setCell(0, 0, { v: 'Hello' }); // 控制台输出变更日志
wb.unusePlugin('HelloPlugin');
```
