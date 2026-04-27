# Phase 通信链路修复 — TASK-LIST

**版本**：v1 · **日期**：2026-04-25 · **架构师**：arch-comm-fix-a · **对抗**：arch-comm-fix-b（独立方案，本文件内列出反方观点 + 采纳理由）

> 本期范围：审计发现的 6 个问题的收敛修复。**不扩 phase-comm 的架构、不动冻结契约**，只补漏。
> 所有行号基于 HEAD（2026-04-25），改造前先 `git log <file>` 确认。

---

## 关键决策（先定原则，再拆任务）

### D1 · 问题 2 方案：**轻 bus + WS 下行层 enrich**（融合方案，区别于纯 A / 纯 B）

**反方 arch-comm-fix-b 方案 A**：`comm.message_sent` / `comm.message_received` 的 payload 扩成完整 Envelope（summary / content / from.displayName / kind / replyTo / attachments…），一次推完。

**采纳方案**：bus 事件 payload **冻结不动**；在 `ws/ws-broadcaster.ts` 的下行转换层（`toWsPayload`）按 messageId 反查 `MessageStore`，enrich 成 `WsCommEventDown`，下行给 client。

**为什么不选 A（反方观点的致命伤）**：
1. **id:378 决策锁死**：phase-comm v2 评审明确记录「不扩 bus event payload，走 messageId + HTTP 反查」，理由是保持订阅者 schema 不破。反方方案直接推翻前决策，需要重新对齐所有 subscriber（notification / log / comm-notify / bus-bridge…）。
2. **id:387 守门测试会红**：`ws.subscriber.test.ts` 锁死 `WS_EVENT_TYPES.size === 34` + `CommMessageSentEvent` 字面量字段 `{type, ts, source, messageId, from, to}`。扩字段即刻挂测试；想扩必须同时改守门基线 = 自毁契约。
3. **bus 是内部契约，WS 是外部契约**，两者应分离：内部事件服务于 subscriber 逻辑（落库 / 通知 / 审计），不该塞前端 UI 字段。`ws-broadcaster.toWsPayload` 本就是转换层，enrich 放这里最自然。
4. **性能成本极低**：reviewer-comm 担心「反查 = 额外 SQL」—— 但 `messageStore.findById` 是 prepared statement，< 0.5ms。相比前端多发一次 HTTP（RTT + fetch 开销 + 状态管理），本地反查一次是净收益。

**为什么不选原 B（保持轻 payload + 前端 HTTP 反查）**：
- 审计结论已经指出「前端要二次 HTTP」是实际痛点。保守做法虽然稳，但没解决问题。
- 既然要解决，就要把 enrich 做进 WS 下行，而不是让前端多一跳。

**具体下行形状**（对 `comm.message_sent` / `comm.message_received`）：
```typescript
// ws-broadcaster.toWsPayload 命中 comm.* 时 enrich 后的事件
interface WsCommEventDownPayload {
  type: 'comm.message_sent' | 'comm.message_received';
  ts: string;
  eventId?: string;           // 保持原字段
  messageId: string;
  from: string;               // 原 address
  to: string;                 // 原 address
  route?: string;             // received 独有
  // ↓ W2-H 以来冻结的 bus payload 字段结束 ↓
  // ↓ 下行层新增 envelope 字段（bus payload 不含）↓
  envelope: {
    summary: string;
    content?: string;         // 可关闭开关控制带不带全文（见 T-1 §note）
    kind: 'chat' | 'task' | 'broadcast' | 'system';
    from: { kind: string; address: string; displayName: string; instanceId: string | null };
    to:   { kind: string; address: string; displayName: string; instanceId: string | null };
    replyTo: string | null;
    teamId: string | null;
    readAt: string | null;
    attachments?: Array<{ type: string; [k: string]: unknown }>;
  };
}
```

**note**：`content` 默认带（聊天场景小体积）；未来若 attachments 体积失控，加开关按 scope 决定是否带。本期先全带，<1KB 文本不值得做开关。

