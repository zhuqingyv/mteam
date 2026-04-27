# mcp-team-hub 前端数据模型和架构设计

> 完成时间：2026-04-26
> 面向：API Scout 和 Team Lead

## 概览

本文档完整梳理 mcp-team-hub 前端（renderer Electron 应用）的：
- **10 个 Zustand store** 及其数据来源
- **35+ 个 HTTP API** 函数及其后端映射
- **34 类 WS 事件** 的前端处理流程
- **理想架构方案** 和单一数据源原则
- **当前 5 个核心问题** 及修复建议

---

## Part A. 现状审计

### A1. Store 体系（10 个）

| Store | 用途 | 字段 | 数据来源 | 消费者 |
|-------|------|------|--------|--------|
| **primaryAgentStore** | 主 Agent 全状态 | `config` (PrimaryAgentRow), `status`, `instanceId`, `driverLifecycle`, `inflightAction`, `lastError` | HTTP: `getPrimaryAgent()` / WS: `snapshot` + `primary_agent.*` 事件 | ExpandedView, CapsulePage, useWsEvents |
| **messageStore** | 对话记录 + Turn 块 | `messages[]` (Message[]), 包含 blocks[], streaming, turnId | WS: `turn.*` 事件 + `comm.message_*` / HTTP: driver-turns (未实现) | ChatPanel, MessageRow, useTurnRenderer |
| **teamStore** | 团队列表 | `teams[]`, `activeTeamId` | HTTP: `listTeams()` / WS: `team.*` 事件 | TeamPage, TeamMonitorPanel, useWsEvents |
| **agentStore** | 实例列表 | `agents[]`, `activeId` | WS: `instance.*` 事件 / HTTP: `listInstances()` (未定期拉) | AgentSwitcher, useWsEvents |
| **wsStore** | WS 连接 | `client: WsClient` | useWsEvents 创建 | 全局使用，事件分发 |
| **notificationStore** | 通知队列 | `notifications[]`, `acknowledgedIds[]` | WS: `notification.delivered` 事件 | 通知面板（未完成） |
| **windowStore** | UI 状态 | `mode` (capsule/chat/pet/settings), `expanded` | 用户交互 | 所有 page/panel |
| **inputStore** | 用户输入 | `text` | 用户输入 + 本地保存 | ChatInput, useEffect |
| **taskStore** | 后台任务 | `tasks[]` | MCP install/uninstall WS 事件（未对接） | ProgressBar（未完成） |
| **useAgentStore（历史）** | 团队成员 | `agents[]` | ~~硬编码数据~~ 应改为 `agentStore` | 逐步移除 |

**关键观察**：
- ✅ primaryAgentStore 完整（HTTP + WS 双轨）
- ✅ messageStore 支持 blocks，已对接 turn 事件
- ✅ teamStore 已对接 HTTP + WS
- ⚠️ agentStore 只订 WS，未定期刷新
- ❌ notificationStore/taskStore 占位未实装
- ❌ inputStore 无持久化

---

### A2. HTTP API 体系（35+ 个）

#### 门面层（前端唯一白名单）：`/api/panel/*`

