# TeamCanvas v2 PRD — 团队协作画布重构

> 出品：pm（基于 team-lead 需求 + GPT 设计稿 + 用户 6 条明确要求）
> 版本：v1.0（2026-04-28）
> 只读分析，无代码变更。落地拆分见 §9。

---

## 0. 一句话

把 TeamCanvas 从「装胶囊标签的透明板」升级成「每个节点都是一个可独立拖拽的、可展开为完整聊天窗口的成员工位，节点之间在通信时长出触手，整个画布可 pan/zoom，唯一的滚动条在 team 侧边栏列表」。

---

## 1. 现状诊断（为什么要重构）

读过：`TeamCanvas.tsx` / `TeamMonitorPanel.tsx` / `AgentCard.tsx` / `useCanvasTransform.ts` / `useTentacles.ts` / `ChatPanel.tsx` / `TeamPage.tsx` / `teamStore.ts` / `useWsEvents.ts`、`phase2/PRD.md`、`frontend-api/{ws-protocol,bus-events,turn-events,messages-api,instances-api}.md`。

| 问题 | 现状 | 影响 |
|---|---|---|
| **节点不能聊天** | `AgentCard.tsx:72-74` 展开后渲染的是一个空 `CapsuleCard`（agentCount=0 / taskCount=0 / messageCount=0），没有消息列表、没有输入框 | 用户无法和成员对话——等于画布废 |
| **节点展开会吃掉画布** | `AgentCard.css:55-59` 展开态固定 400×400、z-index: 20，压在画布上 | 多节点展开会互相遮挡，没有层级秩序 |
| **没有任务/消息计数** | `TeamPage.tsx:88-98` 给节点组 props 时只有 name/status，没有 taskCount/messageCount | 收起态不知道哪个成员在忙 |
| **触手永远常开** | `useTentacles.ts:53-63` 每帧都重算 leader→members 的触手 | 闲置时也在画触手，不符合"通信时出现"设计 |
| **关闭按钮位置丑** | `TeamMonitorPanel.css:49-64` 右上角 28×28 圆钮，在胶囊转场动画时位置会乱 | 视觉不干净，用户已明确吐槽 |
| **顶部工具栏缺位** | 无"缩放/适应画布/新建/分组/筛选"等工具 | 画布没入口，所有操作只能右键或快捷键 |
| **没有小地图** | 无右下角导航 | 多成员时无法概览、找不到谁在哪 |
| **WS 订阅只跟主 Agent** | `useWsEvents.ts:127-142` `syncInstanceSub` 只订阅 `primaryAgent.instanceId` 一个 scope | 成员的 turn.*/driver.* 事件根本收不到，展开节点没数据 |
| **滚动条泛滥** | 当前层级没统一管理 overflow | 用户明确要求"除 team 列表外不能有滚动条" |

---

## 2. 用户故事

### US-1 我想直接在画布上和某个成员聊天（P0）

> 作为用户，我在画布上看到 Leader 正在推进"API 重构"任务，我想点开 Bob 的节点，直接跟他说"先别动 auth.ts，等 Alice 把接口定了再说"，不需要先打开一个独立窗口。

### US-2 我想在一个视野里同时跟多个成员沟通（P0）

> 作为用户，我展开 Bob 的节点问进度，同时想看到 Carol 的节点正在"responding"，需要时点开 Carol 的节点接着和她聊，两个聊天窗口可以并列存在。

### US-3 我想从画布一眼看出谁在忙谁闲着（P0）

> 作为用户，收起态的节点必须告诉我：这个成员在哪个状态（idle/thinking/responding/offline）、手上有几个任务、累积收发了多少条消息，光看颜色和数字就能定位问题节点。

### US-4 我想看清成员之间在互相聊什么（P1）

> 作为用户，Leader 和 Bob 正在交流时，它们之间应该有一根发光的触手连线，消息发出时触手脉冲一下；没有通信的边不画，画布就是干净的。Leader→成员是粗的主干，成员→成员是细的支线。