**契约影响**：
- `bus/types.ts::CommMessageSentEvent` / `CommMessageReceivedEvent` **字段不变** → id:387 守门测试继续通过。
- `ws/ws-broadcaster.ts::toWsPayload` 对 comm.* 做 enrich → 新增 ws-broadcaster 单测验证 enrich 形状。
- `renderer` 前端消费 `event.envelope.*`，可删除现有二次 HTTP `GET /api/messages/:id` 的 UI 链路（仅保留用户主动打开详情时调，保留能力不删接口）。

---

### D2 · 问题 4 方案：**两端默认值保持现状，仅做文档同步**（裁决 B-1）

**背景差异**：
- `check_inbox.ts` MCP 工具默认 `peek=false` → 默认「标已读」
- `messages.routes.ts::handleInbox` 默认 `peek=true`（代码 line 111：`peekRaw === null ? true : peekRaw !== 'false'`）→ 默认「不标已读」

**裁决（team-lead B-1）**：**不翻 HTTP 默认值**，保留 `peek=true`。

**理由**：
1. HTTP 面板调用场景下「打开面板 = 清未读」会破坏多窗口/刷新/调试器中间的一致性。默认不标已读更保守、更符合 HTTP 语义（GET 应该幂等可读）。
2. MCP 的 `peek=false` 默认是 agent 行为契约（看完 = 读完），与 HTTP 场景不同，不强求统一。
3. W1-B 降为**纯文档同步**，在 `docs/frontend-api/messages-api.md` + `check_inbox.ts` JSDoc 明确写「两端默认值不同，如需对齐 MCP 请显式传 `peek=false`」。

---

### D3 · 问题 5 方案：**本期只做 displayName override，不开 agent 分支**（裁决 B-2）

**现状**：`messages.routes.ts::handleSend` 强制 `fromKind='user'`，并 warn 忽略 client 传入的 `from` 字段。

**裁决（team-lead B-2）**：本期**不放开 fromKind=agent**，`fromKind` 仍然强注入为 `user`；只开放 `body.from.displayName` 覆盖默认 `'User'` 的能力。

**采纳范围**：
- `fromKind` 继续强注入 `user`。`body.from.kind` 若存在且 != 'user' → 400。
- 允许 `body.from.displayName`（string）覆盖默认的 `'User'` 显示名。用于调试工具/多窗口区分发送者身份。
- 其余 body.from.* 字段继续忽略（warn 仅对 displayName 以外的字段）。

**Why 缩小范围**：
1. 开 agent 分支引入伪造风险，鉴权未落地前不应开放。
2. 前端当前 UI 面板没有「以 agent 身份代发」场景需求，过度设计。
3. displayName override 是低风险纯显示层调整（只影响 envelope.from.displayName 字段），不动身份语义。

**Future work**（非本期）：Phase 2 鉴权落地后再开 agent 分支，加 token 校验。

---

## Wave 划分

### Wave 1（独立模块，可并行 3 路）

**W1-A · 问题 1**：`InProcessComm.fromLookup` 查表补 displayName
**W1-B · 问题 4**：纯文档同步（两端 peek 默认值差异写进文档，不改代码）
**W1-C · 问题 6**：代码卫生（`void store` 等无意义冗余）

三者无共享文件，可并行。

### Wave 2（有依赖 / 跨模块）

**W2-A · 问题 2**：`ws-broadcaster.toWsPayload` 对 comm.* 做 envelope enrich
**W2-B · 问题 3**：`gap-replayer` 同时补 `comm.message_received`
**W2-C · 问题 5**：`handleSend` 只开 `body.from.displayName` override，不开 agent 分支

W2-A 不需要 W2-B 依赖（形状最终定稿在 W2-A 的 enrichCommEnvelope 里，gap-replay **明确不 enrich**）。W2-C 与 W1-C 同文件（messages.routes.ts），Wave 2 串行执行避免冲突。

---

## Wave 1 任务

### W1-A · 问题 1：InProcessComm 查表补 displayName

**文件**：`packages/backend/src/mcp-http/in-process-comm.ts`

**现状**（line 41-53）：
```typescript
fromLookup: { instanceId: fromId, memberName: fromId, displayName: fromId },
```
`displayName` 直接用 instanceId 填，agent 间通信的通知行显示裸 UUID。

