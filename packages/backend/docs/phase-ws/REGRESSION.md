# Phase WS · 回归测试清单

> 测试员唯一依据。逐条执行，每条给出结果（PASS / FAIL + 证据路径或 git sha）。
>
> 前置：W2 全部模块 merge；`bun run build` 通过；`bun test` 绿灯。
>
> 所有用例不允许 mock db/bus；用 `new EventBus()` 隔离跨用例状态即可。

---

## 0. 环境与工具

- 测试脚本：`packages/backend` 下 `bun test <path>`
- 手工 E2E 工具：`websocat ws://localhost:<port>/ws/events?userId=local` 或浏览器控制台 `new WebSocket(...)`
- DB：使用临时文件（`file:///tmp/ws-regression-<run>.db`），每轮测试前清空

---

## 1. 功能 1：WS 双工协议

### R1-1 · 上行 subscribe 正确被路由
**步骤**：
1. WS 连接 `/ws/events?userId=u1`
2. 发送 `{op:'subscribe', scope:'team', id:'team_01'}`

**预期**：
- 收到下行 `{type:'ack', ok:true}`
- `subscriptionManager.list(connectionId)` 含 `{scope:'team', id:'team_01'}`

**验证脚本**: `packages/backend/src/ws/ws-handler.test.ts::subscribe-no-gap`

---

### R1-2 · 上行 subscribe 带 lastMsgId 触发 gap-replay
**前置**：messageStore 中 `team_01` 有 5 条历史 `msg_1000` ~ `msg_1004`。

**步骤**：
1. WS 连接 + `{op:'subscribe', scope:'team', id:'team_01', lastMsgId:'msg_1002'}`

**预期**：
- 先收到 `{type:'gap-replay', items:[{id:'msg_1003', ...}, {id:'msg_1004', ...}], upTo:'msg_1004'}`
- 再收到 `{type:'ack'}`
- items 内严格只有 id > msg_1002 的消息

---

### R1-3 · 上行 ping → 下行 pong
**步骤**: 发 `{op:'ping'}`
**预期**: 收到 `{type:'pong', ts:'<iso>'}`；连接保持

---

### R1-4 · 上行 prompt 被转发给 driver
**前置**: primary agent instance `inst_leader` driver 已 READY。

**步骤**: 发 `{op:'prompt', instanceId:'inst_leader', text:'hello', requestId:'req_1'}`

**预期**：
- 立即收到 `{type:'ack', requestId:'req_1', ok:true}`
- `driver.prompt('hello')` 被调 1 次（通过 bus 事件 `driver.turn_done` 到达间接断言；断言窗口 3s）
- WS 连接收到后续 `driver.thinking` / `driver.text` / `driver.turn_done` 推送（因连接已 subscribe instance:inst_leader 或 global）

---

### R1-5 · 上行 prompt 到非 READY driver → error
**步骤**: 发 `{op:'prompt', instanceId:'inst_offline', text:'x'}`
**预期**: `{type:'error', code:'not_ready'}`；连接不断

---

### R1-6 · 上行 bad JSON → error；连接不断
**步骤**: 发送文本 `not-json`
**预期**: `{type:'error', code:'bad_request'}`；再发合法 subscribe 仍正常

---

### R1-7 · 每条下行 event 必带 id
**步骤**: subscribe global；后端触发任意 10 条白名单事件。
**预期**: 每条下行 `{type:'event', id:<非空字符串>, event:{...}}`；id 在本连接内全局唯一。所有事件的 id 均来自 bus 事件的 `eventId`（comm.* 里 eventId = messageId，driver.* 与其他事件为 UUID；**不引入 driver seq counter**，与 MILESTONE §5.6 一致）

---

### R1-8 · 关闭连接清理订阅 + user 注销
**步骤**: 连接 → subscribe → 关闭 → 用管理端查询
**预期**: `subscriptionManager.stats().conns` 回退；`commRegistry.getConnection('user:u1')` 为 undefined

---

### R1-9 · 超量 gap 翻页（arch-ws-b 审查补）
**前置**: messageStore 中 `team_01` 有 10 条历史 `msg_2000` ~ `msg_2009`；`gap-replayer` `maxItems=3`。

