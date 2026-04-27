# Codex ACP 消息类型全表

> 调研日期：2026-04-25
> Codex ACP wrapper：`@zed-industries/codex-acp@0.9.5`（本机 npx 缓存实测版本；mteam 当前 pin 0.11.1）
> 底层：Codex CLI `0.118.0`（`/Users/zhuqingyu/.nvm/versions/node/v20.19.4/bin/codex`）
> SDK 版本：`@agentclientprotocol/sdk@0.20.0`（两家共用同一套 schema）
> 源：
> - SDK `types.gen.d.ts`：`node_modules/.bun/@agentclientprotocol+sdk@0.20.0+.../schema/types.gen.d.ts`
> - 历史调研：`docs/acp-research.md`、`docs/acp-deep-dive.md`、`docs/acp-verification-report.md`、`docs/cli-output-samples.md`
> - 现有 adapter：`packages/backend/src/agent-driver/adapters/codex.ts`
> - mnemo 知识：id 300、id 294（prompt 注入走 model_instructions_file）、id 356、id 361
> - Claude 对照：`docs/phase-ws/acp-claude-messages.md`（同一任务批次的姊妹文档）

---

## 0. 顶层 wire format 与 Claude 的区别

`@zed-industries/codex-acp` 是 Rust 二进制（通过 npm 分发 `codex-acp-<platform>` optional dep 拉下来），启动后在 stdin/stdout 讲 **同一套 ACP JSON-RPC 2.0 NDJSON**。这是关键事实：

- **Codex 和 Claude 共享 `SessionUpdate` 这一个 tagged union**。sessionUpdate 值、字段都来自同一个 SDK schema（`types.gen.d.ts:4331-4353`）。
- 差异只有两处：
  1. **哪些 sessionUpdate 类型会被触发、以及各自字段里装什么内容**（Codex 往 `rawInput`/`rawOutput` 里塞大结构、Claude 基本不塞）。
  2. **session/new 的响应里 Codex 多带 `models` 字段**（UNSTABLE 的 SessionModelState）— 这个已经在 0.9.5 实测里看到了；Claude ACP 0.30.0 只回 `modes` + `configOptions`。

本文档只列 Codex 实测 / 源码层面能确定的行为，其他类型保留 SDK 规范描述（Codex 可能未来再开）。

实测来源：2026-04-25 本机跑了两次真实 ACP 握手（probe script），prompt 分别是：
- "Run ls /tmp briefly then tell me 2+2"
- "Read /etc/hostname with the shell tool and tell me what you see"

观察到的 `sessionUpdate` 值集合：`available_commands_update` / `agent_message_chunk` / `usage_update` / `tool_call` / `tool_call_update`。**未观察到** `agent_thought_chunk`（ChatGPT auth 下，与 `acp-verification-report.md` §3 结论一致）。

---

## 1. Codex 实测响应 / 事件全表

### 1.1 `initialize` 响应（Agent → Client，id=1）

