# Stage 3 — 成员 Agent 迁移 ACP / REGRESSION

> 设计文档：`packages/backend/docs/phase-sandbox-acp/stage-3-member-acp.md`
> TASK-LIST：`packages/backend/docs/phase-sandbox-acp/stage-3/TASK-LIST.md`
> 测试员按本清单**逐条**验证；每条必须注明 **PASS / FAIL + 证据**（日志片段 / 事件快照 / grep 输出）。
> 全部 PASS 才能进入 Stage 4。任一 FAIL → 提修复员 task，重测循环。

---

## 0. 测试准备

### 0.1 环境

- 执行目录：`/Users/zhuqingyu/project/mcp-team-hub`
- Node：项目 `.nvmrc` 指定版本
- 清 DB：测试前 `rm -rf ~/.claude/team-hub/team-hub.sqlite*`（或改 `TEAM_HUB_DB=...` 用临时库）
- CLI：`claude` 在 PATH；若项目用 `TEAM_HUB_CLI_BIN` 自定义，保持一致
- 编译：`pnpm -r build` 全绿（TypeScript 严格模式）

### 0.2 基线 fixtures

跑单测 `pnpm --filter backend test` 之前必须绿；E2E 阶段需要如下数据：

1. 一个 leader RoleTemplate（e.g. `role=leader / persona="架构师"`）
2. 一个 member RoleTemplate（e.g. `role=coder / persona="资深开发"`）
3. 至少一个 MCP entry 已装（`mteam` 内置不算外部）

### 0.3 事件观察方式

- 后端 stderr：`tail -f ~/.claude/team-hub/logs/*.log`（或标准输出）
- WebSocket：`wscat -c ws://localhost:58590/ws/events` 抓 `driver.*` / `instance.*`
- DB：`sqlite3 ~/.claude/team-hub/team-hub.sqlite 'SELECT id, session_pid, status FROM role_instances;'`

---

## 1. 单元测试（Wave 1 + Wave 2 合并后）

必须全绿：

| # | 用例 | 位置 | 断言重点 |
|---|------|------|---------|
| U1 | `DriverRegistry` 基础 | `agent-driver/registry.test.ts` | register/get/unregister 双向，重复 register 后 get 拿最新 |
| U2 | `DriverRegistry` 并发安全 | 同上 | 并发 register 不同 id + 并发 unregister → final list 正确 |
| U3 | `assemblePrompt` 快照 | `member-agent/prompt.test.ts` | leader / 非 leader / 无 task / 无 persona 四种组合 |
| U4 | `formatMemberMessage` system 分支 | `member-agent/format-message.test.ts` | `kind='system', action='deactivate'` → 文本含 `[系统消息] deactivate:` |
| U5 | `formatMemberMessage` chat 分支 | 同上 | `from='local:abc'`, summary+content → `[来自 abc] ${summary}\n\n${content}` |
| U6 | `buildMemberDriverConfig` | `member-agent/driver-config.test.ts` | 装配 systemPrompt、mcpServers、env、cwd 全部正确；isLeader=false |
| U7 | `CommRouter.driverDispatcher='delivered'` | `comm/router.test.ts` | socket 未被调，route='local-online' |
| U8 | `CommRouter.driverDispatcher='not-ready'` | 同上 | 走 socket 分支，dispatcher 被调 1 次 |
| U9 | `CommRouter.driverDispatcher='not-found'` + socket 也无 | 同上 | 走 offline.store，route='local-offline' |
| U10 | `CommRouter.driverDispatcher` 抛异常 | 同上 | 异常被吞，走 socket 或 offline；不污染 registry |
| U11 | `member-driver.subscriber` instance.created → start | `bus/subscribers/member-driver.subscriber.test.ts` | `AgentDriver.start` 被调；config 与 W1-3 产出一致 |
| U12 | `member-driver.subscriber` start 成功后 registry.get 非空 | 同上 | `driverRegistry.get(instanceId) === driver` |
| U13 | `member-driver.subscriber` instance.deleted → stop + unregister | 同上 | 顺序正确，registry 中该 id 被清 |
| U14 | `member-driver.subscriber` `driver.error` → unregister | 同上 | 主动解注册 |
| U15 | `member-driver.subscriber` leader instance 不启动 driver | 同上 | `instance.isLeader=true` 时早退 |
| U16 | offline replay 逐条投递 + markDelivered | 同上 | fake offline 有 3 条 → `driver.prompt` 被调 3 次 + `markDelivered` 被调 3 次 |
| U17 | offline replay 中某条失败不中断 | 同上 | 第 2 条抛 → 第 3 条仍被调；stderr 记失败计数 |
| U18 | `createDriverDispatcher` 四分支 | `comm/driver-dispatcher.test.ts` | delivered / not-ready / not-found / exception |
| U19 | `bus/types.ts` 不再导出 `PtySpawnedEvent / PtyExitedEvent` | `bus/types.test.ts`（可选） 或 `tsc` 报错验证 | `import ... PtySpawnedEvent` 必须 TS 报错 |
| U20 | `domain-sync.subscriber.ts` 不再订阅 `pty.spawned` | `bus/subscribers/domain-sync-subscriber.test.ts` | 注入 fake bus emit `pty.spawned` → 无 DB 写；emit `driver.started` 不触发 domain-sync 写 pid（写 pid 由 W2-1 胶水负责，本订阅已不涉） |
| U21 | `bus/index.ts` 注册链包含 `subscribeMemberDriver`，不含 `subscribePty` | 搜代码 + 集成启动日志 | 运行时订阅者列表无 pty |
| U22 | `check_inbox` description 含 "Fallback" | `mcp/tools/check_inbox.test.ts` | 字符串断言 |