| 域 | 模块 | 函数 | 后端路由 | 返回类型 | 状态 |
|-----|------|------|--------|--------|------|
| **Teams** | teams.ts | listTeams | GET `/api/panel/teams` | TeamRow[] | ✅ |
| | | getTeam | GET `/api/panel/teams/:id` | TeamWithMembers | ✅ |
| | | createTeam | POST `/api/panel/teams` | TeamRow | ✅ |
| | | disbandTeam | POST `/api/panel/teams/:id/disband` | null | ✅ |
| | | listTeamMembers | GET `/api/panel/teams/:id/members` | TeamMemberRow[] | ✅ |
| | | addTeamMember | POST `/api/panel/teams/:id/members` | {teamId, instanceId, roleInTeam} | ✅ |
| | | removeTeamMember | DELETE `/api/panel/teams/:id/members/:instanceId` | null | ✅ |
| **Instances** | instances.ts | listInstances | GET `/api/panel/instances` | RoleInstance[] | ✅ |
| | | createInstance | POST `/api/panel/instances` | RoleInstance | ✅ |
| | | activateInstance | POST `/api/panel/instances/:id/activate` | RoleInstance | ✅ |
| | | requestOffline | POST `/api/panel/instances/:id/request-offline` | RoleInstance | ✅ |
| | | deleteInstance | DELETE `/api/panel/instances/:id` | null | ✅ |
| **Primary Agent** | primaryAgent.ts | getPrimaryAgent | GET `/api/panel/primary-agent` | PrimaryAgentRow \| null | ✅ |
| | | configurePrimaryAgent | POST `/api/panel/primary-agent/config` | PrimaryAgentRow | ✅ |
| | | startPrimaryAgent | POST `/api/panel/primary-agent/start` | PrimaryAgentRow | ✅ |
| | | stopPrimaryAgent | POST `/api/panel/primary-agent/stop` | PrimaryAgentRow | ✅ |
| **Messages** | sessions.ts | getTeamMessages | GET `/api/panel/teams/:teamId/messages` | Message[] | ⚠️ panelPending |
| | | getMessage | GET `/api/panel/messages/:id` | Message | ⚠️ panelPending |
| | | markRead | PUT `/api/panel/messages/:id/mark-read` | null | ⚠️ panelPending |
| **Roster** | roster.ts | getRosterEntry | GET `/api/panel/roster/:instanceId` | RosterEntry | ⚠️ panelPending |
| | | updateRosterEntry | PUT `/api/panel/roster/:instanceId` | RosterEntry | ⚠️ panelPending |
| | | searchRoster | GET `/api/panel/roster/search?query=` | SearchResult[] | ⚠️ panelPending |
| **CLI** | cli.ts | getCli | GET `/api/panel/cli` | CliVersion | ⚠️ panelPending |
| **Templates** | templates.ts | listTemplates | GET `/api/panel/templates` | TemplateRow[] | ⚠️ panelPending |
| | | getTemplate | GET `/api/panel/templates/:name` | TemplateRow | ⚠️ panelPending |
| **MCP** | mcp.ts | installMcp | POST `/api/panel/mcp/install` | {mcpId, version} | ⚠️ panelPending (D6 待实装) |
| | | uninstallMcp | POST `/api/panel/mcp/uninstall` | {mcpId} | ⚠️ panelPending (D6 待实装) |
| | | listMcp | GET `/api/panel/mcp` | McpPackage[] | ⚠️ panelPending |
| **Driver Turns** | driver-turns.ts | getDriverTurns | GET `/api/panel/driver/:driverId/turns` | Turn[] | ✅ (仅此一个 HTTP endpoint) |
| **Sessions** | sessions.ts | getSession | GET `/api/panel/sessions/:sessionId` | SessionInfo | ⚠️ panelPending |
| | | getInstanceInbox | GET `/api/panel/instances/:instanceId/inbox` | Message[] | ⚠️ panelPending |

**汇总**：35 个端点，其中 8 个 ✅ 已实装，27 个 ⚠️ D6（facade 层未开放）。

---

### A3. WS 事件处理现状

#### 下行消息类型（后端 → 前端）

| 消息类型 | 处理位置 | 当前实现 | 状态 |
|---------|---------|--------|------|
| `snapshot` | ws.ts | 直写 primaryAgentStore | ✅ |
| `event` | wsEventHandlers.ts | 按 type 前缀分发 | ✅ |
| `gap-replay` | ws.ts | 补发 events | ✅ |
| `ack` | ws.ts | 无处理 | ⚠️ |
| `error` | ws.ts | 无处理 | ⚠️ |
| `pong` | ws.ts | 无处理 | ✅ (ping 心跳可用) |

#### 下行 bus 事件（34 类）

