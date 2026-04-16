# Agent UX 审计报告

> 审计人：体验官 (adian)
> 审计日期：2026-04-16
> 审计范围：packages/mcp-server/src/index.ts (MCP_INSTRUCTIONS)、hub.ts (42 个 MCP 工具)、member-store.ts (数据模型)

---

## 一、MCP_INSTRUCTIONS 系统提示词评估

### 整体评价

MCP_INSTRUCTIONS 共 46 行，结构清晰，覆盖了 Leader 用法、成员生命周期、离场流程、通信、治理、项目管理、MCP 代理、权限模型八大板块。作为 agent 启动时的"全局地图"，基本能让 agent 知道系统里有什么能力。

### 存在的问题

1. **缺少"我是谁"的判断引导**：agent 看到 MCP_INSTRUCTIONS 后不知道自己是 leader 还是成员。身份判断依赖 `CLAUDE_MEMBER` 环境变量（index.ts:106），但提示词没有告诉 agent 如何确认自己的角色。成员 agent 可能误调 leader 工具。

2. **成员生命周期过于简略**：`activate(reservation_code) -> 执行任务 -> checkpoint() -> save_memory() -> deactivate()` 只有一行。缺少关键信息：
   - reservation_code 从哪来？（应说明：spawn prompt 中获取）
   - activate 返回什么？返回值里有 workflow_hint 引导后续步骤，但提示词没提
   - checkpoint 什么时候调？为什么调？

3. **通信模型不完整**：
   - `send_msg(to, content)` 的 `to` 填什么？成员名？uid？提示词没说
   - `check_inbox(member)` 暗示轮询模型，但 send_msg 实际走 PTY stdin 推送。agent 不知道该主动查还是被动收

4. **MCP 代理部分过于抽象**：`install_store_mcp -> mount_mcp -> proxy_tool` 这个链条没有说清 uid 从哪来，mount 前需要什么前置条件

5. **权限模型列表不完整**：权限列表缺少 `cancel_reservation`、`handoff`、`scan_agent_clis`、`spawn_pty_session`、`list_pty_sessions`、`kill_pty_session` 等工具的权限归属

6. **缺少错误恢复引导**：没有告诉 agent 遇到常见错误（预约过期、权限不足、成员忙碌）时该怎么办

### 改进建议

- 在开头增加角色判断段落："如果你是成员（有 CLAUDE_MEMBER 环境变量），你的 spawn prompt 中有 reservation_code，第一步调 activate"
- 成员生命周期展开为 5 步带说明的列表
- 通信部分说明推送 vs 轮询的关系
- 增加"常见错误与恢复"小节

---

## 二、工具逐一审计

### 状态管理类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| check_in | 成员 | 好。说明了"仅切换项目/任务时手动调用" | 好 | 好。hint 引导 save_memory -> deactivate | 好。锁被占用时有清晰的引导 | 无重大问题 | - |
| check_out | 成员 | 好。明确说是"应急手段" | 好 | 好。建议改用 deactivate | 好。未保存经验有拦截 | description 说"底层释放工具"但未说与 deactivate 的区别在哪 | 补充一句"区别：deactivate 含心跳清理和 MCP 清理，check_out 仅释放锁" |
| get_status | 所有 | 好 | 好。member 可选 | 好 | 无特殊错误 | 返回值缺少 hint（其他工具都有） | 补充 hint |
| force_release | leader | 好。说明了场景：stuck_scan 后使用 | 好 | 好。hint 引导重新分配 | 权限校验清晰 | 无 | - |

### 记忆类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| save_memory | 成员 | 好 | scope 的 enum 清晰，project 条件说明有 | 好。hint 引导 submit_experience -> deactivate | 未激活拦截明确 | scope 是 required 但 description 没说默认值 | 参数 description 增加"通常选 generic" |
| read_memory | 成员 | 好 | 好 | 无 hint | 无特殊 | scope 非必填但 description 没说默认行为 | 返回值加 hint |
| submit_experience | 成员 | 好。说明了"每次有教训时调用" | 好 | 有重复检测警告 | 未激活拦截 | scope=team 会"进入规则审批流程"但未在返回值中体现 | 返回值增加 `{ queued_for_approval: true }` |
| read_shared | 所有 | 好 | type 的 enum 清晰 | 无 hint | 无 | 返回值只有 content 字符串，agent 不知道格式 | 增加 format 说明或 hint |
| search_experience | 所有 | 好 | 好 | 空结果有 hint | 无 | 返回值 results 的结构未在 description 中说明 | 说明 results 是字符串数组 |

### 制度类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| propose_rule | 成员 | 好 | 好 | hint 说"通知 leader 调 review_rules" | 无特殊 | **关键缺陷：提议者怎么通知 leader？应该说"用 send_msg 通知 leader"** | hint 改为"用 send_msg(to=leader, content='有新规则待审') 通知 leader" |
| review_rules | leader | 好 | 无参数 | 好。引导逐条审批 | 无 | 无 | - |
| approve_rule | leader | 好 | rule_id 需要从 review_rules 获取，未说明 | 好 | 权限校验 | rule_id 来源不够显式 | description 补充"rule_id 从 review_rules 返回值获取" |
| reject_rule | leader | 好。"拒绝后提议者会在下次 read_shared 时看到" | 好 | 好 | 权限校验 | **被拒绝的规则存在哪？提议者怎么知道被拒了？** 需要主动查 read_shared(pending_rules)，无推送通知 | 拒绝时也应通过 send_msg 通知提议者 |

### 招募类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| hire_temp | leader | 好 | 好 | 好。hint 引导完整流程 | 权限校验 | 无 | - |
| evaluate_temp | leader | 好 | score 1-10 清晰 | 好 | 权限校验 | convert_to_permanent 默认值未说 | 补充默认 false |
| list_templates | 所有 | 好 | 无参数 | 空结果有 hint | 无 | 无 | - |

### 看板类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| team_report | 所有 | 好。说了派发后和验收前各调一次 | 无参数 | 好 | 无 | 无 | - |
| project_dashboard | 所有 | 好 | 好 | 好 | 无 | 无 | - |
| work_history | 所有 | 好 | 好 | 无 hint | 成员不存在时无特殊错误 | 返回空数组时 agent 不知道是成员没干活还是写错名字 | 增加成员不存在检查 |
| stuck_scan | leader | 好。引导操作链 | 好 | 好。action_hint 引导催促 -> 强释放 -> 重分配 | 无 | 无 | - |
| handoff | 成员 | 好 | 好 | 好。提示接收方需 activate | from 未 checked in 有错误 | **from 和 to 谁填？成员能给自己 handoff 吗？leader 能发起 handoff 吗？** | description 说明调用者身份和限制 |

