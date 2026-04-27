# Phase 通信管道 — 回归测试清单

**版本**：v1 · **日期**：2026-04-25 · **对抗审查**：reviewer-comm-a

> 本文件是 Wave 3 测试员的唯一依据。测试员只看这个，不读代码、不读 TASK-LIST。
> 每条用例都能独立复跑；出证据（测试名 / 输出 / SQL 行数）贴回 Stage 目录。
> 编号约定：`U-xx` 单元 · `I-xx` 集成 · `E-xx` 端到端 · `R-xx` 回归（上个 Phase 不破）。

---

## 0. 环境准备

| 项 | 值 |
|---|---|
| 工作目录 | `packages/backend/` |
| 包管理 | `bun install` 已完成 |
| 关键命令 | `bun run tsc --noEmit` / `bun test` |
| 测试 DB | `:memory:`（由 `TEAM_HUB_V2_DB=:memory:` 注入） |
| 注意 | 不 mock db / bus；每个集成测例用独立 `EventBus` + 独立 `:memory:` DB |

---

## 1. 单元测试（Wave 1 出产）

### 1.1 envelope.ts（W1-A）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-01 | `isActorRef` 正向 | agent / user / system 合法入参 | 3 条 `true` | ☐ |
| U-02 | `isActorRef` 反向 | 缺字段 / kind 非法 / 非 object | 3 条 `false` | ☐ |
| U-03 | `isMessageEnvelope` 正向 | 完整 envelope / 仅必填 / 带 attachments | 3 条 `true` | ☐ |
| U-04 | `isMessageEnvelope` 反向 | 缺 id / kind 非法 / to 非 ActorRef | 3 条 `false` | ☐ |
| U-05 | 编译检查 | `tsc --noEmit` 对 envelope.ts | 零错 | ☐ |
| U-06 | 不 import 业务代码 | `grep "from '\\.\\./\\|from '\\.\\./\\.\\./" envelope.ts` | 只能匹到 `./` 自己目录或 node 标准库 | ☐ |

### 1.2 envelope-builder.ts（W1-B）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-10 | agent→agent 正常 | fromKind='agent' + fromLookup + toLookup | envelope.from.kind='agent'、displayName 取 lookup | ☐ |
| U-11 | user→agent | fromKind='user' + fromDisplayNameOverride | from.displayName 用 override（默认 "User"） | ☐ |
| U-12 | system→agent | fromKind='system' + allowSystemKind=true | from.kind='system'、from.address='local:system' | ☐ |
| U-13 | summary 缺省 | summary=undefined | envelope.summary='给你发了一条消息' | ☐ |
| U-14 | 禁止 agent 发 system kind | kind='system' + allowSystemKind=false | throw Error | ☐ |
| U-15 | 允许 system 入口发 system kind | kind='system' + allowSystemKind=true | 不抛 | ☐ |
| U-16 | agent 场景缺 fromLookup | fromKind='agent' + fromLookup=null | throw Error | ☐ |
| U-17 | teamId 缺省 | teamId=undefined | envelope.teamId=null（不查 DB） | ☐ |
| U-18 | attachments 透传 | 入参带 attachments | envelope.attachments 同入参 | ☐ |
| U-19 | now / generateId 可注入 | 入参传 fake | envelope.ts / id 用入参结果 | ☐ |
| U-20 | 不 import DB/bus | `grep "db/connection\\|bus/"` | 零匹配 | ☐ |
| U-21 | replyTo 透传 + 默认 null | 分两条断言 | 与入参一致 | ☐ |
| U-22 | fromKind='user' 配 user: 地址 | fromAddress='user:local' | envelope.from.address 同步 | ☐ |
| U-23 | agent toLookup=null | fromKind='agent' toLookup=null | throw 或 to.kind 降级到 system/unknown（按 README 承诺对齐） | ☐ |

