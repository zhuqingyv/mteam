# Phase 4 TASK-LIST — 模块级任务清单

> 配合 `MILESTONE.md` + `INTERFACE-CONTRACTS.md` 食用。
> 任务 ID 格式：`S{sprint}-{M|G}{序号}`。M = 独立模块；G = 胶水层。
> 复杂度：S（<80 行）/ M（80-150 行）/ L（150-200 行）。**超 200 行一律打回重拆**。

---

## 交付粒度

- **一个 M/G 一个 PR**：每个任务独立成 PR，评审单元清晰，便于回滚
- **合并到 Sprint 子 branch**：所有 Sprint N 的 PR 合到 `phase4/s{n}-{id}` 子 branch（如 `phase4/s1-m1`）
- Sprint 整体验收通过后，子 branch 统一合回 `phase4/main`（或当前集成 branch）
- 单个 PR 超过 200 行（含测试）一律打回重拆
- PR 标题格式：`[Phase4][S{n}-{M|G}{序号}] 任务简述`

---

## 全局约束（所有任务都适用）

- 每个任务单文件 ≤ 200 行（含注释空行）；新建多文件也算合并行数
- 独立模块（M）**不 import**：`store/` / `api/ws` / `hooks/wsEventHandlers` / 全局单例。只能 import：atoms、molecules、其它独立模块、纯函数 utils
  - **S1-M1 显式豁免**：其 deprecated 代理层允许 import `usePrimaryAgentStore` 作为 fallback pid 来源
- 胶水层（G）可以跨层组合，但也要一个文件一件事
- 所有新代码必须带单测（`__tests__/*.test.ts(x)`），mock 只 mock 边界（WS / HTTP），不 mock 被测 store / hook
- 完成即 `tsc` + `build` 自检
- **playground 注册统一由 S2-G1 完成**：S2 的 M 任务本身不要求 playground 注册（只保证组件可独立渲染 + 单测通过）；S2-G1 集中做所有新组件的 registry 登记和版本号升级
- 交叉验证：模块做完由 team-lead 指派另一名成员按本任务 AC 逐条走一遍，通过才闭环

---

## Sprint 1 — 基础设施

### S1-M1 messageStore 分桶
- **类型**：独立模块
- **文件**：`src/store/messageStore.ts`
- **复杂度**：L
- **依赖**：无
- **契约**：见 `INTERFACE-CONTRACTS.md` §3.1
- **完成判据**：
  - [ ] state 新增 `byInstance: Record<string, InstanceBucket>`，`InstanceBucket = { messages: Message[]; pendingPrompts: string[] }`
  - [ ] 新增 action：`addMessageFor(iid, m)` / `replaceMessageFor(iid, id, m)` / `setMessagesFor(iid, list)` / `clearFor(iid)` / `updateTurnBlockFor(iid, turnId, block)` / `removeTurnBlocksByTypeFor(iid, turnId, type)` / `completeTurnFor(iid, turnId)` / `enqueuePromptFor(iid, text)` / `dequeuePromptFor(iid)` / `clearPendingFor(iid)`
  - [ ] 新增 action `markPeerRead(iid, peerId)`：把 `byInstance[iid].messages` 里 peerId 匹配的消息 `read` 置 true（peer 匹配规则：消息 `from === peerId` 或 `to === peerId`；peer='user' 匹配 user→agent 的 turn 消息）
  - [ ] 新增 selector：`selectMessagesFor(iid)` / `selectPendingFor(iid)` / `selectBucketFor(iid)`
  - [ ] 兼容 selector 签名对齐契约：`selectPrimaryMessages(state: MessageState, primaryIid: string | null): Message[]`，`primaryIid` 为 null 时返回空数组
  - [ ] `MAX_MESSAGES = 1000` 按 bucket 独立生效
  - [ ] 旧顶层 `messages/pendingPrompts/addMessage/...` 保留为 deprecated 代理：内部用 `usePrimaryAgentStore.getState().instanceId` 做 fallback pid（本模块对此 import **显式豁免**独立模块禁 import store 的约束，已在全局约束中声明）；pid 为空时代理为 no-op 并打 console.warn
  - [ ] 单测 `messageStore.test.ts`：两个 iid 独立 add / 隔离 / 清理不互相影响 / 跨桶 turnId 不互串 / `markPeerRead` 只标记指定 peer / edge case：A 排队 3 条 + B 正常发 1 条 → A cancel 后 B 队列不动（合并自原 S3-M2）