实测 payload（完整）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {
        "image": true,
        "audio": false,
        "embeddedContext": true
      },
      "mcpCapabilities": { "http": true, "sse": false },
      "sessionCapabilities": { "list": {} }
    },
    "authMethods": [
      { "id": "chatgpt", "name": "Login with ChatGPT", "description": "..." },
      { "id": "codex-api-key", "name": "Use CODEX_API_KEY", "description": "..." },
      { "id": "openai-api-key", "name": "Use OPENAI_API_KEY", "description": "..." }
    ],
    "agentInfo": { "name": "codex-acp", "title": "Codex", "version": "0.9.5" }
  }
}
```

Codex 特有：
- `protocolVersion: 1`（Claude 回 `20`，spec 用的是 `22`）。**版本协商差异要在 Driver 里忍住**，现在 AgentDriver 初始化时不做强校验。
- `mcpCapabilities.http = true` — Codex 支持 MCP Streamable HTTP 作为外部 MCP 传输（对 Stage 4 内置 MCP HTTP 化是顺风）。
- `authMethods` 三种，默认登录走 `chatgpt`，若项目需要稳定 thinking 推测要走 `openai-api-key`。

### 1.2 `session/new` 响应（Agent → Client，id=2）

实测（拆摘要，完整太长）：

```json
{
  "id": 2,
  "result": {
    "sessionId": "019dc57f-99d0-7ee1-8676-a7381321a2fc",
    "modes": {
      "currentModeId": "auto",
      "availableModes": [
        { "id": "read-only", "name": "Read Only", "description": "..." },
        { "id": "auto", "name": "Default", "description": "Identical to Agent mode" },
        { "id": "full-access", "name": "Full Access", "description": "..." }
      ]
    },
    "models": {
      "currentModelId": "gpt-5.3-codex/medium",
      "availableModels": [ /* 30+ 模型 */ ]
    },
    "configOptions": [
      { "id": "mode", "category": "mode", "type": "select", "currentValue": "auto", "options": [...] },
      { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-5.3-codex", "options": [...] },
      { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "medium", "options": [...] }
    ]
  }
}
```

Codex 特有：
- **`models` 字段（UNSTABLE）**：`SessionModelState`，Claude ACP 0.30 当前响应里没有。UI 如果要做模型选择器，Codex 上能拿到，Claude 暂时拿不到。
- **三个一等 `configOptions`**：`mode` / `model` / `reasoning_effort`（前两个和上面字段重复，冗余是 SDK category 映射规则决定的，不是 Codex bug）。
- `reasoning_effort` 的四档 `low / medium / high / xhigh` — mteam 若要自定义 thinking 深度，这是唯一的 ACP 层开关（除了 CLI -c 覆盖）。

### 1.3 会话级事件（session/update notifications）

实测观察到的 `sessionUpdate` 类型按时间顺序：

| # | sessionUpdate | 何时发 | 核心字段 |
|---|---------------|--------|----------|
| 1 | `available_commands_update` | session/new 返回后立即发一次 | `availableCommands[]` |
| 2 | `agent_message_chunk` × N | prompt 处理中持续发 | `content: { type: 'text', text }` |
| 3 | `usage_update` | 每次 turn 结束前发一次 | `used`, `size` |
| 4 | `tool_call` | Agent 决定调工具时 | 完整 payload 见下 |
| 5 | `tool_call_update` | 工具完成/失败 | 带 `rawOutput` |

实测 **没看到** 的类型（但 SDK 允许）：`user_message_chunk`、`agent_thought_chunk`、`plan`、`current_mode_update`、`config_option_update`、`session_info_update`。下面逐个列出 payload。

---

## 2. sessionUpdate 类型逐条（11 种）

全部走外层 `SessionNotification`（types.gen.d.ts:4287-4306）：

```typescript
{ _meta?, sessionId: SessionId, update: SessionUpdate }
```

### 2.1 `user_message_chunk`

- **Codex 实测**：**未观察到**（Codex 不回显用户消息）。
- **SDK 定义**：同 Claude，`ContentChunk + { sessionUpdate: "user_message_chunk" }`。
- **字段**：`content: ContentBlock`、`messageId?: string | null` (UNSTABLE)、`_meta?`。

### 2.2 `agent_message_chunk`（实测✅）

- **Codex 实测 payload**（单 token 流）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "019dc57f-de97-7383-a9b3-ef778c96a4e0",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "I" }
    }
  }
}
```

- **特点**：Codex chunk 粒度非常细（单个 token/子词），一次 turn 几十条是常态。
- **Codex 暂不下发 `messageId`**（Claude 也不下发，UNSTABLE 字段两家都还没实现）。
- **与 Claude 对比**：完全同构，行为一致。
- **当前 codex adapter**：已处理，映射到 `driver.text { content: text }`。只取 `content.text`，其他 ContentBlock 类型会丢。

### 2.3 `agent_thought_chunk`

- **Codex 实测**：**未观察到**（当前 ChatGPT auth 下 Codex 服务端不返回 reasoning summary → ACP 层面收到 0 条，与 `acp-verification-report.md` §3 一致）。
- **源码级确认存在**（`docs/acp-deep-dive.md` §5.4 引的 `codex-acp/src/thread.rs`）：

```rust
EventMsg::AgentReasoningContentDelta { delta, .. } => {
    client.send_agent_thought(delta).await;  // -> agent_thought_chunk
}
EventMsg::AgentReasoning { text } => {
    client.send_agent_thought(text).await;
}
```

- **payload**：与 agent_message_chunk 同构。
- **触发条件**（推测）：用 `openai-api-key` / `codex-api-key` auth + 模型 reasoning 有 summary 时。本机未配 API key 验证。
- **当前 codex adapter**：已处理（和 Claude 同逻辑），拿到就映射 `driver.thinking`。

### 2.4 `tool_call`（实测✅，字段最多的厂商扩展）

- **Codex 实测完整 payload**（一次 `cat /etc/hostname` 工具调用）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "019dc580-7141-7f23-a86c-a267ccb4e8fb",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "title": "Read hostname",
      "kind": "read",
      "status": "in_progress",
      "locations": [{ "path": "/etc/hostname" }],
      "rawInput": {
        "call_id": "call_EGczuUx2czyD6gOklwOTT2oA",
        "process_id": "65818",
        "turn_id": "019dc580-78f7-7b52-ae71-ebd1657d1e3a",
        "command": ["/opt/homebrew/bin/zsh", "-lc", "cat /etc/hostname"],
        "cwd": "/tmp",
        "parsed_cmd": [
          { "type": "read", "cmd": "cat /etc/hostname", "name": "hostname", "path": "/etc/hostname" }
        ],
        "source": "unified_exec_startup"
      }
    }
  }
}
```

Codex 与 Claude 的关键差异在 **`rawInput` 的结构**：

| 字段 | Codex 实际装的 | Claude 实际装的 |
|------|----------------|-----------------|
| `rawInput` | 完整 shell 执行上下文（命令、cwd、process_id、turn_id、parsed_cmd、source）| 原始工具参数字典（如 `{ file_path, offset? }`）|
| `kind` | 稳定使用 `read`/`edit`/`execute` 等 | 基本只用 `other` |
| `locations` | Codex 填了 `path` | Claude 偶尔填 |
| `title` | "Read hostname" 这种 LLM 生成的语义标题 | "Bash"、"Read" 这种工具名 |

- **Codex 的 `status` 初始就是 `in_progress`**（实测），不是 `pending`。
- **Codex 在 tool_call 里不带 `content`**，结果一律通过后续 tool_call_update 下发。
- **当前 codex adapter**：已处理，但 **把 `title` 当作 `name`**，丢掉了 `kind`、`status`、`locations`、整个 `parsed_cmd`/`command` 上下文。前端要做"正在执行 `cat /etc/hostname`"这种展示就拿不到命令字符串，得靠 rawInput 整坨透传。

### 2.5 `tool_call_update`（实测✅，rawOutput 很厚）

- **Codex 实测完整 payload**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "019dc580-7141-7f23-a86c-a267ccb4e8fb",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_EGczuUx2czyD6gOklwOTT2oA",
      "status": "failed",
      "rawOutput": {
        "call_id": "call_EGczuUx2czyD6gOklwOTT2oA",
        "process_id": "65818",
        "turn_id": "019dc580-78f7-7b52-ae71-ebd1657d1e3a",
        "command": ["/opt/homebrew/bin/zsh", "-lc", "cat /etc/hostname"],
        "cwd": "/tmp",
        "parsed_cmd": [...],
        "source": "unified_exec_startup",
        "stdout": "cat: /etc/hostname: No such file or directory\n",
        "stderr": "",
        "aggregated_output": "cat: /etc/hostname: No such file or directory\n",
        "exit_code": 1,
        "duration": { "secs": 0, "nanos": 51935000 },
        "formatted_output": "cat: /etc/hostname: No such file or directory\n",
        "status": "failed"
      }
    }
  }
}
```

