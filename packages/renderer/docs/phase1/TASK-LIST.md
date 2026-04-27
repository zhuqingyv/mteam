# TASK-LIST · Phase 1 任务拆分

> 本表基于 README.md 的 15 个缺口。每个任务**独立可并行**、带验证标准。依赖图见 §最后。
>
> 执行规范：每条任务完成必须对照「验证」逐条贴证据（记忆 #feedback_self_check）；UI 改动必须 CDP 截图自验（记忆 #verify_ui_before_deliver）；带单测才算完（项目红线）。

---

## G1 · 处理 turn.started，建立 agent 气泡壳

**文件**: `src/hooks/wsEventHandlers.ts`

**输入**: `{ type:'turn.started', driverId, turnId, userInput }`

**输出**: 
- 过滤 `driverId !== pa.instanceId` 的事件（含 Phase 2 成员 turn）
- `addMessage({ id: turnId, role:'agent', turnId, streaming:true, blocks:[], content:'', time: fmt(userInput.ts) })`

**验证**:
- 单测：mock ws event → 断言 `messageStore.messages` 多一条 turnId 为 id 的空壳
- 端到端：CDP headless 发送消息，气泡在首个文字到达前出现

**依赖**: 无

---

## G2 · turn.block_updated 支持所有 block type

**文件**: `src/hooks/wsEventHandlers.ts` + `src/store/messageStore.ts`

**输入**: `turn.block_updated{ block: TurnBlock }`，9 种 type。

**输出**:
- scope='turn'（thinking/text/tool_call/plan/usage）: `updateTurnBlock(turnId, block)`；若是 text 同时把 block.content 镜像到 Message.content
- scope='session'（commands/mode/config/session_info）: Phase 1 stub 到 `sessionBlocksStore`（新建轻量 store），或直接 console.debug
- text block 必须触发 thinking=false 切换（如果此前 thinking 气泡在亮）

**验证**:
- 单测：每种 type 都有一条 case；断言 block 落到 `messages[turnId].blocks` 或 sessionBlocksStore
- 端到端：工具调用卡片出现（依赖 G7/G8 MessageRow 渲染）

**依赖**: G1（没有 started 先建壳，block 无处挂）；G3（content 语义先修对）

---

## G3 · block.content 覆盖而非累加 【最严重】

**文件**: `src/hooks/wsEventHandlers.ts:47-49`

**改动**:
- 删除 `existing.content + delta` 这一行
- 替换为 `existing.content = block.content`（完整覆盖）
- 同步修掉注释（"chunk 是增量"是错的，block 是完整状态）

**验证**:
- 单测：连续喂 3 个同 blockId block，content 依次 "a" → "ab" → "abc"，断言最终 Message.content === 'abc' 而不是 'a' + 'ab' + 'abc'
- 端到端：发送长回复，关掉网络看最后一次收到的 block.content 是否等于气泡显示文本（相等才算通过）

**依赖**: 无（独立可开工；但会被 G2 一起改到，合并做也行）

---

## G4 · 处理 turn.completed，清 streaming 态

**文件**: `src/hooks/wsEventHandlers.ts` + `src/store/messageStore.ts`

**输入**: `turn.completed{ turnId, turn: Turn }`

**输出**:
- `messageStore.completeTurn(turnId)`（已有 action）
- 若 `turn.usage` 非空，写入 `uiStore.usage` 或 `primaryAgentStore` 新字段 `lastUsage`（新建）

**验证**:
- 单测：发 started → completed 组合，断言 Message.streaming === false
- 端到端：发一条消息等待完成，usage bar（若 G2 已接）刷新

**依赖**: G1（streaming=true 必须先被 G1 置上）

---

## G5 · 处理 turn.error

**文件**: `src/hooks/wsEventHandlers.ts`

**输入**: `turn.error{ turnId, message }`

**输出**:
- `completeTurn(turnId)`
- `primaryAgentStore.setState({ lastError: message })`
- toast（notificationStore.push）

**验证**:
- 单测：断言 lastError 被写 + messages 里该 turn streaming=false
- 端到端：manual kill driver 看是否弹 toast（需要后端配合或 mock）

