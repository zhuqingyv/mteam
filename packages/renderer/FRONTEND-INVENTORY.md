# 前端现状盘点（组件 / store / 设计文档对齐）

> 任务 #7 产出。数据源：
> - `packages/renderer/COMPONENT-ARCHITECTURE.md`（分层架构权威）
> - `packages/renderer/CHAT-UI-RESEARCH.md`（聊天界面调研报告）
> - `packages/renderer/src/` 实际文件
>
> 目的：下一个接手前端的 agent 不需要重读两份长文档就知道"什么能用、什么要改、什么要新建"。

## 终局统计（Round 10 收尾）

| 层 | 数量 | 目录 |
|---|---|---|
| atoms | **12** | Button / Icon / Logo / MessageMeta / NotificationCard / StatusDot / Surface / TeamSidebarItem / Text / ToolCallItem / TypingDots / VirtualList |
| molecules | **16** | AgentCard / AgentSwitcher / Avatar / ChatHeader / ChatInput / CliList / DragHandle / MenuDots / MessageBadge / MessageBubble / MessageRow / NotificationStack / RosterList / TeamSidebar / TitleBlock / ToolCallList |
| organisms | **9** | AgentList / CapsuleCard / ChatPanel / ExpandedView / NotificationCenter / PrimaryAgentSettings / TeamCanvas / TeamMonitorPanel / TemplateEditor |
| templates | **2** | CapsuleWindow / PanelWindow |
| pages | **3** | CapsulePage / TeamPage / SettingsPage |
| hooks | **2** | useCapsuleToggle / useWsEvents |
| api | **12** | client / index / ws / cli / driver-turns / instances / mcp / primaryAgent / roster / sessions / teams / templates |
| store | **7** | agentStore / inputStore / messageStore / notificationStore / taskStore / windowStore / index |

---

## 1. 架构铁律（来自 COMPONENT-ARCHITECTURE.md）

1. **五层单向依赖**：tokens → atoms → molecules → organisms → templates → pages；**不允许反向依赖**。
2. **抽象跟随场景**：第一次出现不抽，第二次观察，第三次必抽。
3. **Token 即契约**：跨组件的视觉参数只能在 `design-tokens/tokens.css` 定义；tailwind.config.ts 的 `theme.extend` 映射 CSS 变量。
4. **Atom 不接 `className` / `style` 透传**：想改样式 → 加枚举变体，不开天窗。
5. **Props 约定**：
   - 回调统一 `onXxx`（禁止 `handleClick`）
   - 布尔状态直接名词 `online` / `selected` / `disabled`（禁止 `isXxx`）
   - 尺寸/变体字符串枚举 `size='md'`（不是数字，除非例外）

---

## 2. 实际目录（当前 src/）

```
src/
├── design-tokens/   tokens.css / tokens.ts / index.ts
├── atoms/           Button, Icon, Logo, MessageMeta, NotificationCard,
│                    StatusDot, Surface, Text, ToolCallItem, TypingDots, VirtualList
├── molecules/       AgentSwitcher, Avatar, ChatHeader, ChatInput, DragHandle,
│                    MenuDots, MessageBadge, MessageBubble, MessageRow,
│                    NotificationStack, TitleBlock, ToolCallList
├── organisms/       CapsuleCard, ChatPanel
├── templates/       ✗ 空目录
├── pages/           ✗ 空目录
├── hooks/           ✗ 空目录
├── store/           chatStore, teamStore, uiStore, index.ts  （均为占位骨架）
├── api/             client.ts（HTTP 封装 + 部分 team API）
├── App.tsx / main.tsx / index.css / vite-env.d.ts / assets/
```

---

## 3. Atoms 现状（11 个）