**改法**：
1. 构造时可选注入 `lookupAgentByInstanceId`（便于测试 stub）；默认 `import { lookupAgentByInstanceId } from '../comm/agent-lookup.js'`。
2. `send()` 内对 `fromId` 调 lookup：
   - 命中：用返回的 `{instanceId, memberName, displayName}`
   - 未命中：保留现状三字段全填 `fromId`（fail-soft，避免启动期未入库时崩）

**伪代码**：
```typescript
const fromLookup =
  lookupAgentByInstanceId(fromId)
  ?? { instanceId: fromId, memberName: fromId, displayName: fromId };
```

**行数预算**：文件 +3 行（import + 1 行 lookup + 注释）。总 65 → 68 行，远低于 200 行红线。

**完成判据**：
- `in-process-comm.test.ts` 新增两条断言：
  - 注入 lookup stub 返 `{displayName: '老王'}` → envelope.from.displayName === '老王'
  - 注入 lookup stub 返 null → envelope.from.displayName === fromId（保留兜底）
- `bun test` 绿
- `tsc --noEmit` 绿

---

### W1-B · 问题 4：纯文档同步（不改代码，裁决 B-1）

**裁决**：team-lead B-1 判定**不翻 HTTP 默认值**。HTTP `handleInbox` 保留 `peek=true`，MCP `check_inbox` 保留 `peek=false`。两端默认值不同是有意的（见 D2）。

**文件（仅文档 + JSDoc）**：
1. `packages/backend/src/mcp/tools/check_inbox.ts`：`checkInboxSchema.description` 加一句「HTTP 端默认 peek=true（不标已读）；如需对齐本工具请显式传 peek=false」。
2. `packages/backend/src/http/routes/messages.routes.ts`：`handleInbox` 函数顶 JSDoc 写清「默认 peek=true；对齐 MCP 需显式 peek=false」。
3. `docs/frontend-api/messages-api.md`（若存在 inbox 章节）：补说明两端语义差异 + 显式传参示例。

**代码改动**：**零行**（仅注释 + docs）。

**完成判据**：
- `docs/frontend-api/messages-api.md` diff 清楚说明两端语义。
- `check_inbox.ts` / `messages.routes.ts` JSDoc 新增注释可 `grep -n "peek=false"` 命中。
- 不改任何测试（因行为未变）。
- `tsc --noEmit` 绿（注释 + JSDoc 零风险）。

**不做**：不改 `handleInbox` 行为；不改 renderer；不追加 REGRESSION 任务。

---

### W1-C · 问题 6：代码卫生

**文件**：`packages/backend/src/http/routes/messages.routes.ts`

**具体清理**：
1. line 86 `void store; // store 的落库在 router.dispatch 内部完成（W2-C 同步落库契约）`
   - 死代码：`store` 变量从 `getMessagesContext()` 里拿出来但没用。
   - 改法：解构时不要 `store` —— `const { router } = getMessagesContext();`
   - 删除 `void store` 行 + 保留注释作为「不手动落库」的 why 提示放 dispatch 之后一行。

2. grep 全仓库 `void [a-z]` 无意义忽略 —— 本期只修 messages.routes.ts 这一处，其他避免扩散。

**行数影响**：-2。

**完成判据**：
- `tsc --noEmit` 绿
- `bun test http-mcp-tools.test.ts` 绿
- diff 仅删除 2 行，无行为改动

---

## Wave 2 任务

### W2-A · 问题 2：ws-broadcaster.toWsPayload 对 comm.* enrich envelope

**文件**：
- `packages/backend/src/ws/ws-broadcaster.ts`（主改动）
- `packages/backend/src/ws/ws-broadcaster.test.ts`（补测）

**改法**（D1 已定）：