**依赖**: G4（需要 completeTurn 路径已通）

---

## G6 · subscribe instance scope

**文件**: `src/hooks/useWsEvents.ts` + `src/api/ws.ts`

**改动**:
- `useWsEvents` 用 zustand subscribe 监听 `primaryAgentStore.instanceId`
- `instanceId` 从 null → 非空时: `ws.subscribe('instance', instanceId)`
- `instanceId` 从非空 → null 或换值时: `ws.unsubscribe('instance', oldId)`
- 重连时（onopen）如果 `instanceId` 非空要**再次** subscribe 一次（否则 pending flush 完就断了）

**验证**:
- 单测：mock store 推进 instanceId 变化，断言 ws.subscribe 被正确调用
- 端到端：后端 log 显示 instance scope 订阅成功

**依赖**: 无

---

## G7 · messageStore 接入真实 blocks / streaming / turnId

**文件**: `src/store/messageStore.ts`

**改动**:
- Message.id 语义改为 `turnId`（agent 侧）；blockId 下沉到 `Message.blocks[].blockId`
- `addMessage` 保持不变（G1 直接传 turnId）
- `updateTurnBlock` 已实现，G2 调用它即可
- 新增选择器 `selectActiveTurn()` = `messages.find(m => m.streaming)`（供 UI 展示 loading）

**验证**: 单测已有 store case；新增 blocks upsert + completeTurn 覆盖断言

**依赖**: 与 G1/G2/G3/G4 配套，但结构改动属于前置，先动 store 再动 handler

---

## G8 · ChatPanel / MessageRow 渲染 blocks

**文件**: `src/organisms/ChatPanel/ChatPanel.tsx` + `src/molecules/MessageRow/*`

**改动**:
- Message interface 扩 `blocks?: TurnBlock[]` 和 `streaming?: boolean`
- MessageRow 按 block.type 分派渲染：
  - thinking → ThinkingBlock 折叠卡
  - text → 主气泡（原样）
  - tool_call → ToolCallCard（复用现有 molecules/ToolCallList）
  - plan / usage → 对应组件（若未实现先 stub）
- `streaming=true` 时气泡右下角加光标 / 点点动画

**验证**: Storybook / Playground 各渲一条带 blocks 的 Message；CDP 截图

**依赖**: G7

---

## G9 · 断线重连先拉 driver turns 快照

**文件**: `src/api/ws.ts` + 新文件 `src/hooks/useReconnectSnapshot.ts`（或合进 useWsEvents）

**改动**:
- `ws.onopen`（非首次）时：
  1. `const iid = primaryAgentStore.instanceId`
  2. 若 iid 非空 → `await getDriverTurns(iid, 20)`
  3. 用 active + recent 重建 messageStore（`setMessages(...)`）
  4. 然后才 `subscribe('global')` + `subscribe('instance', iid)`（带 lastMsgId）
- 首次连不需要（snapshot 会自己来）

**验证**:
- 单测：mock WebSocket 关→开，断言 getDriverTurns 被调 + setMessages 被调
- 端到端：开发者工具 `offline → online` 后历史消息恢复

**依赖**: G6、G7（需要 messages 支持 turnId 索引）

---

## G10 · 重连时 re-subscribe instance

**文件**: `src/api/ws.ts`

**改动**:
- 在 wsClient 内部维护 `activeSubscriptions: Set<{scope, id}>`
- `subscribe` / `unsubscribe` 时同步更新
- `onopen`（非首次）pending flush 完后，循环 activeSubscriptions 重新发 subscribe

**验证**:
- 单测：模拟 close → reopen，断言后端收到 subscribe global + instance
- 端到端：后端日志连接断开再建连时有两条 subscribe op

**依赖**: G6（instance 必须先进 activeSubscriptions）

---

## G11 · 废弃 primary-agent start / stop HTTP

**文件**: `src/api/primaryAgent.ts` + `src/store/primaryAgentStore.ts`

**改动**:
- 删除 `startPrimaryAgent` / `stopPrimaryAgent` 两个导出
- 删除 store.start / store.stop actions
- 搜索全仓库确认没有调用（若有 UI 按钮依赖，降级为"不可点"或移除）