- **交叉验证**：
  - [ ] 旧 `ExpandedView` 未改也能 build（兼容层到位）
  - [ ] 1000 条上限分桶生效

### S1-M2 promptDispatcher per-instance
- **类型**：独立模块
- **文件**：`src/hooks/promptDispatcher.ts`
- **复杂度**：M
- **依赖**：S1-M1（`BucketMessageStore` 接口由 M1 先落）
- **契约**：见 §3.2
- **完成判据**：
  - [ ] `sendUserPrompt(text, iid?)` / `dispatchPromptNow(text, iid)` / `flushNextPending(iid)` / `cancelCurrentTurn(iid?)` / `isTurnStreaming(iid)` 全部接 iid 参数
  - [ ] 缺省 iid → 使用 `usePrimaryAgentStore.getState().instanceId`（兼容现有调用点）
  - [ ] `pendingPrompts` 走 S1-M1 的 `enqueuePromptFor(iid, text)`，**按 iid 隔离**，A instance streaming 不影响 B instance 立即发送
  - [ ] 单测 `promptDispatcher.test.ts`：两个 iid 同时发送互不阻塞 / cancel 只清对应 iid 队列
- **交叉验证**：
  - [ ] 无 iid 时兜底主 Agent，现有 ExpandedView 调用点零改动能跑
  - [ ] WS ws.prompt 参数 instanceId 正确

### S1-M3 useInstanceSubscriptions hook
- **类型**：独立模块
- **文件**：`src/hooks/useInstanceSubscriptions.ts`
- **复杂度**：M
- **依赖**：无（接受 WsClient 作为参数，纯 hook）
- **契约**：见 §4.1
- **完成判据**：
  - [ ] 签名：`useInstanceSubscriptions(instanceIds: string[], client: WsClient | null): void`
  - [ ] 内部维护当前订阅 Set；每次 props 变化做 diff，新增的 subscribe，消失的 unsubscribe
  - [ ] 变化频繁时 120ms debounce 合并（防抖）
  - [ ] unmount 时 unsubscribe 全部
  - [ ] client 为 null 时 no-op
  - [ ] 单测：快速挂卸多个 id / 重复 id 只订一次 / 卸载清理
- **交叉验证**：
  - [ ] 和 S1-G2 对接后，主 Agent 单订阅逻辑通过

### S1-G1 handleTurnEvent 去主 Agent 过滤
- **类型**：胶水层
- **文件**：`src/hooks/handleTurnEvent.ts`
- **复杂度**：M
- **依赖**：S1-M1
- **完成判据**：
  - [ ] 删除 `if (pa.instanceId && did !== pa.instanceId) return;`
  - [ ] 所有 action 改为 `...For(did, ...)`；`did` 必须从 `e.driverId ?? e.instanceId` 提取，空时 `return`
  - [ ] `flushNextPending(did)` 传 iid
  - [ ] 单测扩展：两个 driverId 交错 turn.* 事件，分桶正确
- **交叉验证**：
  - [ ] 主 Agent 场景行为与 S0 完全一致（对照 ExpandedView 手测）

### S1-G2 useWsEvents 改用 useInstanceSubscriptions
- **类型**：胶水层
- **文件**：`src/hooks/useWsEvents.ts`
- **复杂度**：M
- **依赖**：S1-M3
- **完成判据**：
  - [ ] 内部维护 `subscribedInstanceIds: string[]`，初始 = `[primaryInstanceId]`（若存在）
  - [ ] 新增 export：`useInstancePanelRegistry` 或 `addInstanceSub(id) / removeInstanceSub(id)` —— CanvasNode 展开时用（S3 用）
  - [ ] 删除 `syncInstanceSub` / `currentInstanceSub` 局部状态
  - [ ] `useInstanceSubscriptions(subscribedInstanceIds, client)` 接管
  - [ ] 断线重连 / snapshot 路径保留
- **交叉验证**：
  - [ ] 主 Agent 订阅 / 切换 / 卸载全部无回归
  - [ ] 接入两个额外 instanceId 时 WS 看到 2 次 subscribe

