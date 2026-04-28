# Phase 4 TeamCanvas 重构 Milestone

> 出品：planner（基于 pm / ux / fe-arch 三份报告 + 设计稿新发现）
> 版本：v1.0（2026-04-28）
> 范围：`packages/renderer/` — 将 TeamCanvas 从"装胶囊标签的画板"重构为"每节点都是多会话 IM 聊天窗口的协作画布"。

---

## 0. 一句话目标

每个画布节点 = 一个**独立的多会话 IM 聊天窗**。用户可以在同一张画布上同时和 Leader / 多个成员聊天；每个节点展开后左侧是"私聊列表"（用户/Leader/其它成员），右侧是消息流；节点之间通信时长出触手，画布可 pan/zoom，除 team 列表外不出现滚动条。

---

## 1. Phase 4 总体 milestone

| 项 | 约定 |
|---|---|
| 交付范围 | renderer 侧 P0+P1（见 `phase-canvas-v2/PRD.md` §3），不含后端新增字段 |
| 硬约束 | 0 裸 SVG / 0 Tailwind / 0 自研 button-input-dialog / 0 绕过组件库 |
| 前后端边界 | 只用服务端**已有**的 WS 事件 + HTTP 接口（见 §4 数据契约）；服务端不改 |
| 纯净度 | 独立模块不 import 业务单例（bus / store / wsClient）；胶水层才能跨层组合 |
| 单任务上限 | 单个任务 ≤ 200 行代码改动；超了就再拆 |
| 组件库同步 | 每个新增 / 改名组件必须注册 playground，`App.tsx` 版本号 + `index.html` title 同步升版 |
| 交叉验证 | 每个模块完成后由另一名成员走 AC；整 Sprint 结束再做一次集成 |

**Phase 4 完成判据（总 AC）**：
- [ ] PRD §7 的 AC-1 ~ AC-13 全部 PASS
- [ ] 设计稿新发现（左侧私聊列表 / 未读 badge / sidebar 收起）全部落地
- [ ] `npm run -w @mcp-team-hub/renderer tsc` = 0 error
- [ ] `npm run -w @mcp-team-hub/renderer build` 成功
- [ ] `npm run playground:build` 成功
- [ ] Playground 新增 demo 全部可交互（CanvasNode 四态 / InstanceChatPanel / ChatList sidebar / CanvasTopBar / ZoomControl / MiniMap）
- [ ] CDP 自检脚本：`document.querySelectorAll('*')` 里 `overflow: auto|scroll` 只命中 `.team-sidebar__teams-list` 和 `.chat-list__items`
- [ ] 3 节点展开并行对话，消息不串台，每节点独立 WS subscription 正确挂载/卸载
- [ ] 展开态支持 peer 切换（私聊列表）
- [ ] Sidebar 支持收起态（只显示头像 + 未读 badge）
- [ ] comm.* 事件进入对应 instance 消息桶

---

## 2. Sprint 拆分全景

**拆分原则**：每个 Sprint 要么全是独立模块（不 touch 业务），要么是胶水层（把独立模块织进现有链路）。独立模块 Wave 1 并行，胶水 Wave 2 串行。一个 Sprint 做完 = 系统处在一个**可 build / 可展示**的稳定中间态。

```
Sprint 1 ── 基础设施 ──────────► Sprint 2 ── 节点组件 ───┐
     │                                                  │
     └────────► Sprint 3 ── 消息链路 ────────────────────┤
                                                        ▼
                                        Sprint 4 ── 画布集成
                                                        │
                                                        ▼
                                        Sprint 5 ── 交互打磨
                                                        │
                                                        ▼
                                        Sprint 6 ── 触手+性能+收尾
```

---

### Sprint 1 — 基础设施（store / dispatcher / hooks 改造，无 UI）

**子 milestone**：让底层数据结构支持"多 instance 并行聊天"，但页面行为完全不变（主 Agent 单桶仍能跑通）。

**目的**：在不动 UI 的前提下把 `messageStore` / `promptDispatcher` / `handleTurnEvent` / `wsSubscriptions` 全部 per-instance 化，主 Agent 走"默认 instance"路径继续工作。