1. 新增 helper（同文件，<30 行）：
```typescript
/**
 * 对 comm.message_sent / comm.message_received 事件，按 messageId 反查 MessageStore，
 * 在 WS 下行 payload 追加 envelope 字段，省前端二次 HTTP。bus 原 payload 不扩，守门测试不挂。
 * store.findById 命中失败 → 退化到不带 envelope（fail-soft，前端依然可走 HTTP 反查兜底）。
 */
function enrichCommEnvelope(
  base: Record<string, unknown>,
  event: BusEvent,
  store: MessageStore,
): Record<string, unknown> {
  if (event.type !== 'comm.message_sent' && event.type !== 'comm.message_received') {
    return base;
  }
  const env = store.findById(event.messageId);
  if (!env) return base;
  return {
    ...base,
    envelope: {
      summary: env.summary,
      content: env.content,
      kind: env.kind,
      from: { kind: env.from.kind, address: env.from.address, displayName: env.from.displayName, instanceId: env.from.instanceId ?? null },
      to:   { kind: env.to.kind,   address: env.to.address,   displayName: env.to.displayName,   instanceId: env.to.instanceId ?? null },
      replyTo: env.replyTo,
      teamId: env.teamId,
      readAt: env.readAt,
      attachments: env.attachments,
    },
  };
}
```

2. `WsBroadcasterDeps` 新增 `messageStore: MessageStore`（non-optional，http/server.ts 接线处传入）。

3. `dispatch()` 内 —— **每条事件查询一次，然后在 client 循环里复用**（裁决 R-1：enrichCommEnvelope 必须放循环外，避免 N 个连接 N 次 SQL）：
```typescript
private dispatch(event: BusEvent): void {
  const id = extractEventId(event);
  // enrichCommEnvelope 对同一条事件只调一次（SQL 查一次 / 命中 null 兜底一次）。
  // 之后在 client 循环里复用同一个 payload object，零拷贝零额外 SQL。
  const payload = enrichCommEnvelope(toWsPayload(event), event, this.deps.messageStore);
  for (const [connectionId, client] of this.clients) {
    if (client.ws.readyState !== WS_OPEN) continue;
    if (!this.deps.subscriptionManager.match(connectionId, event)) continue;
    if (!this.deps.visibilityFilter.canSee(client.ctx.principal, event)) continue;
    const down: WsEventDown = { type: 'event', id, event: payload };
    sendSafe(client.ws, down);
  }
}
```

4. `http/server.ts` 构造 WsBroadcaster 处注入 `messageStore`（已有上下文，1 行改动）。

5. `bus/types.ts` **不动**。`CommMessageSentEvent` / `CommMessageReceivedEvent` 保留现有字段。

**行数预算**：ws-broadcaster.ts 166 → ~200 行，卡红线内。若超，把 enrichCommEnvelope 抽到 `ws/enrich-comm.ts`（独立非业务文件）。

**完成判据**：
- `ws-broadcaster.test.ts` 新增 5 条：
  - comm.message_sent 命中 store → payload.envelope.summary === env.summary / content === env.content / from.displayName 正确
  - comm.message_received 命中 store → payload.envelope.to.displayName 正确 / 带 route 字段
  - store.findById 返回 null → payload 不含 envelope 字段（且不抛）
  - 非 comm 事件（driver.text / instance.created） → payload 不含 envelope 字段
  - **R-1 性能断言**：mock store 计 findById 调用次数，3 个 client 订阅同一条 comm.message_sent → store.findById 恰好调用 1 次
- W2-H 守门测试 `bus/subscribers/ws.subscriber.test.ts` **继续绿**（WS_EVENT_TYPES size === 34，bus 事件字段冻结）
- `tsc --noEmit` 绿
- 前端契约文档 `docs/frontend-api/messages-api.md` / `docs/frontend-api/message-flow.md` / `docs/frontend-api/bus-events.md` 更新：comm.message_sent / comm.message_received 在 WS 实时路径下行 payload 增 `envelope` 字段（去重仍按 envelope.id）

**REGRESSION 关注**：renderer 里已有按 messageId 调 `GET /api/messages/:id` 的代码（WS 事件推到 → fetch envelope）可删，但**本期不删 renderer**（前端让 team 里前端 agent 另起 PR 做），本期只补能力，前端改动解耦。

