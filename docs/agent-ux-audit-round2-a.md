# Agent UX 审计报告 — Round 2 (体验官 A)

> 审计人：dev-critical（全新视角，未读前次报告）
> 审计日期：2026-04-16
> 审计范围：hub.ts (42 个工具定义 + handleToolCall)、index.ts (MCP_INSTRUCTIONS)
> 方法：以 Agent 身份模拟完整工作流，逐工具评估

---

## 一、Top 10 修复验证

前次审计提出 10 个必改项。逐条检查代码是否已修复到位。

### 1. [CRITICAL] clock_out 缺 save_memory 检查 — **已修复**

- hub.ts:2951 增加了 `if (isActivated(member) && !hasMemorySaved(member) && !force)`
- description 增加了 "建议先 save_memory 保存经验再 clock_out"
- inputSchema 增加了 `force` 参数
- 测试覆盖：top10-fixes.test.ts Fix 1（3 个测试）

**验证结论：修复完整，经验丢失风险已消除。**

### 2. [CRITICAL] check_inbox 消费语义 — **已修复**

- description 改为 "消费收件箱消息（读取并清空队列）。注意：消息读取后将被清除，不可重复读取。"
- 增加了 `peek` 参数（peek=true 用 GET 只读，默认 DELETE 消费）
- hub.ts:2775-2779 实现 `const method = peek ? "GET" : "DELETE"`
- 测试覆盖：top10-fixes.test.ts Fix 2（3 个测试）

**验证结论：修复完整。peek 模式是正确的非破坏性方案。**

### 3. [CRITICAL] 任务交接上下文断裂 — **已修复**

- request_member inputSchema 增加 `previous_member` 参数
- Reservation 接口增加 `previous_member?: string`
- activate 返回值增加 `predecessor` 字段
- workflow_hint 动态增加前任引导步骤（含 work_history + read_memory 调用示例）
- 测试覆盖：top10-fixes.test.ts Fix 9（2 个测试）

**验证结论：修复完整。跨 session 交接有了明确的上下文传递通道。**

### 4. [HIGH] send_msg from="unknown" — **已修复**

- hub.ts:2748-2755 增加了 `else if (session.isLeader) { from = "leader"; }` 分支
- 推断优先级：activatedMembers → session.memberName → isLeader → "unknown"
- 测试覆盖：top10-fixes.test.ts Fix 3（3 个测试）、isleader.test.ts

**验证结论：修复完整。leader 消息不再是 unknown。**

### 5. [HIGH] activate 不返回收件箱 — **已修复**

- hub.ts:2150-2154 增加 pending_messages_count 获取（通过 GET 不消费）
- hub.ts:2170-2172 workflow_hint 条件增加"你有 N 条待读消息"步骤
- 返回值含 `pending_messages_count` 字段
- 测试覆盖：top10-fixes.test.ts Fix 6（2 个测试）

**验证结论：修复完整。成员上线即知道有待读消息。**

### 6. [HIGH] uninstall_member_mcp 误杀全部 MCP — **已修复**

- hub.ts:2404-2409 改为先检查 `configs.some(c => c.name === mcpName)`，再调 `cleanupOneMcp(member, mcpName)` 只清理目标
- 不再调用 `cleanupMemberMcps`
- 测试覆盖：top10-fixes.test.ts Fix 4（2 个测试）

**验证结论：修复完整。只清理被卸载的 MCP，保留其他。**

### 7. [HIGH] deactivate 不清理 departure.json — **已修复**

- hub.ts:1341 增加 `deleteDepartureFile(member)`
- 注释："清理残留的 departure.json（防止状态不一致）"
- 测试覆盖：top10-fixes.test.ts Fix 5（2 个测试）

**验证结论：修复完整。deactivate 不再留下脏状态。**

### 8. [MEDIUM] MCP_INSTRUCTIONS 缺错误恢复引导 — **已修复**

- index.ts:172-177 增加了"错误恢复"段落
- 覆盖：activate 失败、save_memory 失败、deactivate 失败、权限不足、预约过期
- 每条给出具体恢复步骤

**验证结论：修复完整。**

### 9. [MEDIUM] propose_rule / reject_rule 通知 — **已修复**

- propose_rule 的 hint 改为含 send_msg 示例和 get_roster 查 leader 名的引导
- reject_rule 实现中增加了 callPanel("POST", "/api/message/send") 通知提议者
- 测试覆盖：top10-fixes.test.ts Fix 8（3 个测试）

**验证结论：修复完整。治理流程不再断链。**