| 组件 | 状态 | 实际 props / 关键行为 | 偏离 CHAT-UI-RESEARCH §5.1 的地方 |
|---|---|---|---|
| Button | ✅ | `variant: primary/ghost/icon/dots`、`size: sm/md/lg`、`onClick`、`disabled` | `dots` 变体（胶囊右侧菜单点）超出研究文档，但合理 |
| Icon | ✅ | — | — |
| Logo | ✅ | `size` | — |
| MessageMeta | ✅ | `time`、`read?` | 研究文档原计划放 molecule 层，已提到 atom |
| NotificationCard | ✅ | — | — |
| StatusDot | ✅ | `status: online/busy/offline/warning/danger`、`size` | — |
| **Surface** | ⚠️ **阻塞** | **当前仅 `variant: 'capsule' \| 'panel'`** | **CHAT-UI-RESEARCH §4.3 要求扩为 `capsule/panel/bubble-glass/bubble-accent/input/chip`；尚未落地** |
| Text | ✅ | — | — |
| ToolCallItem | ✅ | 工具调用折叠展示 | — |
| TypingDots | ✅ | 三点跳动动画 | — |
| **VirtualList** | 🆕 | `items`、`renderItem`、`getKey`、`itemEstimateHeight`、`overscan`、`onScrollTop` | CHANGELOG **D-12 已裁决**：原子保留、**P0 不启用**（消息 <500 条用手写滚动）。当前 `ChatPanel` 已用 `VirtualList`，需在 P0 换回普通滚动 |

**未建（CHAT-UI-RESEARCH §5.1 要求）**：
- `BubbleTail`（气泡尖角 SVG）—— P0
- `ReadReceipt`（双勾已读）—— P1；注意 MessageMeta 内部已用简单 `read` 文字占位，要替换
- `Caret`（流式光标）—— P0

---

## 4. Molecules 现状（12 个）

| 组件 | 状态 | 实际 props | 风险点 |
|---|---|---|---|
| **Avatar** | ⚠️ | `online?`、`size=56`。**内部硬绑 `<Logo />`** | 研究文档 §1 §5.2 要求扩 `variant: logo/image/initial` 三态；尚未落地。用户头像需求一出就得改 |
| **AgentSwitcher** | ✅ 超前 | `agents[{id,name,icon?,active?}]`、`activeId`、`onSelect`、`onAdd` | 研究文档原先推测是单按钮+下拉，实际已做多 tab + 号按钮形态；**与设计稿 41 对齐**，可用 |
| **ChatHeader** | ✅ | — | — |
| **ChatInput** | ⚠️ **必测缺口** | `placeholder`、`value`、`onChange`、`onSend`；Enter 发送、Shift+Enter 换行；autosize ≤120px | **没有 IME compositionstart/end 保护** —— 中文输入法 Enter 会误发；CHAT-UI-RESEARCH §5.3 / §6 明确要求 |
| DragHandle | ✅ | — | — |
| MenuDots | ✅ | — | — |
| MessageBadge | ✅ | — | — |
| **MessageBubble** | ⚠️ API 偏离 | `variant: 'agent' \| 'user' \| 'thinking'`、`agentName?`、`time?`、`read?`、`children?` | 研究文档 §2.3 建议的 `side + tone + status` 三维拆分未采用；当前三态耦合在单一 `variant`。**thinking 态的三点动画直接用内部 `<span class="bubble__dots">`，没走 `TypingDots` atom** —— 重复造轮 |
| MessageRow | ✅ | `role`、`content`、`time`、`read?`、`agentName?`、`thinking?`、`toolCalls?` | 相当于研究文档的 `MessageListItem`；自己处理 role 对 Avatar 显示 |
| NotificationStack | ✅ | — | — |
| TitleBlock | ✅ | — | — |
| ToolCallList | ✅ | `calls: ToolCall[]` | `ToolCall` 类型定义在此 |

**未建（CHAT-UI-RESEARCH §5.2 曾提，但 CHANGELOG D-9 已裁决不拆）**：
- ~~`ThinkingIndicator`~~ —— **D-9 裁决：不拆组件**，思考态保留在 `MessageBubble` 内部三态切换（`variant='thinking'`）。**仍建议**把内部自写的 `<span class="bubble__dots">` 改为复用 `TypingDots` atom 去重复造轮（这不违反 D-9，D-9 反对的是拆独立 molecule，不反对复用下层 atom）
- 无法独立抽出 `SpeechBubble`（研究文档 §10 计划，真实场景只出现在 MessageBubble 内，按"三次出现才抽"原则先不抽）

---

## 5. Organisms（2 个）