### S1-G3 ExpandedView / 旧 dispatcher 调用点补 iid
- **类型**：胶水层
- **文件**：`src/pages/ExpandedView.tsx`（以及所有调 dispatcher 的地方）
- **复杂度**：S
- **依赖**：S1-M2
- **完成判据**：
  - [ ] `sendUserPrompt(text)` → `sendUserPrompt(text, primaryInstanceId)` 或确保默认参数兜底（二选一明确写注释说明）
  - [ ] 如选默认兜底，在调用点加注释：`// iid 省略 → fallback to primary agent`
  - [ ] 手测 ExpandedView 无行为差异

---

## Sprint 2 — 节点组件

### S2-M1 CanvasNode 收起态
- **类型**：独立模块（新组件）
- **文件**：`src/molecules/CanvasNode/{CanvasNode.tsx, CanvasNode.css, index.ts}`
- **复杂度**：M
- **契约**：见 §5.1
- **完成判据**：
  - [ ] props：`id / name / status / cliType / taskCount / unreadCount / messageCount / x / y / onOpen / onDragEnd / getZoom`
  - [ ] 视觉复刻设计稿：Avatar + AgentLogo + StatusDot + name + 任务数徽章 + 未读红点
  - [ ] 所有状态色（idle/thinking/responding/offline）对齐 AgentCard.css 现有口径
  - [ ] 不 import store / hooks 业务
  - [ ] 单测：props 变化 → class 变化 / onDragEnd 仅在 moved>3px 触发
- **交叉验证**：
  - [ ] 组件可在 Storybook-style 独立页面渲染四态（playground 注册由 S2-G1 统一完成）

### S2-M2 CanvasNode 展开态骨架
- **类型**：独立模块
- **文件**：`src/molecules/CanvasNode/CanvasNodeExpanded.tsx`（同目录）
- **复杂度**：M
- **契约**：见 §5.1
- **完成判据**：
  - [ ] props：`id / name / status / onMinimize / onClose / children`
  - [ ] 420×540（PRD §5 给的是 420×560，以本文档冻结值 420×540 为准）fixed 定位，顶栏 drag handle
  - [ ] 顶栏：Avatar + name + StatusDot + [最小化] + [关闭]
  - [ ] 主区是 `{children}` 插槽（接 S2-M3 结果）
  - [ ] CSS overflow: hidden 内部滚动由子组件负责
  - [ ] 单测：onMinimize / onClose 点击回调、drag handle 拖动 delta 透出

### S2-M3 InstanceChatPanel
- **类型**：独立模块
- **文件**：`src/organisms/InstanceChatPanel/{InstanceChatPanel.tsx, InstanceChatPanel.css, index.ts}`
- **复杂度**：M
- **契约**：见 §5.3
- **完成判据**：
  - [ ] props：`instanceId / peerId / peerName / messages / streaming / inputValue / onInputChange / onSend / onStop / onCancel / headerSlot / emptyHint`
  - [ ] 内部复用 organisms/ChatPanel；props 透传
  - [ ] 空列表显示 emptyHint
  - [ ] 不订 WS、不读 store；数据全 props 驱动
  - [ ] 单测：props 驱动渲染 / onSend 回调 / streaming 态禁输入

### S2-M4 ChatList + ChatListItem
- **类型**：独立模块
- **文件**：`src/molecules/ChatList/{ChatList.tsx, ChatList.css, ChatListItem.tsx, index.ts}`
- **复杂度**：M
- **契约**：见 §5.4
- **完成判据**：
  - [ ] ChatList props：`items: ChatPeer[] / activeId / onSelect(id)`
  - [ ] ChatPeer：`{ id, name, avatar?, role: 'user' | 'leader' | 'member', lastMessage?, lastTime?, unread?: number }`
  - [ ] 列表项显示：avatar + name + lastMessage（省略号） + lastTime + unread badge
  - [ ] `.chat-list__items { overflow-y: auto }` —— 本 Phase 允许的第二个滚动条
  - [ ] activeId 高亮
  - [ ] 单测：点击 onSelect 触发 / unread badge 显示 / empty 态