---

## 2. 集成 / E2E（Wave 2 全绿后）

### E1 · 成员 activate → ACP 握手成功

**步骤**：
1. 创建 leader instance（`POST /api/role-instances` 或 UI 创建）→ activate
2. 通过 leader 创建 member instance（`add_member` 工具 / UI）→ activate member
3. 观察 WebSocket 事件流

**通过条件**：
- 30s 内收到 `{type:'driver.started', driverId:<memberInstanceId>}`
- 无 `{type:'pty.spawned'}`
- `role_instances.session_pid` 字段被写入（非 NULL，对应 member）
- `role_instances.status='RUNNING'`

**失败信号**：
- stderr 出现 `[pty] spawned` → Wave 2 清扫未完成
- `driver.started` 超时 → driver-config / adapter 装配问题

---

### E2 · leader → member 消息推送

**步骤**：
1. E1 的 leader / member 保持在线
2. leader 调用 `send_msg(to=<memberName>, summary='你好', content='帮我看看 X')`
3. 在 WebSocket 实时观察 `driver.*`

**通过条件**：
- 5s 内收到至少一条 `{type:'driver.text', driverId:<memberId>, content:...}`
- 其后出现 `{type:'driver.turn_done', driverId:<memberId>}`
- member 进程**没有**调用 `check_inbox`（查 `driver.tool_call.name='check_inbox'` 无）
- leader 收到 `send_msg` 返回 `{delivered: true, to: 'local:<memberId>'}`

---

### E3 · PTY 路径彻底不触发（新默认）

**步骤**：
1. 默认环境（不设 `TEAM_HUB_MEMBER_RUNTIME`）启动 hub
2. 跑 E1 + E2 全流程
3. grep 全部日志

**通过条件**：
- 全程 stderr / 日志文件不含：`[pty] spawned` / `[pty] mcp '...' not found` / `[pty] instance ... exited`
- grep 代码：
  ```
  grep -rn "from .*'\.\./pty/" packages/backend/src       # empty
  grep -rn "import.*node-pty" packages/                    # empty
  grep -rn "pty.spawned\|pty.exited" packages/backend/src  # empty
  ```
