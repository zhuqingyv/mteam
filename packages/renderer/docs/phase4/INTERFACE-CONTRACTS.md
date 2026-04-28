# Phase 4 INTERFACE-CONTRACTS — 接口契约冻结

> 冻结版本：v1.0（2026-04-28）
> 本文档是 Phase 4 所有模块间契约的**单一权威源**。
> 任何 Sprint 里的 TASK / 胶水层如果发现签名对不上，**优先改模块对齐本文档**，而不是改本文档。
> 真的需要改本文档：在本文档顶部加一条 `## 修订注` 段落，写修订日期 + 原因 + 影响的 TASK ID，并通知 team-lead。

---

## 1. 术语

- **instanceId**（又称 driverId）：一个 agent 实例的唯一 id。主 Agent 也是一个 instance。
- **peerId**：聊天对话的"对方"id。可以是 `"user"` / 另一个 instanceId。
- **bucket**：messageStore 按 instanceId 分桶的单个桶，结构 `{ messages, pendingPrompts }`。

---

## 2. 数据类型（共享类型）

定义在 `src/store/messageStore.ts` 顶部或 `src/types/chat.ts`（新建，建议后者，所有 Phase 4 共享类型集中）：

```ts
// --- 消息单元（沿用现有 Message 定义，新增 peerId/kind） ---

export type MessageRole = 'user' | 'agent';
export type MessageKind = 'chat' | 'turn' | 'comm-in' | 'comm-out';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  time: string;                  // 显示用，格式 'HH:MM'
  ts?: string;                   // 真实 ISO 时间戳，用于排序和未读判定
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
  turnId?: string;
  blocks?: TurnBlock[];
  streaming?: boolean;
  // Phase 4 新增：
  peerId?: string;               // 归属 peer；user=="user"；agent 间 = 对方 instanceId
  kind?: MessageKind;            // 'turn' = 自己 agent 的 turn 输出；'comm-in/out' = agent 间通信
}

// --- 桶 ---

export interface InstanceBucket {
  messages: Message[];
  pendingPrompts: string[];      // user 对该 instance 的排队文本
}

// --- peer 描述 ---

export type PeerRole = 'user' | 'leader' | 'member';

export interface ChatPeer {
  id: string;                    // 'user' 或 instanceId
  name: string;
  avatar?: string;
  role: PeerRole;
  lastMessage?: string;
  lastTime?: string;
  unread?: number;
}

// --- 节点数据 ---

export interface CanvasNodeData {
  id: string;                    // instanceId
  name: string;
  status: 'idle' | 'thinking' | 'responding' | 'offline';
  cliType?: string;
  isLeader: boolean;
  x: number;
  y: number;
  taskCount: number;
  unreadCount: number;           // 所有 peer 未读之和
  messageCount: number;
}

// --- 活跃边 ---

export interface ActiveEdge {
  fromId: string;
  toId: string;
  intensity: number;             // 0..1
  lastActiveTs: number;          // epoch ms
}
```

---

## 3. messageStore（Sprint 1）

### 3.1 状态结构

```ts
interface MessageState {
  byInstance: Record<string, InstanceBucket>;

  // --- bucketed actions ---
  addMessageFor: (iid: string, m: Message) => void;
  replaceMessageFor: (iid: string, id: string, m: Message) => void;
  setMessagesFor: (iid: string, list: Message[]) => void;
  clearFor: (iid: string) => void;
  updateTurnBlockFor: (iid: string, turnId: string, block: TurnBlock) => void;
  removeTurnBlocksByTypeFor: (iid: string, turnId: string, type: TurnBlock['type']) => void;
  completeTurnFor: (iid: string, turnId: string) => void;
  enqueuePromptFor: (iid: string, text: string) => void;
  dequeuePromptFor: (iid: string) => string | undefined;
  clearPendingFor: (iid: string) => void;

  // --- peer 维度（S4 补） ---
  markPeerRead: (iid: string, peerId: string) => void;

  // --- deprecated 兼容层（S1 保留，S6 可清理） ---
  /** @deprecated 用 addMessageFor */
  addMessage: (m: Message) => void;
  // 其它顶层 action 同理：全部代理到 byInstance[PRIMARY] 桶
}
```

### 3.2 Selectors