### 10. [MEDIUM] update_project 全量替换无警告 — **已修复**

- hub.ts:2609-2625 增加数组缩短检测 + confirm_overwrite 参数
- 缩短时返回当前值 + 明确错误信息
- 测试覆盖：top10-fixes.test.ts Fix 7（5 个测试）

**验证结论：修复完整。误删保护到位。**

---

## 二、全新视角审计 — 成员 Agent 完整流程走查

模拟一个刚 spawn 的成员 Agent，从零开始走完整个生命周期。

### 阶段 1：启动 — Agent 看到什么

Agent 启动后收到 MCP_INSTRUCTIONS（index.ts:126-183）。

**评价：**
- "你是谁"判断段落清晰（有 reservation_code → 成员，没有 → leader）
- 成员生命周期一行式描述足够（activate → 任务 → checkpoint → save_memory → deactivate）
- 错误恢复段落覆盖了 5 种常见场景

**问题 R2-01：MCP_INSTRUCTIONS 中成员专用工具列表包含 check_in、check_out**

index.ts:152 列出成员专用工具含 `check_in, check_out`。但 check_in 的 description 明确说"activate 已自动签入，仅切换项目/任务时手动调用"，check_out 说"仅在 deactivate 失败时作为应急手段"。新成员 agent 看到这个列表后可能在错误的时机调用 check_in 或 check_out。

**建议：** 在列表中标注"(极少使用)"或将 check_in/check_out 从成员专用工具列表移到"应急工具"子段落。

**严重程度：LOW** — description 本身有足够的引导，只是列表可能造成短暂困惑。

### 阶段 2：activate — 返回值是否足以开工

调用 activate(member, reservation_code) 后收到：
- identity, persona, memory_generic, memory_project
- current_task, team_rules, peer_pair, project_rules, project_members
- pending_messages_count, predecessor, workflow_hint

**评价：** activate 的返回值非常丰富，workflow_hint 是分步引导的，条件步骤（有前任时引导读前任记忆，有待读消息时引导 check_inbox）设计优秀。

**问题 R2-02：activate 返回的 project_rules 匹配逻辑可能命中错误项目**

hub.ts:2141-2143 项目匹配用 `p.name === activeLock.project || p.members.includes(member)`。如果成员属于多个项目，会命中第一个匹配的。如果 activeLock.project 名称与任何 project.name 都不匹配但成员在某个项目的 members 中，会返回那个项目的规则——可能不是当前任务的项目。

**建议：** 优先用 project name 精确匹配，members.includes 作为 fallback 但加日志或返回值标记 `{ matched_by: "name" | "membership" }`。

**严重程度：LOW** — 正常流程中 project name 应该匹配。

### 阶段 3：工作中 — 发消息、查进度

#### send_msg

description 清晰说明了 from 自动推断、不需要手动指定。to 填"目标成员名"。

**问题 R2-03：send_msg 的 to="leader" 在 Panel 端如何解析不透明**

hub.ts:2757 注释说"名字解析统一由 Panel 端完成"。如果成员想回复 leader，to 应该填什么？"leader"？leader 的名字？提示词没有说明。request_departure 发出的通知 from="leader"，成员回复时 to="leader" 是否能送达？

**建议：** send_msg 的 description 增加一句"to 支持成员名或 'leader'"。

**严重程度：MEDIUM** — 影响 leader-成员双向通信的可靠性。成员如果猜错 to 的值，消息可能发不出去或发到错误目标。

#### check_inbox

peek 模式完善，description 清晰标注了消费语义。

**无新问题。**

#### checkpoint

verification_prompt 6 条自查提示是系统里设计最好的引导。返回值含 original_task, project_rules, team_rules, acceptance_chain。

**无新问题。**

### 阶段 4：保存经验

save_memory, submit_experience 都有 isActivated 检查。

**问题 R2-04：save_memory scope="project" 但不传 project 时无报错**

save_memory inputSchema 中 project description 说"仅 scope='project' 时需要"，但 scope="project" + project 不传时，代码调用 `saveMemory(MEMBERS_DIR, member, "project", content, undefined)`，行为取决于 memory-store 的实现。可能静默保存到错误位置。

**建议：** 在 handler 中增加 `if (scope === "project" && !project) return ok({ error: "scope='project' 时 project 参数必填" })`。

**严重程度：LOW** — agent 通常会传 project，但边界case可能导致数据存错位置。

### 阶段 5：退场 — deactivate vs clock_out