**交付判据**：
- [ ] `messageStore.byInstance[instanceId]` 分桶结构落地，旧 `messages` 顶层字段被 deprecated（留 selector 回退到 primary 实例以兼容现有 UI）
- [ ] `promptDispatcher` 全部函数接受 `instanceId` 参数；旧接口兼容一层，内部转调
- [ ] `handleTurnEvent` 删除 `did !== pa.instanceId` 过滤，按 driverId 分桶写入
- [ ] `useInstanceSubscriptions` hook 诞生（接受 `instanceIds: string[]`，做增删订阅）；`useWsEvents` 的 primary 单订阅改走它
- [ ] 现有 ExpandedView 页面（主 Agent 聊天）行为完全不变，手动冒烟 + tsc + build 通过
- [ ] 单测：`messageStore.test.ts` / `promptDispatcher.test.ts` / `handleTurnEvent.test.ts` 覆盖分桶 + 跨 instance 隔离

**Wave 1（并行，独立模块）**：
- S1-M1 `messageStore` 分桶（纯 store 改造，不 touch 消费者）
- S1-M2 `promptDispatcher` per-instance（纯函数改造）
- S1-M3 `useInstanceSubscriptions` 新 hook（纯 hook，不挂业务）

**Wave 2（串行，胶水层）**：
- S1-G1 `handleTurnEvent` 去主 Agent 过滤 + 按 driverId 分桶（胶水：S1-M1 依赖）
- S1-G2 `useWsEvents` 改用 `useInstanceSubscriptions`（胶水：S1-M3 依赖）
- S1-G3 现有 ExpandedView 的 dispatcher 调用点补 `instanceId` 参数（胶水：S1-M2 依赖）

---

### Sprint 2 — 节点组件（纯组件，mock 数据）

**子 milestone**：`CanvasNode` / `InstanceChatPanel` / `ChatList` 三个新组件在 playground 里全部可视、可调、可交互（用 mock 数据），但不接真实数据链路。

**目的**：视觉层先跑通，独立于业务。playground demo 即交付物。

**交付判据**：
- [ ] `CanvasNode` 收起态：Avatar + AgentLogo + name + StatusDot + taskCount 徽 + unreadCount 徽
- [ ] `CanvasNode` 展开态骨架：420×540 fixed 浮层，顶栏（drag handle + min + close）+ 主区插槽
- [ ] `InstanceChatPanel` 封装：接受 `instanceId / messages / streaming / onSend / onStop` 等 props，内部复用 organisms/ChatPanel；本身不订 WS
- [ ] `ChatList` molecule：左侧私聊列表，项 = {peerId, peerName, avatar, lastTime, unread}，支持 activeId + onSelect
- [ ] `ChatListItem` atom 或 molecule：单行样式
- [ ] `CanvasTopBar` / `ZoomControl` molecule 骨架（无事件接线）
- [ ] ~~`MiniMap` molecule 骨架~~ → **P2 延后到 S6，本期不做**
- [ ] playground 全部注册 + 可交互 demo
- [ ] Playground 版本号 patch → minor 升（如 v1.5.0 → v1.6.0）
- [ ] 不 import `store/` / `hooks/` / `api/`（纯组件铁律）

**Wave 1（并行，独立模块）**：
- S2-M1 `CanvasNode` 收起态（独立组件，props 驱动）
- S2-M2 `CanvasNode` 展开态骨架（组合容器 + drag handle，不含聊天内容）
- S2-M3 `InstanceChatPanel`（包 ChatPanel，加 header + empty 态）
- S2-M4 `ChatList` + `ChatListItem`（左侧私聊列表）
- S2-M5 `CanvasTopBar` molecule
- S2-M6 `ZoomControl` molecule
- ~~S2-M7 `MiniMap` molecule~~ → **P2 延后到 S6，本期不做**

**Wave 2（串行，胶水层）**：
- S2-G1 playground 注册 + demo 数据 + 版本号升级（集中一次做完）

---

### Sprint 3 — 消息链路（全链路接真实数据）

**子 milestone**：把 Sprint 2 的组件接到 Sprint 1 的分桶 store / dispatcher / subscriptions 上，实现"展开任意 instance 节点 → 订阅 → 发消息 → 接回复 → 不串台"的闭环。此时节点还没进画布，先在一个独立测试页验证。

**目的**：消息链路验证独立于画布布局，降低 debug 面。

