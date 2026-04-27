# ACP 调研报告

> 调研日期：2026-04-23
> 背景：mteam 当前用 PTY stdin/stdout 做 agent 通信，脆弱且无结构化。用户提到用 ACP 做替代方案。

## 重要发现：两个不同的 "ACP"

调研发现市面上存在两个同名但完全不同的协议，必须区分：

| | Agent Client Protocol (ACP) | Agent Communication Protocol (ACP) |
|---|---|---|
| **发起方** | Anthropic（Zed 团队主导） | IBM BeeAI → Linux Foundation |
| **定位** | 编辑器 ↔ 编码 Agent 通信 | Agent ↔ Agent 互操作 |
| **传输层** | JSON-RPC 2.0 over stdio | REST HTTP |
| **当前状态** | **活跃开发，v0.20.0** | **已归档，并入 A2A** |
| **SDK** | TS/Python/Rust/Java/Kotlin | TS/Python（停止维护） |
| **与 mteam 的相关性** | **高度相关** | 不直接相关 |

**结论：对 mteam 有价值的是 Agent Client Protocol（编辑器↔Agent），不是 Agent Communication Protocol（Agent↔Agent）。**

---

## 1. Agent Client Protocol (ACP) — 核心标的

### 1.1 概述

Agent Client Protocol 是 Anthropic 发起的开放协议，标准化 **代码编辑器（Client）** 与 **AI 编码 Agent（Agent）** 之间的通信。解决的核心问题：

- 每个 Agent-Editor 组合都要写专用集成 → 统一协议
- Agent 只能配合特定编辑器 → 跨编辑器兼容
- 厂商锁定 → 开放标准

官网：https://agentclientprotocol.com
GitHub：https://github.com/agentclientprotocol/agent-client-protocol
TS SDK：`@agentclientprotocol/sdk` (npm, v0.20.0, 2026-04-23 发布)
协议许可：Apache 2.0

### 1.2 架构

```
┌─────────────────┐     JSON-RPC 2.0      ┌─────────────────┐
│     Client      │ ◄──── stdio ────────► │     Agent       │
│  (IDE/编辑器/    │                        │  (Claude Code/  │
│   前端 UI)      │                        │   Codex/Gemini) │
└─────────────────┘                        └─────────────────┘
```

- **传输层**：本地部署 = JSON-RPC over stdio（Agent 作为 Client 子进程）
- **远程部署**：HTTP / WebSocket（WIP）
- **消息格式**：JSON-RPC 2.0（Request/Response + Notification）
- **文本渲染**：Markdown 作为默认富文本格式
- **与 MCP 的关系**：复用 MCP 的 JSON 表示结构（Content Block 对齐）

### 1.3 Session 生命周期

```
Client                          Agent
  │                               │
  │──── initialize ──────────────►│  (版本协商 + 能力交换)
  │◄─── result ──────────────────│
  │                               │
  │──── authenticate ────────────►│  (如需要)
  │◄─── result ──────────────────│
  │                               │
  │──── session/new ─────────────►│  (创建会话)
  │◄─── result {sessionId} ──────│
  │                               │
  │──── session/prompt ──────────►│  (发送用户消息)
  │◄─── session/update ──────────│  (plan / text / tool_call / tool_call_update)
  │◄─── session/update ──────────│  (持续推送中间状态)
  │◄─── ...                      │
  │◄─── result {stopReason} ─────│  (一轮结束)
  │                               │
  │──── session/prompt ──────────►│  (继续对话)
  │     ...                       │
  │──── session/close ───────────►│  (关闭)
```

### 1.4 核心 JSON-RPC Methods

**Agent 侧 Methods（Client → Agent）：**

| Method | 说明 |
|---|---|
| `initialize` | 版本协商 + 能力声明 |
| `authenticate` | 授权 |
| `session/new` | 创建新会话 |
| `session/load` | 恢复已有会话（可选） |
| `session/prompt` | 发送用户消息 |
| `session/cancel` | 取消当前 prompt turn |
| `session/set_mode` | 切换 Agent 模式（可选） |

**Client 侧 Methods（Agent → Client）：**

| Method | 说明 |
|---|---|
| `session/request_permission` | 请求工具执行权限 |
| `fs/read_text_file` | 读文件 |
| `fs/write_text_file` | 写文件 |
| `terminal/create` | 创建终端 |
| `terminal/output` | 终端输出 |
| `terminal/kill` | 终端结束 |