### 人事管理类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| request_member | leader | 好。返回值结构详细 | 好。auto_spawn 和 workspace_path 说明清晰 | 好。usage_hint 包含预约码和后续操作 | 成员不存在、已有锁、已有预约都有处理 | **成员忙碌时只返回 reason，没有引导 agent 选别人或等待** | 增加 `alternative_hint: "可选空闲成员：..."` |
| cancel_reservation | leader | 好 | 好 | 好 | 预约码不存在有处理 | 无 | - |
| activate | 成员 | 好。description 详细列出返回内容 | 好 | **优秀。workflow_hint 是亮点，7 步引导** | 预约码不匹配、过期、无预约都有明确错误 | 无重大问题 | - |
| deactivate | 成员 | 好 | 好 | hint 引导通知 leader | 未激活拦截、未保存经验拦截 | 无 | - |
| release_member | leader | 好。与 force_release 区分清晰 | 好 | 好 | 权限校验、成员未持锁有检查 | 无 | - |

### 团队治理查询

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| get_roster | 所有 | 好 | 无参数 | **优秀。summary 含 available_roles、unavailable_roles、hint** | 无 | 返回 governance 数据可能过大 | - |
| get_team_rules | 所有 | 好 | 无参数 | 含 acceptance_chain | 无 | 无 | - |

### MCP 代理类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| proxy_tool | 成员 | 好。说明了 uid 来源 | 好 | 无 hint | UID 不存在有错误 | **错误信息 `UID xxx 不存在` 太简短，agent 不知道如何获取正确 uid** | 错误增加 "请通过 get_roster 或 activate 返回值获取 uid" |
| list_member_mcps | 成员 | 好 | uid 来源说明清晰 | 好 | UID 不存在有错误 | 无 | - |
| install_member_mcp | leader | 好 | 好 | 无 hint | 权限校验 | 返回值没有引导下一步 | 增加 hint |
| uninstall_member_mcp | leader | 好 | 好 | 好 | 权限校验 | 无 | - |
| proxy_status | leader | 好 | 无参数 | 无 hint | 无 | 返回值结构不明 | 增加返回值说明 |
| cleanup_member_mcps | leader | 好 | 好 | 好 | 权限校验 | 无 | - |

### MCP 商店类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| install_store_mcp | leader | 好 | 好 | 返回 store 全量列表 | 权限校验 | 无 | - |
| uninstall_store_mcp | leader | 好。说明了已挂载成员的清理时机 | 好 | 好 | 权限校验 | 无 | - |
| list_store_mcps | 所有 | 好 | 无参数 | 无 hint | 无 | 空商店时无引导 | 增加空结果 hint |
| mount_mcp | 成员 | 好 | uid 来源清晰 | 好。返回子工具列表 | 无 | **如果 mcp_name 不在商店中，错误信息是什么？** 代码中走 mountMcp 但未见具体错误 | 确保有明确的"该 MCP 不在商店中"错误 |
| unmount_mcp | 成员 | 好。说了 deactivate 自动清理 | 好 | 好 | 无 | 无 | - |

### 项目管理类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| create_project | leader | 好 | 好 | hint 引导设规则 | 权限校验 | 无 | - |
| get_project | 所有 | 好 | 好 | 返回全量项目数据 | 项目不存在有检查 | 无 | - |
| list_projects | 所有 | 好。引导检查是否有相似项目 | 无参数 | hint 含活跃计数 | 无 | 无 | - |
| update_project | leader | 好 | members 是全量替换，description 说了 | 返回更新后项目 | 项目不存在 | **members 全量替换容易误操作（agent 可能只想加一个人却覆盖了全部）** | 增加 add_member / remove_member 或在 description 中强调 |
| add_project_experience | 成员 | 好 | 好 | 好 | 项目不存在 | 无 | - |
| add_project_rule | leader | 好 | type enum 清晰 | 好 | 项目不存在 | 无 | - |
| get_project_rules | 所有 | 好 | 好 | 好 | 项目不存在 | 无 | - |
| checkpoint | 成员 | 好 | progress_summary 可选 | **优秀。verification_prompt 6 条自查引导** | 未激活和无锁都有检查 | 无 | - |
| delete_project | leader | 好。说明了不可恢复 | 好 | 好 | 权限校验 + 项目不存在 | 无 | - |

### Agent CLI / PTY 类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| scan_agent_clis | leader/Panel | 好 | 无参数 | 返回 found + not_found | Panel 通信失败有报错 | 无 | - |
| spawn_pty_session | Panel 内部 | 说了"一般通过 request_member 间接触发" | 好 | 返回 session_id | Panel 通信失败 | 无 | - |
| list_pty_sessions | leader/Panel | 好 | 无参数 | 返回值结构说了 | Panel 通信失败 | 无 | - |
| kill_pty_session | leader | 好 | session_id 需要来源未说 | 好 | Panel 通信失败 | session_id 从哪来？ | description 补充"session_id 从 list_pty_sessions 获取" |

### 消息类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| send_msg | 所有 | 好 | to 和 content 必填，priority 可选 | 返回 sent + delivery | **Panel 通信失败是唯一错误**，但 to 目标不存在时的错误由 Panel 返回，Hub 只透传 | **to 填什么？名字？uid？description 说"目标成员名"但实际 Panel 端做名字解析**。如果 to 写错名字，错误来自 Panel 还是 Hub？ | 增加示例和错误说明 |
| check_inbox | 成员 | 好 | 好 | 返回 messages 数组 | Panel 通信失败 | **消息投递模型混乱：send_msg 走 PTY stdin 推送，check_inbox 读什么？** 实际 check_inbox 用 DELETE 方法消费消息队列，但描述说的是"查看"，给人感觉是只读的 | 1. 描述改为"消费收件箱消息（读后清空）"<br>2. 说明 send_msg 同时推送到 PTY 和消息队列 |

### 离场类

| 工具名 | 角色 | 场景引导 | 参数清晰度 | 返回值引导 | 错误处理 | 问题 | 建议 |
|--------|------|---------|-----------|-----------|---------|------|------|
| request_departure | leader | 好。pending=true/false 双向 | 好 | hint 说"异步标记，无需等待" | 多重校验：权限、成员存在、online 状态 | 无重大问题 | - |
| clock_out | 成员 | 好 | 好 | hint 列出完整下班流程 | **丰富的校验**：leader不能调、只能自己下班、必须有 pending_departure | **clock_out 前没有提示成员先 save_memory** | 增加经验保存检查或在 description 中强调"clock_out 前建议先 save_memory" |

