# bus/subscribers/member-driver

成员 driver 业务胶水族。拆成三个子模块（lifecycle / replay / pid-writeback），
通过 `index.ts` 聚合挂到 bus。

## index.ts（W2-A · 聚合入口）

```ts
export function subscribeMemberDriver(deps?: {
  eventBus?: EventBus; registry?: DriverRegistry; runtime?: ProcessRuntime;
  hubUrl?: string; commSock?: string;
}): Subscription;
```

把 `subscribeMemberDriverLifecycle` + `subscribePidWriteback` 两条独立 `Subscription`
合并成一条 master，`bus/index.ts` 的 `bootSubscribers` 里一行 `masterSub.add(...)` 接上。
`replay` 是**纯函数**，由 lifecycle 在 `driver.start()` 成功后直接 `await replayForDriver`
调用 —— 它不走 bus 事件，所以不在 index 里挂；绕 bus 反而要多一跳 registry 反查，
时序更脆。

时序：`bootSubscribers → subscribeMemberDriver → [lifecycle subscribe, pid-writeback subscribe]`。
teardown 时 master.unsubscribe() 级联撤销两条子 sub，lifecycle 内部 teardown 还会
停掉所有在册 driver（见下文）。

---


---

## lifecycle.ts（W2-1a）

### 一句话

订阅 `instance.created` / `instance.deleted` / `instance.offline_requested`，
负责成员 AgentDriver 的起停 + 注册进 `driverRegistry` + 首屏离线消息回灌。

### 对外接口

```ts
export function subscribeMemberDriverLifecycle(deps?: {
  eventBus?: EventBus;         // 默认全局 bus
  registry?: DriverRegistry;   // 默认全局 driverRegistry
  runtime?: ProcessRuntime;    // 默认 new HostRuntime()
  hubUrl?: string;             // 默认 http://localhost:${V2_PORT ?? 58590}
  commSock?: string;           // 默认 defaultCommSock()
}): Subscription;
```

所有依赖可注入；返回的 `Subscription` 被 `unsubscribe()` 时会对所有在册 driver
触发一次 stopMember，避免测试 / 进程退出时残留孤儿进程。

### 时序图：instance.created → driver RUNNING

```
instance.created (e)
    │
    └─ enqueue(e.instanceId, startMember)   ← per-instance 串行队列，C1/C3 防重入
        │
        ├─ 1. entries.has(id)?  YES → await stopMember(id)     (C3)
        ├─ 2. RoleInstance.findById(id)   null/isLeader        → return
        ├─ 3. RoleTemplate.findByName(...)  null                → stderr + return
        ├─ 4. mcpManager.resolve(template.availableMcps, ctx)
        ├─ 5. buildMemberDriverConfig({ instance, template, resolvedMcps })
        ├─ 6. createAdapter(config); adapter.prepareLaunch(config)
        ├─ 7. mergeHostEnv(spec, config)                        // host 下补 process.env
        ├─ 8. runtime.spawn(spec)                               // → RuntimeHandle
        ├─ 9. new AgentDriver(id, config, handle, adapter)
        ├─10. attachDriverToBus(id, driver.events$, bus)        // 翻译桥
        ├─11. entries.set(id, {driver, handle, busSub})         // (C1) 先入 map 再 start
        ├─12. driver.start()
        │      success → events$ emit 'driver.started' ─┐
        │      fail    → catch: delete entry + busSub off │  attachDriverToBus 翻译成 bus 的
        │               + handle.kill + return            │  driver.started {driverId: instanceId}
        │                                                  │    ← 兄弟 W2-1c pid-writeback 入口
        ├─13. registry.register(id, driver)                │
        └─14. await replayForDriver(id, driver)            └─ 兄弟 W2-1b 的链式入口
```

### 时序图：instance.deleted / instance.offline_requested