**Notification（Agent → Client，无需回复）：**

| Notification | 说明 |
|---|---|
| `session/update` | 推送中间状态（思考/文本/工具调用） |
| `session/info_update` | 会话状态变更 |

### 1.5 session/update 的 Update 类型

| updateType | 说明 |
|---|---|
| `plan` | Agent 的执行计划，含 entries（内容/优先级/状态） |
| `agent_message_chunk` | LLM 文本输出流 |
| `tool_call` | 工具调用开始 |
| `tool_call_update` | 工具调用状态更新（pending→in_progress→completed/failed） |

### 1.6 Content Block 类型

| type | 说明 | 能力要求 |
|---|---|---|
| `text` | 文本 | 必须支持 |
| `image` | 图片（base64） | image 能力 |
| `audio` | 音频（base64） | audio 能力 |
| `resource` | 嵌入资源（文件等） | embeddedContext 能力 |
| `resource_link` | 资源链接引用 | — |

### 1.7 Tool Call 结构

```json
{
  "toolCallId": "tc_001",
  "title": "Reading auth.py",
  "kind": "read",          // read|edit|delete|move|search|execute|think|fetch|other
  "status": "in_progress", // pending|in_progress|completed|failed
  "content": [...],        // 输出内容
  "locations": [{"path": "/abs/path/to/file.py", "line": 42}],
  "rawInput": {...},       // 工具参数
  "rawOutput": {...}       // 工具结果
}
```

权限请求格式：
```json
// Agent → Client
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "...",
    "toolCallId": "tc_001",
    "permissions": [
      {"kind": "allow_once"},
      {"kind": "allow_always"},
      {"kind": "reject_once"},
      {"kind": "reject_always"}
    ]
  }
}
```

### 1.8 Stop Reasons

| stopReason | 说明 |
|---|---|
| `end_turn` | 正常完成 |
| `max_tokens` | token 上限 |
| `max_turn_requests` | 模型请求上限 |
| `refusal` | Agent 拒绝继续 |
| `cancelled` | Client 主动取消 |

### 1.9 session/new 请求示例

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/new",
  "params": {
    "cwd": "/Users/user/project",
    "mcpServers": []
  }
}
```

---

## 2. Claude Code 当前的结构化通信能力

### 2.1 stream-json 输出格式

Claude CLI 已支持 `--output-format stream-json`，输出 NDJSON 事件流：

```bash
claude -p "hello" --output-format stream-json --verbose
```

事件类型：

| type | subtype | 说明 |
|---|---|---|
| `system` | `init` | 会话初始化（模型/工具/MCP/插件信息） |
| `system` | `api_retry` | API 重试通知 |
| `system` | `plugin_install` | 插件安装进度 |
| `system` | `compact_boundary` | 压缩事件 |
| `assistant` | — | 模型输出（含 thinking/text/tool_use content blocks） |
| `user` | — | 工具结果回传 |
| `result` | `success`/`error` | 最终结果 |

### 2.2 assistant 消息结构（实际抓包）

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_...",
    "role": "assistant",
    "content": [
      {"type": "thinking", "thinking": "...reasoning...", "signature": "..."},
      {"type": "tool_use", "id": "toolu_...", "name": "Read", "input": {"file_path": "..."}}
    ],
    "usage": {"input_tokens": 3, "output_tokens": 8, ...}
  },
  "session_id": "...",
  "uuid": "..."
}
```