---

## 三、场景走查

### 场景 1：新成员入职

**步骤 1：Leader 收到用户指令"招一个前端"**

Leader agent 看到 MCP_INSTRUCTIONS，知道：
1. `get_roster()` 查花名册 -- OK
2. `hire_temp(caller, name, role)` 创建临时成员 -- OK
3. `request_member(caller, member, project, task, auto_spawn=true)` 预约 -- OK

**卡点：** hire_temp 的 `name` 参数描述是"成员名（汉字）"，但没说命名规范。agent 可能取 "前端小王" 或 "frontend-1"，后续 request_member 要精确匹配。

**步骤 2：成员 agent 启动**

auto_spawn=true 时，Panel 创建终端窗口，成员 agent 启动。成员看到的上下文：
- spawn prompt 中应该有 reservation_code（由 Panel 注入）
- MCP_INSTRUCTIONS 告诉成员"activate(reservation_code) -> 执行任务 -> ..."

**卡点 A：spawn prompt 内容由 Panel 控制，不在当前审计范围内。但 MCP_INSTRUCTIONS 没有说"你的 reservation_code 在 spawn prompt 中"。如果成员 agent 找不到 reservation_code，它不知道去哪里取。**

**卡点 B：reservation_code 在 activate 的 description 中说"推荐必填"而非"必填"。agent 可能选择不传，走向后兼容流程。但向后兼容流程要求"已持有正式锁"，新成员没有锁，会报错 `"需要预约码或已有工作锁"`。错误信息清晰，但本可避免。**

**步骤 3：成员调 activate**

activate 返回值包含 persona、memory、task、rules、workflow_hint。workflow_hint 是 7 步引导，非常清晰。

**评价：** 整体流程通畅，主要风险在 spawn prompt 与 MCP_INSTRUCTIONS 之间的信息衔接。

---

### 场景 2：日常协作

**步骤 1：成员 A 需要和成员 B 协作**

A 怎么知道 B 的信息？
- activate 返回值含 `project_members`（同项目其他成员名单） -- OK
- 如需更详细信息，调 `get_roster()` 或 `project_dashboard(project)` -- OK

**步骤 2：A 给 B 发消息**

`send_msg(to="B的名字", content="消息内容")` -- OK

**卡点 A：send_msg 的 from 是自动推断的（hub.ts:2668-2673），成员不需要填。但 description 中没有任何提及 from 参数的存在或不存在。如果 agent 尝试传 from 参数，会被忽略但不报错——这是好事，但不透明。**

**步骤 3：B 怎么收到消息？**

send_msg 走 PTY stdin 推送，消息直接写入 B 的终端。B 被动收到。

**卡点 B：MCP_INSTRUCTIONS 的通信部分只说了 `send_msg` 和 `check_inbox`，没说 send_msg 是推送式的。agent 可能以为需要 B 主动调 check_inbox 才能收到。实际上两个机制并存：PTY 推送 + 消息队列存储。但这个双通道模型在提示词中完全没有说明。**

**步骤 4：B 回复**

B 收到消息后，用 `send_msg(to="A的名字", content="回复")` -- OK

**步骤 5：发送失败**

如果目标不存在，错误来自 Panel（Hub 透传），错误信息格式：`{ error: "Panel 通信失败: ..." }`。这个信息不够具体，agent 不知道是网络问题还是名字写错了。

---

### 场景 3：任务完成离场

**步骤 1：Leader 要让败者下线**

Leader 需要知道调 `request_departure(member="败者名")`。

**卡点：MCP_INSTRUCTIONS 的"离场流程"部分写了 `request_departure(member)`，但没有说这个工具只对 online 成员有效。如果目标 offline，返回错误 `"成员 xxx 当前 offline，无法发起离场请求"`——错误信息清晰。**

**步骤 2：成员收到离场通知**

request_departure 通过 send_msg 发送格式化通知，内容包含：
- 离场原因
- 三种行为选项（不同意/需要收尾/直接同意）
- 明确指引调 `clock_out(member=自己)`

**评价：** 这部分设计得很好，通知内容本身就是行为引导。

**步骤 3：成员收尾后下班**

**卡点 A：clock_out 前没有自动检查 save_memory。** 对比 deactivate 有 `if (!hasMemorySaved(member) && !force)` 检查，clock_out 完全没有。成员可能忘记保存经验就直接 clock_out，导致经验丢失。

**卡点 B：clock_out 的 description 没说"建议先 save_memory"。** activate 返回的 workflow_hint 最后一步是 "save_memory -> deactivate"，但离场流程走的是 clock_out 不是 deactivate，workflow_hint 的引导不覆盖离场场景。

**步骤 4：成员主动想下班（没有 request_departure）**

成员直接调 clock_out → 返回 `"你未被批准离场，不能擅自下班"` -- 清晰明确。

成员改用 deactivate → 正常执行，释放锁但不通知 leader -- **问题：成员可以绕过离场审批直接 deactivate 下线。** deactivate 不检查 pending_departure 状态，也不检查是否由 leader 批准。

---

### 场景 4：错误恢复

**4.1 成员调了 leader 工具**

成员调 `force_release` → `checkPrivilege` 抛出 `"caller 'xxx' does not have permission to force_release"` -- 信息清晰但没有告诉成员该找谁。

**建议：** 错误改为 `"caller 'xxx' 没有 force_release 权限。请联系 leader（通过 send_msg）申请操作。"`

**4.2 成员忘了 activate 就直接 check_in**

check_in 不检查 activate 状态，会直接执行。这不会报错，但会导致：
- 心跳不会被正确记录
- session 的 activatedMembers 没有该成员
- 后续 save_memory 会报 `"成员 xxx 未激活，请先调用 activate"`

**问题：** 错误在 save_memory 时才暴露，不在 check_in 时。agent 可能已经干了一堆活，到最后才发现流程不对。

**建议：** check_in 增加 `isActivated(member)` 检查，未激活时返回 `"请先调用 activate 激活记忆工作区，再 check_in"`

**4.3 消息发给不存在的成员**

send_msg 的 to 解析由 Panel 完成。如果 Panel 返回错误，Hub 透传 `{ error: "Panel 通信失败: xxx" }`。错误信息不够结构化，agent 难以判断是网络问题还是成员名错误。

