# Primary Agent API

> **WARNING：前端已改走 WS，HTTP 仅供内部/调试，生产前端不要调用。** 启停由应用生命周期自动处理（启动拉起、退出停掉）；查状态走 WS `snapshot`；切 CLI 走 WS `configure_primary_agent`。完整迁移对照见下文 §迁移对照。

> **面向**：前端 UI（WS 消费 `snapshot` / `primary_agent.*` / `driver.*` 事件 + WS 上行 `prompt` / `configure_primary_agent`）。Agent 侧不操作自己的生命周期。

总控 agent（Leader）的生命周期接口。全项目单例：最多一条配置记录。

## 迁移对照（HTTP → WS）

| 旧 HTTP                              | 新路径（前端用）                                    |
|--------------------------------------|-----------------------------------------------------|
| `GET /api/primary-agent`             | WS `snapshot`（建连即收；后端每次 upgrade 推一次）   |
| `POST /api/primary-agent/config`     | WS 上行 `configure_primary_agent`                  |
| `POST /api/primary-agent/start`      | 前端废弃 — 应用启动自动拉起；后端端点保留供内部/调试 |
| `POST /api/primary-agent/stop`       | 前端废弃 — 应用退出自动停；后端端点保留供内部/调试   |

## 本期 configure 能力边界

WS 上行 `configure_primary_agent` **只支持 `cliType / name / systemPrompt`**。`mcpConfig` 字段形状复杂（嵌套 `serverName / mode / tools?`），本期 WS 不暴露；需要改 mcpConfig 仍走 HTTP `POST /api/primary-agent/config`。

## 前端对接清单（迁移 step-by-step）

1. 删掉 primaryAgentStore 里对 4 个 HTTP 端点（`GET /api/primary-agent` / `POST /config` / `POST /start` / `POST /stop`）的调用。
2. WS 客户端新增 `onSnapshot` 回调：收到下行 `{type:'snapshot'}` 时调用 `primaryAgentStore.applySnapshot(payload.primaryAgent)`。
3. `primaryAgentStore.configure(cli)` 改为发 WS 上行 `{op:'configure_primary_agent', cliType, requestId}`，收到 ack 后清 `inflightAction`；状态变化靠后续的 `primary_agent.configured/stopped/started` 事件（payload 已含完整 `row`，可直接 `applySnapshot(event.row)`）。
4. 保留 `debouncedRefresh` 语义，但源从 HTTP GET 改为 `applySnapshot` —— WS 断线重连时后端会再推一次 snapshot。

## TS 类型

```ts
interface McpToolVisibility {
  serverName: string;
  mode: 'all' | 'whitelist';
  tools?: string[];              // mode='whitelist' 时必填
}

interface PrimaryAgentRow {
  id: string;                    // 首次 configure 自动生成
  name: string;                  // 1~64 字符
  cliType: string;               // 非空，例如 'claude' / 'codex'
  systemPrompt: string;
  mcpConfig: McpToolVisibility[];
  status: 'STOPPED' | 'RUNNING';
  agentState: AgentState;        // 工作状态，snapshot 和 state_changed 事件均携带
  createdAt: string;             // ISO
  updatedAt: string;
}

type AgentState = 'idle' | 'thinking' | 'responding';
// idle=空闲  thinking=收到prompt正在思考(显示loading)  responding=大模型回复中(流式渲染)  

interface PrimaryAgentConfig {    // 全部可选，增量 upsert
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: McpToolVisibility[];
}
```

> 注意：这里的 `mcpConfig` 用 `{ serverName, mode, tools? }`，和模板里的 `availableMcps: McpToolVisibility[]`（`{ name, surface, search }`）不是同一结构，别混用。

## `GET /api/primary-agent`
读当前配置。未配置时返回 `200 + null`（不是 404）。

响应 `200`: `PrimaryAgentRow | null`

## `POST /api/primary-agent/config`
首次调用自动生成 `id`，之后都是 upsert。只传想改的字段。

**切 cliType 时，若正在运行，后端会自动 stop→start。**