### US-5 我想在画布里自由布局，不会丢（P1）

> 作为用户，我把 Bob 拖到右下角、把 Carol 拉到左边，关掉应用再回来，位置要保持；我缩放到 1.5× 看细节，再切到别的团队回来，缩放也要保持。

### US-6 团队多了也不能卡（P1）

> 作为用户，我有 8 个成员时，画布还是 60fps 流畅的；小地图能帮我找到"跑到视野外的节点"，一键适应画布把所有节点框回来。

---

## 3. 功能清单（分级）

### P0 — 必须，本期交付

| # | 功能 | 说明 |
|---|---|---|
| F1 | 节点收起态 = 信息胶囊 | 显示：Avatar + AgentLogo(cliType) + 名字 + StatusDot + taskCount 胶囊 + agentCount/messageCount 小徽 |
| F2 | 节点展开态 = 完整聊天窗口 | 顶栏（头像+名字+状态+关闭）+ 消息列表（复用 ChatPanel 的 VirtualList+MessageRow）+ 输入框（ChatInput）+ 工具栏（停止/取消/模式） |
| F3 | 节点独立拖拽 | 收起态和展开态都能拖（展开态只有顶栏 drag handle），坐标按画布坐标系（`x/y` 画布内），拖完落盘到 `teamStore.canvasStates[teamId].nodePositions` |
| F4 | 发送消息链路 | 展开态输入框 → `ws.prompt({ instanceId, text, requestId })` 直投该成员 driver；本地 echo 到 messageStore |
| F5 | 接收消息链路 | 对每个被展开的节点 `subscribe({ scope:'instance', id:instanceId })`；`turn.*` / `driver.started\|stopped\|error` 事件按 instanceId 分桶 |
| F6 | 画布 pan/zoom（保留） | 复用 `useCanvasTransform`，双击空白重置，wheel=缩放以鼠标为中心，mousedown+drag 平移，已验证 |
| F7 | 画布状态持久化（保留） | 复用 `teamStore.canvasStates[teamId]`，pan/zoom/nodePositions 三件套 |
| F8 | 顶部工具栏 | 左：画布标题（team 名 + 成员数）；右：[缩放百分比] [适应画布] [+新建成员] [齿轮] |
| F9 | 右下角缩放控件 | 三按钮：缩小 / 缩放百分比展示 / 放大；双击该百分比 → 1× |
| F10 | 统一 overflow 规则 | `.team-monitor`/`.team-canvas` `overflow:hidden`；唯一滚动条出现在 `TeamSidebar` 的 team 列表；**聊天消息列表内部滚动靠 VirtualList 虚拟滚动，不产生原生滚动条** |
| F11 | 关闭按钮重设计 | 移到顶部工具栏最右（和齿轮同行），尺寸/样式与工具栏按钮一致；移除现在 `team-monitor__close` 的浮层样式 |

### P1 — 应做，本期争取

| # | 功能 | 说明 |
|---|---|---|
| F12 | 触手按通信状态显隐 | 默认不画；`comm.message_sent`/`turn.started` 触发对应边脉冲 800ms；`turn.completed` 后 2s 无新消息触手淡出 |
| F13 | 小地图 | 右下角 160×100，显示全部节点位置 + 当前视口框；点击跳转 |
| F14 | 节点徽章动效 | thinking 呼吸、responding 脉冲（已有 CSS），responding 时节点外框蓝色发光强度随 turn.block_updated 频率升高 |
| F15 | 展开并行上限 | 默认同时最多展开 3 个节点；超过时最早打开的自动收起（带 toast）|
| F16 | 键盘快捷键 | `Esc` 关展开的节点，`F` 适应画布，`0` 重置 1×，`Ctrl+滚轮` 大步缩放 |

### P2 — 可以以后

| # | 功能 | 说明 |
|---|---|---|
| F17 | 分组 / 筛选 | 按状态 / 角色模板分组染色；筛选只看 thinking 的成员 |
| F18 | 自动布局切换 | 环形 / 层级 / 力导向三种 |
| F19 | 会话历史回放 | 展开节点上滑翻 `get_turn_history` 冷历史 |