**建议：** 区分 Panel 网络错误和业务错误，业务错误直接透传 Panel 的具体信息

**4.4 reservation 过期了成员才启动**

activate 检查预约过期 → 返回 `"预约已过期，请重新调用 request_member 申请"` -- 问题是成员自己不能调 request_member，这个引导是给 leader 看的，但成员收到这个错误后不知道该通知谁。

**建议：** 改为 `"预约已过期。请通知 leader（通过对话或其他方式）重新调用 request_member 为你申请预约。"`

---

### 场景 5：团队治理

**步骤 1：成员提议规则**

`propose_rule(member="xxx", rule="...", reason="...")` → 返回 `{ hint: "→ 规则已进入待审队列。请通知 leader 调 review_rules 查看并审批" }`

**卡点：** hint 说"请通知 leader"但没说怎么通知。agent 应该用 `send_msg(to=leader名字, content="有新规则待审")` 但 leader 的名字是什么？agent 不知道。

**建议：** hint 改为包含具体调用示例

**步骤 2：Leader 审批**

`review_rules()` → 返回待审规则列表 + hint 引导逐条审批 -- OK

`approve_rule(caller, rule_id)` → OK，rule_id 来自 review_rules 返回值

**步骤 3：规则被拒绝**

`reject_rule(caller, rule_id, reason)` → hint 说"继续 review_rules 查看剩余待审规则"

**卡点：** 提议者怎么知道被拒了？description 说"提议者会在下次 read_shared(pending_rules) 时看到"，但没有主动通知。如果提议者不主动查，永远不知道。

**建议：** reject_rule 实现中增加 send_msg 通知提议者

---

### 场景 6：多工具组合流程（跨角色工具链）

以下是 6 个必须由多个 agent、多步调用才能完成的组合流程。每步标注：
- ✅ 提示词引导顺畅，agent 能自主完成
- ⚠️ 提示词有引导但不够清晰，agent 可能走岔
- ❌ 提示词完全没引导，agent 不知道下一步

---

#### 组合流程 1：招聘 -> 上岗

完整链路：`hire_temp` -> `request_member` -> (成员) `activate` -> 执行任务

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. 创建临时成员 | leader | `hire_temp(caller, name, role)` | hire_temp 返回 hint: `"→ 临时成员已创建。下一步：request_member(member='前端') 预约 → spawn Agent → 成员 activate 开工"` | ✅ 引导明确，含具体参数示例 |
| 2. 预约成员 | leader | `request_member(caller, member, project, task, auto_spawn=true)` | request_member 返回 usage_hint 包含预约码和后续操作：`"→ 终端已创建，用 send_msg 给成员下达指令"` | ✅ 引导清晰 |
| 3. leader 等待成员上线 | leader | 无需操作 | usage_hint 说"终端已创建"，暗示成员会自动启动。但**没有明确说"成员会自己调 activate，你不用管"**。leader 可能试图代替成员调 activate | ⚠️ 缺少"等待成员自行 activate"的显式引导 |
| 4. 成员启动并 activate | 成员 | `activate(member, reservation_code)` | MCP_INSTRUCTIONS 的"成员生命周期"写了 `activate(reservation_code)`。activate description 说"被 spawn 后第一件事调此工具"。**但 reservation_code 从哪来？** MCP_INSTRUCTIONS 没说在 spawn prompt 中。activate description 说"推荐必填"而非"必填" | ⚠️ reservation_code 来源不够显式 |
| 5. 成员是否需要 check_in？ | 成员 | 不需要 | activate 内部自动执行 check_in（获取锁 + 写 worklog），workflow_hint 不含 check_in 步骤。check_in description 也说"activate 已自动签入" | ✅ 明确说了不需要 |

**总结：** 招聘上岗链路基本通畅。主要卡点在步骤 3（leader 不知道等待）和步骤 4（reservation_code 来源不显式）。agent 不太可能完全走不通，但可能多走弯路。

---

#### 组合流程 2：离场（最关键）

完整链路：leader `request_departure` -> 成员收通知 -> 成员 `save_memory` -> 成员 `clock_out`

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. leader 决定让成员离场 | leader | `request_departure(member)` | MCP_INSTRUCTIONS"离场流程"段落：`"leader: request_departure(member) → 成员收到通知 → 成员收尾 → clock_out"`。**但什么时候该发 request_departure？** 没有任何工具返回值引导"任务完成了，该让成员下线了"。team_report 只显示谁在工作，不引导离场 | ⚠️ 无"任务完成 → 该离场"的触发引导 |
| 2. 成员收到离场通知 | 成员 | 被动接收（PTY stdin） | request_departure 发送的通知内容非常详细：含离场原因、三种行为选项（不同意/需收尾/直接同意）、明确指引调 clock_out | ✅ 通知内容就是行为引导 |
| 3. 成员不想走（正在干活） | 成员 | `send_msg(to=leader, content="理由")` | 通知内容明确说"如果你不同意，请用 send_msg 回复 leader 简短原因" | ✅ 协商路径清晰 |
| 4. 成员同意，先保存经验 | 成员 | `save_memory(member, scope, content)` | **通知内容没有提及 save_memory。** 通知说"收尾后调 clock_out"，但收尾该包含什么？clock_out description 也没说"建议先 save_memory"。只有 activate 的 workflow_hint 提到 save_memory，但那是给正常下线（deactivate）路径写的 | ❌ 离场路径完全没有 save_memory 引导 |
| 5. 成员下班 | 成员 | `clock_out(member)` | clock_out description："只有被 leader 标记为 pending_departure 的成员才能调用"。代码中 **不检查 save_memory**（对比 deactivate 有检查） | ⚠️ 无经验保存拦截，数据丢失风险 |
| 6. leader 收到下班通知 | leader | 被动接收 | clock_out 实现中通过 send_msg 通知 leader：`"[下班通知] xxx 已完成收尾并下班"`。但 **leader 怎么知道成员已经 clock_out？** leader 不主动查时只能被动等 PTY 推送 | ✅ 有推送通知 |

**兜底分析：成员没收到通知怎么办？**

send_msg 走 PTY stdin 推送。如果成员终端繁忙（正在处理长任务），消息会排在 stdin 缓冲区等待处理，不会丢。但如果 PTY 连接断了（Panel 重启等），消息同时存在消息队列中，成员可通过 check_inbox 补查。**但没有提示词告诉成员"如果你觉得有消息可能漏了，调 check_inbox 补查"。**

