# AI 表格 Web 应用具体实施方案

- 编写日期：2026-09-14。
- 开发分支：`feature/ai-sheet-app`。
- 对应产品方案：[AI_TABLE_PRODUCT_PLAN.md](./AI_TABLE_PRODUCT_PLAN.md)。
- 状态：步骤 01–10 已完成并通过专项验证，步骤 12 的 DeepSeek 直连 Provider 已完成代码接入与离线测试；其中原子补丁专项 14 项、API 专项 27 项、只读预览专项 15 项、确认写入专项 5 项和 AI 面板专项 6 项通过，指定组合回归 152 项通过；Mock Provider 已删除，全量检查仍有 6 项协作服务测试待复验，DeepSeek 真实调用待本地人工验收；步骤 11、13–18 待实施。未标记完成的能力不代表已经验收。
- 原则：保留 `vue-canvas-sheet` 组件库，新增独立 Web 应用；AI 负责生成计划，受控代码负责执行。

## 0. 从这里开始：具体执行步骤

先按本节顺序开发，第 1–15 节作为遇到接口和边界问题时的设计参考，不需要先实现所有模块。

**当前进度：第一轮步骤 01–04 已验收。步骤 05 已实现内容修订号；步骤 06 已实现公式检查和平移；步骤 07 已实现 `applyCellPatch()` 原子补丁；步骤 08 已实现 AI API 服务，Mock 实现已删除；步骤 09 已实现真实选区上下文、可信信封比对、公式平移、临时 Workbook 预演和只读预览；步骤 10 已实现 AI 面板、任务状态、确认写入、撤销和重做；步骤 12 已实现 DeepSeek 直连 Provider，默认官方地址 `https://api.deepseek.com`。指定组合回归 152 项通过，相关核心回归 242 项通过；API 27 项、协议 72 项、Web 41 项、核心补丁/历史回归 34 项和运行时导出检查通过。根目录全量测试 978 项通过、6 项协作服务启动失败；沙箱外复验审批未获执行。尚未进入本地文档保存与导入，DeepSeek 真实调用待人工验收。**

本节的路径相对仓库根目录。步骤 01 的测试结果见 [测试基线](./AI_TABLE_BASELINE.md)，步骤 02–04 的检查见各自实施记录；未注明已执行的命令仍为后续验证命令。

### 步骤 01：固定测试数据，记录组件基线

对应任务：T01。

**状态：已完成（2026-09-14）。** 原有 206 项基线全部通过；新增 11 项夹具测试后，6 个文件共 217 项全部通过。

**涉及文件：** 新建 [tests/fixtures/ai-orders.js](../tests/fixtures/ai-orders.js)、[tests/fixtures/ai-orders.spec.js](../tests/fixtures/ai-orders.spec.js) 和 [测试基线记录](./AI_TABLE_BASELINE.md)，未修改业务代码。

1. 定义一个返回新数组的 `createOrdersFixture()`，数据如下，避免测试之间共享可变对象。
2. 准备另外三组数据：目标格已有值、单价为空、目标格带格式。
3. 记录现有 Workbook、历史、多 Sheet、导入导出测试结果，区分已有失败和后续新增失败。
4. 保留当前 `feature/ai-sheet-app` 分支及未提交文档，不重新创建分支，不重置工作区。

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

验证命令：

```bash
npm test -- tests/core/Workbook.spec.js tests/core/History.spec.js tests/core/WorkbookSheets.spec.js tests/core/ImportPlugin.spec.js tests/core/ExportPluginCSV.spec.js
```

**完成标准：** 有固定输入和已记录的测试基线；预期结果统一为 C2:C4 的 `20、15、32`。

### 步骤 02：建立三个 workspace，保留根组件包

对应任务：T02。

**状态：已完成（2026-09-15）。** 三个 workspace 已被 npm 识别，清单和独立测试配置已检查；本步验收时尚未安装依赖或执行新包测试，Web 测试已在步骤 03 补齐并通过。

**涉及文件：** 根 [package.json](../package.json)，以及下面三个新的 `package.json` 和各自的 `vitest.config.js`。

| 文件 | `name` | 基础字段 |
| --- | --- | --- |
| `apps/ai-web/package.json` | `@ai-sheet/web` | `version: "0.0.0"`、`private: true`、`type: "module"` |
| `apps/ai-api/package.json` | `@ai-sheet/api` | 同上 |
| `packages/ai-contracts/package.json` | `@ai-sheet/contracts` | 同上，并设置 `exports: "./src/index.js"` |

1. 在根 `package.json` 合并以下配置，不替换原有 `name`、`exports`、`files` 和脚本。
2. 三个子包均添加 `test` 脚本：`vitest run --config vitest.config.js`。
3. Web 子包添加 `dev: "vite"`；API 子包添加 `dev: "node --watch src/server.js"`。这些启动脚本由本地使用。
4. Web 声明 `vue`、`vue-router` 和 `vue-canvas-sheet: "file:../.."`；前后端都声明本地 `@ai-sheet/contracts` 依赖。
5. Web 的 Vue、Vite、Vue 插件、Vitest、jsdom 和 Sass 优先沿用根包已有版本；API 增加 Fastify，contracts 增加 Zod，API 和 contracts 各声明 Vitest 开发依赖。后续用到 `idb` 等依赖时再加。
6. 创建各子包的 `vitest.config.js`，仅收集本包 `tests/**/*.spec.js`。Web 使用 jsdom，API 和 contracts 使用 node 环境。
7. 三个清单都存在后，由本地在仓库根目录运行一次 `npm install`，只维护根锁文件。

根配置补充：

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "test:ai:web": "npm run test --workspace @ai-sheet/web",
    "test:ai:api": "npm run test --workspace @ai-sheet/api",
    "test:ai:contracts": "npm run test --workspace @ai-sheet/contracts"
  }
}
```

**完成标准：** 三个 workspace 可被 npm 识别；原组件的包名、发布入口和发布文件范围保持不变。测试脚本先配置好，后续创建测试用例后再验证。

**本步完成记录：**

- 三个包均为私有 ESM 包，版本为 `0.0.0`；Web/API 通过 `file:../../packages/ai-contracts` 引用协议包，Web 通过 `file:../..` 引用根组件包。
- Web 的 Vue、Vite、Vue 插件、Vitest、jsdom、Sass 版本范围与根包一致；新增 Vue Router `^4.5.0`、Fastify `^5.0.0` 和 Zod `^4.0.0`。
- 三个测试配置均将 `root` 固定为自身目录，只收集本包 `tests/**/*.spec.js`。Web 使用 jsdom 和 Vue 插件；API、contracts 使用 node，不继承根组件的构建配置或测试替身。
- 通过 JSON 结构比较确认：根清单仅新增 `workspaces` 和三个 `test:ai:*` 脚本，原有全部字段与脚本不变；步骤 02 首次验收时根锁文件未修改，后续依赖已统一记录在根锁文件，子包没有独立锁文件。
- 使用现有依赖动态加载三个测试配置，清单字段、本地依赖路径、版本复用、测试环境与收集范围均检查通过。

已执行的 npm 检查：

```bash
npm pkg get name version private type --workspaces --json
npm pack --dry-run --json --ignore-scripts --workspaces=false
```

第一条返回 `@ai-sheet/web`、`@ai-sheet/api`、`@ai-sheet/contracts`。第二条只预览根组件发布清单，不运行生命周期脚本，不构建、不发布，也不生成压缩包。

npm 10.9.8 的打包预检查在改动前后分别列出 33、32 个文件：唯一减少的是 `src/wasm/pkg/.gitignore`，组件入口、类型、CSS、Worker 和 WASM 文件保持不变，未包含三个子包。根 `files` 白名单未改动；此处记录实际打包差异，不将“发布配置不变”误写成“文件清单逐项完全相同”。

**依赖复核（2026-09-15）：** 当前三个 workspace 的直接依赖均可由 npm 识别，根 `package-lock.json` 已记录 workspace 链接及 Zod `4.6.5`，子包没有独立锁文件。步骤 08 只复用已安装的 Fastify，未重新安装或改动锁文件；Web、contracts 与 API 测试均已通过。

### 步骤 03：让独立 Web 应用先显示现有表格

对应任务：T02、T05。

**状态：已完成（2026-09-15）。** 用户确认本步骤已在本地验证通过；应用测试与相关组件回归也复验通过。页面验收依据用户确认，代理未执行开发服务或构建，不将 jsdom 检查记为真实 Canvas 验收。

**新建文件：**

- `apps/ai-web/index.html`、`apps/ai-web/src/main.js`、`apps/ai-web/src/App.vue`。
- `apps/ai-web/src/views/WorkspaceView.vue`。
- `apps/ai-web/src/components/WorkbookHost.vue`。
- `apps/ai-web/vite.config.js`。

1. `index.html` 提供 `#app`，`main.js` 挂载 Vue，`App.vue` 先只渲染 `WorkspaceView`。
2. `WorkspaceView` 使用左右布局：左边编辑器，右边预留 360px 的 AI 区域，不先做登录和文档列表。
3. `WorkbookHost` 引入 `TableDesigner`，通过 prop 接收步骤 01 的订单数据，给父容器明确高度和 `min-height: 0`。
4. 设置 `enablePersistence: false`，暂不注入 AutoSavePlugin。通过组件 ref 获取 Workbook。
5. 应用 Vite 配置只使用 Vue 插件和应用构建，不继承根配置的 `build.lib`。
6. Web 默认端口设为 `8890`，`/api` 代理到 `http://127.0.0.1:8891`；配置 `worker.format: "es"` 和 Vue 去重。
7. 为下列导入配置精确匹配的源码 alias。源码模式由 Vue SFC 加载样式；包产物接入测试时才按包契约加载 `vue-canvas-sheet/style.css`。

| 导入 | 源码目标 |
| --- | --- |
| `vue-canvas-sheet` | 根 `src/index.js` |
| `vue-canvas-sheet/core` | 根 `src/core/index.js` |
| `vue-canvas-sheet/plugins` | 根 `src/plugins/index.js` |
| `vue-canvas-sheet/wasm` | 根 `src/wasm/pkg/table_wasm_engine.js` |

**验证：** 添加 `apps/ai-web/tests/WorkbookHost.spec.js`；组件测试检查接入和清理，实际 Canvas 由本地启动后的页面验证。

**完成标准：** 独立页面显示订单表，能手动编辑 A2；原有组件示例入口仍可使用。

**本步实施记录：**

- [WorkspaceView.vue](../apps/ai-web/src/views/WorkspaceView.vue) 每次挂载调用 `createOrdersFixture()`，首屏直接显示订单工作台；桌面右侧保留 360px AI 区域，宽度不超过 960px 时暂时隐藏空白区域，不添加登录、文档列表或不可用的 AI 操作按钮。
- [WorkbookHost.vue](../apps/ai-web/src/components/WorkbookHost.vue) 按原组件契约传递 `initialData`，显式关闭持久化，不注入插件；通过公开的 `getWorkbook()` 返回组件 ref 上的 Workbook，未挂载或卸载后返回 `null`。
- Workbook 仍由 `TableDesigner` 创建和关闭，宿主不重复调用 `close()` / `destroy()`，不向 `window` 暴露实例。
- [vite.config.js](../apps/ai-web/vite.config.js) 使用独立应用根目录、Vue 插件、Vue 去重、ES Worker、8890 端口和 8891 API 代理；四个包入口精确匹配源码，另补 `@/` 前缀以支持原组件内部导入，不修改根配置。
- 应用沿用原组件的跨源隔离响应头；样式由 Vue SFC 加载，没有引入尚未构建的 `vue-canvas-sheet/style.css`。
- [vitest.config.js](../apps/ai-web/vitest.config.js) 复用应用解析配置，仍只收集本包测试，不继承根组件的库构建设置或全局测试替身。

已执行：

```bash
npm run test:ai:web
npm test -- tests/components/TableDesignerWatchers.spec.js tests/components/CanvasTableCleanup.spec.js tests/fixtures/ai-orders.spec.js
```

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 应用测试 | 2 个文件，15 项通过 | [WorkbookHost.spec.js](../apps/ai-web/tests/WorkbookHost.spec.js) 7 项，[ViteConfig.spec.js](../apps/ai-web/tests/ViteConfig.spec.js) 8 项 |
| 原组件回归 | 3 个文件，26 项通过 | 数据重载、组件卸载、多实例、订单夹具 |
| 原组件文件检查 | 步骤 03 验收时无改动 | 根 `src`、`types`、`vite.config.js` 和 `samples/basic-usage`；根锁文件的依赖更新见步骤 02 复核记录，后续核心修改见步骤 05 |

应用测试挂载真实 `TableDesigner` 和 Workbook，只替换 Canvas 绘制组件，验证固定输入、关闭持久化、无自动保存插件、通过 Workbook API 修改 A2、数据引用更新、单次关闭与重挂载隔离。测试环境的 Worker 不支持提示是预期日志，不是失败；这些自动化结果本身不代表 Canvas 像素、鼠标输入、实际 Worker 或 WASM 已验收，页面检查以用户的本地验收为依据。