```
instance.deleted / instance.offline_requested (e)
    │
    └─ enqueue(e.instanceId, stopMember)    ← 共享同一 per-instance 队列
        ├─ entries.get(id)   不存在 return  (幂等)
        ├─ entries.delete(id) + registry.unregister(id)
        ├─ driver.stop()      // driver.events$ emit driver.stopped → bus 可见
        ├─ handle.kill()      // HostRuntime.kill 幂等
        └─ busSub.unsubscribe()
```

### 竞态分析

| # | 场景 | 解决 |
|---|------|------|
| **C1** | start 还没完成，外部并发 `instance.deleted` / `offline_requested` | per-instance 队列：deleted 入队等 startMember 跑完；startMember 第 11 步就写入 entries，即便 start() 之后 catch 删掉也无妨，deleted 分支拿不到条目自然幂等 return |
| **C2** | driver 自身 `driver.error` 触发 `driver.stopped`，同时 lifecycle 又收到外部停止事件 | `stopMember` 开头 `entries.get` → 不存在 return；`driver.stop()` / `registry.unregister` / `handle.kill` 皆幂等 |
| **C3** | 同一 instanceId 重复收到 `instance.created`（防御） | `startMember` 开头若 `entries.has(id)` → 先 await `stopMember(id)` 再继续新流程 |
| **C4** | `handle.kill` 并发（stopMember + start 失败分支同帧触发） | HostRuntime.kill 幂等：exited 直接 return、killing 标志防双 SIGTERM |
| **C5** | 订阅整体 `sub.unsubscribe()` 时仍有成员 driver 在跑 | masterSub teardown 回调遍历 entries 调 stopMember；测试无孤儿进程 |

### 错误传播路径

```
RoleTemplate.findByName 返回 null
   └─> stderr + return。不抛错；instance 行保持 PENDING，不产生 driver.*。

mcpManager.resolve 抛错
   └─> enqueue 里的 catch 记 stderr，不吞噬队列（后续 task 仍可入队）。

runtime.spawn 抛错（CLI 缺失 / docker 拉镜像失败）
   └─> startMember 里未 catch；异常冒到 enqueue catch → stderr。entries 未写入，无 driver 产物。

driver.start 抛错（ACP 握手 / session/new 超时）
   └─> entries 已写入 → catch 块 delete + busSub.unsubscribe + handle.kill。
       AgentDriver 内部已 emit driver.error + driver.stopped（翻译进 bus），
       外部观察者（pid-writeback / ws）能看到失败信号。
       registry 不 register，replay 不执行。

replayForDriver 抛错
   └─> catch + stderr。driver 已 register，外部发消息仍可正常投递。

runtime 子进程运行期崩溃
   └─> RuntimeHandle.onExit → driver 内部 emit driver.error + driver.stopped。
       **本模块 entries 不会自动清理**（Stage 3 范围内的已知限制）。
       成员下次 instance.deleted / offline_requested 才 teardown；或等外部重建。
       改进项（非本 Stage 范围）：加 `driver.error` 订阅做自动 teardown + 标脏 RoleInstance。
```

### 使用示例

```ts
// 生产
import { subscribeMemberDriverLifecycle } from './bus/subscribers/member-driver/lifecycle.js';
const sub = subscribeMemberDriverLifecycle();

// 测试：注入 FakeRuntime + 独立 bus/registry
import { EventBus } from '../../events.js';
import { DriverRegistry } from '../../../agent-driver/registry.js';
const bus = new EventBus();
const registry = new DriverRegistry();
const sub = subscribeMemberDriverLifecycle({ eventBus: bus, registry, runtime: new FakeRuntime() });
```

### 约束

- ≤ 150 行（当前 143 行）
- 不 writeFileSync 任何临时 MCP 配置；mcpServers 结构由 `buildMemberDriverConfig` 产出
- 不订阅 `pty.*`；PTY 链路在 W2-3 物理下线
- 不订阅 `driver.error` 做自动 teardown（暂由外部触发 delete/offline_requested 承担）
- replay 调用走**纯函数 await**（见 `replay.ts` 开头注释解释为何不走事件）

