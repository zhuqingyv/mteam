# ACP 综合验证报告

> 3 人并行实测，所有结论标注验证级别。2026-04-24。

---

## 结论矩阵

| 维度 | Claude ACP | Codex ACP | Qwen ACP | ACP Spec |
|------|-----------|-----------|----------|----------|
| 包版本 | 0.30.0 (4天前) | 0.11.1 (3周前) | 0.15.1 (昨天) | SDK 0.20.0 |
| 安装可用 | ✅ 已验证 | ✅ 已验证 | ✅ 已验证(握手通) | — |
| MCP 注入 | ✅ session/new.mcpServers | ✅ session/new.mcpServers | ✅ session/new.mcpServers | ✅ 标准字段 |
| System Prompt | ✅ _meta.systemPrompt | ⚠️ 只能走文件(-c experimental_instructions_file) | ⚠️ 只能走 CLI flag(--system-prompt) | ❌ spec 无标准字段 |
| Env 透传 | ✅ process.env 全继承 | ⚠️ MCP 子进程白名单隔离 | 未实测 | — |
| Thinking | ✅ agent_thought_chunk 实测有 | ❌ ChatGPT auth 下实测 0 条 | 未实测(认证未通过) | ✅ 标准字段 |
| 端到端通信 | ✅ 完整跑通 | ✅ 完整跑通 | ⚠️ 握手通,认证未过 | — |

---

## 关键发现

### 1. MCP 注入：全部走 ACP 标准，无 blocker

三家都支持 `session/new.mcpServers[]`，是 ACP spec 标准字段。不需要再拼 `--mcp-config` CLI flag。

### 2. System Prompt：ACP spec 空白，每家各自处理

| Agent | 注入方式 | 备注 |
|-------|---------|------|
| Claude | `session/new._meta.systemPrompt` 或 `{append: "..."}` | 最优雅，ACP 层面可控 |
| Codex | `-c experimental_instructions_file=/path/to/file` | 必须落盘文件，inline 无效 |
| Qwen | `--system-prompt "..."` CLI flag | 进程启动时传，ACP 连上后无法修改 |

**mteam 需要维护一个 per-agent 的 prompt 注入映射表。**

### 3. Thinking：Claude 可靠，Codex 不可靠

- Claude：`agent_thought_chunk` 默认开启，实测有内容
- Codex：代码层有映射，但 ChatGPT auth 下服务端不返回 reasoning summary → ACP 收到空数据 → 前端 0 条
- Codex 要可靠 thinking 需要 API key 直连（推测，未实测）

**mteam 前端必须优雅降级 — 有 thinking 就显示，没有就只显示回复。**

### 4. Env 透传：差异大

- Claude：process.env 全继承 + _meta 可追加，最宽松
- Codex：MCP 子进程强隔离，只透传 mcpServers[].env 白名单，敏感 env 不泄露
- 结论：自定义 env（IS_LEADER 等）走 ACP 的 mcpServers[].env 传，不靠 process.env

### 5. CLI 发现：ACP Registry

官方 CDN `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，27 个 agent。每个 agent 有 npx/binary 分发方式。mteam 的 CLI 管理器可以从这里拉列表。

---

## 对 mteam 架构的影响

### 确认走 ACP

ACP 是正确方向。MCP 注入标准化，thinking 标准化（虽然 Codex 有坑），27 个 agent 生态。

### 需要调整的模块

| 模块 | 调整 |
|------|------|
| CLI 管理器 | 从 `which` 扫描改为 ACP Registry + 本地 npx 可用性检测 |
| 结构化 CLI Runner | 改为 ACP Client（用 `@agentclientprotocol/sdk`） |
| 主 Agent | spawn ACP 包而不是直接 spawn CLI |
| MCP 注入 | 走 `session/new.mcpServers` 而不是 `--mcp-config` |
| System Prompt | per-agent 映射表（Claude 走 _meta，Codex 走文件，Qwen 走 flag） |
| 前端 | thinking 优雅降级 |

### 不需要改的

| 模块 | 原因 |
|------|------|
| comm | agent 间通信走 Unix socket，跟 ACP 无关 |
| bus / RxJS | 内部事件分发不变 |
| team / roster | 数据层不变 |
| MCP Store | 仍管全局 MCP 运行配置 |

---

## 验证级别说明

- **已验证** = 实际安装 + 实际运行 + 拿到真实输出
- **源码级** = 看了源码确认逻辑，未端到端跑
- **推测** = 基于文档/间接证据
- **未实测** = 因认证/环境限制未能跑通
