# comm/router.ts — W2-C

> 通信管道的核心路由。吃 `MessageEnvelope`，同步落库 → emit 老事件 → 三叉投递。

## 一句话

`CommRouter.dispatch(env)` 把一条 envelope 同步写进 `messages` 表，emit `comm.message_sent`，然后按地址路由到 system handler / driver dispatcher / socket 三选一；offline 就落库等 `replay()`。

## 接口

```ts
new CommRouter({
  registry:          CommRegistry,        // 在线 socket 表
  messageStore:      MessageStore,        // W1-C 出产 DAO（同步落库）
  eventBus?:         EventBus,            // 注入即 emit；不注入则静默
  driverDispatcher?: DriverDispatcher,    // W2-E 签名冻结 (id, text) => Result
});

router.dispatch(env: MessageEnvelope): Promise<DispatchOutcome>;
router.replay(address: string): number;
router.setSystemHandler(fn | null): void;
```

`DispatchOutcome` 五分支：`system` / `local-online` / `local-offline` / `remote-unsupported` / `dropped`。

`driverDispatcher` 收到的 `text` 语义是 **notifyLine**：`@<displayName>><summary>  [msg_id=<id>]`（正则 `^@[^>]+>.+ {2}\[msg_id=msg_[A-Za-z0-9_-]+\]$`）。拼装在 router 内完成，dispatcher 原样透传给 driver.prompt。

## 时序图

### dispatch 成功路径（driver 在线）

```
caller            router          store       bus         dispatcher       driver
  │                 │               │           │              │              │
  │ dispatch(env)  ─▶ parseAddress │           │              │              │
  │                 │   (local/agent)│          │              │              │
  │                 ├── insert(env)─▶           │              │              │
  │                 │◀── dbId ──────┤           │              │              │
  │                 ├── emit('comm.message_sent')─▶            │              │
  │                 ├── dispatcher(id, notifyLine)─────────────▶ prompt(text) ─▶
  │                 │◀── 'delivered' ────────────────────────── │              │
  │                 ├── emit('comm.message_received', route='driver')─▶       │
  │ ◀── {route:'local-online'} ─────                                           │
```

### dispatch offline 路径

```
caller     router          store       bus         dispatcher / socket
  │          │               │           │              │
  │ dispatch ├── insert ────▶            │              │
  │          ├── emit sent ─────────────▶             │
  │          ├── dispatcher(id, …) ─────────────────▶ 'not-found' | 'not-ready'
  │          ├── registry.getConnection(addr) → null
  │ ◀── {route:'local-offline', stored:true}
```

### dispatch dropped / remote

```
caller     router
  │          │
  │ dispatch ├── parseAddress → throw / scope!='local'
  │          │  （不 insert / 不 emit）
  │ ◀── {route:'dropped'} | {route:'remote-unsupported'}
```

### replay（成员上线回灌）

```
caller    router          store                     dispatcher   socket
  │          │               │                         │          │
  │ replay   ├── findUnreadFor(id) ─▶                  │          │
  │          │◀── MessageEnvelope[] ──                 │          │
  │          ├── (for each) dispatcher(…, notifyLine)  │          │
  │          ├── conn?.write(legacyMessage)                       │
  │          ├── store.markRead(env.id)                           │
  │          ├── emit received route='replay'                     │
  │ ◀── delivered count
```

## 竞态分析

| 场景 | 风险 | 处理 |
|---|---|---|
| agent 下一轮立刻 `read_message(msg_id)` | subscriber 异步落库 → DB 还没行 → 404 | **router 内同步 `store.insert`**（I-08 / I-17） |
| 同 envelope 并发 dispatch（理论不出现） | 两条 DB 行 | `store.insert` 幂等：`envelope_uuid` UNIQUE，第二次返回既有 dbId（见 message-store U-31） |
| dispatcher 抛错 | 外部异常冒泡污染 bus | `try/catch` 吞；继续走 socket 兜底（U-78 "dispatcher throw → socket"） |
| system handler 抛错 | 同上 | 同上，吞到 console.warn |
| replay 中途 conn.write 抛错 | 漏一部分 | `break`，剩余下次 replay 继续投递（未 markRead 的仍在 `findUnreadFor`） |
| bus subscriber 同步抛错 | emit 点崩 | EventBus.emit 本身 try/catch（events.ts:50） |

## 错误传播路径

| 层 | 异常 | router 处理 | 对外 outcome |
|---|---|---|---|
| parseAddress | 地址非法 | catch | `{route:'dropped', reason}` |
| parseAddress.scope!='local' | remote 场景 | warn | `{route:'remote-unsupported'}` |
| store.insert | FK / NOT NULL 违约（数据脏） | 不 catch → 冒泡 | 抛给 caller；caller 需要判断是数据层错 |
| dispatcher throw | driver 崩溃 | catch + warn | 继续试 socket |
| conn.write throw | socket 断 | 不 catch（罕见） | 冒泡；replay 中是 `break` |
| systemHandler throw | 业务 bug | catch + warn | 无影响，仍返回 `{route:'system'}` |

**设计选择**：`store.insert` 不 catch——落库失败属于数据层 invariant 破坏，不该被 router 掩盖。上层 caller（W2-I HTTP handler / W2-D send_msg tool）应捕 500 返前端。

## 与 W2-G 的关系

W2-G（message-persister subscriber）已取消。持久化单入口在 router 同步完成。

## 与老 `offline.ts` 的关系

`offline.store` 调用点已从 router 删除（落库并入 `messageStore.insert`）。
`offline.replayFor` / `offline.markDelivered` 作为老路径 shim 保留，但 router.replay 改走 `messageStore`。
shim 彻底删除条件：W3 回归全绿后的下一个 PR（见 W2-F）。

## 不做的事

- 不反向 import `agent-driver/` — dispatcher 通过 deps 注入，签名冻结。
- 不 import `member-agent/format-message` — `formatNotifyLine` 在 `router-helpers.ts` 内自持一份，避免展示层被路由层拉进依赖图。
- 不新增 bus 事件 — `comm.message_sent` / `comm.message_received` payload 冻结（W2-H 守门）。
- 不在 dispatch 里查 registry/DB 填 envelope.from.displayName —— 这是 W1-B envelope-builder 的工作，router 只消费现成 envelope。

## 对应测试

`src/__tests__/comm-router.test.ts`：U-70 ~ U-79 + replay 一条。

## 行数

router.ts ≤ 180 行（硬约束）；router-helpers.ts 独立放 notifyLine / legacy message 拼装。