**策略**：直接启用 enrich，不加 feature flag。理由：findById 是 prepared statement <0.5ms，失败路径已 fail-soft（findById 返 null → 不带 envelope）。生产若真有问题，走回滚 commit，不走运行时开关。

---

### W2-B · 问题 3：gap-replayer 补 comm.message_received

**文件**：
- `packages/backend/src/ws/gap-replayer.ts`（主改动）
- `packages/backend/src/ws/gap-replayer.test.ts`（补测）

**现状**（gap-replayer.ts line 47-55）：`envelopeToEvent` 只吐 `comm.message_sent`。断线期间 agent 已读的消息，客户端收不到 `comm.message_received`，未读→已读状态转换丢失。

**改法**：

1. `fetchCandidates` 对 `instance` / `user` scope 已经用 `findUnreadForAddress`，只能拿到**未读**。但「已读但 sent_at 在 lastMsgId 之后」的消息也需要被补（断线期间 agent 已读了，客户端状态没跟上）。
2. 需要 message-store 新增 `findMessagesAfter(address, lastMsgId)` —— 含已读+未读。**Wave 2 子任务 W2-B.0 先扩 DAO**。
3. gap-replayer 改动：
   ```typescript
   function envelopeToEvents(env: MessageEnvelope): Array<Record<string, unknown>> {
     const sent = {
       type: 'comm.message_sent',
       ts: env.ts,
       messageId: env.id,
       from: env.from.address,
       to: env.to.address,
     };
     if (env.readAt !== null) {
       return [sent, {
         type: 'comm.message_received',
         ts: env.readAt,
         messageId: env.id,
         from: env.from.address,
         to: env.to.address,
         route: 'replay',  // 复用 router.emit 'replay' 语义
       }];
     }
     return [sent];
   }
   ```
4. `buildGapReplay` 把 `items` 从「1 env → 1 item」改为「1 env → 1~2 items」。**截断以 envelope 为单位**（Q4 修正，不打断同一 envelope 的 sent/received pair）：
   ```typescript
   const items: GapReplayItem[] = [];
   let lastFullEnvId: string | null = null;
   for (const env of after) {
     const evs = envelopeToEvents(env);
     if (items.length + evs.length > maxItems) break;  // 不切开 sent/received pair
     for (const ev of evs) items.push({ id: env.id, event: ev });
     lastFullEnvId = env.id;  // 只有完整推完 sent+received 才记
   }
   const upTo = lastFullEnvId;  // 可能为 null（第一个 envelope 就超限 → 本轮推空，客户端下次重试）
   ```
   **边界**：若第一个 envelope 的 events 就超 maxItems（极少，只在 maxItems=1 且已读消息时发生），`upTo=null`，客户端本次拿空批，不会"永远补不齐" —— 客户端用原 lastMsgId 继续订阅，下一轮 maxItems 再试即可。测试覆盖这条。

**W2-B.0 前置**：`comm/message-store.ts` 新增方法
```typescript
findMessagesAfter(address: string, lastMsgId: string, limit: number): MessageEnvelope[];
```

**正确的 SQL 分支**（Q2 修正 —— `messages` 表**没有 `to_address` 列**，参考 `findUnreadForAddress` line 205-230 的三分支结构）：

```typescript
// 伪代码。三分支对齐 findUnreadForAddress + 含已读 + 联合游标 (sent_at, id) 防同毫秒漏/重。
// 先用子查询把 lastMsgId 解析为 (sent_at, id) 双字段游标：
//   SELECT sent_at, id FROM messages WHERE envelope_uuid = ?  —— 走 UNIQUE idx_msg_env_uuid
// 然后三分支按地址 kind 各自加 to_* 过滤：
//
// user:<uid>：
//   SELECT * FROM messages
//    WHERE to_user_id = ?
//      AND (sent_at > ? OR (sent_at = ? AND id > ?))    -- 联合游标
//    ORDER BY sent_at ASC, id ASC
//    LIMIT ?
//
// local:system：
//   SELECT * FROM messages
//    WHERE to_kind = 'system' AND to_instance_id IS NULL
//      AND (sent_at > ? OR (sent_at = ? AND id > ?))
//    ORDER BY sent_at ASC, id ASC
//    LIMIT ?
//
// local:<instId>：
//   SELECT * FROM messages
//    WHERE to_instance_id = ?
//      AND (sent_at > ? OR (sent_at = ? AND id > ?))
//    ORDER BY sent_at ASC, id ASC
//    LIMIT ?
//
// lastMsgId 不存在（已被清理）时：子查询返 null → 三分支都退化为无游标，等价于
//   "当前地址最早的 limit 条"。不抛，fail-soft。
// 其他 address 前缀（不认识）→ 返回空数组，不抛。
```