### S2-M5 CanvasTopBar molecule
- **类型**：独立模块
- **文件**：`src/molecules/CanvasTopBar/{CanvasTopBar.tsx, CanvasTopBar.css, index.ts}`
- **复杂度**：S
- **契约**：见 §5.5
- **完成判据**：
  - [ ] props：`teamName / memberCount / zoomPercent / onZoomMenu / onFit / onNewMember / onSettings / onClose`
  - [ ] 左：{teamName} · {memberCount} 成员
  - [ ] 右：[zoom%] [适应画布] [+ 新成员] [齿轮] [关闭]
  - [ ] 所有按钮走 atoms/Button + Icon；无裸 SVG
  - [ ] 单测：点击各回调 / memberCount=0 渲染

### S2-M6 ZoomControl molecule
- **类型**：独立模块
- **文件**：`src/molecules/ZoomControl/{ZoomControl.tsx, ZoomControl.css, index.ts}`
- **复杂度**：S
- **契约**：见 §5.6
- **完成判据**：
  - [ ] props：`zoom / onZoomIn / onZoomOut / onReset`
  - [ ] [-] [zoom%] [+] 三按钮；双击中间百分比 → onReset
  - [ ] 样式右下绝对定位预留（实际绝对定位由 parent 决定）
  - [ ] 单测：点击回调 / 双击 reset

### ~~S2-M7 MiniMap molecule（P1 骨架）~~ **[延后到 S6，本期不做]**
- **状态**：🚫 延后
- **原因**：实现需要裸 SVG 或裸 canvas，违反 `.claude/CLAUDE.md` 第 0 节铁律（0 裸 SVG；所有图形必须走 `<Icon name="..." />`）
- **解锁条件**：需先在全局 `CLAUDE.md` / `.claude/CLAUDE.md` 为 MiniMap 开白名单（或将 `atoms/Icon` 扩展支持节点点/视口框的 primitive），再在 S6 重新开工
- **原计划契约**：暂存于 `INTERFACE-CONTRACTS.md` §5.7，S6 启动时再核对
- **影响**：S6-M3 / S6-G2 依赖此组件，同步延后；Sprint 6 启动前 team-lead 需复核白名单状态

### S2-G1 playground 集中注册 + demo 数据 + 版本号升级
- **类型**：胶水层
- **文件**：`playground/registry.ts` / `playground/App.tsx` / `playground/index.html`
- **复杂度**：M
- **依赖**：S2-M1 ~ S2-M6（**S2-M7 已延后，本任务不涉及 MiniMap**）
- **完成判据**：
  - [ ] 每个新组件 entry 写进 registry：name / layer / group / defaults / handlers
  - [ ] 覆盖的组件：CanvasNode（收起态）/ CanvasNodeExpanded / InstanceChatPanel / ChatList + ChatListItem / CanvasTopBar / ZoomControl
  - [ ] 可调 props 有 PropDef；所有 onXxx 回调在 Events 面板能看到日志
  - [ ] Playground 版本号 minor 升（如 1.5.0 → 1.6.0），App.tsx + index.html 两处同步
  - [ ] `npm run playground:build` 成功
- **交叉验证**：
  - [ ] team-lead 在 playground 逐个打开，props 切换 / 点击无错
  - [ ] Events 面板日志完整

---

## Sprint 3 — 消息链路

### S3-M1 turnHydrator per-instance
- **类型**：独立模块
- **文件**：`src/hooks/turnHydrator.ts`
- **复杂度**：M
- **依赖**：S1-M1
- **完成判据**：
  - [ ] `applyTurnsResponse(driverId, msg)` 改为写入 `byInstance[driverId]` 桶
  - [ ] `applyTurnHistoryResponse(driverId, msg)` 同
  - [ ] 去除对 primary instance 的隐式假设
  - [ ] 单测：两个 driverId 各自 hydrate 不串

### S3-M2 pendingPrompts per-instance
- **类型**：独立模块
- **文件**：S1-M1 已做大部分 / S1-M2 已调通；本任务确认并补 edge case
- **复杂度**：S
- **依赖**：S1-M1 + S1-M2
- **完成判据**：
  - [ ] `clearPending(iid)` 只清指定 iid 队列
  - [ ] `cancelCurrentTurn(iid)` 只清 iid 自己队列，不碰其它
  - [ ] 单测：A 排队 3 条 + B 正常发 1 条 → A cancel 后 B 队列不动
