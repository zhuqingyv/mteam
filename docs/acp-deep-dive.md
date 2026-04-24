# ACP (Agent Client Protocol) Deep Dive

> 调研日期: 2026-04-23
> ACP SDK 版本: v0.20.0
> 源码: github.com/agentclientprotocol/agent-client-protocol (Rust 参考实现)
> 官网: agentclientprotocol.com

---

## 1. ACP 是什么

ACP 标准化了**代码编辑器 (Client)** 和 **编码 Agent (Agent)** 之间的通信。类比 LSP 之于语言服务器，ACP 之于 AI 编码助手。

- 发起方: Anthropic / Zed Industries，现为独立组织 agentclientprotocol
- 传输: JSON-RPC 2.0 over stdio（本地），Streamable HTTP（远程，draft）
- 定位: 前端/编辑器 <-> Agent 通信层，与 MCP (Agent <-> 工具) 和 A2A (Agent <-> Agent) 互补

**三层协议栈:**
```
Client (编辑器)  ──ACP──>  Agent (Claude Code / Codex / Gemini CLI / ...)
                              │
                              ├──MCP──>  工具/数据源
                              └──A2A──>  其他 Agent
```

### 注意: 不是 BeeAI 的 ACP

IBM BeeAI 的 Agent Communication Protocol 也叫 ACP，但已于 2025-08 归档并入 Google A2A。本文讨论的是 Anthropic/Zed 的 Agent Client Protocol。

---

## 2. ACP 发现机制 — 怎么找到本地 Agent CLI

### 2.1 ACP Registry（标准发现）

ACP 有一个**中心化的 Agent 注册表**:

```
GET https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

返回所有已注册 Agent 的元数据，客户端（如 Zed）定期拉取这个 JSON 来列出可用 Agent。

**每个 Agent 的 agent.json 格式:**
```json
{
  "id": "claude-acp",
  "name": "Claude Agent",
  "version": "0.30.0",
  "description": "ACP wrapper for Anthropic's Claude",
  "repository": "https://github.com/agentclientprotocol/claude-agent-acp",
  "authors": ["Anthropic", "Zed Industries", "JetBrains"],
  "license": "proprietary",
  "distribution": {
    "npx": {
      "package": "@agentclientprotocol/claude-agent-acp@0.30.0"
    }
  }
}
```

### 2.2 三种分发方式

| 类型 | 说明 | 客户端执行方式 |
|------|------|--------------|
| `npx` | npm 包 | `npx <package> [args]` |
| `uvx` | PyPI 包 via uv | `uvx <package> [args]` |
| `binary` | 平台原生二进制 | 下载 archive -> 解压 -> 执行 cmd |

平台标识: `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`, `windows-aarch64`, `windows-x86_64`

### 2.3 当前注册的 Agent (30 个)

| Agent | 分发方式 | 备注 |
|-------|---------|------|
| `claude-acp` | npx (`@agentclientprotocol/claude-agent-acp`) | Anthropic + Zed + JetBrains 合作 |
| `codex-acp` | binary + npx (`@zed-industries/codex-acp`) | OpenAI + Zed |
| `gemini` | npx (`@google/gemini-cli --acp`) | Google |
| `qwen-code` | npx (`@qwen-code/qwen-code --acp`) | Alibaba |
| `github-copilot` | 已注册 | GitHub |
| `cursor` | 已注册 | Cursor |
| `cline` | 已注册 | Cline |
| `kimi` | 已注册 | Moonshot |
| `goose` | 已注册 | Block |
| `junie` | 已注册 | JetBrains |
| ... 还有 amp-acp, auggie, autohand, codebuddy-code, corust-agent, crow-cli, deepagents, factory-droid, fast-agent, github-copilot-cli, kilo, minion-code, mistral-vibe, nova, opencode, pi-acp, qoder, stakpak | | |

### 2.4 Zed 的发现流程

Zed 源码 (`crates/project/src/agent_server_store.rs`) 揭示了三种来源:

1. **ACP Registry**: `AgentRegistryStore` 拉取 registry.json，用户在设置里选择后自动安装
2. **Zed 扩展**: 扩展 manifest 里声明 `agent_servers`，Zed 自动注册
3. **用户配置**: settings.json 里手动配置 `AgentServerCommand { path, args, env }`

核心结构:
```rust
pub struct AgentServerCommand {
    pub path: PathBuf,   // CLI 可执行文件路径
    pub args: Vec<String>,
    pub env: Option<HashMap<String, String>>,
}
```

**没有** 自动扫描 PATH 的机制。所有 Agent 都是显式注册/安装的。

---

## 3. ACP 连接流程

### 3.1 启动 Agent 子进程

客户端启动 Agent 为子进程，通过 **stdin/stdout** 通信:

```
Client --spawn--> Agent process (stdin/stdout = JSON-RPC 2.0)
                  stderr = 日志（不影响协议）
