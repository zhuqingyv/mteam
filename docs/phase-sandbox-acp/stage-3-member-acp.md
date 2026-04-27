# Stage 3 — 成员 Agent 迁移 ACP + 废弃 PTY

> 本阶段把团队里除 Primary Agent 之外的所有**成员 Agent**，从 PTY（伪终端 + 命令行注入）运行模型彻底切换到 ACP（Agent Client Protocol，JSON-RPC 结构化协议）。完成后 `packages/backend/src/pty/`、`bus/subscribers/pty.subscriber.ts`、`bus/types.ts` 里的 `pty.*` 事件族全部退役，成员 Agent 与 Primary Agent 共用同一套 `AgentDriver` 运行时。

- 依赖：Stage 1 `process-runtime` 抽象、Stage 2 `AgentDriver` 解耦已落地
- 下游：Stage 4 DockerRuntime + 内置 MCP HTTP 化
- 主要改动模块：`packages/backend/src/pty/`、`packages/backend/src/bus/subscribers/pty.subscriber.ts`、`packages/backend/src/bus/subscribers/domain-sync.subscriber.ts`、`packages/backend/src/mcp/tools/send_msg.ts`（间接）、`packages/backend/src/api/panel/role-instances.ts`（注释与事件链）

---

## 1. 目标

| # | 目标 | 衡量 |
|---|-----|-----|
| G1 | 成员 Agent activate 走 ACP 握手（`initialize` → `session/new`），不再 `node-pty.spawn` | `grep -r 'ptyManager\.spawn' packages/backend/src` 无结果 |
| G2 | 成员收消息走 `driver.prompt(text)`，不再靠 `check_inbox` 轮询 HTTP /inbox | 成员 agent 侧 `check_inbox` 工具降级为可选兜底或移除 |
| G3 | MCP 注入统一走 `session/new.mcpServers` 字段，不再写 tmp `--mcp-config` 文件 | `grep -r 'writeFileSync.*mteam-.*json' packages/backend/src` 无结果 |
| G4 | system prompt 注入走 adapter 的 `sessionParams(_meta)` / CLI flag，不再 `--append-system-prompt` | `packages/backend/src/pty/prompt.ts` 合并进 adapter 组装 |
| G5 | 前端能收到结构化 `driver.*` 事件（thinking / text / tool_call / tool_result / turn_done），放弃 xterm.js 原始终端展示 | ws.subscriber 广播 `driver.*` 事件，ChatSider 对成员消息按 driverId 订阅 |

统一运行模型后，Primary Agent 与成员 Agent 的启动/通信/事件路径完全一致，这是 Stage 4 把任何一类 agent 丢进 DockerRuntime 的前置条件。

---

## 2. PTY vs ACP 对比