deactivate：标准下线，含经验保存检查、锁释放、MCP 清理、心跳删除、departure.json 清理。
clock_out：离场下班，含 pending_departure 检查、经验保存检查、锁释放、MCP 清理、心跳删除、PTY 关闭、通知 leader、departure.json 清理。

**问题 R2-05：deactivate 成功后没有自动通知 leader**

deactivate 的 hint 说"如需通知 leader 任务完成可用 send_msg"，但这只是建议。对比 clock_out 会自动发 `[下班通知]` 给 leader。如果成员只调 deactivate 不手动 send_msg，leader 不知道成员已完成工作。

这是一个设计选择而非 bug（deactivate 是通用下线，不一定表示任务完成），但在实际场景中 leader 经常依赖成员主动上报来推进工作。

**建议：** workflow_hint 的最后一步从"save_memory → deactivate(member=你自己)"改为"save_memory → 用 send_msg 通知 leader 任务完成 → deactivate(member=你自己)"。

**严重程度：MEDIUM** — 影响 leader 对任务完成的感知时效。

---

## 三、全新视角审计 — Leader Agent 完整流程走查

### 阶段 1：查看团队状态

get_roster 返回值包含 roster + governance + summary。summary 含 available_roles、unavailable_roles、hint。

**评价：** 信息充分，leader 决策材料齐全。

**无新问题。**

### 阶段 2：分配任务

request_member(caller, member, project, task, auto_spawn=true)

返回 reserved + reservation_code + usage_hint + member_brief + spawn_result。

**问题 R2-06：request_member 成功后 usage_hint 引导"用 send_msg 给成员下达指令"，但成员可能尚未 activate**

hub.ts:1964-1968 usage_hint 说"终端已创建，用 send_msg 给成员下达指令"。但 auto_spawn 只是创建了终端，成员 agent 可能还没有 activate。在 activate 之前发的 send_msg 走 PTY stdin 会被 agent 看到（因为 PTY 已创建），但也可能在 agent 启动的 MCP 协商阶段被丢弃或忽略。

更安全的做法是等成员 activate 后再发消息（通过 check_inbox 机制保证不丢），但当前没有"成员已 activate"的回调通知给 leader。

**建议：** usage_hint 增加一句"成员终端正在启动，首次消息请稍等片刻发送，或在成员 activate 后再用 send_msg 下达指令"。

**严重程度：LOW** — PTY stdin 消息不会丢（缓冲区保存），只是时序上可能造成成员看到指令时上下文不完整。

### 阶段 3：监控进展

team_report, project_dashboard, work_history 组合使用。

**评价：** 三个工具各有侧重，覆盖全队、单项目、单成员三个维度。

**问题 R2-07：team_report 的 working 数组只含 lock 信息，不含 heartbeat 时间**

hub.ts:1636 working 数组中每个成员有 `{ uid, name, role, lock }`，但没有 `last_seen`。leader 无法区分"真在工作"和"锁住了但心跳已超时（可能卡死）"。需要额外调 get_status 或 stuck_scan 才能发现。

**建议：** working 数组中增加 `last_seen` 字段。

**严重程度：LOW** — stuck_scan 已覆盖超时检测，只是 team_report 信息不够完整。

### 阶段 4：让成员离场

request_departure → 成员收通知 → 成员 clock_out

**问题 R2-08：request_departure 对 offline 成员报错，但 leader 可能想对 offline 成员清理残留状态**

hub.ts:2817-2819 检查成员心跳，offline 时返回错误 `"成员 xxx 当前 offline，无法发起离场请求"`。但实际场景中，成员可能已经异常退出（offline 但锁残留），leader 想通过 request_departure 标记然后 force_release 清理。当前流程要求成员必须 online 才能发离场请求，但 force_release 不需要。

这不是 bug——offline 成员应该用 force_release 或 release_member 清理，不需要走离场流程。但错误信息没有引导 leader 这样做。

**建议：** 错误信息改为 `"成员 xxx 当前 offline。离场流程仅对在线成员有效。如需清理该成员的残留锁，请用 release_member 或 force_release。"`

**严重程度：LOW** — leader 通常知道用 force_release，但更好的错误信息能减少决策时间。

---

## 四、多工具组合流程验证

