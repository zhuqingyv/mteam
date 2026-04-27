# Stage 5 — 回归测试清单

> 源文档：`docs/phase-sandbox-acp/stage-5-security.md`
> 测试员读这一个文件就够了，**不要**再去看代码找"漏测没漏测"。本清单是**唯一依据**。
>
> 测试纪律：
> - 不 mock DB / bus / router（mnemo 红线）
> - 允许 mock：`dockerode`、时间 `setTimeout/setInterval`
> - 失败一条就必须开修复工单，不"先记着回头测"

---

## 测试分层

```
┌─────────────────────────────────────────────────────────┐
│ L1 单元测试（每个模块自带，已在 TASK-LIST 中列出）        │
│   M1~M7 的 *.test.ts，测试员抽查即可（不再罗列具体 case）│
├─────────────────────────────────────────────────────────┤
│ L2 子系统级（subscriber 注册 + 事件流）                  │
│   → 本文档 §A、§B、§C                                    │
├─────────────────────────────────────────────────────────┤
│ L3 集成/E2E（跨 subscriber + 跨模块）                    │
│   → 本文档 §D、§E                                        │
├─────────────────────────────────────────────────────────┤
│ L4 全量回归（现有 301 单测 + 新增全跑）                  │
│   → 本文档 §F                                            │
└─────────────────────────────────────────────────────────┘
```

---

## A · container.subscriber 事件链路

### A1 · host runtime 启动流

| 步骤 | 断言 |
|------|------|
| 传 `sandbox.enabled=true`, 配 FakeRuntime 映射 `runtime='host'` | — |
| emit `primary_agent.started(agentId=a1, cliType=claude)` | — |
| 等一次事件循环 | `container.started` 事件 payload：`agentId=a1, runtimeKind='host', containerId=<FakeHandle.id>` |
| 读 registry | `registry.get('a1')` 返回非空，`runtimeKind='host'` |

**通过条件**：事件按序到达，registry 记录存在。

### A2 · docker runtime 启动流

| 步骤 | 断言 |
|------|------|
| 配 FakeRuntime 映射 `runtime='docker'` | — |
| emit `primary_agent.started(agentId=a2)` | — |
| — | `container.started.runtimeKind='docker'` |

### A3 · 重启策略三连击

| 步骤 | 断言 |
|------|------|
| enable fake timer | — |
| emit `primary_agent.started(agentId=a3)` | container.started 出现 |
| FakeHandle emit exit(code=1) | `container.crashed` 出现，`exitCode=1` |
| advance timer 1000ms | 收到新的 `primary_agent.started(agentId=a3, source='bus/container.subscriber')` |
| FakeHandle 再 exit(code=1) | 第 2 次 `container.crashed` |
| advance timer 2000ms | 第 2 次重启的 `primary_agent.started` |
| 第 3 次 exit(code=1) | 第 3 次 crashed |
| advance timer 4000ms | 第 3 次重启 |
| 第 4 次 exit(code=1) | **不再 restart**，而是 `container.exited(reason='max_restart_exceeded', exitCode=1)` |

**关键检查**：
- 每次重启的 delay 恰好是 `1000 * 2^(n-1)` ms
- 第 4 次不应看到新的 `primary_agent.started`
- `restartPolicy.peek('a3')` 最终返回 3

### A4 · 主动下线

| 步骤 | 断言 |
|------|------|
| 先 A1 让 agentId=a4 在线 | — |
| emit `primary_agent.stopped(agentId=a4)` | `container.exited(reason='stop_requested', exitCode=0)` |
| 读 registry | `registry.get('a4')` 返回 null |
| 读 restart policy | `restartPolicy.peek('a4') === 0`（被 reset 清零） |

### A5 · stopped 与 exit 竞态

| 步骤 | 断言 |
|------|------|
| a5 在线 | — |
| emit stopped（触发 handle.kill） | registry 清理 + exited(reason=stop_requested) |
| 紧接着 FakeHandle emit exit(code=137) | **不应**再 emit container.crashed（因 userStopped 标记已设） |