```ts
export const selectBucketFor = (s: MessageState, iid: string): InstanceBucket =>
  s.byInstance[iid] ?? { messages: [], pendingPrompts: [] };

export const selectMessagesFor = (s: MessageState, iid: string): Message[] =>
  selectBucketFor(s, iid).messages;

export const selectPendingFor = (s: MessageState, iid: string): string[] =>
  selectBucketFor(s, iid).pendingPrompts;

/** 兼容层：回退到主 Agent 桶（当主 Agent iid 已知时） */
export const selectPrimaryMessages = (s: MessageState, primaryIid: string | null): Message[] =>
  primaryIid ? selectMessagesFor(s, primaryIid) : [];
```

### 3.3 不变量

- 任意桶的 `messages.length <= 1000`（MAX_MESSAGES）
- 同一 turnId 只能出现在它 driverId 对应的桶里
- `pendingPrompts` 不跨桶共享
- 桶不存在时 selector 必须返回 `{messages: [], pendingPrompts: []}` 而非 undefined
- `addMessageFor` 对不存在桶自动创建

---

## 4. promptDispatcher（Sprint 1）

### 4.1 函数签名

```ts
/** 当前 iid 是否正处于 streaming 中（有 streaming=true && turnId 的 agent 消息） */
export function isTurnStreaming(iid: string): boolean;

/** 立即派发 prompt 到指定 instance；本地插 pending 气泡；user echo 由调用方负责 */
export function dispatchPromptNow(text: string, iid: string): void;

/**
 * 用户输入发送。先 user echo。
 * - iid 省略：fallback 到 primary agent iid。
 * - 该 iid 正在 streaming → 入对应桶队列。
 * - 否则 → 立即 dispatchPromptNow。
 */
export function sendUserPrompt(text: string, iid?: string): void;

/** 对指定 iid flush 一条排队消息（turn.completed / turn.error 触发） */
export function flushNextPending(iid: string): void;

/** 取消指定 iid 当前 turn；清该 iid 队列；不影响其它 iid */
export function cancelCurrentTurn(iid?: string): void;
```

### 4.2 口径锚点

- 队列判定"真正 streaming"：`selectMessagesFor(state, iid)` 中存在 `role==='agent' && streaming && !!turnId` 的消息
- `dispatchPromptNow` 内部 WS 调用：`client.prompt(iid, text, requestId)`（`requestId = 'req-' + Date.now()`）
- `cancelCurrentTurn` 内部 WS 调用：`client.cancelTurn(iid, 'cancel-' + Date.now())`
- **绝对不能**使用全局"最近活跃 iid"之类隐式状态；所有 iid 必须显式传

---

## 5. 组件 props（Sprint 2）

### 5.1 CanvasNode（molecules）

```ts
// 收起态
export interface CanvasNodeProps {
  id: string;                      // instanceId
  name: string;
  status: 'idle' | 'thinking' | 'responding' | 'offline';
  cliType?: string;
  taskCount?: number;              // 默认 0
  unreadCount?: number;            // 默认 0；>0 显示红点 + 数字
  messageCount?: number;           // 默认 0
  x?: number;                      // 画布坐标
  y?: number;
  onOpen?: (id: string) => void;   // 单击非拖拽 → 展开
  onDragEnd?: (x: number, y: number) => void;
  getZoom?: () => number;
  elementRef?: (el: HTMLDivElement | null) => void;
}

// 展开态骨架（S2-M2）
export interface CanvasNodeExpandedProps {
  id: string;
  name: string;
  status: 'idle' | 'thinking' | 'responding' | 'offline';
  onMinimize?: () => void;
  onClose?: () => void;
  onDragHeader?: (dx: number, dy: number) => void;  // 顶栏拖动增量
  children?: ReactNode;           // 主区内容（S4 填 ChatList+InstanceChatPanel）
}
```

- 宽高冻结：**420 × 540**（pm PRD 提过 560，此处按 UX 小节锁死 540，不再议）
- z-index 由外层应用 `resolveNodeZ`（见 §7）
- fixed 定位由 S5-G1 做，不在组件内部硬写

### 5.2 InstanceChatPanel（organisms）

```ts
export interface InstanceChatPanelProps {
  instanceId: string;
  peerId: string;                  // 'user' 或对方 instanceId
  peerName: string;
  messages: Message[];             // 已经按 peer 过滤好的列表（selector 责任）
  streaming?: boolean;
  inputValue?: string;
  onInputChange?: (v: string) => void;
  onSend?: () => void;             // 外部决定走 ws.prompt 还是 comm API
  onStop?: () => void;             // streaming 时显示停止（注意：props 名是 onStop，不是 onCancel）
  headerSlot?: ReactNode;          // 自定义头部；CanvasNodeExpanded 里用不到（顶栏在外层）
  emptyHint?: string;              // 空列表提示
  disabled?: boolean;              // 禁用输入（driver not_ready / 其它）
}
```

