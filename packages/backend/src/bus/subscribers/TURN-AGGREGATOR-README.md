# turn-aggregator.subscriber —— driver.* → Turn 聚合

业务胶水订阅者。把 AgentDriver 层的零散事件聚合成一轮完整对话（Turn），
产出 `turn.*` 事件供 ws-broadcaster 推送前端、供 HTTP 快照接口（T-10）查询。

> 权威设计：`docs/phase-ws/turn-aggregator-design.md` §4
> 存储层：`turn-store.ts`（纯数据结构，零 bus 依赖）
> 类型：`packages/backend/src/agent-driver/turn-types.ts`

---

## 1. 职责

- **订阅** bus 上 12 种 driver.* 事件（turn_start / turn_done / thinking / text /
  tool_call / tool_update / plan / usage / commands / mode / config /
  session_info）+ `driver.error` + `driver.stopped`。
- **维护** 每个 driverId 一个 active Turn（内存 Map）+ 最近 N（默认 50）条历史（环形）。
- **产出** `turn.started` / `turn.block_updated` / `turn.completed` / `turn.error`。
- **暴露** `TurnAggregator` 接口（`getActive` / `getRecent`）给 T-10 HTTP 调。

**不**落库。Hub 进程重启即丢失（§4.6 已定边界）。跨设备 / 跨进程历史属
MILESTONE §5.5 方案 Y，本期不做。

---

## 2. 时序图（典型 Turn · happy path）

```
 driver.ts               bus                          turn-aggregator             其他订阅者
                                                      (+ turn-store)             (ws-broadcaster)

  prompt(text)
     │
     │ emit driver.turn_start(turnId, userInput)
     ├────────────────────►  dispatch ─────────────► onTurnStart
     │                                                │  store.openTurn → active[driverId]
     │                                                │  emit turn.started ─────────────► WS send
     │
     │ (ACP sessionUpdate ×N)
     │   agent_thought_chunk → driver.thinking
     │   agent_message_chunk → driver.text
     │   tool_call           → driver.tool_call
     │   tool_call_update    → driver.tool_update
     │   plan / usage / mode / ...
     │
     │ emit driver.text(messageId, content)
     ├────────────────────►  dispatch ─────────────► onTextLike
     │                                                │  store.upsert(blockId=messageId)
     │                                                │    ├─ new → seq=N++, push
     │                                                │    └─ exists → replace, keep seq
     │                                                │  emit turn.block_updated ──────► WS send
     │ (... 重复 N 次 ...)
     │
     │ (session/prompt 响应返回)
     │ emit driver.turn_done(turnId, stopReason, usage?)
     ├────────────────────►  dispatch ─────────────► onTurnDone
     │                                                │  turn.stopReason = e.stopReason ?? end_turn
     │                                                │  turn.usage      = e.usage
     │                                                │  finish(done)
     │                                                │    ├─ streaming blocks → done
     │                                                │    ├─ active.delete
     │                                                │    └─ history.unshift(turn) [cap=50]
     │                                                │  emit turn.completed(turn) ─────► WS send
```

### 异常路径（driver.error / driver.stopped 强制关闭）

```
     │ emit driver.error(driverId, message)
     ├────────────────────►  dispatch ─────────────► onDriverError / onDriverStopped
     │                                                │  if !peekActive → 静默
     │                                                │  store.closeActiveAsCrashed('crashed')
     │                                                │  finish(error)
     │                                                │    ├─ streaming blocks → done
     │                                                │    ├─ turn.status = error
     │                                                │    ├─ turn.stopReason = 'crashed'
     │                                                │    └─ history.unshift
     │                                                │  emit turn.completed(turn status=error)
     │                                                │  emit turn.error(message)
```

### 竞态保护：新 turn_start 碰上未关闭 active

```
     │ emit driver.turn_start(turnId=t2)                        (active=t1 还在)
     ├────────────────────►  onTurnStart(e)
     │                           │  if peekActive →
     │                           │     closeActiveAsCrashed  (t1.status=error, stopReason=crashed)
     │                           │     finish(error)  → emit turn.completed(t1) + turn.error('replaced by new turn_start')
     │                           │  store.openTurn(t2)
     │                           │  emit turn.started(t2)
```

---

## 3. 事件 → Block 映射表

| 输入事件 | blockId 规则 | block.type | block.scope | status 初始 | 合并语义 |
|---------|------------|-----------|-------------|-----------|---------|
| `driver.thinking` | `messageId` 或 `thinking-{turnId}` | `thinking` | turn | streaming | content 替换 |
| `driver.text` | `messageId` 或 `text-{turnId}` | `text` | turn | streaming | content 替换 |
| `driver.tool_call` | `toolCallId` | `tool_call` | turn | streaming | 初次创建；保留 prev.output/kind/locations/content（若已有） |
| `driver.tool_update` | `toolCallId` | `tool_call` | turn | streaming / done | toolStatus ∈ {completed, failed} → block.status=done；其他字段叠加覆盖 |
| `driver.plan` | `plan-{turnId}` | `plan` | turn | streaming | entries 全量替换 |
| `driver.usage` | `usage-{turnId}` | `usage` | turn | done | used/size/cost 替换 |
| `driver.commands` | `commands` | `commands` | session | done | commands 全量替换 |
| `driver.mode` | `mode` | `mode` | session | done | currentModeId 替换 |
| `driver.config` | `config` | `config` | session | done | options 全量替换 |
| `driver.session_info` | `session_info` | `session_info` | session | done | title/updatedAt 按出现字段覆盖 |

**seq 语义**（reviewer G + P3）：
- 每 turn 从 0 重开；block 首次插入时 `seq = nextSeq++`，此后更新 **不变**。
- 前端按 seq 固定位置，content / toolStatus / output 原地更新不重排。

