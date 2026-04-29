# Phase 4 E2E 全链路测试方案

> 版本：v1.0（2026-04-28）
> 范围：packages/renderer Phase 4 TeamCanvas 重构的端到端验证
> 目标：在不 mock store / WS 的前提下，跑通多节点并行聊天的完整链路

---

## 0. 一句话目标

用 Playwright + Electron CDP 直连真实渲染进程，驱动画布、节点、私聊列表和消息流，断言 store 状态 + DOM 表现双路一致，证明 Phase 4 的 instance 分桶和 WS 订阅/通信链路在真实运行环境下不掉链。

---

## 1. 技术选型

- **驱动**：Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')`，附到已运行的 Electron dev 实例
- **连接模式**：CDP（见 mnemo id 542）。Electron `main.ts` dev 下 `appendSwitch('remote-debugging-port', '9222')` 开 CDP；测试脚本复用活跃 renderer，不走 `app.launch`
- **Node**：20.x，跑 CDP 原生 WebSocket 必须带 `--experimental-websocket`（见 mnemo id 597）
- **外部页面**：若需要打开非 Electron URL（例如 Playground 5190），另起独立 `chromium.launch`，不复用 Electron 的 CDP context（见 mnemo id 808）
- **断言双路**：
  - DOM 层：`[data-instance-id="{iid}"]` + ChatPanel 的消息 list 选择器
  - store 层：`window.__messageStore.getState().byInstance[iid].messages`（dev 门控，见 App.tsx）

---

## 2. Mock 策略

**原则**：不 mock store / WS，只在 HTTP 层短路，让事件流尽量真实。

- **不 mock**：`useMessageStore` / `useTeamStore` / `useAgentStore` / `usePrimaryAgentStore` / WS client / `useInstanceSubscriptions`
- **HTTP mock 点**：
  - `POST /api/panel/primary-agent/mock-turn` — 由测试注入一次 turn 事件序列，走真实 WS 广播
  - `POST /api/panel/comm/emit` — 测试注入 agent 间 `comm.*` 事件（comm-in / comm-out）
  - 其它 HTTP 接口（templates / roster / sessions 等）保持真实
- **理由**：Phase 4 的核心是 WS→store→DOM 链路。mock WS 会把被测行为做成假货；HTTP 层做短路只是把事件触发点从真模型移到测试脚本，链路本身仍是生产代码

---

## 3. 前置依赖

| 依赖 | 状态 | 备注 |
|------|------|------|
| App.tsx dev 门控暴露 store 到 window | ✅ 本任务 | `__messageStore` / `__teamStore` / `__agentStore` / `__primaryAgentStore` |
| CanvasNode `data-instance-id` | ✅ 本任务 | DOM 查找节点入口 |
| Electron main.ts dev CDP 开关 | 已有 | `remote-debugging-port=9222` |
| 后端 `/api/panel/primary-agent/mock-turn` | ⏳ 后端 | 注入 turn 事件 |
| 后端 `/api/panel/comm/emit` | ⏳ 后端 | 注入 comm 事件 |
| S1 分桶 store 落地 | 依赖 S1-M1/M2/M3 | 无分桶 E2E 无意义 |
| S2 InstanceChatPanel / ChatList | 依赖 S2 | S2-S3 断言私聊切换 |
| S3 消息链路打通 | 依赖 S3 | S4-S6 断言 comm 事件路由 |

---

## 4. 场景清单

### P4-S1 主 Agent 单桶冒烟（Wave 1）

**目标**：验 dev 门控 + CanvasNode 入口 + 现有主 Agent 单桶路径零回退

**步骤**：
1. connectOverCDP 附到 Electron
2. 打开 CapsulePage，触发 primary agent ready
3. 读 `window.__primaryAgentStore.getState()`，拿 `instanceId`
4. 读 `document.querySelector('[data-instance-id="${iid}"]')`（若画布已展开）
5. 通过 `POST /api/panel/primary-agent/mock-turn` 注入一条 user→agent 的 turn

**断言**：
- `__messageStore.getState().byInstance[iid].messages.length === 1`
- DOM 上主 Agent 聊天面板出现消息
- 旧 `messages` 顶层字段（deprecated 代理）同步可见

---