- Codex `rawOutput` 里的非 ACP 标准字段：`stdout` / `stderr` / `aggregated_output` / `exit_code` / `duration` / `formatted_output` / `status`。前端如果要展示终端式工具结果，这里是金矿。
- `content`（ACP 标准结构化 content）**Codex 没下发** — Codex 走自己的 `rawOutput.formatted_output` 字符串，不拼 `ToolCallContent[]`。
- **没有 `pending → in_progress` 中间态更新**，实测中 tool_call 阶段就已经是 in_progress，tool_call_update 直接 completed/failed。
- **当前 codex adapter**：只认 `status === 'completed' || 'failed'`，映射到 `driver.tool_result { toolCallId, output: rawOutput, ok }`。**后端把整个 rawOutput 对象原样透传**（ok），但前端得知道 Codex 的 `rawOutput.formatted_output` 是字符串结果，Claude 的 `rawOutput` 是工具返回的原始结构，**两家不一样**。

### 2.6 `plan`

- **Codex 实测**：**未观察到**。
- **源码层面**：Codex ACP 源码里未见 `plan` 相关 emit。Codex 主要靠它自己的 "turn planning"（rawInput 里的 turn_id），暂不走 ACP plan。
- **payload（SDK 规范）**：
  ```typescript
  { sessionUpdate: "plan",
    entries: Array<{ content: string,
                     priority: "high"|"medium"|"low",
                     status: "pending"|"in_progress"|"completed" }> }
  ```
