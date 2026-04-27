# Phase 2 PRD：主 Agent 创建 Leader 与 teamCanvas 自动唤起

## 需求概述

本阶段交付 **两个前后端协同的功能**：

1. **需求 1**：主 Agent 通过 mteam-primary MCP 的 `create_leader` 工具创建 leader（项目经理角色），并通过 `send_to_agent` 工具与 leader 通信安排任务
2. **需求 2**：创建 team 后，前端自动唤起 teamCanvas（团队画布面板），使用户无需手动操作

## 需求背景

- **主 Agent** 是"秘书+总机"，不下场干活
- **Leader** 是由主 Agent 创建的"项目经理"实例，拥有成员管理权限
- **teamCanvas** 是团队协作面板，展示 leader 和 team members 的实时状态与通信

当前状态：
- 后端 mteam-primary MCP 已实现 `create_leader` / `send_to_agent` 工具（mnemo #613, #623, #625）
- 前端 teamStore + WS + TeamPage 已支持 team 生命周期事件（mnemo #502, #532）
- teamCanvas 可手动折叠展开，但创建 team 后需手动点击才能看到

## 用户故事

### User Story 1：主 Agent 创建 Leader

```
作为：用户
我想要：对主 Agent 说"帮我建个团队做 XX"
从而：主 Agent 自动调用 mteam-primary.create_leader MCP
      后端创建 leader instance + team
      前端自动展示新团队和 leader
```

#### 样例对话
```
用户：帮我创建一个叫 "API 重构" 的团队，让 Alice 做项目经理
主 Agent：我来帮你。(调用 create_leader → POST /api/role-instances → POST /api/teams)
系统：team created → WS 推 team.created + instance.created 事件
前端：自动打开 teamCanvas，展示 Alice 为 leader、team members 栏空
```

### User Story 2：主 Agent 给 Leader 发任务

```
作为：用户（通过主 Agent）
我想要：主 Agent 对 leader 说"邀请 Bob 做后端，Caroline 做前端"
从而：leader 收到分配的任务
      前端 teamCanvas 实时更新成员名单
```

#### 样例对话
```
用户：Alice，邀请 Bob 和 Caroline 加入团队
主 Agent：(通过 send_to_agent 给 leader 发消息)
Leader：收到消息，自动 add_member Bob 和 Caroline
前端：WS 推 instance.created × 2 + team.member_joined × 2
      TeamCanvas 实时显示 Bob/Caroline 上线
```

### User Story 3：创建 Team 后自动唤起 teamCanvas

```
作为：前端用户
我想要：创建或进入一个 team 后，teamCanvas 自动展开（不是胶囊态）
从而：我无需手动点击，能立即看到 team 的成员和状态
```

#### 样例交互
```
场景1：用户通过主 Agent 创建 team
- WS 收到 team.created
- teamStore 更新 teams[]
- TeamPage 检测到 teams.length > 0
- teamCanvas 自动从 collapsed 切换为 expanded（或始终 expanded）
- 用户看到新 team 的胶囊或完整面板

场景2：用户手动点"创建"按钮
- HTTP POST /api/teams 成功
- WS 收到 team.created
- 同场景1 自动唤起
```

## 功能描述

### 功能 1：后端 mteam-primary MCP create_leader

**已实现**，由后端 team-lead 负责（mnemo #623）。前端需要理解：

| 参数 | 说明 | 示例 |
|------|------|------|
| `leaderName` | 新 leader 的显示名 | "Alice" |
| `teamName` | 团队名 | "API 重构" |
| `description` | 可选，团队描述 | "2026 Q2 API 层重构" |

**返回值**：成功时后端依次触发：
1. `instance.created{instanceId, roleId, name, status}` — leader instance 创建
2. `team.created{id, name, leaderInstanceId, status}` — team 创建

### 功能 2：前端自动唤起 teamCanvas

**实现位置**：`TeamPage.tsx` 中的自动展开逻辑

**触发条件**（任一即可）：
- WS 收到 `team.created` 事件 → teamStore 写入 teams[]
- HTTP POST `/api/teams` 成功

**前端行为**：
```typescript
// TeamPage.tsx 中
useEffect(() => {
  if (teams.length > 0 && collapsed) {
    setCollapsed(false);  // 自动展开
  }
}, [teams.length, collapsed]);
```

**预期 UX**：
- 胶囊态 → 自动展开为完整 panel
- 展示 TeamSidebar（team 列表 + 创建按钮）
- 展示 TeamCanvas（空的图景，等 leader/members 上线）