**本地验收清单（用户已确认本步骤通过）：**

1. 在仓库根目录执行 `npm run dev --workspace @ai-sheet/web`，默认打开 [http://127.0.0.1:8890](http://127.0.0.1:8890)；端口占用时以 Vite 输出为准。当前空白 AI 区域不需要启动 API。
2. 确认 Canvas 非空，A1:C4 显示固定订单，C2:C4 保持为空。
3. 双击 A2，将 10 改成 12 并回车，确认显示 12；点击原工具栏撤销后恢复 10。
4. 检查桌面右侧 AI 区域与表格不重叠；窄屏隐藏空白 AI 区域后，表格和工具栏仍可用。
5. 按既有方式启动原组件示例，确认渲染和编辑未受影响。本清单保留供后续页面回归使用。

### 步骤 04：写死一个 AI 返回结果，再定义共享协议

对应任务：T03。

**状态：已完成（2026-09-15）。** 当前已安装 Zod `4.6.5`；`npm run test:ai:contracts` 复验为 1 个文件、72 项用例全部通过。此前缺少 `zod` 的测试收集失败已解除，本轮未重新安装依赖或修改协议代码。

**新建文件：**

- `packages/ai-contracts/src/index.js`、`packages/ai-contracts/src/context.js`、`packages/ai-contracts/src/plan.js`。
- `packages/ai-contracts/src/events.js`、`packages/ai-contracts/src/errors.js`。
- `packages/ai-contracts/tests/plan.spec.js`、`packages/ai-contracts/tests/fixtures/formula-plan.json`。

1. 把第 6.3 节中的完整计划作为 `formula-plan.json`，目标固定为 C2:C4，起始公式为 `=A2*B2`。
2. 在 `context.js` 定义整数坐标、矩形范围、文档 ID、Sheet ID、修订号和授权范围 Schema。
3. 在 `plan.js` 定义严格的 `plan` 与 `requires_input` 两种返回类型。当前只开放 `fill_formula`。
4. 在 `events.js` 定义生成中、计划就绪、取消和失败事件；`errors.js` 定义稳定错误码；`index.js` 统一导出。
5. 写五类失败用例：负坐标、未知操作、未知字段、目标越权、伪造请求信封。语法校验与授权校验分开测试。

验证命令：`npm run test:ai:contracts`。

**完成标准：** 固定计划通过校验；错误计划在进入表格之前被拒绝。到这里仍不调用模型、不自动改表。

**本步实施记录：**

- [formula-plan.json](../packages/ai-contracts/tests/fixtures/formula-plan.json) 与第 6.3 节完整计划逐字段一致，包括信封、C2:C4 目标、`=A2*B2` 和空警告数组。
- [context.js](../packages/ai-contracts/src/context.js) 定义零起始安全整数坐标、包含端点且有序的矩形、非空 ID、epoch、内容修订号、读写授权范围与完整信封。没有类型强制转换，不接受负数、小数或不安全整数。
- [plan.js](../packages/ai-contracts/src/plan.js) 使用严格对象定义 `plan` / `requires_input`。计划只允许一个 `fill_formula` 操作；澄清结果使用非空字符串数组 `questions`，不得携带 `operations`，即使是空操作数组。
- `validatePlanAuthorization(response, trustedEnvelope)` 与 Schema 分开导出；对照调用方独立保留的信封检查 run、文档、Sheet、epoch、版本及读写范围，再检查目标写入范围。调用方不得从响应自身提取所谓的可信信封。
- [events.js](../packages/ai-contracts/src/events.js) 定义 `status`（queued / generating / cancelled）、`plan_ready`、`requires_input` 和 `error` 事件。事件含正整数 `eventId`，结果事件通过 `result` 携带完整响应，其 run ID 必须与外层一致。事件顺序与状态转换由后续 RunService 管理。
- [errors.js](../packages/ai-contracts/src/errors.js) 定义第 8.3 节的 11 个稳定错误码及严格的 `{ code, message, retryable, requestId }` 传输结构。内部授权异常使用 `AIContractError`，API 层负责补充可信请求的 `requestId` 和安全消息，不直接透传异常对象或上游堆栈。
- [index.js](../packages/ai-contracts/src/index.js) 统一导出协议；运行代码只依赖 Zod，不导入 Workbook、Web UI、模型 SDK 或网络服务。

后续调用顺序：

```js
import {
  AIResponseSchema,
  validatePlanAuthorization
} from '@ai-sheet/contracts';

const response = AIResponseSchema.parse(decodedResult);
const scopedResponse = validatePlanAuthorization(response, trustedEnvelope);
```

`scopedResponse` 不是执行许可。当前只验证公式文本的类型、长度和 `=` 前缀，不解析或计算公式；实际引用、函数白名单、只读权限、非空目标保护和预演仍须按步骤 06、09、10 检查。尤其不能把响应中的 `allowedReadRanges` 与可信范围一致，误认为公式的实际依赖已经通过读取授权。

当前明确限制：每个计划最多写 5,000 格；种子必须位于目标左上角；目标必须完整落在一个写授权矩形内，不用多个授权的外接矩形放行，也不自动合并相邻授权。信封中的范围列表须按原顺序逐项一致。每种授权列表最多 32 个范围，ID 最多 128 字符，公式最多 4,096 字符，澄清问题最多 10 条，警告最多 20 条，每条文本最多 1,000 字符。传输请求体和实际读取规模限制仍由后续 API / 引擎检查。

**验证记录：**

| 检查 | 结果 |
| --- | --- |
| 5 个协议模块和测试文件的 `node --check` | 6 个 JavaScript 文件语法检查通过 |
| 计划夹具与第 6.3 节 JSON 比较 | 完全一致 |
| 格式检查 | 通过 |
| `npm run test:ai:contracts` | 1 个文件，72 项通过 |
| Node 直接导入 `@ai-sheet/contracts` | 公共 ESM 入口可解析，固定计划通过 Schema 校验 |
| `npm ls --workspaces --depth=0` 与根锁文件复核 | 三个 workspace 的直接依赖已安装；Zod 为 `4.6.5`，锁文件记录一致，无子包锁文件 |
| `npm run test:ai:web` | 2 个文件，15 项通过 |
| 步骤 01 的五个原组件基线文件 | 5 个文件，206 项通过 |
| 步骤 03 的接入与夹具回归 | 3 个文件，26 项通过 |
| 根组件兼容性静态检查 | 步骤 04 复验时原清单字段、原脚本、组件源码、类型、根 Vite 配置和原示例均未改变 |

[plan.spec.js](../packages/ai-contracts/tests/plan.spec.js) 中五类失败输入，以及空澄清、未知嵌套字段、单次操作限制、写入上限、授权空隙、旧版本、事件一致性和错误结构检查均通过。授权测试先断言输入语法合法，再验证其不能越过独立信封；语法校验与授权校验分别覆盖。

步骤 04 复验时四组自动化测试共 11 个文件、319 项通过，无新增失败。此前缺少 Zod 属于依赖未就绪导致的收集失败；该次使用已安装的真实依赖复验，没有替代 Zod、跳过用例或关闭严格校验。当次仅更新验收文档，保留当前分支、已有未提交内容及根锁文件，不调用模型、启动 API、向实际页面写表、运行开发服务或构建。

**第一轮到此结束：应交付一个能显示表格的独立页面、一套共享协议和确定性的计划夹具。**

第一轮验收已完成：步骤 03 的页面由用户确认本地验证通过，步骤 04 的协议测试与确定性计划夹具通过。此处仅验收独立页面和共享协议，不代表公式预览、确认写入、DeepSeek Provider 或完整 M1 工作流已实现。

### 步骤 05：先实现内容修订号

对应任务：T04 的第一部分。

**状态：实现与专项验证完成，全量回归保留待复验项（2026-09-15）。** 新增 99 项修订号测试全部通过；相关核心、组件和夹具共 527 项通过。根目录全量测试 945 项通过，另 6 项因协作测试服务未启动而失败；沙箱外复验因审批服务限流未获执行，不能标记全量通过。

**修改文件：** `src/core/Workbook.js`、`src/core/builder/WorkbookBuilder.js`、各修改入口所属管理器、`types/core.d.ts`。

1. 在 Workbook 实例上新增独立内容修订号和 `getContentRevision()`，不要放进会随 Sheet 切换恢复的 `dataVersion`。
2. 增加一个内部提交入口，统一推进修订号并发出 `mutation-committed`。
3. 依次接入普通写入、批量写入、样式、合并、行列结构、行高列宽、冻结、批注、导入、Sheet 新增删除重命名、撤销和重做，覆盖需要持久化的修改。
4. 批量操作结束后只提交一次；公式缓存回填、选区移动和滚动不计为内容编辑。
5. 为导入、重新加载和切 Sheet 预留应用侧 `documentEpoch` 失效处理。

**验证文件：** `tests/core/WorkbookRevision.spec.js`。逐个修改入口断言版本增加，再断言移动选区不增加、切表后版本不倒退。

**完成标准：** 不存在“用户改过表但版本没变”的已开放写入路径。未通过前不进入确认写入流程。

**本步实施记录：**

- [Workbook.js](../src/core/Workbook.js) 新增 `getContentRevision()`，从 `0` 开始；内容版本不进入 Sheet 状态或 JSON，切表、导入与撤销不恢复旧值。
- `_recordContentMutation()` 记录修改，`_commitContentMutation()` 统一推进版本并发出 `mutation-committed`。事件携带前后版本、实例内 mutation ID、受影响 Sheet、来源和已触及坐标数；字段说明见 [Workbook API](./WORKBOOK_API.md#mutation-committed)。
- [WorkbookBuilder.js](../src/core/builder/WorkbookBuilder.js) 注入批次与记录回调；[SparseMatrix.js](../src/core/data/SparseMatrix.js) 跟踪实际矩阵写入，Store 订阅跟踪持久化配置。样式清空、表头数据原地更新、批注等非矩阵替换路径另行标记。
- 样式、合并、行列结构、剪贴板、查找替换、自动填充、尺寸、冻结、工作表增删改名、数据 setter、加载及存储恢复均已覆盖；直接调用公开管理器、Store 持久字段或矩阵写入方法也不会绕过版本。
- [History.js](../src/core/history/History.js) 和 [Store.js](../src/core/data/Store.js) 支持嵌套批次，只在最外层提交。历史的同格编辑合并不吞掉内容版本；`skipHistory` / `skipEvent` 的远程写入仍推进版本。数据重载保留 History 实例及其批次回调。
- 公式引擎未改动。JS 重算、Worker 结果回填、共享数值更新、选区、滚动、复制、保存状态与销毁均不计为内容编辑。
- 成功恢复快照只提交一次；失败且回滚成功的 `fromJSON()` 不提交。旧的非原子批量接口如中途失败并留下部分修改，仍提交版本以使旧预览失效，不将该行为称为原子写入。
- [core.d.ts](../types/core.d.ts) 与根类型入口补充 `ContentMutationEvent` 和方法、事件类型；根包发布入口、脚本、应用配置与锁文件未在本步改动。

**应用侧 `documentEpoch` 预留：**

1. 应用在更换 Workbook、导入、重新加载或恢复文档开始前更新 epoch，先使进行中的请求和预览失效。
2. 切 Sheet 使用既有 `sheet-change` 事件通知应用；即使内容修订号不变，旧 Sheet 的任务也必须失效。
3. `source: 'import'` 的提交事件和 `data-load` 提供加载完成后的补充通知。epoch 不写入核心 Workbook，也不从导入数据恢复。
4. 现有分帧导入不是原子事务，每个实际写入分片结束后更新版本；不跨 `await` 持有全局批次，不隐藏中途编辑。受控导入与应用锁仍留在后续步骤。

修订号是失效令牌，不是严格的数据差异计数，同值写入可保守递增。原有读取 API 返回的单元格引用不能直接修改，应通过写入 API 更新；本步未引入 Proxy 或全表内容扫描。内部批次不构成事务，也不意味着保存成功。

**验证记录：**

| 检查 | 结果 |
| --- | --- |
| 修改前相关基线 | 27 个文件，365 项通过 |
| `WorkbookRevision.spec.js` | 99 项通过；覆盖写入、嵌套批次、历史、跨表、导入回滚、异步读取及缓存排除 |
| 扩大后的相关回归 | 30 个文件，527 项通过，包含上述 99 项 |
| `npm run test:ai:web` | 2 个文件，15 项通过 |
| `npm run test:ai:contracts` | 1 个文件，72 项通过 |
| `npm run check:types:runtime` | 运行时导出及声明中的 Workbook 方法检查通过；未运行 TypeScript 编译器 |
| `npm test` | 70 个文件通过、1 个文件失败；945 项通过、6 项失败 |
| 全量中的性能及真实引擎检查 | 性能门禁、真实 WASM、Worker 测试通过 |
| `RealtimeCollaborationServer.spec.js` | 6 项均停在 `collab server did not start`，未进入业务断言；沙箱外复验审批限流，命令未执行 |

专项验证命令：

```bash
npm test -- tests/core/WorkbookRevision.spec.js
npm run test:ai:web
npm run test:ai:contracts
npm run check:types:runtime
```

需由本地执行或获得明确授权后复验的命令：

```bash
npm test -- tests/core/RealtimeCollaborationServer.spec.js
```

本步没有运行开发服务或构建，没有修改模型协议或实现确认写入；全量未通过项保持公开记录，不通过跳过用例来标记全绿。

### 步骤 06：实现公式检查和逐行平移

对应任务：T04 的第二部分。

**状态：已完成（2026-09-15）。** 19 项专项测试通过；`FormulaCompiler.spec.js`、`Workbook.spec.js`、`WorkbookRevision.spec.js` 联合回归共 330 项通过。

**修改文件：** `src/core/data/FormulaRPNEvaluator.js`、`src/core/Workbook.js`、`types/core.d.ts`。

1. 从现有共享解析逻辑提供 `inspectFormula()` 所需的函数、引用和语法错误信息。
2. 实现 `translateFormula(formula, { from, to })`，根据解析出的引用位置平移，不替换字符串字面量中的地址。
3. 对固定计划生成三条公式：`=A2*B2`、`=A3*B3`、`=A4*B4`。
4. 先拒绝跨 Sheet、未知函数、越界引用、时间变化函数和自定义函数；未通过测试的引用语法不放行。

**验证文件：** `tests/core/FormulaInspection.spec.js`。检查 C2 平移到 C4 的结果，检查字符串 `"A2"` 不被改写，以及非法公式被拒绝。

**完成标准：** 不依赖模型逐行生成公式，固定起始公式可以确定性地展开为目标列。循环依赖在完整预演中继续检查。

**实施记录：**

1. `Workbook.inspectFormula(formula)` 返回 `{ valid, functions, references, errors }`，复用共享 tokenizer、调度场解析和 A1 坐标转换；不执行公式、不读取单元格值、不推进内容修订号。
2. `Workbook.translateFormula(formula, { from, to })` 只按单元格/范围 token 的源码区间平移相对 A1 引用，保留空白和字符串字面量；起点、终点或平移结果越界时抛出 `FormulaInspectionError`，不返回部分结果。
3. M1 函数白名单为 `SUM`、`AVERAGE`、`MIN`、`MAX`、`COUNT`、`ROUND`、`IF`；其余内置函数返回 `UNSUPPORTED_FUNCTION`，未知函数返回 `UNKNOWN_FUNCTION`，`NOW`/`TODAY` 返回 `VOLATILE_FUNCTION`，已注册自定义函数返回 `CUSTOM_FUNCTION`。
4. 跨 Sheet 引用返回 `CROSS_SHEET_REFERENCE`；绝对/混合引用返回 `UNSUPPORTED_REFERENCE`；超过 1,048,576 行或 16,384 列返回 `REFERENCE_OUT_OF_RANGE`。
5. 公式语法检查补充 token 级表达式校验，拒绝多余操作数、缺失操作数、未闭合函数/括号和未测试字符。

**验证记录：**

| 检查 | 结果 |
| --- | --- |
| `npm test -- tests/core/FormulaInspection.spec.js` | 19 项通过 |
| `npm test -- tests/core/FormulaInspection.spec.js tests/core/FormulaCompiler.spec.js tests/core/Workbook.spec.js tests/core/WorkbookRevision.spec.js` | 4 个文件，330 项通过 |
| `npm test -- tests/core/Formula*.spec.js tests/core/IncrementalCalculation.spec.js tests/core/FormulaWorkerConcurrency.spec.js` | 4 个文件，112 项通过 |
| `npm run check:types:runtime` | 通过 |
| `npm test` | 71 个文件通过、1 个文件失败；964 项通过、6 项失败，失败仍为协作服务未启动 |

本步仍未做循环依赖预演、目标非空保护或确认写入；原子补丁提交能力由步骤 07 实现，循环依赖和授权预演仍留给后续步骤。

### 步骤 07：实现一次成功或完整失败的补丁写入

对应任务：T04 的第三部分。

**状态：已完成（2026-09-15）。** 14 项专项测试通过；步骤指定组合回归 4 个文件、152 项通过。

**修改文件：** `src/core/Workbook.js`、`src/core/history/History.js`、`src/core/history/CommandExecutor.js`、持久化及计算调度相关入口。

1. 实现第 5.1 节的 `applyCellPatch()`，先检查已成功的 mutation ID，再检查预期版本，确保重复请求不会被误当成新操作。
2. 检查当前 Sheet、只读状态、坐标、重复目标、旧值前置条件和大小限制；全部通过后才允许写入。
3. 提前深拷贝 `before/after`，准备计算、持久化、历史与通知的提交或恢复状态。
4. 暂缓中间通知与异步副作用，同步应用整组补丁；任何单元格写入失败都恢复之前状态。
5. 成功后只记录一条 `batch-set-cell` 历史，推进一次内容修订号，再恢复计算和保存调度。
6. 保留现有 `bulkSetCells()` 的公共行为，不将它直接改造成另一套接口。

**验证文件：** `tests/core/WorkbookPatch.spec.js`。必须覆盖三格成功、第二格抛错、一次 undo/redo、重复提交、只读拒绝、过期版本和公式被文本替换。

验证命令：

```bash
npm test -- tests/core/WorkbookRevision.spec.js tests/core/FormulaInspection.spec.js tests/core/WorkbookPatch.spec.js tests/core/History.spec.js
```

**完成标准：** 第二格失败时 C2:C4 全部保持原样，历史和脏标记不留下半次修改；成功后一次撤销恢复三格及样式。

**实施记录：**

1. `Workbook.applyCellPatch(patch)` 按 5.1 契约暴露公共 API，返回 `mutationId`、`previousRevision`、`revision` 和 `changedCells`；现有 `bulkSetCells()` 行为未改变。
2. 提交前完成 mutation ID 幂等检查、当前 Sheet、只读、预期修订号、坐标、重复目标、补丁大小、旧值前置条件和公式白名单检查。相同 ID 与相同内容返回原结果，相同 ID 不同内容返回 `MUTATION_ID_CONFLICT`。
3. `before` 只比较持久内容：公式单元格比较 `f` 与样式，忽略计算缓存 `v`、`m`、`dirty`；普通单元格严格比较 `v`、`m` 和样式。
4. 写入阶段使用内部低层路径，暂缓计算调度、持久化调度和对外通知。成功后统一标记计算、记录一条 `batch-set-cell` 历史、推进一次内容修订号、调度保存并通知。
5. 失败时恢复稀疏矩阵、公式依赖图、共享数值、持久化脏标记、历史栈、`dataVersion` 和数据缓存；不产生修订事件，不留下半次修改。
6. `mutation-committed` 事件新增 `source: 'patch'`，并使用调用方提供的 `mutationId`，便于应用侧把确认摘要、任务和提交结果对齐。

**验证记录：**

| 检查 | 结果 |
| --- | --- |
| `npm test -- tests/core/WorkbookPatch.spec.js` | 14 项通过 |
| `npm test -- tests/core/WorkbookRevision.spec.js tests/core/FormulaInspection.spec.js tests/core/WorkbookPatch.spec.js tests/core/History.spec.js` | 4 个文件，152 项通过 |
| `npm test -- tests/core/Workbook.spec.js tests/core/PersistenceManager.spec.js tests/core/IncrementalCalculation.spec.js tests/core/FormulaCompiler.spec.js` | 4 个文件，242 项通过 |
| `npm run check:types:runtime` | 通过 |
| `npm test` | 72 个文件通过、1 个文件失败；978 项通过、6 项失败，失败仍为协作服务未启动 |

本步只提供通用原子写入能力；只读预览、确认按钮和 `PatchExecutor` 已分别由步骤 09–10 实现。AI 面板不得绕过 `PatchExecutor` 直接逐格写表。

### 步骤 08：建立 AI API 服务

对应任务：T03、T06。

**状态：已完成（2026-09-15）；原 Mock Provider 已按最新要求删除。** API 专项 27 项通过；协议 72 项、Web 41 项和运行时导出检查复验通过。

**保留文件：** `apps/ai-api/src/app.js`、`apps/ai-api/src/server.js`、`apps/ai-api/src/routes/aiRuns.js`、`apps/ai-api/src/services/RunService.js`。

1. `app.js` 导出 `buildApp({ provider })`，只创建 Fastify 应用，不监听端口；`server.js` 单独负责读取环境配置并监听 `127.0.0.1:8891`。
2. 实现 `POST /api/ai/runs`、任务查询、SSE 和取消接口，初期用有上限和过期时间的内存任务存储。
3. Provider 只返回步骤 04 的操作部分；服务端从已校验请求恢复 run ID、文档、版本和范围等可信信封。
4. 测试通过 fake `fetch` 覆盖延迟、坏 JSON、越权目标、失败和取消场景，不保留运行时 Mock Provider。
5. 补开发会话、Origin 检查、请求体限制和幂等键；这些检查在 DeepSeek 直连模式下同样生效。
6. 服务端只创建 DeepSeek Provider；未配置 `DEEPSEEK_API_KEY` 时明确启动失败。

**验证文件：** `apps/ai-api/tests/aiRuns.spec.js`，通过 Fastify `inject()` 测试，不需要启动 HTTP 服务。

验证命令：`npm run test:ai:api`。

**完成标准：** 相同请求重试返回同一个 run；成功取消的任务不会再次转为就绪；已完成任务收到取消请求时返回既有终态，由客户端丢弃待确认结果；客户端断开不触发第二次生成。

**本步实施记录：**

- `app.js` 导出 `buildApp({ provider, ... })`，只创建 Fastify 实例并注入 `RunService`，不监听端口；`server.js` 单独读取 Origin、开发会话、DeepSeek 配置、地址和端口，固定创建 DeepSeek Provider 并监听 `127.0.0.1:8891`。
- `POST /api/ai/runs` 支持幂等键，服务端生成 run ID 并与客户端请求中的文档、epoch、Sheet、内容修订号和授权范围组成可信信封；`GET /api/ai/runs/:id`、`GET /api/ai/runs/:id/events` 和 `POST /api/ai/runs/:id/cancel` 均按开发会话隔离。
- `RunService` 使用共享 Schema 和授权校验恢复完整响应，不信任模型提供的信封；测试直接用 `ModelProvider` 注入 fake `fetch` 模拟坏 JSON、越权、失败、延迟和取消。
- 内存任务存储包含上限、TTL、幂等键和状态事件；SSE 支持 `Last-Event-ID` / `afterEventId`，终态后关闭连接；重复订阅不触发新的 Provider 调用，客户端断开只关闭事件流。
- API 统一返回 `{ code, message, retryable, requestId }` 错误结构；请求体默认限制 32KB，Origin 与开发会话检查在 DeepSeek 直连模式下生效。

**验证记录（2026-09-15）：**

| 命令 | 结果 |
| --- | --- |
| `npm run test:ai:api` | 2 个文件、27 项通过 |
| `npm run test:ai:contracts` | 1 个文件、72 项通过 |
| `npm run test:ai:web` | 2 个文件、15 项通过，测试环境 Web Worker 不可用时回退主线程 |
| `npm run check:types:runtime` | 通过 |

测试覆盖固定订单计划、相同幂等键复用、不同请求冲突、坏 JSON、越权目标、Provider 失败、活动任务取消、终态后取消、SSE 事件重放、Origin/开发会话拒绝、跨会话 404、TTL、任务上限、超请求体和缺失幂等键。客户端断开不触发第二次生成的行为由 SSE 只读事件流实现；本步未启动真实 HTTP 服务，也未接入真实模型。

### 步骤 09：从真实选区构建上下文，并生成只读预览

对应任务：T05。

**状态：已完成（2026-09-15）。** 只读预览专项 15 项通过；Web workspace 3 个文件、30 项测试通过。

**新建文件：**

- `apps/ai-web/src/services/WorkbookAdapter.js`、`apps/ai-web/src/services/ContextBuilder.js`。
- `apps/ai-web/src/services/OperationPlanner.js`、`apps/ai-web/src/services/PreviewEngine.js`。
- `apps/ai-web/src/components/ChangePreview.vue`。

1. `WorkbookAdapter` 暴露取选区、取独立快照、取修订号和定位单元格的方法；不向 UI 暴露私有矩阵。
2. `ContextBuilder` 把读取范围 A1:B4、写入范围 C2:C4 和当前修订号放进请求；样本默认不发送。
3. `OperationPlanner` 接收通过校验的计划，调用公式平移，从原表读取旧值并生成三项 `before/after`。
4. `PreviewEngine` 创建关闭持久化的临时 Workbook，加载独立快照并预演所有目标格。
5. 检查预演公式结果和引用依赖；将原始公式、旧值、新结果和错误交给 `ChangePreview`。
6. 页面离开、任务取消或预览替换时关闭临时 Workbook；适配器只清理自己注册的监听。

**验证文件：** `apps/ai-web/tests/PreviewEngine.spec.js`。

**完成标准：** 预览显示 `20、15、32`，而真实表格 C2:C4 仍为空；存在错误或范围变化时不能进入应用状态。

**本步实施记录：**

- `WorkbookAdapter` 私有持有 Workbook，只暴露选区、独立快照、内容修订号、Sheet ID、单元格、A1 定位、公式检查/平移和内容提交订阅；快照使用 `structuredClone(toJSON())`，不向 UI 暴露私有矩阵。
- `ContextBuilder` 从真实 Workbook 读取当前修订号和活动 Sheet，默认生成 A1:B4 读取授权、C2:C4 写入授权；`context.sample` 默认不发送，显式开启时按协议限制最多 5 行、每行 20 格。
- `OperationPlanner` 必须接收 `ContextBuilder` 生成的本地可信信封；计划先用共享 Schema 校验，再与本地信封比对文档、epoch、Sheet、修订号和读写范围，run ID 只接受服务端返回计划中的值。逐格调用 `translateFormula()`，检查每个引用都在读取范围内，并从原表读取受保护的 `before`，生成 `after` 公式，保留已有样式。
- `PreviewEngine` 每次预演前关闭旧临时 Workbook，创建 `enablePersistence: false`、`enableWasm: false` 的临时实例，加载独立快照后用原子补丁写入三行公式并同步计算；返回前再次检查原表修订号，取消、销毁、版本变化、越权引用和 `#VALUE!` 等错误结果都不会进入可应用状态。
- `ChangePreview.vue` 展示单元格、原始公式、旧值和预演值；`WorkspaceView.vue` 在挂载后把 A1:B4 设为真实选区，基于当前上下文生成固定订单计划并渲染只读预览。页面卸载时释放适配器订阅并关闭预览引擎。
- 本步未接通 AI 请求面板，也没有“应用”按钮；确认写入、撤销和任务状态仍留在步骤 10。

**验证记录（2026-09-15）：**

| 命令 | 结果 |
| --- | --- |
| `npm run test:ai:web` | 3 个文件、30 项通过；其中 `PreviewEngine.spec.js` 15 项通过 |
| `npm run test:ai:contracts` | 1 个文件、72 项通过 |
| `npm run test:ai:api` | 1 个文件、15 项通过 |
| `npm run check:types:runtime` | 通过 |

专项覆盖真实选区与快照独立性、默认不发送样本、订阅清理、公式平移、目标已有值、空单价 `#VALUE!`、越权引用、篡改本地可信信封、过期版本、非法公式、取消、销毁关闭临时 Workbook、首屏只读预览和错误态。预览输出为 `20、15、32`，源表 C2:C4 保持为空；测试环境 Web Worker 不可用时按现有引擎回退主线程。

### 步骤 10：接通 AI 面板、确认按钮和撤销

对应任务：T05、T07。

**状态：已完成（2026-09-15）。** 确认写入专项 5 项、AI 面板与任务生命周期专项 6 项通过；Web workspace 5 个文件、41 项测试通过。

**新建文件：** `apps/ai-web/src/components/AiPanel.vue`、`apps/ai-web/src/composables/useAiRun.js`、`apps/ai-web/src/services/aiClient.js`、`apps/ai-web/src/services/PatchExecutor.js`。

1. 输入区提交到本地 AI API；用 `useAiRun` 管理生成中、待澄清、待确认、已应用、失败和取消。
2. `aiClient` 处理创建任务、SSE、断线查询和取消；完整计划验证通过后才进入步骤 09。
3. “应用”按钮绑定本次预览摘要；点击时重新检查文档、Sheet、epoch、修订号和权限。
4. 只允许 `PatchExecutor` 调用 `applyCellPatch()`；AI 面板不逐个调用 `setCell()`。
5. 提交期间禁用重复应用；返回成功后展示影响数量，允许一次撤销。
6. 用户做过后续手动编辑后，禁用该旧任务的快捷撤销，不能把最后一次手动编辑误撤销。

**验证文件：** `apps/ai-web/tests/PatchExecutor.spec.js`、`apps/ai-web/tests/AiPanel.spec.js`。

**完成标准：** DeepSeek 直连模式下完成“输入要求 → 预览 → 应用 → 撤销 → 重做”；生成后手动改 A2，再应用旧预览必须被拦截。

**本步实施记录：**

- `AiPanel.vue` 提供输入区、生成、取消、应用、撤销和重做操作，并展示待输入、生成中、待澄清、待确认、应用中、已应用、已撤销、失败和已取消状态；应用期间由 `useAiRun` 状态机阻止重复提交。
- `useAiRun` 管理 run 生命周期和本地内容监听；SSE 收到计划后先进入步骤 09 的 `PreviewEngine`，事件流断开时自动降级为任务查询，取消会丢弃待确认结果。
- `aiClient.js` 使用 `fetch` 创建任务、查询任务、取消任务并解析 SSE 流，可携带 `Idempotency-Key` 和开发会话头；开发模式默认走同源 `/api`，由 Vite 服务端代理到 `http://127.0.0.1:8891`，避免浏览器系统代理拦截本地 API 请求。`VITE_AI_API_BASE_URL` 保留为显式覆盖项。
- `PatchExecutor.js` 是唯一调用 `applyCellPatch()` 的路径。应用前重新检查 run、文档、epoch、Sheet、修订号、读写授权、重复目标和旧值前置条件；应用后同步计算并返回影响数量。
- 快捷撤销和重做绑定应用后的内容修订号；用户在预览后手动修改 A2 会让预览失效，用户在应用后手动修改会让旧任务快捷撤销不可用，避免误撤销最后一次手动编辑。
- `WorkspaceView.vue` 已接入本地 AI API 流程，默认仍不自动写表；用户输入要求并确认后才应用。

**验证记录（2026-09-15）：**

| 命令 | 结果 |
| --- | --- |
| `npm run test:ai:web` | 5 个文件、41 项通过；其中 `PatchExecutor.spec.js` 5 项、`AiPanel.spec.js` 6 项 |
| `npm run test:ai:contracts` | 1 个文件、72 项通过 |
| `npm run test:ai:api` | 1 个文件、15 项通过 |
| `npm test -- tests/core/WorkbookPatch.spec.js tests/core/History.spec.js` | 2 个文件、34 项通过 |
| `npm run check:types:runtime` | 通过 |

专项覆盖输入到预览、应用、撤销、重做；生成后手动修改 A2 再应用旧预览被拦截；应用后手动编辑禁用旧任务快捷撤销；SSE 断线后通过任务查询恢复；越权目标、篡改文档身份和过期版本均不写表。

### 步骤 11：增加导入、导出和本地文档恢复

对应任务：T07。

**新建文件：** `apps/ai-web/src/services/LocalDocumentRepository.js`、`apps/ai-web/src/composables/useDocument.js`、`apps/ai-web/src/router.js`；扩展 `apps/ai-web/src/components/WorkbookHost.vue`。

1. Web workspace 增加 `idb`。建文档元数据、工作簿快照、任务摘要和 mutation 记录存储，设置数据库版本。
2. 实现 `createDocument`、`listDocuments`、`loadDocument`、`saveDocument`，保存时把同一版本的快照与应用记录放进一次事务。
3. 监听内容提交事件防抖保存；切换文档前显式 flush；先完成恢复再开放 AI 输入。
4. 通过新建临时 Workbook 和现有导入插件解析 XLSX/CSV；成功后再替换当前文档，失败保留原文档。
5. 对多 Sheet 文件说明处理范围并允许取消；M1 不暗中忽略其他 Sheet 后宣称完整导入。
6. 接入现有导出插件；本地存储失败时仍允许导出当前内存数据。
7. 首次加载时使用 `fromJSON()`，日常 AI 修改继续使用补丁，不通过重载整表更新。

**验证文件：** `apps/ai-web/tests/LocalDocumentRepository.spec.js`、`apps/ai-web/tests/DocumentImport.spec.js`，在测试环境使用 IndexedDB 替身。

**完成标准：** 应用公式后刷新能恢复结果；导入坏文件不会清空旧表；保存失败显示未保存，不伪装成功。

### 步骤 12：接入 DeepSeek 直连 Provider

对应任务：T06。

**状态：代码接入已完成（2026-09-15），DeepSeek 真实调用待本地人工验收。** API workspace 2 个文件、27 项测试通过；协议 72 项、Web 41 项和运行时导出检查复验通过。常规测试使用 fake `fetch`，不消耗模型额度。

**新建文件：** `apps/ai-api/src/ai/ModelProvider.js`、`apps/ai-api/src/ai/provider.js`、`apps/ai-api/src/ai/prompts.js`、`apps/ai-api/.env.example`。

1. `ModelProvider` 实现 `generatePlan()` 接口，不改动前端预览和写入流程。
2. 提示词只提供授权上下文、操作白名单和结构化输出 Schema；单元格文本不作为指令。
3. 上游结果先经过服务端 Schema 校验，再绑定可信信封返回浏览器。
4. 限制总超时、输出大小和格式修复次数；取消请求传递给上游 `AbortSignal`。
5. `.env.example` 只放变量名和占位值；本地真实密钥放入已忽略的 `.env.local`，由服务端入口显式读取。密钥不进入前端变量或请求体。
6. 不提供 Mock 运行时开关；开始只用步骤 01 的非敏感测试数据，并设置输出与调用次数上限。

**验证：** 供应商响应使用测试替身覆盖超时、限流和坏 JSON；真实调用单独人工验证，不放进常规单元测试。

**完成标准：** DeepSeek 可以生成同样的公式计划，未知操作和越权范围仍被拦截；未配置密钥时服务端明确启动失败，不存在 Mock 降级路径。

**本步实施记录：**

- `ModelProvider` 使用 OpenAI 兼容的 DeepSeek `POST /chat/completions` 接口，默认 `https://api.deepseek.com` 和 `deepseek-chat`，启用 `response_format: { type: "json_object" }`、`temperature: 0`、`stream: false`。
- `provider.js` 固定创建 DeepSeek Provider；`MockProvider.js` 和 `AI_PROVIDER` / Mock 环境变量已删除。
- 提示词只包含用户需求、授权读写范围、操作白名单和输出结构；样本值被声明为数据而非指令，且提示词不发送 `runId`、`documentId`、`documentEpoch`、`sheetId` 等可信信封字段。
- Provider 输出只允许 `kind`、`operations`、`questions`、`warnings`；服务端仍把模型输出与本地保留的可信信封合并，再执行共享 Schema 和授权范围校验，模型不能伪造文档、Sheet、版本或范围。
- 请求超时默认 30 秒，输出默认限制 1,024 tokens，响应体限制 512KB，单进程模型调用默认最多 1,000 次，JSON 格式修复默认最多 1 次；取消请求通过 `AbortSignal` 传给上游，429/5xx/网络错误映射为可重试错误，坏 JSON 和越权字段映射为 `INVALID_PLAN`。
- `.env.example` 只包含占位值；本地真实密钥放在已忽略的 `apps/ai-api/.env.local`，`npm run dev --workspace @ai-sheet/api` 通过 Node 的 `--env-file-if-exists=.env.local` 读取。密钥只存在于服务端进程，不进入前端环境变量或请求体。

**本地启动步骤：**

```bash
cp apps/ai-api/.env.example apps/ai-api/.env.local
# 编辑 apps/ai-api/.env.local，填入 DEEPSEEK_API_KEY
npm run dev:ai
```

`npm run dev:ai` 会同时启动 API 和 Web；浏览器只打开 `http://127.0.0.1:8890`，Web 通过同源 `/api` 代理访问 `127.0.0.1:8891`。

**验证记录（2026-09-15）：**

| 命令 | 结果 |
| --- | --- |
| `npm run test:ai:api` | 2 个文件、27 项通过 |
| `npm run test:ai:contracts` | 1 个文件、72 项通过 |
| `npm run test:ai:web` | 5 个文件、41 项通过 |
| `npm run check:types:runtime` | 通过 |

### 步骤 13：按固定操作顺序验收第一个版本

对应任务：T07、T10 的 M1 检查。

**新建文件：** `apps/ai-web/e2e/formula-workflow.spec.js`、`apps/ai-web/e2e/fixtures/orders.csv`、`apps/ai-web/e2e/playwright.config.js`。

实际验收按下面顺序执行，全程使用 DeepSeek 直连 provider：

1. 打开独立应用，导入订单文件，确认 A2:B4 与步骤 01 一致。
2. 选择源列和空白结果范围，输入“根据单价和数量生成销售额列”。
3. 等待预览，确认 C2:C4 依然为空，差异面板显示 `20、15、32`。
4. 点击取消，确认原表没有变化。
5. 重新生成并应用，确认三格公式和数值正确。
6. 撤销一次，确认三格恢复；重做一次，确认结果重现。
7. 再撤销一次恢复空白结果列，生成新预览，手动修改 A2，确认旧预览应用被拒绝。
8. 将 A2 改回 10，重新生成并应用；等待本地保存成功后刷新，确认结果 `20、15、32` 恢复。
9. 导出 XLSX，检查单元格公式、结果及格式。
10. 在新的订单文档中模拟第二格写入失败，确认没有部分修改；再模拟保存失败，确认显示未保存并可导出。
11. 在桌面和窄屏检查 Canvas 非空、AI 面板不遮挡表格工具栏、按钮没有布局跳动。

**完成标准：** 上面逐项通过，才标记 M1 完成。开发服务由本地启动；步骤 01–07 未运行 E2E 或开发服务，步骤 03 的页面由用户确认本地验收通过，步骤 07 后的全量测试仍有 6 项协作服务启动失败待复验。

### 步骤 14：依次增加三个清洗操作

对应任务：T08。

**新增或修改：** `packages/ai-contracts/src/plan.js`、`apps/ai-web/src/services/OperationPlanner.js`；新增 `apps/ai-web/src/services/operations/trimText.js`、`apps/ai-web/src/services/operations/normalizeDate.js`、`apps/ai-web/src/services/operations/markDuplicates.js`。

1. 先做 `trim_text`：对 `"  张三  "` 生成 `"张三"` 的补丁，保留空值、数值和公式。
2. 再做 `normalize_date`：明确输入格式后转换日期；`01/02/2026` 未确认格式时要求澄清，无效日期保留原值。
3. 最后做 `mark_duplicates`：按指定列和空值规则比较，在授权空白列写标记，绝不删除原行。
4. 每次只增加一种协议类型、一个规则执行器和对应测试，继续共用预览、确认和撤销。

**验证文件：** `apps/ai-web/tests/CleaningOperations.spec.js`，同时扩展 contracts 的计划校验测试。

**完成标准：** 每种操作都能独立通过“预览不改表、确认才改、一次撤销”测试；前导零和原公式不被破坏。

### 步骤 15：增加全量统计和来源定位

对应任务：T09、T10。

**新建文件：** `apps/ai-web/src/workers/analysis.worker.js`、`apps/ai-web/src/services/AnalysisService.js`、`apps/ai-web/tests/AnalysisService.spec.js`。

1. contracts 增加 `aggregate` Schema，仅允许明确的分组列、比较条件和度量。
2. 从授权完整范围提取数据交给 Worker，模型只生成统计计划。
3. 先做求和、计数、平均值，再做单列分组；金额按确定的十进制舍入规则计算。
4. 结果返回参与行数、排除数量、源范围和修订号。
5. 点击来源调用 `setSelection()`；数据变动后将结果标记为过期，不自动沿用。
6. 执行 M2 的真实任务、安全、规模和性能评测，通过后再进入云端功能。

**完成标准：** 订单样例销售额合计为 `67`，过滤和分组结果与固定夹具一致；答案不是由模型对样本估算。

### 步骤 16：接入账号，再实现云端文档版本

对应任务：T11、T12。

**新建文件：**

- `apps/ai-api/src/middleware/session.js`、`apps/ai-api/src/routes/auth.js`、`apps/ai-api/src/routes/documents.js`。
- `apps/ai-api/src/services/DocumentService.js`、`apps/ai-api/migrations/001_documents.sql`、`apps/ai-api/migrations/002_ai_runs.sql`。
- `apps/ai-web/src/services/CloudDocumentRepository.js`。

1. 先接成熟 OIDC 登录库，实现登录、回调、退出和当前用户接口，验证 state、nonce、PKCE，并建立 HttpOnly 会话。
2. 为文档和任务接口统一加会话及归属校验，先写“用户 A 不能读取用户 B 数据”的接口测试。
3. 按第 9.3 节创建用户、文档、版本、mutation、AI 任务与用量表，给唯一键和外键写迁移。
4. 实现文档创建、读取、重命名和快照保存；提交时携带 `expectedServerRevision` 和 mutation ID。
5. 用数据库事务与条件更新保证版本比较和保存原子性；同一 mutation 重试返回原结果。
6. Web 本地保存成功后再排队同步；断网保留本地副本，`409` 显示冲突，不覆盖服务器。
7. 增加历史列表和恢复接口，恢复时创建新版本，不删除旧版本。

**验证文件：** `apps/ai-api/tests/documentAccess.spec.js`、`apps/ai-api/tests/documentVersions.spec.js`、`apps/ai-web/tests/CloudDocumentRepository.spec.js`。

**完成标准：** 两个标签页基于同一旧版本保存时，后提交者得到冲突；重试不重复生成版本；未登录和越权请求失败。

### 步骤 17：完成内测上线检查

对应任务：T13。

**涉及文件：** `apps/ai-api/src/services/UsageService.js`、`apps/ai-api/src/middleware/requestLimits.js`、`deploy/nginx.conf`、`deploy/README.md`，以及应用和 API 的验收测试。

1. 开启用户级速率、并发、输入大小、任务超时和额度限制。
2. 日志只记录必要元数据，检查前端产物、源码和日志中没有模型密钥或原始表格内容。
3. 配置 HTTPS、同源 API、SSE 代理、数据库备份和功能开关，实际恢复一次备份。
4. 执行关闭源码 alias 的组件包接入测试，检查 CSS、Worker、WASM 和原 npm 包发布范围。
5. 验证关闭 AI 或模型服务不可用时，普通编辑、本地保存和导出仍然可用。
6. 向 5–10 位试点用户开放，记录任务成功率、应用率、保存失败和单次成功成本。

**完成标准：** 第 13.3 节的阻断项全部通过，M3 才进入内测。

### 步骤 18：内测稳定后再做批量 AI 填充

对应任务：T14，不属于首个版本。

**涉及文件：** 扩展 `packages/ai-contracts/src/plan.js`；新增 `apps/ai-api/src/services/BatchFillService.js`、`apps/ai-api/src/repositories/BatchRepository.js`、`apps/ai-api/tests/batchFill.spec.js`。

1. 新增分类和提取 Schema，输出限制为明确字段或枚举。
2. 先做小样本试跑、数据授权和成本确认，再开启批处理。
3. 建批次状态和缓存，按输入、模型、提示词版本及租户隔离结果；失败只重试相应批次。
4. 回填前再次检查来源版本，复用补丁预览和确认，不由服务端直接写当前浏览器表格。
5. 大任务明确拆批，每批独立确认和撤销，不承诺跨批次原子性。

**完成标准：** 用户取消后不再调度新批次；重试不重复回填；原文本变更的行必须重新预览。

### 每一步结束时的固定检查

- 只执行当前步骤已经创建的测试；失败先修复，再进入依赖它的下一步。
- 根引擎改动运行相关 `npm test -- <测试文件>`；应用、API、协议分别运行步骤 02 定义的测试脚本。
- 用 `git diff --check` 检查格式，用 `git diff` 检查是否误改组件发布入口或无关文件。
- 将步骤状态更新为已完成，并记录实际通过的测试；未运行的检查明确保留为待验证。
- 开发服务、依赖安装和构建由本地按需执行，不能把尚未执行的命令记成验证通过。

## 1. 交付目标与范围

### 1.1 第一个必须跑通的场景

用户导入一份订单表，选择单价、数量和空白结果列，输入：

> 根据单价和数量生成销售额列。

系统生成逐行公式，在不修改原表的情况下展示差异。用户确认后一次写入，支持一次撤销、重做和导出。

基准数据：

| 单价 | 数量 | 销售额 |
| --- | --- | --- |
| 10 | 2 | 空 |
| 5 | 3 | 空 |
| 8 | 4 | 空 |

预期写入 `C2 = A2*B2`、`C3 = A3*B3`、`C4 = A4*B4`，计算结果为 `20 / 15 / 32`。撤销后恢复原单元格，包括原有样式。

### 1.2 分阶段范围

| 阶段 | 必须交付 | 明确不做 |
| --- | --- | --- |
| M0 工程基础 | 独立应用入口、组件接入、AI API、协议与测试夹具 | 真实模型自动修改数据 |
| M1 验证版 | 单表导入、公式生成、预览、确认、原子写入、撤销、本地保存 | 跨表写入、结构调整、任意代码执行 |
| M2 MVP | 规则清洗、重复标记、分组统计、来源定位、真实模型评测 | 自动删除重复行、复杂透视表、联网采集 |
| M3 内测版 | 登录、私有文档、云端版本、额度、任务记录、监控 | 实时多人编辑、支付系统、企业权限矩阵 |
| M4 后续 | 文本分类与提取、批量 AI 填充、缓存、失败重试 | 将网络请求直接塞入同步公式引擎 |

M1/M2 的 AI 写入只作用于当前工作表的现有单元格。新增结果列指写入已有的空白列，不自动插入、移动或删除物理列。没有足够空间时提示用户先调整表格，再重新生成计划。

## 2. 已核实的接入基础

以下判断来自当前源码，不以 README 中的概括性宣传作为能力保证。

| 现有位置 | 可以复用 | 实施时的限制 |
| --- | --- | --- |
| [TableDesigner](../src/components/designer/index.vue) | 表格编辑器、工具栏、Sheet 标签、组件 ref | AI 面板放在应用层，不写入组件内部 |
| [Workbook](../src/core/Workbook.js) | `getCell`、`getCellValue`、`iterateRange`、`setSelection`、`toJSON`、`fromJSON` | 业务代码不直接操作私有矩阵、依赖图或历史栈 |
| [History](../src/core/history/History.js) | 批量历史、撤销、重做 | `startBatch/endBatch` 只是历史分组，不提供失败回滚 |
| [Workbook 批量更新](../src/core/Workbook.js) | `bulkSetCells`、`beginBatchUpdate/endBatchUpdate` | 前者边遍历边写入，后者只批量化 Store 通知，都不能直接当作事务 |
| [ImportPlugin](../src/plugins/ImportPlugin.js) | XLSX、CSV 等解析和单元格转换 | 当前 Excel 导入只取第一张 Sheet，分批导入会直接改工作簿 |
| [ExportPlugin](../src/plugins/ExportPlugin.js) | Excel、CSV、JSON 导出 | 复用现有 CSV 类公式文本防护，不默认开启公式放行 |
| [AutoSavePlugin](../src/plugins/AutoSavePlugin.js) | 组件用户的本地自动保存 | 产品需要文档、任务和版本一致性，不能同时启用多套恢复逻辑 |
| [共享公式引擎](../src/core/data/FormulaRPNEvaluator.js) | JS 公式解析和求值 | 仅开放经过测试的函数与引用语法；不根据文档推定完整 Excel 兼容 |
| [公式归一化器](../src/core/data/FormulaCompiler.js) | 引用归一化 | 它不是完整的语法或权限校验器，不作为 AI 公式安全边界 |
| [根 Vite 配置](../vite.config.js) | 多入口组件库构建 | 不能直接拿它构建 Web 应用，否则会继续输出 library 产物 |

还需要注意：

1. `switchSheet()` 会清空当前撤销历史。M1 不承诺切表、刷新或重新导入后仍能执行原生撤销。
2. `fromJSON()` 会清空历史，因此不能用“每次 AI 修改后重新加载整表”代替正常写入。
3. 现有 `dataVersion` 随工作表状态恢复，不是全工作簿单调递增的业务版本。
4. `toJSON()` 顶层数据可能保留活单元格引用。用于预览、任务和持久化时必须取得独立快照。
5. 仅监听 `cell-change` 会漏掉部分批量修改和撤销路径，不能据此保证预览有效性或云端保存完整性。

## 3. 仓库与依赖组织

### 3.1 采用同仓库、独立应用

继续使用 npm，增加 npm workspaces，不迁移 pnpm，不搬动现有 `src`、`types`、`tests`。

```text
table/
  package.json                    # 保留组件库名称、exports、files 和原有脚本
  package-lock.json               # 统一依赖锁文件
  src/                            # 现有组件与通用引擎
  types/                          # 现有公共类型声明
  tests/                          # 组件库测试
  apps/
    ai-web/
      package.json                # @ai-sheet/web，private: true
      index.html
      vite.config.js              # 应用构建，不继承 build.lib
      src/
        main.js
        App.vue
        router.js
        views/
          WorkspaceView.vue
        components/
          DocumentSidebar.vue
          WorkbookHost.vue
          AiPanel.vue
          ChangePreview.vue
          TaskHistory.vue
        composables/
          useDocument.js
          useAiRun.js
        services/
          aiClient.js
          WorkbookAdapter.js
          ContextBuilder.js
          OperationPlanner.js
          PreviewEngine.js
          PatchExecutor.js
          LocalDocumentRepository.js
          CloudDocumentRepository.js
        workers/
          analysis.worker.js
      tests/
      e2e/
    ai-api/
      package.json                # @ai-sheet/api，private: true
      src/
        app.js
        server.js
        routes/
          aiRuns.js
          documents.js
        ai/
          provider.js
          ModelProvider.js
          prompts.js
        services/
          RunService.js
          DocumentService.js
          UsageService.js
        repositories/
        middleware/
      migrations/
      tests/
  packages/
    ai-contracts/
      package.json                # @ai-sheet/contracts，private: true
      src/
        index.js
        context.js
        plan.js
        events.js
        errors.js
      tests/
  docs/
    AI_TABLE_PRODUCT_PLAN.md
    AI_TABLE_IMPLEMENTATION_PLAN.md
```

这些是目标目录，随对应任务逐步创建，不先生成一批空模块。

### 3.2 技术选型

| 层 | 选型 | 原因 |
| --- | --- | --- |
| 前端 | Vue 3、Vite、Vue Router、现有 Sass 和 `@lucide/vue` | 延续当前技术栈 |
| 前端状态 | Vue composables，Workbook 用 `markRaw` 保存 | 不把整张表复制进响应式状态，不提前引入全局状态框架 |
| 代码风格 | JavaScript ESM + JSDoc | 不要求现有组件库进行 TypeScript 迁移 |
| 协议 | Zod 严格 Schema，按需导出 JSON Schema | 前后端共享字段、枚举和边界校验 |
| 本地文档 | IndexedDB，使用 `idb` 封装事务 | 文档快照与任务状态需要一致提交 |
| API | Node.js 22+、Fastify | 单服务起步，支持流式返回和请求限制 |
| 云端 | PostgreSQL；原始文件按需放对象存储 | 先用快照和乐观锁，不做分布式协同 |
| 金额统计 | M2 引入 `decimal.js` | 明确十进制统计、舍入规则，不让模型算金额 |
| 测试 | 现有 Vitest、Playwright | 复用测试体系，应用单独配置 |

### 3.3 组件库隔离要求

- 根包继续发布 `vue-canvas-sheet`，不改为 `private`，不把应用和模型 SDK 加入根包运行时依赖。
- 三个新增 workspace 都设为 `private: true`。共享协议包的拆分只为前后端复用，不新增通用框架。
- Web 声明本地引擎依赖，例如 `file:../..`；共享协议使用本地 workspace 依赖，不假设当前版本已发布到 npm。
- 本地联调为包根入口、`core`、`plugins`、`wasm` 配置精确匹配的源码 alias，避免宽泛前缀替换误伤子入口；Vue 配置去重。
- 应用产物写入 `apps/ai-web/dist`，不覆盖根目录组件库的 `dist`。
- 发布前另做一次关闭源码 alias 的已打包组件接入测试，验证实际 `exports`、CSS、Worker、WASM 资源路径。
- 保留现有示例和包导出回归。新增通用 API 时同步类型声明和 API 文档。

## 4. 应用界面与状态职责

### 4.1 工作台

- `/`：直接打开最近文档；没有文档时打开空白工作台，不先展示营销页。
- `/documents/:documentId`：指定文档工作区。
- 顶部：文档名称、保存状态、导入和导出操作。
- 左侧：可收起的文档列表。
- 中间：现有 `TableDesigner`。
- 右侧：AI 输入、处理进度、待确认结果、任务历史。
- 差异视图：显示坐标、旧值、新值、公式和错误；首屏分页显示，不渲染数千个 DOM 行。

桌面右侧 AI 面板默认约 360px；空间不足先收起文档栏，小屏改为抽屉。工具按钮沿用现有图标库，状态不只用颜色区分。

### 4.2 组件边界

| 模块 | 职责 |
| --- | --- |
| `WorkbookHost` | 挂载和关闭编辑器、持有 ref、传递文档快照，不负责模型请求 |
| `WorkbookAdapter` | 统一读区间、取独立快照、定位来源、获取版本、调用公共写入 API |
| `ContextBuilder` | 构建模型可见的最小上下文，执行字段排除与样本限制 |
| `OperationPlanner` | 将已校验的业务操作转换为确定性的单元格补丁或统计计划 |
| `PreviewEngine` | 在独立临时 Workbook 中预演，返回差异和错误，不改原表 |
| `PatchExecutor` | 执行版本校验、确认绑定、原子提交和任务状态更新 |
| `AiPanel` | 展示任务状态和结果，不直接调用 `setCell` |
| `LocalDocumentRepository` | 本地文档、快照、任务摘要和待同步状态 |
| `CloudDocumentRepository` | 云端版本读写、重试和冲突处理 |

AI 预览期间不向原表写入临时颜色或公式。来源定位使用选区 API；预览展示用 DOM 差异表或独立只读实例，避免污染样式历史。

## 5. 先补齐通用引擎能力

这些增强留在组件库中，名称和语义不绑定 AI。

### 5.1 拟新增公共 API

```js
workbook.getContentRevision();

workbook.applyCellPatch({
  mutationId,
  sheetId,
  expectedRevision,
  changes: [
    { r, c, before: oldCell, after: newCell }
  ]
});

workbook.inspectFormula(formula, { r, c });
workbook.translateFormula(formula, { from, to });
```

约定：

- `getContentRevision()` 返回当前 Workbook 实例的单调递增修订号，不复用 `dataVersion`。
- `applyCellPatch()` 只支持当前 Sheet 的单元格修改，采用完整替换语义；`after: null` 表示删除单元格。
- `before/after` 是独立的单元格值，不允许携带函数、原型对象或执行脚本。
- 旧值前置条件比较持久内容；公式单元格的计算缓存 `v`、`m`、`dirty` 不作为独立编辑，普通单元格的 `v` 必须严格比较。失败恢复仍要保留必要的完整内部快照。
- `mutationId` 标识一次补丁；同一实例内重复提交相同 ID 和内容返回原结果，ID 相同但内容不同则拒绝。
- 返回值至少包含 `mutationId`、`previousRevision`、`revision`、`changedCells`。
- `inspectFormula()` 返回语法、函数、引用和错误信息，不执行网络请求。
- `translateFormula()` 使用与实际求值一致的解析规则平移引用，不对整条公式做不区分字符串的正则替换。

公式检查和平移应复用、适度整理现有共享解析逻辑，不另写一套 Excel 引擎。M1 先放行经过测试的 A1 相对引用；绝对引用、混合引用等逐项通过测试后再开放。

初始公式目标为基础四则运算，以及通过夹具验证的 `SUM`、`AVERAGE`、`MIN`、`MAX`、`COUNT`、`ROUND`、`IF`。M1 不开放 `NOW`、`TODAY` 等随时间变化的函数和业务自定义函数；检查范围包括被引用公式的依赖链，防止预览与应用时结果口径变化。

### 5.2 修订号覆盖面

修订号必须覆盖单元格值、公式、样式、合并、行列结构、行高列宽、冻结、批注、工作表新增删除重命名、数据加载、撤销和重做，保证应用保存订阅不会漏掉持久内容的变化。

选区移动、滚动、光标、保存状态和公式缓存回填不改变内容修订号。应用另行维护 `documentEpoch`，在重新挂载、导入、恢复文档及切换 Sheet 时使旧任务失效。

需要盘点所有公共修改入口及内部管理器调用，不能只新增一个 `cell-change` 监听器。新增统一的提交事件供应用保存与失效检测使用，例如：

```js
{
  type: 'mutation-committed',
  mutationId: 'mutation-123',
  sheetId: 'sheet-1',
  revision: 18,
  source: 'edit', // edit、patch、undo、redo、import、structure
  changedCells: 3
}
```

不破坏原有事件契约。新增事件需要在批量修改和撤销路径中同样触发，并配套测试。

### 5.3 原子写入的实现要求

1. 写入前检查只读权限、活动 Sheet、预期版本、坐标边界、重复坐标、旧值前置条件和补丁大小。
2. 完成所有数据规范化、深拷贝和公式校验后，再进入写入阶段。
3. 单次提交同步执行，不在修改一半时 `await` 或让出主线程。大任务必须缩小范围，不能分帧写原表后宣称整体原子性。
4. 写入期间暂缓计算调度、持久化调度和对外修改通知；Store 批量通知本身不足以完成这些隔离。
5. 成功时只记录一个批量历史命令，推进版本，恢复调度并发送提交完成事件。
6. 提交前失败时恢复已触及的单元格、共享数值、依赖关系、待计算状态和持久化脏标记；保留原来的 undo/redo 栈。
7. 事件监听器在提交成功后报错，作为订阅错误处理，不将已经提交的操作伪装成回滚失败。
8. 不直接改公开 `bulkSetCells()` 的既有语义；新增受控接口，内部复用经过验证的更新逻辑。

预计涉及的现有文件：

- [Workbook.js](../src/core/Workbook.js)：公共入口和修订号。
- [WorkbookBuilder.js](../src/core/builder/WorkbookBuilder.js)：依赖注入和初始化。
- [History.js](../src/core/history/History.js)、[CommandExecutor.js](../src/core/history/CommandExecutor.js)：单次历史、撤销/重做事件与失败隔离。
- [FormulaRPNEvaluator.js](../src/core/data/FormulaRPNEvaluator.js)：复用解析结果的检查与平移能力。
- [PersistenceManager.js](../src/core/PersistenceManager.js)及相关管理器：提交期间副作用控制。
- [types/core.d.ts](../types/core.d.ts)、相关测试与 API 文档：公共契约保持同步。

这一阶段不改 Canvas 渲染算法，不改 WASM 计算语义，不重构无关模块。

## 6. AI 上下文与操作协议

### 6.1 上下文

请求分为两部分：

- 可信请求信封：由应用和服务端生成，包含文档、Sheet、版本、授权范围、请求 ID。
- 模型输入：用户要求、字段含义、类型、可用操作、经过授权的必要样本。

默认发送表头、字段类型和范围，不发送整表，也不默认发送数据样本。需要样本时，由用户明确授权。

区分三类权限：

1. 本地计算可以读取的范围。
2. 可以发送给模型的字段与样本。
3. 用户允许修改的目标范围。

读取公式结果时也要考虑依赖字段是否敏感；不能通过发送派生值绕过排除列规则。模型无权自行扩大任何范围。

### 6.2 首批操作白名单

| 操作 | 阶段 | 执行方 | 主要参数 |
| --- | --- | --- | --- |
| `fill_formula` | M1 | 本地 Workbook | 起始公式、起始坐标、目标范围 |
| `trim_text` | M2 | 本地规则执行器 | 范围、保留空值规则 |
| `normalize_date` | M2 | 本地规则执行器 | 输入格式枚举、输出格式、时区 |
| `mark_duplicates` | M2 | 本地规则执行器 | 比较列、是否忽略空值、标记列 |
| `aggregate` | M2 | 本地 Worker | 分组字段、度量、过滤条件、空值策略 |
| `classify_text` / `extract_text` | M4 | 服务端受限模型任务 | 授权文本列、输出字段、分类枚举 |

不开放 `execute_js`、任意 SQL、外部 URL 抓取、直接上传文件、删除工作表或任意 `set_cells` 工具。

### 6.3 完整计划示例

下面是服务端校验后返回的计划。身份、版本、范围字段来自请求信封，不采纳模型自行生成的同名字段。

```json
{
  "schemaVersion": 1,
  "kind": "plan",
  "runId": "run-123",
  "documentId": "doc-123",
  "documentEpoch": "epoch-123",
  "sheetId": "sheet-1",
  "baseContentRevision": 17,
  "allowedReadRanges": [
    { "s": { "r": 0, "c": 0 }, "e": { "r": 3, "c": 1 } }
  ],
  "allowedWriteRanges": [
    { "s": { "r": 1, "c": 2 }, "e": { "r": 3, "c": 2 } }
  ],
  "operations": [
    {
      "type": "fill_formula",
      "seedCell": { "r": 1, "c": 2 },
      "seedFormula": "=A2*B2",
      "targetRange": {
        "s": { "r": 1, "c": 2 },
        "e": { "r": 3, "c": 2 }
      }
    }
  ],
  "warnings": []
}
```

协议约束：

- 坐标统一从 0 开始；UI 中的 A1 地址仅用于展示。
- Schema 使用严格对象校验，拒绝未知字段、未知操作、负坐标、超限范围和任意表达式。
- M1 每个计划只有一个写操作，禁止多轮自动工具循环。
- 原表非空目标默认拒绝覆盖；用户扩大覆盖授权后重新生成预览和确认。
- 缺少列映射、日期口径或输出范围时返回 `requires_input`，不猜测后执行。
- 模型返回的流式片段只用于展示状态；完整 JSON 校验通过后才允许进入预览。

返回类型用 `kind` 区分：`plan` 必须携带操作数组，`requires_input` 必须携带待确认问题且不能携带可执行写操作。两种类型分别定义 Schema，不依赖解析自然语言来判断能否执行。

### 6.4 从计划到补丁

`OperationPlanner` 在本地读取真实旧值，按规则产生完整 `before/after` 补丁。旧值不能由模型提供。

公式以明确的公式字段存储，结果缓存交给引擎重算。替换公式或文本时显式处理旧 `f`、`m` 和缓存字段，避免浅合并遗留内容。

文本结果即使以 `=` 开头也必须作为字面文本处理，不能经由现有“字符串以等号开头即公式”的便捷写入路径。

补丁记录包含：

- 原始计划 ID、操作类型和 Schema 版本。
- `documentEpoch`、Sheet ID、内容修订号。
- 完整旧值、新值及影响数量。
- 规范化计划与补丁的摘要，用于将用户确认绑定到这一次预览。
- 预演错误、警告和来源范围。

确认后不再次调用模型重新生成补丁，也不按变化后的数据悄悄重算目标。

## 7. 预览、提交和撤销流程

### 7.1 执行顺序

1. 结束正在进行的单元格编辑；捕获当前文档、Sheet、修订号和授权范围。
2. `ContextBuilder` 生成最小上下文，发起 AI 请求。
3. 服务端完成鉴权、额度检查、模型调用和计划 Schema 校验。
4. 应用再次校验操作、权限、引用范围和当前版本。
5. 从原 Workbook 创建独立快照，在关闭持久化的临时 Workbook 中执行预演。
6. 预演覆盖整个目标范围，不只检查预览第一页；拒绝循环引用、越界引用和未支持公式。
7. 展示差异、影响数量和错误。M1 有公式错误时禁止应用，先修改要求或数据。
8. 用户确认后锁定当前文档的应用流程，暂停导入、切表等操作，先保存必要的基线。
9. 再次检查文档、Sheet、权限、修订号与确认摘要，调用 `applyCellPatch()`。
10. 将新快照与任务应用记录写入同一次 IndexedDB 事务，再异步排队云端保存。
11. 更新保存状态，释放应用锁，关闭临时 Workbook 和相关任务资源。

确认时数据变动返回 `STALE_PREVIEW`，要求重新预览；不得自动覆盖用户在模型响应期间做的修改。

### 7.2 状态机分离

```text
服务端生成：
queued -> generating -> ready
                    -> requires_input
                    -> failed
                    -> cancelled

客户端应用：
received -> validating -> preview_ready -> applying -> applied
                       -> rejected                 -> failed
                                      -> stale
                                      -> cancelled

本地保存：
dirty -> saving -> saved
                -> save_failed

云端同步：
local_only -> syncing -> synced
                      -> conflict
                      -> sync_failed
```

“模型生成完成”“原表已修改”“本地已保存”“云端已保存”是不同状态，UI 不合并成一个成功提示。

取消生成应中止上游请求；已经产生的模型成本可能仍需记账。取消预览只清理临时状态。原子提交开始后不接受中途取消，成功后由撤销处理。

### 7.3 撤销边界

- M1 的一次 AI 补丁对应一次原生 undo/redo。
- AI 任务上的快捷撤销只在它仍是当前 Sheet 最新内容操作时启用。
- 用户后续又做了手动编辑时，不能盲目调用 `undo()` 并声称撤销了某个旧 AI 任务。
- 切 Sheet、重新导入或刷新后，不提供原生历史跨会话恢复的假象；任务记录只保留审计信息。
- M3 的历史版本恢复是创建一个新云端版本，不删除已有版本，也不等同于原生 undo。

### 7.4 保存失败与崩溃

内存补丁原子性和磁盘持久化是两层保证：

- 内存提交失败：恢复原表，不产生部分修改或新历史记录。
- 内存提交成功、本地保存失败：保留内存结果，显示“未保存”，允许重试和导出，不声称已经持久化。
- 本地快照与已应用任务 ID 在同一 IndexedDB 事务提交，避免只保存其中一项。
- 重启后只恢复最后完整快照；未完成任务不能自动重放，需确认状态后重新预览。
- 云端重试只重试保存同一版本，不再次执行 AI 补丁。

## 8. 后端接口与模型适配

### 8.1 M1 接口

| 接口 | 请求或行为 | 返回 |
| --- | --- | --- |
| `POST /api/ai/runs` | 提交要求、上下文和可信信封；携带 `Idempotency-Key` | `202`、`runId` |
| `GET /api/ai/runs/:id` | 查询本人任务和最终结果 | 状态、计划或错误 |
| `GET /api/ai/runs/:id/events` | SSE 订阅；事件带递增 ID | `status`、`plan_ready`、`requires_input`、`error` |
| `POST /api/ai/runs/:id/cancel` | 取消生成，幂等 | 当前最终状态 |
| `GET /api/capabilities` | 获取功能开关、操作和大小限制 | 经版本化的能力清单 |

每个接口都校验会话和任务归属。澄清问题得到回答后创建新请求，可带 `parentRunId`，不无限续跑旧任务。

幂等键按用户和接口作用域隔离；相同键、相同请求返回原任务，相同键、不同请求返回冲突。取消与生成完成的竞争由服务端状态转换决定，客户端不能因此自动应用。

SSE 断开后可根据事件 ID 补取状态；事件已过期时通过任务查询接口恢复最终结果。不得因自动重连重复调用模型。

### 8.2 Provider

```js
generatePlan({
  prompt,
  context,
  operationSchema,
  signal,
  onProgress
});
```

- 只保留 DeepSeek `ModelProvider`；测试通过注入 fake `fetch` 覆盖正常计划、坏 JSON、越权范围、超时和取消等场景。
- 不做多模型路由，也不提供 Mock 运行时降级。
- 使用模型原生结构化输出或工具参数能力；不支持时仍须服务端完整解析和校验，不能提取任意 Markdown 代码块直接执行。
- 最多进行一次受限格式修复；所有尝试都计入成本和超时预算。
- 网络失败不能无限重试；明确取消、超时、限流、供应商失败和协议错误。
- SSE 不展示供应商内部推理内容，只展示面向用户的进度和最终计划。

### 8.3 错误码

至少定义 `INVALID_PLAN`、`UNSUPPORTED_FORMULA`、`OUT_OF_SCOPE`、`READ_ONLY`、`STALE_PREVIEW`、`LIMIT_EXCEEDED`、`AI_TIMEOUT`、`AI_CANCELLED`、`APPLY_FAILED`、`LOCAL_SAVE_FAILED`、`VERSION_CONFLICT`。

错误结构统一为 `{ code, message, retryable, requestId }`，不向浏览器返回 API Key、请求头、完整上游响应或服务器堆栈。

### 8.4 环境配置

服务端配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_MAX_TOKENS`、`AI_REQUEST_TIMEOUT_MS`、`AI_REPAIR_ATTEMPTS`、`AI_MAX_MODEL_REQUESTS`、`DATABASE_URL`、`SESSION_SECRET`。

前端只配置应用 API 地址和非敏感功能开关，不通过 `VITE_*` 暴露模型密钥。模型地址由部署者维护白名单，浏览器不能提交任意上游 URL。

开发默认 Web 端口 `8890`、API 端口 `8891`，冲突时修改配置，不终止用户已有进程。通过 Web 的 `/api` 代理保持同源。

M1 无正式账号时仅允许 localhost 试用，API 绑定回环地址，校验 Origin 和开发会话；禁止将带真实模型密钥的无鉴权演示直接暴露到公网。

## 9. 本地文档与云端持久化

### 9.1 本地只启用一个保存主体

产品应用使用 `LocalDocumentRepository` 负责文档恢复和保存：

- `TableDesigner` 设置 `enablePersistence: false`，不同时注入 `AutoSavePlugin`。
- 现有组件的自动保存能力保持不变，继续服务组件库使用者。
- 本地存储包括文档元数据、完整 Workbook 快照、任务摘要、已应用 mutation ID、待同步状态。
- 监听统一内容提交事件做防抖保存，初始建议 800ms；文档切换前显式 flush。
- 恢复完成前不允许发起 AI；创建新文档、导入和从云端恢复都生成新的 `documentEpoch`。
- 关闭页面时的异步 flush 不能作为唯一保障，正常编辑期间必须持续保存。

M1 先采用有规模上限的完整快照，不同时开发增量云同步。快照需要应用级格式版本、引擎版本和迁移策略。

### 9.2 三种版本不能混用

| 标识 | 管理方 | 用途 |
| --- | --- | --- |
| `documentEpoch` | 应用 | 区分加载会话和当前 Sheet 上下文，使旧响应失效 |
| `contentRevision` | Workbook | 检查本次预览与内存内容是否一致 |
| `serverRevision` | 服务端 | 防止不同标签页、设备或用户覆盖云端版本 |

### 9.3 M3 数据表

| 表 | 主要字段 | 约束 |
| --- | --- | --- |
| `users` | `id`、外部身份标识、创建时间 | 身份来自登录系统 |
| `documents` | `id`、`owner_id`、名称、`current_revision`、删除标记 | 首版仅本人可读写 |
| `document_versions` | 文档 ID、版本号、快照 JSONB、Schema 版本、创建时间 | `(document_id, revision)` 唯一 |
| `document_mutations` | 文档 ID、mutation ID、请求摘要、提交版本 | 同一 mutation 不重复提交 |
| `ai_runs` | 用户、文档、状态、模型、协议版本、最终计划、用量 | 保存必要记录，不默认保存整表上下文 |
| `usage_ledger` | run ID、尝试 ID、预留额度、实际用量 | 重试、幂等和结算可追踪 |

原始 XLSX 只有用户选择云端备份时才上传对象存储。对象键由服务端生成并绑定文档归属，不接受任意路径和公开下载 URL。

### 9.4 云端接口与并发

| 接口 | 用途 |
| --- | --- |
| `GET /api/documents` | 列出当前用户文档 |
| `POST /api/documents` | 创建文档 |
| `GET /api/documents/:id` | 获取元数据、当前版本与快照 |
| `PATCH /api/documents/:id` | 修改名称等元数据 |
| `PUT /api/documents/:id/snapshot` | 提交快照、`expectedServerRevision` 和 mutation ID |
| `GET /api/documents/:id/versions` | 查询版本列表 |
| `POST /api/documents/:id/restore` | 将指定历史快照恢复成一个新版本 |

保存时在数据库事务中校验所有者和预期版本，写入新快照及 mutation 记录，再推进当前版本。前端提供的 `owner_id`、角色和成功状态不作为鉴权依据。

版本比较与更新必须使用行锁，或带 `current_revision = expectedServerRevision` 条件的更新并检查影响行数，不能先查询版本再无条件更新。名称修改和历史恢复同样检查预期版本。

同一 mutation ID 的重试先查既有结果，避免服务端已成功但客户端丢失响应后重复生成版本；同 ID 不同内容拒绝。

版本落后返回 `409 VERSION_CONFLICT`。首版不自动合并，保留本地副本，允许重新加载或另存为新文档。云端保存失败不回滚用户的本地编辑。

账号优先接成熟 OIDC 或托管身份服务；使用 HttpOnly、Secure 会话 Cookie，写接口做 CSRF 防护。公网开放前必须完成鉴权和越权测试。

## 10. M2 与 M4 的具体实现

### 10.1 数据清洗

- `trim_text` 只处理文本，保留数值、空值和公式；不把手机号、身份证号转成数字。
- `normalize_date` 先确认输入格式，不用宽松 `Date.parse` 猜测 `01/02/2026` 的含义；日期与日期时间采用不同规则。
- 输出目标是文本日期还是 Excel 日期数值及显示格式，必须在计划中明确。无法解析的值保留原值并列出异常。
- `mark_duplicates` 明确比较列、大小写、空白和空值处理规则，只在授权的空白列写标记，不删除行。
- 所有清洗使用与公式相同的补丁、预览和原子写入流程，不单独开发一条不支持撤销的执行路径。

### 10.2 数据分析

- 模型只输出分组、过滤和度量计划。
- Worker 对授权完整范围计算，不依据样本推断全表统计。
- 过滤条件限定列、比较运算符和字面值；不接收 JavaScript 或任意 SQL。
- 结果附 Sheet、范围、过滤条件、参与行数、排除空值数和计算时的内容修订号。
- 用户点击来源时定位原表；内容变化后将旧结果标记为过期，不静默复用。
- 金额统计使用十进制库并明确舍入规则；现有公式引擎仍按其 JS 数值语义工作，不宣传财务级精度保证。
- M2 先在结果面板展示聚合表。写入新 Sheet、自动生成图表和跨表公式列为后续能力。

### 10.3 AI 批量填充

M4 才开启此功能：

1. 用户明确授权待提交的文本列和行范围，先展示预计调用规模与费用区间。
2. 小样本试跑并确认结果 Schema，例如只允许返回预设分类枚举。
3. 按批处理，初始每批 20 行、并发 2，均可由服务端调整。
4. 服务端记录批次状态、输入摘要和逐行错误；失败只重试对应批次。
5. 缓存键包含用户或租户、源文本、提示词版本、模型版本和输出 Schema，禁止跨租户复用敏感结果。
6. 结果回到客户端后再次检查来源版本，先预览再写入；原文被改过的行不能直接回填。
7. 大任务按明确批次确认和撤销，不宣称所有批次组成一个原子事务。

单实例内测可先使用 PostgreSQL 持久任务及有界 worker。达到多实例或明显积压后再引入独立队列，不在 M1 增加 Redis 和复杂调度基础设施。

## 11. 安全、规模和性能预算

### 11.1 默认试点限制

以下是拟定的保护阈值，不是当前性能测试结论；实施后根据固定设备测试调整。

| 项目 | 初始限制 |
| --- | --- |
| 导入文件 | 10MB；M1 仅开放单表 XLSX 和 CSV |
| 有值单元格 | 每文档 100,000 个 |
| 单次 AI 本地读取 | 当前 Sheet 最多 10,000 行 |
| 单次原子写入 | 最多 5,000 个单元格，包含标题和标记 |
| 模型样本 | 默认不发送；授权后最多 5 行、20 列 |
| 模型上下文请求体 | 32KB，不包括业务保存快照 |
| 单次生成 | 总预算 60 秒，最多一次格式修复 |
| 文档写并发 | 同一文档一次只允许一个 AI 应用流程 |

5,000 单元格限制与 10,000 行读取限制不同。超限写入要求用户缩小范围或明确拆批，不能无提示执行前一部分。

文件压缩后大小不能替代解压后资源检查。导入阶段还要限制实际行列、解码结果、耗时和内存；大文件支持取消，优先把解析隔离到可终止 Worker。复用现有解析库和转换逻辑，不另写 CSV/XLSX 解析器。

M1 对多 Sheet 文件明确告知处理范围并允许取消，不能默默只导入第一张却提示整本成功。导入先进入临时工作簿，成功后才创建或替换文档，失败不破坏旧文档。

### 11.2 安全要求

- 单元格、表头、文件名、模型返回文本全部视为不可信数据，不作为系统指令。
- 模型输出不得自行改变权限、目标文档、目标范围、URL 或操作白名单。
- AI 响应作为文本或经过清洗的 Markdown 渲染，不直接使用 `v-html`。
- 日志默认只记录请求 ID、状态、操作类型、数量、耗时和用量，不记录原始单元格、密钥和完整请求体。
- 服务端再次限制请求大小、任务并发、速率、用户额度和响应大小。
- 云端删除文档时处理历史版本、AI 任务及对象文件；保留周期和备份删除边界在上线前明确。
- 新函数、网络能力、结构操作默认关闭，逐项加测试后开放。

### 11.3 性能验收目标

- 首先用 1,000 行公式场景建立基线，再测试 5,000 单元格补丁上限。
- 将模型耗时、本地快照、预演、提交、保存分别计时，不把网络延迟混入引擎性能。
- 差异表只展示当前页，计算仍覆盖完整目标。
- 同步提交目标是不产生明显长时间卡顿；若固定测试设备上无法将提交控制在约 200ms 内，应降低单次写入上限或优化，不先承诺更大规模。
- 超时、超限或内存预算不足时不写原表，给出可操作的缩小范围建议。

## 12. 工作拆分与排期

按两名熟悉项目的工程师估算：一人主前端和引擎接入，一人主 API、协议与存储；测试共同负责。M1 至 M3 目标约 6 周，另留 1–2 周风险缓冲。

产品方案中的一周验证版可作为 DeepSeek 直连演示目标；具有原子写入、失败回滚和回归覆盖的可用验证版，按下表安排到第 2 周完成。

T01 已完成，结果见 [测试基线](./AI_TABLE_BASELINE.md)；T02 已建立三个 workspace、Web 入口、应用配置和 API 入口，页面由用户确认本地验收通过；T03 的协议、夹具和错误码已完成，协议 72 项测试通过；T04 的内容修订号、公式检查、逐行平移和原子补丁已实现，指定组合回归 152 项通过；T05 的 WorkbookHost、上下文、只读预览、任务状态、确认写入、撤销和重做已完成；T06 的 API、SSE、取消、幂等、安全边界和 DeepSeek 直连 Provider 代码接入已完成，Mock Provider 已删除，真实调用待人工验收；T07 的公式闭环已完成，本地文档保存与导入待实施。其余任务未开始。

| ID | 时间 | 任务与产物 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| T01（已完成） | 第 1 周前半 | 四组订单夹具、公式结果校验与既有 Workbook、历史、多表、导入导出基线 | 无 | 原有 206 项通过，新增后 217 项通过；未验证能力已记录 |
| T02（已完成） | 第 1 周前半 | workspaces、Web 入口、应用 Vite 配置、API 入口和独立测试 | T01 | 三个 workspace 已识别，原组件发布配置不变；Web 页面用户本地验收通过；API 不监听即可测试 |
| T03（已完成） | 第 1 周前半 | shared Schema、错误码和计划夹具 | T01 | 72 项协议测试通过，五类失败输入被拒绝 |
| T04（已完成） | 第 1–2 周 | 内容修订号、统一提交事件、公式检查、平移和原子补丁 | T01、T03 | 原子补丁 14 项专项、指定组合 152 项和相关核心 242 项测试通过；全量有 6 项协作服务测试待复验 |
| T05（已完成） | 第 1–2 周 | WorkbookHost 接入、上下文构建、可信信封比对、公式平移、临时 Workbook 预演、任务状态、确认写入、撤销和重做 | T02、T03 | 宿主接入与清理测试通过；只读预览 15 项、确认写入 5 项、AI 面板 6 项和 Web 41 项测试通过 |
| T06（代码完成，真实调用待验收） | 第 2 周 | API 请求、SSE、取消、幂等、安全边界和 DeepSeek 直连 Provider | T03 | API 27 项通过，断线不重复调用 Provider，未校验计划不进入表格；真实 DeepSeek 调用待人工验收 |
| T07（部分完成） | 第 2 周 | 公式闭环已完成；本地文档保存、导入预处理和刷新恢复待实施 | T04–T06 | 输入、预览、应用、撤销、重做流程通过；本地持久化验收待步骤 11 |
| T08 | 第 3 周 | trim、日期标准化、重复标记 | T07 | 异常数据保留，修改可预览和撤销 |
| T09 | 第 3–4 周 | 聚合 Worker、统计口径、来源定位 | T07 | 全量统计与基准一致，旧结果可识别 |
| T10 | 第 4 周 | 真实模型评测、规模限制、安全回归 | T08、T09 | 达到 M2 发布门槛 |
| T11 | 第 5 周 | 登录、会话、文档权限、PostgreSQL 迁移 | T07 | 任务和文档不可越权访问 |
| T12 | 第 5–6 周 | 云端快照、版本冲突、恢复、断网重试 | T11 | 双标签页不覆盖，重试不重复建版本 |
| T13 | 第 6 周 | 额度、监控、备份、内测部署和用户验证 | T10、T12 | 通过 M3 上线检查 |
| T14 | M3 之后 | 批量分类/提取、费用预估、缓存和批次恢复 | T13 | 确认成本后执行，失败按批次重试 |

关键路径是 `T01 → T03 → T04 → T07`。T04 通用引擎能力和 T05 前端闭环已完成；T06 完成真实 provider 与 T07 完成本地持久化前，不开放真实模型写入原表。

## 13. 测试与发布门槛

### 13.1 测试矩阵

| 层 | 必测内容 |
| --- | --- |
| 协议 | 坏 JSON、未知操作、未知字段、越界、重复目标、超大请求、伪造文档/Sheet/版本 |
| 公式 | 相对引用平移、字符串中的地址不被替换、未知函数、循环引用、除零、来源越权 |
| 补丁 | 多单元格一次提交、完整样式恢复、删除和空值区别、文本与公式区别 |
| 回滚 | 第 N 个单元格注入错误，数据、依赖、共享值、历史和脏标记均不留下部分变化 |
| 版本 | 手动编辑、粘贴、批量修改、样式、行列结构、undo/redo、导入均使旧计划失效 |
| 切表 | 生成期间切表、删除表、重新导入、关闭文档，旧结果绝不落到新目标 |
| 幂等 | 双击应用、相同 mutation 重试、同 ID 不同内容、服务端成功但响应丢失 |
| 保存 | IndexedDB 配额不足、关闭重开、快照与任务一致、云端离线与恢复 |
| 清洗 | 中文空格、前导零、空值、无效日期、日期歧义、公式不被当文本修改 |
| 分析 | 分组和过滤正确、完整行范围、缺失值策略、金额舍入、来源定位 |
| 鉴权 | 未登录、他人文档、他人任务/SSE、过期会话、CSRF、对象存储越权 |
| 模型 | 超时、限流、取消、提示注入、截断、格式修复失败、结果不确定性 |
| UI | 中文输入、粘贴、滚动、窄屏面板、状态反馈、按钮禁用、焦点恢复 |
| 包兼容 | 原有示例、包导出、类型、真实打包接入、Worker/WASM 路径 |

单元测试和 API 测试默认注入 fake `fetch`，不依赖真实密钥。真实模型评测独立运行并设置费用上限。

### 13.2 文件落点

- 引擎新增：`tests/core/WorkbookPatch.spec.js`、`WorkbookRevision.spec.js`、`FormulaInspection.spec.js`。
- 扩充现有 `History.spec.js`、`WorkbookSheets.spec.js`、`PersistenceManager.spec.js` 和类型测试。
- Web 测试放在 `apps/ai-web/tests`，API 测试放在 `apps/ai-api/tests`，协议测试放在 `packages/ai-contracts/tests`。
- 应用 E2E 使用独立配置，复用现有 Canvas 检查思路，不改变旧组件 E2E 的服务配置。
- 视觉检查覆盖常见桌面和窄屏视口，检查 Canvas 非空、公式结果、侧栏和差异面板无重叠。

### 13.3 放行标准

1. 基准订单场景完整通过，Excel 导出后公式和数值符合预期。
2. 取消和失效预览对原表零修改，注入失败无部分写入。
3. AI 补丁一次撤销能够恢复此前数据与样式，用户后续修改不被错误撤销。
4. 清洗和分析使用固定夹具全部通过，不以模型语言“看起来正确”作为验收。
5. 建立至少 50 个真实任务评测样本，覆盖正常、歧义、错误和恶意输入；首轮目标可执行正确计划占比至少 90%，歧义任务按正确澄清单独计分。
6. 越权写入、无确认写入、部分提交、密钥泄漏属于阻断发布的问题，不以整体成功率抵消。
7. 新增代码未破坏原包导出、现有组件使用方式和发布文件范围。

当前步骤 01–10 已完成，步骤 12 的 DeepSeek 直连 Provider 已完成代码接入，Mock Provider 已删除。步骤 05 的内容修订号、步骤 06 的公式检查/平移、步骤 07 的原子补丁、步骤 08 的 AI API 服务、步骤 09 的只读预览和步骤 10 的确认写入/撤销/重做已实现。原子补丁专项 14 项、指定组合回归 152 项、相关核心回归 242 项、API 27 项、只读预览 15 项、确认写入 5 项和 AI 面板 6 项通过。2026-09-15 的根目录全量检查 978 项通过、6 项协作服务启动失败；Web 41 项、核心补丁/历史 34 项、协议 72 项及运行时声明检查通过。沙箱外协作测试复验审批未获执行，全量不标记通过。代理未启动开发服务、未运行构建、未发起真实模型调用；本地文档保存、导入恢复、DeepSeek 真实调用与发布门槛仍未验收。

## 14. 部署、灰度与回退

- Web 静态资源与 `/api` 使用同一站点，SSE 路径关闭代理缓冲并配置合理空闲超时。
- API 只读任务和写入能力分别开关控制，例如 `AI_ENABLED`、`AI_APPLY_ENABLED`、`CLOUD_SAVE_ENABLED`。
- 初期在本地直接用 DeepSeek 验证预览与写入链路，再对少量账号开放确认写入。
- 模型不可用时，表格编辑、保存和导出仍可工作。
- 应用采用独立发布产物，不需要随着每次 AI 改动重新发布 npm 组件。
- 需要 SharedArrayBuffer 时验证现有 COOP/COEP 配置与资源来源；不可用时保留降级，不能让整个应用无法打开。
- 数据库迁移先做兼容性扩展；回退应用版本前验证旧版是否能读取新快照 Schema。
- 定期验证备份恢复。出问题时优先关闭 AI 应用入口，保留文档访问与导出，不回滚或删除用户数据。

记录计划通过率、预览应用率、版本冲突率、回滚次数、保存失败率、响应耗时和单个成功任务成本。上线试点以 5–10 位运营用户的真实表格为主。

## 15. 推荐提交顺序

1. `chore: scaffold ai web and api workspaces`：工程入口、隔离配置和基础测试。
2. `feat: define ai plan contracts`：协议、计划夹具和错误状态。
3. `feat(core): add atomic cell patches and content revisions`：通用 API 与回归测试。
4. `feat: add formula preview apply and undo workflow`：首个可用闭环。
5. `feat: add local documents and ai request lifecycle`：持久化、真实模型、取消和幂等。
6. `feat: add cleaning and aggregate operations`：M2 能力。
7. `feat: add authenticated cloud document versions`：M3 能力。

每个提交或 PR 都应带对应测试和边界说明。步骤 01–10 已完成并通过专项回归；补齐全量协作测试复验后，按步骤 11 实现本地文档保存与导入恢复，不跳过持久化事务或堆叠更多 AI 功能。