```

### 3.2 完整会话生命周期

```
┌─────────┐                              ┌─────────┐
│  Client  │                              │  Agent   │
└────┬─────┘                              └────┬─────┘
     │  1. initialize(protocolVersion,         │
     │     clientCapabilities, clientInfo)      │
     ├────────────────────────────────────────>│
     │                                         │
     │  1r. {protocolVersion,                  │
     │       agentCapabilities,                │
     │       agentInfo, authMethods}           │
     │<────────────────────────────────────────┤
     │                                         │
     │  2. authenticate(methodId, ...)         │
     ├────────────────────────────────────────>│  (如果需要)
     │                                         │
     │  3. session/new(cwd, mcpServers, ...)   │
     ├────────────────────────────────────────>│
     │  3r. {sessionId, modes, configOptions}  │
     │<────────────────────────────────────────┤
     │                                         │
     │  4. session/prompt(sessionId, prompt)   │
     ├────────────────────────────────────────>│
     │                                         │
     │  ──── streaming notifications ────      │
     │  session/update: agent_thought_chunk    │
     │<────────────────────────────────────────┤  (thinking)
     │  session/update: agent_message_chunk    │
     │<────────────────────────────────────────┤  (回复文本)
     │  session/update: tool_call              │
     │<────────────────────────────────────────┤  (发起工具调用)
     │                                         │
     │  fs/readTextFile(path)                  │  (Agent 请求读文件)
     │<────────────────────────────────────────┤
     │  {content}                              │
     ├────────────────────────────────────────>│
     │                                         │
     │  requestPermission(toolCallId, ...)     │  (需要用户授权)
     │<────────────────────────────────────────┤
     │  {outcome: "allow"}                     │
     ├────────────────────────────────────────>│
     │                                         │
     │  session/update: tool_call_update       │
     │<────────────────────────────────────────┤  (工具完成)
     │  session/update: plan                   │
     │<────────────────────────────────────────┤  (执行计划)
     │                                         │
     │  4r. {stopReason: "end_turn"}           │
     │<────────────────────────────────────────┤  (turn 结束)
     │                                         │
     │  5. session/close(sessionId)            │
     ├────────────────────────────────────────>│  (可选)
```

### 3.3 Initialize 请求/响应

**请求 (Client -> Agent):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 20,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": {
      "name": "zed",
      "title": "Zed Editor",
      "version": "0.200.0"
    }
  }
}
```