| 维度 | PTY（当前成员路径） | ACP（目标，Primary 已在此路径） |
|------|--------------------|------------------------------|
| 进程启动 | `node-pty.spawn(cliBin, [...])` （`pty/manager.ts:104-110`） | `child_process.spawn(adapter.prepareSpawn().command, args, { stdio: ['pipe','pipe','inherit'] })` （`agent-driver/driver.ts:81-85`） |
| 通信通道 | 伪终端字节流（stdin 写、stdout 读） | stdin/stdout JSON-RPC over ndjson（ACP SDK `ndJsonStream`） |
| 协议 | 无 — 直接塞字符流 + 正则嗅探 `bypass permissions\|shift\+tab` 判 ready（`pty/manager.ts:9`） | JSON-RPC 2.0：`initialize`、`session/new`、`session/prompt`、`session/update` 通知 |
| MCP 注入 | spawn 前写 tmp JSON，`--mcp-config <path>`（`pty/manager.ts:86-91`） | `conn.newSession({ mcpServers: [...] })` 的标准字段（`agent-driver/driver.ts:118-122`、`158-183`） |
| system prompt | `--append-system-prompt <text>`（`pty/manager.ts:92`），prompt 由 `pty/prompt.ts:assemblePrompt()` 拼 | Claude：`_meta.systemPrompt = { append: <text> }`（`adapters/claude.ts:21-26`）；Codex：`-c model_instructions_file=<path>`；Qwen：`--system-prompt` CLI flag |
| 消息注入（leader → member） | `comm.send` → `CommRouter.dispatch` 存到 member 的 socket / offline 队列，**成员 agent 需要调用 `check_inbox` 工具轮询拉取**（`mcp/tools/check_inbox.ts:22-33`） | `driver.prompt(text)` → `conn.prompt({ sessionId, prompt: [{type:'text', text}] })`，**子进程被动接收**，无需轮询 |
| 输出解析 | `handle.onData(chunk)` → `RingBuffer` 存字符流（`pty/manager.ts:40-57, 123-126`），前端用 xterm.js 渲染 | `client.sessionUpdate` 回调 → `adapter.parseUpdate()` → `DriverEvent`（`driver.thinking/text/tool_call/tool_result/turn_done`）→ bus-bridge emit（`driver.ts:101-109`） |
| 就绪判定 | 正则 `READY_RE.test(chunk)`（字符串包含 "bypass permissions" 或 "shift+tab"）（`pty/manager.ts:9, 125`） | `conn.initialize()` 返回即握手完成，`driver.status = 'READY'`（`driver.ts:42-43`） |
| 终止 | `handle.kill('SIGTERM')` + 2s 兜底 SIGKILL + `unlinkSync(mcpConfigPath)`（`pty/manager.ts:155-164`） | `AgentDriver.teardown()`：`child.kill('SIGTERM')` + 2s SIGKILL + `adapter.cleanup()`（`driver.ts:126-139`） |
| 退出回写 | `pty.spawned` → `domain-sync` 回写 `session_pid`（`bus/subscribers/domain-sync.subscriber.ts`） | `driver.started/stopped/error`，`primary-agent.ts:117-133` 订阅处理 |
| 前端 UI | xterm.js 原始终端窗口（`packages/frontend/**` 依赖 ring buffer 字符流） | 结构化工作流 UI：按 `driver.*` 事件分轨渲染（thinking 折叠、tool_call 展开参数、tool_result 展开输出） |

关键观察：当前成员"消息注入"并不是 `writeToPty(text)`——PTY 里塞字符会被 Claude CLI 解析成键盘输入、ANSI 序列冲突极脆弱。实际路径是 comm socket + `check_inbox` 主动轮询（`mcp/tools/check_inbox.ts`）。ACP 迁移真正收敛的是**把"塞消息"从"让 agent 轮询"改成"直接推给 agent"**，效率 + 语义双赢。

---

## 3. 迁移步骤（按序执行）

### 3.1 成员 activate 流程改造

**当前**（`bus/subscribers/pty.subscriber.ts:15-47`）：

```text
instance.created
  → pty.subscriber 取 template
  → ptyManager.spawn({ instanceId, memberName, isLeader, persona, task, availableMcps })
      ├─ assemblePrompt(...)                          # pty/prompt.ts
      ├─ mcpManager.resolve(availableMcps, ctx)       # 展开 MCP
      ├─ writeFileSync(tmp/mteam-<id>.json, ...)      # 写 tmp MCP 配置
      ├─ ptySpawn('claude', ['--mcp-config', path,
      │            '--append-system-prompt', prompt,
      │            '--dangerously-skip-permissions'])
      └─ handle.onData(READY_RE) → entry.ready = true
  → emit pty.spawned { instanceId, pid }
  → domain-sync 回写 role_instances.session_pid
```

**改造后**（新 subscriber：`bus/subscribers/member-driver.subscriber.ts`）：

