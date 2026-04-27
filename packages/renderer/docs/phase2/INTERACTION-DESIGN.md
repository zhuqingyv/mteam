# Phase 2 交互设计：主 Agent 创建 Leader + TeamCanvas 自动唤起

> 对应 PRD：[PRD.md](./PRD.md)
> 落盘日期：2026-04-26
> 设计者：ux-doc

## 目录

1. [交互总览](#1-交互总览)
2. [架构约束](#2-架构约束双窗口多-browserwindow)
3. [状态机](#3-状态机)
4. [核心交互链路](#4-核心交互链路)
5. [触发条件](#5-触发条件)
6. [动画参数](#6-动画参数)
7. [布局方案](#7-布局方案)
8. [三种状态图](#8-三种状态图)
9. [异常场景](#9-异常场景)
10. [组件清单](#10-组件清单)

---

## 1. 交互总览

### 1.1 设计目标

- **零点击唤起团队面板**：用户对主 Agent 下达"建团队"指令后，团队画布自动出现在视野内。
- **主对话不中断**：唤起过程不打断用户与主 Agent 的聊天流。
- **视觉连续**：新面板以"从旁边滑入"的方式出现，而非突兀弹出。

### 1.2 设计原则


| 原则   | 含义                           |
| ---- | ---------------------------- |
| 自动化  | team.created 到达即唤起，无需用户确认    |
| 可撤销  | 用户可随时折叠 / 关闭团队面板，不影响 team 数据 |
| 异步容错 | WS 事件延迟 / 失败都有兜底（轮询 + toast） |
| 视觉轻量 | 滑入动画 ≤ 300ms，缓动曲线与胶囊展开保持一致   |


---

## 2. 架构约束（双窗口多 BrowserWindow）

**这是 Phase 2 最核心的技术约束，影响整套交互设计。**

### 2.1 现状（electron-main/main.ts）


| 窗口                     | 尺寸                       | 路由                 | 角色                           |
| ---------------------- | ------------------------ | ------------------ | ---------------------------- |
| 主窗口 `mainWindow`       | 380×120（胶囊）→ 640×620（展开） | `/`（默认）            | CapsulePage，承载 Logo/对话       |
| 团队面板 `teamPanelWindow` | 1200×800                 | `?window=team`     | TeamPage，承载 TeamMonitorPanel |
| 设置窗口 `settingsWindow`  | 600×500                  | `?window=settings` | SettingsPage                 |


**关键事实**：

- 团队面板是**独立的 Electron BrowserWindow**，不是主窗口内的侧边栏。
- 两个窗口共用同一个 renderer bundle，通过 URL query param 区分路由。
- teamStore / WS 状态通过后端 WS 连接同步（每个 renderer 进程各自维持 WS）。

### 2.2 UX 方案 "侧边滑出 + 并排" 的真实含义

> ⚠️ 之前 UX 评估写的"并排布局"容易被误读为"同一窗口两列"。
> 实际方案是：**胶囊主窗口保持在桌面右下角，团队面板作为新 BrowserWindow 在胶囊窗口左侧打开**，两个窗口在桌面空间上并排。

```
┌───── 桌面 ─────────────────────────────────────┐
│                                                 │
│                                                 │
│   ┌──────────────────┐  ┌────────────────┐     │
│   │ TeamPanelWindow  │  │ Main (Expanded)│     │
│   │ 1200×800         │  │ 640×620        │     │
│   │                  │  │                │     │
│   │  TeamCanvas      │  │   ChatPanel    │     │
│   │                  │  │                │     │
│   └──────────────────┘  └────────────────┘     │
│                           右下角锚点            │
└─────────────────────────────────────────────────┘
```

### 2.3 架构影响清单


| 影响项  | 说明                                                              |
| ---- | --------------------------------------------------------------- |
| 窗口唤起 | 走 `ipcMain.on('window:open-team-panel')` 触发 `openPanel('team')` |
| 位置联动 | 团队窗口默认位置需在主窗口左侧（本期可先按 Electron 默认，Phase 3 再做窗口吸附）               |
| 折叠胶囊 | 因两个窗口独立，主窗口收胶囊不会影响团队窗口显示                                        |
| 数据同步 | 各自 WS 订阅，无需 IPC 转发（已是现状）                                        |


---

## 3. 状态机

团队面板的生命周期由三个维度决定：**teamPanelWindow 是否打开**、**teams 数组是否非空**、**collapsed 状态**。

```
                   team.created 事件
                          │
                          ▼
  ┌─────────┐  WS   ┌──────────────┐  openPanel('team')  ┌──────────────┐
  │  无团队  │ ────▶ │ teams.len>0  │ ──────────────────▶ │ 团队窗口打开 │
  │ (idle)  │       │ 窗口未打开    │                     │ panel 展开态 │
  └─────────┘       └──────────────┘                     └──────┬───────┘
       ▲                                                        │
       │                                                        │ 用户点折叠
       │                                                        ▼
       │                                                 ┌──────────────┐
       │           user close team window                │ panel 胶囊态 │
       └─────────────────────────────────────────────────│  (collapsed) │
                                                         └──────────────┘
```

### 3.1 状态枚举


| 状态         | teams.length | teamPanelWindow | collapsed | 用户可见           |
| ---------- | ------------ | --------------- | --------- | -------------- |
| S0 无团队     | 0            | null            | –         | 仅胶囊/主窗口        |
| S1 团队创建中   | 0 → 1 过渡     | null → 创建中      | false（默认） | 胶囊 + 面板滑入      |
| S2 团队面板展开  | ≥1           | open            | false     | 胶囊 + 完整面板      |
| S3 团队面板胶囊态 | ≥1           | open            | true      | 胶囊 + 胶囊态 panel |
| S4 团队已解散   | 1 → 0        | open → close    | –         | 胶囊/主窗口         |


### 3.2 状态转换表


| From  | To  | 触发                                    | 耗时            |
| ----- | --- | ------------------------------------- | ------------- |
| S0    | S1  | WS 收到 `team.created`                  | 0ms（立即）       |
| S1    | S2  | 主进程 `openPanel('team')` 完成 + 页面挂载     | 300~500ms     |
| S2    | S3  | 用户点 `.team-monitor__close` 按钮         | 350ms（CSS 动画） |
| S3    | S2  | 用户点胶囊 `.team-monitor__collapsed-face` | 350ms         |
| S2/S3 | S4  | WS `team.deleted` + 最后一个 team 被移除     | 0ms           |
| S4    | S0  | 团队窗口自动关闭                              | 窗口销毁 ~100ms   |


---

## 4. 核心交互链路

### 4.1 主链路：主 Agent 创建团队

```
用户在 ExpandedView 输入: "帮我建个叫 Demo 的团队"
  │
  ▼ (T0)
┌─────────────────────────────────────────────────────┐
│ ExpandedView.handleSend → WS prompt op              │
│   instanceId = primaryAgent.id                      │
└─────────────────────────────────────────────────────┘
  │
  ▼ (T1  后端)
┌─────────────────────────────────────────────────────┐
│ 主 Agent 理解意图 → 调用 MCP create_leader           │
│   后端: POST /api/role-instances  (leader)           │
│         POST /api/teams                              │
└─────────────────────────────────────────────────────┘
  │
  ▼ (T2  WS 推送)
┌─────────────────────────────────────────────────────┐
│ WS 广播:                                             │
│   instance.created {instanceId, name:"Alice"}        │
│   team.created     {id, leaderInstanceId, name}      │
└─────────────────────────────────────────────────────┘
  │
  ▼ (T3  前端主窗口)
┌─────────────────────────────────────────────────────┐
│ useWsEvents.handleTeamCreated                        │
│   → teamStore.addTeam()                              │
│   → teams.length 0 → 1                               │
│   → autoOpenTeamWindow() 触发一次 IPC                │
│     window.electronAPI.openTeamPanel()               │
│   → 聊天气泡追加一条主 Agent 回复                    │
│     "已创建团队 Demo，正在为你打开团队面板..."       │
└─────────────────────────────────────────────────────┘
  │
  ▼ (T4  主进程)
┌─────────────────────────────────────────────────────┐
│ ipcMain.on('window:open-team-panel')                 │
│   → new BrowserWindow(1200×800)                      │
│   → loadRenderer('?window=team')                     │
│   → 默认动画由 Electron 自身提供（window fade-in）   │
└─────────────────────────────────────────────────────┘
  │
  ▼ (T5  团队窗口 renderer)
┌─────────────────────────────────────────────────────┐
│ TeamPage mount                                       │
│   → listTeams() 拉取数据                             │
│   → WS 订阅建立                                      │
│   → TeamMonitorPanel 挂载，collapsed=false           │
│   → TeamCanvas 显示空画布 + Leader 节点              │
└─────────────────────────────────────────────────────┘
```

### 4.2 关键节点代码改动点


| 位置                         | 改动                                          | 目的                |
| -------------------------- | ------------------------------------------- | ----------------- |
| `useWsEvents.ts`           | team.created handler 调 `autoOpenTeamWindow` | 收事件自动开窗           |
| `TeamPage.tsx`             | 已有 `hasTeams → setCollapsed(false)`         | 窗口打开即展开 panel     |
| `electronAPI`              | 新增 `openTeamPanel()` 调 IPC                  | renderer 触发主进程开窗  |
| `preload.cjs`              | 暴露 `window.electronAPI.openTeamPanel`       | 渲染进程接口            |
| `ChatPanel`/`ExpandedView` | 无改                                          | 气泡由主 Agent 回复自动生成 |


> ℹ️ 避免重复开窗：`autoOpenTeamWindow` 需有 debounce/guard，确保同一时间片内 team.created 只触发一次（即使短时间多次）。主进程 `openPanel` 已有 "已存在则 close" 的逻辑，但这里我们要改成 "已存在则 focus"。

### 4.3 次链路：主 Agent 给 Leader 发任务

此链路不涉及窗口唤起，只涉及 TeamCanvas 节点增加。详见 PRD 链路 C。

---

## 5. 触发条件

### 5.1 "自动唤起团队窗口" 触发规则

条件 **A AND B AND C** 才触发 `openTeamPanel()`：


| 条件                                   | 判定                             |
| ------------------------------------ | ------------------------------ |
| A. teamStore.teams 从 0 变 ≥1          | `prevLen === 0 && nextLen > 0` |
| B. teamPanelWindow 当前不存在或已 destroyed | IPC 响应态或本地缓存                   |
| C. 上一次触发距今 >500ms（防抖）                | 本地 ts 记录                       |


### 5.2 "面板内 collapsed 自动切换" 触发规则

TeamPage 内已有：

```ts
useEffect(() => { if (hasTeams) setCollapsed(false); }, [hasTeams]);
```

保持不变。意味着**团队窗口打开后，panel 默认展开态**；用户主动折叠后，除非下一个 team 被创建（触发 hasTeams true → true 不触发），否则保持胶囊态。

### 5.3 "面板关闭" 触发规则


| 触发                              | 结果                  |
| ------------------------------- | ------------------- |
| 用户点 `.team-monitor__close`      | panel 折叠为胶囊态（S2→S3） |
| 用户点 macOS 红点关闭窗口                | 窗口销毁（S*→S0/S4）      |
| `team.deleted` + teams.length=0 | 窗口销毁 + 主 Agent 气泡提示 |


---

## 6. 动画参数

所有时序与缓动统一走"胶囊展开"已有配方，保持视觉一致。

### 6.1 缓动曲线


| 场景             | 曲线                                | 用途            |
| -------------- | --------------------------------- | ------------- |
| 窗口尺寸 / 位置      | Electron 原生（`setBounds(…, true)`） | 主窗口展开/收起      |
| CSS 形变（圆角、透明度） | `cubic-bezier(0.2, 0, 0, 1)`      | panel 胶囊 ↔ 展开 |
| 简单淡入淡出         | `ease`                            | 内容层 opacity   |


### 6.2 时长表


| 动画对象                                    | 属性              | 时长                  | 延迟               | 缓动            |
| --------------------------------------- | --------------- | ------------------- | ---------------- | ------------- |
| `.team-monitor` border-radius           | 20px ↔ 44px     | 350ms               | 0                | cb(0.2,0,0,1) |
| `.team-monitor__expanded` opacity       | 0 ↔ 1           | 280ms               | 120ms（展开）/ 0（折叠） | ease          |
| `.team-monitor__collapsed-face` opacity | 0 ↔ 1           | 250ms               | 180ms（展开）/ 0（折叠） | ease          |
| 新 BrowserWindow fade-in                 | 透明 → 不透明        | Electron 默认 ≈ 200ms | 0                | 系统            |
| 主 Agent 气泡插入                            | 现有 ChatPanel 动画 | 150ms               | 0                | ease          |


### 6.3 时序编排（创建团队场景）

```
T+0ms     WS team.created 到达
T+0ms     teamStore.addTeam
T+0ms     IPC openTeamPanel
T+30ms    ChatPanel 追加 "已创建 xxx" 气泡
T+200ms   BrowserWindow 显示（系统动画）
T+250ms   TeamPage 挂载完成
T+250ms   .team-monitor collapsed=false（初始态）
T+250ms   .team-monitor__expanded opacity 开始 0→1
T+530ms   面板完全可见可交互
```

用户的主观感受：**"我说完话，面板滑进来了"**，无中间卡顿。

---

## 7. 布局方案

### 7.1 团队面板窗口尺寸（已有）

```
┌────────────────────────────────────── 1200px ──────────────────────────────────┐
│ ┌──── TeamSidebar ────┐ ┌────────── TeamCanvas ───────────────────────────┐ │
│ │                      │ │                                                 │ │
│ │  [Team Demo] ◀active │ │        ┌─────────────┐                          │ │ 800px
│ │  [Team Api]          │ │        │  Alice      │                          │ │
│ │  [+ 创建]            │ │        │  (Leader)   │                          │ │
│ │                      │ │        └─────────────┘                          │ │
│ │                      │ │                                                 │ │
│ └──────────────────────┘ └─────────────────────────────────────────────────┘ │
│                                                                              × │
└────────────────────────────────────────────────────────────────────────────────┘
```


| 元素                | 尺寸          | 约束                        |
| ----------------- | ----------- | ------------------------- |
| panel padding     | 16px        | `.team-monitor__expanded` |
| gap               | 16px        | sidebar ↔ canvas          |
| TeamSidebar width | 240px（现有）   | flex: 0 0 240px           |
| TeamCanvas min    | 560×480（现有） | flex: 1                   |
| 右上关闭按钮            | 28×28       | `.team-monitor__close`    |


### 7.2 胶囊态尺寸

胶囊态保持在 1200×800 窗口内（窗口本身不缩），只是内部 `.team-monitor` 视觉形变为大胶囊：

```
┌──────── 1200×800 窗口 ────────────────────┐
│                                            │
│  ┌───  Demo · 1 Teams · 1 Agents  ───┐   │
│  └────────────────────────────────────┘   │  collapsed=true
│                                            │
└────────────────────────────────────────────┘
```

现有 `.team-monitor--collapsed { border-radius: 44px }` 仅改圆角，内容层靠 opacity=0 隐藏。视觉上需要调整为"居中小胶囊"以示区分：

> ⚠️ 当前实现：胶囊态 panel 占满整个窗口（1200×800 的圆角框），视觉上过大。
> **推荐优化（非本期阻塞）**：胶囊态时把 `.team-monitor` max-width 限制到 420px，margin: auto 居中，视觉上与主胶囊等大。

### 7.3 双窗口桌面布局建议

本期不强制窗口吸附/联动，但给 Phase 3 留口子：

```
理想布局（Phase 3）：
┌─────────────────────────────────────────────┐
│                                              │
│                                              │
│   [ teamPanelWindow ]   [ mainWindow ]      │
│   (1200×800)            (640×620 胶囊展开)   │
│                                              │
│   水平间距 8px                               │
│   垂直对齐 底部对齐                          │
└─────────────────────────────────────────────┘

本期 MVP：Electron 默认位置即可，不做窗口吸附。
```

---

## 8. 三种状态图

### 8.1 胶囊态（主窗口）

```
主窗口 380×120
┌───────────────────────────────┐
│  ◉ MTEAM  0 Agents · 0 Tasks ⋯│
└───────────────────────────────┘
teams.length === 0，teamPanelWindow 不存在
```

### 8.2 展开态（主窗口）+ 团队面板

```
主窗口 640×620                 团队面板 1200×800
┌──────────────────────────┐  ┌──────────────────────────────────────┐
│ ◉ MTEAM                × │  │                                    × │
│  ┌──────────────────┐    │  │ ┌────────┐ ┌──────────────────────┐ │
│  │  对话历史         │    │  │ │Sidebar │ │      TeamCanvas      │ │
│  │  主 Agent: 已创建 │    │  │ │        │ │                      │ │
│  │  ...              │    │  │ │  Demo  │ │    ┌──────────┐      │ │
│  ├──────────────────┤    │  │ │   ◀    │ │    │ Alice    │      │ │
│  │ 输入框 "..."      │    │  │ │        │ │    │ Leader   │      │ │
│  └──────────────────┘    │  │ │ [+ 新建]│ │    └──────────┘      │ │
│                          │  │ │        │ │                      │ │
└──────────────────────────┘  │ └────────┘ └──────────────────────┘ │
                              └──────────────────────────────────────┘

teams.length ≥ 1, collapsed=false
```

### 8.3 团队面板胶囊态（用户主动折叠后）

```
主窗口 640×620                  团队面板 1200×800
┌──────────────────────────┐  ┌──────────────────────────────────────┐
│ ◉ MTEAM                × │  │                                      │
│  ┌──────────────────┐    │  │                                      │
│  │  对话历史         │    │  │     Demo · 1 Teams · 1 Agents        │
│  │  ...              │    │  │         （点击重新展开）              │
│  ├──────────────────┤    │  │                                      │
│  │ 输入框            │    │  │                                      │
│  └──────────────────┘    │  │                                      │
│                          │  │                                      │
└──────────────────────────┘  └──────────────────────────────────────┘

teams.length ≥ 1, collapsed=true
```

---

## 9. 异常场景

### 9.1 创建失败（409 Conflict）

**场景**：leader 已有活跃 team，主 Agent 再次调 create_leader。


| 步骤        | 行为                                |
| --------- | --------------------------------- |
| 后端        | POST /api/teams 返回 409            |
| 主 Agent   | MCP 调用失败，捕获错误                     |
| ChatPanel | 主 Agent 回复"该 leader 已有活跃团队：[团队名]" |
| teamStore | 不变（无事件推送）                         |
| 团队窗口      | 不唤起                               |


### 9.2 WS 延迟 / 丢失

**场景**：主 Agent MCP 返回成功，但 WS `team.created` 3s 未到达。


| 步骤   | 行为                                             |
| ---- | ---------------------------------------------- |
| 前端兜底 | 发送 prompt 后 1s 起，每 2s 调一次 `listTeams()`，最多 3 次 |
| 命中   | 新增 team ID 不在 teamStore → addTeam + 触发唤起逻辑     |
| 未命中  | ChatPanel 提示"网络慢，请稍后刷新"，不自动开窗                  |


> ⚠️ 本期不强制实现兜底轮询，仅在 PRD 写明。Phase 3 可加。

### 9.3 team 解散

**场景**：用户在团队面板点"删除团队"。


| 步骤        | 行为                             |
| --------- | ------------------------------ |
| WS        | `team.deleted` 广播              |
| teamStore | removeTeam → teams.length -= 1 |
| TeamPage  | 如果 teams.length===0，触发窗口关闭 IPC |
| 主进程       | `teamPanelWindow.close()`      |
| 主窗口聊天     | 主 Agent 气泡追加"团队已解散"            |


### 9.4 Leader 离线

**场景**：leader instance 被手动终止。


| 步骤         | 行为                                      |
| ---------- | --------------------------------------- |
| WS         | `instance.deleted` 或状态变 PENDING_OFFLINE |
| TeamCanvas | leader 节点 StatusDot 变灰                  |
| 团队本身       | 不删除，保留，允许重新激活                           |
| 聊天气泡       | 不追加（避免打扰）                               |


### 9.5 用户手动关闭团队窗口后又创建新 team


| 步骤             | 行为                               |
| -------------- | -------------------------------- |
| 窗口关闭           | `teamPanelWindow = null`         |
| 新 team 创建      | team.created 到达                  |
| 检测条件 A ∩ B ∩ C | prev=1, next=2（不触发 A：prev !== 0） |
| 结果             | **不自动唤起窗口**（用户已主动关闭，尊重选择）        |


> ⚠️ 这是刻意设计。如果要"每次新 team 都唤起"，把条件 A 改为 `prevLen < nextLen`。本期按"用户关了就别烦他"处理。

### 9.6 主窗口关闭（胶囊态 → 隐藏）

当前 `app.on('window-all-closed')` 会退出整个 app。本期不改，团队窗口跟随退出。

---

## 10. 组件清单

### 10.1 已有组件（复用，无改）


| 组件               | 路径                           | 作用                           |
| ---------------- | ---------------------------- | ---------------------------- |
| TeamMonitorPanel | `organisms/TeamMonitorPanel` | 团队面板，含 collapsed/expanded 双态 |
| TeamSidebar      | `molecules/TeamSidebar`      | 左侧 team 列表 + 创建按钮            |
| TeamCanvas       | `organisms/TeamCanvas`       | 团队画布 + AgentCard 节点          |
| CapsuleCard      | `organisms/CapsuleCard`      | 主窗口胶囊/展开容器                   |
| ExpandedView     | `organisms/ExpandedView`     | 主窗口展开态（ChatPanel+ToolBar）    |
| ChatPanel        | `organisms/ChatPanel`        | 对话气泡                         |
| PanelWindow      | `templates/PanelWindow`      | 团队 BrowserWindow 的根容器        |
| CapsuleWindow    | `templates/CapsuleWindow`    | 主 BrowserWindow 的根容器         |


### 10.2 需改动组件


| 组件                      | 改动                                          | 位置                     |
| ----------------------- | ------------------------------------------- | ---------------------- |
| `useWsEvents.ts`        | team.created handler 调 `autoOpenTeamWindow` | renderer/hooks         |
| `TeamPage.tsx`          | 自动展开逻辑（已有，验证即可）                             | renderer/pages         |
| `preload.cjs`           | 暴露 `openTeamPanel()`                        | renderer/electron-main |
| `electron-main/main.ts` | `openPanel('team')` 改 "已存在则 focus"          | renderer/electron-main |


### 10.3 需新建（本期）


| 组件 / 模块                 | 路径                              | 作用                    |
| ----------------------- | ------------------------------- | --------------------- |
| `autoOpenTeamWindow.ts` | `src/lib/autoOpenTeamWindow.ts` | 防抖 guard + IPC 调用的小工具 |


### 10.4 新建（建议，非本期阻塞）


| 组件                   | 路径                         | 作用                  |
| -------------------- | -------------------------- | ------------------- |
| `TeamPanelToast`     | `molecules/TeamPanelToast` | 团队唤起时主窗口右上角的轻提示（可选） |
| 胶囊态 max-width 约束 CSS | `TeamMonitorPanel.css`     | 胶囊态视觉优化（见 §7.2）     |


### 10.5 组件边界一览

```
mainWindow (/)                  teamPanelWindow (/?window=team)
┌──────────────────────────┐   ┌──────────────────────────────┐
│ CapsuleWindow            │   │ PanelWindow                  │
│  └ CapsuleCard           │   │  └ TeamMonitorPanel          │
│     └ ExpandedView       │   │     ├ TeamSidebar            │
│        └ ChatPanel       │   │     └ TeamCanvas             │
│                          │   │        └ AgentCard[]         │
│  useWsEvents (订 WS)     │   │                              │
│  teamStore (触发开窗)    │   │  useWsEvents (订 WS)         │
└──────────────────────────┘   │  teamStore (接收数据)        │
                                └──────────────────────────────┘
```

---

## 附录 A：与 UX 初版方案的差异


| 项目     | UX 初版（评估文档 #641） | 本文档定稿                            |
| ------ | ---------------- | -------------------------------- |
| 布局     | "并排" 被理解为单窗口双栏   | 双 BrowserWindow，桌面空间并排           |
| 胶囊折叠   | "胶囊自动折叠"         | 改为 "主窗口保持当前态（展开/胶囊由用户控制），只开团队窗口" |
| 唤起时机   | teams.length 0→1 | 同，加 debounce + window 状态检查       |
| 异常兜底   | 轮询               | 本期只定义，Phase 3 再实现                |
| 用户关窗复开 | 未明确              | 本期：用户关窗后不自动重开                    |


## 附录 B：验收 check-list（与 PRD Case 对应）

- Case 1：主 Agent 调 MCP → WS 事件到达 → 团队窗口在 500ms 内打开
- Case 2：窗口打开后默认 panel 展开态（非胶囊）
- Case 3：add_member 后 TeamCanvas 节点实时增长，无闪烁
- Case 5：409 时不开窗，仅 ChatPanel 报错
- Case 6：leader 离线后 StatusDot 变灰，team 不删除
- Case 7：WS 重连后新增 team 仍能触发唤起
- Case 8：sidebar 切换 team 时 canvas 重渲染无残留
- Case 9：手动 createTeam 按钮走同链路
- 动画：border-radius 350ms / opacity 280ms 计时准确（CDP 测量）
- 双开防抖：500ms 内连续两次 team.created 只触发一次 openPanel