| 组件 | 状态 | 已接入 | 缺 |
|---|---|---|---|
| CapsuleCard | ✅ | 胶囊主体 | 未接真实 store（agent 数 / 任务数 / 未读数都是 props 传入） |
| ChatPanel | ⚠️ 壳就绪 | `MessageRow` via `VirtualList`、`AgentSwitcher`、`ChatInput`（仅 `value=""` 固定） | **1）`ChatInput` 的 `onChange/onSend` 没接；2）`AgentSwitcher` 的 `onSelect/onAdd` 没接；3）消息源是 prop 假数据，未接 `chatStore`；4）未挂 `ThinkingIndicator`**（thinking 态靠 MessageBubble 内部渲染） |

**未建（PRD 要求）**：
- `AgentList` / `TeamPanel` / `TemplateEditor` / `McpStorePanel` / `SettingsPanel` / `NotificationCenter` —— P1
- `InboxList`（展示单 agent inbox 摘要，对应 PRD §1.12 `GET /api/role-instances/:id/inbox`，等 D6 暴露到 `/api/panel/`）—— P1
- `MessageHistoryList`（团队消息历史滚动加载，对应 PRD §1.12 `GET /api/teams/:id/messages`，等 D6）—— P1
- `JellyPet` —— P2

---

## 6. Templates / Pages（空）

两个目录均空。`App.tsx` 仍在做多窗口路由分发，按 COMPONENT-ARCHITECTURE §11 计划该拆成 `CapsulePage / ChatPage / SettingsPage / PetPage`，未动。

P0 至少需要：
- `templates/CapsuleWindow.tsx`（胶囊骨架 + 拖拽区接管）
- `templates/PanelWindow.tsx`（聊天/设置面板骨架）
- `pages/CapsulePage.tsx` + `pages/ChatPage.tsx`

---

## 7. Store 现状（全是占位骨架）

| Store | 现状 | PRD §4.2 建议 |
|---|---|---|
| `chatStore` | 仅 `{ messages, inputText }`，不分 driver | 按 `driverId` 分会话：`{ byDriverId, currentDriverId, activeTurn, streaming }` |
| `teamStore` | `{ agents, tasks, messages }` —— 职责混杂 | 应拆成 `instanceStore` / `teamStore` / `rosterStore` 独立 |
| `uiStore` | `{ windowMode, sidebarOpen }` | 基本够用，待扩 `currentAgentTabId` 等 |
| `templateStore` / `mcpStore` / `cliStore` / `primaryAgentStore` / `notificationStore` / `eventCacheStore` | **全部未建** | P0/P1 按需新建 |

**没有任何 store 订阅 WS 事件**。整个"WS → store"链路是缺的。

---

## 8. API 现状（src/api/client.ts）

- `apiFetch` / `apiGet` / `apiPost` / `apiPut` / `apiDelete` 已有，统一返 `ApiResult { ok, status, data, error }`
- 已封装的具体 API：Team 7 个（listTeams / getTeam / createTeam / disbandTeam / listMembers / addMember / removeMember）
- ⚠️ **已封装的 Team API 违反新硬门禁**（只能走 `/api/panel/`，但它们走 `/api/teams/*`）。下一步需要删除或等服务端在 `/api/panel/` 下重新暴露
- **没有 WS 客户端** `src/api/ws.ts` —— P0 必须建
- WS 路径当前 `/ws/events`（后端 `bus/ws-upgrade.ts:15`），**是否受 `/api/panel/` 门禁约束仍待裁决**（PRD §2.3 #9）；前端实现时用常量存路径，不写死为 prod 契约
- 前端目前**唯一合规可调**端点：`GET /api/panel/driver/:id/turns`（Turn 快照）

详见 `SERVER-API-INDEX.md` 顶部"前端使用警告"和 PRD §0.2。

---

## 9. Design Tokens 现状（tokens.css）

权威文件已落地，和 COMPONENT-ARCHITECTURE §5 对齐：
- 强调色 / 文本 / 表面 / 间距（1-6） / 圆角（sm-pill） / 字体 / 阴影（soft/glass/float） / 动效（fast/base/slow + easing-standard）
- 新增了 `--color-accent-primary-rgb` 供 rgba 拼接用（超出原设计，但实用）

**CHAT-UI-RESEARCH §4.3 要求新增但尚未落的 token**：
- `--glow-soft / --glow-medium / --glow-strong`（气泡发光的三档 box-shadow）
- `--bubble-accent-fill`（用户气泡蓝色底）
- `--stroke-hairline`（1px 半透明描边色）

---

## 10. 优先级缺口总表（给下一个 agent）

### P0（必须先做，影响聊天主链路）