```text
instance.created
  → member-driver.subscriber 取 template + 装 DriverConfig
      (复用 primary-agent/driver-config.ts:buildDriverConfig 的思路，
       多一个 buildMemberDriverConfig 分支：isLeader=false, systemPrompt=assemblePrompt(...))
  → new AgentDriver(instanceId, config)
  → driver.start()
      ├─ adapter.prepareSpawn(config)                 # cliType 决定 command/args
      ├─ child_process.spawn + ndJsonStream
      ├─ conn.initialize()                            # JSON-RPC 握手
      └─ conn.newSession({ cwd, mcpServers, ..._meta })
  → driver 进入 READY → emit driver.started { driverId=instanceId }
  → domain-sync 订阅 driver.started → 回写 role_instances.session_pid (= child.pid)
```

要点：
- **driverId 复用 instanceId**，`primary-agent.ts:75` 已是这个约定，成员也跟上
- **systemPrompt 仍由 `pty/prompt.ts:assemblePrompt()` 拼装**（逻辑保留），但交付渠道从 CLI arg 变成 adapter 的 `sessionParams()._meta`
- **`mcpManager.resolve()` 的 `configJson.mcpServers`** 经 `buildDriverConfig` 转 `McpServerSpec[]`（transport='stdio'），Stage 4 再把内置 MCP 改 http transport
- **旧 prompt 组装函数 `assemblePrompt` 原地保留**，它是"成员身份 / 任务 / leader 归属"的业务描述，adapter 只负责"怎么送给 CLI"

### 3.2 leader → member 消息投递改造

**当前**路径（`mcp/tools/send_msg.ts:52` + `mcp/tools/check_inbox.ts:22-33` + `comm/router.ts:61-72`）：

```text
leader 进程调 mteam.send_msg → comm.send(payload)
  → CommRouter.dispatch
      ├─ 若 member socket 在线：conn.write(serialize(msg))  # 推给 member 的 CommClient
      └─ 若离线：offline.store(msg) 存 SQLite
  → member 进程自己调 mteam.check_inbox (HTTP /inbox 轮询)
  → member agent 拿到消息文本 → 自行决定下一步
```

**改造后**：

```text
leader 进程调 mteam.send_msg → comm.send(payload)
  → CommRouter.dispatch
      ├─ 目标 scope=local, id=<memberInstanceId>
      ├─ 查 driverRegistry.get(memberInstanceId)
      │     ├─ 找到：driver.prompt(formatMsg(payload))   # ACP 推模式
      │     └─ 没找到（member 未上线）：offline.store(msg) 存 SQLite
      └─ member driver.status 变 WORKING → 产生 driver.text/tool_call 事件流
  → member 上线时（driver.start() 成功），
    member-driver.subscriber 触发 offline.replayFor(memberInstanceId)，
    遍历调 driver.prompt(...) 回灌离线消息
```

要点：
- 新增单例 **`driverRegistry`**（在 `agent-driver/registry.ts`）：`Map<driverId, AgentDriver>`，`AgentDriver.start()` 时注册、`stop()` 时注销
- `CommRouter` 引入可选 `driverDispatcher`（依赖注入，测试好 mock），保持 router 本身不直接 import agent-driver
- `check_inbox` 工具保留一期作为**兜底工具**（agent 有时会要求"把所有未处理的再发一次"），但默认不用；二期观察数据后移除
- `formatMsg(payload)` 规则：`payload.kind === 'system'` → 以 `"[系统消息] ${action}: ${summary}"` 注入；普通消息 → `"[来自 ${from}] ${summary}\n\n${content}"`

### 3.3 MCP 注入标准化

**当前**（`pty/manager.ts:76-91`）：

```ts
const resolved = mcpManager.resolve(opts.availableMcps ?? [], { instanceId, hubUrl, commSock, isLeader });
const mcpConfigPath = join(tmpdir(), `mteam-${opts.instanceId}.json`);
writeFileSync(mcpConfigPath, JSON.stringify(resolved.configJson), 'utf-8');
// ... --mcp-config mcpConfigPath
// teardown: unlinkSync(entry.mcpConfigPath)
```

