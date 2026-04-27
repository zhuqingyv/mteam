# Phase 1 · 主 Agent 前端完整接入

> 目标：主 Agent 在 UI 上**完整可用** —— 状态同步、对话发送、思考流式、文本流式回复、错误处理，全部打通并有据可查。
>
> 范围：仅限 `packages/renderer/` 的 primaryAgentStore、messageStore、WS 处理、ExpandedView / ChatPanel。不涉及成员 Agent（Phase 2）、团队（Phase 3）、花名册（Phase 4）。
>
> 文档权威（后端契约）：`docs/frontend-api/INDEX.md` / `primary-agent-api.md` / `ws-protocol.md` / `turn-events.md` / `bus-events.md`。后端已全部实时推事件；前端**不能**绕开门面层（见 INDEX §5.1）。

---

## Phase 1 完整目标

| 能力 | 验收标准 |
|---|---|
| 1. 进程就绪展示 | 启动后 5s 内胶囊 / 展开态能准确显示主 Agent `status=RUNNING`、`cliType`、`driverLifecycle=ready`；未配置态显示 not-configured。 |
| 2. 发送用户消息 | 展开态输入框发出 → WS `prompt` → 后端 `ack{ok:true}` → 气泡落消息流（本地 echo 不重复、不丢失）。 |
| 3. 思考状态 | 主 Agent 回复前，气泡显示「思考中...」（由 `turn.started` + `turn.block_updated{type:'thinking'}` 驱动）。 |
| 4. 流式文本回复 | `turn.block_updated{type:'text'}` 按 `blockId` upsert，打字机式增量刷新，不闪烁、不累错。 |
| 5. Turn 结束 | `turn.completed` 收到后清 streaming 状态，usage bar 更新。 |
| 6. 生命周期变更 | 切 cliType / 应用重启 / driver 崩溃 → WS `snapshot` + `primary_agent.*` + `driver.*` 事件全部落到 store，UI 3 秒内感知。 |
| 7. 断线重连 | WS 断开重连：先拿 `/api/panel/driver/:id/turns` 快照，再 `subscribe(instance, id, lastMsgId)` 触发 gap-replay，active turn 无缝续跑。 |
| 8. 错误兜底 | prompt 未就绪 → 用户看到「Primary Agent not started」提示；configure 抛错 → WS `error{code:internal_error}` 映射到 `lastError` 并 toast。 |

---

## 当前状态（2026-04-26 快照）

### 已接入

- **HTTP 层**（`src/api/primaryAgent.ts`）: `getPrimaryAgent` / `configure` / `start` / `stop` 已全部走 `/api/panel/primary-agent/*`，但按后端迁移契约 `start`/`stop` 应该**废弃**（由应用生命周期自动拉起 / 停止，前端不调）。
- **Store**（`src/store/primaryAgentStore.ts`）: `config` 单一源 + `status` 从 `config.status` 派生 + `instanceId = config.id` + `driverLifecycle` + `inflightAction` + `lastError` + 150ms debouncedRefresh WS bridge（记忆 #512 / #517）。
- **WS 客户端**（`src/api/ws.ts`）: `createWsClient` 已实现 `subscribe` / `unsubscribe` / `prompt` / `ping`、`onEvent` / `onAck` / `onError` 回调、`lastMsgId` 游标、`pending` 队列（修 CONNECTING 丢包，记忆 #543）、`snapshot` 直接写 store、`gap-replay` 分发。
- **WS 订阅**（`src/hooks/useWsEvents.ts`）: 挂载后 `subscribe('global')` + 30s 心跳，按 `event.type` 前缀分发。
- **Bootstrap**（`src/hooks/useBootstrap.ts`）: 应用启动时一次 refresh + 3s 后补一次。
- **展开态对话**（`src/organisms/ExpandedView/ExpandedView.tsx`）: 从 store 读 `config.cliType` 驱动 model 下拉；`handleSend` 本地 echo + `ws.prompt(instanceId, text, requestId)`；模型切换走 `primaryAgentStore.configure`。
- **生命周期事件**（`src/hooks/wsEventHandlers.ts`）: `primary_agent.*` → `primaryAgentBridge.onPrimaryAgentEvent` 触发 debouncedRefresh；`driver.started/stopped/error` → `onDriverEvent` 写 `driverLifecycle`（记忆 #503）。
- **流式文本**（`handleTurnEvent`）: `turn.block_updated{type:'text'}` 按 `blockId` 查 `messages` + 追加 `content`。

### 缺口（必须补齐才算 Phase 1 完成）

> 下列缺口的判定依据：代码现状 vs `docs/frontend-api/turn-events.md` §5 的"事件 → store"映射表 + `ws-protocol.md` 的 snapshot/gap-replay 契约。