**绕过风险：** 成员可以无视 request_departure，直接调 deactivate 走人。deactivate 不检查 pending_departure 状态，正常执行。departure.json 残留在磁盘上。leader 那边看到的状态可能不一致。

**总结：** 离场流程前半段（通知+协商）设计优秀，后半段（保存+下班）有显著缺陷。最大的问题是 clock_out 路径不引导也不拦截 save_memory。

---

#### 组合流程 3：消息-回复闭环

完整链路：`send_msg` -> (对方) 收到 -> `send_msg` 回复

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. A 发消息 | A | `send_msg(to="B", content="请协助 xxx")` | send_msg description 清晰。返回 `{ sent: boolean, delivery?: string }` | ✅ 发送方清楚 |
| 2. A 知道 B 收到了吗？ | A | 无确认机制 | send_msg 返回 `sent: true` 只表示消息投递到 Panel，**不表示 B 已读**。没有已读回执、没有投递确认。agent 不知道消息是否到达 | ❌ 无投递确认，无已读回执 |
| 3. B 收到消息 | B | 被动（PTY stdin） | 消息推送到 B 的终端 stdin。B 作为 AI agent 会在下次处理输入时看到。**但消息格式是什么？B 能区分"来自其他 agent 的消息"和"系统通知"吗？** 这取决于 Panel 的推送格式，不在审计范围但影响 agent 理解 | ⚠️ 推送格式不确定 |
| 4. B 看到后回复 | B | `send_msg(to="A", content="已协助")` | 没有任何提示词引导 B "你应该回复"。消息到了 stdin 就到了，B 要自己判断是否需要回复 | ⚠️ 无回复引导 |
| 5. urgent 消息有区别吗？ | B | 无 | send_msg 支持 `priority: "urgent"` 参数。但 **urgent 和 normal 在接收端行为完全没有区别**：都是写入 PTY stdin，没有弹窗/置顶/重复推送等特殊处理。check_inbox 返回值含 priority 字段，但 agent 怎么据此改变行为？ | ❌ urgent 语义空心化 |
| 6. 发送失败恢复 | A | 重试或换渠道 | 错误信息 `"Panel 通信失败: xxx"` 不区分网络错误和业务错误（如目标不存在） | ⚠️ 错误不可操作 |

**总结：** 消息发送能力本身 OK，但作为协作通信系统缺三样东西：投递确认、回复引导、urgent 差异化行为。这会导致 agent 间协作效率低——发了消息不知道对方收没收到，只能盲等。

---

#### 组合流程 4：治理全流程

完整链路：`propose_rule` -> (leader) `review_rules` -> `approve_rule`/`reject_rule` -> (提议者收到结果)

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. 成员提议规则 | 成员 | `propose_rule(member, rule, reason)` | 返回 hint: `"→ 规则已进入待审队列。请通知 leader 调 review_rules 查看并审批"` | ⚠️ "请通知 leader"但怎么通知？leader 叫什么名字？应用 send_msg 但没说 |
| 2. leader 得知有规则待审 | leader | 需成员主动通知 | **没有自动通知机制。** leader 不会自动知道有新规则。如果成员 propose_rule 后不发 send_msg 通知 leader，规则永远卡在待审 | ❌ 无通知 leader 的自动机制 |
| 3. leader 查看待审规则 | leader | `review_rules()` | 返回待审列表 + hint: `"→ 逐条 approve_rule(rule_id) 或 reject_rule(rule_id, reason) 处理"` | ✅ 清晰引导 |
| 4. leader 批准 | leader | `approve_rule(caller, rule_id)` | 返回 hint: `"→ 继续 review_rules 查看剩余待审规则"` | ✅ 有循环引导 |
| 5. leader 拒绝 | leader | `reject_rule(caller, rule_id, reason)` | 返回 hint: `"→ 继续 review_rules 查看剩余待审规则"` | ✅ 有循环引导 |
| 6. 提议者知道结果 | 提议者 | 需主动查询 | **没有通知机制。** 批准后"所有成员下次 activate 时自动获取"（approve_rule description），但提议者不会重新 activate。拒绝后"提议者会在下次 read_shared(pending_rules) 时看到"（reject_rule description），但提议者不会主动查 | ❌ 无结果反馈机制 |

**总结：** 治理流程的中间段（leader 审批）清晰，但前后两端（通知 leader、通知提议者）都没有主动推送。整个流程依赖 agent 主动轮询或手动 send_msg，很容易断链。

---

#### 组合流程 5：MCP 工具链

完整链路：`install_store_mcp` -> (成员) `mount_mcp` -> `proxy_tool`

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. leader 安装 MCP 到商店 | leader | `install_store_mcp(caller, mcp_name, command, args)` | 返回 `{ success: true, mcp: config, store: [...] }`。**但没有 hint 引导下一步。** 成员怎么知道商店里有新东西？没有通知机制 | ⚠️ 无 hint，无成员通知 |
| 2. 成员知道要 mount | 成员 | `list_member_mcps(uid)` -> `mount_mcp(uid, mcp_name)` | list_member_mcps description: `"成员 activate 后查看自己可用的工具集，按需 mount_mcp 挂载"` | ⚠️ 有引导但时机不对——成员 activate 时没有自动提示"你有可 mount 的 MCP"，需自己主动调 list_member_mcps |
| 3. 成员挂载 | 成员 | `mount_mcp(uid, mcp_name)` | mount_mcp description: `"挂载后用 proxy_tool 调用其中的工具"` + 返回值含 tools 列表（名称+参数 schema） | ✅ 清晰 |
| 4. 成员调用工具 | 成员 | `proxy_tool(uid, mcp_name, tool_name, arguments)` | proxy_tool description: `"调用前先 list_member_mcps 查看已挂载 MCP 的可用工具名和参数 schema"` | ✅ 有前置查询引导 |
| 5. 错误：mount 了不存在的 MCP | 成员 | `mount_mcp(uid, "不存在")` | mountMcp 返回 `{ success: false, error: 'MCP "不存在" 不在团队商店中' }` | ✅ 错误信息清晰，直接说"不在商店中" |
| 6. uid 从哪来？ | 成员 | 需要知道 | proxy_tool、list_member_mcps、mount_mcp 都需要 uid。description 统一说"uid 从 activate 返回值的 identity.uid 获取，或从 get_roster 返回的 roster[].uid 获取" | ✅ 来源说明一致 |

