# 实时协同真实项目接入指南

本文面向要把 `RealtimeCollaborationPlugin` 接入真实业务的开发者，覆盖前端初始化、服务端部署、鉴权与权限、断线恢复、反向代理、生产化演进和常见问题排查。

相关代码：

- 客户端插件：[../src/plugins/RealtimeCollaborationPlugin.js](../src/plugins/RealtimeCollaborationPlugin.js)
- 本地参考服务：[../scripts/collab-server.mjs](../scripts/collab-server.mjs)
- 协同示例：[../samples/basic-usage/src/AppCollab.vue](../samples/basic-usage/src/AppCollab.vue)

> `scripts/collab-server.mjs` 是协议参考和本地联调服务。它可以用于内网试点，但不建议未改造前直接暴露到公网生产环境。

---

## 1. 接入架构

推荐的真实项目架构：

```text
Vue 前端
  ↓ wss://your-domain.com/collab
Nginx / 网关
  ↓ WebSocket 反向代理
协同服务
  ├─ 登录态与文档权限校验
  ├─ 房间成员管理
  ├─ 心跳与异常清理
  ├─ 消息广播与 seq 分配
  ├─ 初始快照与断线补偿
  └─ 数据库 / Redis（生产扩展）
```

前端不直接信任任何“我是编辑者”的声明。只读权限最终必须由服务端判定并拦截写入消息。

---

## 2. 前端接入

### 2.1 初始化插件

`RealtimeCollaborationPlugin` 依赖 `CollaborativeCursorPlugin`，必须先创建光标插件：

```js
import {
  TableDesigner,
  createCollaborativeCursorPlugin,
  createRealtimeCollaborationPlugin
} from 'vue-canvas-sheet';

const cursorPlugin = createCollaborativeCursorPlugin({
  expireTime: 15000
});

const collabPlugin = createRealtimeCollaborationPlugin({
  serverUrl: 'wss://your-domain.com/collab',
  roomId: 'doc_10001',
  userId: 'user_10001',
  userName: '张三',
  userColor: '#3498db',

  // 连接鉴权。服务端设置 COLLAB_AUTH_TOKEN 时必传。
  token: 'short-lived-access-token',

  // 编辑权限。服务端设置 COLLAB_EDIT_TOKEN 时，编辑者必传。
  editToken: 'short-lived-edit-token',

  // 由业务权限系统决定，不要让用户随意修改。
  readOnly: false,

  autoConnect: true,
  heartbeatTimeoutMs: 20000
});

const plugins = [cursorPlugin, collabPlugin];
```

在组件中使用：

```vue
<template>
  <TableDesigner
    ref="table"
    :initial-data="initialData"
    :plugins="plugins"
    :read-only="isReadOnly"
  />
</template>
```

### 2.2 关键参数

| 参数 | 类型 / 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `string` / `null` | 协同服务地址。生产使用 `wss://`。 |
| `roomId` | `string` / `'default-room'` | 房间 ID。真实项目建议使用文档 ID、工作簿 ID 或资源 ID。 |
| `userId` | `string` / 随机值 | 用户 ID。必须来自登录态，刷新和重连后保持不变。 |
| `userName` | `string` / 自动生成 | 协作者显示名称。 |
| `userColor` | `string` / `'#3498db'` | 协作者颜色。 |
| `token` | `string \| function` | 访问令牌，映射到 URL 的 `token` 参数。 |
| `authTokenParam` | `string` / `'token'` | 访问令牌参数名。 |
| `editToken` | `string \| function` | 编辑令牌，映射到 URL 的 `editToken` 参数。 |
| `editTokenParam` | `string` / `'editToken'` | 编辑令牌参数名。 |
| `readOnly` | `boolean` / `false` | 客户端声明只读身份。服务端仍会二次拦截写入。 |
| `autoConnect` | `boolean` / `true` | 插件挂载后是否自动连接。 |
| `heartbeatTimeoutMs` | `number` / `20000` | 客户端检测服务端心跳超时的时间。 |
| `selectionThrottleMs` | `number` / `30` | 选区广播节流时间。 |

`token` 和 `editToken` 支持函数，可以在连接前动态获取短期票据：

```js
const collabPlugin = createRealtimeCollaborationPlugin({
  serverUrl: 'wss://your-domain.com/collab',
  roomId: documentId,
  userId: currentUserId,
  token: async () => (await getCollabTicket(documentId)).accessToken,
  editToken: async () => (await getCollabTicket(documentId)).editToken
});
```

> 当前协议令牌会放在 WebSocket URL 查询参数中。生产环境建议使用短期票据，并避免把长期密钥放入前端配置。

