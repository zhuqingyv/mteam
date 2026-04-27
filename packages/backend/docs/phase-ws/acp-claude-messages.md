# Claude ACP 消息类型全表

> 调研日期：2026-04-25
> SDK 版本：`@agentclientprotocol/sdk@0.20.0`
> Claude ACP wrapper：`@agentclientprotocol/claude-agent-acp@0.30.0`
> 源：
> - SDK types.gen.d.ts：`node_modules/.bun/@agentclientprotocol+sdk@0.20.0+.../schema/types.gen.d.ts`
> - 历史调研：`packages/backend/docs/acp-research.md`、`packages/backend/docs/acp-deep-dive.md`、`packages/backend/docs/acp-verification-report.md`
> - 现有 adapter：`packages/backend/src/agent-driver/adapters/claude.ts`
> - mnemo 知识库：id 284 / 288 / 361

---

## 0. 顶层 wire format

所有 ACP 消息都是 JSON-RPC 2.0，以 `\n` 分隔的 NDJSON。核心分两类：

| 方向 | 类型 | method 举例 |
|------|------|-------------|
| Agent → Client | Notification（无 id） | `session/update` |
| Agent → Client | Request（有 id，需回复） | `fs/readTextFile`、`requestPermission`、`terminal/create` |
| Client → Agent | Response | `initialize` / `session/new` / `session/prompt` 的响应 |

**前端只需处理一种主要消息流：`session/update` 这个 Notification** — 它用 `params.update.sessionUpdate` 字段做 tagged union，其他字段随类型不同而变。

其他 Agent → Client 请求（`fs/*`、`terminal/*`、`requestPermission`）不是 UI 流式事件，而是 Agent 向 Client 反向请求，当前 mteam adapter 没有处理这些（不支持 loadSession、不响应 permission）。

---

## 1. sessionUpdate 类型清单（11 种）

SDK 定义位置：types.gen.d.ts:4331-4353。完整 tagged union：

```typescript
export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: "user_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_thought_chunk" })
  | (ToolCall & { sessionUpdate: "tool_call" })
  | (ToolCallUpdate & { sessionUpdate: "tool_call_update" })
  | (Plan & { sessionUpdate: "plan" })
  | (AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" })
  | (CurrentModeUpdate & { sessionUpdate: "current_mode_update" })
  | (ConfigOptionUpdate & { sessionUpdate: "config_option_update" })
  | (SessionInfoUpdate & { sessionUpdate: "session_info_update" })
  | (UsageUpdate & { sessionUpdate: "usage_update" });
```

外层包裹（types.gen.d.ts:4287-4306）：

```typescript
// 作为 JSON-RPC notification.params
export type SessionNotification = {
  _meta?: { [key: string]: unknown } | null;
  sessionId: SessionId;
  update: SessionUpdate;
};
```

---

### 1.1 `user_message_chunk`

- **触发时机**：Client 发送的用户消息被 Agent 回显（Claude 实现中不常出现，Claude 直接收 `session/prompt` 不回显 user chunk）。
- **payload**：

```typescript
{
  sessionUpdate: "user_message_chunk",
  content: ContentBlock,     // 一块内容
  messageId?: string | null, // UNSTABLE，消息分组 ID（UUID）
  _meta?: {...}
}
```

- **前端渲染**：用户气泡（若 Agent 确实回显）。

---

### 1.2 `agent_message_chunk`

- **触发时机**：Agent 的正式回复文本（Claude 的 `text` / `text_delta` content block）。
- **payload**：

```typescript
{
  sessionUpdate: "agent_message_chunk",
  content: ContentBlock,     // 多数为 { type: 'text', text: '...' }
  messageId?: string | null, // UNSTABLE
  _meta?: {...}
}
```

- **Claude ACP 映射**：SDK 源码把 Anthropic 的 `text` / `text_delta` → `agent_message_chunk`。
- **前端渲染**：聊天气泡，流式追加。**同一个 `messageId` 的 chunk 拼到同一气泡**。
- **当前 adapter**：已处理，走 `driver.text` 事件，只取 `content.text`。

---

### 1.3 `agent_thought_chunk`

- **触发时机**：Agent 内部推理（Claude 的 `thinking` / `thinking_delta` content block）。
- **payload**：与 agent_message_chunk 完全同构，只差 `sessionUpdate` 值。
- **Claude ACP 映射**（SDK `src/acp-agent.ts`）：

