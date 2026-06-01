# Vue Canvas Sheet 文档

> 基于 Canvas 渲染、WASM 加速公式计算的高性能 Vue 3 表格组件。本目录为全部文档的导航入口。

## 📚 文档导航

| 文档 | 内容 | 适合 |
|------|------|------|
| [使用文档 USAGE](./USAGE.md) | 安装、快速开始、组件 Props / 方法 / 插槽、数据格式、懒加载、持久化、协同、导入导出、FAQ | 第一次接入，先读这篇 |
| [包导出总览 API_OVERVIEW](./API_OVERVIEW.md) | 三个入口（主入口 / `core` / `render`）的完整导出清单与类型索引 | 想知道“包里到底有什么” |
| [Workbook API](./WORKBOOK_API.md) | 核心引擎 `Workbook` 的全部属性与方法参考 | 直接操作数据引擎 |
| [插件开发 PLUGIN_DEVELOPMENT](./PLUGIN_DEVELOPMENT.md) | 插件架构、生命周期、钩子系统、共享状态、内置插件、自定义插件 | 开发/定制插件 |
| [公式 formulas](./FORMULAS.md) | 支持的公式函数与语法 | 编写公式 |

## 🚀 快速上手

```bash
npm install vue-canvas-sheet
```

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
];
</script>
```

更多见 [使用文档](./USAGE.md)。

## 🧭 按场景索引

- **只用组件** → [USAGE](./USAGE.md)
- **无头引擎 / 自定义 UI** → [API_OVERVIEW §二](./API_OVERVIEW.md#二vue-canvas-sheetcore) + [Workbook API](./WORKBOOK_API.md)
- **自建渲染层** → [API_OVERVIEW §三](./API_OVERVIEW.md#三vue-canvas-sheetrender)
- **写插件 / 扩展能力** → [PLUGIN_DEVELOPMENT](./PLUGIN_DEVELOPMENT.md)
- **TypeScript 类型** → [types/index.d.ts](../types/index.d.ts)

## 🔗 其他

- 项目主页：[../readme.md](../readme.md) ｜ [中文 README](../README_zh.md)
- 在线 Demo：[../samples/basic-usage](../samples/basic-usage)
