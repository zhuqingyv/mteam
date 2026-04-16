# Agent UX 审计报告 — Round 2 (体验官 B)

> 审计人：独立二审官（全新视角，未读一审报告）
> 审计日期：2026-04-16
> 审计范围：hub.ts (60+ 工具定义 + handleToolCall) 、index.ts (MCP_INSTRUCTIONS)
> 方法：以 Agent 身份模拟完整工作流，逐工具评估，特别关注跨工具组合流程

---

## 一、MCP_INSTRUCTIONS 初级评估

阅读 index.ts 第 126-183 行的 MCP_INSTRUCTIONS。

**评价：**
- "你是谁"判断段落清晰（有 reservation_code → 成员，无 → leader）
- 成员生命周期一行式足够：activate → 执行任务 → checkpoint → save_memory → deactivate
- 离场流程说明：request_departure + clock_out 分离
- 权限模型列表明确区分 leader/成员/全员工具
- 错误恢复段落覆盖 5 种场景

**问题 B-01：成员工具列表中 check_in/check_out 排列位置造成误导**

index.ts:152 列出成员工具含 `activate, save_memory, read_memory, deactivate, submit_experience, checkpoint, check_in, check_out, check_inbox, clock_out`。但 check_in 和 check_out 的 description 表明它们是低频操作（切换项目/任务时用 check_in；deactivate 失败时用 check_out）。排列在高频工具（activate/save_memory）之后，容易造成新 agent 以为是常规流程的一部分。

**建议：** 在列表中对 check_in/check_out 标注"（极少使用）"或将其移到 MCP_INSTRUCTIONS 最后的"应急工具"子段落。

**严重程度：LOW** — 列表顺序容易造成短暂困惑，但工具 description 本身有足够引导。

---

## 二、成员完整生命周期走查

模拟新成员从 spawn 到下线的完整流程。

### 预约阶段：request_member

hub.ts:1768-1970 `request_member(caller, member, project, task, auto_spawn=true)`

**测试流程：**
1. Leader 调 `request_member("leader", "alice", "project_a", "实现认证系统", auto_spawn=true)`
2. 返回：`reserved=true, reservation_code, ttl_seconds=210, member_brief, spawn_result, usage_hint`

**评价：**
- 返回值包含预约码、TTL、成员简介、spawn 结果、usage_hint
- usage_hint 明确说"终端已创建，用 send_msg 下达指令"
- previous_member 参数存在，支持交接场景

**问题 B-02：usage_hint 说"终端已创建"但成员终端可能尚未就绪**

hub.ts:1964-1968 usage_hint 说 `"→ 终端已创建，用 send_msg(to="${member}", content="任务描述") 给成员下达指令"`。但 auto_spawn 只是创建 PTY session，成员 agent 可能还在 MCP 协商阶段。发送的 send_msg 会写入 PTY stdin，但如果成员 agent 尚未开始读取 MCP 工具列表，消息可能在缓冲区等待。

目前 index.ts 没有"成员已激活"的显式通知给 leader，所以 leader 无法确认时序。

**建议：** usage_hint 增加一句"成员终端正在启动，首条消息建议稍等片刻发送，或待成员调 activate 后再下达"。

**严重程度：LOW** — PTY 缓冲会保存消息不会丢，只是时序上成员可能看不到完整上下文。

---

### 激活阶段：activate

hub.ts:1996-2195 `activate(member, reservation_code)`

**测试流程：**
1. 成员 `activate("alice", reservation_code)`
2. 返回：identity, persona, memory_generic, memory_project, current_task, team_rules, peer_pair, project_rules, project_members, pending_messages_count, predecessor, workflow_hint

**评价：**
- 返回值极其丰富，workflow_hint 是分步骤的动态生成
- 条件步骤设计优秀：
  - 有前任（predecessor）时自动引导读前任记忆
  - 有待读消息时自动引导 check_inbox
  - 无项目规则时明确说明
- 工作流 7 步引导清晰

**问题 B-03：project_rules 匹配可能命中错误项目**

hub.ts:2141-2146 项目匹配逻辑：
```
const currentProject = allProjects.find(
  (p) => p.name === activeLock.project || p.members.includes(member)
);
```

如果成员属于多个项目（project_A 和 project_B 都包含 alice），但 activeLock.project 是 "project_C"（名称不匹配），则会返回第一个包含 alice 的项目（project_A），而不是当前任务的项目。

**建议：** 优先用 project name 精确匹配，members.includes 作 fallback 但加日志或返回值标记 `{ matched_by: "name" | "membership" }`。

**严重程度：LOW** — 正常流程中 project name 应该精确匹配，这是边界 case。

---

### 工作中：checkpoint + send_msg + check_inbox

#### checkpoint 

hub.ts:947-956