### 2.3 手动连接与断开

```js
collabPlugin.roomId = documentId;
collabPlugin.userName = currentUser.name;
collabPlugin.userColor = currentUser.color;
collabPlugin.readOnly = !canEdit;

collabPlugin.connect('wss://your-domain.com/collab');
```

断开：

```js
collabPlugin.disconnect();
```

连接成功后，插件会自动发送 `user-join`；断开前会尝试发送 `user-leave` 并清理本地协作者状态。

### 2.4 连接状态

```js
const info = collabPlugin.getConnectionInfo();
```

返回结构：

```js
{
  status: 'CONNECTED',
  roomId: 'doc_10001',
  userId: 'user_10001',
  userName: '张三',
  userColor: '#3498db',
  readOnly: false,
  memberCount: 3,
  members: [
    {
      userId: 'user_10001',
      userName: '张三',
      userColor: '#3498db',
      readOnly: false
    }
  ]
}
```

状态值：

| 状态 | 说明 |
| --- | --- |
| `CONNECTING` | 正在建立连接 |
| `CONNECTED` | 已连接 |
| `RECONNECTING` | 已断开，等待自动重连 |
| `OFFLINE` | 离线或重连放弃 |

监听状态变化：

```js
const off = workbook.on('collaboration-status', (info) => {
  connectionStatus.value = info.status;
  roomMembers.value = info.members;
});
```

### 2.5 权限事件

当服务端拒绝写入时，前端会收到：

```js
workbook.on('collaboration-permission-denied', (event) => {
  // event.messageType: 'cell-change' / 'comment-change' / ...
  // event.readOnly: true
});
```

收到该事件后，插件会把当前连接收敛为只读，并将 `Workbook.readOnly` 设置为 `true`。

---

## 3. 服务端接入

### 3.1 本地参考服务

本地联调：

```bash
node scripts/collab-server.mjs
```

默认监听：

```text
ws://0.0.0.0:8800
```

常用环境变量：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址。生产建议 `127.0.0.1`，由 Nginx 代理。 |
| `PORT` | `8800` | 监听端口。 |
| `COLLAB_AUTH_TOKEN` | 空 | 访问令牌。设置后，连接必须携带匹配 `token`。 |
| `COLLAB_EDIT_TOKEN` | 空 | 编辑令牌。设置后，只有携带匹配 `editToken` 的连接可写。 |
| `HEARTBEAT_INTERVAL_MS` | `5000` | 服务端心跳发送间隔。 |
| `HEARTBEAT_TIMEOUT_MS` | `15000` | 服务端心跳超时时间。 |

内网试点示例：

```bash
HOST=127.0.0.1 \
PORT=8800 \
COLLAB_AUTH_TOKEN=access-secret \
COLLAB_EDIT_TOKEN=edit-secret \
node scripts/collab-server.mjs
```

### 3.2 鉴权模式

#### 模式 A：本地开放模式

不设置 `COLLAB_AUTH_TOKEN`：

```bash
node scripts/collab-server.mjs
```

适合本机和内网联调。所有连接都可以进入，未声明 `readOnly=true` 的用户默认为编辑者。

#### 模式 B：访问鉴权

服务端：

```bash
COLLAB_AUTH_TOKEN=access-secret node scripts/collab-server.mjs
```

前端：

```js
createRealtimeCollaborationPlugin({
  token: 'access-secret'
});
```

#### 模式 C：访问鉴权 + 编辑权限

服务端：

```bash
COLLAB_AUTH_TOKEN=access-secret \
COLLAB_EDIT_TOKEN=edit-secret \
node scripts/collab-server.mjs
```

编辑者：

```js
createRealtimeCollaborationPlugin({
  token: 'access-secret',
  editToken: 'edit-secret',
  readOnly: false
});
```

只读用户：

```js
createRealtimeCollaborationPlugin({
  token: 'access-secret',
  readOnly: true
});
```

如果只读用户绕过前端直接发送 `cell-change`、`cell-change-batch`、`comment-change`、`cell-lock`、`cell-editing` 等写入消息，服务端会返回 `permission-denied`，不会广播给其他协作者。

### 3.3 真实业务鉴权建议

静态共享 token 只适合小规模内网试点。生产建议替换为业务登录态：

1. 前端向业务后端申请短期协同票据。
2. 票据包含 `userId`、`roomId`、`readOnly`、过期时间和签名。
3. WebSocket 握手时校验票据。
4. 服务端再次查询用户对文档的实际权限。
5. 连接期间权限变更时，服务端主动断开或更新连接权限。

推荐握手信息：