---

## replay.ts（W2-1b）

### 一句话

成员 driver 启动成功后，把 offline store 里该成员的 pending 消息**串行**回灌给 driver，
每条成功后从 pending 移除。

### 接口

```ts
export interface ReplayResult {
  total: number;
  delivered: number;
  failed: number;
}

export function replayForDriver(
  instanceId: string,
  driver: AgentDriver,
): Promise<ReplayResult>;
```

### 接法（选型）

**纯函数，不订阅 bus**。由 `lifecycle.ts`（W2-1a）在以下时序点**显式 await**：

```
driver.start() resolve
  → driverRegistry.register(instanceId, driver)
  → await replayForDriver(instanceId, driver)   ← 本模块
  → （lifecycle 返回，后续新消息走 router → registry → driver.prompt）
```

### 为什么不走事件

TASK-LIST §3 W2-1b 允许二选一（订阅 `member.driver.started` vs 暴露纯函数）。选纯函数的理由：

1. **时序精确**：回灌必须发生在"注册之后、接受新消息之前"。await 能自然保证；
   事件驱动需要额外握手确认 replay 完成。
2. **无耦合**：lifecycle 本就持有 `instanceId` + `driver` 引用，直接 await 零多余跳转；
   走 bus 还要再查 registry 拿回 driver 实例。
3. **不污染 bus**：`member.driver.started` 是个内部协调信号，没有其他消费者，
   让它只存在于 lifecycle 的内部顺序里更干净。

### 时序图

```
lifecycle (W2-1a)           replay (W2-F v2)         messageStore (W1-C)          driver
    │                             │                             │                     │
    │  await driver.start()       │                             │                     │
    │──────────────────────────────────────────────────────────────────────────────→ │
    │                             │                             │                     │
    │  registry.register(id, d)   │                             │                     │
    │                             │                             │                     │
    │  await replayForDriver(id, d)                             │                     │
    │────────────────────────────→│                             │                     │
    │                             │  findUnreadFor(id) ────────→│                     │
    │                             │←───── MessageEnvelope[]     │                     │
    │                             │                             │                     │
    │                             │ for each env:               │                     │
    │                             │   formatNotifyLine(env)     │                     │
    │                             │   await driver.prompt(line) │──────────────────→ │
    │                             │                             │    (WORKING→READY) │
    │                             │←────────────────────────────────────────── resolve│
    │                             │   store.markRead(env.id) ──→│                     │
    │                             │                             │                     │
    │←──── ReplayResult           │                             │                     │
```

### 竞态分析

- **R1 · replay 期间新消息到达**：派发侧走 `router → driverDispatcher → registry.get → driver.prompt`。
  `driver.prompt` 在 `WORKING` 态会被调用（见 driver.ts §62）——此时会抛 "driver ... not READY"，
  dispatcher 捕获后回落 socket/offline（见 §1.5 设计）。**本模块不做二次队列**，
  driver 层的串行化由 Stage 2 的 `driver.prompt` 状态机保证。
- **R2 · replay 中途 driver 被 stop**：`driver.prompt` 抛 "driver ... not READY"，
  本模块记失败、**不 markDelivered**，继续尝试后续消息（也都会抛）。
  未 deliver 的消息留在 offline store，**等下次 `instance.created` 触发 replay 再投递**。
- **R3 · 单条消息 format/prompt 失败**：捕获异常 → stderr 日志 → 继续下一条。
  不 markDelivered 的消息天然保留重试机会。
- **R4 · 并发调用 `replayForDriver` 同一 instanceId**：理论上只应从 lifecycle 调一次；
  若真的并发，两次都会读到未 read_at 的消息，`driver.prompt` 串行化会让第二调用串到第一调用后面，
  但可能重复 prompt（`markDelivered` 之前）。lifecycle 层保证"一次 created → 一次 replay"即可。