```typescript
case "thinking":
case "thinking_delta":
  update = { sessionUpdate: "agent_thought_chunk",
             content: { type: "text", text: chunk.thinking } };
```

- **前端渲染**：折叠思考块（可默认收起，点开展开）。
- **当前 adapter**：已处理，走 `driver.thinking`。
- **可靠性**：Claude 默认就开，实测稳定（`packages/backend/docs/acp-verification-report.md` §3）。Codex 在 ChatGPT auth 下实测 0 条。

---

### 1.4 `tool_call`

- **触发时机**：Agent 发起工具调用（Read/Edit/Bash/WebFetch/MCP 工具等）。
- **payload**（types.gen.d.ts:4885-4930）：

```typescript
{
  sessionUpdate: "tool_call",
  toolCallId: string,                     // 必填，会话内唯一
  title: string,                          // 必填，人类可读标题，如 "Reading src/main.ts"
  kind?: "read" | "edit" | "delete" | "move" | "search"
       | "execute" | "think" | "fetch" | "switch_mode" | "other",
  status?: "pending" | "in_progress" | "completed" | "failed",
  content?: ToolCallContent[],            // 产物内容（可空数组，后续 update 补）
  locations?: ToolCallLocation[],         // [{ path, line? }]
  rawInput?: unknown,                     // 工具参数原始值
  rawOutput?: unknown,                    // 工具结果原始值（tool_call 阶段通常空）
  _meta?: {...}
}
```

- **ToolCallContent**（types.gen.d.ts:4939-4945）：

```typescript
type ToolCallContent =
  | { type: "content", content: ContentBlock, _meta?: {...} }   // 普通输出
  | { type: "diff", path, newText, oldText?, _meta?: {...} }    // 文件改动
  | { type: "terminal", terminalId, _meta?: {...} };            // 终端引用
```

- **前端渲染**：工具调用卡片，显示图标（按 kind）、title、参数（rawInput）。初始状态 pending/in_progress。
- **当前 adapter**：已处理，映射为 `driver.tool_call { toolCallId, name: title, input: rawInput }`。**注意：丢弃了 `kind` 和 `locations`**，前端如果想按 kind 区分图标就拿不到。

---

### 1.5 `tool_call_update`

- **触发时机**：工具执行进度更新（pending → in_progress → completed/failed），以及补齐 output。
- **payload**（types.gen.d.ts:4994-5037）：

```typescript
{
  sessionUpdate: "tool_call_update",
  toolCallId: string,                     // 必填，关联到之前的 tool_call
  content?: ToolCallContent[] | null,     // 替换整个 content 集合
  kind?: ToolKind | null,                 // 可改
  locations?: ToolCallLocation[] | null,  // 可改
  rawInput?: unknown,                     // 可改
  rawOutput?: unknown,                    // 通常在 completed 阶段出现
  status?: ToolCallStatus | null,
  title?: string | null,                  // 可改
  _meta?: {...}
}
```

- **语义**：除 `toolCallId` 外所有字段都是可选「覆盖」；未提供的字段保留原值；content 是**全量替换**。
- **前端渲染**：同一 toolCallId 的卡片原地更新状态/输出。
- **当前 adapter**：只处理 `status === 'completed' || 'failed'`，映射为 `driver.tool_result { toolCallId, output: rawOutput, ok }`。**中间态 in_progress 更新、diff 内容、locations 变更全部丢弃**。

---

### 1.6 `plan`

- **触发时机**：Agent 输出执行计划（主 Claude Code 较少主动发，Claude ACP 当前版本未必转发）。
- **payload**（types.gen.d.ts:3208-3258）：

```typescript
{
  sessionUpdate: "plan",
  entries: Array<{
    content: string,                     // 任务描述
    priority: "high" | "medium" | "low",
    status: "pending" | "in_progress" | "completed",
    _meta?: {...}
  }>,
  _meta?: {...}
}
```

- **注意**：每次发送是**全量替换**（agent 必须带完整列表，client 整体替换旧 plan）。
- **前端渲染**：任务清单侧栏/顶部条，按 priority 排序。
- **当前 adapter**：**未处理**（落入 default → null）。

---

### 1.7 `available_commands_update`

- **触发时机**：Agent 可用的 slash-command 列表变更。
- **payload**（types.gen.d.ts:460-475 + 427-456）：