### 1.3 message-store.ts（W1-C）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-30 | insert 新 envelope | 第一次调用 | 返回 dbId>0，messages 行 +1 | ☐ |
| U-31 | insert 幂等 | 同 envelope_uuid 两次 | 两次返回同一 dbId；messages 行仅 +1 | ☐ |
| U-32 | findById 命中 | insert 后再 findById(envelope.id) | 返回完整 envelope，字段一致 | ☐ |
| U-33 | findById 未命中 | 查不存在的 id | 返回 null | ☐ |
| U-34 | markRead 首次 | 未读消息 | 返回 1，read_at 写入 | ☐ |
| U-35 | markRead 幂等 | 已读消息再调 | 返回 0，read_at 不变 | ☐ |
| U-36 | listInbox peek=true | 3 条未读 | 返回 3 条摘要，read_at 仍为 null | ☐ |
| U-37 | listInbox peek=false | 3 条未读 | 返回 3 条，且全部 read_at 写入 | ☐ |
| U-38 | listInbox 只返摘要 | 返回结构 | **不含 content 字段**（关键！） | ☐ |
| U-39 | listInbox limit | limit=2 插 5 条 | 返回 2 条，total=5 | ☐ |
| U-40 | listTeamHistory 游标 | 5 条同 team，before=第 3 条 id | 返回第 4、5 条；nextBefore 指第 5 条；hasMore=false | ☐ |
| U-41 | listTeamHistory hasMore | limit=2，实际 5 条 | hasMore=true | ☐ |
| U-42 | findUnreadFor 完整 envelope | 未读 2 条 | 返回 MessageEnvelope[]（不是 Message） | ☐ |
| U-43 | findUnreadFor 不含已读 | 1 读 + 2 未读 | 只返 2 条 | ☐ |
| U-44 | 不 import 业务代码 | `grep "bus/\\|comm/router\\|mcp/"` | 零匹配 | ☐ |

### 1.4 read_message.ts（W1-D）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-50 | HTTP 200 | fake fetch 返回 envelope | 返回 `{envelope}` | ☐ |
| U-51 | HTTP 404 | fake fetch 返回 404 | 返回 `{error}` 含 'not found' | ☐ |
| U-52 | HTTP 403 | 跨收件人 | 返回 `{error}` 含 'forbidden' | ☐ |
| U-53 | HTTP 500 | 服务端错 | 返回 `{error}`，**不**抛异常 | ☐ |
| U-54 | markRead=true 默认 | 入参 undefined | URL 带 `markRead=true` | ☐ |
| U-55 | markRead=false | 入参 false | URL 带 `markRead=false` | ☐ |
| U-56 | messageId 必填 | 入参缺 messageId | 返回 `{error: 'messageId is required'}` | ☐ |
| U-57 | 不 import db | `grep "db/connection"` | 零匹配 | ☐ |

---

## 2. 单元测试（Wave 2 出产）

### 2.1 bus/subscribers/member-driver/index.ts（W2-A）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-60 | index 聚合两条子 sub | 独立 EventBus + FakeRuntime；订阅后发 `instance.created` | driver 起来 + `driver.started` 事件 + role_instances.session_pid 被写 | ☐ |
| U-61 | unsubscribe 级联 | 调 `Subscription.unsubscribe()` | 两条 sub 同时解挂（再发事件无反应） | ☐ |
| U-62 | 挂载后 `instance.offline_requested` → 停 driver | 走完 created 流程后发 offline_requested | driver.stop 被调（FakeRuntime kill 记录） | ☐ |
| U-63 | bus/index.ts 调用 index | 删掉 `subscribeMemberDriver` 调用 | `tsc --noEmit` 不会报（说明挂钩不被强制）→ **反例**：要求直接对 `bus/index.ts` snapshot 包含该 import 行 | ☐ |