**响应 (Agent -> Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 20,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
      "mcpCapabilities": { "http": false, "sse": false },
      "sessionCapabilities": {
        "close": {},
        "list": {},
        "resume": {}
      }
    },
    "agentInfo": { "name": "claude-acp", "version": "0.30.0" },
    "authMethods": [...]
  }
}
```

版本协商: 客户端发最新支持的版本号，Agent 回复实际使用的版本号。

---

## 4. ACP 消息格式 — 完整 Schema

### 4.1 完整方法清单

**Client -> Agent (请求):**

| 方法 | 说明 | 必须 |
|------|------|------|
| `initialize` | 协议握手、能力交换 | 必须 |
| `authenticate` | 认证 | 按需 |
| `session/new` | 创建会话 | 必须 |
| `session/load` | 加载已有会话 | 可选 (需 `loadSession` 能力) |
| `session/list` | 列出会话 | 可选 (需 `sessionCapabilities.list`) |
| `session/resume` | 恢复会话 (不返回历史消息) | 可选 (需 `sessionCapabilities.resume`) |
| `session/close` | 关闭会话 | 可选 (需 `sessionCapabilities.close`) |
| `session/prompt` | 发送用户消息 | 必须 |
| `session/set_mode` | 切换 Agent 模式 | 可选 |
| `session/set_config_option` | 设置会话配置 | 可选 |

**Client -> Agent (通知):**

| 通知 | 说明 |
|------|------|
| `session/cancel` | 取消当前 turn |

**Agent -> Client (请求):**

| 方法 | 说明 | 需要能力 |
|------|------|---------|
| `fs/readTextFile` | 读取文件 | `fs.readTextFile` |
| `fs/writeTextFile` | 写入文件 | `fs.writeTextFile` |
| `requestPermission` | 请求用户授权 | - |
| `terminal/create` | 创建终端执行命令 | `terminal` |
| `terminal/output` | 获取终端输出 | `terminal` |
| `terminal/wait_for_exit` | 等待终端退出 | `terminal` |
| `terminal/kill` | 杀终端命令 | `terminal` |
| `terminal/release` | 释放终端 | `terminal` |

**Agent -> Client (通知):**

| 通知 | 说明 |
|------|------|
| `session/update` | 会话更新 (核心流式通知) |

### 4.2 session/update 的所有类型

`session/update` 通过 `sessionUpdate` 字段区分类型（tagged union）:

| sessionUpdate 值 | 说明 | 载荷 |
|-------------------|------|------|
| `user_message_chunk` | 用户消息 chunk | ContentChunk |
| **`agent_message_chunk`** | Agent 回复文本 chunk | ContentChunk |
| **`agent_thought_chunk`** | **Agent 内部推理/thinking chunk** | ContentChunk |
| `tool_call` | 新工具调用 | ToolCall |
| `tool_call_update` | 工具调用状态更新 | ToolCallUpdate |
| `plan` | 执行计划 | Plan |
| `available_commands_update` | 可用命令变更 | AvailableCommandsUpdate |
| `current_mode_update` | 当前模式变更 | CurrentModeUpdate |
| `config_option_update` | 配置选项变更 | ConfigOptionUpdate |
| `session_info_update` | 会话元数据变更 | SessionInfoUpdate |

### 4.3 ContentBlock 类型

```
ContentBlock = Text | Image | Audio | ResourceLink | Resource(EmbeddedResource)
```

所有 Agent 必须支持 Text 和 ResourceLink。Image/Audio/EmbeddedContext 需通过能力协商。

### 4.4 ToolCall 结构

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "tc_001",
  "title": "Reading file: src/main.ts",
  "kind": "read",
  "status": "pending",
  "content": [],
  "locations": [{ "uri": "file:///src/main.ts", "range": { "start": 0, "end": 100 } }]
}
```

**ToolKind 枚举:** `read` | `edit` | `delete` | `move` | `search` | `execute` | `think` | `fetch` | `switch_mode` | `other`

**ToolCallStatus:** `pending` -> `in_progress` -> `completed` | `failed`

**ToolCallContent:** `content` (标准内容块) | `diff` (文件 diff) | `terminal` (终端引用)

### 4.5 StopReason

| 值 | 含义 |
|----|------|
| `end_turn` | 正常结束 |
| `max_tokens` | Token 上限 |
| `max_turn_requests` | 模型请求次数上限 |
| `refusal` | Agent 拒绝继续 |
| `cancelled` | 客户端取消 |

### 4.6 消息分隔

stdio 传输: 每条 JSON-RPC 消息以 `\n` 分隔，消息内部 **不得** 包含换行符。UTF-8 编码。

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
{"jsonrpc":"2.0","id":1,"result":{...}}\n
{"jsonrpc":"2.0","method":"session/update","params":{...}}\n
```

---

## 5. Thinking 在 ACP 里的支持

### 5.1 结论: thinking 是 ACP 标准字段，不是扩展

ACP v0.20.0 spec 明确定义了 `agent_thought_chunk` 作为 `SessionUpdate` 的一种类型:

```json
{
  "jsonrpc": "2.0",
  "method": "sessionUpdate",
  "params": {
    "sessionId": "sess_001",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": {
        "type": "text",
        "text": "Let me analyze the user's request..."
      }
    }
  }
}
```

### 5.2 thought_level 配置

ACP spec 还定义了 `SessionConfigOptionCategory::ThoughtLevel`，允许客户端控制 thinking 级别:

```rust
pub enum SessionConfigOptionCategory {
    Mode,           // 会话模式选择器
    Model,          // 模型选择器
    ThoughtLevel,   // thinking/reasoning 级别选择器
}
```

### 5.3 Usage 统计中的 thought_tokens

ACP 还追踪 thinking token 用量:

```rust
pub struct Usage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thought_tokens: Option<u64>,     // thinking token 统计
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
}
```

### 5.4 各 Agent 的 thinking 支持情况

| Agent | 是否输出 thinking | 实现方式 |
|-------|-------------------|---------|
| **Claude Code (claude-acp)** | **是** | Claude API 的 `thinking`/`thinking_delta` content block -> ACP `agent_thought_chunk` |
| **Codex (codex-acp)** | **是** | OpenAI 的 `AgentReasoningEvent`/`ReasoningContentDeltaEvent` -> ACP `agent_thought_chunk` |
| **Gemini CLI** | 未确认，spec 支持 | `--acp` flag 启用 ACP 模式 |
| **Qwen Code** | 未确认，spec 支持 | `--acp --experimental-skills` |

**关键发现: Codex 确实通过 ACP 输出 thinking。**

Codex ACP 源码 (`src/thread.rs`) 明确映射:
```rust
// Codex reasoning -> ACP thought
EventMsg::AgentReasoningContentDelta { delta, .. } => {
    self.seen_reasoning_deltas = true;
    client.send_agent_thought(delta).await;  // -> agent_thought_chunk
}
EventMsg::AgentReasoning { text } => {
    client.send_agent_thought(text).await;   // -> agent_thought_chunk
}
```

Claude ACP 源码 (`src/acp-agent.ts`) 映射:
```typescript
case "thinking":
case "thinking_delta":
  update = {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: chunk.thinking },
  };
  break;