**改造后**（直接复用 `primary-agent/driver-config.ts:38-58` 的装配逻辑）：

```ts
const resolved = mcpManager.resolve(template.availableMcps, { instanceId, hubUrl, commSock, isLeader: false });
const mcpServers: McpServerSpec[] = Object.entries(resolved.configJson.mcpServers).map(
  ([name, spec]) => ({ name, transport: 'stdio', command: spec.command, args: spec.args, env: spec.env }),
);
// → 进 DriverConfig.mcpServers
// → AgentDriver.toAcpMcpServers() 转 ACP SDK 的 McpServer[]
// → conn.newSession({ mcpServers }) 作为标准字段送进子进程
```

收益：
- 不再有 tmp 文件生命周期管理（删除时机 / 进程崩溃残留）
- MCP 注入路径 Primary / 成员完全一致，一个 bug 一次修
- Stage 4 内置 MCP 改 HTTP 时，只要把 `transport='stdio'` 的改成 `transport='http', url='http://localhost:<hubPort>/mcp/...'`，driver 层零改动（`driver.ts:160-175` 已原生支持）

---

## 4. 废弃 & 改动文件清单

### 4.1 可整包删除

| 路径 | 说明 |
|------|-----|
| `packages/backend/src/pty/manager.ts` | PTY 管理器主体，180 行 |
| `packages/backend/src/pty/prompt.ts` | prompt 组装。**不删**，迁移到 `packages/backend/src/member-agent/prompt.ts`（复用逻辑） |
| `packages/backend/src/bus/subscribers/pty.subscriber.ts` | PTY subscriber，被 `member-driver.subscriber.ts` 取代 |
| `packages/backend/src/__tests__/pty-manager.test.ts` | 如存在，删 |

### 4.2 新增

| 路径 | 说明 |
|------|-----|
| `packages/backend/src/member-agent/driver-config.ts` | 仿 `primary-agent/driver-config.ts`：把 `RoleInstance + Template` 装配成 `DriverConfig`，`isLeader=false, systemPrompt=assemblePrompt(...)` |
| `packages/backend/src/member-agent/prompt.ts` | 原 `pty/prompt.ts` 迁移 |
| `packages/backend/src/bus/subscribers/member-driver.subscriber.ts` | 监听 `instance.created` → 建 driver + start；`instance.deleted` → driver.stop |
| `packages/backend/src/agent-driver/registry.ts` | 全局 `Map<driverId, AgentDriver>`，供 CommRouter 按目标 instanceId 查 driver |
| `packages/backend/src/__tests__/member-driver-subscriber.test.ts` | `instance.created` → AgentDriver spawn mock / `driver.started` 事件断言 |

### 4.3 需修改

| 路径 | 改动 |
|------|-----|
| `packages/backend/src/bus/index.ts:27` | 注释"team 必须在 pty 之前注册"改成"team 必须在 member-driver 之前注册"；把 `subscribePty` 换成 `subscribeMemberDriver` |
| `packages/backend/src/bus/subscribers/domain-sync.subscriber.ts:12` | 订阅 `pty.spawned` → 改订阅 `driver.started`，payload 里从 `e.pid` 改 `e.pid`（保持字段名但来源从 `IPty.pid` 变 `ChildProcess.pid`） |
| `packages/backend/src/bus/types.ts:10-11, 85-97` | 删 `pty.spawned` / `pty.exited` 事件定义，前端 / ws.subscriber 不再广播 |
| `packages/backend/src/bus/subscribers/ws.subscriber.ts:17` | 广播列表去掉 `'pty.spawned'`，加 `'driver.started'`, `'driver.text'`, `'driver.tool_call'`, `'driver.tool_result'`, `'driver.turn_done'`, `'driver.error'`, `'driver.stopped'` |
| `packages/backend/src/comm/router.ts` | 加可选 `driverDispatcher(memberId, formattedText)` 注入点；`dispatch()` 在线分支先试 driver、再回退 socket 写入 |
| `packages/backend/src/comm/server.ts` | `CommServer` 构造把 `driverDispatcher` 透传给 `CommRouter` |
| `packages/backend/src/mcp/tools/check_inbox.ts` | 保留，但 `description` 明确"fallback 工具"；默认 activate prompt 不再指导使用 |
| `packages/backend/src/api/panel/role-instances.ts:3-4` | 注释链路 `instance.created → pty.spawn + ...` 改成 `instance.created → member-driver.start + ...` |
| `packages/backend/src/__tests__/domain-sync-subscriber.test.ts` | `pty.spawned` 事件断言 → `driver.started` |