- **当前 codex adapter**：**未处理**（default → null）。

### 2.7 `available_commands_update`（实测✅）

- **Codex 实测 payload**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "019dc57f-99d0-7ee1-8676-a7381321a2fc",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "review", "description": "Review my current changes and find issues",
          "input": { "hint": "optional custom review instructions" } },
        { "name": "review-branch", "description": "Review the code changes against a specific branch",
          "input": { "hint": "branch name" } },
        { "name": "review-commit", "description": "Review the code changes introduced by a commit",
          "input": { "hint": "commit sha" } },
        { "name": "init", "description": "create an AGENTS.md file with instructions for Codex",
          "input": null },
        { "name": "compact", "description": "summarize conversation to prevent hitting the context limit",
          "input": null },
        { "name": "undo", "description": "undo Codex's most recent turn", "input": null },
        { "name": "logout", "description": "logout of Codex", "input": null }
      ]
    }
  }
}
```

- **触发时机**：session/new 返回后 **立即**发一次（Claude 同位置暂未观察到 — 两家的触发时机这条是 Codex 先发、Claude 可能不主动发）。
- **Codex 的 slash-command 清单很稳定**（实测 7 条：review/review-branch/review-commit/init/compact/undo/logout）。
- **当前 codex adapter**：**未处理**。

### 2.8 `current_mode_update`

- **Codex 实测**：**未观察到**（本次 probe 没 set_mode）。
- **触发条件**：Client 发 `session/set_mode` 请求把 mode 切到 `read-only` / `auto` / `full-access` 其中之一时，Codex 回通知。
- **payload**：`{ sessionUpdate: "current_mode_update", currentModeId: SessionModeId }`。
- **当前 codex adapter**：**未处理**。

### 2.9 `config_option_update`

- **Codex 实测**：**未观察到**（没 set_config_option）。
- **触发条件**：Client 发 `session/set_config_option` 改 mode/model/reasoning_effort 时，Codex 回通知。
- **payload**：`{ sessionUpdate: "config_option_update", configOptions: SessionConfigOption[] }`（全量替换）。
- **当前 codex adapter**：**未处理**。

### 2.10 `session_info_update`

- **Codex 实测**：**未观察到**。
- **SDK 定义**：`{ title?: string|null, updatedAt?: ISO8601|null }`。
- **Codex 行为未知**（源码里未翻到主动 emit 的地方；需更长会话验证）。
- **当前 codex adapter**：**未处理**。

### 2.11 `usage_update`（UNSTABLE，实测✅）

- **Codex 实测 payload**：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "019dc57f-de97-7383-a9b3-ef778c96a4e0",
    "update": {
      "sessionUpdate": "usage_update",
      "used": 8284,
      "size": 258400
    }
  }
}
```