- 内部**不订 WS**；**不读 store**；全 props 驱动
- 复用 `organisms/ChatPanel`，`agents=[]` 场景（主 Agent / 单对话）

### 5.3 ChatList（molecules）

```ts
export interface ChatListProps {
  items: ChatPeer[];
  activeId?: string;
  onSelect?: (id: string) => void;
  collapsed?: boolean;             // 收起态：只显示头像栏（S5 sidebar 联动）
}
```

- CSS 唯一滚动条白名单位置：`.chat-list__items { overflow-y: auto }`
- 按 `lastTime` desc 或外部已排序传入（组件内部不重排）

### 5.4 CanvasTopBar（molecules）

```ts
export interface CanvasTopBarProps {
  teamName: string;
  memberCount: number;
  zoomPercent: number;             // 0-300
  onZoomMenu?: () => void;         // 弹 50/75/100/150/200/适应画布 菜单（菜单由外层控制）
  onFit?: () => void;              // 直接适应画布
  onNewMember?: () => void;
  onSettings?: () => void;
  onClose?: () => void;
}
```

### 5.5 ZoomControl（molecules）

```ts
export interface ZoomControlProps {
  zoom: number;                    // 0.25 ~ 3
  onZoomIn?: () => void;           // 步进 +0.1，clamp
  onZoomOut?: () => void;
  onReset?: () => void;            // 双击中间百分比
}
```

### 5.6 MiniMap（molecules，P1）

```ts
export interface MiniMapProps {
  nodes: Array<{ id: string; x: number; y: number }>;
  viewport: { x: number; y: number; w: number; h: number };   // 画布坐标系
  canvasSize: { w: number; h: number };                        // 实际 viewport 尺寸
  onJump?: (cx: number, cy: number) => void;                  // 画布坐标系中心
}
```

- 固定尺寸 160 × 100
- 纯绘制 + 点击事件；不 touch store

---

## 6. hooks（Sprint 1 + 3 + 5 + 6）

### 6.1 useInstanceSubscriptions（S1-M3）

```ts
/**
 * 声明式管理 WS instance scope 订阅集合。
 * - 输入的 instanceIds 数组变化时做 diff：新增 subscribe，消失 unsubscribe
 * - 变化频繁时 120ms debounce
 * - unmount 自动全部 unsubscribe
 * - client 为 null 时 no-op（不抛错）
 */
export function useInstanceSubscriptions(
  instanceIds: string[],
  client: WsClient | null,
): void;
```

### 6.2 useInstancePanel（S3-G2）

```ts
/**
 * 单个 InstanceChatPanel 的登记/注销 + 初始数据拉取。
 * 返回 subscription control，供容器调 addInstanceSub/removeInstanceSub。
 */
export function useInstancePanel(instanceId: string): {
  isReady: boolean;          // snapshot/history 至少拉过一次
};
```

内部：
- 挂载：调全局 `addInstanceSub(instanceId)` + `ws.get_turns(instanceId, 20)` + `ws.get_turn_history(instanceId, {limit:20})`
- 卸载：`removeInstanceSub(instanceId)`
- `addInstanceSub / removeInstanceSub` 由 S1-G2 在 `useWsEvents` 里 export

### 6.3 useCanvasNodes（S4-M3）

```ts
export function useCanvasNodes(teamId: string | null): CanvasNodeData[];
```

### 6.4 useCanvasControls（S4-M4）

```ts
export function useCanvasControls(transformApi: {
  getTransform: () => Transform;
  setTransform: (t: Transform) => void;
}): {
  zoom: number;
  zoomPercent: number;
  setZoom: (z: number) => void;
  resetZoom: () => void;
  fitAll: (nodes: Array<{ x: number; y: number; w: number; h: number }>) => void;
};
```

> 内部实现：`setZoom(z) = setTransform({ ...getTransform(), zoom: z })`，不修改 `useCanvasTransform`。

### 6.5 useCanvasHotkeys（S5-M4）

```ts
export function useCanvasHotkeys(handlers: {
  onEscape?: () => void;     // Esc → 关最上层展开节点
  onFit?: () => void;        // f
  onResetZoom?: () => void;  // 0
}): void;
```