### 功能 3：消息三路分发（mainline）

**不是本期新增**，但需确认集成到位：

| 消息类型 | 来源 | 前端处理 |
|---------|------|---------|
| 用户 → 主 Agent | WS `prompt op` | ChatPanel（Phase 1 已做） |
| 主 Agent → Leader → Team | WS `comm.message_sent` + 后端 bus 事件 | 待做（Phase 2+） |
| Agent 间任务分配 | Team canvas 上显示 task badge | 待做（Phase 3） |

本期关注：**team.created 到 instance.created 的链路一通百通**。

## 数据流说明

### 链路 A：用户对主 Agent 说"创建团队"

```
Timeline:
┌─────────────────────────────────────────────────────────────┐
│ T0: 用户输入 "帮我创建一个叫API重构的团队"                      │
├─────────────────────────────────────────────────────────────┤
│ T1: 前端 WS.prompt({text, instanceId=primaryAgent.id})       │
│     → 后端 agent-driver.prompt                              │
├─────────────────────────────────────────────────────────────┤
│ T2: 主 Agent 理解意图，调用 MCP create_leader               │
│     参数: leaderName="Alice", teamName="API重构"             │
├─────────────────────────────────────────────────────────────┤
│ T3: 后端 create_leader 处理链：                              │
│     a) POST /api/role-instances (isLeader=true)             │
│        → 创建 leader instance                                │
│        → emits: bus event instance.created                   │
│                                                               │
│     b) POST /api/teams (leaderInstanceId, name)             │
│        → 创建 team 记录                                       │
│        → emits: bus event team.created                       │
└─────────────────────────────────────────────────────────────┘
```

### 链路 B：WS 推送事件到前端 → 自动唤起 teamCanvas

```
Timeline:
┌─────────────────────────────────────────────────────────────┐
│ T3a: 后端发 instance.created 到 WS 广播                      │
│     {                                                         │
│       type: 'instance.created',                              │
│       instanceId: 'inst-leader-xxx',                         │
│       roleId: 'role-xxx',                                    │
│       name: 'Alice',                                         │
│       status: 'PENDING'  // or ACTIVE                       │
│     }                                                         │
├─────────────────────────────────────────────────────────────┤
│ T3b: 后端发 team.created 到 WS 广播                          │
│     {                                                         │
│       type: 'team.created',                                  │
│       id: 'team-xxx',                                        │
│       name: 'API重构',                                       │
│       leaderInstanceId: 'inst-leader-xxx',                   │
│       status: 'ACTIVE'                                       │
│     }                                                         │
├─────────────────────────────────────────────────────────────┤
│ T4: 前端 useWsEvents 订阅处理                                 │
│     - onEvent('team.created') 触发:                          │
│       teamStore.addTeam(team)                                │
│       teams = [{...}, ...new team...]                        │
├─────────────────────────────────────────────────────────────┤
│ T5: TeamPage useEffect 检测 teams.length 变化                │
│     if (teams.length > 0 && collapsed) {                     │
│       setCollapsed(false)                                    │
│     }                                                         │
├─────────────────────────────────────────────────────────────┤
│ T6: UI 重新渲染                                               │
│     hasTeams=true → 展示 TeamMonitorPanel                    │
│     collapsed=false → 展示完整 panel 而非胶囊                 │
├─────────────────────────────────────────────────────────────┤
│ T7: 用户看到：                                                │
│     - TeamSidebar 显示 "API重构" team                         │
│     - TeamCanvas 空的图景                                    │
│     - Leader (Alice) 卡片在画布上（待 instance.activated）   │
└─────────────────────────────────────────────────────────────┘
```

### 链路 C：主 Agent 给 Leader 分配任务