---

## 4. 数据来源映射（功能 → API/事件）

| 需求点 | 数据来源 | 说明 |
|---|---|---|
| 节点列表（leader+members） | `teamStore.teams` + `teamStore.teamMembers[teamId]` + `agentStore.agents`（做 join） | 完全复用现有 `TeamPage.tsx:54-76` 的组装逻辑；*`GET /api/teams/:id` 返回的 members 是裸行，无 name/status，必须本地 join*（mnemo #624）|
| 节点 name | 优先 `teamMembers[teamId][i].roleInTeam`，再回退 `agentStore` 的 name | 已有 |
| 节点 status | `agentStore.agents[i].status` → 映射 `idle\|thinking\|responding\|offline` | WS `driver.started/stopped/error` + `primary_agent.state_changed` 已维护；成员 state 通过 `turn.started/completed` 间接推断 |
| 节点 taskCount | **新增**：以实例为主体，读 `taskStore.tasks[instanceId]` 数量 | 本期如无现成 store，先 `0` 兜底，F1 验收不强制 |
| 节点 messageCount | 本期用 **在线 session 的 turn 数** 作为近似：`messageStore.turns[instanceId].length` | 等 `messages-api` 接入后再切真实收件箱 `GET /api/role-instances/:id/inbox?peek=true&limit=1` 的 `total` 字段 |
| 节点展开后的消息流 | 订阅 `scope:'instance', id:instanceId`；`turn.started` / `turn.block_updated` / `turn.completed` / `turn.error` 四类事件（turn-events.md §2） | 按节点独立 store：`messageStore.turns[instanceId]` |
| 节点展开时的历史 | 展开瞬间 `ws.send({ op:'get_turns', driverId:instanceId, limit:20, requestId })`（快照） | 已有 `useWsEvents` 做过主 Agent 的版本，需泛化到任意 driver |
| 发送消息 | `ws.send({ op:'prompt', instanceId, text, requestId })` | fire-and-forget；ack 只表示已接收；真正的结果走 turn 流；*用户 prompt 直投 driver，不走 CommRouter*（mnemo #548）|
| 停止生成 | `ws.send({ op:'cancel_turn', instanceId, requestId })` | 已有（ws-protocol.md §cancel_turn）|
| 触手通信高亮 | `comm.message_sent` 事件（bus-events.md comm.*）+ `turn.started` | 按 `from/to` 的 instanceId 匹配节点对 |
| 团队/成员实时变更 | `team.created/disbanded/member_joined/member_left` + `instance.created/activated/offline_requested/deleted` | 已全部在 `teamStore`/`agentStore` 接入 |

---

## 5. 页面布局结构（文字描述）

```
TeamPage (pages/TeamPage.tsx)
└─ PanelWindow (templates)                         ← 整窗，唯一的"close window"按钮挪到工具栏，不要外挂
   └─ TeamMonitorPanel (organisms)                 ← overflow:hidden
      ├─ TeamSidebar (molecules)                   ← 左列，唯一允许出现滚动条的区域
      │  ├─ 顶部：MTEAM 标识 + [+ 新团队]
      │  ├─ 团队列表（带 overflow-y:auto，VirtualList 可选）
      │  └─ 底部：用户胶囊 / 设置入口
      └─ CanvasWorkspace (organism，新建)           ← 右侧主区，flex:1, overflow:hidden
         ├─ CanvasTopBar (molecule，新建)           ← 顶，h=44
         │  ├─ 左：{team.name}  ·  {memberCount} 成员
         │  └─ 右：[100%] [适应画布] [+ 新成员] [齿轮] [关闭窗口]
         ├─ TeamCanvas (organisms，重构)            ← 中，flex:1, position:relative, overflow:hidden
         │  ├─ <canvas>  tentacles WebGL 画布      ← z:1
         │  ├─ .viewport  transform:translate+scale ← z:2，pointer-events:none
         │  │  └─ AgentNode × N (molecule，重构，对应现 AgentCard)
         │  │     ├─ 收起态 NodeCapsule           ← 显示 Avatar+Logo+Name+Status+胶囊徽
         │  │     └─ 展开态 NodeChat              ← 独立飘浮层，位置锚定原节点+偏移
         │  │        ├─ NodeChatHeader (drag handle)
         │  │        ├─ ChatPanel (organisms，复用)
         │  │        └─ 右上小按钮：[最小化] [关闭]
         │  ├─ ZoomControl (molecule，新建)         ← 右下绝对定位，z:3
         │  └─ MiniMap (molecule，新建 / P1)        ← 右下 ZoomControl 上方，z:3
         └─ （无其他层）
```