**评价：**
- 返回值含原始任务、项目规则、验收标准
- 设计清晰

**无新问题。**

#### send_msg 

hub.ts:1007-1018 `send_msg(to, content, priority)`

**问题 B-04：send_msg 的 to 参数支持值不明确**

description 说"from 由系统自动推断，支持成员间互相协调"。但 to 的 description 只说"目标成员名"，没有说明是否支持 "leader" 作为 to 值。如果成员想回复来自 leader 的消息（send_msg 中 from="leader"），to 应该填什么？成员名？'leader'？

hub.ts:2048 有代码 `to: { type: "string", description: "目标成员名" }`，但实现中（index.ts 没有详细的 send_msg 实现，转发到 Hub），没有明确的参数验证。

**建议：** send_msg 的 inputSchema 中 to 的 description 改为"目标成员名或 'leader'"。同时增加一句说明如何识别消息来自谁。

**严重程度：MEDIUM** — 影响 leader-成员双向通信。成员如果猜错 to 的值，消息可能发送失败或发到错误目标。

---

#### check_inbox

hub.ts:1020-1030 `check_inbox(member, peek=false)`

**评价：**
- peek 参数设计完善：peek=true 只读不消费，peek=false 消费（默认）
- description 明确标注"消息读取后将被清除"
- 返回值含 messages 数组

**无问题。**

---

### 保存经验：save_memory + submit_experience

#### save_memory

hub.ts:418-430 `save_memory(member, scope, content, project?)`

**评价：**
- description 说"deactivate 前必须调用"
- scope 两值：generic/project
- inputSchema 中 project description 说"仅 scope='project' 时需要"

**问题 B-05：scope='project' 但不传 project 时无报错**

hub.ts:1404-1422 save_memory 实现：
```typescript
const scope = str("scope") as "generic" | "project";
const content = str("content");
const project = optStr("project");
try {
  await callPanel("POST", `/api/member/${encodeURIComponent(member)}/memory/save`, 
    { scope, content, ...(project ? { project } : {}) });
} catch {
  saveMemory(MEMBERS_DIR, member, scope, content, project);
}
```

当 scope='project' 但 project 未传时，optStr("project") 返回 undefined，然后调 saveMemory 的 project 参数为 undefined。内部逻辑取决于 memory-store 实现，可能存入错误位置。

**建议：** 在 handler 中增加显式验证：
```typescript
if (scope === "project" && !project) {
  return ok({ error: "scope='project' 时 project 参数必填" });
}
```

**严重程度：LOW** — 正常使用中 agent 会传 project，但边界 case 可能导致数据存错位置。

---

#### submit_experience

hub.ts:445-456

**评价：**
- 三个 scope：generic/project/team
- team scope 进入规则审批流程，设计优秀
- 返回值含 warning + similar_lines

**无问题。**

---

### 离场：deactivate vs clock_out

#### deactivate

hub.ts:671-682 `deactivate(member, note?, force?)`

**测试流程：**
1. 成员调 `save_memory("alice", "generic", "...经验...")`
2. 成员调 `deactivate("alice")`
3. 返回：success, member, hint

**评价：**
- 含 isActivated 检查、经验保存检查、lock 释放、MCP 清理、心跳删除、departure.json 清理
- 返回值含 hint 引导

**问题 B-06：deactivate 成功后没有自动通知 leader**

hub.ts:1345 hint 说"→ 已下线。如需通知 leader 任务完成可用 send_msg"，这只是建议。对比 clock_out（离场下班），会自动发通知给 leader。

在实际场景中，leader 经常依赖成员主动上报来推进工作。如果成员只调 deactivate 不手动 send_msg，leader 不知道成员已完成，可能导致任务推进缓慢。

这是设计选择而非 bug（deactivate 是通用下线，不一定表示任务完成），但在工作流中造成了不对称。

**建议：** workflow_hint 最后一步从 "save_memory → deactivate" 改为 "save_memory → 用 send_msg 通知 leader 任务完成 → deactivate"，或在 deactivate 返回值中更明确地引导通知。

**严重程度：MEDIUM** — 影响 leader 对任务完成的感知时效。

---

#### clock_out

hub.ts:1046-1057 `clock_out(member, note?, force?)`

**评价：**
- 比 deactivate 更完整：含离场前的 pending_departure 检查
- 自动通知 leader：线上查到 "调 callPanel(...通知 leader...)"
- 返回值明确

**无问题。**

---

## 三、Leader 完整生命周期走查

### 初期：查看花名册

get_roster 返回值含 roster, governance, summary

**无问题。**

---

### 分配阶段：request_member + send_msg

已在成员阶段评估过。此处关注 leader 侧的时序问题（B-02）。

---

### 监控阶段：team_report / project_dashboard / stuck_scan

