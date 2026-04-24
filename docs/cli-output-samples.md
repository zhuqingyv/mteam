# CLI Structured Output Samples

采集日期：2026-04-24

---

## Claude CLI

- **版本**：2.1.119 (Claude Code)
- **安装路径**：`/Users/zhuqingyu/.local/bin/claude`

### 格式 1：`--output-format json`（单个 JSON 对象）

**命令**：
```bash
claude -p '你好，简单介绍一下自己' --output-format json 2>/dev/null
```

**完整输出**（单行 JSON，已格式化）：
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 18763,
  "duration_api_ms": 23846,
  "num_turns": 3,
  "result": "我是 Claude，Anthropic 构建的 AI 助手...",
  "stop_reason": "end_turn",
  "session_id": "e00c8484-77f3-465e-918e-fd580b1afb22",
  "total_cost_usd": 0.09797135,
  "usage": {
    "input_tokens": 7,
    "cache_creation_input_tokens": 21121,
    "cache_read_input_tokens": 40852,
    "output_tokens": 405,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 21121
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputTokens": 351,
      "outputTokens": 13,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.000416,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    },
    "global.anthropic.claude-sonnet-4-6": {
      "inputTokens": 7,
      "outputTokens": 405,
      "cacheReadInputTokens": 40852,
      "cacheCreationInputTokens": 21121,
      "webSearchRequests": 0,
      "costUSD": 0.09755535,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [
    {
      "tool_name": "mcp__mnemo__search",
      "tool_use_id": "toolu_bdrk_01BeKXBuh1kGFPbgPUQe7Z8w",
      "tool_input": {
        "query": "项目介绍 mcp-team-hub",
        "task_context": "onboarding"
      }
    }
  ],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "29678548-a730-4003-9eee-f9f33743d685"
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定 `"result"` |
| `subtype` | string | `"success"` 或 `"error"` |
| `is_error` | bool | 是否出错 |
| `api_error_status` | int/null | API 错误码，正常为 null |
| `duration_ms` | int | 总耗时（毫秒） |
| `duration_api_ms` | int | API 调用耗时（毫秒） |
| `num_turns` | int | 对话轮次 |
| `result` | string | 最终文本输出 |
| `stop_reason` | string | 停止原因：`"end_turn"` / `"max_tokens"` 等 |
| `session_id` | string | 会话 UUID |
| `total_cost_usd` | float | 总费用（美元） |
| `usage` | object | 聚合 token 用量 |
| `modelUsage` | object | 按模型分拆的 token 用量和费用 |
| `permission_denials` | array | 被拒绝的工具调用列表 |
| `terminal_reason` | string | 终止原因：`"completed"` |
| `fast_mode_state` | string | 快速模式状态 |
| `uuid` | string | 本次结果的唯一 ID |

---

### 格式 2：`--output-format stream-json`（NDJSON 流）

**命令**：
```bash
claude -p '你好，简单介绍一下自己' --output-format stream-json --verbose 2>/dev/null
```

> 注意：`stream-json` 必须搭配 `--verbose` 才能在 `--print` 模式下使用，否则报错：
> `Error: When using --print, --output-format=stream-json requires --verbose`

**完整输出**（每行一个 JSON，共 8 行）：

**第 1 行 — init 事件**：
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/zhuqingyu/project/mcp-team-hub",
  "session_id": "787baa3c-6b05-450d-95fa-2ca2338cd3dd",
  "tools": ["Task", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Read", "Write", "..."],
  "mcp_servers": [
    {"name": "pencil", "status": "failed"},
    {"name": "notify", "status": "connected"},
    {"name": "mnemo", "status": "connected"}
  ],
  "model": "global.anthropic.claude-sonnet-4-6",
  "permissionMode": "default",
  "slash_commands": ["update-config", "debug", "simplify", "..."],
  "apiKeySource": "none",
  "claude_code_version": "2.1.119",
  "output_style": "default",
  "agents": ["Explore", "general-purpose", "Plan", "statusline-setup"],
  "skills": ["update-config", "debug", "simplify", "..."],
  "plugins": [
    {"name": "typescript-lsp", "path": "...", "source": "typescript-lsp@claude-plugins-official"}
  ],
  "analytics_disabled": true,
  "uuid": "c5017199-e0e6-4229-be2f-bf5c618df352",
  "memory_paths": {"auto": "/Users/zhuqingyu/.claude/projects/.../memory/"},
  "fast_mode_state": "off"
}
```

**第 2 行 — assistant thinking**：
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_bdrk_01WJiAj1RM9TT7CW8cb6BHKD",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants me to introduce myself...",
        "signature": "EskCCkgIDRAB..."
      }
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 19863,
      "output_tokens": 0
    }
  },
  "session_id": "787baa3c-6b05-450d-95fa-2ca2338cd3dd",
  "uuid": "42ec3be9-7d14-4129-8525-dec08dcd1c81"
}
```

**第 3 行 — assistant tool_use**：
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_bdrk_01RUir9xbJtWdz776TMcHomx",
        "name": "ToolSearch",
        "input": {"query": "select:mcp__mnemo__search", "max_results": 1}
      }
    ],
    "stop_reason": null
  },
  "session_id": "...",
  "uuid": "..."
}
```

**第 4 行 — user (tool_result)**：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_bdrk_01RUir9xbJtWdz776TMcHomx",
        "content": [
          {"type": "tool_reference", "tool_name": "mcp__mnemo__search"}
        ]
      }
    ]
  },
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-04-24T06:00:38.296Z",
  "tool_use_result": {
    "matches": ["mcp__mnemo__search"],
    "query": "select:mcp__mnemo__search",
    "total_deferred_tools": 34
  }
}
```