### 2.2 comm/router.ts（W2-C）改造后

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-70 | dispatch 入参是 MessageEnvelope | TSC 编译 | 老 Message 入参调用点 `tsc` 报错（证明类型漂移已清零） | ☐ |
| U-71 | 路由 system | to.address='local:system' + systemHandler 已注册 | 调用 handler 一次；返回 `{route:'system'}` | ☐ |
| U-72 | driver delivered | driverDispatcher 返回 'delivered' | 返回 `{route:'local-online'}` | ☐ |
| U-73 | driver not-ready fallback | dispatcher 返回 'not-ready' + 无 socket | 走 offline，返回 `{route:'local-offline', stored:true}` | ☐ |
| U-74 | remote-unsupported | to.address='remote:hub1:inst' | 返回 `{route:'remote-unsupported'}`，不写库 | ☐ |
| U-75 | dropped | to.address 非法 | 返回 `{route:'dropped'}`，不写库 | ☐ |
| U-76 | 落库入口唯一 | 所有成功路径（system/online/offline）都应调 store.insert 恰好一次；dropped/remote 不调 | 用 spy store 校验计数 | ☐ |
| U-77 | bus 事件 emit 一次 | 每条 envelope dispatch 过程中 `comm.message_sent` emit 恰好一次 | 计数=1（不漏发、不重发） | ☐ |
| U-78 | driver.prompt 文本格式 | dispatch 成功路径 | dispatcher 收到的 notifyLine 精确匹配 `^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$` | ☐ |
| U-79 | extractText 删除 | `grep "function extractText" router.ts` | 零匹配 | ☐ |

### 2.3 mcp/tools/send_msg.ts（W2-D）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-80 | 缺 summary 走默认 | 入参只有 to + content | comm.send payload.summary='给你发了一条消息' | ☐ |
| U-81 | 缺 content | 入参只有 to + summary | 返回 `{error:'content is required'}` | ☐ |
| U-82 | kind='system' 被拒 | 入参 kind='system' | 返回 `{error}`，不调 comm.send | ☐ |
| U-83 | kind='task' 透传 | 入参 kind='task' | payload.kind='task' | ☐ |
| U-84 | replyTo 透传 | 入参带 replyTo | payload.replyTo 一致 | ☐ |
| U-85 | 返回 messageId | 成功路径 | `{delivered, messageId, route}` 三字段齐 | ☐ |
| U-86 | to 走 lookup | to='老王'（alias） | runLookup 被调一次 | ☐ |

### 2.4 bus/types.ts + ws.subscriber.ts（W2-H）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-90 | comm.message_sent payload 不破 | TSC 编译 | 仍是 `{messageId, from, to}`，**不扩展** | ☐ |
| U-91 | comm.message_received payload 不破 | TSC 编译 | 仍是 `{messageId, from, to, route}` | ☐ |
| U-92 | WS 白名单不漂移 | `WS_EVENT_TYPES.size` | 等于 34（当前数量）——**未新增事件** | ☐ |
| U-93 | toWsPayload 剥离字段 | 发 comm.message_sent | 输出无 source / correlationId | ☐ |

> **审查修订**：原 TASK-LIST W2-H 提出新增 `comm.message_delivered` 事件且进 ws 白名单。
> 经对比 `comm-model-frontend.md` §6.2（Part B 最终稿明确拒绝扩 payload、坚持沿用两事件 + HTTP 反查），
> 以及 W2-C 走"subscriber 异步写库"带来的 `msg_id` 尚未落库 → `read_message` 404 的竞态，
> 本期**不新增事件**、**router 内同步落库**，WS 沿用老的 sent/received（payload 不扩）。
> 上述 U-90 ~ U-93 按新方案断言"不漂移"。

### 2.5 bus/subscribers/message-persister.subscriber.ts（W2-G）

> **审查修订**：原设计 persister 订阅 `comm.message_delivered` 写库。
> 改为：**持久化在 router 内同步调 store.insert**（见 W2-C），保证 envelope.id 在 emit bus 之前就稳定可查。
> persister subscriber **不再独立成模块**，本组测试取消（U-100 ~ U-105 作废）。
> 若架构师坚持保留 persister，必须补 "emit → persist 之间 read_message 并发查询" 的时序测试（见 I-17）。