> ⚠️ **阻塞警告**：服务端 `/api/panel/*` facade 未就绪（**D6**），P0 HTTP 交互大部分无法落地，只有 `GET /api/panel/driver/:id/turns` 合规。当前阶段前端只能做"UI 骨架 + 假数据"。

| 缺口 | 所在层 | 来源文档 |
|---|---|---|
| 0. **删除 `client.ts` 里违反 `/api/panel/` 门禁的 Team API 封装**，或打 TODO 标签等 facade | api | mnemo `feedback_no_direct_backend_api` |
| 1. `ChatInput` 加 IME compositionstart/end 保护 | molecule | CHAT-UI-RESEARCH §5.3 §6 |
| 2. `ChatPanel` 接 `chatStore` + 接 `onChange/onSend/onSelect` | organism | PRD §1.2 |
| 3. 建 `src/api/ws.ts` + `eventCacheStore` + 串 `chatStore`（turn.* 事件 → block upsert） | store + api | PRD §4.3 / `SERVER-EVENTS-INDEX.md` |
| 4. 封装 `apiGetDriverTurns`（`GET /api/panel/driver/:id/turns`）；**不要**封装非 `/api/panel/` 端点 | api | `SERVER-API-INDEX.md` 顶部警告 |
| 5. `MessageBubble` 内部的自写三点动画改为复用 `TypingDots` atom（不拆独立 molecule，遵循 D-9） | molecule 内部 | CHAT-UI-RESEARCH §3 + CHANGELOG D-9 |
| 6. 新建 `BubbleTail` atom + `Caret` atom；`MessageBubble` 用上 | atom | CHAT-UI-RESEARCH §5.1 |
| 7. `ChatPanel` 按 CHANGELOG D-12 把 `VirtualList` 换为普通滚动（P0 不启用虚拟滚动） | organism | CHANGELOG D-12 |
| 8. 建 `templates/CapsuleWindow` + `templates/PanelWindow`；把 `Surface` 的 drag 耦合移出 | template + atom | CHAT-UI-RESEARCH §4.3；COMPONENT-ARCHITECTURE §11 |

### P1（团队管理落地）

| 缺口 | 所在层 |
|---|---|
| `Avatar` 扩 `variant: logo/image/initial` 三态 | molecule |
| `Surface` 扩 `bubble-glass / bubble-accent / input / chip` variant | atom |
| tokens 加 `--glow-*` / `--bubble-accent-fill` / `--stroke-hairline` | tokens |
| 建 `AgentList` / `TeamPanel` / `TemplateEditor` / `McpStorePanel` / `SettingsPanel` / `NotificationCenter` | organism |
| 拆 `teamStore` 成 `instanceStore` / `teamStore` / `rosterStore` | store |
| D6 落地后，在 `/api/panel/` 下重新封装 9 组端点（见 §8） | api |

### P2（远期）

- `JellyPet` 桌宠
- Markdown 渲染
- MCP 工具搜索面板（聊天内 `/tool`）

---

## 11. 与其他参考文档的关系

| 文档 | 定位 |
|---|---|
| `COMPONENT-ARCHITECTURE.md` | 分层与命名铁律（不变层，改动需评审） |
| `CHAT-UI-RESEARCH.md` | 聊天界面的设计决策原因（异形气泡 / 思考态 / 发光边 Q1~Q3 权衡） |
| `PRODUCT-REQUIREMENTS.md` | 功能 / 优先级 / 交互流程 / 数据流（what & why） |
| `SERVER-API-INDEX.md` | 服务端 HTTP 端点清单（⚠️ 前端只可用 `/api/panel/*`） |
| `SERVER-EVENTS-INDEX.md` | 服务端 WS 事件与数据结构清单 |
| `DESIGN-REFERENCE.md` | 设计稿视觉规格（像素/色值/字号） |
| `CHANGELOG.md` | 迭代日志 + 13 条设计决策 D-1~D-13（含 D-9 思考态不拆 / D-12 P0 不启用虚拟滚动 / D-6 `/api/panel/` 门禁） |
| **`FRONTEND-INVENTORY.md`（本文件）** | **现有代码已做 / 没做 / 偏离设计的地方** |

---

文档路径：`/Users/zhuqingyu/project/mcp-team-hub/packages/renderer/FRONTEND-INVENTORY.md`