**层级/z-index 约定**：
- canvas（触手层） z:1
- viewport 本身 z:2，单个 AgentNode 默认 z:2，拖拽中 z:10，展开中 z:20，hover/active 聚焦的展开节点 z:30
- ZoomControl/MiniMap/CanvasTopBar z:40（永远在最上）

**展开态节点的定位规则**：
- 展开态不改 `transform` 坐标系，仍位于 viewport 内；`width: 420px; height: 560px`（建议值）
- 如果展开会撞画布边缘，viewport 负责 auto-pan 把它框进来（"吸附进入视野"）
- 展开节点的拖拽通过顶栏（`NodeChatHeader`）触发；消息列表、输入框区域 `no-drag`
- 超过 F15 规定的并行上限时，最早的自动收起并保留 pan 位置不变

**无滚动条保证**：
- `.team-monitor`, `.canvas-workspace`, `.team-canvas`, `.agent-node--expanded` 全部 `overflow:hidden`
- 消息列表已有 `.chat-panel__messages` + `VirtualList`——它不产生原生滚动条（用 transform 移动内部 wrapper，见 mnemo #593）
- 唯一例外：`.team-sidebar__teams-list { overflow-y: auto }`

---

## 6. 交互细节（回答用户 6 条明确要求）

| 用户要求 | 本 PRD 答复 |
|---|---|
| ① 节点展开 = 聊天窗口，能和每个成员聊天 | F1+F2+F4+F5：展开态直接渲染 ChatPanel（复用 organisms/ChatPanel.tsx），发送走 `ws.prompt({instanceId, text})`，接收走 `subscribe(scope:instance, id:instanceId)` + `turn.*` 事件流 |
| ② 节点可独立拖拽（相对画布） | F3：沿用 AgentCard 现有的 mousedown+mousemove/mouseup 实现，坐标已按 zoom 换算（见 `AgentCard.tsx:40-53`），扩展到展开态用顶栏做 drag handle |
| ③ 整个窗口不能有滚动条（除 team 列表） | F10+§5 无滚动条保证；交付前自检 `document.querySelectorAll('*').filter(el => getComputedStyle(el).overflow === 'auto' or 'scroll')` 只允许命中 `team-sidebar__teams-list` |
| ④ 关闭按钮位置要合理 | F11：统一挪进 CanvasTopBar 最右侧，与齿轮/适应画布同一列，移除 `team-monitor__close` 右上浮层 |
| ⑤ 触手连线在通信时出现 | F12：`useTentacles` 改造为按"最近通信时间"过滤 —— 每条边有 `lastActiveTs`，大于 2s 未激活则不画；`comm.message_sent` / `turn.started` 刷新对应边的 `lastActiveTs` 并触发脉冲动画 |
| ⑥ 交互细节处理干净 | 见 §7 验收标准；每个 UI 状态都有明确预期，没有"应该大概差不多"的模糊点 |

---

## 7. 验收标准（可测试）

### AC-1 节点收起态（F1）
- [ ] 每个节点正确展示：头像、CLI logo、名字、状态点、taskCount 胶囊（无任务隐藏）
- [ ] 状态点 4 色对应 `idle/thinking/responding/offline`，与 `agentStore` 实时同步
- [ ] `thinking` 节点有呼吸动画；`responding` 节点有蓝色脉冲（复用 AgentCard.css 现有动画）
- [ ] `offline` 节点灰度 0.85 + opacity 0.5（沿用）

