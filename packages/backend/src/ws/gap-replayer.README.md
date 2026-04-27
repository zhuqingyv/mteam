# ws/gap-replayer

Phase WS · W1-C。断线 gap 补发纯函数。

## 一句话

吃 `(messageStore, lastMsgId, scope)`，吐 `WsDownstream.gap-replay`，把客户端断线期间错过的 `comm.*` 消息按批返回。不碰 WS 连接、不 emit bus、只读 DB。

## 接口

```typescript
import { buildGapReplay } from './gap-replayer.js';

const result = buildGapReplay(
  { messageStore, maxItems: 200 },
  { lastMsgId: 'msg_1002', sub: { scope: 'team', id: 'team_01' } },
);
// result: { type: 'gap-replay', items: [{ id, event }...], upTo: string | null }
```

## scope × MessageStore 方法映射

| scope          | 走的方法                                     | 过滤逻辑                          |
| -------------- | -------------------------------------------- | --------------------------------- |
| `team:<id>`    | `listTeamHistory(id, limit=budget)`          | 团内全量；再按 `id > lastMsgId` 切 |
| `instance:<id>`| `findUnreadForAddress('local:<id>')`         | 未读 + to_instance_id=id          |
| `user:<id>`    | `findUnreadForAddress('user:<id>')`（W1-D） | 未读 + to_user_id=id              |
| `global`       | —（返回空）                                   | 重连走 HTTP 快照                  |

## 超量 gap 翻页协议（REGRESSION R1-9）

- 单次最多 `maxItems` 条（默认 200）。
- 若实际缺失 > maxItems：**只推最老的 maxItems 条**；`upTo` = 本批最后一条 id（= 已推中最新一条）。
- 前端收到后把新 `lastMsgId = upTo` 再发 `subscribe`，严格拉 id > upTo 的下一批。
- 翻到最后一次：items.length < maxItems 且 `upTo = 最末 id`；再次调用返回 `items=[], upTo=null`。

### 为什么这么设计

TASK-LIST W1-C 的"关于冻结接口不改的妥协"：phase-comm 已冻结的 `MessageStore.listTeamHistory` 只有 `before` 游标（向历史），gap 需要 `after` 方向。本期不改冻结签名，`before=null` 拉最近一批再 `id > lastMsgId` 过滤即可。代价是 budget 有上限，超了靠翻页。arch-ws-b 审查同意。

## lastMsgId=null 的语义

首订阅时不走 gap：返回 `items=[], upTo=null`。**原因**：phase-comm 的 `listTeamHistory` 是游标式，null 视作"无缺"，否则首订阅会把全表灌下去。**前端首屏**自己调 HTTP 拉最近一批即可。

## 非 comm 事件不补（MILESTONE §5.3 / REGRESSION R5-6）

只补 `comm.message_sent`。`team.*` / `instance.*` / `driver.*` 这类状态事件不走 gap — 重连后客户端自行 HTTP 拉快照更新状态。补状态事件成本高、重复推送还会冒竞态风险，不划算。

## 已知妥协

1. **budget 上限 = maxItems\*2+50**：常见场景够用；极端"断线很久、全部未读"时可能拉不全，只能依赖翻页（或前端 HTTP 快照重置 lastMsgId）。
2. **N+1 findById**：team scope 下 `listTeamHistory` 返回 InboxSummary（无 content），再用 `findById` 拿完整 envelope。最多 200 次，PK 索引查询 <1ms/条，接受。
3. **import `ClientSubscription`** 暂未生效：W1-B subscription-manager.ts 交付前，本文件用局部 `GapReplayScope` 等价类型占位；W1-B 合入后把 type 切成 `import type { ClientSubscription } from './subscription-manager.js'` 即可，字段完全对齐。

## 注意事项

- 纯函数 + 显式 DI：不读全局 bus/registry，便于 ws-handler 单测时直接注入 mock。
- scope=`user:<id>` 的越权校验（id !== ctx.userId）**不**在本模块做 — 放在 ws-handler 层。
- 返回 `items` 按 sent_at ASC 排序；前端按此顺序补状态即可，不必再排。