---

## 7. 常量（Sprint 5）

```ts
// src/utils/zIndex.ts
export const Z = {
  CANVAS_FX: 1,                 // 触手 canvas 层
  VIEWPORT: 2,                  // 节点默认
  NODE_DRAGGING: 10,
  NODE_EXPANDED: 20,
  NODE_EXPANDED_FOCUSED: 30,
  TOP_UI: 40,                   // CanvasTopBar / ZoomControl / MiniMap
} as const;

export function resolveNodeZ(s: {
  dragging?: boolean;
  expanded?: boolean;
  focused?: boolean;
}): number;
```

---

## 8. 扩展：teamStore.canvasStates

Phase 4 **不扩**结构字段，沿用现有：

```ts
export interface CanvasState {
  pan: { x: number; y: number };
  zoom: number;
  nodePositions: Record<string, { x: number; y: number }>;
}
```

新增 action（如需，S4-M3 范围）：

```ts
// 仅在布局算法用到；不暴露给 UI 直接写
setInitialLayout: (teamId: string, positions: Record<string, {x:number; y:number}>) => void;
```

---

## 9. 数据来源矩阵（冻结）

| 字段 | 来源 | 说明 |
|---|---|---|
| `CanvasNodeData.status` | `agentStore.agents[i].status` | 已有 |
| `CanvasNodeData.taskCount` | `taskStore.tasks[instanceId]?.length ?? 0` | 新增 taskStore 入桶口径（若 store 缺则 0） |
| `CanvasNodeData.unreadCount` | `selectUnreadMap(state, iid)` 值求和 | 实时 |
| `CanvasNodeData.messageCount` | `selectMessagesFor(state, iid).length` | 实时 |
| `CanvasNodeData.x/y` | `teamStore.canvasStates[teamId].nodePositions[iid]` | 落盘 |
| `ChatPeer[] (展开态左栏)` | `selectPeersFor(state, iid, teamId, currentUserName)` | 纯函数 |
| 单 peer 消息流 | `selectMessagesForPeer(state, iid, peerId)` | 纯函数 |
| `ActiveEdge[]` | `selectActiveEdges(state, now)` | selector + RAF 刷新 |

---

## 10. 发送 / 接收路径（冻结）

### 10.1 用户 → 某 instance（peer = 'user'）

```
InstanceChatPanel.onSend
  → sendUserPrompt(text, instanceId)
  → dispatchPromptNow → ws.prompt({instanceId, text, requestId})
后端 → driver.prompt → turn.* 事件 → subscribed instance scope → handleTurnEvent
  → addMessageFor(instanceId, ...)（kind='turn', peerId='user'）
```

### 10.2 instance A → instance B（peer = 对方 instanceId）

```
展开节点 A 选中 peer=B
InstanceChatPanel.onSend
  → sendAgentMessage(toInstanceId=B, text)
  → POST /api/panel/messages
       body = {
         to:      { address: 'local:<B>', kind: 'agent' },
         content: text,
         kind:    'chat',
       }
后端 → CommRouter → comm.message_sent 事件
订阅 instance B → subscribers 分桶写到 byInstance[A]（outbound）和 byInstance[B]（inbound）
前端 handleCommEvent（新）：
  - 给 from 桶写 kind='comm-out' peerId=to
  - 给 to 桶写 kind='comm-in' peerId=from
```

**sendAgentMessage 函数签名**：

```ts
/**
 * 发送消息给另一个 instance（agent 间 chat）。
 * from 由后端强制注入为 user:local —— 前端无法指定发送者身份，任何 body.from 都会被后端忽略。
 * 因此"当前在哪个节点打字"是 UI 语义，不等于 envelope.from。
 */
export function sendAgentMessage(toInstanceId: string, text: string): Promise<{ messageId: string; route: string }>;
// 实际实现：POST /api/panel/messages，body = { to: { address: `local:${toInstanceId}`, kind: 'agent' }, content: text, kind: 'chat' }
```

**comm.message_sent envelope 的 from/to 结构**：

- `from` / `to` 是 `ActorRef`，形如 `{ kind: 'user'|'agent'|'system', address: 'user:<uid>'|'local:<instanceId>'|'local:system', displayName, instanceId?: string|null, memberName?: string|null, origin?: 'local'|'remote' }`
- **peer 提取口径**（订阅层分桶/归属判断时统一走这里）：

