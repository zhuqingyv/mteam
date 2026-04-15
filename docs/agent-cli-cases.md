# Agent CLI 管理 + 跨 Agent 通信 — 功能 Case 文档

> 规划日期：2026-04-14
> 功能方向：Agent CLI 扫描/唤起 + PTY 代理层 + 跨 Agent 消息通信

---

## 技术方案决策（2026-04-14 确认）

### 终端渲染方案：Electron + node-pty + xterm.js

**决策**：不打开外部终端（iTerm2/Warp/Terminal.app），在 Panel 内用 xterm.js 渲染终端。

**架构**：
```
Panel (Electron)
├── Main Process
│   ├── node-pty: spawn agent CLI 进程（claude/aider/gemini 等）
│   ├── PTY stdout → IPC 推送到 renderer
│   ├── PTY stdin ← IPC 接收用户输入 / team-hub 消息注入
│   └── 空闲检测：stdout 匹配 idle prompt pattern
│
└── 独立 BrowserWindow（每个 agent 一个窗口）
    ├── xterm.js 全屏渲染，看起来就是一个真正的终端
    ├── 窗口标题："{成员名} — {CLI名}"
    ├── 用户可见、可交互（Terminal.app 级别体验）
    └── 窗口关闭时自动 kill 对应 PTY session
```

**选择理由**（对比 8 种方案后确认）：

| 方案 | 可见 | stdout | stdin | 结论 |
|------|:----:|:------:|:-----:|------|
| **node-pty + xterm.js (Electron)** | ✅ | ✅ 完整流 | ✅ 完整 | **采用** |
| iTerm2 Python API | ✅ | ⚠️ 快照 | ⚠️ 模拟 | 仅限 iTerm2 |
| tmux Control Mode | ✅ | ✅ | ✅ | 复杂度高 |
| Terminal.app AppleScript | ✅ | ❌ | ❌ | 不可靠 |
| macOS Accessibility API | ✅ | ❌ | ⚠️ | 脆弱 |

**体验边界**：
- ✅ 每个 agent 独立 BrowserWindow（不是 Panel 内 tab，是真正的独立窗口）
- ✅ 基本终端交互（输入/输出/颜色/滚动/复制）
- ✅ team-hub 可同时捕获 stdout + 注入 stdin
- ✅ 长文本粘贴（bracketed paste mode 原生支持，无长度限制）
- ✅ 图片显示（`@xterm/addon-image` 支持 Sixel + iTerm2 IIP + Kitty Graphics MVP）
- ❌ 不做 Warp 级特性（命令块、光标点击定位、AI 补全）

### 图片协议兼容策略

Claude CLI 根据环境变量自动选择图片协议：
- `KITTY_WINDOW_ID` 存在 → Kitty Graphics Protocol
- `TERM_PROGRAM=iTerm.app` → iTerm2 IIP

node-pty spawn 时设置环境变量引导 CLI 走 IIP 路径：
```typescript
env: { ...process.env, TERM_PROGRAM: 'iTerm.app' }
```
配合 `@xterm/addon-image` 即可渲染。实测 Claude CLI 当前未使用终端内联图片（用文本占位符），此策略为未来兼容预留。

### 方案调整

原文档中以下 Case 因方案变更而调整：

| Case | 原设计 | 调整 |
|------|--------|------|
| BE-03 | 打开外部终端（iTerm2/Warp）启动 CLI | 改为 Panel 内 node-pty spawn + xterm.js 渲染 |
| BE-04 | 扫描本地终端工具 | **废弃** — 不再需要外部终端 |
| BE-05 | 用户终端偏好持久化 | **废弃** — 不再需要终端选择 |
| FE-04 | 带队 — 终端选择弹窗 | **废弃** — 不再需要终端选择 |
| FE-09 | 内嵌终端视图（P1） | **提升为 P0** — 成为 agent 的主要工作界面 |
| SP-04 | Warp/iTerm2 deep link 验证 | **废弃** — 不使用外部终端 |

---

## 目录