- **说明**：若 S1 阶段已覆盖，本任务可 merge 进 S1-M2 的 PR，不单独产出

### S3-M3 CanvasDebugPage 脚手架
- **类型**：独立模块（临时页）
- **文件**：`src/pages/CanvasDebugPage.tsx`（Sprint 6 搬到 playground-only 或删除）
- **复杂度**：M
- **完成判据**：
  - [ ] 页面两栏并排，每栏一个 `InstanceChatPanel`
  - [ ] 顶部各有一个 instanceId 输入框
  - [ ] 不依赖画布 / 节点，纯测试页
  - [ ] 不接真实数据（props 用 mock），由 G 阶段接真
- **交叉验证**：
  - [ ] `tsc` + `build` 通过

### S3-G1 InstanceChatPanel 接 messageStore selector + dispatcher
- **类型**：胶水层
- **文件**：可能新建 `src/pages/CanvasDebugPage.tsx` 或一个 `InstanceChatPanelConnected.tsx` 容器
- **复杂度**：M
- **依赖**：S1-G1、S2-M3、S1-M2
- **完成判据**：
  - [ ] 容器组件 `InstanceChatPanelConnected`：props `instanceId`，内部 `useMessageStore(state => selectMessagesFor(state, instanceId))` + `sendUserPrompt(text, instanceId)` 组装
  - [ ] 输入 state 走 inputStore by instanceId（新增 key 维度）或本地 useState
  - [ ] 单测：两个 connected panel 消息独立

### S3-G2 InstanceChatPanel 接 subscriptions + get_turns
- **类型**：胶水层
- **文件**：`src/hooks/useInstancePanel.ts`（新）
- **复杂度**：M
- **依赖**：S1-M3、S1-G2、S3-M1
- **完成判据**：
  - [ ] `useInstancePanel(instanceId)`：挂载时登记 subscription、发 `ws.get_turns(instanceId, 20)` + `get_turn_history(instanceId, {limit:20})`、卸载时移除 subscription
  - [ ] 内部去重（同一 instanceId 只拉一次热快照）
  - [ ] 单测：挂载 → 登记，卸载 → 注销

### S3-G3 CanvasDebugPage 串起来 + 双 instance 手测
- **类型**：胶水层
- **文件**：`src/pages/CanvasDebugPage.tsx`
- **复杂度**：S
- **依赖**：S3-G1、S3-G2
- **完成判据**：
  - [ ] 两栏分别接 `InstanceChatPanelConnected`
  - [ ] 一栏指向主 Agent，另一栏指向任一成员 instance
  - [ ] 手动测：同时发送，消息流各自正确、cancel 不串
  - [ ] 截图留证

---

## Sprint 4 — 画布集成

### S4-M1 instanceChatSelectors
- **类型**：独立模块
- **文件**：`src/store/selectors/instanceChat.ts`
- **复杂度**：M
- **完成判据**：
  - [ ] 纯函数：`selectPeersFor(state, instanceId, teamId, userName)`：返回 `ChatPeer[]`，含用户、leader（若非自己）、其它 team 成员
  - [ ] 纯函数：`selectMessagesForPeer(state, instanceId, peerId)`：按 sender/receiver 过滤 bucket 消息（comm 走 from/to；用户发来的 turn.* 归属 peerId='user'）
  - [ ] 不 touch store / 不副作用
  - [ ] 单测：peer 列表生成 / 消息按 peer 过滤 / 自己不出现在 peers

### S4-M2 unreadSelectors
- **类型**：独立模块
- **文件**：`src/store/selectors/unread.ts`
- **复杂度**：M
- **完成判据**：
  - [ ] 纯函数：`selectUnreadFor(state, instanceId, peerId)`：统计 bucket 里未 read 的消息数
  - [ ] 纯函数：`selectUnreadMap(state, instanceId)`：返回 `Record<peerId, number>`
  - [ ] 消息 `read` 字段语义：true = 已读（用户已打开过该 peer 的对话）
  - [ ] 对应 action：`markPeerRead(instanceId, peerId)` —— 写到 S1-M1 的 store 里？本任务提供纯函数 + 推动 S1-M1 补这个 action（跨 Sprint 小回补，允许）
  - [ ] 单测：未读统计 / 标记已读