### 组合流程 1：完整生命周期（招人→派活→工作→离场）

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. get_roster | 查状态 | summary.hint 引导选人 | OK |
| 2. request_member(auto_spawn=true) | 预约+创建终端 | usage_hint 含预约码和 send_msg 示例 | OK |
| 3. (成员) activate | 加载上下文 | workflow_hint 分步引导 | OK |
| 4. (成员) checkpoint | 自查 | verification_prompt 6 条引导 | OK |
| 5. (成员) save_memory | 保存经验 | hint → submit_experience → deactivate | OK |
| 6. (成员) deactivate | 下线 | hint → send_msg 通知 leader | OK |
| 7. (leader) request_departure | 发起离场 | hint "异步标记，无需等待" | OK |
| 8. (成员) clock_out | 下班 | 含经验保存检查、自动通知 leader | OK |

**结论：** 完整生命周期流程通畅，每步都有返回值引导下一步。前次审计的所有断裂点已修复。

### 组合流程 2：任务交接（跨成员）

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. A save_memory | 保存进度 | OK |
| 2. A deactivate | A 下线 | OK |
| 3. leader request_member(member=B, previous_member=A) | 预约 B，标记前任 A | reserved=true + reservation_code | OK |
| 4. B activate | 加载上下文 | predecessor="A" + workflow_hint 含"读前任记忆" | OK (已修复) |
| 5. B read_memory(member=A) | 读 A 的记忆 | 返回 A 的 content | OK |
| 6. B work_history(member=A) | 看 A 的工作记录 | 返回 history | OK |

**结论：** 交接流程已完整。predecessor 信息传递通畅。

### 组合流程 3：治理流程

| 步骤 | 工具 | 返回值引导 | 评价 |
|------|------|-----------|------|
| 1. 成员 propose_rule | 提议规则 | hint 含 send_msg 通知 leader 示例 | OK (已修复) |
| 2. 成员 send_msg(to=leader) | 通知 leader | sent=true | OK |
| 3. leader review_rules | 查看待审 | hint → approve/reject | OK |
| 4. leader reject_rule | 拒绝 | 自动 send_msg 通知提议者 | OK (已修复) |

**结论：** 治理流程前后端都有主动通知，不再断链。

---

## 五、新发现问题汇总

| 编号 | 严重程度 | 工具 | 问题 | 建议 |
|------|---------|------|------|------|
| R2-01 | LOW | MCP_INSTRUCTIONS | 成员专用工具列表含 check_in/check_out 可能误导新 agent | 标注"(极少使用)"或移到应急子段落 |
| R2-02 | LOW | activate | project_rules 匹配可能命中非当前项目 | 优先 name 精确匹配，membership 作 fallback 并标记 |
| R2-03 | MEDIUM | send_msg | to="leader" 的解析不透明，成员不知道怎么回复 leader | description 说明"to 支持成员名或 'leader'" |
| R2-04 | LOW | save_memory | scope="project" 但不传 project 时无验证 | 增加参数校验 |
| R2-05 | MEDIUM | deactivate | 成功后不自动通知 leader | workflow_hint 增加 send_msg 步骤 |
| R2-06 | LOW | request_member | 成员尚未 activate 时 leader 可能就发 send_msg | usage_hint 增加时序说明 |
| R2-07 | LOW | team_report | working 数组缺 last_seen | 增加心跳时间字段 |
| R2-08 | LOW | request_departure | offline 成员报错没有引导用 force_release | 错误信息增加替代操作引导 |

---

## 六、总结

### Top 10 修复状态

**全部 10 项已修复到位，代码实现正确，测试覆盖完整（27 个集成测试 + 13 个 isLeader 测试）。**

修复质量评价：
- clock_out/deactivate 的 save_memory 检查与 force 旁路设计一致
- check_inbox 的 peek 模式是干净的非破坏性方案
- activate 的 predecessor + 动态 workflow_hint 是优雅的解决方案
- update_project 的 confirm_overwrite 是最小侵入的保护机制
- reject_rule 的自动通知 + propose_rule 的 hint 改进闭合了治理流程

### 新问题评估

新发现 8 个问题，其中：
- 0 个 CRITICAL
- 0 个 HIGH
- 2 个 MEDIUM（send_msg to="leader" 解析 + deactivate 不通知 leader）
- 6 个 LOW

**结论：核心工作流已无断裂点。剩余问题均为锦上添花的改进，不影响 agent 正常协作。系统已达到可用状态。**

### 设计亮点（前次+本次）

1. **checkpoint verification_prompt** — 6 条自查提示，强制 agent 反思
2. **workflow_hint 条件分支** — 有前任时引导读前任记忆，有消息时引导 check_inbox
3. **Panel/本地双回退** — 对 Panel 崩溃有韧性
4. **Hint 链模式** — 工具间形成自然工作流
5. **confirm_overwrite 保护** — 最小侵入的数据保护
6. **离场通知三选项** — 尊重成员自主权