**交付判据**：
- [ ] 新建 `pages/CanvasDebugPage.tsx`（临时，交付时删或改 playground-only）：并排两个 `InstanceChatPanel`，两个 instance 能同时发送/接收，消息不串台
- [ ] 发送链路：`InstanceChatPanel.onSend` → `promptDispatcher.sendUserPrompt(instanceId, text)` → WS `op:prompt` 直投
- [ ] 接收链路：每个展开 panel 经 `useInstanceSubscriptions([id])` 订 instance scope → `turn.*` 事件按 instanceId 分桶 → panel 只消费自己桶里的消息
- [ ] 展开瞬间 `ws.get_turns(driverId, 20)` + `ws.get_turn_history(driverId, 20)` 拉初始化数据
- [ ] 关闭 panel → `unsubscribe(instance, id)`
- [ ] cancel 链路：点停止 → `op:cancel_turn({instanceId})`
- [ ] `messageStore` 里的 pendingPrompts 也 per-instance（避免 A 未 streaming 时 B 排队阻塞）
- [ ] 单测：CanvasDebugPage.test.tsx 双 instance 快照切换 + 消息 fixture

**Wave 1（并行，独立模块）**：
- S3-M1 `turnHydrator` per-instance（接受 driverId 写入对应桶）
- S3-M2 `pendingPrompts` per-instance（store 改 + dispatcher 改）
- S3-M3 `CanvasDebugPage` 脚手架（两个 InstanceChatPanel 并排 + instanceId 输入框）

**Wave 2（串行，胶水层）**：
- S3-G1 `InstanceChatPanel` 接 messageStore selector by instanceId + onSend 接 dispatcher
- S3-G2 `InstanceChatPanel` 接 `useInstanceSubscriptions([instanceId])` + 挂载即 get_turns
- S3-G3 `CanvasDebugPage` 串起来 + 手测两个 instance 并发（含主 Agent + 一个成员）

---

### Sprint 4 — 画布集成（CanvasNode 进 TeamCanvas + 展开态 IM）

**子 milestone**：TeamCanvas 用 `CanvasNode` 替代 `AgentCard`；节点展开时按设计稿渲染"左侧 ChatList + 右侧 InstanceChatPanel"；真实数据联通。

**目的**：让画布成为主界面，用户可以在画布上直接和任何成员聊天、切换对话对象。

**交付判据**：
- [ ] TeamCanvas 渲染 CanvasNode 列表，替换原 AgentCard（改名不改文件名也行，TeamCanvas import 目标切换即可）
- [ ] 节点收起态从真实数据取：taskCount 来自 `taskStore`（无则 0）、unreadCount 来自 inbox selector（见 §4）、messageCount 来自 `messageStore.byInstance[id].turns.length`
- [ ] 节点展开：内嵌 `ChatList` + `InstanceChatPanel`；peers = [用户, Leader（若非自己）, 其它成员]
- [ ] ChatList 切换 peer → 右侧面板切换为"当前成员 ↔ 选中 peer"的消息流（数据源见 §4）
- [ ] peer = 用户：消息走 `ws.prompt` + turn.*（现有链路）
- [ ] peer = 其它成员：消息走 `comm.*` 事件 + `POST /api/agents/:id/messages/send`（agent 间通信）
- [ ] unread badge：每个 peer 独立未读计数，点击对话置 0
- [ ] CanvasTopBar + ZoomControl 接入 `useCanvasTransform` 真实 API
- [ ] 关闭按钮从 `TeamMonitorPanel.__close` 移到 CanvasTopBar 最右
- [ ] `PanelWindow.css` overflow: auto → hidden（从 mnemo #891）
- [ ] 单测：CanvasNode 组件交互、ChatList 切 peer、未读计数逻辑

**Wave 1（并行，独立模块）**：
- S4-M1 `instanceChatSelectors`：纯函数，从 `messageStore` 派生某 instance 的 peer 分组（用户/leader/members）
- S4-M2 `unreadStore` 或 `unreadSelectors`：按 (instanceId, peerId) 二级维度算未读
- S4-M3 `TeamCanvas` 新节点绑定：从 teamStore + agentStore join + canvasStates 取坐标（纯函数 `layout.ts` + 组装 hook）
- S4-M4 `CanvasTopBar` + `ZoomControl` 对接 `useCanvasTransform` 真 API（组件内部 refactor，不涉画布）