### S4-M3 TeamCanvas 节点数据组装
- **类型**：独立模块
- **文件**：`src/hooks/useCanvasNodes.ts` + `src/organisms/TeamCanvas/layout.ts`
- **复杂度**：M
- **完成判据**：
  - [ ] `useCanvasNodes(teamId)`：从 teamStore + agentStore + canvasStates join 出 `CanvasNodeData[]`
  - [ ] `CanvasNodeData`：`{ id, name, status, cliType, isLeader, x, y, taskCount, unreadCount, messageCount }`
  - [ ] 无 canvasStates 时用 `layout.ringLayout(leaderId, memberIds)` 算初始位置（纯函数，已有雏形 mnemo #872）
  - [ ] 单测：layout 布局 / join 逻辑

### S4-M4 CanvasTopBar / ZoomControl 对接 useCanvasTransform
- **类型**：独立模块（容器 hook）
- **文件**：`src/hooks/useCanvasControls.ts`
- **复杂度**：S
- **完成判据**：
  - [ ] `useCanvasControls(transformApi)`：返回 `{ zoom, setZoom, reset, fitAll, nodes?: BBox[] }`
  - [ ] 内部调 `getTransform / setTransform`
  - [ ] 单测：fitAll 计算正确

### S4-G1 TeamCanvas import AgentCard → CanvasNode
- **类型**：胶水层
- **文件**：`src/organisms/TeamCanvas/TeamCanvas.tsx`
- **复杂度**：S
- **依赖**：S4-M3、S2-M1
- **完成判据**：
  - [ ] 仅替换 import 和 JSX 节点；props 映射表写注释
  - [ ] Agents 接口迁移至 `CanvasNodeData`；TeamPage 侧同步
  - [ ] 旧 AgentCard 暂不删除（Sprint 6 统一清理）
  - [ ] 手测：画布仍渲染，节点状态色正确

### S4-G2 CanvasNode 展开态装配 ChatList + InstanceChatPanel
- **类型**：胶水层
- **文件**：`src/molecules/CanvasNode/CanvasNodeExpanded.tsx`（覆盖 S2-M2 的 children slot）
- **复杂度**：L
- **依赖**：S2-M2、S2-M3、S2-M4、S4-M1、S4-M2
- **完成判据**：
  - [ ] 展开态内部维护 `activePeerId: string`（默认 user）
  - [ ] 左侧 `<ChatList items={peers} activeId onSelect />`
  - [ ] 右侧 `<InstanceChatPanelConnected instanceId peerId=activePeerId />`
  - [ ] 切换 peer → `markPeerRead(iid, peerId)` 清未读
  - [ ] peer=user：发送走 ws.prompt（已有）
  - [ ] peer=其它 instance：发送走 `POST /api/agents/:fromInstanceId/messages/send` + `comm.message_sent` 订阅显示回信
  - [ ] 单测：切 peer 行为 / 发送路径分流

### S4-G3 PanelWindow overflow + TeamMonitorPanel 去 __close + 装入 CanvasTopBar
- **类型**：胶水层
- **文件**：`src/templates/PanelWindow/PanelWindow.css` / `src/organisms/TeamMonitorPanel/TeamMonitorPanel.tsx` / `src/pages/TeamPage.tsx`
- **复杂度**：M
- **完成判据**：
  - [ ] PanelWindow.css: `overflow: auto` → `hidden`（含 mnemo #891 锚点）
  - [ ] TeamMonitorPanel 移除 `.team-monitor__close` 浮层（CSS 和 TSX）
  - [ ] TeamMonitorPanel 顶部装 `<CanvasTopBar />`，回调接 TeamPage
  - [ ] `onClose` 保留 `window.close()` 行为
  - [ ] 手测：无原生滚动条 / 关闭按钮在顶栏右端

### S4-G4 跨成员聊天 API 接入
- **类型**：胶水层
- **文件**：`src/api/messages.ts` + dispatcher 内部分流
- **复杂度**：M
- **完成判据**：
  - [ ] 先查 `docs/frontend-api/messages-api.md` 确认接口签名
  - [ ] 新增 `sendAgentMessage(fromInstanceId, toInstanceId, text): Promise<{ok}>`；失败 throw
  - [ ] 若接口缺失：降级为"跨成员聊天需后端支持"toast，不阻塞 S4 主干
  - [ ] 订阅 `comm.*` 事件写入 `byInstance[receiverId]` 桶，from/to 作为 peer 过滤依据
  - [ ] 单测：fetch mock 成功 / 失败两路径

