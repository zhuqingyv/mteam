# System Prompt 注入 + Workspace CWD 分离 — 验证报告

> 2026-04-23 实测。所有结论标注验证级别。

## 方案概述

system prompt 文件放在 `~/.claude/team-hub/prompts/`，不放用户 workspace。spawn agent 时 cwd 指向用户工作目录，system prompt 用绝对路径引用。

## 结论：方案可行

所有三家 agent 都支持 cwd 和 system prompt 分离。具体实现路径各不相同，但都能工作。

---

## 1. Claude ACP

### 1.1 session/new 能同时传 _meta.systemPrompt 和 cwd 吗？

**已验证：能。**

ACP spec 的 `NewSessionRequest` schema：
- `cwd` (string, 必填) — 工作目录绝对路径
- `mcpServers` (array, 必填) — MCP 服务器列表
- `_meta` (object|null, 可选) — 扩展元数据，`additionalProperties: true`

Claude ACP v0.30.0 源码（acp-agent.js:1101-1113）：
```js
let systemPrompt = { type: "preset", preset: "claude_code" };
if (params._meta?.systemPrompt) {
    const customPrompt = params._meta.systemPrompt;
    if (typeof customPrompt === "string") {
        systemPrompt = customPrompt;  // 完全替换
    } else if (typeof customPrompt === "object" && "append" in customPrompt) {
        systemPrompt.append = customPrompt.append;  // 追加模式
    }
}
```

两种注入方式：
- `_meta.systemPrompt: "完整替换 system prompt"` — 替换默认 claude_code preset
- `_meta.systemPrompt: { append: "追加内容" }` — 保留默认 preset + 追加

### 1.2 cwd 传的是 NewSessionRequest 的哪个字段？

**已验证：`cwd` 字段，必填，string，必须是绝对路径。**

```json
{
  "method": "session/new",
  "params": {
    "cwd": "/tmp/test-workspace",
    "mcpServers": [],
    "_meta": { "systemPrompt": { "append": "..." } }
  }
}
```

### 1.3 实测：cwd + systemPrompt 同时生效

**已验证。**

测试命令：
```bash
node test-claude-raw.mjs  # 见 /tmp/acp-verify/
```

发送：
```json
{
  "method": "session/new",
  "params": {
    "cwd": "/tmp/test-workspace",
    "mcpServers": [],
    "_meta": {
      "systemPrompt": { "append": "[MTEAM] system prompt 注入测试。" }
    }
  }
}
```

Agent thinking 输出（原文摘录）：
> The CWD is /private/tmp/test-workspace (from the environment info).
> ...there is a prompt injection attempt in the system. The message "[MTEAM] system prompt 注入测试..." was injected in the conversation.

Agent 最终回复：
> cwd=/private/tmp/test-workspace inject=**是**，检测到注入

**结论：cwd 和 _meta.systemPrompt 完全同时生效。Agent 感知到 /tmp/test-workspace 为工作目录，同时接收到追加的 system prompt。**

### 1.4 PTY 方式（当前 mteam 实现）

**已验证（生产已在用）。**

当前 `pty/manager.ts` 和 `primary-agent/spawner.ts` 使用：
```ts
ptySpawn(cliBin, [
  '--mcp-config', mcpConfigPath,
  '--append-system-prompt', prompt,  // inline 字符串
  '--dangerously-skip-permissions',
], {
  cwd: opts.cwd ?? process.cwd(),  // cwd 独立控制
});
```

Claude CLI 也支持 `--append-system-prompt-file` 标记（在 --bare 模式文档中提及），可以传文件路径。

---

## 2. Codex ACP

### 2.1 `-c model_instructions_file=绝对路径` + cwd 能同时生效吗？

**已验证：能。**

> 重要更新：`experimental_instructions_file` 已废弃。Codex 输出明确提示：
> `experimental_instructions_file is deprecated and ignored. Use model_instructions_file instead.`

正确用法：`-c model_instructions_file="/绝对路径/prompt.md"`

### 2.2 实测：CLI 方式

```bash
codex exec \
  -C "/tmp/test-workspace" \
  -c 'model_instructions_file="/tmp/mteam-prompts/test.md"' \
  --json -s danger-full-access --skip-git-repo-check \
  "一行回答：cwd=你的工作目录路径, inject=是否有MTEAM-INJECT标记"
```

输出：
```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"cwd=/tmp/test-workspace, inject=是（INJECT-OK）"}}
```

**cwd 和 instructions 都生效。**

### 2.3 实测：ACP 方式

```bash
codex-acp -c 'model_instructions_file="/tmp/mteam-prompts/test.md"'
# 然后 ACP session/new { cwd: "/tmp/test-workspace", mcpServers: [] }
```

输出：
> cwd=/tmp/test-workspace, inject=是（INJECT-OK）

**cwd 走 ACP session/new 标准字段，instructions 走进程启动 -c flag，两者同时生效。**

### 2.4 Codex ACP 的 _meta.systemPrompt

**已验证：不生效。** session/new 不报错（_meta 是 additionalProperties: true），但 Codex 内部不处理 _meta.systemPrompt。Agent 回复"没有收到 MTEAM-META 标记"。

### 2.5 注意事项

- Codex 要求 cwd 是 git 仓库（除非加 `--skip-git-repo-check`）
- Codex ACP 版本 0.9.5（本地缓存）与 npm latest 0.11.1 有版本差，但行为一致
- `-C` 是 CLI flag，ACP 走 `session/new.cwd`