### 2.6 comm/driver-dispatcher.ts（W2-E）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-110 | 签名不变 | TypeScript 类型 | `DriverDispatcher = (id: string, text: string) => Promise<Result>` | ☐ |
| U-111 | registry 命中 ready | driver.isReady=true | 调 driver.prompt(text) 一次；返回 'delivered' | ☐ |
| U-112 | registry 命中 not ready | isReady=false | 返回 'not-ready'，不调 prompt | ☐ |
| U-113 | registry 未命中 | get 返回 null | 返回 'not-found' | ☐ |
| U-114 | driver.prompt 抛错 | prompt reject | 返回 'not-ready'（吞） | ☐ |

### 2.7 member-agent/format-message.ts（W2-F）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-120 | formatNotifyLine 格式 | 给定 id / displayName / summary | 精确等于 `@<name>>${summary}  [msg_id=<id>]` | ☐ |
| U-121 | 正则断言 | 100 条随机数据 | 全部匹配 `^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$` | ☐ |
| U-122 | 老 formatMemberMessage 保留 | 保留 shim | 旧签名仍能调；返回值为新格式（delegate） | ☐ |
| U-123 | check_inbox 返回不含 content | 走 fake HTTP 返回 3 条摘要 | 每条只有 `{id,from,summary,kind,replyTo,ts,readAt}` | ☐ |

### 2.8 http/routes/messages.routes.ts（W2-I）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-130 | POST /api/messages/send 200 | body=to+summary+content | 返回 `{messageId}`；DB 有新行 | ☐ |
| U-131 | POST body 带 from → 被覆盖 | body 里伪造 `from.kind='agent'` | DB 写入的 from_kind='user'（强注入胜出） | ☐ |
| U-132 | POST to 最小化 | body `to: {kind:'agent', address:'local:inst1'}` | 后端 lookup 补全 displayName/memberName/instanceId | ☐ |
| U-133 | POST to 不可达 | address 指向不存在实例 | 返回 404 + error | ☐ |
| U-134 | POST 415 | Content-Type 不是 application/json | 返回 415 | ☐ |
| U-135 | GET /api/messages/:id 200 | 已插入一条 | 返回 `{envelope}` | ☐ |
| U-136 | GET /api/messages/:id 404 | 不存在 id | 返回 404 | ☐ |
| U-137 | GET :id?markRead=true | 原未读 | 返回后 DB read_at 已写 | ☐ |
| U-138 | GET :id 默认不 markRead | 不带 query | DB read_at 仍为 null | ☐ |
| U-139 | GET inbox peek=true | 3 条未读 | 返回 3 条摘要；DB read_at 都为 null | ☐ |
| U-140 | GET inbox peek=false | 3 条未读 | 返回 3 条；DB read_at 全部写入 | ☐ |
| U-141 | GET inbox 不存在实例 | 非法 instanceId | 返回 404 | ☐ |
| U-142 | GET teams/:teamId/messages 分页 | 5 条 team 消息 limit=2 | 返回 2 条 + nextBefore + hasMore=true | ☐ |
| U-143 | http/router.ts 挂载 | 新 route 在 handlers 数组中 | E-xx 场景覆盖（GET 实际走通） | ☐ |

### 2.9 db/schemas/messages.sql 迁移（W2-J）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| U-150 | 新库 CREATE TABLE 含新列 | `:memory:` 启动，`PRAGMA table_info(messages)` | 包含 from_kind/from_user_id/from_display/to_kind/to_display/envelope_uuid/attachments_json | ☐ |
| U-151 | 老库 ALTER TABLE 补列 | 用 v1 表预置 1 行老数据，再运行迁移 | 新列存在；老行值为 backfill 默认 | ☐ |
| U-152 | envelope_uuid backfill | 老行 `envelope_uuid='msg_'\|\|id` | `SELECT COUNT(*) WHERE envelope_uuid='' OR envelope_uuid IS NULL` = 0 | ☐ |
| U-153 | from_kind 系统消息 backfill | 老行 from_instance_id IS NULL | from_kind='system' | ☐ |
| U-154 | UNIQUE 索引 | 再插同 uuid | 违约抛异常（索引生效） | ☐ |
| U-155 | 迁移幂等 | 连续 boot 两次 | 不抛，新列值不变 | ☐ |
| U-156 | CHECK 约束 | 插入 from_kind='other' | 违约抛异常 | ☐ |