**Wave 2（串行，胶水层）**：
- S4-G1 `TeamCanvas` import 切换：AgentCard → CanvasNode（只改这一处，保证 diff 小）
- S4-G2 `CanvasNode` 展开态装配 `ChatList` + `InstanceChatPanel`（peer 切换内部 state）
- S4-G3 `PanelWindow.css` overflow + `TeamMonitorPanel` 去 `__close` + 装入 CanvasTopBar
- S4-G4 comm 消息发送 API 接入（`POST /api/agents/:id/messages/send` 现已存在；若否，降级为 toast "跨成员聊天需后端支持"）

---

### Sprint 5 — 交互打磨（定位 / 层叠 / 边界 / sidebar）

**子 milestone**：按 UX 报告把所有交互 bug 修掉，达到"可展示级"。

**目的**：消除 ux 报告里点名的所有视觉 / 交互问题。

**交付判据**：
- [ ] 展开态节点 `position: fixed`，不受 canvas transform 影响（实装 mnemo #891 §AgentCard 展开态用 fixed）
- [ ] z-index 层叠：canvas 1 / viewport 2 / 默认节点 2 / 拖拽中 10 / 展开中 20 / 聚焦展开 30 / TopBar-Zoom-MiniMap 40
- [ ] 节点拖拽 clamp：边界 40px padding，越界回弹
- [ ] 多节点展开位置去重：避免两个展开态完全重叠（自动偏移 24px × 已展开计数）
- [ ] `TeamSidebar` 支持 collapsed 态（只显示头像 + 未读 badge），点击展开；sidebar 内部滚动条保留
- [ ] ChatList 内部滚动（唯一第 2 个允许 overflow 的地方，`.chat-list__items`）
- [ ] Esc 关最近一个展开节点；F 适应画布；0 重置 1×
- [ ] 单测：clamp 边界 / z-index 层级 / Esc 关闭栈 / sidebar 收起态渲染

**Wave 1（并行，独立模块）**：
- S5-M1 `clampToCanvas` 纯函数 + 单测
- S5-M2 `zIndexResolver` 纯函数 + 单测（输入状态 → z-index 数字）
- S5-M3 `TeamSidebar` 收起态样式 + 切换 logic（组件内部）
- S5-M4 `useCanvasHotkeys` hook：Esc/F/0 三键，依赖注入 action

**Wave 2（串行，胶水层）**：
- S5-G1 `CanvasNode` 展开态 fixed 定位 + 偏移算法（用 S5-M2）
- S5-G2 `CanvasNode` 拖拽绑 S5-M1 clamp
- S5-G3 `TeamPage` 挂 S5-M4 hotkeys

---

### Sprint 6 — 触手 + 性能 + 收尾

**子 milestone**：触手按通信活跃；8 成员+3 展开 ≥55fps；MiniMap 联动；回归全量 AC。

**目的**：收尾和性能保证，准备交付。

**交付判据**：
- [ ] `useTentacles` 接受 `activeEdges: {fromId, toId, intensity, lastActiveTs}[]`，只画活跃边
- [ ] `comm.message_sent` / `turn.started` 触发 `activeEdges` 刷新 + 800ms 脉冲
- [ ] 2s 无新消息边 fade out
- [ ] MiniMap 显示全节点 + 当前视口框，点击跳转
- [ ] 性能：8 节点 idle 60fps / 3 展开 1 responding ≥55fps（DevTools Performance 截图留证）
- [ ] VirtualList overscan 5 已生效（mnemo #709 已落地，确认）
- [ ] `tsc` / `build` / `playground:build` 全绿
- [ ] Playground 最终版本号升（minor）
- [ ] PRD §7 AC-1 ~ AC-13 逐条打勾 + 证据
- [ ] CanvasDebugPage 从 pages 移出（转 playground-only）

**Wave 1（并行，独立模块）**：
- S6-M1 `activeEdges` selector：纯函数，从 messageStore + 时间戳派生
- S6-M2 `useTentacles` 改造接新参数（保持旧签名默认值兼容）
- S6-M3 `MiniMap` 交互逻辑（viewport 框 + 点击 setTransform）
- S6-M4 性能探针：`useRenderCount` dev-only，统计各组件重渲染次数