**关键**：stopped 路径在 kill 前必须先标记"用户主动"，否则 exit 会误判为崩溃。

### A6 · 重启 timer 被 stopped 取消

| 步骤 | 断言 |
|------|------|
| a6 崩溃 1 次（container.crashed 出现） | timer 已排程 1000ms |
| advance 500ms（未到重启点） | — |
| emit `primary_agent.stopped(agentId=a6)` | `container.exited(reason=stop_requested)` |
| advance 1000ms | **不应**出现 primary_agent.started（timer 已取消） |

### A7 · 重复 primary_agent.started 幂等

| 步骤 | 断言 |
|------|------|
| emit started(a7) 两次 | 只有 1 次 `container.started`，registry 只记一次，只 spawn 一个 handle |

---

## B · policy.subscriber 拦截链路

### B1 · 白名单命中放行

| 步骤 | 断言 |
|------|------|
| ruleRepo 配置 `driverKey=d1` 的 allow=['mcp__mteam__*']，configured=true | — |
| 绑定 `driverMap.bind('d1', 'i1')` | — |
| emit `driver.tool_call(driverId='d1', name='mcp__mteam__search_members')` | **不应**出现 policy.violated |
| 1 个 tick 后 emit `instance.offline_requested`？ | **不应**出现 |

### B2 · 违规拦截 + 级联下线

| 步骤 | 断言 |
|------|------|
| 同 B1 准备 | — |
| emit `driver.tool_call(d1, name='Bash', correlationId='c-xxx')` | `policy.violated(driverId='d1', toolName='Bash', reason='not_in_whitelist', correlationId='c-xxx')` |
| 自动级联 | `instance.offline_requested(instanceId='i1', requestedBy='policy-enforcer', correlationId='c-xxx')` |

**关键**：correlationId 必须从 tool_call 一路透传到 offline_requested。

### B3 · 全局 deny 覆盖模板 allow

| 步骤 | 断言 |
|------|------|
| 模板 allow=['Bash']，yaml deny=['Bash'] | — |
| emit `driver.tool_call(d2, name='Bash')` | `policy.violated(reason='explicit_deny')` |

### B4 · 未配置白名单 = default allow

| 步骤 | 断言 |
|------|------|
| ruleRepo 对 driverKey 返回 `configured=false` | — |
| emit `driver.tool_call(d3, name='AnyTool')` | **不应**出现 policy.violated |

### B5 · driver→instance 未绑定

| 步骤 | 断言 |
|------|------|
| ruleRepo 触发违规 | `policy.violated` 照常出现（审计） |
| driverMap 无 d4 的 binding | **不应**出现 `instance.offline_requested` |

### B6 · driver.stopped 清理 map

| 步骤 | 断言 |
|------|------|
| bind d5→i5 | lookup('d5') === 'i5' |
| emit `driver.stopped(driverId='d5')` | `lookup('d5') === null` |

### B7 · 通配符 + 精确组合

| 步骤 | 断言 |
|------|------|
| allow=['mcp__mteam__*', 'Read']，deny=[] | — |
| call 'mcp__mteam__search' → 放行 | ✓ |
| call 'Read' → 放行 | ✓ |
| call 'Write' → 拦 | policy.violated |

---

## C · bootSubscribers 配置开关

### C1 · 默认零配置 = Stage 3 形态

| 步骤 | 断言 |
|------|------|
| `bootSubscribers({ commRouter })`（不传 config） | — |
| emit `primary_agent.started(a0)` | **无** container.started（subscriber 未注册） |
| emit `driver.tool_call(d0, name='Bash')` | **无** policy.violated |

### C2 · sandbox.enabled=false

| 步骤 | 断言 |
|------|------|
| 传 `{ sandbox: { enabled: false, transport: 'stdio' } }` | — |
| emit primary_agent.started | **无** container.started |