### 2.3 tool_result 回传结构

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "toolu_...",
      "type": "tool_result",
      "content": "1\t{...file content...}"
    }]
  },
  "tool_use_result": {
    "type": "text",
    "file": {"filePath": "...", "content": "...", "numLines": 17}
  }
}
```

### 2.4 input-format stream-json（双向流）

Claude CLI 支持 `--input-format stream-json`，允许通过 stdin 以 NDJSON 发送消息，实现完整的双向结构化通信。

---

## 3. Agent Communication Protocol（BeeAI/Linux Foundation）— 已归档

### 3.1 概述

- 原名 ACP，IBM BeeAI 团队发起
- 定位：Agent ↔ Agent 互操作（不是编辑器↔Agent）
- 2025-08 仓库归档，合并进 A2A（Agent-to-Agent）协议
- A2A 由 Google 发起，Linux Foundation 托管，v1.0.0 (2026-03-12)
- A2A 用 JSON-RPC 2.0 over HTTP，支持 SSE 流式 + 推送通知

### 3.2 A2A 核心概念

| 概念 | 说明 |
|---|---|
| Agent Card | Agent 能力声明（类似 MCP 的 tool list） |
| Task | 一次 Agent 执行，有状态机（WORKING/COMPLETED/FAILED/...） |
| Message | 角色消息（user/agent），含 parts 数组 |
| Part | 内容单元（text/file/structured data） |
| Artifact | Agent 生成的输出物 |

### 3.3 与 MCP 的关系

MCP 和 A2A/ACP(旧) 是互补关系：
- **MCP**：Agent ↔ 外部工具/数据源（垂直整合）
- **A2A**：Agent ↔ Agent（水平互操作）
- **ACP(新)**：编辑器 ↔ Agent（前端通信）

---

## 4. CLI 支持现状

### 4.1 Claude Code

| 能力 | 状态 |
|---|---|
| ACP (Agent Client Protocol) | **已支持** — Claude Code 是 ACP Agent 实现，IDE 扩展（VS Code/JetBrains）通过 ACP 与 Claude Code 进程通信 |
| `--output-format stream-json` | **已支持** — NDJSON 事件流，含 thinking/tool_use/text |
| `--input-format stream-json` | **已支持** — 双向流式通信 |
| `--output-format json` | **已支持** — 单次 JSON 结果 |
| `--json-schema` | **已支持** — 结构化输出 |
| Agent Teams | **实验性** — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，支持 TeamCreate/SendMessage |
| A2A | 不支持 |

### 4.2 其他 CLI

| CLI | ACP 支持 |
|---|---|
| OpenAI Codex CLI | **是** — `@zed-industries/codex-acp` npm 包存在 |
| Gemini CLI | **是** — TypeScript SDK 文档提到 Gemini CLI Agent 作为参考实现 |
| Cursor | 未知，可能通过私有协议 |
| Copilot | 未知 |

### 4.3 ACP 客户端（编辑器）

| 客户端 | 状态 |
|---|---|
| Zed | **主要推动者**，深度集成 ACP |
| VS Code | 通过 Claude Code 扩展支持 |
| JetBrains | 通过 Claude Code 扩展支持（有已知 bug） |
| acpx | 命令行 ACP 客户端（npm `acpx`） |

---

## 5. 与 MCP 的关系

```
┌──────────────────────────────────────────────────────────┐
│                     用户                                  │
│                      ↕                                    │
│              ┌──────────────┐                             │
│              │  Client/IDE  │  ◄── ACP ──►  Agent        │
│              └──────────────┘               (Claude Code) │
│                                                ↕          │
│                                    ┌──────────────────┐   │
│                                    │   MCP Servers    │   │
│                                    │  (工具/数据源)    │   │
│                                    └──────────────────┘   │
│                                                ↕          │
│                                    ┌──────────────────┐   │
│                                    │   A2A Agents     │   │
│                                    │  (其他 Agent)     │   │
│                                    └──────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

三层协议栈：
1. **ACP**：前端/编辑器 ↔ Agent（用户界面层）
2. **MCP**：Agent ↔ 工具/数据源（能力扩展层）
3. **A2A**：Agent ↔ Agent（多 Agent 协作层）

---

## 6. 对 mteam 的适用性分析

### 6.1 mteam 的核心需求

1. 用户在前端 UI 跟主 Agent 聊天
2. 看到 Agent 的思考过程（thinking）
3. 看到工具调用的实时状态（tool_call + progress）
4. 主 Agent 管理多个子 Agent（团队模式）
5. 替代 PTY stdin/stdout 的脆弱方案

### 6.2 方案对比

| 方案 | 优势 | 劣势 | 推荐度 |
|---|---|---|---|
| **ACP (Agent Client Protocol)** | 开放标准；Claude Code 原生支持；结构化 thinking/tool_call/permission；多编辑器兼容 | 定位是编辑器↔Agent，不是前端↔Agent；stdio 传输在自定义 UI 场景需要适配 | ★★★★ |
| **Claude CLI stream-json** | 零额外依赖；Claude Code 已内置；双向流式；包含 thinking/tool_use/result 完整事件 | Anthropic 专有格式；不保证跨版本稳定；不是正式协议 | ★★★★★ |
| **A2A** | 正式标准 v1.0；多框架支持 | 定位是 Agent↔Agent 不是前端↔Agent；过重 | ★★ |
| **自定义 WebSocket + JSON** | 完全可控 | 需要自己定义所有消息类型 | ★★★ |