**总结：** MCP 工具链本身能走通，但缺少"商店有更新 → 通知成员"的推送环节。成员需要主动 list_member_mcps 才能发现新工具。对于 leader 主动为成员安装的场景（install_member_mcp），可以通过 send_msg 告知成员，但没有自动提示。

---

#### 组合流程 6：任务交接（中途换人）

完整链路：A `save_memory` -> A 离场 -> leader `request_member` 给 B -> B `activate` -> B `read_memory` 接上

这个流程有两条路径：

**路径 A：通过 handoff 工具（同 session 内）**

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. A 保存进度 | A | `save_memory(member="A", scope, content)` | workflow_hint 步骤 7 说"全部完成后 save_memory" | ✅ |
| 2. 交接给 B | A 或 leader | `handoff(from="A", to="B")` | handoff description: `"自动释放 from 的锁并为 to 获取正式锁。交接后建议用 send_msg 通知接收方"` + 返回 hint 说明 B 需调 activate | ✅ 引导清晰 |
| 3. B activate | B | `activate(member="B")` | handoff 在 PTY 推送中告知 B `"请调用 activate 加载上下文后继续工作"`。activate description 说"无需 reservation_code，handoff 已自动转移正式锁" | ✅ |
| 4. B 读取 A 的记忆 | B | `read_memory(member="B")` 或 `read_memory(member="A")` | **B 怎么知道要读 A 的记忆？** activate 返回的 memory_project 是 B 自己的项目记忆，不是 A 的。如果 B 想看 A 留下的工作笔记，需要知道调 `read_memory(member="A")`。但 **没有任何提示词说 B 可以/应该读 A 的记忆** | ❌ 无"读前任记忆"引导 |

**路径 B：通过离场+重新分配（跨 session）**

| 步骤 | 调用方 | 工具调用 | 提示词引导 | 评价 |
|------|-------|---------|-----------|------|
| 1. A save_memory | A | `save_memory(...)` | ✅ |
| 2. A 离场 | leader+A | `request_departure` → A `clock_out` | ⚠️ clock_out 不引导 save_memory |
| 3. leader 分配给 B | leader | `request_member(caller, member="B", project, task)` | ✅ |
| 4. B activate | B | `activate(member="B", reservation_code=...)` | ✅ |
| 5. B 接续 A 的工作 | B | ? | **完全没有引导。** B 的 activate 返回的是 B 自己的记忆和项目信息。B 不知道这个任务之前是 A 在做、做到了哪里、A 有什么笔记。没有任何工具或提示词引导 B 去查 A 的记忆或工作历史 | ❌ 完全无交接上下文传递 |

**关键缺陷分析：**

交接场景中最大的问题是 **接班人不知道前任的存在和进度**。handoff 路径至少有 PTY 通知说明交接来源，但跨 session 路径完全没有。

可能的改进方向：
1. `request_member` 增加可选的 `previous_member` 参数，记录前任
2. `activate` 返回值增加 `handoff_from` 字段（如果是交接任务）
3. `activate` 的 workflow_hint 增加条件步骤："如果你是接续别人的任务，调 `work_history(member=前任)` 和 `read_memory(member=前任)` 了解进度"

---

## 四、异步通信卡点

| 场景 | 等待方 | 被等待方 | 超时处理 | 卡点风险 | 建议 |
|------|-------|---------|---------|---------|------|
| request_departure 后等 clock_out | leader | 成员 | **无超时机制** | 成员可能卡死或忽略通知，leader 无限等待 | 增加 departure_timeout，超时后 leader 自动收到提示可 force_release |
| request_member 后等 activate | leader | 成员 | 预约 3m30s TTL 自动过期释放 | 低风险，有自动清理 | OK |
| handoff 后等接收方 activate | 交出方 | 接收方 | **无超时机制**，锁已转移到接收方 | 锁被转移但接收方可能不 activate，锁永远被占 | handoff 应创建类似 reservation 的 TTL 机制 |
| propose_rule 后等 leader 审批 | 提议者 | leader | **无超时机制** | 规则可能永远卡在待审队列 | 低优先级，可接受 |
| send_msg 后等回复 | 发送方 | 接收方 | **无超时机制** | 消息可能被忽略 | 低优先级，可接受 |
| 成员 deactivate 绕过 request_departure | leader | 成员 | 无感知机制 | leader 发了 request_departure，成员直接 deactivate 走人，departure 文件残留 | deactivate 时检查并清理 departure 状态 |

### 多 agent 并发冲突

| 场景 | 冲突类型 | 现有保护 | 风险 | 建议 |
|------|---------|---------|------|------|
| 两个 leader session 同时 request_member 同一成员 | 预约竞争 | reservation 文件写入非原子，后写覆盖先写 | 两个 session 都拿到"成功"但预约码不同，只有后写的有效 | 使用原子写入或 CAS 机制 |
| leader force_release 同时成员 deactivate | 锁释放竞争 | nonce 校验 | 低风险，nonce 不匹配时释放失败但不会数据损坏 | OK |
| 两个成员同时 handoff 到同一目标 | 锁获取竞争 | acquireLock 原子性依赖文件锁实现 | 需确认 lock-manager 的原子性 | 检查 lock-manager 实现 |

---

## 五、错误提示改进清单