```
Timeline:
┌─────────────────────────────────────────────────────────────┐
│ T7: 用户对主 Agent 说 "Alice，邀请 Bob 和 Caroline"           │
├─────────────────────────────────────────────────────────────┤
│ T8: 主 Agent 调用 send_to_agent MCP                          │
│     send_to_agent({                                          │
│       toInstanceId: 'inst-leader-xxx',  // Alice             │
│       message: "Add Bob (backend) and Caroline (frontend)"   │
│     })                                                        │
├─────────────────────────────────────────────────────────────┤
│ T9: 后端 send_to_agent 处理：                                │
│     - 查 toInstanceId = Alice                                │
│     - 创建 comm.message 到 Alice                              │
│     - emits: bus event comm.message_sent                     │
├─────────────────────────────────────────────────────────────┤
│ T10: Alice (leader instance) 的 agent-driver 收消息         │
│      - 解析用户意图                                           │
│      - 调用 mteam.add_member(Bob) × 2                        │
│      - 后端依次 emits: instance.created × 2                  │
│                       team.member_joined × 2                │
├─────────────────────────────────────────────────────────────┤
│ T11: 前端 useWsEvents 收到事件链                              │
│      instance.created → instanceStore.add                    │
│      team.member_joined → teamStore.addMember                │
│      agents[] 实时增长                                        │
├─────────────────────────────────────────────────────────────┤
│ T12: TeamCanvas 重新渲染，显示：                              │
│      - Leader (Alice) 卡片                                   │
│      - 2 个 member 卡片 (Bob, Caroline)                      │
│      - 3 个实时状态点                                         │
└─────────────────────────────────────────────────────────────┘
```

## 验收走查 Case

### Case 1：主 Agent 通过 MCP 创建 Leader（E2E）

**前置条件**：
- 主 Agent 已启动，状态 RUNNING
- Playground 打开，可与主 Agent 交互

**操作步骤**：
1. 在 Playground 文本框输入："帮我创建一个叫'Demo Team'的团队，让 Alice 做项目经理"
2. 点击发送
3. 等待主 Agent 回复
4. 查看 WS 日志是否收到 `team.created` 和 `instance.created` 事件

**预期结果**：
- [ ] 主 Agent 返回确认消息（如"已创建...")
- [ ] WS 收到 `team.created` 事件，payload 包含 `id / name='Demo Team' / leaderInstanceId`
- [ ] WS 收到 `instance.created` 事件，payload 包含 `name='Alice' / status=PENDING 或 ACTIVE`
- [ ] Console 无错误，无 403 / 404

### Case 2：创建 Team 后 teamCanvas 自动展开

**前置条件**：
- 主 Agent 运行中
- TeamPage 当前折叠态（只显示胶囊）

**操作步骤**：
1. 通过 Playground 触发主 Agent 创建 team（或直接 HTTP POST /api/teams）
2. 观察 UI 变化

**预期结果**：
- [ ] WS 收到 `team.created` 事件
- [ ] TeamPage 的 collapsed 自动从 `true` 切换为 `false`
- [ ] TeamMonitorPanel 从胶囊态展开为完整面板，显示：
  - [ ] TeamSidebar 左侧栏展示新 team
  - [ ] TeamCanvas 中央画布显示 leader 节点
  - [ ] 关闭按钮（右上角）可用

### Case 3：Leader 收消息 + 自动添加成员

**前置条件**：
- Demo Team 已创建，leader=Alice
- teamCanvas 展开显示 Alice
- 主 Agent 运行

**操作步骤**：
1. 对主 Agent 说："Alice，邀请 Bob (backend) 和 Carol (frontend) 加入"
2. 主 Agent 调用 `send_to_agent` 给 Alice 发消息
3. Alice 执行任务（add_member），后端 emits `instance.created` + `team.member_joined`
4. 观察 TeamCanvas 实时更新

**预期结果**：
- [ ] WS 收到 `instance.created` × 2（Bob / Carol）
- [ ] WS 收到 `team.member_joined` × 2
- [ ] TeamPage.agents 数组从 [Alice] 增长为 [Alice, Bob, Carol]
- [ ] TeamCanvas 重新布局，显示 3 个节点
- [ ] 每个节点显示 name 和 status 状态点

### Case 4：Team 成员列表实时同步

**前置条件**：
- Demo Team 有 leader + 2 members
- TeamPage 与 Backend 连接正常

**操作步骤**：
1. 在后端（另一个窗口或 CLI）直接调 `/api/teams/:id/members` 添加第 3 个成员
2. 观察前端 TeamCanvas 是否实时更新

**预期结果**：
- [ ] WS 收到 `team.member_joined` 事件
- [ ] TeamCanvas agents[] 自动增长为 4 个
- [ ] 无需刷新页面，无需手动触发

### Case 5：创建失败时的提示（边界）

**前置条件**：
- 主 Agent 运行

**操作步骤**：
1. 尝试创建两个 team，都用同一个 leaderInstanceId（违反约束：同 leader 仅一个 ACTIVE team）
2. 观察主 Agent 和前端的错误处理