### 6.3 推荐方案

**方案 A（推荐）：Claude CLI stream-json 作为传输层 + ACP 消息语义**

理由：
1. **Claude CLI 的 `--output-format stream-json` + `--input-format stream-json`** 已经提供了完整的结构化双向通信：
   - `system/init` — 会话初始化（工具列表、模型、MCP 状态）
   - `assistant` 消息 — 含 thinking、text、tool_use content blocks
   - `user` 消息 — 工具结果回传
   - `result` — 最终结果 + 统计
2. mteam 后端 spawn `claude -p --output-format stream-json --input-format stream-json`，解析 NDJSON 事件流
3. 前端通过 WebSocket 接收后端转发的结构化事件
4. 参考 ACP 的消息语义（session/update、tool_call、plan）设计前端展示

```
┌──────────┐  WebSocket   ┌──────────┐  stdio NDJSON  ┌──────────┐
│  前端 UI  │ ◄──────────► │ mteam    │ ◄────────────► │ claude   │
│  (React)  │  ACP-like   │ Backend  │  stream-json   │ CLI      │
└──────────┘  消息格式     └──────────┘                └──────────┘
```

**具体实施步骤：**

1. **替换 PTY** — 改用 `spawn('claude', ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'])` + stdin/stdout pipe
2. **解析 NDJSON** — 每行一个 JSON 事件，按 type 分发
3. **前端事件映射**：
   - `system/init` → 显示工具列表、模型信息
   - `assistant` + `content[type=thinking]` → 思考过程面板
   - `assistant` + `content[type=text]` → 聊天气泡
   - `assistant` + `content[type=tool_use]` → 工具调用卡片（开始）
   - `user` + `tool_result` → 工具调用卡片（结果）
   - `result` → 对话结束标记
4. **多 Agent** — 每个 Agent 是一个独立的 claude 进程，各自的 stream-json 流独立解析
5. **权限请求** — 用 `--allowedTools` 预授权，或用 `--permission-mode auto`

**方案 B（未来升级路径）：原生 ACP**

如果 ACP 协议稳定到 v1.0+，且有非 stdio 传输（HTTP/WebSocket），可以直接让 mteam Backend 作为 ACP Client 连接 Claude Code Agent。当前 ACP 还在 v0.x 快速迭代，不建议直接依赖。

---

## 7. 关键 npm 包参考

| 包名 | 说明 | 版本 |
|---|---|---|
| `@agentclientprotocol/sdk` | ACP 官方 TS SDK | 0.20.0 |
| `acpx` | ACP 命令行客户端 | 0.5.3 |
| `acp-sdk` | Agent Communication Protocol SDK（已停维） | 1.0.3 |
| `@zed-industries/codex-acp` | Codex 的 ACP Agent 实现 | 0.11.1 |

---

## 8. 总结

| 问题 | 回答 |
|---|---|
| ACP 能解决 mteam 的通信问题吗？ | **能，但不是直接用 ACP 协议，而是用 Claude CLI 的 stream-json 格式** |
| 需要额外安装什么？ | **不需要** — Claude CLI 已内置 stream-json 支持 |
| 比 PTY 好在哪？ | 结构化 JSON 而非纯文本流；有明确的事件类型；thinking/tool_use/result 分离 |
| 前端能看到思考过程吗？ | **能** — thinking content block 有完整推理文本 |
| 前端能看到工具调用吗？ | **能** — tool_use content block 有工具名+参数，user 消息有 tool_result |
| 什么时候该用正式 ACP？ | ACP 到 v1.0 且支持 HTTP/WebSocket 传输时，可以考虑迁移 |

---

## 9. 主流 Agent CLI 结构化通信能力对照表

> 调研日期：2026-04-23
> 过滤标准：仅独立命令行工具（终端直接运行、可 spawn 为子进程），排除编辑器/IDE 内嵌 Agent（Cursor、VS Code 扩展、JetBrains 插件等）。

### 9.1 对照表