请求体示例:
```json
{
  "name": "Leader",
  "cliType": "claude",
  "systemPrompt": "You are the team lead...",
  "mcpConfig": [
    { "serverName": "mteam-primary", "mode": "all" },
    { "serverName": "mnemo", "mode": "whitelist", "tools": ["search", "create_knowledge"] }
  ]
}
```

> **MCP 注入说明**：主 Agent 启动时，后端通过 `mcpManager.resolveForPrimary()` 注入 MCP：
> - **mteam-primary**（内置，无条件注入）— 4 个专属工具：`create_leader` / `send_to_agent` / `list_addresses` / `get_team_status`
> - **searchTools**（内置，无条件注入）— 工具搜索
> - **mnemo**（用户配置，透传）— 知识库记忆
> - mteam（成员/Leader 的团队工具）**不注入给主 Agent**，主 Agent 不在 `role_instances` 表中，mteam 工具对其无效

响应 `200`: `PrimaryAgentRow`

错误 `400`: `name` 长度 1~64；`cliType` 非空字符串；`systemPrompt` 为 string；`mcpConfig` 为数组，每项 `serverName` 非空、`mode` 为 `'all'|'whitelist'`；whitelist 时 `tools` 为 `string[]`。

## `POST /api/primary-agent/start`
要求已配置、对应 CLI 可用。fire-and-forget 由 bus 推事件。

响应 `200`: `PrimaryAgentRow`（status=RUNNING）

错误:
- `409 primary agent already running`
- `400 primary agent not configured`
- `400 cli '<name>' is not available`（先 `GET /api/cli` 确认）

## `POST /api/primary-agent/stop`
响应 `200`: `PrimaryAgentRow`（status=STOPPED）

错误 `409`: `primary agent is not running`

---

## 与 WS `prompt` op 的联动

前端发 prompt、收输出走两条不同通道：**HTTP 负责生命周期，WS 负责消息流**。

### 前端流程

1. `POST /api/primary-agent/start` 起 driver
2. WS 订阅相关 scope（见下）
3. 用 WS 上行 `prompt` op 发消息
4. 从 WS 下行 `driver.*` 事件读输出

### 上行 prompt（WS）

用户发消息是**直接对话**：后端调用 `driver.prompt(text)`，agent 收到用户原文，不经过 CommRouter / Envelope。只有 agent 间通信（MCP `send_msg`）才走 CommRouter 产生通知行。

```ts
interface WsPrompt {
  op: 'prompt';
  instanceId: string;     // 总控用 PrimaryAgentRow.id；成员用 RoleInstance.id
  text: string;
  requestId?: string;     // 回填 ack 用
}
```

后端立刻回 `ack`，真正结果通过 bus 事件推回：

```json
{ "op": "prompt", "instanceId": "pa_abc", "text": "hi", "requestId": "r1" }
→ { "type": "ack", "requestId": "r1", "ok": true }
```

失败返回 error：
- `not_ready` — driver 尚未 READY（未 start 或在启动中）
- `bad_request` — 字段缺失 / 类型错

### 下行 driver 事件（订阅后推送）

全部事件名：
- `driver.started` / `driver.stopped` / `driver.error`
- `driver.thinking` — 模型思考中
- `driver.text` — 文本输出片段
- `driver.tool_call` — 调用工具
- `driver.tool_result` — 工具结果
- `driver.turn_done` — 本轮结束

以及生命周期事件：
- `primary_agent.configured` / `primary_agent.started` / `primary_agent.stopped`
- `primary_agent.state_changed` — 总控工作状态变化（`agentState`：`idle` 空闲 / `thinking` 思考中，前端显示 loading / `responding` 回复中，前端做流式渲染）

### 订阅建议

总控实例用 `instance` scope，`id = PrimaryAgentRow.id`：

```json
{ "op": "subscribe", "scope": "instance", "id": "pa_abc" }
```

想拿全局生命周期（任何实例的 start/stop），再加一条 `global`：

```json
{ "op": "subscribe", "scope": "global" }
```

### 下行事件信封

```ts
interface WsEventDown {
  type: 'event';
  id: string;              // eventId，可作 lastMsgId 断线补发
  event: Record<string, unknown>;  // 剥去 source/correlationId 的 bus 事件
}
```

断线重连带 `lastMsgId` 会先收一条 `gap-replay` 再收 `ack`。
