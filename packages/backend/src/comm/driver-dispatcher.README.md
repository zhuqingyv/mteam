# comm / driver-dispatcher

> **签名冻结 · W2-C 不改此文件**
> `DriverDispatcher` 签名 `(memberInstanceId: string, text: string) => Promise<'delivered'|'not-ready'|'not-found'>` 已在 phase-comm W2-E 冻结（见 `docs/phase-comm/TASK-LIST.md` §W2-E、`docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md`）。
> phase-comm 的 W2-C router 改造里，通知行拼接（`formatNotifyLine(envelope)`）在 router 内完成，调用 dispatcher 时原样作为 `text` 传入。**dispatcher 文件本身 0 代码改动**；任何对签名/返回字面量集合的改动必须先走 `INTERFACE-CONTRACTS.md` 的修订流程。
> 语义备注：**v2 起 `text` 的语义是 notifyLine**，形如 `@<name>>${summary}  [msg_id=msg_xxx]`（由 router 调 `formatNotifyLine` 生成）。dispatcher 不做解析，仅透传。

连接 `CommRouter`（W1-5）与 `DriverRegistry`（W1-1）的**业务胶水**：router 下发本地消息时，先通过 dispatcher 查 registry → 调 `driver.prompt`；命不中或 driver 未就绪则回退到 socket / offline。

## 接口

```typescript
import type { DriverRegistry } from '../agent-driver/registry.js';
import type { DriverDispatcher } from './router.js';

export function createDriverDispatcher(registry: DriverRegistry): DriverDispatcher;
```

`DriverDispatcher` 定义在 `comm/router.ts`（Stage 3 W1-5）：

```typescript
type DriverDispatchResult = 'delivered' | 'not-ready' | 'not-found';
type DriverDispatcher = (memberInstanceId: string, text: string) => Promise<DriverDispatchResult>;
```

权威合约见 `docs/phase-sandbox-acp/stage-3/TASK-LIST.md` §1.2 / §1.3。

## 使用示例

Hub bootstrap 处装配到 `CommServer`：

```typescript
import { driverRegistry } from '../agent-driver/registry.js';
import { createDriverDispatcher } from './driver-dispatcher.js';
import { CommServer } from './server.js';

const dispatcher = createDriverDispatcher(driverRegistry);
const server = new CommServer({ /* ... */ driverDispatcher: dispatcher });
await server.start();
```

Router 内部（已由 W1-5 实现）：

```typescript
// 在线分支优先 dispatcher → 命中返回 'delivered'
// 否则回退 socket → 最后走 offline.store
const r = await driverDispatcher(id, text);
if (r === 'delivered') return { route: 'local-online', address: msg.to };
```

## 时序图

```
leader.send_msg "local:<memberId>"
        │
        ▼
CommRouter.dispatch(msg)
        │ parseAddress scope=local id=<memberId>
        ▼
driverDispatcher(memberId, text)
        │
        ├─ registry.get(memberId) == undefined  ─►  'not-found'  ─► router 试 socket
        │                                                          socket 不通 ─► offline.store
        │
        ├─ driver.isReady() == false            ─►  'not-ready'  ─► router 试 socket / offline
        │
        └─ driver.prompt(text)
                 │
                 ├─ 成功 ─► 'delivered'        ─► route='local-online'（不再试 socket）
                 │            driver 内部 events$ → bus-bridge → 'driver.text' / 'driver.turn_done'
                 │
                 └─ 抛异常 ─► 吞掉 + 'not-ready' ─► router 试 socket / offline
```

## 竞态分析

- **D1 · prompt 执行期间 driver 被 stop**：`AgentDriver.prompt()` 在非 READY 状态抛错；dispatcher 吞异常返回 `'not-ready'`，router 回退 socket → socket 也已断则进 offline。registry 里的过期引用由 `member-driver/lifecycle` 的 `driver.error` / `instance.deleted` 订阅负责清理，dispatcher **不主动 unregister**（避免与 lifecycle 双写竞争）。
- **D2 · 同一 memberId 并发两条 message**：`AgentDriver.prompt()` 内部用状态机串行（READY → WORKING → READY），Stage 2 的责任。dispatcher 不做二次队列。并发第二条很可能落在 WORKING 状态上 → `isReady()` 返回 false 前已进入 prompt 则抛 "not READY" → 走 `'not-ready'` 回退分支。这符合"推模式不保证幂等投递，失败走 offline 兜底"的 Stage 3 合约。
- **D3 · 高并发多 member 下发**：dispatcher 本身无状态，每次调用都新建 closure，Promise 并发安全。registry.get 是 Map 读，无锁。

## 错误传播路径

| 源头 | dispatcher 行为 | router 看到 | 最终状态 |
|------|-----------------|-------------|---------|
| registry 未命中 | 返回 `'not-found'` | 继续 socket 分支 | 在线 socket 命中 → local-online；否则 offline.store |
| `driver.isReady()===false` | 返回 `'not-ready'` | 同上 | 同上 |
| `driver.prompt()` 抛异常 | 吞异常 + 返回 `'not-ready'` | 同上 | 同上；错误不向 router 泄漏（router.ts 已有额外 try/catch 兜底） |
| dispatcher 本身抛异常（不应发生） | — | router 侧 `try/catch` 打印 warn 后继续 socket 分支 | 不影响 leader 发消息链路 |

## 注意事项

- **不在 dispatcher 内修改 registry**：不因 prompt 失败就 `unregister`，不因 `not-found` 就创建。状态变更一律由 `member-driver/lifecycle` 胶水层负责，dispatcher 是纯"读 + 推"路径。
- **不 import bus / db / domain**：dispatcher 只允许依赖 `agent-driver/registry` 与 `comm/router` 类型。
- **`text` 透传**：dispatcher 不做消息格式化；router 侧已通过 `extractText(msg)` 拼好 `summary + content`。成员侧进一步的"[来自 X]"包装由 `formatMemberMessage`（W1-2）在 lifecycle replay 或上游拼装时完成，不在 dispatcher 内。
- **`router.ts` 已经对 dispatcher 异常有兜底 try/catch**（见 `router.ts:84-90`）。本模块仍自吞异常，双保险。