**Wave 2（串行，胶水层）**：
- S6-G1 `TeamCanvas` 接 S6-M1 + S6-M2
- S6-G2 `TeamCanvas` 挂 MiniMap
- S6-G3 全量 AC 回归 + 收尾清理

---

## 3. Sprint 间依赖

| Sprint | 依赖 | 说明 |
|---|---|---|
| S1 | — | 纯底层改造，可独立开始 |
| S2 | — | 纯组件 + mock，和 S1 可并行 |
| S3 | S1 完成 + S2 完成 | 需要 store 分桶 + 组件实体都在位 |
| S4 | S3 完成 | 画布挂真实数据前必须先 verify 单 instance 链路 |
| S5 | S4 完成 | 交互打磨基于已集成画布 |
| S6 | S5 完成 | 性能与触手依赖交互稳定后再调 |

**人力并行建议**：
- Day 1~2：A、B、C 三人分别跑 S1 / S2-Wave1 第一批 / S2-Wave1 第二批
- Day 3：S1 胶水 + S2 胶水合流，启动 S3
- Day 4：S3 完成，启动 S4
- Day 5~8：S4 单独 4 天（G2 拆分后工作量增加，原 3 天不够）
- Day 9~10：S5 推进
- Day 11：S6 + 回归

---

## 4. Sprint 之间的"稳定快照"

每个 Sprint 结束时系统应可 build + 可手测：

| Sprint 结束快照 | 页面能做什么 |
|---|---|
| S1 完 | 主 Agent 聊天（ExpandedView）完全正常，画布完全正常；代码底层已分桶 |
| S2 完 | Playground 能看所有新组件；业务页面不变 |
| S3 完 | CanvasDebugPage 两个 instance 并行聊天 OK；画布页面还是旧 AgentCard |
| S4 完 | TeamCanvas 节点展开能聊 = 核心 demo 可展示 |
| S5 完 | 所有交互干净，可对外 demo |
| S6 完 | 达 Phase 4 交付标准 |

---

## 5. 硬性工作流（每个模块都要走）

1. **开工前** `mnemo__search` 本模块关键词，看是否有前人结论
2. **开工前** 读 `INTERFACE-CONTRACTS.md` 对应节，确认签名
3. 写代码 + 写单测（新模块必须带单测，铁律）
4. `tsc` / `build` 自检
5. 组件类：playground 注册 + demo + 版本号升级
6. 交叉验证：指派另一名成员走 AC
7. 收工 `mnemo__create_knowledge` 存非显然经验

---

## 6. 风险与退路

| 风险 | 处置 |
|---|---|
| `messageStore` 分桶改动面大，破坏现有消费者 | S1-M1 提供兼容 selector `selectPrimaryMessages(state)`，所有现有消费点零改动先通过，下个 Sprint 再替换 |
| `useInstanceSubscriptions` 频繁变化导致 WS 订阅抖动 | hook 内部用 Set diff + 120ms debounce；单测覆盖快速挂卸 |
| `comm.*` 跨成员聊天接口未就绪 | S4-G4 降级为只读 + toast；不阻塞 S4 主干 |
| 展开态 fixed 脱离 transform，节点位置跟随错位 | 锚点用 `rootEl.getBoundingClientRect()` 计算，加 `pan/zoom` 变化监听刷新 |
| 8 节点性能回退 | S6-M4 探针优先做，出问题才回 memo/selector 优化 |

---

## 7. 参考文档

| 文件 | 用途 |
|---|---|
| `phase-canvas-v2/PRD.md` | PM 原始 PRD，验收标准源头 |
| `phase4/TASK-LIST.md` | 本 milestone 的任务级分解（本目录同级） |
| `phase4/INTERFACE-CONTRACTS.md` | 接口冻结文档（本目录同级） |
| `packages/renderer/.claude/CLAUDE.md` | 组件库铁律 |
| `docs/frontend-api/ws-protocol.md` | WS 协议契约 |
| `docs/frontend-api/turn-events.md` | turn.* 事件语义 |
| `docs/frontend-api/bus-events.md` | comm.* / team.* / instance.* 事件语义 |
| `docs/frontend-api/messages-api.md` | agent 间通信 HTTP |