- [后端 Case（BE）](#后端-case)
- [前端 Case（FE）](#前端-case)
- [架构风险 Spike](#架构风险-spike)
- [建议落地顺序](#建议落地顺序)

---

## 后端 Case

### BE-01 扫描本地 agent CLI（P0）

**目标**：检测用户机器上已安装的 agent CLI 工具。

- 通过 `which` + `--version` 检测 claude / chatgpt / gemini / aider 等
- 输出：`found` 列表（name / bin / version）+ `not_found` 列表
- **边界情况**：
  - 全空 → `found: []`
  - 超时 → 标记 `version: "unknown"`
  - 无权限 → `status: "no_permission"`
- **挂载**：IPC `scan-agent-clis` + HTTP `GET /api/agent-clis`

---

### BE-02 扫描结果持久化与缓存（P1）

**目标**：避免每次启动都重新扫描，提升响应速度。

- 写入 `~/.claude/team-hub/agent_clis.json`，TTL 24h
- 支持 `force=true` 强制重扫
- **边界情况**：
  - 缓存损坏 → 重扫
  - 磁盘写入失败 → 返回内存结果（不抛错）

---

### BE-03 唤起 agent CLI / 带队启动（P0）

**目标**：以指定成员身份在 Panel 内通过 node-pty spawn 启动 agent CLI。

- 输入：`memberName`, `cliName`, `extraArgs`
- 用 node-pty spawn 进程，注入成员身份环境变量，在独立 BrowserWindow 中渲染（xterm.js）
- 每个 CLI 有启动参数模板（见 BE-06）
- **边界情况**：
  - CLI 路径消失 → `cli_not_found`
  - spawn 失败 → `spawn_failed`

---

### BE-06 CLI 启动命令模板管理（P1）

**目标**：为每个 agent CLI 维护可配置的启动参数模板。

- 每个 CLI 预设启动参数模板，支持用户覆盖
- 存入 `~/.claude/team-hub/cli_templates.json`

---

### BE-07 PTY 代理层（P0）

**目标**：用 PTY 包裹 agent CLI 进程，实现 stdout 捕获和 stdin 注入。

- 用 `node-pty` 包裹 agent CLI 进程
- 管理 `PtySession`：`id / agentId / memberId / status / cols / rows`
- **API**：
  - `spawnPtySession`
  - `writeToPty`
  - `killPtySession`
  - `getPtySessions`
- stdout 捕获 → ring buffer（10KB）→ SSE 推送到前端
- stdin 注入 → 接收其他 agent 消息写入 `pty.write`
- **技术风险**：
  - Bun 对 node-pty 兼容性需 spike（见 SP-01）
  - 建议 PTY 层放 Electron 主进程（见 SP-02）

---

### BE-08 Agent 消息队列（P0）

**目标**：为每个 agent 维护独立的消息收件箱，支持异步投递。

- 每个 agent 独立消息队列（inbox）
- **消息结构**：

  ```ts
  {
    id: string
    from: string
    to: string
    content: string
    priority: "normal" | "urgent"
    timestamp: number
    status: "pending" | "delivered" | "expired"
  }
  ```

- 入队：`send_msg` 调用时存入目标 agent 的队列
- 出队：目标 agent IDLE 时 flush 队首消息
- BUSY 时不投递，排队等待
- 超时：队列中超过 N 分钟未投递的消息标记 `expired`
- **消息合并策略**：相邻且来自同一发送方的排队消息，flush 时合并为一条注入。不改变消息顺序，只合并连续相邻的。
  - 示例：队列 `[A:"问题1", A:"补充", C:"请求", A:"又想到一个"]`
  - 第一轮 IDLE → 合并相邻的 A 两条，投递一次：
    ```
    [team-hub] 来自 A(开发):
    问题1
    补充
    ---END---
    ```
  - 第二轮 IDLE → 投递 C：
    ```
    [team-hub] 来自 C(架构):
    请求
    ---END---
    ```
  - 第三轮 IDLE → 投递 A（不与第一轮合并，因为不相邻）：
    ```
    [team-hub] 来自 A(开发):
    又想到一个
    ---END---
    ```
  - **规则**：按队列顺序扫描，遇到不同发送方就断开，每次 flush 只投递队首的一组相邻同人消息

---

### BE-09 Agent 空闲检测（P0）

**目标**：通过 PTY stdout 判断 agent 是否处于 IDLE 状态，以决定何时投递消息。

- PTY proxy 状态机：`IDLE ↔ BUSY`
- 通过 stdout 正则匹配 prompt 特征判断 agent 是否空闲
- **每个 CLI 的 idle pattern**：

  | CLI    | Idle Pattern   |
  |--------|----------------|
  | claude | `/[❯>]\s*$/`   |
  | aider  | `/[❯>]\s*$/`   |
  | 其他   | 需单独适配      |

- 检测到 IDLE → 自动 flush 队列中下一条消息
- 注入消息后立即切为 BUSY
- **技术风险**：不同 CLI 的 prompt 格式差异大，需逐个适配验证（见 SP-06）

---

### BE-10 消息路由与投递（P0）

**目标**：将消息从发送方路由到目标 agent 的 PTY stdin。

- 收到 `send_msg` → 查目标 agent 的 PTY session → 入队
- 目标 agent 不在线 → 消息存队列，agent 上线后自动投递
- **消息信封格式**（注入 stdin）：

  ```
  [team-hub] 来自 {fromName}({fromRole}):
  {content}
  ---END---
  ```

- 支持 MCP 工具调用发送（有 MCP 的 agent）
- 支持 stdout `@mention` 解析发送（无 MCP 的 agent）

---

### BE-11 消息优先级（P1）

**目标**：支持 urgent 消息插队，确保紧急消息优先投递。

- 支持 `priority` 字段：`normal` / `urgent`
- urgent 消息插队到队首
- 可选：urgent 消息在 agent BUSY 时也投递（打断）

---

### BE-12 MCP 新增工具（P0）

**目标**：通过 MCP 暴露 agent CLI 管理和消息通信能力。

| 工具名              | 说明                         |
|---------------------|------------------------------|
| `scan_agent_clis`   | 返回已安装 CLI 列表           |
| `spawn_pty_session` | 启动 agent CLI               |
| `send_msg`          | 发消息给其他 agent（to, content, priority?） |
| `check_inbox`       | 手动检查收件箱               |
| `list_pty_sessions` | 列出运行中的 PTY session     |
| `kill_pty_session`  | 终止 PTY session             |

---

## 前端 Case

### FE-01 Agent CLI 扫描结果展示/设置页（P1）

**目标**：在设置页展示已检测到的 agent CLI 列表。

- 展示 CLI 列表：名称 / 图标 / 版本 / 路径 / 状态
- 进入时自动扫描（走缓存），支持手动刷新
- **边界情况**：
  - 全空 → 空态文案引导安装（配合 FE-07）
  - 加载中 → skeleton 占位

---

### FE-02 成员详情页"带队"按钮（P0）

**目标**：在成员详情页提供快捷带队入口。

- `MemberDetail.tsx` 新增"带队"按钮
- 无可用 CLI 时 disabled + tooltip 提示原因

---

### FE-03 带队 — CLI 选择弹窗（P0）

**目标**：让用户选择用哪个 agent CLI 启动该成员。

- 点击带队 → Modal 列出已检测 CLI
- 只有 1 个 CLI → 默认选中，跳过选择步骤
- 启动中 loading 状态，防重复点击

---

### FE-05 带队启动结果反馈（P0）

**目标**：给用户明确的启动成功/失败反馈。

- 成功 → toast 提示 + Modal 自动关闭
- 失败 → 红色错误信息 + 重试按钮 + "复制命令"按钮

---

### ~~FE-06 终端偏好设置页~~（废弃）

> 废弃原因：方案改为 Panel 内 xterm.js 渲染，不再依赖外部终端，无需终端偏好管理。

---

### FE-07 空态引导（P1）

**目标**：在没有检测到 agent CLI 时引导用户安装。

- 无 CLI 时展示推荐安装列表 + 各工具官网链接

---

### FE-08 消息队列可视化（P1）

**目标**：让用户了解每个 agent 的消息排队状态。

- 前端展示每个 agent 当前排队消息数
- 可查看队列中的消息列表（含状态、发送方、内容摘要）
- 支持手动清空 / 删除排队消息

---

### FE-09 内嵌终端视图（P0）

**目标**：在前端直接渲染 agent CLI 的 PTY 输出流。

- 使用 `xterm.js` 渲染 PTY 输出流
- 接收 `pty-output` IPC 事件
- 支持用户在内嵌终端中直接输入
- **技术风险**：xterm.js Electron 渲染性能（见 SP-07）

---

## 架构风险 Spike

| 编号  | 风险描述                              | 优先级 | 验证方式                              |
|-------|---------------------------------------|--------|---------------------------------------|
| SP-01 | Bun 运行时对 node-pty 的支持          | 高     | 10 行 test script，`bun run` 跑通     |
| SP-02 | Electron 中 node-pty rebuild          | 高     | `electron-rebuild` 跑通               |
| SP-03 | Electron 沙箱 PATH 找不到 CLI         | 中     | `execSync('which claude')` 验证       |
| SP-05 | claude CLI stdin 注入格式             | 中     | `echo hello \| claude` 测试           |
| SP-06 | 各 CLI idle prompt 检测准确率         | 中     | 各 CLI 手动交互录制 prompt，验证正则   |
| SP-07 | xterm.js Electron 渲染性能            | 低     | 1000 行输出压测                       |

---

## 建议落地顺序

| 阶段 | 内容 | 预估时间 |
|------|------|----------|
| 1 | **Spike 先行**：SP-01 / SP-02，验证 node-pty 可行性 | 1–2 天 |
| 2 | **并行推进**：CLI 扫描（BE-01 + FE-01）\| 成员带队交互（FE-02 / FE-03 / FE-05） | — |
| 3 | **通信基础**：PTY 代理层 + 消息队列 + 空闲检测（BE-07 / BE-08 / BE-09） | — |
| 4 | **路由 + MCP**：消息路由 + MCP 新工具（BE-10 / BE-12） | — |
| 5 | **体验完善**：CLI 模板（BE-06） | — |
| 6 | **高级视图**：内嵌终端 + 队列可视化（FE-08 / FE-09） | — |
| 7 | **增强**：消息优先级 + 合并投递（BE-11） | — |

---

## Case 汇总

| 编号  | 标题                         | 模块 | 优先级 |
|-------|------------------------------|------|--------|
| BE-01 | 扫描本地 agent CLI           | 后端 | P0     |
| BE-02 | 扫描结果持久化与缓存         | 后端 | P1     |
| BE-03 | 唤起 agent CLI / 带队启动    | 后端 | P0     |
| BE-06 | CLI 启动命令模板管理         | 后端 | P1     |
| BE-07 | PTY 代理层                   | 后端 | P0     |
| BE-08 | Agent 消息队列               | 后端 | P0     |
| BE-09 | Agent 空闲检测               | 后端 | P0     |
| BE-10 | 消息路由与投递               | 后端 | P0     |
| BE-11 | 消息优先级                   | 后端 | P1     |
| BE-12 | MCP 新增工具                 | 后端 | P0     |
| FE-01 | Agent CLI 扫描结果展示/设置页 | 前端 | P1     |
| FE-02 | 成员详情页"带队"按钮         | 前端 | P0     |
| FE-03 | 带队 — CLI 选择弹窗          | 前端 | P0     |
| FE-05 | 带队启动结果反馈             | 前端 | P0     |
| ~~FE-06~~ | ~~终端偏好设置页~~       | 前端 | 废弃   |
| FE-07 | 空态引导                     | 前端 | P1     |
| FE-08 | 消息队列可视化               | 前端 | P1     |
| FE-09 | 内嵌终端视图                 | 前端 | P0     |