- Codex 实测**不带 `cost`** 字段（Claude ACP 里也没看到；这字段当前两家都空）。
- `size` 是 context window 总 token 数（gpt-5.3-codex 实测 258400），`used` 是已消耗。
- **每轮 turn 结束前发一次**（实测 turn1 发 8284，turn2 发 11791，增量一致于用户消息 + 工具结果 token 数）。
- **当前 codex adapter**：**未处理**。

---

## 3. session/prompt 响应（非 session/update）

实测一个正常 turn 结束：

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "end_turn" } }
```

Codex 的 prompt 响应 **只有 `stopReason` 一个字段**（实测）。Claude 在 SDK 规范里允许还带 `usage`（Usage 对象），Codex 没带；token 统计完全靠 `usage_update` 事件。

- `StopReason`：`end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`（SDK spec）。
- **当前 codex adapter**：`prepareLaunch` / `sessionParams` / `parseUpdate` / `cleanup` 四个接口不涉及 prompt 响应 — `stopReason` 由 AgentDriver 自己处理（codex.ts:6 注释明说"Codex 通过 tool_call/tool_call_update 和 agent_message_chunk 通知；turn 完成通过 PromptResponse.stopReason 判定，adapter 不处理 turn_done"）。

---

## 4. Agent → Client 反向请求

Codex 也会发 `fs/readTextFile`、`fs/writeTextFile`、`requestPermission`、`terminal/*` 这些反向请求（见 `docs/acp-deep-dive.md` §4.1）。本次 probe 中 Codex **没有发**这些请求（因为 Codex 自己有命令执行能力，且我们 `clientCapabilities.terminal=true` 没触发其 fallback）。

关键：**Codex 的 MCP 子进程是走白名单 env 隔离的**（`docs/acp-verification-report.md` §4）— 不像 Claude 全继承 process.env。mteam 往 Codex MCP 服务里传自定义 env 必须走 `session/new.mcpServers[].env` 白名单。

---

## 5. 当前 codex adapter 处理 vs 遗漏对照

文件：`packages/backend/src/agent-driver/adapters/codex.ts`

| sessionUpdate | adapter 处理 | 映射事件 | 遗漏 / 风险 |
|---------------|--------------|----------|-------------|
| `user_message_chunk` | 否 | — | Codex 不发，可不管 |
| `agent_message_chunk` | 是 | `driver.text` | 只取 `content.text`；丢 messageId（两家都没发所以暂时不是问题） |
| `agent_thought_chunk` | 是 | `driver.thinking` | 同上；**ChatGPT auth 下实测永远 0 条**（前端 UI 必须降级） |
| `tool_call` | 是 | `driver.tool_call` | **丢 `kind`、`status`、`locations`**；**把 `title` 当成 `name`**（实际 title 是 "Read hostname" 这种语义字符串，不是 tool name）；rawInput 整坨透传 OK |
| `tool_call_update` | 部分 | `driver.tool_result` (仅 completed/failed) | Codex 实测**跳过 in_progress 中间态**所以这块没损失；但 `rawOutput` 里的 stdout/stderr/exit_code/duration/formatted_output 是 **Codex 扩展字段**，前端要知道这套结构，**和 Claude 的 rawOutput 形状不兼容** |
| `plan` | 否 | — | Codex 暂不发 plan；空洞等上游 |
| `available_commands_update` | 否 | — | **Codex session/new 后立即发**，7 条 review/init/compact/undo/logout 等 slash-command 完全丢 |
| `current_mode_update` | 否 | — | mteam 若让用户切 mode 会拿不到确认通知 |
| `config_option_update` | 否 | — | 同上 |
| `session_info_update` | 否 | — | Codex 是否主动发未知 |
| `usage_update` | 否 | — | **Codex 每轮实测都发**，context used/size 前端想做 token 进度条就靠它 |

**与 Claude adapter 的差异点**：

| 维度 | Claude adapter | Codex adapter | 说明 |
|------|----------------|---------------|------|
| `prepareLaunch` | npx `@agentclientprotocol/claude-agent-acp` | npx `@zed-industries/codex-acp` + `-c model_instructions_file=<tmp>` | Codex systemPrompt 必须落盘 |
| `sessionParams` | `_meta.systemPrompt.append` | `{}` | Claude 走 _meta、Codex 走文件 |
| `parseUpdate` | 4 分支（user/agent/thought/tool_call/tool_call_update）| 同样 4 分支 | **逻辑完全一致**（两家同 SDK） |
| `cleanup` | no-op | unlinkSync(promptFile) | Codex 要删临时 instruction 文件 |
| 特殊关心 | — | 未关心 `usage_update`、`available_commands_update` | 见上表 |

**两家 adapter 的 parseUpdate 是相同代码（只换了注释），这是合理的** — ACP SDK 屏蔽了厂商差异，但**具体 payload 形状的厂商差异没屏蔽**（rawInput/rawOutput、status 初始值、哪些事件主动发）。

---

## 6. Codex 厂商扩展字段一览

Codex 往标准 ACP schema 塞的**非标准字段**（客户端不能依赖 SDK 类型，只能当 `unknown` 读）：

1. **`tool_call.rawInput`**：`{ call_id, process_id, turn_id, command, cwd, parsed_cmd, source }` —— 是 Codex "unified exec" 子系统的完整调用上下文。
2. **`tool_call_update.rawOutput`**：在 rawInput 字段基础上加 `{ stdout, stderr, aggregated_output, exit_code, duration{secs,nanos}, formatted_output, status }`。
3. **`session/new.result.models`**（UNSTABLE SessionModelState）：Codex 主动下发，Claude 0.30 不发。
4. **`session/new.result.configOptions[].category = "thought_level"`**：用 `reasoning_effort` 选 low/medium/high/xhigh。Claude 当前 configOptions 类目未确认。

Codex `parsed_cmd` 的已知 `type` 值（实测采到一个）：`read`。源码层面还支持 `search` / `edit` / `execute` / `other` 等（未逐个验证）。

---

## 7. 前端事件映射建议（与 Claude 一致，做厂商平滑）

mteam 的 `DriverEvent` 是 Claude/Codex 两家合流层。建议 Driver 在这一层**统一字段**，adapter 层做厂商翻译：

| 统一 DriverEvent | Claude 取值来源 | Codex 取值来源 |
|------------------|-----------------|----------------|
| `driver.text { text, messageId? }` | agent_message_chunk.content.text | 同 |
| `driver.thinking { text, messageId? }` | agent_thought_chunk.content.text | 同（若 auth 允许）|
| `driver.tool_call { toolCallId, title, kind, status, input, locations }` | tool_call 全字段 | 同；**`input` 透传 rawInput 但结构是 Codex unified_exec 形状** |
| `driver.tool_update { toolCallId, status?, output?, diff?, content? }` | tool_call_update | 同；**Codex 的 `output` 是 `{stdout, stderr, exit_code, formatted_output, ...}`，Claude 是工具原生返回值** |
| `driver.plan { entries[] }` | plan | Codex 当前不发 |
| `driver.commands { commands[] }` | available_commands_update | 同；**Codex 先发 Claude 未观察到** |
| `driver.mode { currentModeId }` | current_mode_update | 同 |
| `driver.config { options[] }` | config_option_update | 同 |
| `driver.session_info { title?, updatedAt? }` | session_info_update | 同 |
| `driver.usage { used, size, cost? }` | usage_update | 同；**Codex 每轮都发，Claude 行为待实测** |
| `driver.turn_end { stopReason, usage? }` | session/prompt response | Codex 只带 stopReason |

关键提醒：**`output` / `input` 这两个字段在 Claude 和 Codex 之间结构不同**，前端渲染工具卡片时要根据 agent 类型选不同组件（或者 adapter 层统一成 `{ kind: 'codex-shell' | 'claude-tool', data }`）。

---

## 8. 与 Claude 的对照结论

| 比较点 | Claude (0.30.0) | Codex (0.9.5 本机 / 0.11.1 mteam) |
|--------|-----------------|----------------------------------|
| 协议版本 | 20 | **1** ← 差异大但 SDK 已处理 |
| sessionUpdate 种类 | SDK 定义的 11 种全部合法 | 同 |
| 实测下发的种类 | agent_thought_chunk / agent_message_chunk / tool_call / tool_call_update 等 | agent_message_chunk / tool_call / tool_call_update / available_commands_update / usage_update |
| thinking 可靠性 | 高（默认开） | **低**（ChatGPT auth 下 0 条） |
| tool_call rawInput | 工具原生参数字典 | Codex unified_exec 完整上下文 |
| tool_call_update rawOutput | 工具原生返回 | stdout/stderr/exit_code/formatted_output 等扩展字段 |
| session/new 额外字段 | `modes` + `configOptions` | `modes` + **`models`** + `configOptions` |
| available_commands 主动发 | 未实测（Claude adapter 未处理） | **是，session/new 后立即** |
| usage_update 主动发 | 未实测 | **是，每 turn 一次** |
| plan 主动发 | 可能发（源码支持，未实测） | **不发**（源码未翻到 emit） |
| prompt 注入 | `_meta.systemPrompt.append` | `-c model_instructions_file=<tmp>`（id 294） |
| MCP HTTP transport | agentCapabilities.mcpCapabilities.http=?(需实测) | `http: true`（实测） |

**回答团队关心的三个问题：**

1. **两家有没有差异？** 在 ACP 协议/事件类型层面基本一致（共享 SDK）；差异集中在 ① `rawInput`/`rawOutput` 的具体字段形状 ② 哪些事件主动下发 ③ 认证/thinking 可靠性 ④ prompt 注入手法。
2. **哪些类型是标准的、哪些是厂商扩展的？** 11 种 `sessionUpdate` 全部来自 SDK 标准 schema，**无厂商新 sessionUpdate 值**。厂商扩展只发生在字段层：Codex 往 `rawInput`/`rawOutput` 塞了它自有的 unified_exec 字段，Claude 的 rawInput/rawOutput 是工具原生结构。`session/new` 结果的 `models` 是 SDK UNSTABLE 字段，Codex 已经在用，Claude 暂缓。
3. **现有 adapter 是否遗漏？** 遗漏了 **7 类 sessionUpdate**（plan / available_commands_update / current_mode_update / config_option_update / session_info_update / usage_update / user_message_chunk），以及已处理 4 类里的 **`kind`/`status`/`locations`/`messageId`** 等字段；Codex 特有的 **`available_commands_update`（session 开始就发）和 `usage_update`（每轮都发）** 是目前丢弃最可惜的两类。

---

## 9. 一句话总结

Codex ACP 与 Claude ACP 共享 11 种标准 `sessionUpdate`；Codex 实测活跃的有 5 种（agent_message_chunk / tool_call / tool_call_update / available_commands_update / usage_update），当前 `codex adapter` 只处理 3 种（text / tool_call / tool_call_update），**丢了 available_commands_update、usage_update 以及 tool_call/update 里 Codex 特有的 unified_exec 上下文（command/stdout/exit_code/duration 等）**；adapter 和 Claude 几乎同代码，差异在厂商字段形状而不在协议类型。