| CLI | 厂商 | 安装 | 结构化输出 | 结构化输入 | MCP | ACP | 思考/工具/回复分离 |
|-----|------|------|----------|----------|-----|-----|-----------------|
| **Claude Code** | Anthropic | `brew install --cask claude-code` / `curl` 安装脚本 / npm (deprecated) | **完整** — `--output-format json` (单次) / `stream-json` (NDJSON 事件流) / `--json-schema` (结构化响应) | **完整** — `--input-format stream-json` (stdin NDJSON 双向流) | **是** — `claude mcp` 子命令 + `--mcp-config` flag | **是** — 作为 ACP Agent 实现（IDE 扩展通过 ACP 与 CLI 进程通信） | **是** — assistant 消息的 content blocks 按 type 区分: `thinking` / `text` / `tool_use`; user 消息含 `tool_result` |
| **Codex CLI** | OpenAI | `npm i -g @openai/codex` / `brew install --cask codex` | **完整** — `codex exec --json` (JSONL 事件流: thread.started, turn.started/completed, item.*) / `--output-schema` (JSON Schema 约束最终响应) | **部分** — stdin 管道输入文本（非结构化 JSON），`codex exec -` 从 stdin 读 prompt | **是** — `codex mcp` 子命令管理 MCP 服务器 | **是** — 在 ACP 官方 agents 列表中 | **是** — JSONL 事件流中 item.type 区分: `agent_message` / `reasoning` / `command_execution` / `file_change` / `mcp_tool_call` |
| **Gemini CLI** | Google | `npm i -g @google/gemini-cli` / `brew install gemini-cli` / conda / npx | **完整** — `--output-format json` (单次 JSON) / `stream-json` (NDJSON 事件流) | **未记录** — 文档未提及结构化 stdin 输入 | **是** — `~/.gemini/settings.json` 配置 MCP 服务器 | **是** — 在 ACP 官方 agents 列表中 | **部分** — stream-json 输出 NDJSON 事件，但事件类型细节未公开文档化 |
| **Qwen Code** | 阿里 (Qwen) | `npm i -g @qwen-code/qwen-code` / `brew install qwen-code` | **未记录** — 有 `-p` 非交互模式，但未见 `--output-format` 或 JSON 输出 flag | **未记录** — 支持管道输入文本，无结构化 JSON 输入 | **是** — 文档明确提及 MCP 支持 | **是** — 在 ACP 官方 agents 列表中（列为 "Qwen Code"） | **未记录** — 无公开文档说明输出事件分离 |
| **Trae Agent** | ByteDance | `git clone` + `uv sync`（Python 环境） | **部分** — `--trajectory-file` 保存完整执行轨迹为 JSON 文件（非实时流，事后分析用） | **否** — 任务通过 CLI 参数传入自然语言，无结构化 stdin | **是** — YAML 配置 `mcp_servers` | **否** — 未提及 ACP | **是** — trajectory JSON 文件中包含 LLM 交互、agent 步骤、工具使用、执行元数据，按步骤区分 |
| **Aider** | 开源 (Paul Gauthier) | `pip install aider-install && aider-install` | **否** — 无 JSON 输出 flag；`-m/--message` 非交互模式输出纯文本到 stdout | **否** — `--message` / `--message-file` 传入文本指令，无结构化 JSON 输入 | **否** — 无内置 MCP 支持 | **否** — 未提及 ACP | **否** — 输出为纯文本流，无事件类型区分 |
| **Goose** | Block (Square) | `curl` 安装脚本 / 桌面应用下载 | **未记录** — 有 CLI 模式但未见 JSON 输出 flag 文档 | **未记录** | **是** — 支持 70+ MCP 扩展 | **是** — 在 ACP 官方 agents 列表中 | **未记录** |
| **OpenHands CLI** | All Hands AI (开源) | `uv tool install openhands` / `curl` 安装脚本 | **是** — `--headless --json` 输出 JSON | **部分** — `-t "task"` / `-f file` 传入任务，非结构化 JSON 流 | **是** — `openhands mcp` 管理 MCP 服务器 | **是** — 在 ACP 官方 agents 列表中；`openhands acp` 命令连接 IDE | **未记录** — `--json` 输出格式细节未公开 |
| **Amp** | Sourcegraph | `curl -fsSL https://ampcode.com/install.sh \| bash` | **未记录** — 闭源 CLI，文档未提及 JSON 输出 | **未记录** | **未记录** | **未记录** | **未记录** |

### 9.2 各 CLI 简要说明