### 4.4 依赖变化

- `package.json` 删 `node-pty` 依赖（Stage 5 一并收尾，确认没有其他地方 import）
- `@agentclientprotocol/sdk` 已在 Primary Agent 引入，成员直接复用

---

## 5. mteam MCP `send_msg` 工具改造

`send_msg` 工具本身的**参数契约不变**（`to / summary / content`），改动只在下游 CommRouter。但由于这是迁移最直观的语义变化，单列一节画对比图。

### 5.1 改造前（PTY + 轮询）

```
┌─────────────────┐                                         ┌──────────────────┐
│ leader agent    │                                         │ member agent     │
│ (claude CLI)    │                                         │ (claude CLI)     │
│                 │                                         │                  │
│ tool_call       │                                         │ tool_call        │
│  send_msg ──────┼──→ mteam MCP stdio                      │  check_inbox ────┼──→ HTTP GET
│                 │     ├─ comm.send ──→ comm.sock          │    (轮询)        │     /inbox
│                 │     │   └─ CommRouter.dispatch          │                  │     ↑
│                 │     │       ├─ socket.write(msg) ──→ member CommClient ──→ 缓冲落库
│                 │     │       └─ 或 offline.store         │                  │     │
│                 │     └─ return {delivered:true}          │  拉取到才处理    │←────┘
└─────────────────┘                                         └──────────────────┘

痛点：
 (a) 成员必须主动轮询才能看到消息 → 高延迟或浪费 token
 (b) comm socket 只是"消息队列"，不是"让 agent 立刻响应"的触发器
 (c) 消息进入 member 是字符串 payload，成员自己解析 summary/content
```

### 5.2 改造后（ACP 推模式）

```
┌─────────────────┐                                         ┌──────────────────┐
│ leader agent    │                                         │ member agent     │
│ (claude ACP)    │                                         │ (claude ACP)     │
│                 │                                         │                  │
│ tool_call       │                                         │  ↑ session/prompt│
│  send_msg ──────┼──→ mteam MCP http (Stage4)              │  JSON-RPC notify │
│                 │     ├─ comm.send ──→ hub (IPC)          │                  │
│                 │     │   └─ CommRouter.dispatch          │                  │
│                 │     │       ├─ driverRegistry.get(memberId)                │
│                 │     │       │     └─ driver.prompt(text) ─→ ACP conn.prompt│
│                 │     │       │                                   ↓          │
│                 │     │       │                         session/update 流:   │
│                 │     │       │                           thinking / text /  │
│                 │     │       │                           tool_call / result │
│                 │     │       └─ 或 offline.store（离线）                     │
│                 │     └─ return {delivered:true}          │                  │
└─────────────────┘                                         └──────────────────┘

收益：
 (a) 消息到达即唤醒 → 零轮询、零额外 token
 (b) 成员侧看到的是"有人把新 user turn 塞进来了"，和用户在终端敲字完全同构
 (c) 消息格式由 formatMsg() 在 hub 侧统一成 "[来自 X] summary\n\ncontent"，成员 agent 读 text
```

---

## 6. 回滚策略

### 6.1 分支级回滚

- 本阶段改动全部集中在 feature branch `stage-3/member-acp`
- PR 合并前所有 CI 必过：单测 + Primary/成员双路径 E2E（见 §7）
- 回滚动作：`git revert <merge-commit>` 即恢复 PTY 路径