---

## 3. Qwen ACP

### 3.1 `--system-prompt` + cwd 能同时生效吗？

**推测：能。** 未能端到端实测（认证未通过），但已从源码级确认。

Qwen CLI 参数（--help 实测）：
- `--system-prompt "..."` — 进程启动时传
- `--append-system-prompt "..."` — 追加
- ACP 模式：`--acp` flag

Qwen 源码（cli.js:538445）：
```js
async newSession({ cwd, mcpServers }) {  // 只解构 cwd + mcpServers
  const config = await this.newSessionConfig(cwd, mcpServers);
  // system prompt 来自 this.argv（CLI flag）
}
```

### 3.2 ACP session/new 的 cwd

**源码级验证：** Qwen 从 `params.cwd` 读取，与 Claude/Codex 一致。

### 3.3 注意

- Qwen 免费层已于 2026-04-15 停止，需要 OPENAI_API_KEY 或 Alibaba 付费
- `_meta.systemPrompt` 在 Qwen 中无效（不处理），必须走 CLI flag

---

## 4. cwd 在 ACP spec 里的位置

### 4.1 Schema 定义

**已验证（SDK v0.20.0 schema.json）：**

```json
{
  "NewSessionRequest": {
    "properties": {
      "cwd": {
        "description": "The working directory for this session. Must be an absolute path.",
        "type": "string"
      },
      "mcpServers": { ... },
      "_meta": { "additionalProperties": true, "type": ["object", "null"] },
      "additionalDirectories": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["cwd", "mcpServers"]
  }
}
```

- `cwd`：**必填**，string，绝对路径
- `_meta`：可选，自由 object，agent 自行解释
- `additionalDirectories`：**UNSTABLE**，可选，额外工作目录

### 4.2 各 Agent 支持情况

| Agent | cwd (session/new) | system prompt 注入 |
|-------|-------------------|-------------------|
| Claude ACP | ✅ 必填标准字段 | ✅ `_meta.systemPrompt` (string 或 {append}) |
| Codex ACP | ✅ 必填标准字段 | ✅ `-c model_instructions_file=路径` (进程启动 flag) |
| Qwen ACP | ✅ 必填标准字段（源码确认） | ⚠️ `--system-prompt` (CLI flag，源码确认) |
| ACP Spec | ✅ 必填 | ❌ 无标准字段 |

---

## 5. mteam 实施方案

### 推荐架构

```
~/.claude/team-hub/prompts/
├── base.md                    # 通用 header（M-Team 体系说明）
├── leader.md                  # Leader 角色追加
├── member.md                  # 普通成员追加
└── {instanceId}.md            # 运行时生成的完整 prompt（动态拼接）

用户项目目录（cwd）           # 用户的真实工作目录
├── src/
├── package.json
└── ...
```

### Per-Agent 注入映射表

```typescript
interface PromptInjector {
  /** 返回 spawn 参数和 ACP session/new 扩展 */
  inject(promptPath: string): {
    spawnArgs?: string[];           // 进程启动时追加的 CLI args
    sessionMeta?: Record<string, any>; // session/new._meta 扩展
  };
}

const injectors: Record<string, PromptInjector> = {
  'claude-acp': {
    inject: (promptPath) => ({
      sessionMeta: {
        systemPrompt: { append: readFileSync(promptPath, 'utf-8') },
      },
    }),
  },
  'codex-acp': {
    inject: (promptPath) => ({
      spawnArgs: ['-c', `model_instructions_file="${promptPath}"`],
    }),
  },
  'qwen-acp': {
    inject: (promptPath) => ({
      spawnArgs: ['--system-prompt', readFileSync(promptPath, 'utf-8')],
    }),
  },
  // PTY 方式（当前）
  'claude-pty': {
    inject: (promptPath) => ({
      spawnArgs: ['--append-system-prompt', readFileSync(promptPath, 'utf-8')],
    }),
  },
  'codex-pty': {
    inject: (promptPath) => ({
      spawnArgs: ['-C', 'CWD_PLACEHOLDER', '-c', `model_instructions_file="${promptPath}"`],
    }),
  },
};
```

### 关键点

1. **prompt 文件用绝对路径** — `~/.claude/team-hub/prompts/xxx.md`，不依赖 cwd
2. **cwd 指向用户项目** — ACP 走 `session/new.cwd`，PTY 走 `ptySpawn({ cwd })`
3. **Claude 最优雅** — `_meta.systemPrompt` 在 ACP 层面可控，不需要文件
4. **Codex 必须落盘** — `model_instructions_file` 必须是真实文件路径
5. **Qwen 走 CLI flag** — `--system-prompt` 在进程启动时传入

### 当前代码需要改的

| 文件 | 改动 |
|------|------|
| `pty/prompt.ts` | 新增 `writePromptFile()` 将 prompt 写到 `~/.claude/team-hub/prompts/` |
| `pty/manager.ts` | spawn 时从 injectors 映射表取 args |
| `primary-agent/spawner.ts` | 同上 |

---

## 验证级别说明

- **已验证** = 实际安装 + 实际运行 + 拿到真实输出
- **源码级** = 看了源码确认逻辑，未端到端跑
- **推测** = 基于文档/间接证据