```

### 5.5 ToolKind::Think

ACP 还定义了 `think` 作为 ToolKind 的一个枚举值。当 Agent 内部使用 "thinking tool" 时，可以标记 kind 为 `think`，客户端可用不同 UI 展示。

---

## 6. 对 mteam 的影响分析

### 6.1 当前 mteam 方案 vs ACP

| 维度 | mteam 当前方案 | ACP 方案 |
|------|---------------|---------|
| 通信方式 | CLI `--json` flag + stdout 解析 | JSON-RPC 2.0 over stdio |
| 消息格式 | 各 CLI 自定义 JSON | 统一的 SessionUpdate schema |
| thinking | 各 CLI 各自处理 | 统一的 `agent_thought_chunk` |
| 工具调用 | 不可见 | 完整的 tool_call/tool_call_update 流 |
| 计划 | 不可见 | plan 通知 |
| 文件操作 | Agent 自行处理 | Client 可代理 fs 操作 |
| 权限 | 无 | requestPermission 机制 |
| 终端 | 各 CLI 自行管理 | Client 统一提供 terminal 能力 |
| 发现 | 手动配置 | Registry + 自动安装 |
| 生态 | 仅支持手动适配的 CLI | 30+ Agent 生态 |

### 6.2 ACP 的优势

1. **统一的 thinking 输出**: 不需要为每个 CLI 写不同的 thinking 解析逻辑
2. **结构化工具调用**: 能看到 Agent 在做什么（读文件、改代码、执行命令），而不是只能看到最终文本
3. **双向通信**: Agent 可以主动请求文件操作和权限，mteam 可以控制文件访问范围
4. **标准生态**: 接入 ACP 意味着自动支持 30+ Agent，包括 Claude Code、Codex、Gemini CLI
5. **Session 管理**: session/load、session/resume 让对话恢复变得标准化
6. **权限隔离**: requestPermission 机制天然适合 mteam 的权限控制需求

### 6.3 ACP 的限制

1. **本地 stdio 限制**: ACP 目前以本地子进程为主，HTTP transport 还是 draft
2. **Claude ACP wrapper**: Claude Code 不是原生 ACP — 需要通过 `@agentclientprotocol/claude-agent-acp` 包装层（底层用 `@anthropic-ai/claude-agent-sdk`）
3. **认证复杂度**: 每个 Agent 有自己的认证流程
4. **不处理 Agent 间通信**: ACP 只管 Client <-> Agent，不管 Agent <-> Agent（那是 A2A 的事）

### 6.4 Claude ACP 架构细节

Claude ACP wrapper 的架构:
```
Zed/Editor ──ACP (stdio)──> claude-agent-acp (npx)
                                │
                                └──> @anthropic-ai/claude-agent-sdk
                                        │
                                        └──> Claude Code native binary
                                              (平台特定: darwin-arm64/x86_64, linux-...)