### 6.2 运行时降级（灰度期）

在 `bus/index.ts` 用环境变量开关并存两路：

```ts
if (process.env.TEAM_HUB_MEMBER_RUNTIME === 'pty') {
  sub.add(subscribePty(bus));
} else {
  sub.add(subscribeMemberDriver(bus));  // 默认
}
```

- 默认走 ACP；出现问题时用户/运维设 `TEAM_HUB_MEMBER_RUNTIME=pty` 重启 hub 即可退回
- 灰度窗口 ≤ 1 个 release；下个 release 拆除开关 + 删 `pty/` 目录
- 前端相应用 `driver.*` vs `pty.*` 事件双订阅（有哪个显示哪个），灰度期对用户透明

### 6.3 部分成员回退不支持

不支持"同一 hub 里 A 成员走 ACP、B 成员走 PTY"。环境变量是 hub 全局开关。理由：`CommRouter.driverDispatcher` 和 `subscribePty` 在消息路由上互斥，同时在线会双写。

### 6.4 数据兼容

- `role_instances.session_pid` 字段语义不变（仍是子进程 pid）
- 离线消息表 `offline_messages` schema 不变；ACP 路径启动时 replay 同一套 payload
- `role_instances` / `teams` 表结构零改动

---

## 7. 测试策略

### 7.1 单元测试

| 用例 | 文件 | 断言 |
|------|------|-----|
| `instance.created` → AgentDriver 启动 | `__tests__/member-driver-subscriber.test.ts` | mock `AgentDriver.start` 被调用一次，配置的 `agentType / systemPrompt / mcpServers / cwd` 与模板对齐 |
| `instance.deleted` → driver.stop | 同上 | mock `AgentDriver.stop` 被调用，registry 中对应项清空 |
| `CommRouter.dispatch` 在线分支走 driver | `__tests__/comm-router-driver.test.ts` | 注入 fake `driverDispatcher`，dispatch 后被调一次，socket.write 未被调 |
| `CommRouter.dispatch` 离线分支走 offline store | 同上 | driverDispatcher 抛"not found" → offline.store 收到消息 |
| member driver.start 成功后自动 replay offline | 同上 | fake offline store 里塞 2 条，driver.start 触发后 driver.prompt 被调 2 次 |
| domain-sync 订阅 `driver.started` 回写 session_pid | 更新 `__tests__/domain-sync-subscriber.test.ts` | bus emit `driver.started { pid: 12345 }` → DB.session_pid = 12345 |

禁止 mock database：单测直接开内存 SQLite（项目既定，参考 `__tests__/domain-sync-subscriber.test.ts` 已有基础设施）。

### 7.2 集成/E2E

| 场景 | 步骤 | 断言 |
|------|------|-----|
| 成员 activate 握手 | 创建 leader 模板 + member 模板 → POST /api/role-instances activate member | WS 通道收到 `driver.started { driverId=<memberInstanceId> }`，30s 内 |
| 消息推送 | leader agent 调 `send_msg(to=memberName, summary, content)` | member 侧 WS 通道在 5s 内收到 `driver.turn_done`；其间伴随 `driver.text` 事件 |
| 旧 PTY 路径不再被触发 | 全流程抓 stderr | 不出现 `[pty] spawned` / `[pty] mcp '...'` 日志行 |
| MCP 工具调用可观察 | 成员 agent 调用 `check_inbox`（作为 fallback） | 前端收到 `driver.tool_call { name: 'check_inbox' }` + `driver.tool_result` |
| 离线 replay | member 下线（driver.stop）→ leader 发 3 条 → member 再 activate | member 上线 10s 内 `driver.text` 累计出现 3 次"[来自 leader]" |

### 7.3 回滚开关测试