### AC-2 节点展开态（F2）
- [ ] 单击节点空白处（非拖拽）展开；位置=节点原位置偏移，不遮挡 TopBar
- [ ] 展开面板顶栏含：头像、名字、状态点、最小化按钮、关闭按钮
- [ ] 消息列表使用 ChatPanel + VirtualList；空列表显示占位
- [ ] 输入框可输入，回车发送；发送过程中显示 streaming 态 + 停止按钮
- [ ] 工具栏至少含：取消生成按钮（`cancel_turn`）

### AC-3 节点拖拽（F3）
- [ ] 收起态拖拽：鼠标 drag 阈值 > 3px 才视为拖拽（避免误触发展开）
- [ ] 展开态拖拽：只允许顶栏触发；消息列表、输入框正常接收 mouse 事件
- [ ] 拖拽结束后 `updateNodePosition(teamId, id, {x,y})` 落盘；刷新应用后位置保持
- [ ] 拖拽时视觉反馈：scale 1.04、阴影加深、z-index=10（沿用）

### AC-4 消息收发（F4+F5）
- [ ] 输入 "hi" → Network 看到 WS `op:prompt` upstream，`ack.ok=true`
- [ ] 本地 echo 立即出现在列表（user 气泡）
- [ ] 后端回复通过 `turn.started` → `turn.block_updated` (text block) → `turn.completed` 推回
- [ ] 多个节点展开时，每个节点只显示自己的消息，不串台
- [ ] 点击停止按钮 → `op:cancel_turn` → 后端回 `turn.completed` with `stopReason:'cancelled'`

### AC-5 WS 订阅（F5 内部）
- [ ] 展开节点 X → WS 发 `subscribe(scope:instance, id:X)`
- [ ] 关闭节点 X → WS 发 `unsubscribe(scope:instance, id:X)`
- [ ] 主 Agent 的 instance 订阅维持不变（独立于成员）
- [ ] 同时展开 3 个节点 → 同时 3 个 instance subscription，互不干扰

### AC-6 画布 pan/zoom（F6+F7）
- [ ] 空白处 drag → 画布平移，不拖动节点
- [ ] 节点上 mousedown → 不触发画布平移（`e.target === e.currentTarget` 已保证）
- [ ] Wheel/pinch → 以鼠标位置为中心缩放，0.25~3 clamp
- [ ] 双击空白 → 重置 1×, 0, 0
- [ ] 切 team 再切回来 → pan/zoom/nodePositions 完全恢复

### AC-7 顶部工具栏（F8）
- [ ] 左侧显示 `{team.name} · {memberCount} 成员`
- [ ] 缩放百分比按钮点击 → 弹菜单 50/75/100/150/200/适应画布
- [ ] 适应画布按钮 → 计算所有节点 bbox，自动调整 pan/zoom 把全部塞进视口（留 40px padding）
- [ ] 新建成员按钮 → 调 `openRoleList()`（复用 Phase 3 RoleListPage 已有能力）
- [ ] 齿轮 / 关闭窗口按钮集中在此区，没有其他位置的 X 按钮

### AC-8 右下缩放控件（F9）
- [ ] [-] [100%] [+] 三按钮；点击 [-]/[+] 步进 0.1；双击 [100%] → reset
- [ ] 当前 zoom 实时同步（subscribe `getTransform` 或 transform commit 回调）

### AC-9 无滚动条（F10，硬约束）
- [ ] DevTools 里遍历所有元素，`overflow:auto|scroll` 的只有 `.team-sidebar__teams-list`
- [ ] 聊天消息超长 → VirtualList 内部虚拟滚动，不出现原生滚动条
- [ ] 节点展开面板内 `ChatPanel` 的 `.chat-panel__messages` 已有正确配置（mnemo #593）