### C3 · sandbox.enabled=true

| 步骤 | 断言 |
|------|------|
| 传 `{ sandbox: { enabled: true, transport: 'stdio' } }` + FakeRuntime | — |
| emit primary_agent.started | container.started 出现 |

### C4 · policy.enabled=false

| 步骤 | 断言 |
|------|------|
| 传 `{ policy: { enabled: false } }` | — |
| emit driver.tool_call('Bash') | **无** policy.violated |

### C5 · policy.enabled=true

| 步骤 | 断言 |
|------|------|
| 传 `{ policy: { enabled: true, configPath } }` + 写 yaml `deny: [Bash]` | — |
| emit driver.tool_call('Bash') | policy.violated 出现 |

### C6 · 幂等 + 关停

| 步骤 | 断言 |
|------|------|
| `bootSubscribers(cfg)` 两次 | 第二次是 no-op，subscription 数不变 |
| `teardownSubscribers()` | ruleRepo.close 被调用，subscription 全部清理 |

---

## D · 跨 subscriber 联动

### D1 · policy.violated → instance.offline_requested → team.subscriber 级联下线

> 这条验证 policy.subscriber 发出的 `instance.offline_requested` 能被**现有 team.subscriber 原样消费**（不应因 Stage 5 新增而破坏现有级联）。

| 步骤 | 断言 |
|------|------|
| 真实启动 team.subscriber + policy.subscriber + roster.subscriber | — |
| 走完 team 创建 → leader + member 各一 → all ACTIVE（复用现有 http-*.test.ts fixture） | — |
| emit driver.tool_call 让成员违规 | `policy.violated` → `instance.offline_requested(instanceId=memberId, requestedBy='policy-enforcer')` → team.subscriber 消费 → 成员状态变 PENDING_OFFLINE / 最终 DELETED |
| 读 DB | `role_instances` 里该成员 status 落到"下线中"或按 team-cascade 现有路径完成删除 |

**关键**：policy 触发的下线与用户主动下线走同一级联路径，不应引入新分支。

### D2 · container.crashed 事件被 ws.subscriber 广播

| 步骤 | 断言 |
|------|------|
| 新增 WS 客户端监听 | — |
| 触发 crashed | WS 客户端收到 `container.crashed` 消息 |
| 同样对 container.started / container.exited / policy.violated | 四条都应被广播 |

### D3 · log.subscriber 覆盖新事件

| 步骤 | 断言 |
|------|------|
| 触发 A3 场景 | log.subscriber 的日志输出里能看到 container.crashed / policy.violated 条目（文本包含事件类型） |

---

## E · 端到端（E2E）

> 放 `packages/backend/src/__tests__/` 目录，参考现有 `team-integration.test.ts` 风格。
> E2E 测试**不跑真 docker**（测试环境没 docker），用 FakeRuntime 绕开。真 docker 场景由 `docs/phase-sandbox-acp/e2e-report.md` 手工验证。

### E2E-1 · 主 Agent host 模式 + 崩溃自愈

| 步骤 | 断言 |
|------|------|
| server.ts 启动（环境变量 TEAM_HUB_SANDBOX=1），FakeRuntime 注入 | — |
| `POST /api/primary-agent/start` | 2xx，DB `primary_agent.status='RUNNING'` |
| 事件流监听 | 先后收到 `primary_agent.started` → `container.started(runtimeKind='host')` → `driver.started` |
| FakeHandle 模拟崩溃（exit 1） | `container.crashed` → 1s 后 `primary_agent.started` 自动重试 → 新 `container.started` |
| 三次崩溃后第 4 次 | `container.exited(reason='max_restart_exceeded')`，**不再自愈** |

### E2E-2 · 成员 Agent 策略拦截