| 场景 | 步骤 | 断言 |
|------|------|-----|
| `TEAM_HUB_MEMBER_RUNTIME=pty` 冒烟 | 设环境变量，跑 2.1 同样的流程 | stderr 出现 `[pty] spawned`；无 `driver.started` 事件；前端仍能通过 xterm.js 看到字符流 |

### 7.4 前端验证

Stage 3 不负责 UI 重构（留给独立 ChatSider 重构 ticket），但需要保证：
- `driver.text / thinking / tool_call / tool_result / turn_done` 事件能在 DevTools → Network → WS 实时观察
- 前端至少有个临时 debug 面板能 dump 事件流（已存在 `WorkflowDebugger` 类组件即可）

---

## 8. 架构图（改造前后对比）

### 8.1 改造前：成员 Agent（PTY）

```
                ┌────────────────────────── hub (node) ───────────────────────────┐
                │                                                                  │
   HTTP POST    │    ┌─────────────────────┐        ┌───────────────────────┐     │
   /role-       │    │ api/panel/role-     │  emit  │ EventBus              │     │
   instances ───┼──→ │ instances.ts        │ ─────→ │ instance.created      │     │
                │    └─────────────────────┘        └──┬────────────────────┘     │
                │                                      │                           │
                │                          ┌───────────┴─────────────┐             │
                │                          ↓                         ↓             │
                │                ┌─────────────────┐    ┌─────────────────┐        │
                │                │ pty.subscriber  │    │ roster.sub /    │        │
                │                │ spawn member    │    │ team.sub / …    │        │
                │                │ (PTY + tmp mcp) │    └─────────────────┘        │
                │                └────────┬────────┘                               │
                │                         │ node-pty.spawn('claude', ['--mcp-     │
                │                         │   config', tmp, '--append-system-     │
                │                         │   prompt', prompt, ...])              │
                │                         ↓                                        │
                │                 ┌───────────────────────────┐                    │
                │                 │ member CLI (claude PTY)   │                    │
                │                 │ ├─ stdin: 字符流（键盘）  │                    │
                │                 │ ├─ stdout: ANSI 字符流    │                    │
                │                 │ └─ mteam MCP stdio 子进程 │                    │
                │                 └─┬───────────────┬─────────┘                    │
                │                   │ ring buffer   │                              │
                │                   │ (64KB)        │ mteam MCP:                   │
                │                   │               │  send_msg / check_inbox /…   │
                │                   ↓               │                              │
                │           ┌────────────────┐      │                              │
                │           │ ws.subscriber  │      │                              │
                │           │ 广播 raw chunk │      │                              │
                │           └───────┬────────┘      │                              │
                │                   │               ↓                              │
                │                   │       ┌────────────────┐                     │
                │                   │       │ comm socket    │ ← leader send_msg   │
                │                   │       │ offline store  │   入队              │
                │                   │       └────────┬───────┘                     │
                │                   │                │                             │
                │                   │                └─→ 等 member 主动轮询        │
                │                   │                    HTTP /inbox 才能看到      │
                └───────────────────┼──────────────────────────────────────────────┘
                                    │ WS ndjson
                                    ↓
                            ┌──────────────────┐
                            │ frontend         │
                            │ xterm.js 渲染    │
                            │ 原始 ANSI        │
                            └──────────────────┘
```

### 8.2 改造后：成员 Agent（ACP）

