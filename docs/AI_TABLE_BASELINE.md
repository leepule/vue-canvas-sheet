# AI 表格组件测试基线

对应 [实施方案](./AI_TABLE_IMPLEMENTATION_PLAN.md) 的步骤 01 / T01。本轮只新增测试夹具、夹具测试和文档，未修改业务代码。

## 1. 记录环境

| 项目 | 实测值 |
| --- | --- |
| 日期与时区 | 2026-09-14，Asia/Shanghai（UTC+08:00） |
| 开发分支 | `feature/ai-sheet-app` |
| HEAD | `c2bfdad98e8942326841f88087da63ab44cc8875` |
| 系统 | darwin / arm64，Darwin 24.6.0 |
| Node.js | v22.23.2 |
| Vitest | 3.2.4 |

基线在新增夹具前运行，工作区当时已有未提交的产品方案、实施方案和文档导航改动；这些改动均保留，未创建分支、重置工作区或提交。

## 2. 固定输入

夹具文件：[tests/fixtures/ai-orders.js](../tests/fixtures/ai-orders.js)。

```js
export function createOrdersFixture() {
  return [
    ['单价', '数量', '销售额'],
    [10, 2, null],
    [5, 3, null],
    [8, 4, null]
  ];
}
```

| 工厂 | 与基础数据的区别 | 后续用途 |
| --- | --- | --- |
| `createOrdersFixture()` | 无；C2:C4 均为 `null` | 正常公式生成、预览、应用与撤销 |
| `createOrdersWithExistingTargetFixture()` | 仅 C2 为 `999` | 验证已有值保护与覆盖确认 |
| `createOrdersWithMissingPriceFixture()` | 仅 A2 为 `null` | 验证缺失输入提示，不静默转成零 |
| `createOrdersWithStyledTargetFixture()` | C2:C4 为带独立样式的空单元格对象 | 验证后续写入、撤销与回滚的格式保留 |

带格式单元格使用现有数据结构：

```js
{
  v: null,
  s: {
    fmt: 'comma',
    decimals: 2,
    border: {
      bottom: { color: '#333333', style: 'solid' }
    }
  }
```

每次调用都会创建新数组和新行；带格式场景的单元格、样式及嵌套边框对象也不在行间或调用间共享。

正常输入的统一结果为 C2:C4 的数值 `20、15、32`，对应公式为 `=A2*B2`、`=A3*B3`、`=A4*B4`。目标已有值场景不能默认覆盖；空单价场景不能直接套用正常结果，这两种行为留待后续步骤验收。

## 3. 新增前基线

在仓库根目录执行用户指定命令：

```bash
npm test -- tests/core/Workbook.spec.js tests/core/History.spec.js tests/core/WorkbookSheets.spec.js tests/core/ImportPlugin.spec.js tests/core/ExportPluginCSV.spec.js
```

运行开始时间：2026-09-14 17:27:17。Vitest 总耗时：1.21s。

| 测试文件 | 范围 | 通过 | 失败 |
| --- | --- | --- | --- |
| `tests/core/Workbook.spec.js` | Workbook 核心行为 | 157 | 0 |
| `tests/core/History.spec.js` | 历史、撤销与重做 | 20 | 0 |
| `tests/core/WorkbookSheets.spec.js` | 多 Sheet | 10 | 0 |
| `tests/core/ImportPlugin.spec.js` | 导入插件 | 3 | 0 |
| `tests/core/ExportPluginCSV.spec.js` | CSV 导出 | 16 | 0 |
| **合计** | **5 个文件** | **206** | **0** |

结论：指定范围内无已有失败。后续在同一基准与环境下出现失败时，应作为待调查的新增回归，不能归为本次已知失败。

## 4. 新增后复验

新增测试：[tests/fixtures/ai-orders.spec.js](../tests/fixtures/ai-orders.spec.js)，共 11 项：

- 四组夹具的固定内容：4 项。
- 四个工厂返回的数组和行互不共享：4 项。
- 带格式单元格及嵌套样式在行间、调用间互不共享：1 项。
- 基础、带格式两组数据通过现有 Workbook 计算得到 `20、15、32`：2 项。

```bash
npm test -- tests/core/Workbook.spec.js tests/core/History.spec.js tests/core/WorkbookSheets.spec.js tests/core/ImportPlugin.spec.js tests/core/ExportPluginCSV.spec.js tests/fixtures/ai-orders.spec.js
```

运行开始时间：2026-09-14 17:35:05。Vitest 总耗时：2.66s。

| 范围 | 文件数 | 通过 | 失败 |
| --- | --- | --- | --- |
| 原有基线 | 5 | 206 | 0 |
| 新增夹具测试 | 1 | 11 | 0 |
| **合计** | **6** | **217** | **0** |

两次命令均正常结束。指定原有测试无新增失败，新增夹具测试全部通过。耗时仅为本次运行记录，不是性能验收指标。

## 5. 日志与覆盖边界

- 原有测试会输出非法 JSON / merge 输入对应的 `DATA_LOAD_ERROR`、循环引用 DEBUG 和 Worker 不支持提示；对应断言均通过，不属于测试失败。
- 既有 [tests/setup.js](../tests/setup.js) 使用 Worker、Canvas、IndexedDB 等测试替身；本轮结果不代表真实浏览器渲染、Worker 或 WASM 已验收。
- 新增计算测试显式关闭 WASM，使用 `recalcAll({ useWorker: false })`，结束后销毁 Workbook。
- 带格式夹具测试验证的是输入结构、对象隔离和公式数值结果，未验证后续 AI 写入保留样式、原子回滚或一次撤销。
- 尚未实现 AI 计划、已有值保护、缺失值策略、应用层导入导出或多 Sheet 写入保护；原有组件测试通过不等于这些能力已完成。
- 未运行全量测试、E2E、真实模型调用、依赖安装、开发服务或构建。导入导出结论仅限本次指定的两个测试文件，不涵盖完整 XLSX 往返验收。

## 6. T01 完成记录

- 四组固定输入已建立，调用间不共享可变对象。
- 正常输入的 C2:C4 公式结果已验证为 `20、15、32`。
- 新增前 206 项与新增后 217 项结果已分别记录，均无失败。
- 保留 `feature/ai-sheet-app` 和原有未提交文档；未修改业务代码。
- 本轮止于步骤 01，步骤 02 及后续任务仍待实施。