```typescript
{
  sessionUpdate: "available_commands_update",
  availableCommands: Array<{
    name: string,                        // 例 "create_plan"、"research_codebase"
    description: string,
    input?: { hint: string } | null,     // unstructured，text hint
    _meta?: {...}
  }>,
  _meta?: {...}
}
```

- **前端渲染**：输入框 `/` 触发的命令面板。
- **当前 adapter**：**未处理**。

---

### 1.8 `current_mode_update`

- **触发时机**：Agent 当前工作模式变更（Claude Code 的 plan mode / default mode 等）。
- **payload**（types.gen.d.ts:1031-1046）：

```typescript
{
  sessionUpdate: "current_mode_update",
  currentModeId: string,                 // 对应 session/new 响应里的 mode ID
  _meta?: {...}
}
```

- **前端渲染**：顶部模式指示（只读或切换器）。可用模式通过 `session/new` 响应的 `modes.availableModes` 下发。
- **当前 adapter**：**未处理**。

---

### 1.9 `config_option_update`

- **触发时机**：Agent 的可配置项（如 thought_level）变更。
- **payload**（types.gen.d.ts:787-802）：

```typescript
{
  sessionUpdate: "config_option_update",
  configOptions: Array<SessionConfigOption>,  // 全量替换
  _meta?: {...}
}
```

- **分类**：`SessionConfigOptionCategory` = `mode` | `model` | `thought_level`。
- **前端渲染**：设置面板。
- **当前 adapter**：**未处理**。

---

### 1.10 `session_info_update`

- **触发时机**：会话元数据变更（标题、最后活跃时间）。
- **payload**（types.gen.d.ts:4167-4186）：

```typescript
{
  sessionUpdate: "session_info_update",
  title?: string | null,                 // null = 清空
  updatedAt?: string | null,             // ISO 8601
  _meta?: {...}
}
```

- **前端渲染**：侧栏会话标题动态更新。
- **当前 adapter**：**未处理**。

---

### 1.11 `usage_update` _(UNSTABLE)_

- **触发时机**：token / cost 累计更新。
- **payload**（types.gen.d.ts:5088-5146）：

```typescript
{
  sessionUpdate: "usage_update",
  size: number,                          // 上下文窗口总大小
  used: number,                          // 已用 token
  cost?: { amount: number, currency: string } | null,
  _meta?: {...}
}
// 注：turn 结束时 session/prompt 响应还带更详细的 Usage:
// { totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens? }
```

- **前端渲染**：底部 token 条 / cost 指示。
- **当前 adapter**：**未处理**。
- **稳定性**：标记 experimental，可能变。

---

## 2. ContentBlock 类型（types.gen.d.ts:838-848）

用于 `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` 的 `content` 字段，以及 `ToolCallContent.type=="content"` 里的 `content` 字段。

```typescript
type ContentBlock =
  | (TextContent & { type: "text" })
  | (ImageContent & { type: "image" })
  | (AudioContent & { type: "audio" })
  | (ResourceLink & { type: "resource_link" })
  | (EmbeddedResource & { type: "resource" });
```

| type | 必备字段 | 能力要求 |
|------|---------|---------|
| `text` | `text: string`, `annotations?` | 所有 Agent 必须支持 |
| `image` | `data: string` (base64), `mimeType` | `promptCapabilities.image` |
| `audio` | `data: string` (base64), `mimeType` | `promptCapabilities.audio` |
| `resource_link` | `uri, name, mimeType?, size?, title?, description?` | 所有 Agent 必须支持 |
| `resource` | `resource: TextResourceContents \| BlobResourceContents` | `promptCapabilities.embeddedContext` |

**Claude 实际下发**：
- 正式回复/思考：几乎全是 `{ type: 'text', text: '...' }`。
- 工具结果里偶见 `{ type: 'resource_link' }`（文件引用）或 `{ type: 'image' }`（截图工具）。

**当前 adapter 的 `extractText`**（claude.ts:73-78）只认 `type === 'text'`，其他一律返回空串 — 遇到 image/resource 会**静默丢失**。

---

## 3. Agent → Client 反向请求（非 session/update）

这些不是 UI 流式事件，但 Agent 会发，**Client 必须响应**，否则 Agent 会卡住。当前 mteam 若使用 `@agentclientprotocol/sdk` 的 Client base class，未实现的请求会自动回 `method not found`，多数场景 Agent 能降级。