```ts
function extractPeerId(actor: ActorRef): string {
  if (actor.kind === 'user') return 'user';                         // user 侧一律归到 peerId='user'
  return actor.instanceId ?? parseAddress(actor.address).id;        // agent 侧优先 instanceId，否则从 address 解析
}
```

- 分桶与 peer 归属：
  - A→B 的 envelope：`byInstance[A]` 写 `kind='comm-out'`、`peerId = extractPeerId(envelope.to)`
  - 同一条 envelope 在 B 侧：`byInstance[B]` 写 `kind='comm-in'`、`peerId = extractPeerId(envelope.from)`
  - user→A 的 envelope（10.1 非 WS 路径场景）：`byInstance[A]` 写 `peerId='user'`

### 10.3 未读算法

- 消息进入桶时默认 `read=false`
- 当前展开的 peer 的消息 → `markPeerRead(iid, peerId)` 把该 peer 所有消息的 `read` 置 true
- `unreadCount` = 统计 `read !== true` 且 `peerId === targetPeerId` 的消息条数

**markPeerRead 时序（权威）**：

1. 用户在节点 A 的 ChatList 选中 peer=P（即切换 activePeer），立刻对 `(A, P)` 调 `markPeerRead`，把已在桶里的历史未读全部置 read。
2. 收起/关闭节点 A 的展开态，或切到别的 peer，要重置 `activePeerId`，此后到达 `(A, P)` 的新消息不再自动标 read。
3. **在 `(instanceId, peerId)` 当前处于展开且活跃态时，新消息入桶即标 `read=true`**（订阅层 addMessageFor 前检查 activePeerId，命中则直接写 read）。

> **activePeerId 是 session-only 状态**：只活在前端内存里，不落盘、不跨窗口同步；关闭窗口 / 刷新 / 进程重启后全部重置为空，不会恢复上次的活跃 peer。

---

## 11. 命名对齐（避免漂移）

| 别名 | 权威名 | 说明 |
|---|---|---|
| driverId / agentId / memberId | **instanceId** | 统一（API 文档里 get_turns 参数叫 driverId 是历史兼容，我们对外一律叫 instanceId，只在调 ws.getTurns 那一行写 `driverId: instanceId`） |
| AgentNode / CanvasCard / ChatNode | **CanvasNode** | pm PRD 叫 AgentNode，本 Phase 冻结 CanvasNode |
| peerChat / privateChat / dm | **peer chat** | 展开态左栏列的对话对象 |
| TopBar / Toolbar | **CanvasTopBar**（画布上方）/ **ToolBar**（输入框上方的模型选择，已有） | 保持两者区分，不要合并命名 |

---

## 12. 变更流程

1. 开 Sprint 前：所有参与者读本文档对应节
2. 发现签名和需求对不上：
   - 优先改模块对齐本文档
   - 真要改本文档：本文档顶部加 `## 修订注` 段落 + 通知 team-lead + 相关任务重新评估复杂度
3. 每个 Sprint 结束：team-lead 审视本文档是否还准；不准就同步更新

---

## 13. 附：与现有实现的 diff 清单

| 现有文件 | 现状 | Phase 4 后 |
|---|---|---|
| `store/messageStore.ts` | 顶层 `messages: Message[]` + 顶层 pendingPrompts | `byInstance: Record<iid, Bucket>` + 顶层兼容代理（deprecated） |
| `hooks/promptDispatcher.ts` | 所有函数从 `primaryAgentStore` 取 iid | 所有函数接 `iid?: string` 参数（默认 primary fallback） |
| `hooks/handleTurnEvent.ts` | `did !== pa.instanceId` 早退 | 按 `did` 分桶写入，不过滤 |
| `hooks/useWsEvents.ts` | `syncInstanceSub` 单 instance | 改用 `useInstanceSubscriptions` + export `addInstanceSub/removeInstanceSub` |
| `organisms/TeamCanvas/TeamCanvas.tsx` | 渲染 AgentCard | 渲染 CanvasNode |
| `molecules/AgentCard/*` | 展开态是空 CapsuleCard | 从 TeamCanvas unmount；Sprint 6 删除 |
| `templates/PanelWindow/PanelWindow.css` | `overflow: auto` | `overflow: hidden` |
| `organisms/TeamMonitorPanel/*` | 右上角 `__close` 浮层 | 移除，close 进 CanvasTopBar |
| `pages/TeamPage.tsx` | 直接 Esc→window.close | Esc 先关展开节点栈，栈空才 close |