含已读（不加 `read_at IS NULL`）。游标必须联合 `(sent_at, id)`：ORDER BY 本就是 `sent_at ASC, id ASC`（见 line 199），只按 sent_at 比较会在同一毫秒多条消息时漏/重。

5. `fetchCandidates` 对 instance/user scope 切到新方法：
```typescript
return store.findMessagesAfter(addressForScope, lastMsgId, budget);
```
（team scope 已走 listTeamHistory，历史本就含已读，不需要改）

**行数预算**：
- message-store.ts：+~40 行（一个新 method，三分支 + 游标解析）
- gap-replayer.ts：148 → ~180 行

**完成判据**：
- `gap-replayer.test.ts` 新增 5 条：
  - 断线期间有 1 条已读消息 → gap-replay.items 长度 === 2（sent + received）
  - 断线期间有 1 条未读 + 1 条已读 → 3 items（2 sent + 1 received）
  - **Q4 边界 1**：maxItems=3，实际 env1(未读, 1 ev) + env2(已读, 2 ev) + env3(已读, 2 ev) → items 长度 === 3（env1.sent + env2.sent + env2.received），upTo === env2.id（env3 整个被截掉，下次从 env2 后续拉）
  - **Q4 边界 2**：maxItems=1，实际 env1(已读, 2 ev) → items 长度 === 0，upTo === null（第一个 envelope 就超限，本轮推空，客户端下次重试）
  - **Q4 正常**：maxItems=2，实际 env1(未读, 1 ev) + env2(未读, 1 ev) → items 长度 === 2，upTo === env2.id
- `message-store.test.ts` 新增 `findMessagesAfter` 单测（5 条）：
  - user 地址 3 条含已读按序全返
  - local:instId 地址 2 条含已读按序返
  - local:system 地址命中 `to_kind='system' AND to_instance_id IS NULL`
  - **Q2 同毫秒游标**：插入 sent_at 相同、id 递增的 2 条，lastMsgId=第一条 → 只返第二条（不漏不重）
  - lastMsgId 不存在 → 退化为"最早 limit 条"（不抛）
- `tsc --noEmit` 绿
- phase-ws W1-C 原 REGRESSION 回归绿（跨模块）

**依赖**：W2-A 的 enrich 不影响 gap-replay（gap 走轻 payload 路径，不过 ws-broadcaster，也不 enrich —— 前端对 gap 里的 comm.* 走 HTTP 兜底拉详情是 OK 的）。**决策**：gap-replay 不 enrich，理由：gap 是批量补发，量可能大，inline envelope 会放大包体积；前端对 gap 里的每条消息按需打开时再拉。

---

### W2-C · 问题 5：handleSend 允许 displayName override（裁决 B-2，缩小范围）

**文件**：`packages/backend/src/http/routes/messages.routes.ts`

**范围（本期）**：
- `fromKind` **继续强注入为 `user`**，不开 agent 分支。
- `body.from.kind` 若存在且 !== `'user'` → 400（HTTP 始终禁止 agent / system）。
- 允许读取 `body.from.displayName`（string 非空）→ 透传 `fromDisplayNameOverride`，让 envelope.from.displayName 从默认 `'User'` 替换为请求给的值。

**改法**：