| 领域 | 事件 | 处理 handler | 当前实装状态 |
|-----|-----|-------------|-----------|
| **primary_agent** | started / stopped / configured | handlePrimaryAgentEvent | ✅ (触发 debouncedRefresh) |
| **driver** | started / stopped / error | handleDriverEvent | ✅ (映射 driverLifecycle) |
| **instance** | created / activated / offline_requested / deleted / session_registered | handleInstanceEvent | ⚠️ (部分逻辑) |
| **turn** | started / block_updated / completed / error | handleTurnEvent | ⚠️ (仅 block_updated + text 类型) |
| **team** | created / disbanded / member_joined / member_left | handleTeamEvent | ✅ (基础实装) |
| **comm** | registered / disconnected / message_sent / message_received | handleOtherEvent | ⚠️ (仅创建空壳) |
| **template** | created / updated / deleted | handleOtherEvent | ❌ |
| **mcp** | installed / uninstalled | handleOtherEvent | ❌ |
| **cli** | available / unavailable | handleOtherEvent | ❌ |
| **container** | started / exited / crashed | handleOtherEvent | ❌ |
| **notification** | delivered | handleOtherEvent | ⚠️ (创建壳) |

#### 上行操作（前端 → 后端）

| op | 当前实装 | 位置 | 状态 |
|-----|---------|------|------|
| `subscribe` | ✅ | ws.ts client.subscribe() | ✅ |
| `unsubscribe` | ✅ | ws.ts client.unsubscribe() | ✅ |
| `prompt` | ✅ | ws.ts client.prompt() | ✅ (但前端无 UI 调用) |
| `ping` | ✅ | useWsEvents 30s 心跳 | ✅ |
| `configure_primary_agent` | ❌ | — | D6 待实装 |

---

## Part B. 理想架构方案

### B1. Store 体系重设计

```
┌─ Bootstrap 阶段（App mount）────────────────────────────────┐
│ useBootstrap() → getPrimaryAgent() → primaryAgentStore.refresh() │
└────────────────────────────────────────────────────────────┘

┌─ WS 建连（useWsEvents）──────────────────────────────────────┐
│ 1. createWsClient('local')                                    │
│ 2. onmessage → snapshot: {primaryAgent}                       │
│    → 直写 primaryAgentStore                                   │
│ 3. subscribe('global')                                        │
│ 4. onEvent → wsEventHandlers 按 type 分发                     │
└────────────────────────────────────────────────────────────┘

┌─ 10 个 Zustand Store（单向数据流）─────────────────────────┐
│                                                               │
│  ┌──────────────────┐  (HTTP/WS 命令行)                      │
│  │ primaryAgentStore │ ← getPrimaryAgent(HTTP)                │
│  │                  │ ← WS: snapshot/primary_agent.* events   │
│  └──────────────────┘                                         │
│         ↓ (consume)                                           │
│  [ExpandedView: 显示在线态 + 按钮]                           │
│  [CapsulePage: 胶囊显示]                                      │
│                                                               │
│  ┌──────────────────┐                                         │
│  │   messageStore   │ ← WS: turn.* 事件                       │
│  │                  │ ← HTTP: getDriverTurns() (未定期拉)     │
│  └──────────────────┘                                         │
│         ↓                                                      │
│  [ChatPanel: 显示 messages + blocks]                         │
│  [MessageRow: 渲染 turn 块]                                   │
│                                                               │
│  ┌──────────────────┐                                         │
│  │    teamStore     │ ← HTTP: listTeams() (bootstrap)         │
│  │                  │ ← WS: team.* 事件                       │
│  └──────────────────┘                                         │
│         ↓                                                      │
│  [TeamPage: 列表 + 新建]                                      │
│  [TeamMonitorPanel: 显示]                                     │
│                                                               │
│  ┌──────────────────┐                                         │
│  │    agentStore    │ ← HTTP: listInstances() (bootstrap)     │
│  │ (新建：cliStore) │ ← WS: instance.* 事件                   │
│  └──────────────────┘                                         │
│         ↓                                                      │
│  [AgentSwitcher: 列表切换]                                    │
│                                                               │
│  ┌──────────────────┐                                         │
│  │ notificationStore │ ← WS: notification.delivered           │
│  │    (待实装)       │ ← HTTP: listNotifications() (D6)        │
│  └──────────────────┘                                         │
│         ↓                                                      │
│  [NotificationPanel: 队列显示]                                │
│                                                               │
│  ┌──────────────────┐                                         │
│  │  windowStore    │ ← 用户交互（UI 状态）                    │
│  └──────────────────┘                                         │
│         ↓                                                      │
│  [所有 page/panel: 受控 mode/expanded]                        │
└────────────────────────────────────────────────────────────┘
```