```text
GET /collab?roomId=doc_10001&userId=user_10001&ticket=xxx
```

服务端校验后固定该连接的身份：

```js
const auth = {
  roomId: ticket.roomId,
  userId: ticket.userId,
  readOnly: !documentService.canEdit(ticket.userId, ticket.roomId)
};
```

之后所有消息都必须校验 `roomId` 和 `userId` 是否与握手身份一致，防止连接后冒充他人或切换房间。

---

## 4. 协议与同步机制

### 4.1 消息类型

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `user-join` | 客户端 → 服务端 | 加入房间，可携带 `resume` 和 `lastSeq`。 |
| `user-leave` | 客户端 → 服务端 | 主动离开。 |
| `room-members` | 服务端 → 客户端 | 房间成员和只读状态。 |
| `selection-change` | 客户端 ↔ 服务端 | 远端选区和协作光标。 |
| `state-request` | 服务端 → 客户端 | 要求已有编辑者提供工作簿快照。 |
| `state-snapshot` | 客户端 → 服务端 → 新成员 | 完整工作簿快照。 |
| `sync-ready` | 服务端 → 客户端 | 同步阶段完成，可补发离线修改。 |
| `sync-reset` | 服务端 → 客户端 | 服务端序号重建，需要重新对齐。 |
| `cell-change` | 客户端 ↔ 服务端 | 单格修改。 |
| `cell-change-batch` | 客户端 ↔ 服务端 | 批量修改，每个单元格有独立 `seq`。 |
| `sync-ack` | 服务端 → 客户端 | 服务端确认收到修改并返回版本。 |
| `cell-lock` / `cell-unlock` | 客户端 ↔ 服务端 | 编辑锁。 |
| `cell-editing` | 客户端 ↔ 服务端 | 他人正在输入的临时草稿。 |
| `comment-change` | 客户端 ↔ 服务端 | 批注变更。 |
| `heartbeat-ping` | 服务端 → 客户端 | 心跳探测。 |
| `heartbeat-pong` | 客户端 → 服务端 | 心跳响应。 |
| `permission-denied` | 服务端 → 客户端 | 只读连接尝试写入。 |

### 4.2 初始同步流程

```text
新成员连接
  ↓ user-join
服务端广播 room-members / user-join
  ↓
服务端选择一个已有可编辑成员
  ↓ state-request
旧编辑者发送 state-snapshot
  ↓
服务端路由给新成员
  ↓
新成员 workbook.fromJSON(snapshot)
  ↓
新成员广播当前选区
```

如果房间内没有可编辑成员，服务端直接发送 `sync-ready`，不会向只读成员请求权威快照。

### 4.3 断线重连与补偿

客户端会记录服务端返回的最大 `seq`。重连时 `user-join` 携带：

```js
{
  type: 'user-join',
  roomId: 'doc_10001',
  userId: 'user_10001',
  resume: true,
  lastSeq: 128
}
```

服务端处理：

1. 补发其他用户 `seq > lastSeq` 的单元格修改。
2. 发送 `sync-ready`。
3. 客户端补发自己断线期间的本地修改。

### 4.4 冲突收敛

- 服务端为房间内每个单元格修改分配递增 `seq`。
- 批量修改中，每个单元格都有独立 `seq`。
- 客户端只应用更新的单元格版本。
- 重复、乱序、旧版本消息会被丢弃。
- 检测到旧版本时会触发 `collaboration-conflict` 事件。

这可以解决“同格并发编辑”和“延迟旧批量消息覆盖新数据”的问题。

### 4.5 多 Sheet 隔离

单元格、锁、输入草稿、批注和远端光标消息都携带 `sheetId`。客户端只会把消息应用到对应 Sheet，不会写入当前激活 Sheet。

---

## 5. 部署

### 5.1 Nginx 反向代理

```nginx
upstream vue_canvas_collab {
  server 127.0.0.1:8800;
  keepalive 64;
}

server {
  listen 443 ssl http2;
  server_name your-domain.com;

  # TLS 证书按实际环境配置
  # ssl_certificate ...
  # ssl_certificate_key ...

  location /collab {
    proxy_pass http://vue_canvas_collab;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 心跳周期为 5 秒，读超时需要大于心跳超时。
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    proxy_buffering off;
  }
}
```

前端地址：

```js
serverUrl: 'wss://your-domain.com/collab'
```

不要在生产使用明文 `ws://`，否则令牌、工作簿数据和批注内容都可能被网络中间层读取或篡改。

### 5.2 进程守护

可以使用 systemd、PM2、Docker 或 Kubernetes 管理协同服务。服务进程的基本要求：