> **审查新增**：当前 `db/connection.ts` 只是把 `schemas/*.sql` 拼起来 exec，没 migration runner。
> W2-J 必须补一段 "若 messages 表已存在且缺新列 → ALTER TABLE"的逻辑（放在 applySchemas 之后），
> 并用 U-151 / U-155 双测夹出真实迁移行为。纯 schema 文件修改不够。

---

## 3. 集成测试（串多模块）

| # | 测试项 | 验证什么 | 预期 | 通过 |
|---|--------|---------|------|------|
| I-01 | 启动完整 bus 链 | `bootSubscribers` + createServer 启动后观察 masterSub 聚合 | member-driver + message 相关订阅全部 add | ☐ |
| I-02 | CommServer 构造带 dispatcher | 启动 HTTP server 后 `comm.router.driverDispatcher` 非 undefined | 断言字段存在 | ☐ |
| I-03 | instance.created → driver start → pid 回写 | FakeRuntime + 独立 bus + :memory: DB | role_instances.session_pid 有值 | ☐ |
| I-04 | envelope-builder → store → router 全链路 | user→agent 单次 dispatch | DB 行 +1；envelope_uuid 格式 msg_*；from_kind='user' | ☐ |
| I-05 | 系统消息走强注入 | `subscribeCommNotify` 走 offline_requested | router 收到 envelope.from.kind='system' | ☐ |
| I-06 | offline → replay 走新通知行 | 成员未上线 → 消息落库 → 成员 activated → replay | driver.prompt 收到 `@<name>>summary  [msg_id=msg_xx]`（**不再是老格式**） | ☐ |
| I-07 | send_msg 幂等 | agent 连发同 content 两次 | DB 两条不同 envelope_uuid；driver.prompt 两次 | ☐ |
| I-08 | message_sent 顺序 | POST /api/messages/send → 在 WS 广播收到 comm.message_sent 之前消息已落库 | GET /api/messages/:id 在 WS 推之后立即返 200（**不能 404**） | ☐ |
| I-09 | 跨事件隔离 | primary_agent driver 起来发 driver.started | pid-writeback 跳过（findById null）；不误写别的实例 | ☐ |
| I-10 | lookup 补全 to 字段 | POST 只传 `to:{kind,address}` | DB to_display / to_instance_id / 其它字段由 role_instances 反查填入 | ☐ |
| I-11 | check_inbox 只摘要 | 成员调 check_inbox | 返回项无 content 字段 | ☐ |
| I-12 | read_message 拉全文 | agent 用 msg_id 查 | 返回完整 envelope 含 content；DB read_at 更新 | ☐ |
| I-13 | kind='system' 三入口隔离 | (1) agent send_msg kind=system → 被拒；(2) HTTP POST kind=system → 被拒；(3) bus subscriber 内部 dispatch kind=system → 放行 | 三条断言全过 | ☐ |
| I-14 | driver 未 ready 时发送 | PENDING 实例收消息 | route=local-offline + stored=true；activate 后 replay 自动投递 | ☐ |
| I-15 | 团队历史分页 | 5 条同 team 消息 + limit=2 翻三页 | 页 1 / 页 2 拿到正确 subset；页 3 `hasMore=false` | ☐ |
| I-16 | WS 推 sent + 前端反查 | 单次 POST 发消息 | WS client 收到 comm.message_sent（含 messageId）；随即 GET /api/messages/:id 返回 200 | ☐ |
| I-17 | **时序门禁（关键）** | 若 architect 坚持 W2-G persister 独立：在 emit 到 subscribe 之间用极短间隔调 GET | 必须 200，**绝不 404**。通不过即证明 persister 方案不可行，回退到 router 同步写库 | ☐ |

---

## 4. 端到端场景