**预期结果**：
- [ ] 后端返回 409 Conflict（见 teams-api.md）
- [ ] 主 Agent 收到错误并报告给用户（如"该 leader 已有活跃团队")
- [ ] 前端 teamStore 不添加冲突的 team
- [ ] 用户能根据错误消息理解问题

### Case 6：Leader 离线时的处理（边界）

**前置条件**：
- Demo Team 已创建，leader=Alice（实例已激活）
- TeamCanvas 显示 Alice

**操作步骤**：
1. 手动将 Alice 实例下线（模拟 `instance.deleted` 或 `driver.stopped`）
2. 观察 TeamCanvas 中 Alice 的状态变化

**预期结果**：
- [ ] WS 收到 `instance.deleted` 或状态变为 PENDING_OFFLINE
- [ ] TeamCanvas 中 Alice 节点状态点从绿变灰 / 变红
- [ ] Team 本身不删除，仅 leader 标记离线
- [ ] 点击 Alice 节点无法交互（或显示灰态）

### Case 7：WebSocket 断线重连

**前置条件**：
- Demo Team 已创建，3 个成员在线
- TeamCanvas 展开

**操作步骤**：
1. 用浏览器 DevTools 手动断开 WebSocket（关闭 WSS 连接）
2. 等待 2-3 秒，WS 自动重连
3. 主 Agent 创建新 team 或添加新成员
4. 观察前端是否收到更新

**预期结果**：
- [ ] WS 重连后自动 subscribe
- [ ] 新的 `team.created` / `team.member_joined` 事件正常推送
- [ ] TeamCanvas agents 数组继续更新，无重复 / 缺失

### Case 8：团队 sidebar 选中 + 成员列表联动

**前置条件**：
- 至少 2 个 team（Team A / Team B），各有不同成员

**操作步骤**：
1. TeamSidebar 中点击 Team A
2. 观察 TeamCanvas 和成员列表变化
3. 点击 Team B

**预期结果**：
- [ ] 活跃 team（activeTeamId）切换
- [ ] agents[] 重新从 getTeam(Team A) 拉取
- [ ] TeamCanvas 的节点布局重新排列
- [ ] 无闪烁 / 无数据残留

### Case 9：创建按钮可用性

**前置条件**：
- 主 Agent 已启动

**操作步骤**：
1. TeamSidebar 中点击"创建"按钮
2. 弹出 prompt 输入 team 名
3. 输入名字并确认

**预期结果**：
- [ ] HTTP POST /api/teams 触发（检查 Network tab）
- [ ] 成功时 WS 收到 `team.created`
- [ ] 新 team 自动出现在 sidebar
- [ ] teamCanvas 自动展开（如果之前是折叠）
- [ ] 新 team 自动选中 + 显示为 activeTeamId

### Case 10：异常状态 — leaderInstanceId 不存在

**前置条件**：
- 主 Agent 运行

**操作步骤**：
1. 尝试 POST /api/teams 指定不存在的 leaderInstanceId
2. 或模拟主 Agent create_leader 时 instanceId 被删除

**预期结果**：
- [ ] 后端返回 400 / 404（取决于实现）
- [ ] 前端 teamStore 不添加该 team
- [ ] 错误日志清晰（便于调试）

## 边界条件处理

| 场景 | 前端处理 | 后端保证 |
|------|---------|---------|
| Team 创建失败（409 冲突） | 弹 toast 错误 | POST /api/teams 返回 409 |
| Leader 不存在 | 建 team 时 getTeam 返回 404 | POST /api/teams 先校验 leaderInstanceId |
| Members 列表超大（>100） | 分页 / 虚拟滚动 | 见 members-api.md 分页 |
| 网络抖动导致 WS 丢事件 | useWsEvents 心跳 + getTeam 补齐 | gap-replay 补库 |
| 主 Agent 创建 leader 超时 | 主 Agent 自处理（重试 / 超时） | 无前端干预 |
| 同时创建多个 team | WS 依次推送，store 去重 | Bus 事件原子性 |

## API 契约查证