---

## Sprint 5 — 交互打磨

### S5-M1 clampToCanvas 纯函数
- **类型**：独立模块
- **文件**：`src/utils/canvasClamp.ts`
- **复杂度**：S
- **完成判据**：
  - [ ] `clampNodePosition(pos, nodeSize, canvasSize, padding=40): {x,y, clampedDir?: 'n'|'s'|'e'|'w'|null}`
  - [ ] 单测：边界 / 对角越界 / 正中

### S5-M2 zIndexResolver 纯函数
- **类型**：独立模块
- **文件**：`src/utils/zIndex.ts`
- **复杂度**：S
- **完成判据**：
  - [ ] `resolveNodeZ(state): number`，state = `{ dragging, expanded, focused }`
  - [ ] 映射：默认 2 / dragging 10 / expanded 20 / focused+expanded 30
  - [ ] 常量 `Z.CANVAS_FX = 1 / Z.TOP_UI = 40` 统一 export
  - [ ] 单测 4 组合

### S5-M3 TeamSidebar 收起态
- **类型**：独立模块
- **文件**：`src/molecules/TeamSidebar/TeamSidebar.tsx` + css
- **复杂度**：M
- **完成判据**：
  - [ ] 新增 prop `collapsed?: boolean / onToggleCollapsed?: () => void`
  - [ ] 收起态只显示头像列 + 未读 badge + 顶部 toggle 按钮
  - [ ] 展开态保持现有
  - [ ] 动画 200ms ease
  - [ ] 单测：两态渲染 + onToggle

### S5-M4 useCanvasHotkeys hook
- **类型**：独立模块
- **文件**：`src/hooks/useCanvasHotkeys.ts`
- **复杂度**：S
- **完成判据**：
  - [ ] 签名：`useCanvasHotkeys({ onEscape, onFit, onResetZoom })`
  - [ ] window keydown 监听 Esc / f / 0（避免 ctrl/cmd 组合被覆盖）
  - [ ] 输入框聚焦时不响应（`e.target` tagName 判断）
  - [ ] 单测：事件触发、输入框例外

### S5-G1 CanvasNode 展开态 fixed 定位 + 偏移
- **类型**：胶水层
- **文件**：`src/molecules/CanvasNode/CanvasNodeExpanded.tsx`
- **复杂度**：M
- **依赖**：S5-M2
- **完成判据**：
  - [ ] 展开态 CSS `position: fixed`；锚点由父 CanvasNode 的 getBoundingClientRect 计算 + 偏移 24px × expandedIndex
  - [ ] 监听 canvas transform commit → 刷新锚点
  - [ ] z-index 用 `resolveNodeZ`
  - [ ] 手测：pan/zoom 画布时展开面板稳定可用、不被缩放

### S5-G2 CanvasNode 拖拽 clamp
- **类型**：胶水层
- **文件**：`src/molecules/CanvasNode/CanvasNode.tsx`
- **复杂度**：S
- **依赖**：S5-M1
- **完成判据**：
  - [ ] `onDragEnd` 之前套 `clampNodePosition`
  - [ ] 越界回弹 150ms ease-out
  - [ ] 单测：越界位置被夹回、回弹动画类

### S5-G3 TeamPage 挂 hotkeys
- **类型**：胶水层
- **文件**：`src/pages/TeamPage.tsx`
- **复杂度**：S
- **依赖**：S5-M4
- **完成判据**：
  - [ ] 挂 `useCanvasHotkeys({ onEscape: closeTopExpanded, onFit, onResetZoom })`
  - [ ] 维护"当前展开 id 栈"便于 Esc 关最上层
  - [ ] 原有 `window.close()` Esc 行为移到 ChatList / 输入框都没焦点且栈空时

---

## Sprint 6 — 触手 + 性能 + 收尾