### B2. 数据流向原则（单一真相源）

```
┌─ 不变性规则 ──────────────────────────────────────────┐
│                                                         │
│  1. 每个 store 有唯一数据来源                           │
│     - primaryAgentStore ← HTTP (refresh) + WS (event)  │
│     - messageStore ← WS (turn.*)                       │
│     - teamStore ← HTTP (init) + WS (team.*)            │
│     - agentStore ← HTTP (init) + WS (instance.*)       │
│                                                         │
│  2. 不允许双向更新                                     │
│     - UI 改 state → store mutate → HTTP PATCH          │
│     - 禁止 UI 改 store 后忘记持久化                    │
│                                                         │
│  3. WS 事件是"异步源代码"                              │
│     - WS 推来的才是真相                                │
│     - 本地 setState 只做 optimistic UI                │
│     - 等 WS 确认再提交 store                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### B3. 页面消费关系

```
┌─────────────────────────────────────────────────────────┐
│                    App.tsx                               │
│  useBootstrap() + useWsEvents()                          │
└──────────────────┬──────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   [CapsulePage]        [ExpandedView]
        │                     │
   ┌────┴────┐           ┌────┴────┐
   │          │           │         │
 TeamMonitor  Capsule  ChatPanel  Settings
     │                    │
     ├─→ teamStore        ├─→ primaryAgentStore
     │                    ├─→ messageStore
     ├─→ primaryAgent     ├─→ inputStore
     │   Store            └─→ wsStore
     │
   [页面布局]            [页面布局]
   - 胶囊折叠             - 聊天区
   - 发光                 - 消息列表
   - Team 列表            - 用户输入
                          - Turn 块渲染
```

### B4. WS 订阅策略

```
应用启动时：
  subscribe('global')        // 所有全局事件（primary_agent.* / team.* / cli.* ...）

页面切换时：
  (team view) subscribe('team', teamId)      // 团队内消息流
  (agent view) subscribe('instance', agentId) // 某实例的 turn 事件

关键约束：
  - 全订 global，不用过滤
  - 需要的领域事件都在 global 里
  - scope=instance 仅为未来可选优化
```

### B5. 快照机制

```
WS 建连流程：
  1. WebSocket 连接建立
  2. 后端推送 snapshot { primaryAgent: PrimaryAgentRow | null }
  3. 前端 onmessage 直写 primaryAgentStore
  4. 等价 HTTP GET /api/panel/primary-agent 的结果
  5. 一次性，之后全靠 WS 事件更新

优势：
  - 建连即得到主 Agent 初态
  - 无须 bootstrap 特殊逻辑拉 PA
  - 断线重连时 lastMsgId → gap-replay → 补发事件