1. 改 line 46-49 warn 逻辑 → 白名单 + displayName 校验（Q3）：
   ```typescript
   const DISPLAY_NAME_MAX = 64;  // Q3：displayName 长度上限，防注入/撑爆

   let fromDisplayNameOverride: string | undefined;
   const fromRaw = body.from;
   if (fromRaw !== undefined) {
     if (!isObj(fromRaw)) return err(400, 'from must be an object if provided');
     // 本期只接受 kind='user' 且只取 displayName；其他字段忽略并 warn。
     if (fromRaw.kind !== undefined && fromRaw.kind !== 'user') {
       return err(400, `from.kind='${String(fromRaw.kind)}' not allowed; HTTP send is user-only in this phase`);
     }
     if (fromRaw.displayName !== undefined) {
       if (typeof fromRaw.displayName !== 'string') {
         return err(400, 'from.displayName must be a string');
       }
       const trimmed = fromRaw.displayName.trim();
       if (trimmed.length === 0) {
         return err(400, 'from.displayName must be non-empty after trim');
       }
       if (trimmed.length > DISPLAY_NAME_MAX) {
         return err(400, `from.displayName exceeds ${DISPLAY_NAME_MAX} chars`);
       }
       // 不做 HTML 转义：渲染层责任，此处只做长度/空白校验。
       fromDisplayNameOverride = trimmed;
     }
     // 其他字段（address / instanceId 等）本期忽略，warn 一次提示调用方。
     const ignoredKeys = Object.keys(fromRaw).filter(
       (k) => k !== 'kind' && k !== 'displayName',
     );
     if (ignoredKeys.length > 0) {
       // eslint-disable-next-line no-console
       console.warn(`[messages.routes] from.${ignoredKeys.join('/')} ignored (user-only phase)`);
     }
   }
   ```

2. `buildEnvelope` 入参加一行 `fromDisplayNameOverride`：
   ```typescript
   const env = buildEnvelope({
     fromKind: 'user',             // 继续强注入 user
     fromAddress: 'user:local',    // 不接受客户端 address 覆盖
     fromDisplayNameOverride,      // ← 本期新增
     toAddress: to.address,
     toLookup: lookup,
     summary: ...,
     content,
     kind: kindRaw as ...,
     replyTo: ...,
     attachments: ...,
   });
   ```

3. 文件顶部注释更新：`// 本期允许 body.from.displayName 覆盖默认 'User'；kind/address 仍强注入 user。`

**行数预算**：158 → ~180 行，安全。

**完成判据**：
- `http-sessions.test.ts` 或 `http-mcp-tools.test.ts` 补 7 条：
  - 不传 from → envelope.from.displayName === 'User'（默认，向后兼容）
  - from={displayName:'测试脚本A'} → envelope.from.displayName === '测试脚本A'
  - from={displayName:'  空格名  '} → trim 后成功，envelope.from.displayName === '空格名'
  - **Q3 校验 1**：from={displayName:''} → 400（trim 后空）
  - **Q3 校验 2**：from={displayName:'a'.repeat(65)} → 400（超 64 char）
  - **Q3 校验 3**：from={displayName:123} → 400（非 string）
  - from={kind:'agent', instanceId:'xxx'} → 400（本期禁 agent）
  - from={kind:'system'} → 400（HTTP 永禁 system）
- `tsc --noEmit` 绿
- `docs/frontend-api/messages-api.md` 同步 API 形状（注明仅 displayName 可用 / 长度 ≤ 64 / kind 强制 user）

**Future work 预留**：D3 已记「Phase 2 鉴权落地后再开 agent 分支」，不在本期范围。

---

## T-REGRESSION（前端配套）

**T-REGRESSION-1**（W2-A 后置，实时事件路径）：renderer 收到 `comm.message_sent` / `comm.message_received` WS 事件后原有 `fetch(/api/messages/:id)` 可删，改为直接用 `event.envelope`。渐进式迁移，不强制。

**T-REGRESSION-2**（W2-A/W2-B 区别，必写进前端文档 `docs/frontend-api/bus-events.md`）：
- **实时推送路径**（`comm.message_sent` / `comm.message_received` 直接从 bus 经 ws-broadcaster 下发）**带 envelope 字段**，前端可直接渲染。
- **gap-replay 路径**（`{type:'gap-replay', items:[...]}` 下行）的 items **不带 envelope 字段**，前端需按 messageId 走 `GET /api/messages/:id` HTTP 兜底。
- 理由（R-2）：gap 可能批量补发数百条，inline envelope 放大包体积不值；前端按需打开时 HTTP 拉详情即可。