- `sqlite3 ... 'SELECT session_pid FROM role_instances WHERE id=?'` 写入的 pid 能通过 `ps -p <pid>` 查到活子进程

---

### E4 · 离线消息 replay

**步骤**：
1. leader + member 都在线
2. 主动 `POST /api/role-instances/:id/offline-request`（或 UI "下线"）member → 等 `driver.stopped`
3. leader 调 `send_msg(to=member, summary='s1', content='c1')` × 3 次（不同内容）
4. 再 activate member

**通过条件**：
- member 下线期间：`offline.store` 产生 3 行 DB record（`SELECT * FROM messages WHERE read_at IS NULL`）
- member 重新 activate 后 **10s 内**：WebSocket 观察到 3 次 `driver.text`，内容含 `s1 / s2 / s3`
- 之后 `messages` 表里对应 3 行 `read_at` 非 NULL

---

### E5 · driver 事件在 ws 可观察（替代 xterm）

**步骤**：
1. 保持 E1 状态
2. leader 发一条长消息（触发多轮 tool_call）
3. 抓 WebSocket

**通过条件**：
- 按时间顺序出现：`driver.thinking`（可选）→ `driver.tool_call` → `driver.tool_result` → `driver.text` → `driver.turn_done`
- 每条事件都带 `driverId=<memberId>`
- 前端 DevTools Network → WS 能实时显示（若前端未更新则用 `wscat` 验证）

---

### E6 · 回滚开关 `TEAM_HUB_MEMBER_RUNTIME=pty`（灰度兜底）

**步骤**：
1. 重启 hub：`TEAM_HUB_MEMBER_RUNTIME=pty pnpm --filter backend dev`
2. 跑 E1 的步骤 1~2（activate member）

**通过条件**：
- stderr 出现 `[pty] spawned ... instance=<memberId>`
- WebSocket **没有** `driver.started` for member（有可能有 primary agent 的，需要区分 driverId）
- 前端 xterm 面板能看到字符流（若前端已去掉面板，则退化验证：`sqlite3 ... 'SELECT session_pid'` 能拿到 pty 子进程 pid）
- 停止 hub 后：`/tmp/mteam-*.json` 临时文件被清理（`unlinkSync` 路径）

**注意**：本 Stage 合并 Wave 2 全部 task 后，灰度窗口 ≤ 1 个 release，下个 release 的 Stage 清扫会拔掉此开关。重跑本用例时以 MILESTONE.md 标注的 "灰度开关在哪个 commit 被移除" 为准。

---

### E7 · 运行时同 hub 下 leader（primary-agent）+ member 共享 ACP

**步骤**：
1. 新建 leader 用 primary-agent 接管（本项目 leader 会转化为 primary_agent 实例）
2. activate member
3. 观察 `primary_agent.started` + `driver.started`（不同 driverId）

**通过条件**：
- 两个 driverId 都在 ws 事件里出现、可按 driverId 过滤
- leader 走 primary-agent 发 `send_msg`（通过 mteam MCP）→ member 走 driver.prompt 收到
- driverRegistry.list() 返回至少两项

---

### E8 · 错误传播：driver 启动失败 → instance 状态可感

**步骤**：
1. 构造一个不存在的 CLI：临时把 `TEAM_HUB_CLI_BIN=/bin/not-exist`
2. activate member
3. 观察事件 + DB

**通过条件**：
- 5s 内收到 `driver.error { driverId:<memberId>, message:'...' }`
- 未收到 `driver.started`
- `role_instances.status` 保持 PENDING（沿用 pty.subscriber 的妥协语义；本 Stage **不修复**这个历史问题，仅验证不会更糟）
- stderr 有明确 error log

---

### E9 · MCP 注入走原生字段（不写 tmp JSON）

**步骤**：
1. activate member
2. `ls /tmp/mteam-*.json` 全程
3. `ps` 查 child process argv

**通过条件**：
- `/tmp/mteam-*.json` 不产生（新路径走 `session/new.mcpServers`）
- child argv 不含 `--mcp-config /tmp/...`、`--append-system-prompt ...`（由 adapter.prepareSpawn 决定，不再硬拼）

