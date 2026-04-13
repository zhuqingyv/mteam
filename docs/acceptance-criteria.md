# MCP Team Hub — 产品验收标准

> 版本：v1.0 | 日期：2026-04-13 | 作者：产品-郭聪明
> 
> 说明：本文档定义每个功能的验收标准。**所有功能点须通过刺猬（测试）+ 郭总（dog-food）+ 钱多多（商业评估）三道验收才算完成，缺一不可。**

---

## 目录

1. [员工状态管理](#一员工状态管理)
2. [员工锁机制](#二员工锁机制)
3. [记忆沉淀](#三记忆沉淀)
4. [公共制度](#四公共制度)
5. [临时招募](#五临时招募)
6. [桌面面板](#六桌面面板)
7. [数据可靠性](#七数据可靠性)

---

## 一、员工状态管理

### 1.1 check_in(member, project, task)

**功能描述：** 将指定员工签入某项目的某任务，同时获取该员工的排他锁。

**验收标准：**

- Given：员工 A 当前空闲
  - When：调用 `check_in("A", "proj-x", "实现登录模块")`
  - Then：
    - 返回成功响应，包含签入时间戳和 session nonce
    - `get_status("A")` 显示员工忙碌，project = "proj-x"，task = "实现登录模块"

- Given：员工 A 已在项目 proj-x 工作
  - When：另一 Claude 实例调用 `check_in("A", "proj-y", "其他任务")`
  - Then：返回失败，错误信息包含"员工 A 已被占用"和当前持锁方信息，不改变现有状态

- Given：员工 A 已在项目 proj-x 工作（持锁进程已死亡）
  - When：新进程调用 `check_in("A", "proj-y", "新任务")`
  - Then：自动释放僵尸锁，签入成功

**边界条件：**
- member 不存在于花名册：返回错误"成员不存在"，不创建新成员
- task 参数为空字符串：返回错误，拒绝签入
- project 名含特殊字符（`/`、空格）：做字符串转义，不报错

**不通过判定：**
- 两个实例能同时持有同一员工的锁
- 签入成功但 `get_status` 仍显示空闲
- 僵尸锁超过 30 秒未自动释放

---

### 1.2 check_out(member)

**功能描述：** 将指定员工签出，释放锁，标记为空闲。

**验收标准：**

- Given：员工 A 正在工作（本 session 持锁）
  - When：调用 `check_out("A")`
  - Then：返回成功，`get_status("A")` 显示空闲，工作记录已追加本次 session 的起止时间

- Given：员工 A 已空闲
  - When：调用 `check_out("A")`
  - Then：返回幂等成功（不报错），无副作用

- Given：员工 A 由 Session-1 持锁
  - When：Session-2 调用 `check_out("A")`
  - Then：返回错误"无权签出，该员工由其他 session 持有"，状态不变

**边界条件：**
- 签出时写工作记录失败（磁盘满等）：锁仍必须释放，错误异步上报，不阻塞主流程

**不通过判定：**
- 签出后 `get_status` 仍显示忙碌
- 非持锁方能成功签出他人
- 工作记录丢失（时间戳缺失）

---

### 1.3 get_status(member?)

**功能描述：** 查询单个员工或全员的当前状态。

**验收标准：**

- Given：员工 A 正在工作
  - When：调用 `get_status("A")`
  - Then：返回 `{ member: "A", status: "busy", project: "...", task: "...", since: "<ISO时间>", pid: <数字> }`

- Given：不传 member 参数
  - When：调用 `get_status()`
  - Then：返回所有员工的状态列表，每条格式同上

- Given：部分员工持锁进程已死亡
  - When：调用 `get_status()`
  - Then：这些员工标记 `status: "zombie"`，而非显示为正常忙碌

**边界条件：**
- 花名册为空时调用全员查询：返回空数组，不报错
- member 参数传入不存在的名字：返回错误"成员不存在"

**不通过判定：**
- 僵尸员工显示为正常 "busy"（掩盖真实状态）
- since 字段缺失或格式不一致

---

### 1.4 force_release(member, reason)

**功能描述：** Leader 角色强制释放员工锁，记录释放原因，用于卡死或异常处理。

**验收标准：**

- Given：调用方角色为 leader
  - When：调用 `force_release("A", "进程卡死超过1小时")`
  - Then：员工 A 立即变为空闲，操作日志记录：操作人、时间、reason

- Given：调用方角色非 leader
  - When：调用 `force_release("A", "xxx")`
  - Then：返回权限错误，状态不变

- Given：员工 A 已空闲
  - When：leader 调用 `force_release("A", "预防性释放")`
  - Then：返回幂等成功，日志仍记录操作

**边界条件：**
- reason 为空字符串：拒绝，要求提供原因（防止无理由强制释放）
- leader 角色通过哪个字段判断：必须在 PRD/配置中明确，不能靠调用方自报

**不通过判定：**
- 非 leader 能成功调用
- 操作日志未记录 reason 和操作人
- 强制释放后员工状态未变为空闲

---

### 1.5 team_report()

**功能描述：** 输出全员快照：忙/闲分布、项目分布、僵尸预警。

**验收标准：**

- Given：团队有 5 人，2 人忙、2 人闲、1 人僵尸
  - When：调用 `team_report()`
  - Then：返回包含以下字段的报告：
    - `total`: 5
    - `busy`: 2（含项目名）
    - `idle`: 2
    - `zombie`: 1（含成员名和持锁时长）
    - `by_project`: 按项目分组的成员列表

**边界条件：**
- 全员空闲：正常返回，zombie 列表为空
- 全员忙碌：正常返回

**不通过判定：**
- 僵尸员工未出现在报告中
- 统计数字和实际状态不符

---

### 1.6 project_dashboard(project)

**功能描述：** 查看某项目当前所有在工作的员工及其任务。

**验收标准：**

- Given：proj-x 有 2 名员工在工作
  - When：调用 `project_dashboard("proj-x")`
  - Then：返回 2 条记录，每条包含 member、task、since

- Given：project 名不存在（无人在此项目工作）
  - When：调用 `project_dashboard("proj-unknown")`
  - Then：返回空列表，不报错

**不通过判定：**
- 跨项目数据混入（其他项目的员工出现在结果里）

---

### 1.7 work_history(member, limit?)

**功能描述：** 查询成员历史工作记录，支持条数限制。

**验收标准：**

- Given：员工 A 已完成 10 次 session
  - When：调用 `work_history("A", 3)`
  - Then：返回最近 3 条，每条包含：project、task、check_in_time、check_out_time、duration

- Given：不传 limit
  - When：调用 `work_history("A")`
  - Then：返回全部历史，默认最多 100 条（防止数据量过大）

- Given：员工 A 有正在进行中的 session
  - When：调用 `work_history("A")`
  - Then：当前 session 包含在结果中，check_out_time 显示为 null 或 "进行中"

**不通过判定：**
- 历史记录乱序（非按时间倒序）
- 已完成 session 的 duration 字段为 null

---

### 1.8 stuck_scan()

**功能描述：** 扫描所有超时未签出的员工，返回疑似卡死列表。

**验收标准：**

- Given：员工 A 已持锁超过 2 小时，员工 B 持锁 30 分钟
  - When：调用 `stuck_scan()`
  - Then：返回包含员工 A 的列表（含持锁时长），员工 B 不在列表中

- Given：所有员工持锁时间均在阈值内
  - When：调用 `stuck_scan()`
  - Then：返回空列表，不报错

**边界条件：**
- 超时阈值需可配置（默认值须在文档中明确，建议 2 小时）
- 僵尸员工（进程死亡）必须出现在 stuck_scan 结果中

**不通过判定：**
- 进程死亡的员工未被识别为卡死
- 超时阈值硬编码无法修改

---

### 1.9 handoff(from, to, project, notes)

**功能描述：** 将一个员工的工作交接给另一员工，附带交接说明。

**验收标准：**

- Given：员工 A 在 proj-x 工作，员工 B 空闲
  - When：调用 `handoff("A", "B", "proj-x", "已完成登录模块，剩余注册模块")`
  - Then：
    - 员工 A 签出，工作记录追加此次 session
    - 员工 B 签入 proj-x，task 字段含 notes 摘要
    - 交接记录持久化，可通过 `work_history` 查到

- Given：员工 B 已在另一项目工作
  - When：调用 `handoff("A", "B", "proj-x", "...")`
  - Then：返回错误"员工 B 当前忙碌，无法接收交接"，A 的状态不变

- Given：员工 A 未在 project 字段指定的项目工作
  - When：调用 `handoff("A", "proj-y", ...)`（A 实际在 proj-x）
  - Then：返回错误，project 不匹配

**不通过判定：**
- 交接后 A 仍显示忙碌
- 交接失败但 A 已被签出（原子性破坏）
- notes 内容丢失

---

## 二、员工锁机制

### 2.1 互斥锁（一人一项目）

**功能描述：** 任意时刻，一个员工只能在一个项目持有锁。

**验收标准：**

- Given：两个 Claude 实例几乎同时对员工 A 调用 `check_in`
  - When：并发请求到达服务器
  - Then：只有一个成功，另一个返回"已被占用"。不出现两个实例同时持锁的情况

**边界条件：**
- 测试并发量：至少 10 个并发请求，全部结果正确
- 锁的底层实现须使用原子操作或文件锁，不能依赖内存状态（多进程访问）

**不通过判定：**
- 压测 10 次并发，出现一次双持锁

---

### 2.2 进程死亡自动释放

**功能描述：** 持锁进程崩溃或被 kill -9 后，锁最终自动释放，不残留僵尸员工。

**验收标准：**

- Given：进程 P1 持锁员工 A
  - When：`kill -9 <P1的PID>`
  - Then：30 秒内，`get_status("A")` 变为 zombie 或 idle

- Given：进程 P1 正常退出（未调用 check_out）
  - When：P1 进程结束
  - Then：MCP Server 通过 heartbeat 或 PID 检测，60 秒内释放锁

**三层释放机制验收（逐层测试）：**

| 层级 | 触发条件 | 预期结果 |
|------|----------|----------|
| 第一层：进程退出钩子 | 正常退出 | 立即释放 |
| 第二层：心跳检测 | kill -9 | ≤30s 释放 |
| 第三层：启动扫描 | Server 重启 | 重启后立即清僵尸 |

**不通过判定：**
- kill -9 后 2 分钟仍显示 busy
- Server 重启后僵尸锁未清除

---

### 2.3 PID 复用防误判（nonce UUID）

**功能描述：** 新进程复用了旧进程 PID，不会继承旧锁，通过 nonce UUID 区分。

**验收标准：**

- Given：进程 P1（PID=1234）持锁员工 A 后崩溃
  - When：新进程 P2 恰好分配到 PID=1234，并调用 `check_in("B", ...)`
  - Then：P2 不会自动继承 A 的锁；A 仍被识别为僵尸锁；P2 签入 B 成功

**边界条件：**
- 每次 check_in 生成新 nonce，存储在锁记录中
- PID 匹配 + nonce 匹配 = 合法持锁；PID 匹配但 nonce 不匹配 = 僵尸

**不通过判定：**
- 仅靠 PID 判断持锁合法性（nonce 未实现）
- PID 复用导致 A 的锁被误认为合法

---

## 三、记忆沉淀

### 3.1 save_memory(member, scope, content, project?)

**功能描述：** 保存员工的个人记忆，支持全局范围或项目范围。

**验收标准：**

- Given：调用 `save_memory("laochui", "global", "不要在周五下午合并大PR")`
  - Then：记忆持久化到磁盘，`read_memory("laochui", "global")` 能读回原文

- Given：调用 `save_memory("laochui", "project", "登录模块用了JWT", "proj-x")`
  - Then：只在 proj-x 作用域可读，全局作用域不可见

**边界条件：**
- content 超过 10KB：返回错误，要求精简
- scope 为 "project" 但未传 project 参数：返回错误

**不通过判定：**
- 重启 Server 后记忆丢失
- project 作用域的记忆在全局查询中出现

---

### 3.2 read_memory(member, scope?, project?)

**功能描述：** 读取员工的个人记忆，支持按作用域过滤。

**验收标准：**

- Given：员工 A 有 3 条全局记忆、2 条 proj-x 记忆
  - When：调用 `read_memory("A", "global")`
  - Then：只返回 3 条全局记忆

  - When：调用 `read_memory("A")` 不传 scope
  - Then：返回所有记忆（全局 + 所有项目）

  - When：调用 `read_memory("A", "project", "proj-x")`
  - Then：只返回 2 条 proj-x 记忆

**不通过判定：**
- scope 过滤失效（不同作用域的记忆混在一起）
- 返回其他员工的记忆

---

### 3.3 submit_experience(member, scope, content, project?)

**功能描述：** 员工提交可供团队共享的经验，进入待审队列或直接归入共享库（取决于规则）。

**验收标准：**

- Given：员工 A 调用 `submit_experience("A", "global", "避免在迭代中途换框架")`
  - Then：经验进入共享待审队列，状态为 "pending"，`read_shared("pending")` 可见

**边界条件：**
- 相同内容的经验已存在（语义重复）：提示"与现有经验高度重复"，建议合并，不强制拒绝

**不通过判定：**
- 提交后无法通过任何接口查询到该条经验

---

### 3.4 read_shared(type, scope?, project?)

**功能描述：** 读取团队共享经验库，支持按类型和作用域过滤。

**验收标准：**

- Given：共享库有 5 条 approved 经验、2 条 pending 经验
  - When：调用 `read_shared("approved")`
  - Then：返回 5 条，不含 pending 经验

  - When：调用 `read_shared("pending")`
  - Then：返回 2 条

**不通过判定：**
- type 参数过滤失效
- 返回结果包含已删除的经验

---

### 3.5 search_experience(keyword, scope?)

**功能描述：** 按关键词搜索共享经验，结果去重。

**验收标准：**

- Given：共享库有 3 条含"JWT"的经验，其中 2 条内容高度相似
  - When：调用 `search_experience("JWT")`
  - Then：返回 3 条（含相似标注），或自动合并为 2 条（需明确哪种策略）

- Given：关键词无匹配
  - When：调用 `search_experience("量子纠缠")`
  - Then：返回空列表，不报错

**边界条件：**
- 关键词长度上限：建议 100 字符，超出返回错误
- 搜索范围：默认全部已 approved 经验；传 scope 则限定

**不通过判定：**
- 搜索结果不含关键词（索引失效）
- 完全相同的经验出现两次（去重失效）

---

## 四、公共制度

### 4.1 propose_rule(member, rule, reason)

**功能描述：** 员工提议新团队规则，自动查重后进入审核队列。

**验收标准：**

- Given：规则库中无类似规则
  - When：调用 `propose_rule("ciwei", "测试文件必须有独立目录", "避免和源码混在一起")`
  - Then：规则进入待审队列，分配 rule_id，状态 "pending"

- Given：已有规则"测试必须独立"
  - When：提议"测试文件须单独放置"（语义高度重复）
  - Then：返回"与 rule-003 高度相似"，提示确认是否继续，不自动拒绝

**边界条件：**
- reason 为空：拒绝，要求填写原因
- rule 超过 500 字：拒绝，要求精简

**不通过判定：**
- 完全相同的规则能重复提交，审核队列出现重复项
- 查重功能缺失（相似规则没有任何提示）

---

### 4.2 review_rules()

**功能描述：** 查看所有待审规则列表。

**验收标准：**

- Given：有 3 条 pending 规则
  - When：调用 `review_rules()`
  - Then：返回 3 条，每条含：rule_id、提议人、提议时间、rule 内容、reason、status

**不通过判定：**
- 已批准/驳回的规则混入待审列表
- 缺少 rule_id（无法后续操作）

---

### 4.3 approve_rule(rule_id, approver)

**功能描述：** 批准待审规则，规则生效进入执行库。

**验收标准：**

- Given：rule-001 状态为 pending
  - When：调用 `approve_rule("rule-001", "laochui")`
  - Then：rule-001 状态变为 "approved"，`review_rules()` 不再包含该条

**边界条件：**
- 同一规则能否被多次 approve：幂等，第二次返回"已批准"

**不通过判定：**
- 批准后规则仍出现在 `review_rules()` 待审列表
- approver 字段未记录

---

### 4.4 reject_rule(rule_id, reason)

**功能描述：** 驳回待审规则，记录原因。

**验收标准：**

- Given：rule-002 状态为 pending
  - When：调用 `reject_rule("rule-002", "规则过于宽泛，需细化")`
  - Then：rule-002 状态变为 "rejected"，reason 持久化

- Given：reason 为空
  - When：调用 `reject_rule("rule-002", "")`
  - Then：拒绝操作，要求填写驳回理由

**不通过判定：**
- 驳回后无法查询驳回原因
- 空 reason 可以驳回成功

---

## 五、临时招募

### 5.1 hire_temp(name, role_template, project, reason)

**功能描述：** 临时招募一个员工，基于岗位模板初始化配置。

**验收标准：**

- Given：岗位模板 "frontend-dev" 存在
  - When：调用 `hire_temp("小王", "frontend-dev", "proj-x", "前端开发资源紧缺")`
  - Then：
    - 员工"小王"出现在花名册，标记为 `temp: true`
    - 继承 "frontend-dev" 模板的默认配置
    - 可立即被 `check_in` 使用

- Given：role_template 不存在
  - When：调用 `hire_temp("小王", "rocket-scientist", "proj-x", "测试")`
  - Then：返回错误"模板不存在"，员工未创建

**边界条件：**
- name 与已有员工重名：返回错误，不覆盖现有员工
- reason 为空：拒绝，要求填写招募理由

**不通过判定：**
- 临时员工未标记 `temp: true`，无法与正式员工区分
- 基于不存在模板的员工被创建

---

### 5.2 evaluate_temp(name, decision, performance_note)

**功能描述：** 评估临时员工的去留，决定转正或解雇。

**验收标准：**

- Given：临时员工"小王"存在
  - When：调用 `evaluate_temp("小王", "hire", "表现优秀，按时交付")`
  - Then：小王状态变为正式员工（`temp: false`），performance_note 存入档案

  - When：调用 `evaluate_temp("小王", "fire", "无法完成基础任务")`
  - Then：小王从花名册删除（或标记 inactive），performance_note 存入档案

- Given：decision 为 "hire" 且小王已是正式员工
  - When：调用 `evaluate_temp`
  - Then：返回错误"该成员已是正式员工"

**边界条件：**
- performance_note 为空：返回错误，要求填写（不允许无理由解雇或转正）
- decision 只接受 "hire" 或 "fire"，其他值返回错误

**不通过判定：**
- 解雇后员工仍出现在活跃花名册
- performance_note 未持久化

---

### 5.3 list_templates()

**功能描述：** 查看所有可用的岗位模板。

**验收标准：**

- When：调用 `list_templates()`
- Then：返回所有模板列表，每条含：template_name、description、默认配置摘要

**边界条件：**
- 模板为空时：返回空列表，不报错

**不通过判定：**
- 返回结果不含 description 字段（无法判断该用哪个模板）

---

## 六、桌面面板

### 6.1 自动生命周期（随 Claude 启动/消失）

**功能描述：** 有 Claude 进程运行时面板出现，全部 Claude 关闭后面板自动消失。

**验收标准（手动验收）：**

- [ ] 启动 Claude Code → 面板在 3 秒内自动出现
- [ ] 关闭所有 Claude 窗口 → 面板在 5 秒内自动消失
- [ ] 重新启动 Claude → 面板再次出现，状态与上次一致

**不通过判定：**
- 关闭 Claude 后面板仍然存在
- 启动 Claude 后需要手动打开面板

---

### 6.2 实时状态显示

**功能描述：** 面板实时显示每个成员状态（忙/闲/疑似卡死），支持按项目分组。

**验收标准（手动验收）：**

- [ ] 员工 A check_in 后，面板 5 秒内更新显示"忙碌"
- [ ] 员工 A check_out 后，面板 5 秒内更新显示"空闲"
- [ ] 疑似卡死（超时未签出）的员工显示区别于"忙碌"的特殊标识（颜色或图标）
- [ ] 多个员工在同一项目时，按项目分组展示
- [ ] 每条记录显示当前任务名和工作时长

**边界条件：**
- 成员数 > 20 时：面板可滚动，不截断
- 任务名超长（>50字符）：截断显示，hover 可见全文

**不通过判定：**
- 状态更新延迟超过 10 秒
- 疑似卡死和正常忙碌视觉上无法区分

---

### 6.3 底部统计栏

**功能描述：** 面板底部显示汇总统计：session 数、忙碌数、空闲数。

**验收标准（手动验收）：**

- [ ] 统计数字与实际状态实时同步
- [ ] 3 忙 2 闲时，底部显示"忙碌: 3 | 空闲: 2 | Sessions: X"

**不通过判定：**
- 统计数字与列表中实际条目数不符

---

### 6.4 深色/浅色跟随系统

**验收标准（手动验收）：**

- [ ] macOS 切换深色模式 → 面板自动切换，无需重启
- [ ] 深色模式下文字可读性正常（对比度符合 WCAG AA）

**不通过判定：**
- 切换系统主题后需要重启面板才生效
- 深色模式下出现白底白字（不可读）

---

### 6.5 可拖拽、无标题栏、置顶

**验收标准（手动验收）：**

- [ ] 鼠标拖拽面板任意区域可移动
- [ ] 无系统标题栏（无红绿灯按钮）
- [ ] 面板始终在其他窗口之上（置顶）
- [ ] 拖拽位置在应用重启后保留

**不通过判定：**
- 面板被其他全屏应用遮挡
- 关闭后重新打开位置重置为默认

---

## 七、数据可靠性

### 7.1 崩溃/kill -9/休眠唤醒下最终一致

**功能描述：** 任何异常情况下，锁状态最终趋于正确，不出现永久不一致。

**验收标准（集成测试）：**

| 场景 | 操作 | 预期结果 | 验收期限 |
|------|------|----------|----------|
| 正常崩溃 | 进程抛出未捕获异常 | 锁在 30s 内释放 | 60s |
| kill -9 | `kill -9 <pid>` | 锁在 60s 内释放（心跳超时） | 120s |
| 休眠唤醒 | 合盖再开盖 | 唤醒后 30s 内重新检测 | 60s |
| Server 重启 | 重启 MCP Server | 重启完成后立即扫描并清理僵尸锁 | 启动后 10s |

**不通过判定：**
- 任何场景下出现"永远 busy"的成员（人工无法通过正常接口恢复，只能手改文件）

---

### 7.2 不出现两个 session 同时持锁

**功能描述：** 系统保证锁的唯一性，任何情况下不出现双重持锁。

**验收标准（压测）：**

- 并发场景：100 个并发 check_in 请求同一员工
  - Then：只有 1 个成功，99 个返回"已被占用"

- 网络异常场景：check_in 请求在写锁途中模拟超时
  - Then：要么锁写入成功，要么锁未写入；不出现半写状态

**不通过判定：**
- 100 次并发测试中，出现任何一次双持锁

---

## 附：验收流程

```
功能开发完成
    ↓
刺猬（测试）执行本文档所有 checklist / Given-When-Then 用例
    ↓
郭总 dog-food（真实使用场景走一遍）
    ↓
钱多多商业评估（使用体验、价值交付是否符合预期）
    ↓
三方全部 PASS → 标记该功能为"完成"
三方任一未 PASS → 打回开发修复
```

> **铁律：三方全过才能说完成。缺一不可。**