| # | 缺口 | 严重度 | 根因 / 现状 |
|---|---|---|---|
| G1 | `turn.started` 未处理 | 高 | `wsEventHandlers.ts:40` 硬编码 `if (t !== 'turn.block_updated') return;`，`turn.started` 被吞。UI 无「思考中」loading；用户发完问题到首个 text block 之间视觉断片。 |
| G2 | `turn.block_updated` 只处理 `type=text` | 高 | 同上，`b.type !== 'text'` 直接 return，丢掉 `thinking`/`tool_call`/`plan`/`usage`。思考气泡、工具调用卡片、计划都不显示。 |
| G3 | `block.content` 误当 delta 累加 | **严重** | `wsEventHandlers.ts:47-49` 注释声称 chunk 是增量所以 `existing.content + delta`；但 `turn-events.md` §2.2 / 代码 `turn-events.ts:22` 明确 **block 是完整最新状态（非 delta）**。当前实现会把完整字符串重复累加，文字越来越长。记忆 #543 已修"turn text 累加不覆盖"说明历史反复，需最终对齐 upsert 覆盖语义。 |
| G4 | `turn.completed` 未处理 | 高 | 事件被丢到 `handleTurnEvent` 的 `return`；`messageStore.completeTurn` 永远不会被调用，streaming 态不清，usage 不落库。 |
| G5 | `turn.error` 未处理 | 中 | 同 G4；driver 中途挂掉前端看不到错误，只能看最后一次 block。 |
| G6 | `ExpandedView` 未订阅 instance scope | 高 | `useWsEvents.ts:28` 只 `subscribe('global')`，没有 `subscribe('instance', primaryAgent.id)`。按后端 `ws-protocol.md`，instance scope 是 turn.* 的接收必要条件，现状能收到仅因为 global 没过滤；一旦后端收紧 scope 过滤就全瞎（记忆 #501 已记）。 |
| G7 | messageStore 未真正用 `blocks` / `streaming` / `turnId` | 中 | store 定义了字段（`messageStore.ts:23-25`）但 ChatPanel / MessageRow 都不读。thinking/tool_call/plan 无处挂载。 |
| G8 | ChatPanel 不接受 blocks / streaming | 中 | `ChatPanel.tsx:9-18` Message 类型里有 `thinking/toolCalls` 但没 `blocks`；MessageRow 渲染也没 block 分派。 |
| G9 | 断线重连未拉 turn 快照 | 中 | `ws.ts` 断线 3s 后重连只 re-subscribe global，不调 `getDriverTurns`。active turn 会丢；按 `turn-events.md` §5 规范，**必须**先 HTTP 拉快照再 subscribe。 |
| G10 | 断线重连未 re-subscribe instance | 中 | `ws.ts:65` 重连只等 onopen 用 pending 重发，但 pending 在首次 subscribe 已被 flush 清掉；第二次连上去没人 subscribe instance。 |
| G11 | HTTP `start`/`stop` 未废弃 | 低 | `primaryAgent.ts:39-45` + `primaryAgentStore.ts:72-99` 还在暴露、调 HTTP。按 `primary-agent-api.md` 表 1 应该删，由应用生命周期自动处理；同时 `configure` 该改为走 WS `configure_primary_agent`（HTTP 仅改 mcpConfig 场景保留）。 |
| G12 | `configure` 没走 WS | 低 | 现状 `primaryAgentStore.configure` 调 HTTP `POST /config`；按迁移对照应走 WS `configure_primary_agent`，HTTP 作为 mcpConfig 后备。 |
| G13 | WS `error` 下行没有落到 `lastError` | 低 | `useWsEvents.ts` 只注册 `onEvent`，没注册 `onError` / `onAck`；`configure` 失败走 `error{code:internal_error}`，用户无感知。 |
| G14 | `snapshot` 只在建连时写，未覆盖 `lastError` / `driverLifecycle` | 低 | `ws.ts:47-54` 直接 setState 三个字段，若上一连接里 `lastError` 有值、`driverLifecycle=error`，新连接 snapshot 不清它。 |
| G15 | 无单测 | 高 | `useBootstrap` / `wsEventHandlers` / store bridge 零单测。按项目红线"新模块必须带单测"必须补。 |

---

## 文档组织

| 文件 | 作用 |
|---|---|
| [README.md](./README.md) | 本文：总目标 + 现状 + 缺口清单（入口） |
| [DATA-MODEL.md](./DATA-MODEL.md) | primaryAgentStore / messageStore 数据模型 + 状态转换 |
| [WS-EVENTS.md](./WS-EVENTS.md) | 11 类主 Agent 相关 WS 下行事件 × payload × 前端动作 × 已处理状态 |
| [API-CONTRACT.md](./API-CONTRACT.md) | 前端 HTTP 白名单 + WS 上行 / 下行完整契约 |
| [TASK-LIST.md](./TASK-LIST.md) | 15 个独立任务（G1~G15），含依赖、输入输出、验证标准 |

---

## 排期（建议）

按 TASK-LIST.md 的依赖图，15 项可分 4 轮并行：

- **Round 1**（可独立开工）: G3（content 覆盖不累加）、G6（subscribe instance）、G11/G12（迁移到 WS configure）、G15（单测骨架）
- **Round 2**（需 G3 完成）: G1（turn.started）、G2（block 多类型）、G4（turn.completed）、G5（turn.error）、G7/G8（messageStore/ChatPanel blocks）
- **Round 3**（需 G1-G5 完成）: G9（断线拉快照）、G10（重连 re-subscribe）、G13（onError / onAck）、G14（snapshot 清 lastError）
- **Round 4**: 端到端验收（CDP headless 点聊天 + 观察流式，记忆 #playground_cdp_testing）。