前端逻辑示意：
```ts
if (msg.type === 'event' && msg.event?.type?.startsWith('comm.')) {
  if (msg.event.envelope) useEnvelope(msg.event.envelope);      // 实时路径
  else await fetch(`/api/messages/${msg.event.messageId}`);      // 兜底
}
if (msg.type === 'gap-replay') {
  for (const it of msg.items) await fetch(`/api/messages/${it.id}`);  // gap 恒走 HTTP
}
```

---

## 全局完成判据

- `tsc --noEmit`（backend）绿
- `bun test`（backend 全量）绿
- 新增/修改测试 10+ 条，覆盖 6 个问题每个 ≥ 1 条
- 守门测试 `bus/subscribers/ws.subscriber.test.ts` 未动（继续锁 size === 34 + bus 字段冻结）
- 文档 `docs/frontend-api/*.md` 按 W1-B / W2-A / W2-C 更新
- commit 按 wave 分组（Wave 1 一个 commit，Wave 2 三个或一个 squash）

---

## 变更日志

- **v1 (2026-04-25)**：arch-comm-fix-a 初版。与 arch-comm-fix-b 方案对抗：问题 2 采取「bus 冻结 + WS 下行 enrich」融合方案，而非纯 A（扩 bus）或纯 B（保持 HTTP 反查）。决策理由：遵循 phase-comm id:378 前决策 + id:387 守门测试锁定，同时解决前端二次请求痛点。

- **v2.2 (2026-04-25)**：arch-comm-fix-b 最后一审，采纳 3 条修正：
  - **Q2（真 bug）**：W2-B.0 的 SQL 伪代码里写了不存在的 `to_address` 列。改为对齐 `findUnreadForAddress` 的三分支（`to_user_id` / `to_kind='system' AND to_instance_id IS NULL` / `to_instance_id`），游标从单字段 sent_at 改为联合 `(sent_at, id)` 防同毫秒漏/重。
  - **Q4（真 bug）**：W2-B gap-replay 截断逻辑 v2 在 item 级截断但 upTo 按 envelope 级前移 → 会永久丢失被截断 envelope 的 received 事件。改为截断以 envelope 为单位，不打断同一 envelope 的 sent/received pair；`upTo` 仅记最后**完整**处理的 envelope id；第一个 envelope 就超限时 `upTo=null` 客户端下轮重试。
  - **Q3（防护）**：W2-C displayName 加校验：非 string 400 / trim 后空 400 / 长度 > 64 400。不做 HTML 转义（渲染层责任）。补 3 条单测。

- **v2.1 (2026-04-25)**：同步 `packages/renderer/docs/FRONTEND-API-INDEX.md` 更新后的前端文档路径：`messages.md` → `messages-api.md`、`ws-events.md` → `bus-events.md`；W2-A 额外把 envelope 下行形状同步到 `message-flow.md`（消息三路分发文档）。前端索引 §模块 3 明确「去重靠 envelope.id」印证融合方案 C 与前端现有习惯一致。

- **v2 (2026-04-25)**：team-lead 审查通过，2 个阻塞裁决 + 3 个风险处理：
  - **B-1**：不翻 peek 默认值。W1-B 降为纯文档同步（补「如需对齐 MCP 请显式传 peek=false」）。
  - **B-2**：handleSend 本期只做 `displayName` override，不开 agent 分支。W2-C 大幅缩小范围，`fromKind` 继续强注入 user。
  - **R-1**：W2-A `enrichCommEnvelope` 明确放循环外，每条事件查一次，在 client 循环里复用 payload。补 mock 性能单测锁 findById 调用次数 === 1。
  - **R-2**：REGRESSION 明确「实时路径带 envelope / gap 路径不带」，前端 HTTP 兜底文档化。
  - **R-3**：删除 W2-A 的 feature flag 回滚口矛盾表述（v1 一边说「本期先不做」一边说「问题了再加」），改为直接上线 + fail-soft 兜底 + 有问题走 commit 回滚。