**步骤**：
1. WS 连接 + `{op:'subscribe', scope:'team', id:'team_01', lastMsgId:'msg_1999'}`
2. 收到第一批 gap-replay 后，取其 `upTo` 作为新 `lastMsgId`，再发第二次 `{op:'subscribe', scope:'team', id:'team_01', lastMsgId:'<upTo>'}`
3. 重复直到 upTo 为 null 或空 items

**预期**：
- 第一次：`items.length === 3`；`upTo` 指向**第三条已推送消息的 id**（翻页游标）；不抛错
- 第二次/后续：严格推 `id > 前次 upTo` 的消息；最多 3 条；最终一次 `items.length < 3 && upTo === 最末消息 id` 或 `items=[] && upTo=null`
- 翻页过程中 item id 无重复、无遗漏（10 条一条不少）
- 符合 MILESTONE §5.3 + TASK-LIST W1-C "超量 gap 契约"（丑但有界，明码标价）

---

### R1-10 · subscribe user scope 越权被拒（arch-ws-b 审查新增）
**步骤**: 连接 `/ws/events?userId=u1` 后发 `{op:'subscribe', scope:'user', id:'u2'}`
**预期**: 回 `{type:'error', code:'forbidden'}`；`subscriptionManager.list(connectionId)` 不含 user:u2；连接不断

---

## 2. 功能 2：业务过滤器

### R2-1 · 无规则 → default_allow
**前置**: `visibility_rules` 表空。
**步骤**: user u1 subscribe global，触发 `team.member_joined`
**预期**: u1 的 WS 收到该事件

---

### R2-2 · deny 规则短路
**前置**: 插 rule `{principal:user u1, target:agent i1, effect:'deny'}`
**步骤**: u1 subscribe global；触发 `comm.message_sent` from=i1, to=u1
**预期**: u1 不收到

---

### R2-3 · allow 规则明确放行
**前置**: `{principal:user u1, target:team t1, allow}`
**步骤**: u1 subscribe team:t1；触发 `team.member_joined` teamId=t1
**预期**: u1 收到；断言 visibility-filter decide byRuleId 非 'default_allow'

---

### R2-4 · deny 优先于 allow
**前置**: 同一 principal u1 对同一 target 既有 deny 又有 allow
**步骤**: 触发事件
**预期**: deny 生效（事件被 drop）

---

### R2-5 · filter-store 运行期 upsert 立即生效
**步骤**: 连接已建立 → `filterStore.upsert(新 deny rule)` → 触发该 rule 覆盖的事件
**预期**: 事件被过滤（过滤器每次 canSee 都读当前 store，不缓存）

---

### R2-6 · comm 层零 filter import（静态）
**验证命令**: `grep -rE "from ['\"].*/filter/" packages/backend/src/comm/`
**预期**: 0 结果

---

### R2-7 · DB 表独立
**验证命令**: `sqlite3 <db> ".schema visibility_rules"`
**预期**: 表存在；无外键引用 `messages` / `role_instances`（保持 filter 独立）

---

## 3. 功能 3：通知系统

### R3-1 · proxy_all 模式：通知发给 primary agent
**前置**: `notification_configs` mode='proxy_all'；primary agent instance 存在且 READY
**步骤**: 触发 `container.crashed`
**预期**: `commRouter.dispatch` 被调 1 次（to = primary agent address）；前端 user 连接**不**直接收到 `notification.delivered`

---

### R3-2 · direct 模式：通知直接推给 user
**前置**: mode='direct'
**步骤**: user u1 subscribe global；触发 `team.member_joined`
**预期**: u1 收到 `{type:'event', event:{type:'notification.delivered', target:{kind:'user',id:'u1'}, sourceEventType:'team.member_joined', ...}}`

---

### R3-3 · custom 模式 + 通配命中
**前置**: mode='custom'，rules=[{matchType:'team.*', to:{kind:'user', userId:'u1'}}]
**步骤**: 触发 `team.created`
**预期**: notification.delivered target=user:u1

---

### R3-4 · custom 模式全不命中 → drop
**前置**: mode='custom'，rules=[{matchType:'container.*', to:{kind:'drop'}}]
**步骤**: 触发 `team.created`
**预期**: 无 commRouter.dispatch，无 notification.delivered

---

### R3-5 · 非白名单事件不走通知系统
**步骤**: 触发 `driver.text`
**预期**: notification.subscriber 不产生任何动作；`driver.text` 仍通过普通订阅路径推给前端（R4-2 覆盖）