```

`claude-agent-acp` 不是直接调 Claude API，而是启动 Claude Code 的原生二进制，通过 `claude-agent-sdk` 通信。SDK 处理:
- 消息映射: Claude 的 thinking/text/tool_use -> ACP 的 thought_chunk/message_chunk/tool_call
- 模式映射: Claude Code 的模式 -> ACP SessionMode
- 配置映射: 模型选择、thinking level -> ACP SessionConfigOption

---

## 7. 推荐方案

### 方案 A: 用 ACP 替代当前 CLI --json flag（推荐）

**做法:** mteam 作为 ACP Client 实现，通过 ACP 协议管理所有 Agent。

**理由:**
- 一套协议支持所有 Agent（Claude Code、Codex、Gemini CLI、Qwen Code...）
- thinking 输出标准化，不需要 per-CLI 解析
- 工具调用可见可控，符合 mteam 的权限管理需求
- 生态快速增长（30+ Agent 已注册）

**实现路径:**
1. 用 `@agentclientprotocol/sdk` (TS) 或 `agentclientprotocol` (Rust crate) 实现 ACP Client
2. 实现 `Client` trait: fs 操作、终端管理、权限审批
3. 通过 registry.json 发现可用 Agent
4. 通过 npx/uvx/binary 安装并启动 Agent 子进程
5. 用 session/update 统一处理所有流式输出

**mteam 特有的增强:**
- requestPermission 可以实现跨 Agent 的权限策略
- 多 Agent 共享同一 Client 的 fs/terminal 能力
- agent_thought_chunk 可以选择性暴露或隐藏

### 方案 B: ACP + 自定义层（折中）

对于 ACP 不覆盖的场景（Agent 间通信、团队协调），在 ACP 之上加一层 mteam 协议:

```
mteam coordinator
  ├── ACP Client 1 ──> Claude Code Agent
  ├── ACP Client 2 ──> Codex Agent
  └── ACP Client 3 ──> Gemini Agent
      │
      └── mteam 协议层 (Agent间消息路由、任务分配、状态同步)
```

### 方案 C: 不用 ACP（不推荐）

继续用 `--json` flag 和自定义解析。理由: 更轻量，但长期维护成本高，每增加一个 CLI 就要写一个适配器。

---

## 附录 A: ACP Schema 源

- 正式 JSON Schema: `github.com/agentclientprotocol/agent-client-protocol/schema/schema.json`
- Rust 源码: `github.com/agentclientprotocol/agent-client-protocol/src/`
- TS SDK: `@agentclientprotocol/sdk` (npm, v0.20.0)
- Rust SDK: `agentclientprotocol` (crates.io)
- 其他 SDK: Kotlin (`agentclientprotocol/kotlin-sdk`), Go (`coder/acp-go-sdk`), Python, Java

## 附录 B: 各 Agent 的 ACP 启动参数

```bash
# Claude Code (via ACP wrapper)
npx @agentclientprotocol/claude-agent-acp@0.30.0

# Codex (OpenAI)
npx @zed-industries/codex-acp@0.11.1
# 或下载平台二进制: ./codex-acp

# Gemini CLI
npx @google/gemini-cli@0.39.1 --acp

# Qwen Code
npx @qwen-code/qwen-code@0.15.1 --acp --experimental-skills
```

## 附录 C: 第三方 ACP Client 实现

- **Zed**: 原生支持 (Rust, `crates/agent_servers/`)
- **VS Code**: `formulahendry/vscode-acp`
- **Obsidian**: `RAIT-09/obsidian-agent-client`
- **Emacs**: `xenodium/acp.el`
- **CLI**: `openclaw/acpx` (headless CLI client)
- **JetBrains**: 通过 claude-agent-acp 的 authors 列表推断已支持

## 附录 D: wire format 示例

**Agent thought chunk (thinking 输出):**
```json
{"jsonrpc":"2.0","method":"sessionUpdate","params":{"sessionId":"test-456","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"I need to analyze the codebase structure first..."}}}}
```

**Agent message chunk (正常回复):**
```json
{"jsonrpc":"2.0","method":"sessionUpdate","params":{"sessionId":"test-456","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Here's what I found..."}}}}
```

**Tool call:**
```json
{"jsonrpc":"2.0","method":"sessionUpdate","params":{"sessionId":"test-456","update":{"sessionUpdate":"tool_call","toolCallId":"tc_001","title":"Reading src/main.ts","kind":"read","status":"pending","content":[],"locations":[]}}}
```

**Request permission (Agent -> Client):**
```json
{"jsonrpc":"2.0","id":5,"method":"requestPermission","params":{"toolCallId":"tc_002","title":"Execute: npm install","message":"Allow running this command?","options":["allow","deny"]}}
```