| method | params | 何时发 | Client 需实现 |
|--------|--------|--------|--------------|
| `fs/readTextFile` | `{ sessionId, path, line?, limit? }` | Agent 想读文件（需要 `fs.readTextFile` 能力） | 读文件返回 `{ content }` |
| `fs/writeTextFile` | `{ sessionId, path, content }` | Agent 想写文件（需要 `fs.writeTextFile` 能力） | 写文件返回 `{}` |
| `requestPermission` | `{ sessionId, toolCall, options: [{ optionId, name, kind }] }` | 执行前需要用户授权（allow_once/allow_always/reject_once/reject_always） | 返回 `{ outcome: {type:"selected", optionId} \| {type:"cancelled"} }` |
| `terminal/create` | `{ sessionId, command, args?, env?, cwd?, outputByteLimit? }` | Agent 要跑命令（需要 `terminal` 能力） | 创建 PTY 返回 `{ terminalId }` |
| `terminal/output` | `{ sessionId, terminalId }` | 轮询输出 | 返回 `{ output, truncated, exitStatus? }` |
| `terminal/wait_for_exit` | `{ sessionId, terminalId }` | 阻塞等终端结束 | 返回 `{ exitCode?, signal? }` |
| `terminal/kill` | `{ sessionId, terminalId }` | 终止 | 返回 `{}` |
| `terminal/release` | `{ sessionId, terminalId }` | 释放引用 | 返回 `{}` |

**关键**：mteam 声明 `clientCapabilities` 时可以全部关（`fs=false`, `terminal=false`），此时 Agent 会走 **Claude 进程自己的 fs/terminal**，不反向请求 Client。**当前 mteam 这样就最省事**（Claude 本来就有能力自己读写文件、跑命令）。

只有在 mteam 想拦截文件/终端操作（权限审计、sandbox）时才需要实现。

---

## 4. 当前 adapter 处理 vs 遗漏对照

文件：`packages/backend/src/agent-driver/adapters/claude.ts`

| sessionUpdate | adapter 处理 | 映射事件 | 遗漏 / 风险 |
|---------------|--------------|----------|-------------|
| `user_message_chunk` | 否 | — | Claude 不常发，暂可不管 |
| `agent_message_chunk` | 是 | `driver.text` | **丢 `messageId`**（无法判分段）；仅取 `content.text`，其他 ContentBlock 类型全丢 |
| `agent_thought_chunk` | 是 | `driver.thinking` | 同上，丢 messageId；非 text 类型丢失 |
| `tool_call` | 是 | `driver.tool_call` | **丢 `kind`、`status`、`locations`、`content`（初始）、`title` 只借作 name** |
| `tool_call_update` | 部分 | `driver.tool_result` (仅 completed/failed) | **中间态 in_progress 全丢**；**content 里的 diff/terminal 全丢**；locations、title 变更丢 |
| `plan` | 否 | — | 计划清单完全看不到 |
| `available_commands_update` | 否 | — | slash-command 面板无数据 |
| `current_mode_update` | 否 | — | 模式切换不同步 |
| `config_option_update` | 否 | — | 配置 UI 拿不到动态值 |
| `session_info_update` | 否 | — | 会话标题无法自动更新 |
| `usage_update` | 否 | — | token/cost 统计拿不到 |

**Agent→Client 反向请求**：adapter 未实现（由 SDK Client base 默认 `method not found`），目前 Claude 靠自己能力绕过。若未来开 `fs`/`terminal` 能力，必须加响应。

---

## 5. 前端事件映射建议（对应 Phase WS TASK-LIST）

以下是补齐遗漏后，后端 → 前端 WS 事件的建议映射。mteam 当前走 `DriverEvent`，WS 再转发到前端。

| ACP sessionUpdate | 建议 DriverEvent | 前端 UI |
|-------------------|------------------|---------|
| agent_message_chunk | `driver.text { messageId, text }` | 聊天气泡，按 messageId 聚合 |
| agent_thought_chunk | `driver.thinking { messageId, text }` | 折叠思考块，按 messageId 聚合 |
| tool_call | `driver.tool_call { toolCallId, title, kind, status, input, locations }` | 工具卡片（按 kind 选图标） |
| tool_call_update | `driver.tool_update { toolCallId, status?, output?, diff?, content?, locations? }` | 原地更新卡片（pending → in_progress → completed/failed） |
| plan | `driver.plan { entries[] }` | 顶部/侧栏任务清单 |
| available_commands_update | `driver.commands { commands[] }` | `/` 命令面板 |
| current_mode_update | `driver.mode { currentModeId }` | 模式指示 |
| config_option_update | `driver.config { options[] }` | 设置面板（动态） |
| session_info_update | `driver.session_info { title?, updatedAt? }` | 侧栏标题 |
| usage_update | `driver.usage { used, size, cost? }` | 底部 token 条 |