**第 5 行 — assistant thinking (第 2 轮)**：
```json
{
  "type": "assistant",
  "message": {
    "content": [{"type": "thinking", "thinking": "...", "signature": "..."}],
    "stop_reason": null
  }
}
```

**第 6 行 — assistant tool_use (mnemo search, 被 denied)**：
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_bdrk_01JbBSQDRfRxYm5JUqEEFwEB",
        "name": "mcp__mnemo__search",
        "input": {"query": "项目介绍 mcp-team-hub 总体架构", "task_context": "onboarding"}
      }
    ]
  }
}
```

**第 7 行 — user (permission denied error)**：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "content": "Claude requested permissions to use mcp__mnemo__search, but you haven't granted it yet.",
        "is_error": true,
        "tool_use_id": "toolu_bdrk_01JbBSQDRfRxYm5JUqEEFwEB"
      }
    ]
  },
  "tool_use_result": "Error: Claude requested permissions to use mcp__mnemo__search, but you haven't granted it yet."
}
```

**第 8 行 — assistant final text**：
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "text",
        "text": "我是 Claude，Anthropic 构建的 AI 助手..."
      }
    ],
    "stop_reason": null
  }
}
```

**第 9 行 — result（与 json 格式相同）**：
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 16554,
  "duration_api_ms": 19139,
  "num_turns": 3,
  "result": "我是 Claude，Anthropic 构建的 AI 助手...",
  "stop_reason": "end_turn",
  "session_id": "787baa3c-6b05-450d-95fa-2ca2338cd3dd",
  "total_cost_usd": 0.02629305,
  "usage": {"...": "..."},
  "modelUsage": {"...": "..."},
  "permission_denials": ["..."],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "..."
}
```

**stream-json 事件类型汇总**：

| type | subtype | 说明 |
|------|---------|------|
| `system` | `init` | 初始化信息：cwd、工具列表、模型、MCP 服务器状态等 |
| `assistant` | — | 模型输出，content 数组包含 `thinking` / `tool_use` / `text` |
| `user` | — | 工具执行结果返回，包含 `tool_result` |
| `result` | `success` / `error` | 最终结果，与 `--output-format json` 输出结构一致 |

**assistant message content block types**：

| content.type | 说明 |
|--------------|------|
| `thinking` | 思考过程（含 signature 签名） |
| `tool_use` | 工具调用（含 name、input） |
| `text` | 最终文本回复 |

---

## Codex CLI

- **版本**：codex-cli 0.118.0
- **安装路径**：`/Users/zhuqingyu/.nvm/versions/node/v20.19.4/bin/codex`

### `codex exec --json`（NDJSON 流）

**命令**：
```bash
codex exec --json '你好，简单介绍一下自己' 2>/dev/null
```

**完整输出**（每行一个 JSON，共 3 行）：

**第 1 行 — thread.started**：
```json
{
  "type": "thread.started",
  "thread_id": "019dbe13-a916-77d3-ba78-57273649adff"
}
```

**第 2 行 — turn.started**：
```json
{
  "type": "turn.started"
}
```

**第 3 行 — item.completed**：
```json
{
  "type": "item.completed",
  "item": {
    "id": "item_0",
    "type": "agent_message",
    "text": "我是你的编程协作助手（Codex），在这个工作区里可以直接帮你做实际工作，比如：\n\n- 阅读和修改代码\n- 运行命令、排查报错、补测试\n- 实现功能、重构、做代码评审\n- 查文档并给出可执行的技术方案\n\n风格上我会尽量直接、务实，先把事情做成，再清楚说明改了什么和为什么。"
  }
}
```

**第 4 行 — turn.completed**：
```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 11200,
    "cached_input_tokens": 9856,
    "output_tokens": 102
  }
}
```

**字段说明**：

| 事件 type | 说明 |
|-----------|------|
| `thread.started` | 线程启动，包含 `thread_id` |
| `turn.started` | 一轮对话开始 |
| `item.completed` | 一个完成的输出项，`item.type` 可以是 `agent_message`（文本）或其他类型（工具调用等） |
| `turn.completed` | 一轮对话结束，包含 `usage` token 统计 |

**item types**（根据文档和观测）：

| item.type | 说明 |
|-----------|------|
| `agent_message` | 模型文本输出，`text` 字段为内容 |
| `tool_call` | 工具调用（本次简单问答未触发） |
| `tool_output` | 工具执行结果（本次未触发） |

---

## 对比总结

| 维度 | Claude CLI | Codex CLI |
|------|-----------|-----------|
| 版本 | 2.1.119 | 0.118.0 |
| JSON 格式 | `--output-format json`（单 JSON）或 `stream-json`（NDJSON） | `--json`（NDJSON） |
| 流式必要条件 | `stream-json` 需要搭配 `--verbose` | 无额外条件 |
| init 事件 | 有（包含完整工具列表、MCP 状态、模型等） | 仅 `thread.started` + `thread_id` |
| thinking 可见 | 是（`content.type=thinking`） | 否 |
| 工具调用可见 | 是（`content.type=tool_use` + `tool_result`） | 是（`item.type=tool_call`） |
| 最终结果 | `type=result` 包含完整元数据（cost、usage、session_id） | `type=turn.completed` 仅含 token usage |
| 费用信息 | `total_cost_usd` + 按模型分拆的 `costUSD` | 无 |
| session/thread ID | `session_id`（UUID） | `thread_id`（UUID v7） |