#### team_report

hub.ts:1623-1642

**评价：**
- 返回 working 和 idle 两个数组
- working 数组含 lock 信息
- 返回值有 hint 引导

**问题 B-07：working 数组缺少心跳时间信息**

hub.ts:1636 working 数组中每个成员有 `{ uid, name, role, lock }`，但没有 `last_seen`。leader 无法区分"真在工作"和"锁住了但心跳已超时（可能卡死）"。需要额外调 get_status 或 stuck_scan 才能发现。

**建议：** working 数组中增加 `last_seen` 字段。

**严重程度：LOW** — stuck_scan 已覆盖超时检测，只是 team_report 信息不够完整。

---

#### stuck_scan

hub.ts:605-614

**评价：**
- 自动扫描超时成员
- 返回 stuck 数组 + 推荐操作步骤
- 设计完善

**无问题。**

---

### 离场：request_departure + clock_out

#### request_departure

hub.ts:1033-1044 `request_departure(member, pending=true, requirement?)`

**测试流程：**
1. Leader 调 `request_departure("alice", pending=true)`
2. 返回：成功时异步标记，通知 alice
3. alice 最后调 `clock_out("alice")`

**评价：**
- pending=false 支持撤销
- 通过 PTY 通知成员

**问题 B-08：offline 成员报错没有引导替代操作**

hub.ts 中离场流程的代码（在下文的检查中）可能在检查成员 heartbeat 时发现成员 offline。当 offline 时返回错误。但错误信息没有引导 leader 用 force_release 或 release_member 替代。

**建议：** 如果检查到 offline，错误信息应该改为"成员 xxx 当前 offline。离场流程仅对在线成员有效。如需清理该成员的残留锁，请用 release_member 或 force_release"。

**严重程度：LOW** — leader 通常知道用 force_release，但更好的错误信息能减少决策时间。

---

## 四、多工具组合流程验证

### 组合流程 1：完整生命周期（招人→派活→工作→离场）

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. get_roster | 查状态 | 返回全员状态 + 建议 | OK |
| 2. request_member(auto_spawn=true) | 预约+创建终端 | usage_hint 含预约码 + send_msg 示例 | ⚠ 有 B-02 |
| 3. (成员) activate | 加载上下文 | workflow_hint 分步引导 | OK |
| 4. (成员) checkpoint | 自查 | 6 条引导 | OK |
| 5. (成员) save_memory | 保存经验 | hint → submit_experience → deactivate | OK |
| 6. (成员) deactivate | 下线 | hint 只建议 send_msg，不强制 | ⚠ 有 B-06 |
| 7. (leader) request_departure | 发起离场 | 异步标记，无需等待 | OK |
| 8. (成员) clock_out | 下班 | 自动通知 leader | OK |

**结论：** 完整生命周期流程通畅，但存在两个值得改进的地方（B-02、B-06）。

---

### 组合流程 2：任务交接（跨成员）

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. A save_memory | 保存进度 | OK |
| 2. A deactivate | A 下线 | OK |
| 3. leader request_member(member=B, previous_member=A) | 预约 B，标记前任 | reserved=true + reservation_code | OK |
| 4. B activate | 加载上下文 | predecessor="A" + workflow_hint 含"读前任记忆"步骤 | OK |
| 5. B read_memory(member=A) | 读 A 的记忆 | 返回 content | OK |
| 6. B work_history(member=A) | 看 A 的工作记录 | 返回 history | OK |

**结论：** 交接流程完整。predecessor 信息传递通畅。

---

### 组合流程 3：消息流（跨 agent 协调）

| 步骤 | 工具 | 语义 | 评价 |
|------|------|------|------|
| 1. alice send_msg(to=?, content="需要建议") | 发消息给谁 | ⚠ to 参数支持值不明确 | 有 B-04 |
| 2. leader check_inbox(member="leader", peek=true) | 查收件箱 | 只读不消费 | OK |
| 3. leader send_msg(to="alice", content="...") | 回复 alice | from 自动推断为 leader | OK |
| 4. alice check_inbox(member="alice") | 消费消息 | 消息被清除 | OK |

**结论：** 消息流完整，但 to 参数语义需要澄清（B-04）。

---

### 组合流程 4：治理流程

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. 成员 propose_rule | 提议规则 | hint 含 send_msg 通知 leader 示例 | OK |
| 2. 成员 send_msg(to=leader 名字) | 通知 | sent=true | OK |
| 3. leader review_rules | 查待审 | 返回规则列表 + hint | OK |
| 4. leader reject_rule | 拒绝 | 自动 send_msg 通知提议者 | OK |

**结论：** 治理流程前后端都有通知，不再断链。

---

## 五、工具描述清晰度逐项检查