prompt turn 结束（`session/prompt` 响应）还有：
- `stopReason`: `end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`
- `usage`: `{ totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens? }`

建议转成 `driver.turn_end { stopReason, usage? }`，前端用来解锁输入框。

---

## 6. 实际调用样本

未在本次任务实跑（用户任务聚焦类型穷举）。历史调研文档已抓到 wire format 样本：

- `packages/backend/docs/acp-deep-dive.md` §6 附录 D — agent_thought_chunk / agent_message_chunk / tool_call / requestPermission 四条 JSON
- `packages/backend/docs/acp-verification-report.md` §3 — Claude 实测 agent_thought_chunk 默认开启有内容

Claude CLI 本地可用（`/Users/zhuqingyu/.local/bin/claude`），如需回归测试可跑：

```bash
# 注意：@agentclientprotocol/claude-agent-acp 需要 Anthropic API Key
ANTHROPIC_API_KEY=xxx npx -y @agentclientprotocol/claude-agent-acp@0.30.0
# 然后在 stdin 写入：
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":20,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}},"clientInfo":{"name":"mteam","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<id>","prompt":[{"type":"text","text":"读一下 /tmp/x.txt"}]}}
```

---

## 7. 与 Codex ACP 对照（research-codex 回传，2026-04-25）

姊妹文档：`packages/backend/docs/phase-ws/acp-codex-messages.md`。Codex 侧实测 `@zed-industries/codex-acp@0.9.5`，Claude 侧本地无 API key 未实跑；以下对照结合 Codex 实测 + Claude ACP SDK 源码 + 历史调研（`acp-verification-report.md` §3）。

### 7.1 大结论

- **sessionUpdate 11 种两家共享**，无厂商新类型值。SDK 屏蔽了协议类型差异。
- **Codex 实测活跃 5 种**：agent_message_chunk / tool_call / tool_call_update / available_commands_update / usage_update。
- **Claude 实测活跃**（历史调研，见 `acp-verification-report.md` §3）：agent_thought_chunk / agent_message_chunk / tool_call / tool_call_update。
- **厂商扩展都在字段层、不在类型层**：Codex 往 `rawInput`/`rawOutput` 塞 unified_exec 上下文（command/cwd/parsed_cmd/stdout/stderr/exit_code/duration/formatted_output），Claude 则是工具原生参数/返回值 — 前端要按 agent 选不同渲染组件。

### 7.2 对照表（补齐 Codex 回传的关键差异）