| 工具 | 错误场景 | 当前错误信息 | 问题 | 建议改进 |
|------|---------|------------|------|---------|
| activate | 预约过期 | "预约已过期，请重新调用 request_member 申请" | 成员自己不能调 request_member | "预约已过期。请通知 leader 重新为你申请（leader 调 request_member）" |
| activate | 无预约码且无锁 | "需要预约码或已有工作锁。请先通过 request_member 申请并传入 reservation_code。" | 成员不知道找谁 | "需要预约码。你的 spawn 提示中应该有 reservation_code，如果找不到，请通知 leader 重新 request_member" |
| checkPrivilege | 权限不足 | "caller 'xxx' does not have permission to yyy" | 不知道谁有权限 | "caller 'xxx' 没有 yyy 权限。这是 leader 专用操作，请用 send_msg 联系 leader。" |
| proxy_tool | UID 不存在 | "UID xxx 不存在" | 不知道正确 uid 怎么获取 | "UID xxx 不存在。请通过 get_roster 查看成员 uid，或从 activate 返回值的 identity.uid 获取。" |
| send_msg | Panel 通信失败 | "Panel 通信失败: xxx" | 不知道是名字错还是网络问题 | 区分业务错误和网络错误，分别给出恢复建议 |
| clock_out | 未被批准离场 | "你未被批准离场，不能擅自下班" | 不知道正常下线该用什么 | "你未被 leader 批准离场。如需正常下线请用 deactivate；如需请假请用 send_msg 联系 leader。" |
| clock_out | leader 调用 | "leader 由用户控制，不能自行下班" | 信息不可操作 | OK，这个错误是防御性的，不需要恢复路径 |
| check_out | 未保存经验 | "请先调用 save_memory 保存本次工作经验，再 check_out。如确实无经验可存，传 force=true 跳过。" | 信息清晰，无问题 | OK |
| handoff | from 未 checked in | "xxx is not checked in" | 不知道 from 应该怎么 check in | "xxx 没有工作锁（未 check_in 或已 check_out）。请确认 from 成员当前正在工作中。" |
| request_member | 成员正忙 | "成员正在 xxx 项目工作，由 session yyy 占用" | 没引导选别人 | "成员正在 xxx 项目工作。建议：1. 调 get_roster 选其他空闲成员；2. 等对方完成后重试；3. 调 force_release 强制释放（需确认对方确实卡住）" |
| save_memory | 未激活 | "成员 xxx 未激活，请先调用 activate" | 信息清晰 | OK |
| deactivate | 未激活 | "成员未激活" | 太简短 | "成员未激活，无需 deactivate。如需释放残留锁，请用 check_out(force=true)" |

---

## 六、总结：Top 10 必改项（双人对审统一结论）

> 以下为 ux-auditor 与 ux-auditor-2 独立审计后交叉对审、辩论达成的共识。
> 辩论过程中解决了 5 个分歧点（见附录 A）。

按优先级排序：

### 1. [CRITICAL] clock_out 缺少 save_memory 检查（数据丢失风险）
**工具：** clock_out | **位置：** hub.ts:2839-2955 | **双方一致同意**
clock_out 执行完整下班流程（释放锁、清理 MCP、删心跳、关终端）但不检查 save_memory。对比 deactivate（hub.ts:1301）和 check_out（hub.ts:1244）都有 `if (!hasMemorySaved(member) && !force)` 检查。离场是成员生命周期终点，经验丢失不可恢复。
**修复：** 在 clock_out 中增加与 deactivate 相同的 `hasMemorySaved` 检查，含 `force=true` 旁路。

### 2. [CRITICAL] check_inbox 消费语义未在描述中体现（消息丢失风险）
**工具：** check_inbox | **位置：** hub.ts:2694 | **双方一致同意**
description 说"查看自己的消息收件箱"，但实现用 HTTP DELETE 消费消息（读后清空队列）。agent 以为是只读操作，反复调用导致消息永久丢失。
**修复：** (a) description 改为"消费收件箱消息（读取并清空队列）"；(b) 增加 `peek` 只读选项，或改为非破坏性读取 + 独立的 `acknowledge_inbox` 工具。

### 3. [CRITICAL] 任务交接丢失个人记忆（跨成员上下文断裂）
**工具：** activate / save_memory / handoff | **双方一致同意**
当成员 A 用 save_memory 保存项目记忆后离场，成员 B 接替同一任务时，B 的 activate 返回的 memory_project 是 B 自己的（空的），无法访问 A 的个人项目记忆。save_memory 是 per-member 存储，没有跨成员读取机制。handoff 工具的 PTY 通知也不提及"读前任记忆"。
**修复：** (a) activate 返回值增加 `predecessor_memory` 字段（如果是交接任务）；(b) 增加 `read_member_memory(target, scope, project)` 跨成员读取工具（需权限控制）；(c) workflow_hint 增加条件步骤"如果是接续任务，调 work_history + read_memory 了解前任进度"。

### 4. [HIGH] send_msg from="unknown" 导致 leader 消息不可回复
**工具：** send_msg | **位置：** hub.ts:2668-2673 | **ux-auditor-2 发现，ux-auditor 代码验证确认**
Leader session 的 `memberName=""` (index.ts:105, falsy)，`activatedMembers` 为空（leader 不调 activate），send_msg 的 from 推断逻辑全部跳过，落到 `from="unknown"`。**所有 leader 发出的消息 from 都是 "unknown"，接收方无法回复**。这破坏了最基本的 leader->member->reply 通信链。
**修复：** 在 from 推断逻辑中增加 `else if (session.isLeader) { from = "leader"; }`。

### 5. [HIGH] activate 不返回待处理收件箱消息
**工具：** activate | **位置：** hub.ts:2109-2133 | **ux-auditor-2 发现，ux-auditor 接受**
activate 返回 persona、memory、rules、workflow_hint、project_members，但不包含收件箱信息。如果成员上线前有其他 agent 发来的关键消息（尤其是离场后重新上线场景），成员完全不知道有待读消息。workflow_hint 也不引导"检查收件箱"。
**修复：** activate 返回值增加 `pending_messages_count: N`，或直接包含待处理消息。workflow_hint 增加"如有待处理消息，先用 check_inbox 查看"。

### 6. [HIGH] uninstall_member_mcp 误杀全部 MCP 子进程（代码 bug）
**工具：** uninstall_member_mcp | **位置：** hub.ts:2347 | **ux-auditor-2 发现，ux-auditor 代码验证确认**
`uninstall_member_mcp` 调用 `cleanupMemberMcps(member)` 杀掉该成员的**全部** MCP 子进程，而非仅清理被卸载的那一个。对比 `unmount_mcp`（hub.ts:2430）正确使用 `cleanupOneMcp(memberName, mcpName)` 只清理目标进程。成员有 3 个 MCP 运行中，卸载 1 个会导致另外 2 个也被杀。
**修复：** 将 hub.ts:2347 的 `cleanupMemberMcps(member)` 替换为 `cleanupOneMcp(member, mcpName)`。

### 7. [HIGH] deactivate 不清理 departure.json（状态残留）
**工具：** deactivate | **位置：** hub.ts:1283-1339 | **双方辩论后达成共识**
leader 发 request_departure 后写入 departure.json。如果成员选择 deactivate 而非 clock_out 下线，departure.json 残留在磁盘上，`pending: true` 不被清理。下次 get_status/get_roster 查询该成员时仍显示 `"pending_departure"` 即使成员已经 offline。
**辩论记录：** ux-auditor 原提议"block deactivate when pending_departure exists"，ux-auditor-2 反驳"这会造成死锁——成员不同意离场时无法正常下线"。最终共识：**不阻止 deactivate，但 deactivate 应清理 departure.json**。
**修复：** deactivate 流程中增加 `deleteDepartureFile(member)` 调用。