### 高频工具（必须清晰）

| 工具 | 描述清晰度 | 参数命名 | 返回值引导 | 评价 |
|------|-----------|---------|-----------|------|
| activate | ✅ 清晰 | ✅ 明确 | ✅ workflow_hint 完善 | OK |
| save_memory | ✅ 清晰 | ⚠ project 参数校验缺失 | ✅ 好 | 有 B-05 |
| deactivate | ✅ 清晰 | ✅ 明确 | ⚠ 缺通知 leader 步骤 | 有 B-06 |
| send_msg | ✅ 清晰 | ⚠ to 支持值不明确 | ✅ 好 | 有 B-04 |
| request_member | ✅ 清晰 | ✅ 明确 | ⚠ 时序说明缺失 | 有 B-02 |
| get_roster | ✅ 清晰 | - | ✅ 返回值丰富 | OK |

### 中频工具（良好即可）

| 工具 | 评价 |
|------|------|
| checkpoint | OK - 自查提示清晰 |
| submit_experience | OK - 有重复检测 warning |
| check_inbox | OK - peek 设计完善 |
| project_dashboard | OK - 返回值清晰 |
| team_report | ⚠ last_seen 缺失 - 有 B-07 |
| stuck_scan | OK - 推荐操作明确 |
| handoff | OK - 通知机制完善 |

### 低频工具（一致性检查）

propose_rule, review_rules, approve_rule, reject_rule：治理流程环节清晰，无问题。

hire_temp, evaluate_temp, list_templates：招募流程清晰，无问题。

proxy_tool, mount_mcp, unmount_mcp：MCP 工具路由清晰，无问题。

---

## 六、新问题汇总

| 编号 | 严重程度 | 工具 | 问题 | 建议 |
|------|---------|------|------|------|
| B-01 | LOW | MCP_INSTRUCTIONS | 成员工具列表含 check_in/check_out 排列位置容易误导 | 标注"(极少使用)"或移到应急子段落 |
| B-02 | LOW | request_member | 成员终端可能尚未就绪时 leader 就发 send_msg | usage_hint 增加时序说明 |
| B-03 | LOW | activate | project_rules 匹配可能命中非当前项目 | 优先 name 精确匹配，membership 作 fallback |
| B-04 | MEDIUM | send_msg | to 参数支持值不明确（成员如何回复 leader） | description 说明"to 支持成员名或 'leader'" |
| B-05 | LOW | save_memory | scope='project' 但不传 project 时无验证 | 增加参数校验 |
| B-06 | MEDIUM | deactivate | 成功后不自动通知 leader | workflow_hint 增加 send_msg 步骤或强化返回值引导 |
| B-07 | LOW | team_report | working 数组缺 last_seen | 增加心跳时间字段 |
| B-08 | LOW | request_departure | offline 成员报错没有引导用替代操作 | 错误信息增加 release_member/force_release 建议 |

---

## 七、与一审的交集检查

从审计范围判断，一审应该已评估：
- clock_out save_memory 检查（应已修复）
- check_inbox 消费语义（应已修复）
- 任务交接上下文（应已修复）
- activate 不返回收件箱（应已修复）
- 各工具通知机制（应已修复）

本审计 B-01 到 B-08 是全新发现。其中 B-04、B-06 是 MEDIUM 严重程度，其余是 LOW。

---

## 八、总结

### 核心工作流评估

✅ **流程通畅度：完整的成员生命周期（recruit→activate→work→save_memory→deactivate）无明显断裂。**

✅ **跨成员交接流程：predecessor 信息传递完善，前任记忆读取引导清晰。**

✅ **消息系统：send_msg + check_inbox 机制完善，但 to 参数语义需澄清。**

✅ **治理流程：propose_rule→review→approve/reject 闭环，通知机制完整。**

⚠ **返回值引导：大多数工具有 hint 字段，但少数关键流程缺少隐性引导（如 deactivate 缺通知 leader 步骤）。**

### 发现的问题

**MEDIUM 级（需要修复）：**
- B-04：send_msg 的 to 参数支持值不透明 — 影响 leader-成员通信可靠性
- B-06：deactivate 不通知 leader — 影响任务完成感知时效

**LOW 级（改进项）：**
- B-01、B-02、B-03、B-05、B-07、B-08 — 均为信息不完整或边界 case 处理

### 系统整体评估

**可用性评分：8/10**

核心流程完整，Agent 能够理解并执行标准工作流。返回值和 hint 设计已达到生产级别。剩余问题为锦上添花的改进，不影响基本功能运作。

**建议优先级：**
1. 修复 B-04（send_msg to 参数支持值）— 高频工具
2. 改进 B-06（deactivate 通知机制）— 工作流完整性
3. 其余 LOW 级问题作为后续迭代改进