### S6-M1 activeEdges selector
- **类型**：独立模块
- **文件**：`src/store/selectors/activeEdges.ts`
- **复杂度**：M
- **完成判据**：
  - [ ] 纯函数：`selectActiveEdges(state, now)`：从 messageStore + commEvents 派生 `{fromId, toId, intensity, lastActiveTs}[]`
  - [ ] intensity 随 lastActiveTs 距 now 衰减（0~1）
  - [ ] 超过 2000ms 返回空
  - [ ] 单测：衰减曲线 / 边界 2s

### S6-M2 useTentacles 接新参数
- **类型**：独立模块（改造）
- **文件**：`src/hooks/useTentacles.ts`
- **复杂度**：M
- **完成判据**：
  - [ ] 签名：`useTentacles(canvasRef, nodes, getElement, activeEdges?)`
  - [ ] activeEdges 未传 → 旧行为（全量 leader → members）
  - [ ] activeEdges 传入 → 只画这些边，按 intensity 调色
  - [ ] 单测（canvas 用 jsdom mock）：受限渲染路径

### S6-M3 MiniMap 交互
- **类型**：独立模块
- **文件**：`src/molecules/MiniMap/MiniMap.tsx`
- **复杂度**：M
- **完成判据**：
  - [ ] 点击跳转 → `onJump(centerX, centerY)`
  - [ ] viewport 框随画布 transform 变化
  - [ ] 单测：点击计算正确的画布坐标

### S6-M4 性能探针（dev-only）
- **类型**：独立模块
- **文件**：`src/utils/useRenderCount.ts`
- **复杂度**：S
- **完成判据**：
  - [ ] dev 模式计数某组件渲染次数，可选打印
  - [ ] prod 构建被 tree-shake
  - [ ] 单测：计数正确

### S6-G1 TeamCanvas 接 activeEdges + 新 useTentacles
- **类型**：胶水层
- **文件**：`src/organisms/TeamCanvas/TeamCanvas.tsx`
- **复杂度**：S
- **依赖**：S6-M1、S6-M2
- **完成判据**：
  - [ ] `useTentacles(canvasRef, nodes, getEl, activeEdges)`
  - [ ] 空闲时 0 边渲染

### S6-G2 TeamCanvas 挂 MiniMap
- **类型**：胶水层
- **文件**：`src/organisms/TeamCanvas/TeamCanvas.tsx`（或 CanvasWorkspace 若已新建）
- **复杂度**：S
- **依赖**：S6-M3
- **完成判据**：
  - [ ] MiniMap 绝对定位右下，z-index = Z.TOP_UI
  - [ ] viewport/nodes 对齐

### S6-G3 全量 AC 回归 + 收尾清理
- **类型**：胶水层（总验收）
- **文件**：主要是删除和整理
- **复杂度**：M
- **完成判据**：
  - [ ] 删除 `molecules/AgentCard/`（或保留但从 TeamCanvas unimport）
  - [ ] `pages/CanvasDebugPage.tsx` 迁到 playground-only 或删掉，路由清理
  - [ ] 所有 Sprint AC 对照 `MILESTONE.md` + PRD §7 逐条走一遍，证据（截图 / log）归档到 `docs/phase4/ACCEPTANCE.md`（新建）
  - [ ] Playground 最后一次版本号升
  - [ ] `tsc` / `build` / `playground:build` 三绿
  - [ ] CDP 脚本跑一次：overflow 审计 + 3 节点并行聊天录屏

---

## 交叉验证矩阵

| 模块 | 验证者（团队成员） | 验证方式 |
|---|---|---|
| store / selector / 纯函数（M 类） | 另一名 dev | 跑单测 + 边界 case 手造 |
| 组件（M 类） | team-lead 或 ux | playground 看 demo + AC 逐条 |
| 胶水（G 类） | team-lead | 端到端手测 + CDP 录屏 |

每次交叉验证后，验证者在任务 AC 下补签一条"✅ {name} 于 YYYY-MM-DD 通过"。未补签不视为完成。

---

## 进度面板

> Sprint 执行期间由 team-lead 维护。以下为空白模板。

| Sprint | 状态 | 起始 | 完成 | 备注 |
|---|---|---|---|---|
| S1 | ⬜ 未开始 | | | |
| S2 | ⬜ 未开始 | | | |
| S3 | ⬜ 未开始 | | | |
| S4 | ⬜ 未开始 | | | |
| S5 | ⬜ 未开始 | | | |
| S6 | ⬜ 未开始 | | | |