**Claude Code (Anthropic)**
最成熟的结构化通信方案。`--output-format stream-json` 输出完整 NDJSON 事件流，每个 assistant 消息含 content blocks 数组，按 type 严格区分 thinking（推理过程）、text（最终回复）、tool_use（工具调用）。配合 `--input-format stream-json` 实现完整双向结构化通信。`--json-schema` 可约束最终输出为指定 JSON 格式。支持 ACP，IDE 扩展通过 ACP JSON-RPC over stdio 与 CLI 进程通信。内置 MCP 服务器管理。

**Codex CLI (OpenAI)**
`codex exec --json` 输出 JSONL 事件流，事件类型丰富（thread/turn/item 层级），item 类型包括 agent_message、reasoning、command_execution、file_change、mcp_tool_call 等，区分度好。`--output-schema` 支持 JSON Schema 约束最终响应。stdin 支持管道文本输入但非结构化 JSON 流。已在 ACP 官方列表中。Rust 实现，带沙箱。

**Gemini CLI (Google)**
支持 `--output-format json` 和 `stream-json` 两种模式，与 Claude Code 的 flag 命名一致。文档称 stream-json 为"newline-delimited JSON events"，但事件类型的详细 schema 未公开文档化。MCP 通过 settings.json 配置。已在 ACP 官方列表中。

**Qwen Code (阿里)**
阿里通义千问团队的终端 Agent CLI，定位类似 Claude Code。安装方式与 Claude Code 类似（npm / brew / 安装脚本）。有 `-p` 非交互模式和管道支持，但目前文档中未暴露 `--output-format` 或 JSON 输出相关 flag。支持 MCP。已在 ACP 官方 agents 列表中。作为新产品，结构化通信能力可能尚在开发中。

**Trae Agent (ByteDance)**
字节跳动开源的 CLI agent，Python 实现。不提供实时结构化事件流，但通过 `--trajectory-file` 将完整执行轨迹保存为 JSON 文件，包含每步的 LLM 交互、工具调用、执行结果。适合事后分析但不适合实时 UI 驱动。支持 MCP。不支持 ACP。

**Aider (开源)**
专注于代码编辑的 CLI agent，面向单次改动场景。`--message` 非交互模式只输出纯文本，无 JSON 输出。无 MCP 支持。无 ACP 支持。有非官方 Python API (`Coder` 类) 但不保证稳定。在结构化通信方面最弱。

**Goose (Block/Square)**
Block (原 Square) 开源的通用 AI agent，有 CLI 和桌面应用。支持 70+ MCP 扩展。已在 ACP 官方列表中。但 CLI 的结构化输出能力文档不足，未见 JSON 输出 flag 的明确记录。

**OpenHands CLI (All Hands AI)**
前身 OpenDevin，开源 agent 平台。CLI 支持 `--headless --json` 输出 JSON 格式结果。有 `openhands acp` 命令支持 ACP 连接 IDE。内置 MCP 管理。Python 实现，也有独立二进制。

**Amp (Sourcegraph)**
Sourcegraph 的付费 agent CLI。闭源，文档较少，结构化通信能力未公开。定位高端付费用户。

### 9.3 结论

**结构化输出能力排名：**

1. **第一梯队（完整双向结构化流）**：Claude Code、Codex CLI
   - 实时 NDJSON 事件流 + 事件类型明确区分 + JSON Schema 约束
   - Claude Code 额外支持双向 stream-json（stdin + stdout）
2. **第二梯队（有结构化输出）**：Gemini CLI、OpenHands CLI
   - 有 JSON / stream-json 输出，但事件细节文档不足
3. **第三梯队（部分/离线结构化）**：Trae Agent、Qwen Code
   - Trae: trajectory 文件（事后分析，非实时）
   - Qwen Code: 新产品，结构化 flag 可能在开发中
4. **第四梯队（无结构化）**：Aider、Goose、Amp
   - 纯文本输出或文档不足

**对 mteam 的启示：**

- Claude Code 的 `stream-json` 仍是最适合 mteam 的方案（完整双向流 + 事件分离）
- Codex CLI 的 `--json` JSONL 也是可行的通信方案，如果需要支持 OpenAI 模型
- ACP 已有 39 个 Agent 实现，未来可作为统一 Agent 接入层
- 大部分 CLI 已支持 MCP，说明 MCP 生态已成主流