**验证**: `grep -r 'startPrimaryAgent\|stopPrimaryAgent'` 零命中；`tsc` 通过

**依赖**: 无（删除型任务）

---

## G12 · configure 走 WS `configure_primary_agent`

**文件**: `src/api/ws.ts` + `src/store/primaryAgentStore.ts`

**改动**:
- `WsClient` 增 `configurePrimaryAgent(cliType, name?, systemPrompt?, requestId?)`
- `primaryAgentStore.configure(body)`：
  - 若 body 只含 `cliType / name / systemPrompt` → 走 WS
  - 若包含 `mcpConfig` → 走原 HTTP
  - inflightAction 在 ack 收到后清（需要 requestId 映射）或维持 debounce 简化方案：发完就清

**验证**:
- 单测：分别跑纯 cliType 和带 mcpConfig，断言调的是 ws / http
- 端到端：切 cliType 从 claude→codex，WS 日志看到 configure_primary_agent op + 后续 primary_agent.configured 事件

**依赖**: 无

---

## G13 · 注册 onAck / onError 处理

**文件**: `src/hooks/useWsEvents.ts`

**改动**:
- `client.onAck((ack) => { if (!ack.ok) notify(ack.reason) })`
- `client.onError((err) => { primaryAgentStore.setState({ lastError: err.message }); notify(err.message) })`
- driver.error 同时写 lastError（在 primaryAgentBridge.onDriverEvent 里加）

**验证**:
- 单测：mock ws 下行 error / ack ok:false，断言 lastError 和 notification 各更新一次
- 端到端：故意发 cliType='unknown' 触发 internal_error，UI 出现 toast

**依赖**: 无

---

## G14 · snapshot 应清 lastError / driverLifecycle

**文件**: `src/api/ws.ts`

**改动**: 处理 snapshot 时 setState 增补 `lastError: null, driverLifecycle: 'idle'`（或根据 row.status 初值）

**验证**: 单测：预置 lastError='x'，推一条 snapshot，断言 lastError 变 null

**依赖**: 无

---

## G15 · 单测骨架 + 覆盖 Phase 1 全链路

**文件**: 新建若干 `__tests__/*.test.ts`

**覆盖**:
- `primaryAgentStore.test.ts`: refresh / configure / bridge / selectors
- `wsEventHandlers.test.ts`: 每种 event type 一个 case
- `ws.test.ts`: createWsClient 的 pending / snapshot / gap-replay / reconnect
- `useBootstrap.test.ts` / `useWsEvents.test.ts`: mount → 订阅行为

**基建**:
- vitest / jest 任选（与项目一致即可）
- mock WebSocket 用 `mock-socket` 或手写
- 不 mock 数据库（记忆红线：不 mock 测试 —— 这里指业务逻辑，mock WebSocket 属于 harness 不违反）

**验证**: `pnpm test --filter renderer` 全绿；覆盖率 ≥ 70%

**依赖**: 其他所有任务（随任务增量加 case）

---

## 依赖图

```
Round 1 (独立):   G3 · G6 · G11 · G12 · G14 · G15(骨架)
Round 2 (需 Round 1): G1 · G7 · G8 · G13
Round 3 (需 Round 2): G2 · G4 · G9 · G10
Round 4 (需 Round 3): G5 · 端到端验收 · G15(补 case)
```

建议分工（参考 Team Roster）：
- **渲染层**（G1 / G2 / G7 / G8）：懂 React + zustand
- **通信层**（G3 / G6 / G9 / G10 / G12 / G13 / G14）：懂 WS 协议
- **清理**（G11）：任何成员可做
- **测试**（G15）：主测试成员贯穿整期

## 交付前自检（记忆 #self_check / #delivery_gate）

每个 G 完成前必须对照：

- [ ] 代码改动聚焦单一任务，无夹带
- [ ] 新增 / 改动的模块有单测
- [ ] `pnpm tsc` + `pnpm build` 通过
- [ ] UI 改动 CDP 截图验过
- [ ] 对应 WS-EVENTS.md / DATA-MODEL.md 的状态从 ❌/⚠️ 改为 ✅
- [ ] 无直接调底层 `/api/*`（硬门禁）