| 比较点 | Claude (0.30.0) | Codex (0.9.5 / mteam pin 0.11.1) |
|--------|-----------------|----------------------------------|
| 协议版本（initialize.result.protocolVersion） | `20` | **`1`** ← 差异大但 SDK 已屏蔽；**Driver 层不要做强校验** |
| sessionUpdate 种类（SDK 层） | 11 种全部合法 | 同 |
| 实测活跃种类 | agent_thought_chunk / agent_message_chunk / tool_call / tool_call_update | agent_message_chunk / tool_call / tool_call_update / available_commands_update / usage_update |
| **thinking 可靠性** | **高**（默认开，实测稳定） | **低**（ChatGPT auth 下 0 条，源码支持但线上拿不到） |
| `tool_call.kind` | 基本只用 `other` | 稳定使用 `read`/`edit`/`execute` |
| `tool_call.title` | 多为工具名（"Bash"/"Read"） | LLM 生成语义标题（"Read hostname"） |
| `tool_call.locations` | 偶尔填 | 填了 `path` |
| `tool_call.rawInput` | 工具原生参数字典（如 `{ file_path, offset }`） | Codex unified_exec 上下文 `{ call_id, process_id, turn_id, command, cwd, parsed_cmd, source }` |
| `tool_call_update.rawOutput` | 工具原生返回 | 扩展 `{ stdout, stderr, aggregated_output, exit_code, duration{secs,nanos}, formatted_output, status }` |
| `tool_call_update` 中间态 | 可能发 in_progress（待实测） | 实测**跳过 in_progress**，tool_call 阶段已 in_progress，update 直接 completed/failed |
| `tool_call_update.content` (ACP 标准结构化) | 走 content（含 diff/terminal） | **Codex 不下发**，靠 `rawOutput.formatted_output` 字符串 |
| `session/new.result` 额外字段 | `modes` + `configOptions` | `modes` + **`models`（UNSTABLE SessionModelState）** + `configOptions`；Claude 0.30 暂不发 `models` |
| `configOptions.category` | 未实测确认具体类目 | 明确三个：`mode` / `model` / `thought_level`（后者选 `reasoning_effort` low/medium/high/xhigh 四档） |
| `available_commands_update` | 未观察到主动发（Claude adapter 未处理） | **session/new 后立即发一次**（review/review-branch/review-commit/init/compact/undo/logout 共 7 条） |
| `usage_update` | 未实测（本次未跑） | **每轮 turn 结束前发一次**；`{ used, size }`，不带 `cost` |
| `plan` | SDK 支持；Claude 主进程有 TodoWrite，ACP 层未实测是否主动 emit | Codex 源码未翻到 emit，**实测不发** |
| `session/prompt` 响应 | SDK 允许带 `usage`（Usage 对象） | 实测**只带 `stopReason`**，token 统计完全靠 `usage_update` |
| MCP HTTP transport 支持 | `mcpCapabilities.http`（需实测） | `http: true`（实测） |
| prompt 注入方式 | `_meta.systemPrompt.append` | `-c model_instructions_file=<tmp>`（落盘文件，见 mnemo id 294） |
| MCP 子进程 env | process.env 全继承 | 白名单隔离，走 `session/new.mcpServers[].env` |

### 7.3 adapter 代码层差异（仅供参考）

`packages/backend/src/agent-driver/adapters/claude.ts` 与 `codex.ts` 的 `parseUpdate` **几乎同代码**（4 分支同逻辑），合理 — ACP SDK 屏蔽了协议差异；但 adapter 把 `input`/`output` 原样透传时，**前端必须知道形状因 agent 不同**。

| 维度 | Claude adapter | Codex adapter |
|------|----------------|---------------|
| `prepareLaunch` | npx `@agentclientprotocol/claude-agent-acp` | npx `@zed-industries/codex-acp` + `-c model_instructions_file=<tmp>` |
| `sessionParams` | `{ _meta: { systemPrompt: { append } } }` | `{}`（prompt 已落盘通过 CLI flag 传） |
| `parseUpdate` 分支 | user/agent_message/agent_thought/tool_call/tool_call_update | 完全同构 |
| `cleanup` | no-op | `unlinkSync(promptFile)` |

### 7.4 对 Phase WS 前端/Driver 设计的可操作结论

1. **`available_commands_update` 必须接** — Codex 开局就发，前端想做 `/` 命令面板必需。
2. **`usage_update` 建议接** — Codex 每轮都发，token 进度条数据源；Claude 行为待实测，先接住不吃亏。
3. **`driver.tool_call.input` / `driver.tool_update.output` 在 adapter 层统一成 envelope**：推荐 `{ agentKind: 'claude'|'codex', raw: unknown }`，前端按 agentKind 选卡片组件。
4. **thinking UI 必须降级**：Claude 有、Codex 无（auth 相关）；`agent_thought_chunk` 缺席不代表出错。
5. **Driver 启动时不要校验 protocolVersion**（Claude 20 / Codex 1 / spec 22，全部交给 SDK 处理）。
6. **session/new 响应里的 `models`/`modes`/`configOptions` 要透传给前端**，否则模型选择器、模式切换器、reasoning_effort 选项都做不出。

---

## 8. 一句话总结

Claude ACP session/update 共 **11 种 sessionUpdate**，当前 mteam adapter 只认 **4 种**（agent_thought_chunk / agent_message_chunk / tool_call / tool_call_update），并且在这 4 种里还丢了 `messageId`、`kind`、`status`、`locations`、`diff` 等关键字段。若 Phase WS 前端要做完整的聊天 + 思考 + 工具卡片 + 计划 + 命令面板 + token 条 UI，adapter 和 DriverEvent 需补齐这 7 类未处理的 sessionUpdate 以及现有 4 类的字段丢失。