### P4-S2 两节点并行聊天，消息不串桶（Wave 1）

**目标**：验 per-instance 分桶 + 独立 subscription，是 Phase 4 的核心不变量

**步骤**：
1. 创建团队（HTTP `POST /api/panel/teams`）+ 两个成员 instance A / B
2. 展开 A、B 两个 CanvasNode
3. 同时 `POST /api/panel/primary-agent/mock-turn` 向 A 和 B 各推一条
4. 等 WS 事件回流

**断言**：
- `byInstance[A].messages.length === 1` 且内容 = A 的注入
- `byInstance[B].messages.length === 1` 且内容 = B 的注入
- DOM 上 A / B 两个 ChatPanel 互不串消息
- A 的 `pendingPrompts` 不被 B 清空

---

### P4-S3 展开态私聊 peer 切换（Wave 2）

**目标**：验 ChatList 私聊切换不丢消息、不回退订阅

**步骤**：
1. 展开 Leader 节点 → 左侧私聊列表显示 user / 成员 A / 成员 B
2. 默认选中 user，注入 user→leader turn
3. 切到成员 A，`POST /api/panel/comm/emit` 注入 leader→A comm-out 一条
4. 切回 user

**断言**：
- 切换时右侧消息流按 peer 过滤（只显示当前 peer 对话）
- `byInstance[leaderIid].messages` 既含 user peer 又含 memberA peer 消息
- 回到 user 时 user 对话完整（不丢历史）

---

### P4-S4 comm.* 事件路由到正确 instance（Wave 2）

**目标**：验 Leader→Member comm 事件走 instance 分桶写入

**步骤**：
1. 展开 Leader + Member A
2. `POST /api/panel/comm/emit` 注入一条 leader→A 的 `comm.message`
3. 同上注入一条 A→leader 的 `comm.message` 回信

**断言**：
- `byInstance[leaderIid].messages` 出现 peerId=A, kind=comm-out 的消息
- `byInstance[A].messages` 出现 peerId=leader, kind=comm-in 的消息
- 触手动画触发（`document.querySelector('.tentacle--{from}-{to}')` 出现）

---

### P4-S5 Sidebar 收起态（Wave 3）

**目标**：验设计稿新发现「sidebar 收起只显示头像 + 未读 badge」

**步骤**：
1. 画布侧栏 toggle 到收起态
2. 注入多条 comm 事件打到不同成员（让他们产生未读）

**断言**：
- `.team-sidebar--collapsed` 存在
- 每个成员项只剩头像 + 未读 badge
- 点击头像能展开对应节点

---

### P4-S6 画布 pan/zoom 与节点拖拽（Wave 3）

**目标**：验画布交互不破坏 instance subscription（pan/zoom 后节点依旧收消息）

**步骤**：
1. 画布 pan 到某位置，zoom 到 0.5
2. 拖拽节点 A 到新位置
3. 注入 turn 到 A

**断言**：
- A 的新位置被 `nodePositions[A]` 记录
- A 的消息仍然正确入桶
- `overflow: auto|scroll` 仍然只命中白名单（`.team-sidebar__teams-list` / `.chat-list__items`）

---

## 5. Wave 分层

| Wave | 场景 | 依赖的 Sprint | 谁写 |
|------|------|---------------|------|
| Wave 1A | 基础设施（本任务） | — | 前端：store 暴露 + data-instance-id + 本文档 |
| Wave 1B | P4-S1 / P4-S2 | S1 完成 | QA + 前端配合 |
| Wave 2 | P4-S3 / P4-S4 | S2 + S3 完成 | QA + 前端 |
| Wave 3 | P4-S5 / P4-S6 | S4 + S5 完成 | QA |
| Wave 4 | 全链路回归 + CDP overflow 白名单检测 | S6 完成 | QA |

---

## 6. 注意事项

- dev-only：`window.__*Store` 仅在 `import.meta.env.DEV === true` 时挂载；生产构建禁止访问
- CDP 连接后不要 `browser.close()`，否则 Electron 一起挂；用 `browser.disconnect()`
- 多节点并行测试时，WS `subscribe` 有 120ms debounce（S1-M3），断言前要等 >= 120ms
- store 断言优先 `getState()` 直读；避免依赖 React 渲染时序