### AC-10 关闭按钮（F11）
- [ ] 原 `team-monitor__close` 右上浮层移除
- [ ] 新关闭按钮位于 CanvasTopBar 右端最末位，与齿轮同行
- [ ] 点击 → `window.close()`（保留现有行为）
- [ ] Esc 键仍触发 `window.close()`（TeamPage.tsx:127-131 保留）

### AC-11 触手通信（F12，P1）
- [ ] 默认无触手
- [ ] A→B 发消息（`comm.message_sent` from=A to=B 或 `turn.started` on B 且 A 为 Leader）→ A-B 边 800ms 脉冲
- [ ] 2 秒无新消息 → 触手渐隐至完全消失
- [ ] 多对通信并发 → 多条触手独立脉冲，互不干扰

### AC-12 性能
- [ ] 8 个成员全部 idle + 空触手 → 60fps（DevTools Performance）
- [ ] 3 个节点展开且 1 个正在 responding + 实时触手 → ≥ 55fps
- [ ] 画布 transform 写 DOM（非 React state），已由 `useCanvasTransform` 保证
- [ ] VirtualList 上限 500 条消息（mnemo #668）

### AC-13 回归
- [ ] `tsc` 0 error
- [ ] `npm run build` 成功
- [ ] `npm run playground:build` 成功
- [ ] 组件库 100% 合规（0 裸 SVG / 0 Tailwind / 0 自研 button/input）
- [ ] Playground 新增 CanvasWorkspace、ZoomControl、AgentNode 的 demo

---

## 8. 组件变更清单（对照 renderer CLAUDE.md 铁律）

| 层 | 组件 | 状态 | 说明 |
|---|---|---|---|
| organisms | `TeamCanvas` | **大改** | 剥离工具栏/缩放控件；仍是纯画布 + 节点容器；props 新增 `onNodeOpen(id)` `openedNodeIds: string[]` |
| organisms | `CanvasWorkspace` | **新增** | 包 TopBar+TeamCanvas+ZoomControl+MiniMap 的组合 organism |
| organisms | `TeamMonitorPanel` | **小改** | 把 TeamCanvas 替换成 CanvasWorkspace；移除浮层 close 按钮 |
| organisms | `ChatPanel` | **复用** | 完全不改；`agents=[]` 就能在单 agent 场景用（renderer/.claude/CLAUDE.md §4） |
| molecules | `AgentCard` | **改名为 AgentNode 并大改** | 展开态替换为 ChatPanel 包装，加顶栏/关闭按钮；收起态增强胶囊徽 |
| molecules | `CanvasTopBar` | **新增** | 工具栏 molecule（左侧标签 + 右侧按钮组） |
| molecules | `ZoomControl` | **新增** | 右下角三按钮控件 |
| molecules | `MiniMap` | **新增（P1）** | Canvas 缩略图 + 视口框 |
| molecules | `NodeChatHeader` | **新增** | AgentNode 展开态顶栏（drag handle + 关闭） |
| atoms | `Icon` | 扩展 | 需要补 `minimize` / `fit` / `map` 图标 |
| hooks | `useCanvasTransform` | **复用** | `getTransform/setTransform` 已经暴露，够用 |
| hooks | `useTentacles` | **小改** | 接受 `activeEdges: {fromId,toId,intensity}[]` 参数，只画活跃边 |
| hooks | `useInstanceSubscriptions` | **新增** | 管理多 instanceId 的 subscribe/unsubscribe，抽离 `useWsEvents` 的单 instance 逻辑 |
| store | `teamStore` | **复用** | `canvasStates` 已有，够用 |
| store | `messageStore` | **小改** | turns 按 driverId/instanceId 分桶（已有？需验证）|
| store | `agentStore` | **复用** | 状态同步已到位 |

**Playground 新增 demo**：CanvasWorkspace 全景、AgentNode 收起 vs 展开四态、ZoomControl、CanvasTopBar、MiniMap（P1）。

---

## 9. 实施顺序建议（供后续拆分用，非 PRD 必选项）