| API | 文档 | 状态 |
|-----|------|------|
| POST /api/teams | teams-api.md §POST | ✅ 实现 |
| GET /api/teams/:id | teams-api.md §GET | ✅ 实现 |
| POST /api/teams/:id/members | teams-api.md §POST members | ✅ 实现 |
| WS team.created | bus-events.md / ws-protocol.md | ✅ 实现 |
| WS instance.created | bus-events.md / ws-protocol.md | ✅ 实现 |
| MCP create_leader | mcp-primary 骨架 (mnemo #623) | ✅ 后端实现 |
| MCP send_to_agent | send_to_agent.ts (mnemo #625) | ✅ 后端实现 |

## 前端组件清单

| 组件 | 文件 | 需改 | 说明 |
|------|------|------|------|
| TeamPage | src/pages/TeamPage.tsx | 小改 | 自动展开逻辑 |
| TeamMonitorPanel | organisms/TeamMonitorPanel.tsx | 无改 | 接收 collapsed 状态即可 |
| TeamSidebar | molecules/TeamSidebar.tsx | 无改 | 已有创建按钮逻辑 |
| TeamCanvas | organisms/TeamCanvas.tsx | 无改 | 纯受控渲染 |
| teamStore | store/teamStore.ts | 已有 | 已支持 CRUD 和 WS 事件 |
| useWsEvents | hooks/useWsEvents.ts | 已有 | 已分发 team.* / instance.* 事件 |

## 前端实现要点

### 1. TeamPage 自动展开逻辑

```typescript
// src/pages/TeamPage.tsx
useEffect(() => {
  // 检测 teams 数组，有 team 时自动展开
  if (teams.length > 0 && collapsed) {
    setCollapsed(false);
  }
}, [teams.length, collapsed]);
```

### 2. WS 事件处理（已到位，无需改）

```typescript
// src/hooks/useWsEvents.ts 已包含：
case 'team.created':
  teamStore.addTeam(event.data);
  break;
case 'instance.created':
  instanceStore.add(event.data);
  break;
```

### 3. 自动选中新建 team

```typescript
// TeamPage 或 teamStore 补充逻辑：
const handleTeamCreated = (team: TeamRow) => {
  setTeams([...teams, team]);
  setActiveTeamId(team.id);  // 自动选中
};
```

## 交付清单

- [ ] **后端**
  - [ ] mteam-primary MCP create_leader 工具落地（已有 mnemo #623）
  - [ ] send_to_agent 工具落地（已有 mnemo #625）
  - [ ] team.created / instance.created 事件正确推送
  - [ ] HTTP POST /api/teams 返回 201 + TeamRow
  - [ ] WS /ws/events 订阅收到事件

- [ ] **前端**
  - [ ] TeamPage 自动展开逻辑（基于 teams.length）
  - [ ] useWsEvents 处理 team.created 分发到 teamStore
  - [ ] teamStore 去重 + 状态同步
  - [ ] 新 team 自动在 sidebar 显示
  - [ ] 新 team 自动选中（activeTeamId）
  - [ ] TeamCanvas 实时渲染 leader + members

- [ ] **集成测试**
  - [ ] E2E：主 Agent → MCP create_leader → team 显示
  - [ ] E2E：主 Agent → send_to_agent → leader 收消息 → 成员自动加入
  - [ ] E2E：WS 断线重连 + team 数据一致

- [ ] **验收走查**
  - [ ] 执行上述 10 个 Case，全部通过
  - [ ] 截图对比（teamCanvas 展开前 / 后）
  - [ ] 性能监控（10+ team 时无卡顿）

## 测试环境准备

- Playground + Electron 应用一起启动
- 后端 :58590 WS 正常
- 主 Agent 已启动（PRIMARY_AGENT_ENABLED=1 或对应环境变量）
- CLI selector 和 sandbox 环境配置正确

## 知识依赖

| 记忆 ID | 标题 | 关键点 |
|---------|------|--------|
| #613 | mteam-primary 5 工具设计 | 主 Agent 专属 MCP，create_leader / send_to_agent 核心工具 |
| #623 | mcp-primary 骨架落地 | create_leader 三步曲（instance / team / member） |
| #625 | send_to_agent 直接复用 runSendMsg | 不重复解析，调用成熟函数 |
| #502 | renderer createTeam 全功能接入 | teamStore + WS 事件分发已做 |
| #532 | TeamMonitorPanel 发光容器 | 胶囊折叠 + 自动唤起架构已定 |
| #624 | 团队成员列表 members 不 enrich | 需二次调 /api/role-instances 或用 by-instance 接口 |

---

**PRD 审阅建议**：
- ✅ 数据流图完整，链路清晰
- ✅ API 契约已查证，无黑盒
- ✅ 验收 case 可执行，有量化标准
- ✅ 边界条件明确，异常处理有方案
- 👉 待 UX 审阅：自动展开 vs 手动展开的用户体验，是否需要 toast 提示