### 8. [MEDIUM] MCP_INSTRUCTIONS 缺少错误恢复引导
**文件：** index.ts:125-171 | **双方一致同意**
MCP_INSTRUCTIONS 只覆盖 happy path，不告诉 agent 工具失败后该怎么办。agent 遇到 activate 失败可能陷入重试循环，save_memory 失败可能放弃保存。
**修复：** 增加"错误恢复"段落：activate 失败 → 检查 get_status；save_memory 失败 → 重试一次然后 deactivate(force=true)；deactivate 失败 → check_out(force=true) 兜底。

### 9. [MEDIUM] propose_rule / reject_rule 缺少主动通知
**工具：** propose_rule / reject_rule | **双方一致同意**
propose_rule 的 hint 说"请通知 leader 审批"但没说用 send_msg，leader 的名字是什么也不知道。reject_rule 不通知提议者，提议者需要主动调 read_shared(pending_rules) 才能发现规则被拒。整个治理流程依赖 agent 主动轮询，容易断链。
**修复：** (a) propose_rule 的 hint 改为含 send_msg 示例；(b) reject_rule 实现中增加 send_msg 通知提议者被拒原因。

### 10. [MEDIUM] update_project 全量替换数组无警告（数据丢失风险）
**工具：** update_project | **位置：** hub.ts:2542-2558 | **双方一致同意**
`members`、`forbidden`、`rules` 参数是全量替换。agent 传 `members: ["A"]` 会静默移除其他所有成员。无确认机制、无 diff 展示。
**修复：** (a) 增加 add_member/remove_member 原子操作；或 (b) 返回值展示变更 diff；或 (c) 数组长度减少时要求 `confirm_overwrite: true`。

---

## 附录 A：双人对审分歧记录

| 分歧点 | ux-auditor 立场 | ux-auditor-2 立场 | 最终共识 |
|--------|----------------|-------------------|---------|
| deactivate 绕过离场审批 | HIGH：应阻止 deactivate | 不是问题：member 有自主权 | 不阻止 deactivate，但清理 departure.json（状态一致性修复） |
| uninstall_member_mcp 杀全部 MCP | 未发现 | HIGH：代码 bug | 接受，确认是 bug（cleanupMemberMcps vs cleanupOneMcp） |
| activate 不返回收件箱 | 未显式标记 | HIGH | 接受，但降为 MEDIUM→最终 HIGH（与 check_inbox 消费语义构成消息系统缺陷集群） |
| send_msg from="unknown" | 提到 from 推断问题但未标为 must-fix | HIGH：破坏所有 leader 通信 | 接受为 HIGH，代码验证确认 leader 必然 from="unknown" |
| check_in 不检查 activate | LOW，我的 #10 | 同意但认为不够 top 10 | 从 top 10 移除，降为"值得修复但非优先"项 |

## 附录 B：值得保留的设计亮点

> 来自 ux-auditor-2 报告，双方一致认同。

1. **checkpoint 工具** — 返回原始任务 + 规则 + 6 条自查提示。强制 agent 自我反思，是系统中设计最好的工具。
2. **get_roster summary** — 返回可用角色、忙碌角色、在线/离线计数，leader 决策信息充分。
3. **Panel/本地双回退模式** — 每个工具先尝试 Panel API，失败后回退到直接文件 I/O。系统对 Panel 崩溃有韧性。
4. **Hint 链模式** — 大多数工具返回值含 hint 指向下一步操作，形成自然的工作流引导。
5. **submit_experience 重复检测** — 提交经验时检查相似内容，避免经验库噪音积累。
6. **离场流程通知设计** — request_departure 的 PTY 通知包含三种行为选项，尊重成员自主权同时保持 leader 控制。
7. **心跳扫描 + PID 存活检测** — 覆盖超时和进程死亡两种场景，防止僵尸锁。

---

## 附录 C：真实案例 — leader 无法让成员下线

### 现象

Leader agent 调 `request_departure` 两次都失败，返回错误：`"只有 leader 才能发起离场请求，你不能擅自让成员离场"`。

### 根因分析

`request_departure` 的权限校验使用 `session.isLeader`（hub.ts:2710），该标志在 session 注册时由 `CLAUDE_MEMBER` 环境变量决定（index.ts:106）：`isLeader = !memberName`。

如果 agent 进程启动时 `CLAUDE_MEMBER` 环境变量被设置（即使值为 leader 的名字），session 会被注册为非 leader，导致所有 leader-only 工具不可用。这可能发生在以下场景：
- Panel spawn 时错误地为 leader 终端设置了 `CLAUDE_MEMBER`
- agent 被 re-spawn 到一个已有 `CLAUDE_MEMBER` 的终端环境中

错误信息 `"只有 leader 才能发起离场请求"` 没有告诉 agent **为什么**当前 session 不被认为是 leader，也没有给出修复路径。agent 无法自诊断是环境变量问题还是权限配置问题。

### Agent 的自救过程

Agent 最终推理出应该先 activate 确认身份，然后再调 request_departure。但这个推理过程浪费了两轮工具调用，而且 activate 本身并不影响 `session.isLeader` 标志——真正的修复应该是确保 session 注册时 `isLeader` 正确。

### 关联到本报告的发现

| 关联项 | 说明 |
|--------|------|
| Top 10 #8（MCP_INSTRUCTIONS 缺错误恢复引导） | 如果提示词有"request_departure 失败 → 检查 session 身份"的恢复引导，agent 不会盲目重试 |
| 场景走查-组合流程 2（离场） | 离场流程评级 ⚠️→❌，leader 连第一步都可能走不通 |
| 错误提示改进清单 | `"只有 leader 才能发起离场请求"` 应改为 `"当前 session 未被识别为 leader（可能是 CLAUDE_MEMBER 环境变量被错误设置）。请检查终端环境或联系系统管理员。"` |

### 建议

1. **request_departure 错误信息增加诊断信息**：返回当前 session 的 `isLeader` 值和 `memberName` 值，帮助 agent 自诊断
2. **MCP_INSTRUCTIONS 增加 leader 身份确认段落**：告诉 leader agent "你的身份由 CLAUDE_MEMBER 环境变量在启动时决定，不可通过工具调用改变"
3. **防御性检查**：`request_departure` 可增加 fallback——如果 `!session.isLeader` 但 caller profile 的 role 是 "leader"/"总控"，也允许操作（类似 `checkPrivilege` 的逻辑）