**无 active Turn 时的 block 事件**：直接丢弃（store.upsert 返回 null），
不 emit `turn.block_updated`。语义：driver 还没 prompt / 已 turn_done，无处挂靠。

---

## 4. Turn 边界判定（双保险）

**开**：`driver.turn_start { turnId, userInput }` → 新建 Turn(status=active)。
若已存在未关的 active Turn → 先以 `crashed` 强制结算旧 Turn（emit turn.completed + turn.error），
再开新 Turn。防止 driver 异常未 turn_done 时的内存悬挂。

**关（正常）**：`driver.turn_done { turnId, stopReason, usage? }` → finish(done)。
- `turnId` 不匹配 active.turnId → 忽略（老事件漂移）。
- `stopReason` 缺省退化 'end_turn'（过渡期 driver 可能不填）。

**关（异常）**：
- `driver.error { message }` → 有 active 则 finish(error)，以 message 写入 turn.error。
- `driver.stopped` → 有 active 则 finish(error)，message='driver stopped'（正常流程应先
  turn_done 再 stopped，有 active 说明异常）。
- 无 active 时两者都静默 noop。

---

## 5. 历史保留策略

- `history[driverId]`：`Turn[]`，最新优先（unshift），容量上限 `historyPerDriver`（默认 50）。
- 超出容量 → 丢最旧（数组从尾部截断）。
- `driver.stopped` 不清 history —— 只关 active；driver 重启后仍可读到历史。
- 进程重启 → 全部丢失（§4.6）。

---

## 6. 竞态分析

1. **RxJS 同步分发**：`EventBus.emit` → `subject.next`，subscriber 在同步栈内运行。
   聚合器内部不调异步，所有 handler 完整执行完才返回调用栈；因此 `store.upsert`
   / `openTurn` / `finish` 不会在 handler 间交错。
2. **同一 driverId 连发事件**：按 emit 顺序串行处理，seq 分配严格单调。
3. **跨 driverId 事件**：各 driver 独立 key；互不污染。
4. **subscriber handler 抛错**：外层 `wrap` try-catch 吞掉 → stderr 日志；
   `EventBus.emit` 自带外层 try-catch 再保险一次。单条事件失败**不阻塞**同事件的
   其他订阅者 / 下一条事件。
5. **turn_done 后的迟到 block 事件**：active 已 delete → store.upsert 返回 null → 丢弃。
6. **turn_start 重复触发**：先 finish(error) 旧的、再 open 新的；旧 Turn 正常入 history。

---

## 7. 错误传播路径

| 发生位置 | 表现 | subscriber 处理 | 最终状态 |
|---------|------|----------------|---------|
| build block 回调抛错 | upsert 内合成 block 出错 | wrap try-catch 吞掉 → stderr | 不 emit turn.block_updated；active Turn 不变 |
| `eventBus.emit` 抛错 | 极少见（EventBus 内部已 try-catch） | wrap 再兜底 | 单条事件丢失，不冒泡 |
| handler 内读 `e` 字段缺失 | `undefined` 访问 | wrap 兜底 | 该事件静默跳过，其他事件继续 |
| store.upsert 内部抛错 | 几乎不可能（纯 Map/数组操作） | wrap 兜底 | 静默 |

**fail-open 是有意选择**：聚合器挂掉不应拖挂整条 bus。丢一条 block_updated 前端
可以靠下一条 block_updated 的完整状态自愈（设计 §4.4：block 推完整最新状态，不推 delta）。

---

## 8. 接口签名

```ts
import type { Turn } from '../../agent-driver/turn-types.js';
import type { EventBus } from '../events.js';
import type { Subscription } from 'rxjs';

export interface TurnAggregator {
  getActive(driverId: string): Turn | null;
  getRecent(driverId: string, limit: number): Turn[];
}

export function subscribeTurnAggregator(
  eventBus?: EventBus,                    // 默认 defaultBus
  opts?: { historyPerDriver?: number },   // 默认 50
): { aggregator: TurnAggregator; subscription: Subscription };
```

**bootSubscribers 使用**：

```ts
const { aggregator, subscription } = subscribeTurnAggregator(eventBus);
masterSub.add(subscription);
// HTTP 接口（T-10）从闭包拿 aggregator 注入；不走全局单例，避免多实例污染。
```

---

## 9. 已定边界（reviewer 审查后固化）

- **不持久化**：Hub 重启丢失。跨进程 / 跨设备历史留给 MILESTONE §5.5 方案 Y。
- **block 推完整状态**：不推 delta。前端按 blockId 替换；下一条自愈。
- **session-scoped block 有静态 blockId**：同一 session 只存一份，turn_start 不重置。
  当前实现放在 `Turn.blocks` 内；跨 turn 不复制（重置 nextSeq=0 时按 turnId 生命周期）。
- **driver.stopped 不清 history**：history 随 driverId 生存，重启 driver 仍可查。

---

## 10. 与其他订阅者的关系

- `ws.subscriber`（T-11）：订阅 turn.* 四事件（白名单切换后）。白名单切换晚于 T-9
  merge，避免断流（reviewer P2）。
- `log.subscriber`：订阅 driver.* 继续写审计日志（不看 turn.*）。
- `policy.subscriber`：只看 driver.tool_call 做白名单判定，与聚合器并行；
  policy 违规导致的 instance.offline_requested 会经由 roster → driver.stopped → 聚合器强制关闭 Turn。
- `ws/handle-turns.ts`（WS op，取代旧 HTTP T-10）：通过 `WsHandlerDeps.getTurnAggregator`
  延迟注入聚合器，对外暴露 WS op `get_turns` / `get_turn_history`。旧 HTTP 路由
  `/api/panel/driver/*` 已整体下线（主 Agent 对前端只走 WS）。