### 错误传播

| 失败点 | 本模块动作 | 最终状态 |
|--------|-----------|---------|
| `store.findUnreadFor` 抛 | 异常冒泡给 lifecycle | driver 已 register，lifecycle 自行决定是否回滚 |
| `formatNotifyLine` 抛 | 理论不抛（纯拼串） | — |
| `driver.prompt` 抛 | 记 failed++ + stderr，不 markRead，继续 | 消息留未读下次再试 |
| `store.markRead` 抛 | 异常冒泡 | 罕见（SQL 写失败）；lifecycle 捕获处理 |

### 约束

- ≤ 100 行（当前 ~54 行，含注释）
- 串行（`for … await`），**不**并发 `Promise.all(prompts)`
- 不 import bus（纯函数）；依赖 `agent-driver/driver`（type）+ `comm/message-store` + `member-agent/format-message`
- 单测不 mock db / store — 用 `:memory:` DB + 真实 `buildEnvelope` + `messageStore.insert`

### 使用示例（lifecycle 内部）

```ts
// lifecycle.ts（W2-1a）
import { driverRegistry } from '../../../agent-driver/registry.js';
import { replayForDriver } from './replay.js';

await driver.start();
driverRegistry.register(instanceId, driver);
await replayForDriver(instanceId, driver);   // 一次性，不异步漂
```

---

## pid-writeback.ts（W2-1c）

### 一句话

订阅 bus `driver.started`，把事件里的 runtime pid 写回 `role_instances.session_pid`。

### 为什么独立成胶水

旧 PTY 链路下 `domain-sync.subscriber` 订阅 `pty.spawned` 写 pid；Stage 3 下线 PTY
后，`driver.started` 成为唯一 pid 信号源。写 DB 属于胶水职责（跨 bus + domain），
与 lifecycle 解耦的理由是：

1. **职责单一**：lifecycle 管进程起停 + registry + replay；pid 写回不应塞进它里面，
   否则单文件轻易超过 150 行红线。
2. **时序鲁棒**：lifecycle 在 `driver.start()` resolve 后才 `registry.register`，而
   `driver.started` 是 `start()` 内部 **同步** emit 的。pid-writeback 如果依赖 registry，
   就会拿到还没注册的 driver。直接从 bus event payload 拿 pid + 走 DB 查 RoleInstance
   避免了这个错位。
3. **适配非成员 driverId**：`primary_agent` 也 emit `driver.started`，但它的 driverId 是
   `primary_agent.id`，不在 `role_instances` 表里。`RoleInstance.findById` 返回 null →
   本模块直接跳过，天然隔离两条 driver 链。

### 对外接口

```ts
export function subscribePidWriteback(deps?: {
  eventBus?: EventBus;   // 默认全局 bus
}): Subscription;
```

### 时序

```
driver.start() resolve
   └─ AgentDriver emit 'driver.started' { pid: handle.pid }
         └─ bus-bridge 翻译 → bus.emit DriverStartedEvent { driverId, pid }
               ├─ pid-writeback.subscribe      ← 本模块
               │    ├─ pid === undefined?      → return（留 NULL）
               │    ├─ Number(pid) 不是有限数? → return（非数字 id 留 NULL）
               │    ├─ RoleInstance.findById(driverId) === null? → return（primary_agent）
               │    └─ inst.setSessionPid(pidNum)  // UPDATE role_instances SET session_pid=?
               └─ lifecycle（不订阅本事件，走 await 链串行）
```

### 约束

- ≤ 60 行（当前 34 行）
- 只做 pid 写回；不改 status、不动 session_id、不解注册
- `driver.started` 无 pid（极端 RuntimeHandle 失败）→ 保持 NULL，记 debug 级别
- pid 非数字（容器化场景预留 string）→ 暂不写回，留到未来扩 session_pid 列类型
- 单测不 mock db/bus（`:memory:` DB + 独立 EventBus）
