# MCP Team Hub 测试用例文档

版本：v1.0  
日期：2026-04-13  
作者：测试-刺猬  

---

## 目录

1. [MCP Server 工具测试](#一-mcp-server-工具测试)
2. [锁机制测试（P0 优先）](#二-锁机制测试p0-优先)
3. [Session 生命周期测试](#三-session-生命周期测试)
4. [面板测试](#四-面板测试)
5. [多 Claude 实例并发测试](#五-多-claude-实例并发测试)
6. [记忆与经验测试](#六-记忆与经验测试)
7. [临时成员测试](#七-临时成员测试)
8. [测试重点与风险](#八-测试重点与风险)

---

## 一、MCP Server 工具测试

### 1.1 签到/签退

#### TC-001
- **模块**：MCP Server / check_in
- **优先级**：P0
- **前置条件**：`~/.claude/team-hub/members/laochui/` 目录存在，`profile.json` 已配置，无 `lock.json`
- **操作步骤**：
  1. 调用 `check_in`，参数 `member="laochui"`，`project="proj-a"`，`task="修复登录bug"`
  2. 检查 `~/.claude/team-hub/members/laochui/lock.json` 是否创建
- **预期结果**：
  - `lock.json` 存在，包含 `nonce`（非空随机串）、`session_pid`（当前 Claude 进程 PID）、`session_start`、`project="proj-a"`、`task="修复登录bug"`、`locked_at`（ISO 时间）
  - 返回成功消息
- **注意**：nonce 必须每次随机生成，不能是固定值

#### TC-002
- **模块**：MCP Server / check_in（成员已占用）
- **优先级**：P0
- **前置条件**：`laochui` 已有 `lock.json`，且持锁 session PID 仍存活
- **操作步骤**：
  1. 另一个 session 调用 `check_in`，参数 `member="laochui"`
- **预期结果**：
  - 返回错误，明确说明该成员当前被占用
  - 原有 `lock.json` 内容不变
- **注意**：不能静默覆盖现有锁

#### TC-003
- **模块**：MCP Server / check_out
- **优先级**：P0
- **前置条件**：当前 session 持有 `laochui` 的锁
- **操作步骤**：
  1. 调用 `check_out`，参数 `member="laochui"`
  2. 检查 `lock.json` 是否删除
- **预期结果**：
  - `lock.json` 被删除
  - 返回成功消息

#### TC-004
- **模块**：MCP Server / check_out（无锁状态）
- **优先级**：P1
- **前置条件**：`laochui` 无 `lock.json`
- **操作步骤**：
  1. 调用 `check_out`，参数 `member="laochui"`
- **预期结果**：
  - 返回提示（成员未被使用），不报错崩溃

#### TC-005
- **模块**：MCP Server / get_status
- **优先级**：P1
- **前置条件**：团队中有成员处于空闲和占用两种状态
- **操作步骤**：
  1. 调用 `get_status`
- **预期结果**：
  - 返回所有成员列表，包含 `name`、`busy`、`project`（busy 成员有值，idle 成员无）、`type`（permanent/temporary）

#### TC-006
- **模块**：MCP Server / force_release
- **优先级**：P1
- **前置条件**：`laochui` 持有锁，但对应进程已死（PID 不存在）
- **操作步骤**：
  1. 调用 `force_release`，参数 `member="laochui"`
- **预期结果**：
  - `lock.json` 被删除
  - 返回成功，附带释放原因（进程不存在）
- **注意**：force_release 应检查进程是否真的死了，不能无条件删锁

---

### 1.2 记忆工具

#### TC-007
- **模块**：MCP Server / save_memory
- **优先级**：P1
- **前置条件**：成员目录存在
- **操作步骤**：
  1. 调用 `save_memory`，参数 `scope="personal"`，`key="coding_style"`，`content="优先写类型再写实现"`
  2. 检查文件是否写入
- **预期结果**：
  - `~/.claude/team-hub/members/[member]/memory/personal/coding_style.md` 存在，内容正确

#### TC-008
- **模块**：MCP Server / read_memory
- **优先级**：P1
- **前置条件**：TC-007 执行后
- **操作步骤**：
  1. 调用 `read_memory`，参数 `scope="personal"`，`key="coding_style"`
- **预期结果**：
  - 返回 "优先写类型再写实现"

#### TC-009
- **模块**：MCP Server / read_memory（key 不存在）
- **优先级**：P2
- **前置条件**：指定 key 的文件不存在
- **操作步骤**：
  1. 调用 `read_memory`，参数 `key="nonexistent_key"`
- **预期结果**：
  - 返回 null 或明确的"未找到"提示，不报 500 错误

#### TC-010
- **模块**：MCP Server / submit_experience
- **优先级**：P1
- **前置条件**：经验审核队列目录存在
- **操作步骤**：
  1. 调用 `submit_experience`，参数 `title="避免直接修改 lock 文件"`，`content="应通过原子写入..."`，`tags=["lock","安全"]`
- **预期结果**：
  - 经验以 pending 状态写入审核队列
  - 返回经验 ID

#### TC-011
- **模块**：MCP Server / read_shared
- **优先级**：P1
- **前置条件**：共享记忆目录存在，有已批准的内容
- **操作步骤**：
  1. 调用 `read_shared`，参数 `scope="team"`
- **预期结果**：
  - 返回所有已批准的共享内容列表

#### TC-012
- **模块**：MCP Server / search_experience
- **优先级**：P1
- **前置条件**：经验库中有多条经验，含重复关键词
- **操作步骤**：
  1. 调用 `search_experience`，参数 `query="lock"`
- **预期结果**：
  - 返回匹配 "lock" 的经验列表
  - 结果不含重复条目（去重验证）

---

### 1.3 规则工具

#### TC-013
- **模块**：MCP Server / propose_rule
- **优先级**：P1
- **前置条件**：规则提议队列目录存在
- **操作步骤**：
  1. 调用 `propose_rule`，参数 `title="锁文件原子写入"`，`content="写锁必须先写临时文件再 rename"`
- **预期结果**：
  - 规则以 pending 状态写入审核队列
  - 返回规则 ID

#### TC-014
- **模块**：MCP Server / review_rules
- **优先级**：P1
- **前置条件**：存在 pending 的规则提议
- **操作步骤**：
  1. 调用 `review_rules`
- **预期结果**：
  - 返回所有 pending 规则列表，每条含 ID、title、content、提议人

#### TC-015
- **模块**：MCP Server / approve_rule
- **优先级**：P1
- **前置条件**：TC-013 执行后，规则 ID 已知
- **操作步骤**：
  1. 调用 `approve_rule`，参数 `rule_id=[TC-013 的ID]`
- **预期结果**：
  - 规则状态变为 approved
  - 规则写入生效规则文件

#### TC-016
- **模块**：MCP Server / reject_rule
- **优先级**：P1
- **前置条件**：存在 pending 的规则提议
- **操作步骤**：
  1. 调用 `reject_rule`，参数 `rule_id=[ID]`，`reason="范围太宽泛"`
- **预期结果**：
  - 规则状态变为 rejected，附 reason

---

### 1.4 报告与诊断工具

#### TC-017
- **模块**：MCP Server / team_report
- **优先级**：P1
- **前置条件**：有多个成员，状态各异
- **操作步骤**：
  1. 调用 `team_report`
- **预期结果**：
  - 返回团队整体状态汇总：在线 session 数、每成员 busy/idle 状态、当前任务

#### TC-018
- **模块**：MCP Server / project_dashboard
- **优先级**：P1
- **前置条件**：有多个成员正在处理不同 project
- **操作步骤**：
  1. 调用 `project_dashboard`
- **预期结果**：
  - 返回按项目分组的成员列表

#### TC-019
- **模块**：MCP Server / work_history
- **优先级**：P2
- **前置条件**：已有历史工作记录
- **操作步骤**：
  1. 调用 `work_history`，参数 `member="laochui"`，`limit=10`
- **预期结果**：
  - 返回最近 10 条历史，含 project、task、时间戳

#### TC-020
- **模块**：MCP Server / stuck_scan
- **优先级**：P1
- **前置条件**：某成员 `locked_at` 超过 2 小时
- **操作步骤**：
  1. 调用 `stuck_scan`，阈值设为 120 分钟
- **预期结果**：
  - 返回疑似卡住的成员列表，含卡住时长

#### TC-021
- **模块**：MCP Server / handoff
- **优先级**：P1
- **前置条件**：成员 A 持有锁，成员 A 需要把任务交接给成员 B
- **操作步骤**：
  1. 调用 `handoff`，参数 `from="laochui"`，`to="xiaokuai"`，`note="接着做登录模块"`
- **预期结果**：
  - A 的锁被释放
  - B 的锁被创建，task 继承 A 的，附 note

---

### 1.5 临时成员工具

#### TC-022
- **模块**：MCP Server / hire_temp
- **优先级**：P1
- **前置条件**：模板目录 `~/.claude/team-hub/templates/` 存在，有 `researcher` 模板
- **操作步骤**：
  1. 调用 `hire_temp`，参数 `template="researcher"`，`name="临时研究员-001"`
- **预期结果**：
  - `~/.claude/team-hub/members/[生成ID]/` 目录创建
  - `profile.json` 中 `type="temporary"`

#### TC-023
- **模块**：MCP Server / evaluate_temp（保留转正）
- **优先级**：P1
- **前置条件**：TC-022 执行后，临时成员存在
- **操作步骤**：
  1. 调用 `evaluate_temp`，参数 `member=[临时成员ID]`，`decision="keep"`，`note="表现优秀"`
- **预期结果**：
  - `profile.json` 中 `type` 变为 `"permanent"`

#### TC-024
- **模块**：MCP Server / evaluate_temp（辞退清理）
- **优先级**：P1
- **前置条件**：有临时成员
- **操作步骤**：
  1. 调用 `evaluate_temp`，参数 `decision="dismiss"`
- **预期结果**：
  - 成员目录被完整清理（含 memory、lock 等子目录）
  - 不影响其他成员目录

#### TC-025
- **模块**：MCP Server / list_templates
- **优先级**：P2
- **前置条件**：模板目录有至少 2 个模板
- **操作步骤**：
  1. 调用 `list_templates`
- **预期结果**：
  - 返回所有可用模板列表，含模板名称和角色描述

---

## 二、锁机制测试（P0 优先）

### P0-1：面板与 MCP 同时清理同一把锁（double-free）

#### TC-101
- **模块**：锁机制 / 并发清理
- **优先级**：P0
- **前置条件**：
  - `laochui` 持有 lock.json，nonce="abc123"，session PID 已死
  - 面板的 `inspectSessions` 和 MCP 的 `force_release` 可同时触发
- **操作步骤**：
  1. 同时触发面板 5s 轮询 `inspectSessions` 和 MCP `force_release` 调用
  2. 两个操作都读到 nonce="abc123"，准备删除
- **预期结果**：
  - lock.json 只被删除一次
  - 第二个删除操作因 nonce 已不匹配（文件已删）而跳过，不报错
  - 面板代码路径：`index.ts:212-218`（二次读取 nonce 比对）
- **注意**：当前面板代码有"记住 nonce，再读一次确认"的保护，测试需验证这条路径真的有效

#### TC-102
- **模块**：锁机制 / nonce 二次校验
- **优先级**：P0
- **前置条件**：lock.json 存在，nonce="abc123"
- **操作步骤**：
  1. 第一次读取：获取 nonce="abc123"
  2. 在第二次读取前，另一个进程修改 lock.json，nonce 变为 "xyz789"
  3. 执行第二次读取
- **预期结果**：
  - 二次读取发现 nonce 不匹配，放弃删除操作
  - 原 lock.json（nonce="xyz789"）保留

---

### P0-2：check_out/cleanup 盲删别人的锁

#### TC-103
- **模块**：锁机制 / session 隔离
- **优先级**：P0
- **前置条件**：
  - Session A（PID=1234）持有 `laochui` 的锁，lock.json 中 `session_pid=1234`
- **操作步骤**：
  1. Session A 执行 `check_out`，过程中（读取后删除前）
  2. Session B（PID=5678）调用 `check_in` 抢占 `laochui`，写入新 lock.json，`session_pid=5678`
  3. Session A 的删除操作继续执行
- **预期结果**：
  - Session A 的删除因 `session_pid` 或 nonce 不匹配而放弃
  - Session B 的 lock.json 保留完整

#### TC-104
- **模块**：锁机制 / 面板清理 session 归属校验
- **优先级**：P0
- **前置条件**：
  - Session A（PID=1234）已死，对应 session.json 存在
  - `laochui` 的 lock.json 中 `session_pid=5678`（Session B，仍存活）
- **操作步骤**：
  1. 面板 `inspectSessions` 清理 session A
  2. 遍历 members 时发现 `laochui` 的锁中 `session_pid=5678` ≠ 死亡的 1234
- **预期结果**：
  - `laochui` 的 lock.json **不被删除**（归属不匹配）
  - 代码路径：`index.ts:207`（`lock.session_pid !== session.pid` 判断）

---

### P0-3：写入中断 → 半截 JSON

#### TC-105
- **模块**：锁机制 / JSON 容错
- **优先级**：P0
- **前置条件**：`laochui` 的 lock.json 内容为损坏的 JSON（如 `{"nonce":"abc123","ses`）
- **操作步骤**：
  1. 面板调用 `readJson(lockPath)`
  2. MCP Server 调用任何读取 lock 的工具
- **预期结果**：
  - `readJson` 返回 null，不抛出异常（代码路径：`index.ts:65-72`）
  - 面板对该成员显示为"idle"（因 `lock === null`）
  - MCP Server 对该成员的处理不崩溃，报告该锁损坏并跳过或清理

#### TC-106
- **模块**：锁机制 / 写入原子性
- **优先级**：P0
- **前置条件**：准备写入新 lock.json
- **操作步骤**：
  1. 检查写入实现：是否先写临时文件再 rename（原子写入）
  2. 若直接 writeFileSync：模拟写入时进程被 kill
- **预期结果**：
  - 原子写入：文件要么完整要么不存在，不存在半截 JSON
  - 非原子写入：记录为已知风险，需改为 rename 方式

---

### P0-4：check_in 接管的 TOCTOU

#### TC-107
- **模块**：锁机制 / 接管竞争
- **优先级**：P0
- **前置条件**：`laochui` 的锁持有者 PID 已死（死锁状态）
- **操作步骤**：
  1. Session A 和 Session B 同时调用 `check_in`，参数 `member="laochui"`
  2. 两者都检查到锁存在但持有者已死，准备接管
  3. 两者同时写入新 lock.json
- **预期结果**：
  - 只有一个 session 成功接管（lock.json 中 session_pid 只有一个值）
  - 另一个 session 收到"接管失败"或"成员已被占用"的错误
- **注意**：此为 TOCTOU 竞争，需要原子写入（rename）保证正确性

---

### P0-5：清理顺序（先锁后 session）

#### TC-108
- **模块**：锁机制 / 退出顺序
- **优先级**：P0
- **前置条件**：session 正常运行，持有 `laochui` 的锁
- **操作步骤**：
  1. 触发 `gracefulShutdown`（stdin 关闭或 SIGTERM）
  2. 观察文件删除顺序
- **预期结果**：
  1. 先删 `lock.json`（释放员工）
  2. 再删 `session.json`（注销 session）
  - 不能反序（若先删 session，面板短暂看不到 session 但锁还在，导致成员显示 busy 但无对应 session）

---

### P0-6：PID 复用误判

#### TC-109
- **模块**：锁机制 / PID 复用
- **优先级**：P0
- **前置条件**：
  - `laochui` 的 lock.json 中 `session_pid=1234`，`nonce="old_nonce"`
  - PID 1234 对应的旧进程已死，但操作系统已将 PID 1234 分配给新进程
  - session.json 中记录了 `lstart`（进程启动时间）
- **操作步骤**：
  1. 面板 `inspectSessions` 检测到 PID=1234 存活（新进程）
  2. 读取 session.json 中的 `lstart`，与新进程的 lstart 比较
- **预期结果**：
  - lstart 不匹配 → 判定为不同进程 → 清理孤儿锁和 session
  - 代码路径：`index.ts:182-185`（lstart 双验）
- **注意**：仅凭 PID 存活不足以判断是同一进程，lstart 是关键防线

---

## 三、Session 生命周期测试

#### TC-201
- **模块**：Session / 正常启动
- **优先级**：P0
- **前置条件**：`~/.claude/team-hub/sessions/` 目录存在
- **操作步骤**：
  1. 启动 Claude Code（MCP Server 随之启动）
  2. 检查 sessions 目录
- **预期结果**：
  - `sessions/[PID].json` 创建，包含 `pid`、`lstart`、`cwd`、`started_at`

#### TC-202
- **模块**：Session / 正常退出
- **优先级**：P0
- **前置条件**：session 已启动，持有 `laochui` 的锁
- **操作步骤**：
  1. 正常退出 Claude Code（Ctrl+D 或 exit）
- **预期结果**：
  - `lock.json` 被删除
  - `session.json` 被删除
  - 顺序：先删锁，后删 session（见 TC-108）

#### TC-203
- **模块**：Session / stdin 关闭触发 gracefulShutdown
- **优先级**：P0
- **前置条件**：session 运行中，持有锁
- **操作步骤**：
  1. 关闭 MCP Server 的 stdin（模拟 Claude Code 进程崩溃）
- **预期结果**：
  - MCP Server 检测到 stdin 关闭
  - 触发 gracefulShutdown：先释放锁，再删 session
  - 整个清理过程在 stdin 关闭后 5 秒内完成

#### TC-204
- **模块**：Session / kill -9 强杀（面板巡检清理）
- **优先级**：P0
- **前置条件**：session 运行中，持有锁，面板正在运行
- **操作步骤**：
  1. `kill -9 [Claude_PID]`
  2. 等待面板下一次 5s 轮询
- **预期结果**：
  - 面板 `inspectSessions` 发现 PID 不存在
  - lstart 验证（PID 复用检查）
  - 清理孤儿 session.json 和对应的 lock.json
  - 最多 5 秒后清理完毕，面板 UI 更新

#### TC-205
- **模块**：Session / 启动全量扫描
- **优先级**：P1
- **前置条件**：面板启动前，`sessions/` 目录中有残留的孤儿 session（PID 已死）
- **操作步骤**：
  1. 启动面板
  2. 面板初始化时执行全量 `inspectSessions`
- **预期结果**：
  - 启动后清理所有孤儿 session 和对应孤儿锁
  - UI 显示正确的当前状态

---

## 四、面板测试

#### TC-301
- **模块**：面板 / 单实例保护
- **优先级**：P0
- **前置条件**：面板已运行
- **操作步骤**：
  1. 再次启动面板（第二个实例）
- **预期结果**：
  - 第二个实例立即退出（`app.quit()`）
  - 原有窗口如果最小化，恢复并 focus（`index.ts:376-380`）
  - 验证方式：检查进程列表只有一个面板进程

#### TC-302
- **模块**：面板 / 文件监听实时更新
- **优先级**：P1
- **前置条件**：面板运行，chokidar 监听 `~/.claude/team-hub/`
- **操作步骤**：
  1. 手动修改某成员的 lock.json（或创建/删除）
  2. 观察面板 UI
- **预期结果**：
  - UI 在文件变化后立即更新（< 1 秒），不需要等待 5s 轮询
  - 代码路径：`index.ts:304`（chokidar `all` 事件触发 `pushStatus`）

#### TC-303
- **模块**：面板 / 5s 轮询兜底
- **优先级**：P1
- **前置条件**：面板运行，假设 chokidar 未触发（模拟 chokidar 失效）
- **操作步骤**：
  1. 直接修改 lock.json，绕过 chokidar 事件（如通过 rename）
  2. 等待最多 5 秒
- **预期结果**：
  - 5 秒内面板 UI 更新反映最新状态
  - 代码路径：`index.ts:318`（setInterval 5000ms）

#### TC-304
- **模块**：面板 / 自关逻辑（正常路径）
- **优先级**：P1
- **前置条件**：面板运行，当前有 1 个 session
- **操作步骤**：
  1. 关闭唯一的 session（删除 session.json）
  2. 等待 15 秒
- **预期结果**：
  - sessions.length === 0 时，启动 15s 计时器
  - 15s 后再次扫描，仍为 0 session
  - 面板自动退出（`app.quit()`）
  - 代码路径：`index.ts:271-290`

#### TC-305
- **模块**：面板 / 自关中断（新 session 出现）
- **优先级**：P1
- **前置条件**：0 session，15s 自关计时器已启动（约 10s 时）
- **操作步骤**：
  1. 在计时器触发前（第 10s）创建新 session.json
  2. 文件监听或轮询触发 `pushStatus`
- **预期结果**：
  - 检测到 `sessions.length > 0`
  - 清除 autoQuitTimer（`clearTimeout`）
  - 面板**不退出**，继续运行
  - 代码路径：`index.ts:285-290`

#### TC-306
- **模块**：面板 / 休眠唤醒恢复
- **优先级**：P1
- **前置条件**：面板运行中
- **操作步骤**：
  1. 系统进入休眠（`powerMonitor suspend` 事件触发）
  2. 验证 watcher 和 pollTimer 停止
  3. 系统唤醒（`powerMonitor resume` 事件触发）
  4. 等待 10 秒
- **预期结果**：
  - suspend：chokidar watcher 关闭，轮询停止
  - resume + 10s 后：执行全量 `inspectSessions`，重启 watcher 和轮询
  - 代码路径：`index.ts:336-352`

#### TC-307
- **模块**：面板 / 深色/浅色主题
- **优先级**：P2
- **前置条件**：面板运行
- **操作步骤**：
  1. 系统切换深色/浅色模式
- **预期结果**：
  - 面板收到 `theme-change` IPC 消息，UI 跟随切换

#### TC-308
- **模块**：面板 / 初始状态加载
- **优先级**：P1
- **前置条件**：启动面板前 sessions 和 members 目录已有数据
- **操作步骤**：
  1. 启动面板
  2. 渲染进程调用 `get-initial-status` IPC
- **预期结果**：
  - 窗口加载后立即显示当前状态，不需要等待 5s 轮询

---

## 五、多 Claude 实例并发测试

#### TC-401
- **模块**：并发 / 不同成员
- **优先级**：P1
- **前置条件**：`laochui` 和 `xiaokuai` 均空闲
- **操作步骤**：
  1. Session A 调用 `check_in member="laochui"`
  2. Session B 调用 `check_in member="xiaokuai"`
- **预期结果**：
  - 两个 check_in 均成功
  - 各自持有不同成员的锁，互不干扰

#### TC-402
- **模块**：并发 / 抢占同一成员
- **优先级**：P0
- **前置条件**：`laochui` 空闲
- **操作步骤**：
  1. Session A 和 Session B 同时调用 `check_in member="laochui"`
- **预期结果**：
  - 只有一个 session 成功（lock.json 中 session_pid 唯一）
  - 另一个收到错误：成员已被占用
  - lock.json 中的 session_pid 与成功的 session 一致

#### TC-403
- **模块**：并发 / session 退出后自动释放
- **优先级**：P0
- **前置条件**：Session A 持有 `laochui` 的锁，Session B 在等待
- **操作步骤**：
  1. Session A 正常退出
  2. Session B 调用 `check_in member="laochui"`
- **预期结果**：
  - Session A 退出后 `laochui` 的锁被释放
  - Session B 的 `check_in` 成功

---

## 六、记忆与经验测试

#### TC-501
- **模块**：记忆 / 个人通用记忆读写
- **优先级**：P1
- **前置条件**：成员 `laochui` 已存在
- **操作步骤**：
  1. `save_memory scope="personal" key="test_philosophy" content="优先集成测试"`
  2. `read_memory scope="personal" key="test_philosophy"`
- **预期结果**：读回内容与写入一致

#### TC-502
- **模块**：记忆 / 项目记忆读写
- **优先级**：P1
- **前置条件**：项目标识已配置
- **操作步骤**：
  1. `save_memory scope="project" project="mcp-team-hub" key="arch_decision" content="单文件即状态"`
  2. 另一个成员调用 `read_memory scope="project" project="mcp-team-hub" key="arch_decision"`
- **预期结果**：项目记忆跨成员共享，另一个成员能读到

#### TC-503
- **模块**：记忆 / 经验提交到审核队列
- **优先级**：P1
- **操作步骤**：
  1. `submit_experience title="X" content="Y" tags=["t1"]`
  2. `review_rules`（或经验审核接口）查看队列
- **预期结果**：经验出现在 pending 队列，状态为"待审核"

#### TC-504
- **模块**：记忆 / 经验搜索去重
- **优先级**：P1
- **前置条件**：经验库中有 3 条都含 "lock" 关键词的经验，其中 2 条内容几乎相同
- **操作步骤**：
  1. `search_experience query="lock"`
- **预期结果**：
  - 返回匹配结果，重复内容被去重（返回 2 条而非 3 条）
  - 去重逻辑应基于内容相似度或 hash，不仅仅是 ID

---

## 七、临时成员测试

#### TC-601
- **模块**：临时成员 / 从模板创建
- **优先级**：P1
- **前置条件**：`researcher` 模板存在于 templates 目录
- **操作步骤**：
  1. `hire_temp template="researcher" name="临时研究员-test"`
- **预期结果**：
  - 在 members 目录创建独立目录（唯一 ID）
  - `profile.json` 包含 `type: "temporary"`
  - 独立 memory 子目录存在（空）

#### TC-602
- **模块**：临时成员 / 评估保留转正
- **优先级**：P1
- **前置条件**：TC-601 执行后
- **操作步骤**：
  1. `evaluate_temp member=[临时ID] decision="keep" note="工作质量高"`
- **预期结果**：
  - `profile.json` 中 `type` 变为 `"permanent"`
  - 目录和 memory 保留

#### TC-603
- **模块**：临时成员 / 评估辞退目录清理
- **优先级**：P1
- **前置条件**：有临时成员，且当前无锁（已 check_out）
- **操作步骤**：
  1. `evaluate_temp member=[临时ID] decision="dismiss"`
- **预期结果**：
  - 临时成员目录（含 profile、memory、lock 等）完整删除
  - 其他成员目录不受影响

#### TC-604
- **模块**：临时成员 / 辞退持锁成员
- **优先级**：P1
- **前置条件**：临时成员当前持有锁（busy 状态）
- **操作步骤**：
  1. `evaluate_temp member=[临时ID] decision="dismiss"`
- **预期结果**：
  - 要么拒绝操作，提示成员仍在使用中
  - 要么先强制释放锁，再删除目录
  - 不能在锁存在时静默删除目录

---

## 八、测试重点与风险

### 8.1 最容易出问题的地方

#### 1. 锁的并发竞争（最高风险）

**风险**：check_in 和 check_out 之间没有原子性保证。当前实现直接使用 `writeFileSync`/`rmSync`，在以下场景下可能出错：
- 两个 session 同时接管死锁（P0-4，TC-107）
- check_out 执行一半时，另一个 session 写入新锁（P0-2，TC-103）

**必须验证**：lock.json 的写入是否使用原子 rename（先写 `.lock.tmp` 再 rename）。如果不是，TC-107 是大概率失败的用例。

#### 2. nonce 校验路径的实际效果（面板侧）

当前面板代码（`index.ts:211-218`）有"读取 nonce → 再次读取比对"的保护，但这两次读取之间仍有窗口期。

**必须验证**：在极端并发下，两次读取之间 lock.json 被替换的情况是否被正确处理（TC-102）。

#### 3. PID 复用（lstart 防线）

`isPidAlive` 只检查 PID 是否存在，PID 复用会导致误判存活。面板的 lstart 双验（`index.ts:182-185`）是唯一防线。

**必须验证**：lstart 比较逻辑是否正确，格式是否一致（`ps -o lstart=` 的输出格式可能含前导空格）。

#### 4. 半截 JSON 处理

`readJson` 返回 null 对面板是安全的（成员显示 idle），但 MCP Server 侧如果也需要读取损坏的 lock，需要同样的容错。

**必须验证**：MCP Server 的 lock 读取是否也有 try/catch，避免 JSON.parse 异常冒泡。

#### 5. 自关 15s 计时器竞态

`autoQuitTimer` 未考虑多次 `pushStatus` 连续调用的情况：若 sessions.length 在 15s 内反复在 0 和非 0 之间变化，计时器的清除和重建逻辑需要验证不会重复创建多个计时器。

**必须验证**：TC-305（自关中断）中 `clearTimeout` 是否真的清除了计时器，以及是否存在多个 autoQuitTimer 并存的情况。

#### 6. 面板 inspectSessions 与 MCP Server 同时操作同一文件

面板是独立进程，MCP Server 是另一个独立进程，两者都会对 lock.json 和 session.json 进行读写/删除。OS 层面没有互斥锁。

**已知风险**：无文件级锁，依赖 nonce 比对和 PID 校验作为软保护。这是架构层面的已知妥协，测试需要覆盖所有并发边界场景（TC-101 ~ TC-109）。

---

### 8.2 测试执行优先级

| 优先级 | 用例 | 原因 |
|--------|------|------|
| 立刻测 | TC-107、TC-103、TC-101 | 原子性和并发竞争，最容易导致数据损坏 |
| 立刻测 | TC-109、TC-204 | PID 复用和 kill -9 是生产必现场景 |
| 立刻测 | TC-105、TC-106 | 半截 JSON 和写入原子性，影响系统稳定性 |
| 高优 | TC-001~006 | 基础签到签退，功能核心 |
| 高优 | TC-301~308 | 面板核心功能 |
| 次要 | TC-019、TC-025 | 历史记录和模板列表，不影响核心流程 |

---

### 8.3 测试环境说明

- MCP Server：Bun + TypeScript，stdio 模式，需通过 Claude Code 的 MCP 机制调用
- 面板：Electron，`packages/panel/`，通过 `npm run dev` 或打包后运行
- 数据目录：`~/.claude/team-hub/`（sessions/、members/）
- 并发测试：需要同时打开两个 Claude Code 终端窗口，各自连接同一 MCP Server 配置
- P0 锁机制测试：部分需要在文件系统层面人工干预（直接修改 JSON 文件）来模拟竞态