---

### E10 · 并发：同一 member 连续 3 条 send_msg

**步骤**：
1. leader 快速 3 次 `send_msg`（间隔 50ms）
2. 观察 driver 事件

**通过条件**：
- 3 次均返回 `{delivered:true}`
- member 侧按顺序触发 3 轮 `driver.turn_done`
- 不出现 "driver not READY" 错误（driver 内部队列兜底）
- 若 driver 没做队列且发生错误 → 本 Stage 记为已知风险，**不阻塞合并**，但需在 `MILESTONE.md` 登记

---

## 3. 代码审计（Wave 3 清扫后）

| # | 审计项 | 命令 | 期望 |
|---|--------|------|------|
| A1 | PTY 目录已删 | `ls packages/backend/src/pty/ 2>&1` | `No such file or directory` |
| A2 | 无 `node-pty` 依赖 | `grep -r "node-pty" packages/backend/` | empty |
| A3 | 无 `ptyManager` 引用 | `grep -rn "ptyManager" packages/backend/src` | empty |
| A4 | 无 `pty.spawned / pty.exited` | `grep -rn "pty.spawned\|pty.exited" packages/backend/src` | empty |
| A5 | `BusEventType` 无 pty.* | `grep -n "pty\." packages/backend/src/bus/types.ts` | empty |
| A6 | `ws.subscriber.ts` 白名单无 pty.* | `grep -n "pty\." packages/backend/src/bus/subscribers/ws.subscriber.ts` | empty |
| A7 | `router.ts` 不 import agent-driver | `grep -n "agent-driver" packages/backend/src/comm/router.ts` | empty |
| A8 | `registry.ts` 不 import bus | `grep -n "from.*bus" packages/backend/src/agent-driver/registry.ts` | empty |
| A9 | `api/panel/role-instances.ts` 注释链路已更新 | `grep -n "pty.spawn" packages/backend/src/api/panel/role-instances.ts` | empty |

---

## 4. 文档审计

| # | 审计项 | 期望 |
|---|--------|------|
| D1 | 各新模块 `README.md` 存在 | `agent-driver/registry/`, `member-agent/`, `bus/subscribers/member-driver.subscriber.ts` 同目录 README |
| D2 | 业务模块 README 含时序图 | `member-driver.subscriber` README、`driver-dispatcher` README 有 ASCII 时序图 |
| D3 | 业务模块 README 含竞态分析 | 至少列 3 条竞态场景 + 解决方案 |
| D4 | 业务模块 README 含错误传播路径 | 列明上下游模块挂掉时的最终状态 |
| D5 | 设计文档 §6.2 里的"灰度 ≤ 1 release"与 `MILESTONE.md` 实际记录一致 | 文字一致 |
| D6 | TASK-LIST.md 所有 task 标记 completed | 本文件与 status 索引一致 |

---

## 5. 回归测试报告模板

测试员每轮测试产出 `packages/backend/docs/phase-sandbox-acp/stage-3/test-report-<yyyymmdd-hhmm>.md`：

```markdown
# Stage 3 回归测试报告

- 测试员：
- 分支 / 提交：
- 执行时间：
- 测试环境：

## 单元测试
| # | 用例 | 结果 | 证据 |
|---|------|------|------|
| U1 | ... | PASS | pnpm test 片段 |
| ... |

## 集成 E2E
| # | 场景 | 结果 | 证据（事件快照 / 日志） |
|---|------|------|------|
| E1 | ... | PASS |
| ... |

## 代码审计
| # | 项 | 结果 |

## 文档审计
| # | 项 | 结果 |

## FAIL 总结
- 提给修复员的 issue 清单：...

## 结论
- [ ] 全部 PASS → Stage 3 完成，通知 Leader 更新 MILESTONE.md
- [ ] 有 FAIL → 建修复任务 W3-2 ...
```

---

*架构师产出结束。Wave 1 可立即并行启动。*