| # | 场景 | 步骤 | 预期 | 通过 |
|---|------|------|------|------|
| E-01 | agent A → agent B 在线 | (1) 起 leader + member A + member B（FakeRuntime） (2) A 调 send_msg to=B summary='x' content='y' | B 的 driver.prompt 收到 `@A>x  [msg_id=msg_<id>]` | ☐ |
| E-02 | B 调 read_message 拿全文 | E-01 后 B 用 msg_id 调 read_message | 返回 envelope.content='y'；DB read_at 写入 | ☐ |
| E-03 | 用户 → agent | POST /api/messages/send body={to:{kind:'agent',address:'local:inst_leader'},summary:'hi',content:'start'} | leader driver.prompt 收到 `@User>hi  [msg_id=...]`；messages 表 from_kind='user' | ☐ |
| E-04 | 前端 WS 看到事件 | 连 WS 订阅 + 执行 E-03 | WS 收到 comm.message_sent + comm.message_received | ☐ |
| E-05 | 前端 GET 历史分页 | E-03 + 之前历史 5 条 | GET teams/:teamId/messages 按 before 游标翻页正确 | ☐ |
| E-06 | B 离线时发送 + 上线 replay | A 对 PENDING 的 B 发 2 条 → activate B | B 上线后 driver.prompt 收到 2 条通知行，均带 msg_id | ☐ |
| E-07 | 系统消息送达 | leader 批准某成员 offline → comm-notify 发系统消息 | 成员 driver 收到 `@系统>...  [msg_id=...]`，envelope.from.kind='system' | ☐ |
| E-08 | check_inbox 只摘要 + read_message 拿详情 | B 收到 2 条后调 check_inbox peek=true | 返回 2 条摘要（无 content）；再 read_message(msg_id1) 拿到 content | ☐ |

---

## 5. 回归验证（上个 Phase 不破）

| # | 测试项 | 预期 | 通过 |
|---|--------|------|------|
| R-01 | `bun run tsc --noEmit` | 零报错 | ☐ |
| R-02 | `bun test` 全部已有测试 | 全绿（无新失败） | ☐ |
| R-03 | PTY 清零 | `grep -rn "pty\\." packages/backend/src \| wc -l` | 不增长（上个 Phase 已清零） | ☐ |
| R-04 | process-runtime 测试 | `bun test process-runtime` | 全绿 | ☐ |
| R-05 | agent-driver 测试 | `bun test agent-driver` | 全绿 | ☐ |
| R-06 | member-driver lifecycle / replay / pid-writeback 测试 | 三套 `.test.ts` 跑完 | 全绿 | ☐ |
| R-07 | driver-dispatcher 签名冻结 | 检查 `INTERFACE-CONTRACTS.md` 的 DriverDispatcher 仍是 `(id,text)=>Promise<Result>` | 签名未变 | ☐ |
| R-08 | offline.ts shim 仍能 replayFor | 老 test 跑 offline.replayFor | 继续通过（过渡期） | ☐ |
| R-09 | comm-server.test.ts | 现有 socket 注册 / dispatch 覆盖率 | 全绿 | ☐ |
| R-10 | comm-router.test.ts | 现有 5 条路径 + 新加路径 | 全绿（含改造后的断言） | ☐ |
| R-11 | http-*.test.ts（9 套） | 全部 HTTP 端点回归 | 全绿 | ☐ |
| R-12 | WS_EVENT_TYPES 数量 | 未减少、未漂移 | 等于基线值（34） | ☐ |
| R-13 | schema_version 表 | 迁移 2 遍后 version 行 1 条 | 不重复写 | ☐ |

---

## 6. 测试员交付清单

测试员跑完后在 Stage 目录下留：

```
packages/backend/docs/phase-comm/
├── REGRESSION.md        ← 本文件
└── regression-report-<date>.md   ← 测试员产出
```

`regression-report-*.md` 结构：

```markdown
# 回归报告 - <日期>

## 环境
- commit: <hash>
- bun 版本: <x.y>
- OS: darwin 24.1.0

## 通过率
- 单元：xx/xx
- 集成：xx/xx
- 端到端：xx/xx
- 回归：xx/xx

## 失败清单
| # | 用例 | 失败现象 | 日志路径 |
|---|------|---------|---------|

## 结论
可以进入下一 Phase / 打回修复（N 条）
```

---

## 7. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版 | reviewer-comm-a |