- 只监听内网地址或 `127.0.0.1`。
- 由网关统一暴露 TLS。
- 随进程重启恢复必要状态。
- 对异常退出自动拉起。
- 输出连接数、房间数、消息量、心跳断开数和权限拒绝数。

---

## 6. 生产化要求

当前参考服务的状态主要保存在单个 Node 进程内存中。接入真实项目前，建议补齐以下能力。

### 6.1 权限中心化

服务端必须知道：

- 当前用户是谁
- 当前文档是哪个
- 用户能否查看
- 用户能否编辑
- 权限是否在连接期间变化

权限来源应来自业务系统，不应信任前端传入的 `readOnly`。

### 6.2 数据持久化

建议持久化：

- 工作簿权威快照
- 单元格变更日志
- 批注线程
- 房间元信息
- 审计日志

这样服务重启后可以恢复房间状态，也支持后续回滚和历史追踪。

### 6.3 多实例部署

单个进程内的 `Map` 无法跨实例共享房间状态。多实例时需要：

- Redis Pub/Sub 或消息队列广播房间消息
- Redis 或数据库共享房间成员、锁、心跳状态
- 根据文档或房间做一致性路由
- 或者使用支持跨节点广播的 WebSocket 网关

### 6.4 安全限制

建议增加：

- 请求体和消息大小限制
- 每用户消息频率限制
- 房间人数上限
- 单次批量修改单元格数量上限
- 行列范围校验
- URL 查询参数日志脱敏
- 恶意消息断开策略

### 6.5 可观测性

建议上报：

- 当前连接数
- 每房间人数
- 心跳超时次数
- 重连次数
- 消息延迟
- 快照大小和耗时
- 权限拒绝次数
- 服务端广播错误

---

## 7. 常见问题

### 7.1 后加入的人看不到之前的人

检查：

1. 两边 `roomId` 是否完全一致。
2. 两边是否连接同一个服务地址。
3. 页面是否仍连着旧进程。
4. 是否收到 `room-members`。
5. 服务端日志中是否出现两次 `joined room`。

### 7.2 后加入的人数据没有同步

检查：

1. 是否收到 `state-request`。
2. 旧编辑者是否发送 `state-snapshot`。
3. 新成员是否收到 `state-snapshot`。
4. 房间内是否存在可编辑成员；只有只读成员时不会提供权威快照。
5. 快照是否过大，被网关或服务端限制拦截。

### 7.3 只读用户仍然能改本地数据

前端应同时满足：

```js
collabPlugin.readOnly = !canEdit;
workbook.readOnly = !canEdit;
```

如果希望在只读协同查看时保留完整界面，可以给 `TableDesigner` 传入：

```vue
<TableDesigner
  :read-only="!canEdit"
  :show-editing-ui-in-read-only="!canEdit"
/>
```

此时工具栏和 Sheet 操作按钮仍会显示，但处于禁用状态；画布也保持只读，不会产生未同步的本地修改。

即使前端被绕过，服务端也会拒绝广播只读用户的写入消息。

### 7.4 连接频繁断开

检查：

1. Nginx `proxy_read_timeout` 是否小于心跳周期。
2. 客户端 `heartbeatTimeoutMs` 是否小于服务端心跳间隔。
3. 网关是否禁用 WebSocket 长连接。
4. 服务端是否被负载均衡反复重启。

推荐关系：

```text
HEARTBEAT_INTERVAL_MS < HEARTBEAT_TIMEOUT_MS < proxy_read_timeout
HEARTBEAT_INTERVAL_MS < client heartbeatTimeoutMs
```

### 7.5 服务重启后出现数据差异

当前参考服务的房间补偿日志在内存中。服务重启后：

- 已连接客户端会重新加入。
- 序号超过服务端记录时会收到 `sync-reset`。
- 客户端需要重新对齐快照。

生产环境应持久化快照和变更日志，减少服务重启带来的状态丢失。

---

## 8. 接入清单

上线前逐项确认：

- [ ] 前端使用 `wss://`
- [ ] `roomId` 绑定业务文档 ID
- [ ] `userId` 来自登录态且稳定
- [ ] 服务端校验访问权限
- [ ] 服务端校验编辑权限
- [ ] 只读用户无法写入并被服务端拒绝
- [ ] 新成员可以收到完整快照
- [ ] 断线重连后可以补偿离线修改
- [ ] 多 Sheet 消息按 `sheetId` 隔离
- [ ] 心跳超时会清理光标、锁和输入草稿
- [ ] Nginx WebSocket 超时配置正确
- [ ] 服务有持久化或多实例方案
- [ ] 有连接数、房间数和异常日志监控