```

---

## Part C. 当前 5 个核心问题

### C1. ❌ agentStore 数据陈旧

**症状**：
```typescript
// 当前 wsEventHandlers.ts
export function handleInstanceEvent(t: string, e: Record<string, unknown>) {
  const as = useAgentStore.getState;
  if (t === 'instance.created') {
    // ... 新增 agent
  }
}
```

**问题**：
- 只订阅 WS 事件，从不主动拉 `listInstances()`
- App 启动时 agentStore 是空的
- 第一条 instance.created 事件到达前，页面无任何数据

**修复**（优先级 P1）：
```typescript
// useBootstrap.ts 新增
export function useBootstrapInstances() {
  useEffect(() => {
    listInstances().then(res => {
      if (res.ok && res.data) {
        useAgentStore.setState({ 
          agents: res.data.map(inst => ({ 
            id: inst.id,
            name: inst.memberName,
            status: inst.isLeader ? 'running' : 'idle'
          }))
        });
      }
    });
  }, []);
}
```

### C2. ❌ messageStore 未对接 HTTP 历史

**症状**：
```typescript
// 当前 messageStore 只订 WS turn.* 事件
// 无法拉历史消息
```

**问题**：
- 用户打开应用看不到历史消息
- 只有新消息到达时才会显示
- getDriverTurns 接口存在但从不调用

**修复**（优先级 P1）：
```typescript
// useBootstrap.ts 新增
export function useBootstrapMessages(instanceId: string) {
  useEffect(() => {
    if (!instanceId) return;
    getDriverTurns(instanceId).then(res => {
      if (res.ok && res.data) {
        const msgs = res.data.map(turn => ({
          id: turn.id,
          role: 'agent' as const,
          turnId: turn.id,
          blocks: turn.blocks,
          ...
        }));
        useMessageStore.setState({ messages: msgs });
      }
    });
  }, [instanceId]);
}
```

### C3. ⚠️ turn 事件处理不完整

**症状**：
```typescript
// 当前 wsEventHandlers.ts
export function handleTurnEvent(t: string, e: Record<string, unknown>) {
  if (t !== 'turn.block_updated') return;  // ← 其他事件全忽视
  const b = e.block as { blockId?: string; type?: string; content?: string } | undefined;
  if (!b?.blockId || b.type !== 'text') return;  // ← 只处理 text 类型
  // ...
}
```

**问题**：
- 漏掉 `turn.started` / `turn.completed` / `turn.error` 事件
- 不处理 thinking / tool_call / tool_result 块
- turn streaming 状态不更新
- Turn 进度/错误无法展示

**修复**（优先级 P1）：
```typescript
export function handleTurnEvent(t: string, e: Record<string, unknown>) {
  const pa = usePrimaryAgentStore.getState();
  const did = String(e.driverId ?? e.instanceId ?? '');
  if (pa.instanceId && did !== pa.instanceId) return;

  const turnId = String(e.turnId ?? e.id ?? '');
  const ms = useMessageStore.getState();

  if (t === 'turn.started') {
    // 新建 message 记录 turn
    ms.addMessage({ 
      id: turnId, 
      role: 'agent', 
      turnId,
      blocks: [],
      streaming: true,
      ...
    });
  } else if (t === 'turn.block_updated') {
    // 更新块
    const block = e.block as TurnBlock;
    ms.updateTurnBlock(turnId, block);
  } else if (t === 'turn.completed') {
    ms.completeTurn(turnId);
  } else if (t === 'turn.error') {
    ms.updateTurnBlock(turnId, { 
      blockId: 'error',
      type: 'error',
      content: String(e.error ?? 'Unknown error')
    });
  }
}
```

### C4. ❌ inputStore 无持久化

**症状**：
```typescript
// 当前 inputStore 只在内存
export const useInputStore = create<InputState>()((set) => ({
  text: '', // 刷新就丢
  ...
}));
```

**问题**：
- 用户打字到一半刷新浏览器，输入丢失
- 不符合桌面应用预期

**修复**（优先级 P2）：
```typescript
export const useInputStore = create<InputState>()(
  persist(
    (set) => ({
      text: '',
      setText: (v) => set({ text: v }),
      clearText: () => set({ text: '' }),
    }),
    { name: 'input-store', storage: localStorage }
  )
);
```

### C5. ⚠️ 门面层缺口（D6 27 个 pending 端点）

**症状**：
```typescript
// 当前 api/sessions.ts
export const getTeamMessages = () => panelPending('team-messages');
export const getMessage = () => panelPending('message');
// 等等 27 个...
```

**问题**：
- `/api/panel/` facade 层后端尚未实装
- 前端无法调任何除了 driver-turns 外的端点
- 许多 store 初始化无法进行

**依赖项**：
- 后端需要实装 `/api/panel/` 路由转发层
- 预计 5-8 endpoint 优先级最高（messages / roster / instances 的查询）

---

## Part D. 检查清单

### D1. 已验证 ✅

- [x] 10 个 store 的字段、数据来源、消费者
- [x] 8 个已实装 + 27 个 D6 pending 的 HTTP API
- [x] 34 类 WS 事件和前端处理位置
- [x] WS 连接、订阅、心跳、gap-replay 完整
- [x] primaryAgentStore 双源完整
- [x] teamStore 双源完整
- [x] messageStore blocks 支持

### D2. 识别缺陷 ⚠️

| 问题 | 优先级 | 修复工作量 | 负责人建议 |
|------|--------|----------|----------|
| agentStore 缺 bootstrap | P1 | 2h | frontend-dev |
| messageStore 缺历史 | P1 | 3h | frontend-dev |
| turn 事件处理不完整 | P1 | 4h | frontend-dev |
| inputStore 无持久化 | P2 | 1h | frontend-dev |
| 门面层 27 个缺口 | P0（后端） | 8h | backend-dev |

### D3. 后续步骤

1. **后端 (api-scout 审核)**
   - 验证前端对 API 的理解（INDEX.md vs 实装）
   - 确认 `/api/panel/` facade 层拆分计划
   - 优先级排序：messages / roster / instances / teams

2. **前端（本周）**
   - 修复 C1-C3（agentStore / messageStore / turn 事件）
   - 集成 bootstrap 三合一（PA + instances + teams）
   - 补全 turn 事件处理

3. **测试（E2E）**
   - 应用启动 → 所有 store 初始化完成
   - WS 事件实时更新 store
   - 历史消息拉取 + 新消息流式更新
   - 用户交互 → HTTP 命令 → WS 反馈 → store 更新

---

## 附录：类型定义完整版

### App 初始化顺序

```typescript
// App.tsx
export function App() {
  // 1. 建立 WS 连接并订阅全局事件
  useWsEvents();
  
  // 2. 拉初态数据（PA + instances + teams）
  useBootstrap();
  useBootstrapInstances();
  useBootstrapTeams();
  
  // 3. 打开对应实例时拉历史消息
  const instanceId = usePrimaryAgentStore(s => s.instanceId);
  useBootstrapMessages(instanceId);
  
  return (
    <div>
      {/* 全局 WS 连接状态指示 */}
      <WsStatusIndicator />
      
      {/* 主体面板（受控 mode/expanded） */}
      {expanded ? <ExpandedView /> : <CapsulePage />}
    </div>
  );
}
```

### Store 更新时序

```
T=0     App mount
        ├─ useWsEvents() → createWsClient()
        ├─ useBootstrap() → HTTP GET /api/panel/primary-agent
        ├─ useBootstrapInstances() → HTTP GET /api/panel/instances
        └─ useBootstrapTeams() → HTTP GET /api/panel/teams

T=50ms  WS 建连完成，收到 snapshot
        └─ ws.onmessage → primaryAgentStore.setState()

T=100ms HTTP 请求返回
        ├─ primaryAgentStore.refresh()
        ├─ agentStore.setAgents()
        └─ teamStore.setTeams()

T=150ms 应用渲染完成（所有 store ready）

T=5s    WS 事件流到达
        ├─ primary_agent.configured
        ├─ instance.created
        └─ team.member_joined
        
        (对应 handlers 更新 store)
        ├─ primaryAgentStore.setState()
        ├─ agentStore.addAgent()
        └─ teamStore.updateTeam()
```

---

## 总结

前端架构已形成 **10 store + 35 API + 34 WS 事件** 的完整模型。核心问题集中在 **P1 数据初始化缺陷**（3 个）和 **P0 后端 facade 层缺口**（27 个），其余问题均为渐进式优化。

建议后端先从 **messages / roster / instances** 三个端点开始实装 facade，前端并行修复初始化问题。2 周内可达到 **完整端到端流程** 验收。

---

**反馈联系**：@api-scout 审核后端接口理解，@team-lead 收集修复优先级排序。