| 步骤 | 断言 |
|------|------|
| server 启动 with TEAM_HUB_POLICY=1 | yaml: `global_allow: [mcp__mteam__*]`, `deny: [Bash]` |
| `POST /api/role-instances` 创建成员（template 白名单=['mcp__mteam__*']） | 2xx |
| `POST /api/role-instances/:id/activate` | 2xx |
| 模拟 AgentDriver emit `driver.tool_call(name='Bash')` | `policy.violated(reason='explicit_deny')` → `instance.offline_requested(requestedBy='policy-enforcer')` |
| 等级联完成 | DB `role_instances.status` 最终为 `DELETED`（走 team-cascade 现有路径） |

### E2E-3 · 配置关闭不回归

| 步骤 | 断言 |
|------|------|
| server 启动 **不传**任何新环境变量 | — |
| 完整跑一遍 team 创建 / member 加入 / 下线的现有流程（复用 http-team-lifecycle.test.ts 场景） | 行为与 Stage 3 完全一致，无 container.* / policy.* 事件产出 |

---

## F · 全量回归

### F1 · 现有单测不破

| 命令 | 期望 |
|------|------|
| `cd packages/backend && bun test` | **301 个现有单测 + Stage 5 新增单测全绿** |
| 如有失败 | 定位是 Stage 5 改动引起还是既有 bug。Stage 5 引起 → 回 TASK-LIST 找对应 M 开修复工单 |

### F2 · TypeScript 零错误

| 命令 | 期望 |
|------|------|
| `cd packages/backend && bun run typecheck`（或等价 `tsc --noEmit`） | 零错误 |

### F3 · 现有事件类型兼容

| 检查点 | 期望 |
|--------|------|
| 所有现有 subscriber（roster / team / pty / domain-sync / comm-notify / log / ws）无签名变更 | grep 现有 `subscribeXxx` 的导出签名 = Stage 4 末状态 |
| `BusEvent` 联合只"加"不"改" | M5 diff 是纯增量，无 interface 字段变更 |

### F4 · WS 白名单

| 检查点 | 期望 |
|--------|------|
| `WS_EVENT_TYPES` 包含 Stage 4 所有旧事件 + 4 个新事件 | 对比 ws.subscriber.ts diff，集合大小 = 原 + 4 |

---

## 测试员交付

测试员每轮出一份报告：`docs/phase-sandbox-acp/stage-5/TEST-REPORT-<轮次>.md`，格式：

```markdown
# Stage 5 测试报告 - 第 N 轮

测试员：<name>
日期：YYYY-MM-DD
被测 commit：<sha>

## 通过
- A1 ✓
- A2 ✓
- ...

## 失败
- A3 第 4 次崩溃未触发 max_restart_exceeded
  - 实际：timer 继续排程了第 4 次重启
  - 证据：log 片段 / 截图
  - 责任模块：M4 / M6
  - 建议：检查 restartPolicy.onCrash 的边界条件

## 结论
- 通过率 X/Y
- 阻断性 bug 数：N
- 是否放行：是/否
```

有 bug → 派修复员 → 新测试员重测 → 循环直到全绿。

---

## 不在 Stage 5 验收范围

**明确记下来，避免测试员误扩范围：**

1. **真 docker 容器启动**：测试环境无 docker 守护进程，用 FakeRuntime 覆盖事件语义即可。真 docker 验证走 `docs/phase-sandbox-acp/e2e-report.md` 手工。
2. **事前拦截工具调用**：Stage 5 policy 是"事后强制下线"（stage-5-security.md §3.1 明文）。期望"AgentDriver 把 tool_call 挂起等 policy 决策"的是下一个 Stage 的事。
3. **重启计数持久化**：backend 重启后计数清零是已定妥协（stage-5-security.md §2.1.2）。测试不要为这条"找不 bug"。
4. **driver→instance map 的 bind 责任**：policy.subscriber 只做 unbind。如果成员没下线，先查调用方有没有 bind，**不是** policy.subscriber 的 bug。