> Wave 拆分不是产品需求，仅便于工程侧并行。PM 建议：

**Wave A（底座，1 人，2d）**
- AgentNode 改造：收起态增强 + 展开态集成 ChatPanel
- 展开/收起状态在节点内管；顶栏 drag handle

**Wave B（画布外围，1 人，1.5d）**
- CanvasWorkspace + CanvasTopBar + ZoomControl
- 关闭按钮迁移到 TopBar

**Wave C（消息链路，1 人，2d）**
- `useInstanceSubscriptions` 抽离
- messageStore 支持多 driverId 分桶
- 发送/接收/取消/历史快照全链路跑通

**Wave D（触手 + 小地图 + 性能，1 人，1.5d）**
- useTentacles 活跃边改造
- MiniMap
- 8 成员+3 展开性能验证

**合流/测试（团队 1d）**
- E2E：主 Agent 创建 leader → leader 加 2 成员 → 用户在画布上直接和 3 个实例并行对话
- CDP 自动化验收 AC-1 ~ AC-13

---

## 10. 风险与边界

| 风险 | 处置 |
|---|---|
| 同时展开多节点导致性能退化 | F15 限制并行展开 ≤ 3；VirtualList 本就只渲视口内消息 |
| 成员 driver 未 READY 时用户发消息 | `ack.ok=false, reason='not_ready'` → UI 禁用输入 + toast "agent 未就绪" |
| 触手事件过密导致抖动 | 脉冲用 requestAnimationFrame 节流；`lastActiveTs` 合并窗口 120ms |
| 节点被拖到视口外 | "适应画布" 按钮可一键找回；MiniMap 也能点回 |
| 节点展开时宽高超出小画布 | auto-pan 吸附；最小画布尺寸 ≥ 560×480（现 TeamCanvas.css 已保证） |
| 成员 inbox 数据源未接 | messageCount 本期用 turn 数兜底；F1 验收不强制真实收件箱 |

---

## 11. 知识依赖（mnemo）

| ID | 标题 | 用途 |
|---|---|---|
| #872 | TeamCanvas 环形自动布局 + 画布状态持久化 | 沿用 `layout.ts` + `teamStore.canvasStates` 契约 |
| #647 | TeamCanvas 实时渲染 agents（teamStore + agentPool join） | 节点组装逻辑，包含 leader-first 顺序 |
| #624 | GET /api/teams/:id members 是裸行不含 name/status | 解释为何必须前端 join |
| #548 | WS prompt 直投 driver 不走 CommRouter | 节点发送链路的后端契约 |
| #501 | 展开态聊天面板数据流审查（2026-04-26） | 复用其修复结论：订 instance scope + 真实 instanceId + blocks/streaming 传入 ChatPanel |
| #593 | ChatPanel 滚动容器 padding 放内层 wrapper | 展开节点 ChatPanel 的 padding 规则 |
| #668 | VirtualList useMemo + messageStore 上限 | 性能基线 |
| #739 | Phase 2 AgentCard 四态 | 状态映射表 |
| #637 | 主 Agent create_leader + teamCanvas 开发方案 | 上游依赖 |

---

## 12. 评审检查清单（交 team-lead）

- [ ] 用户 6 条明确要求 100% 对齐（§6 表格）
- [ ] 每个 P0 功能都有唯一数据来源（§4）
- [ ] 每个 AC 都可测试、有失败判定条件
- [ ] 没有引入 renderer 铁律禁止的东西：裸 SVG / Tailwind / 外部 UI 库
- [ ] 组件变更清单覆盖所有新增 UI，且能在 Playground 注册
- [ ] 关闭按钮、滚动条、触手、独立拖拽等用户吐槽点均有明确方案

---

**PM 结论**：可以开干。建议 team-lead 按 §9 Wave 拆分，先 Wave A+B 并行（无冲突），Wave C 依赖 A 完成后接手，Wave D 最后合流。整体 5-6 个工作日可完成 P0+P1。