---

### R3-6 · proxy_all 且 primary agent 不在线 → fallback direct
**前置**: mode='proxy_all'；primary agent driver 不在 registry
**步骤**: 触发 `container.crashed`
**预期**: notification.delivered target=user；stderr 有 warn 行（可选校验）

---

### R3-7 · notification_configs DAO 回写
**步骤**: `notificationStore.upsert({id:'default',userId:null,mode:'custom',rules:[...]})` → 重启后端 → `get(null).mode === 'custom'`
**预期**: 配置持久化

---

## 4. 功能 4：user comm 注册

### R4-1 · WS 连接后 commRegistry 出现 user:u1
**步骤**: 连 `/ws/events?userId=u1`
**预期**: `commRegistry.getConnection('user:u1')` 非空；`commRegistry.has('user:u1')` true

---

### R4-2 · 发给用户的 envelope 通过 WS 到达
**前置**: agent inst_leader send_msg(to:'user:u1', summary:'hi', content:'你好')
**步骤**: 观察 u1 WS
**预期**: u1 收到 `{type:'event', id:'msg_XXX', event:{type:'comm.message_received', ...}}` 且 `GET /api/messages/msg_XXX` 返回完整 envelope（验证 commRouter 走的是 socket 分支）

---

### R4-3 · agent 回复通过 driver.text 推送（不走 comm）
**前置**: u1 subscribe instance:inst_leader；随后 `driver.prompt('帮我看下 X')`
**步骤**: agent 产生 assistant 回复
**预期**：
- u1 WS 收到一条或多条 `{type:'event', event:{type:'driver.text', driverId:'inst_leader', content:'...'}}`
- `messages` 表**未**新增行（不落库）
- commRouter.dispatch 未被调用

---

### R4-4 · 连接断开注销 user
**步骤**: u1 断开 → wait 100ms → 查 registry
**预期**: `getConnection('user:u1')` 为 undefined

---

### R4-5 · 同 userId 多 tab：后注册覆盖，旧连接下次写失败
**步骤**: u1 连接 A → u1 连接 B → agent send_msg to:'user:u1'
**预期**: B 收到消息，A 不收到（shim.destroyed 后 router 走 offline 分支）

---

## 5. 跨功能集成（端到端场景）

### R5-1 · 经典聊天回环
**场景**: user 发消息 → agent 回复 → user 收到 driver.text；全程用 WS

**步骤**：
1. 连接 `/ws/events?userId=local`
2. `{op:'subscribe', scope:'instance', id:'inst_leader'}`
3. `{op:'prompt', instanceId:'inst_leader', text:'你好'}`
4. 等 agent turn_done

**预期**:
- step 3 收到 ack
- 之后陆续收到 driver.thinking / driver.text / driver.turn_done
- user 无需调 `read_message`，直接看到 driver.text 渲染

---

### R5-2 · 团队聊天多人订阅隔离
**步骤**：
1. A 连接 subscribe team:t1
2. B 连接 subscribe team:t2
3. 在 t1 内 agent send_msg 广播
**预期**: A 收到 comm.message_sent；B 不收到

---

### R5-3 · 断线重连 gap-replay
**步骤**：
1. 连接 → subscribe team:t1
2. 收到 msg_1010
3. 断开（记 lastMsgId=msg_1010）
4. 后端期间有 msg_1011, msg_1012
5. 重连 `subscribe` 带 lastMsgId=msg_1010
**预期**: 重连后先收到 gap-replay 含 msg_1011, msg_1012；后续不重复推送

---

### R5-4 · 订阅撤销后不再推
**步骤**: subscribe team:t1 → 收到 ≥1 条 → unsubscribe team:t1 → 后端再发 team:t1 事件
**预期**: unsubscribe 后不再收到

---

### R5-5 · 过滤器 + 订阅 + 通知三件齐动（arch-ws-b 审查修正：双推冲突）
**场景**：
- user u1 subscribe global
- 过滤规则：u1 deny agent inst_leak
- 通知：mode='direct'

**步骤**: 后端触发 3 类事件：(a) `comm.message_sent` from=inst_leak to=team；(b) `team.member_joined` teamId=t1（notifiable 白名单内）；(c) `driver.text` driverId=inst_leak