```
                ┌──────────────────────────── hub (node) ─────────────────────────────┐
                │                                                                      │
   HTTP POST    │   ┌──────────────────────┐        ┌─────────────────────────┐       │
   /role-       │   │ api/panel/role-      │  emit  │ EventBus                │       │
   instances ───┼─→ │ instances.ts         │ ─────→ │ instance.created        │       │
                │   └──────────────────────┘        └────┬────────────────────┘       │
                │                                        │                             │
                │                          ┌─────────────┴─────────────┐               │
                │                          ↓                           ↓               │
                │           ┌─────────────────────────────┐   ┌────────────────┐       │
                │           │ member-driver.subscriber    │   │ roster.sub /   │       │
                │           │ buildMemberDriverConfig()   │   │ team.sub / …   │       │
                │           │ new AgentDriver + start()   │   └────────────────┘       │
                │           └────────┬────────────────────┘                            │
                │                    │ child_process.spawn('npx', ['-y',               │
                │                    │   '@agentclientprotocol/claude-agent-acp'])     │
                │                    │ + ndJsonStream(stdin, stdout)                   │
                │                    │ + conn.initialize()                              │
                │                    │ + conn.newSession({ cwd, mcpServers,             │
                │                    │                     _meta.systemPrompt })        │
                │                    ↓                                                  │
                │         ┌──────────────────────────────┐                              │
                │         │ AgentDriver (成员 instance)  │                              │
                │         │ ├─ child: ACP agent 子进程   │                              │
                │         │ ├─ conn: ClientSideConnection│                              │
                │         │ └─ adapter.parseUpdate       │                              │
                │         └────────┬─────────────────────┘                              │
                │                  │  session/update ← child                            │
                │                  │  emitToBus(driverId, DriverEvent)                  │
                │                  ↓                                                    │
                │          ┌─────────────────────────────────┐                          │
                │          │ EventBus                        │                          │
                │          │ driver.thinking / text /        │                          │
                │          │ tool_call / tool_result /       │                          │
                │          │ turn_done / error / stopped     │                          │
                │          └─┬────────────────┬────────────┬─┘                          │
                │            │                │            │                            │
                │            ↓                ↓            ↓                            │
                │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐              │
                │  │ ws.subscriber│  │ domain-sync  │  │ comm-notify.sub │              │
                │  │ 广播结构事件 │  │ 回写 pid     │  │ 系统消息投递    │              │
                │  └──────┬───────┘  └──────────────┘  └─────────────────┘              │
                │         │                                                              │
                │         │        ┌──────────────────────────────────────────┐          │
                │         │        │ CommRouter ← leader send_msg             │          │
                │         │        │  ├─ driverRegistry.get(memberId)         │          │
                │         │        │  │   └─ driver.prompt(formatMsg(...))    │          │
                │         │        │  └─ offline.store（离线 → 上线 replay） │          │
                │         │        └─────────────┬────────────────────────────┘          │
                │         │                      │ conn.prompt({sessionId,               │
                │         │                      │   prompt:[{type:'text',text}]})       │
                │         │                      ↓                                        │
                │         │              （同一个 member AgentDriver，                    │
                │         │                再次触发 session/update 事件流）              │
                │         │                                                              │
                └─────────┼──────────────────────────────────────────────────────────────┘
                          │ WS ndjson（结构化事件）
                          ↓
                  ┌──────────────────────────┐
                  │ frontend                 │
                  │ 工作流 UI：               │
                  │  - thinking 折叠气泡      │
                  │  - tool_call 展开面板     │
                  │  - text 流式渲染          │
                  └──────────────────────────┘
```

---

## 9. 里程碑验收清单

- [ ] `packages/backend/src/pty/` 目录不再被引用（`grep -r 'from.*pty/' packages/backend/src` 仅剩 `member-agent/prompt.ts` 内部引用或已完全迁移）
- [ ] `bus/types.ts` 的 `pty.spawned / pty.exited` 事件族已删除，TS 编译绿
- [ ] `send_msg` leader 发 → member 收到 `driver.text` 事件的 E2E 用例通过
- [ ] `driver.started` → `role_instances.session_pid` 回写单测通过
- [ ] `TEAM_HUB_MEMBER_RUNTIME=pty` 开关走得通（回滚兜底）
- [ ] Stage 4 可以在"把 mteam MCP 改 HTTP transport"时，**零改动 driver 层**完成切换

---

*文档维护：本阶段完成后更新 MILESTONE.md 对应条目；后续若 adapter 扩充 qwen 支持，本文档 §3.1、§5 里 Claude-only 的 _meta 注入需补 qwen 分支说明。*