**预期**:
- (a) 过滤器 canSee=deny → drop（u1 不收）
- (b) 产出两条 bus 事件：原 `team.member_joined`（订 global 会命中）和新 `notification.delivered{target:user:u1, sourceEventType:'team.member_joined', sourceEventId:<同一个 eventId>}`；u1 收到 2 条下行 event，**但 id 不同**（原事件 id=eventId_A，通知事件 id=eventId_B），**前端按 sourceEventId 识别关系不做去重**（通知只是"指针"，原事件是"正文"），UI 可以选择把通知高亮在原事件旁
- (c) 过滤器 target=inst_leak 命中 deny → drop

**note**：原版本 `(b) 作为通知推到 u1`（言下之意只收一条）与"订 global 会收本体"冲突，按 TASK-LIST W2-6 bus 事件扩展段 arch-ws-b 审查结论修正 —— 通知 payload 去掉 sourceEventPayload，改 sourceEventId 指针，两事件分离推送。

---

### R5-6 · 非 comm 事件不走 gap-replay（arch-ws-b 审查新增）
**前置**: 断线期间后端触发 2 条 `team.member_joined` + 2 条 `instance.created` + 2 条 `comm.message_sent`
**步骤**: 重连 subscribe team:t1 带 `lastMsgId=<断线前最后一条 comm msg_id>`
**预期**:
- gap-replay items 只含 2 条 comm.message_sent（`type: 'comm.message_sent'`）
- 不含 team.member_joined / instance.created（这类状态事件重连后走 HTTP 拉快照，不走 gap）
- 符合 MILESTONE §5.3 决策

---

## 6. 非功能 / 防漂移

### R6-1 · 每文件 ≤ 200 行
**命令**:
```
find packages/backend/src/ws packages/backend/src/filter packages/backend/src/notification \
  -name '*.ts' -not -name '*.test.ts' -exec wc -l {} + | awk '$1>200'
```
**预期**: 输出为空（无超长文件）

---

### R6-2 · comm 层零 filter / notification / ws 业务 import
**命令**:
```
grep -rnE "from ['\"]\\.\\./(filter|notification|ws)/" packages/backend/src/comm/
```
**预期**: 0 行

---

### R6-3 · 非业务模块不 import 业务代码（静态）
**非业务模块**: `ws/protocol.ts`、`ws/subscription-manager.ts`、`ws/gap-replayer.ts`、`filter/types.ts`、`filter/filter-store.ts`、`notification/types.ts`、`notification/notification-store.ts`

**命令**（对每个文件）:
```
head -50 <file> | grep -E "^import " | grep -vE "from ['\"]node:|^import type|from ['\"]\\./"
```
**预期**: 非业务模块只允许 `import type`、nodejs 内置、或同目录 `./` 同级（纯内部拆）。业务模块（`bus/*`、`comm/*`、`http/*`）的运行时 import 不应出现。

---

### R6-4 · bun test 全绿
**命令**: `cd packages/backend && bun test`
**预期**: exit 0，无 failed；覆盖率>既有 baseline（若统计）

---

### R6-5 · WS_EVENT_TYPES 白名单扩张受控
**检查**: `bus/subscribers/ws.subscriber.ts::WS_EVENT_TYPES.size === 35`（新增 `notification.delivered`）
**测试文件**: `bus/subscribers/ws.subscriber.test.ts`（已有的 W2-H 守门测试，本期更新期望数字）

---

### R6-6 · INTERFACE-CONTRACTS.md 未漂移
**命令**: `git diff main -- packages/backend/docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md`
**预期**: 空（本 Phase 不修该文件）

---

## 7. 失败处理流程

如有任何条目 FAIL：
1. 开 issue/task，标注 R 编号、复现步骤、实际结果
2. 交回修复员（WORKFLOW.md §4）
3. 修复员改完 + 更新对应 README.md；新测试员**重跑本条**（不是全部）
4. 重测通过 → 本 Phase 完成

---

## 8. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版（38 条回归点，覆盖 4 功能 + 5 场景 + 6 防漂移） | arch-ws-a |
| 2026-04-25 | arch-ws-b 审查：新增 R1-9 超量 gap 翻页 / R1-10 user 越权 / R5-6 非 comm 不补；修 R5-5 双推去歧义 | arch-ws-a |
