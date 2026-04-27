# Phase · Reliability — Task List

## 拆分约束

- 每 **实现** 文件 ≤ 200 行（文档不计）。
- Wave 1 = 非业务（`process-manager/*`、`memory-manager/*`、WS 常量模块）；不得 `import` 任何业务路径（bus / domain / db / http / comm）。
- Wave 2 = 业务胶水；依赖已合并的 Wave 1 模块。
- Wave 3 = 观测 / HTTP 暴露。
- 每任务列：代码位置 / 契约摘要 / 依赖 / 预估行数 / 完成判据。
- 详细接口签名、字段含义直接写在实现文件的头注释里；本表只抓核心。

---

## Wave 1 · 非业务（可并行）

### W1-1 · ProcessManager 核心
- 位置：`packages/backend/src/process-manager/manager.ts`（新建）
- 契约：`ManagedProcess { id, pid, owner, spawnedAt, tempFiles: string[] }`；`ProcessManager { register/unregister/get/listAll/killAll(SIGTERM→2s→SIGKILL)/onProcessExit/stats/snapshot/attachTempFiles }`。register 传 `{ id, pid, owner, kill: (sig) => Promise<void> }`——kill 回调由 Runtime 实现 PGID 组播（F1），Manager 本身不调 `process.kill`。
- **`attachTempFiles(pid, paths: string[])`**：在已登记的进程上**追加** tempFiles（幂等、去重）。pid 不存在直接 return（调用方 spawn 失败的路径不应该抛）。进程 exit 时统一 `fs.unlink`（吞 ENOENT）。
- `snapshot(path)` 写 pid 清单文件（S5）。
- 依赖：仅 node 内置（`fs/promises` 写 snapshot + unlink）。
- 行数：≤ 160。
- 判据：单测覆盖幂等 / tempFiles unlink / `attachTempFiles` 幂等+pid 缺失静默 / 回调解绑 / snapshot 读写；grep 证不 import 业务路径。

### W1-1b · Runtime 自动注册接入（F2 强制入口）
- 位置：改 `packages/backend/src/process-runtime/host-runtime.ts` + `docker-runtime.ts`
- 行为：
  - `spawn` 加 `detached: true`（F1）。
  - `createHandle` 内部调 `processManager.register({ id: String(pid), pid, owner: spec.env.TEAM_HUB_PROCESS_OWNER ?? 'runtime', kill })`，`onExit` 内部 `unregister` + 触发 onProcessExit cb。
  - `kill` 实现改：`try { process.kill(-pid, sig) } catch (EPERM|ESRCH) { child.kill(sig) }`。
  - Runtime 模块不允许 import `bus` / 业务，但 `process-manager` 是同 Wave 1 的纯净模块，**允许** `process-runtime` import `process-manager`（§2 明确两者同层）。
- 依赖：W1-3（单例）。
- 行数：+25 host / +25 docker。
- 判据：
  - grep 后业务层 0 处显式 `processManager.register`（全靠 runtime 自动）。
  - 单测：spawn 一个 `sleep 30` + 一个 shell fork 孙子进程 → `kill()` 后父子孙全退。
  - `pgrep -P <pid>` 在 kill 后为空。
- 备注：契约 `ProcessRuntime` / `RuntimeHandle` **签名不变**，只升级 kill 行为（非破坏）。调用方如需追加 tempFiles，**不 register**（已自动），改调 `processManager.attachTempFiles(pid, paths)`（R2 约束）。

### W1-2 · 父进程心跳
- 位置：`packages/backend/src/process-manager/parent-watcher.ts`（新建）
- 契约：`watchParentAlive(onParentGone, { initialPpid? }): ParentWatcher { stop() }`。**intervalMs = 500 写死**（F3），不暴露参数。轮询 `process.ppid`，变 1 则触发一次（去重：多次触发只调回调一次）。
- 依赖：无。
- 行数：≤ 50。
- 判据：mock ppid 测回调只触发一次；interval `.unref()`；stop 幂等。

### W1-2b · stdin EOF 监听（F3 主通道）
- 位置：`packages/backend/src/process-manager/stdin-watcher.ts`（新建）
- 契约：`watchStdinEnd(onEof): StdinWatcher { stop() }`。监听 `process.stdin.on('end'|'close', onEof)`，调 `process.stdin.resume()` 让 stream 流动（否则 EOF 不触发）。回调去重（只一次）。
- 依赖：无。
- 行数：≤ 40。
- 判据：stub EventEmitter 触发 'end' → 回调跑；stop 后再触发不跑。

### W1-3 · ProcessManager 单例
- 位置：`packages/backend/src/process-manager/index.ts`（新建）
- 契约：re-export W1-1/W1-2/W1-2b + `export const processManager`。
- 依赖：W1-1、W1-2、W1-2b。
- 行数：≤ 20。
- 判据：import 不触发副作用（lazy 起 watcher）。

### W1-4 · MemoryManager 核心
- 位置：`packages/backend/src/memory-manager/manager.ts`（新建）
- 契约：`Collection { size, evict(k), keys, touch?, ageOf? }`；`CollectionOpts { maxSize, ttlMs?, strategy: 'lru'\|'ttl'\|'fifo', warnThreshold? }`；`MemoryManager { register/unregister/cleanup/startTicker/stopTicker/getStats/onWarn }`。
- 依赖：无。
- 行数：≤ 150。
- 判据：三策略 + warn + cleanup 单测；tick `.unref()`；grep 证纯净。

### W1-5 · 集合适配器
- 位置：`packages/backend/src/memory-manager/collection-adapters.ts`（新建）
- 契约：`mapAsCollection(map, { touch? })` / `setAsCollection(set)`。
- 依赖：W1-4 的 type。
- 行数：≤ 40。
- 判据：Map/Set 包一层可被淘汰。

### W1-6 · MemoryManager 单例
- 位置：`packages/backend/src/memory-manager/index.ts`（新建）
- 契约：re-export + `export const memoryManager`。
- 依赖：W1-4、W1-5。
- 行数：≤ 10。

### W1-7 · 新 Bus 事件类型
- 位置：追加到 `packages/backend/src/bus/types.ts`
- 契约：新增 `runtime.fatal` / `memory.warn` / `process.reaped` 三个事件类型及 payload。**不改白名单**。
- 行数：+30。
- 判据：`BusEventType` 联合补齐；`makeBase` 通过编译。

### W1-8 · WS 白名单独立（S3 时序第一步）
- 位置：**新建** `packages/backend/src/ws/event-types.ts`；**改** `bus/subscribers/ws.subscriber.ts` 改 `WS_EVENT_TYPES` 为 re-export；**`WsBroadcaster` class 暂不删**（保证 `bus/index.ts` 仍能 `new WsBroadcaster()`）。
- 契约：`export const WS_EVENT_TYPES: ReadonlySet<BusEventType>`。`ws/ws-broadcaster.ts` 已从 `bus/subscribers/ws.subscriber.ts` import，W1-8 合并后它 import 路径切到 `ws/event-types.ts`。
- 依赖：W1-7 的 type（type-only import）。
- 行数：新文件 ≤ 50 / 旧文件 -36 / +2 re-export。
- 判据：
  - grep `export const WS_EVENT_TYPES` 只在 `ws/event-types.ts`。
  - `bus/subscribers/ws.subscriber.ts` 只 re-export + 保留 class 定义。
  - `bun test` 全绿（A 系列守门测试、team-lifecycle-ws 都过）。
  - W1-8 合并后系统仍双 broadcaster 运行，不破坏现有行为。
- 边界：**不碰 class、不碰 `bus/index.ts` 的 `wsBroadcaster` 实例化**，那些归 W2-5。

---

## Wave 2 · 业务胶水

### W2-1 · 全局 process handler
- 位置：新建 `packages/backend/src/http/fatal-handlers.ts`（≤ 80 行）；改 `http/server.ts:58` 起手调 `installFatalHandlers({ bus, processManager, shutdown })`。
- 行为：unhandledRejection → stderr + emit `runtime.fatal` + 不 exit；uncaughtException → stderr + emit + 触发 shutdown。
- 依赖：W1-3、W1-7。
- 判据：stub bus 注入并触发两种错误，emit 行为符合预期。

### W2-2 · store.insert 异常收敛
- 位置：`packages/backend/src/comm/router.ts:71`
- 行为：try/catch 包裹 `this.store.insert`，失败返回 `{ route: 'dropped', reason: 'store-failure', detail }`。`DispatchOutcome` 新增该分支。
- 行数：+15 / 测试 +20。
- 判据：注入抛错的 MessageStore，dispatch 不传播。

### W2-3 · primary-agent 自愈（S4 物理隔离）
- 位置：`packages/backend/src/primary-agent/primary-agent.ts:150-172`
- 行为：
  - 构造函数内 `this.restartPolicy = createRestartPolicy({ maxRestarts: 3, backoffBaseMs: 1000 })`——**独立实例**，不从构造参数传入，避免被外部共享。测试可通过覆盖实例字段 inject。
  - `handleDriverFailure` 调 `this.restartPolicy.onCrash(agentId)`：restart → `setTimeout(() => this.start(), delayMs)`；give_up → emit `primary_agent.give_up`。
  - 正常 `stop` 调 `this.restartPolicy.reset(agentId)`。
- 依赖：W1-3（用 processManager 检查自己是否还在跑）不必需；本任务可与 W1 并行。
- 行数：+40 / 测试 +60。
- 判据：
  - stub policy 返回 restart → start 被调一次（延时验证）。
  - stub policy 返回 give_up → 无 start 调用；emit `primary_agent.give_up`。
  - **S4 隔离测试**：mock container 的 policy 达到 give_up 状态，primary 的 policy 仍可正常 onCrash 返回 restart（证明不共享 map）。

### W2-4 · Electron 父死子随（F3 双保险 + S1 PGID）
- 位置：`packages/renderer/electron-main/backend.ts` + `packages/backend/src/http/server.ts`
- 行为：
  - **renderer 侧（S1）**：`spawn('bun', [...], { detached: true, stdio: ['pipe', 'inherit', 'inherit'], env })`；**不调** `child.unref()`（原方案错误，unref 会让 Electron 不等 backend 退出，与父死子随语义冲突）。
  - `stopBackend` 改：`process.kill(-child.pid, 'SIGTERM')`；2s 内未退则 `process.kill(-child.pid, 'SIGKILL')`。catch `ESRCH` 静默（已退）。
  - `app.on('before-quit', stopBackend)` 钩入 Electron 退出流程。
  - **backend 侧（F3）**：`http/server.ts` 的 `startServer` **第一行**（在 `createServer()` 调用之前）：
    ```ts
    installFatalHandlers(...);
    watchStdinEnd(() => shutdown());      // 主通道
    watchParentAlive(() => shutdown());   // 兜底，intervalMs=500 写死
    ```
  - shutdown 幂等（加 `let shuttingDown = false` 门闩）。
- 依赖：W1-2、W1-2b、W1-3。
- 行数：+30 renderer / +15 backend。
- 判据：
  - 手动 `kill -9 <electron-main-pid>` → 2s 内 backend 收到 stdin EOF，走 shutdown；5s 内所有子进程清零。
  - 人为 `exec >/dev/null 2>&1 < /dev/null` 让 stdin 不正常，500ms 轮询兜底触发（单测可 mock）。
  - shutdown 只跑一次（两路并发触发时）。

### W2-5 · 删除旧 WsBroadcaster（S3 时序第二步）
- 位置：`packages/backend/src/bus/subscribers/ws.subscriber.ts`、`packages/backend/src/bus/index.ts`
- 前置条件：W1-8 已合并；新 `ws/ws-broadcaster.ts` 已在 `http/server.ts:65` 生效并跑通。
- 行为：
  - 删除 `bus/subscribers/ws.subscriber.ts` 的 `WsBroadcaster` class + `toWsPayload` 本地实现，文件只剩 `WS_EVENT_TYPES` 的 re-export（≤ 15 行）。
  - `bus/index.ts:27` `export const wsBroadcaster = new WsBroadcaster()` 删除。
  - `bus/index.ts:73` `if (eventBus === defaultBus) wsBroadcaster.start()` 删除。
  - `bus/index.ts:82` `wsBroadcaster.stop()` 删除。
  - 外部若有 `import { wsBroadcaster }` 的地方全部 grep 清理（预期 0 处，已走新实现）。
- 依赖：W1-8（强）。
- 行数：-80 / +5。
- 判据：
  - grep `new WsBroadcaster` 只剩 `http/server.ts:65` 一处。
  - grep `export.*wsBroadcaster` 为 0。
  - `team-lifecycle-ws.test.ts` 单次 bus 事件对单 ws 连接只下发 1 条。
  - `bun test` 全绿。
- 边界：不碰 `ws/ws-broadcaster.ts` 本身；不改白名单内容。

### W2-6 · driver.prompt 超时（S2 双路 race / R1 实例字段）
- 位置：`packages/backend/src/agent-driver/driver.ts:35-81`
- 行为：
  - `PROMPT_TIMEOUT_MS = 2 * 60 * 1000`（2 分钟）。可由 `DriverConfig.promptTimeoutMs` 覆写。
  - **复用构造函数里已有的** `this.handle.onExit(...)`（driver.ts:35-41）。**不在每次 prompt 重新 onExit**——RuntimeHandle.onExit 在 host-runtime.ts:103 有 `if (exitCb) throw 'already registered'` 守护，重复注册必抛（R1 关键）。
  - 新增实例字段：`private pendingPromptReject: ((e: Error) => void) | null = null`。
  - 构造函数中 `handle.onExit` cb 的**第一步**（切 STOPPED 之前）新增：`if (this.pendingPromptReject) { this.pendingPromptReject(new Error('process exited during prompt')); this.pendingPromptReject = null; }`。
  - `prompt` 方法改为 Promise.race：
    ```ts
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.conn.prompt({ sessionId: this.sessionId, prompt: [...] }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('prompt timeout')), ms); }),
        new Promise<never>((_, rej) => { this.pendingPromptReject = rej; }),
      ]);
      this.status = 'READY';
    } catch (err) {
      if (this.status !== 'STOPPED') this.status = 'READY';  // exit 路径已在 cb 切 STOPPED，不覆盖
      this.emit({ type: 'driver.error', message: (err as Error).message });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingPromptReject = null;
    }
    ```
- 行数：+35。
- 判据：
  - stub 永不 resolve 的 prompt：2 分钟后超时，status==READY，后续 prompt 可发起；`pendingPromptReject` 为 null。
  - stub 中途 handle 触发 exit：**立即** reject（fake timer 断言 setTimeout 未 fire），status==STOPPED，emit `driver.error` message 含 'process exited during prompt'。
  - 正常 prompt 完成：timer 被 clear，`pendingPromptReject == null`。
  - 并发安全：顺序发两条 prompt，finally 已清空 reject，第二条不会收到第一条残留的 reject。

### W2-7 · replay markRead 顺序
- 位置：`packages/backend/src/bus/subscribers/member-driver/replay.ts:33-54`
- 行为：`await driver.prompt` 抛错则**不 markRead**，`delivered`/`failed` 计数按实际成败。（当前实现已是此顺序，但缺错误路径单测；本任务补强语义并加测。）
- 行数：+10 / 测试 +40。
- 判据：第 3 条抛错时前 2 条 markRead，后 3 条仍 unread。

### W2-8 · Codex 临时文件纳管（R2 attachTempFiles）
- 位置：`packages/backend/src/agent-driver/adapters/codex.ts` + `primary-agent/primary-agent.ts` + `bus/subscribers/member-driver/lifecycle.ts`
- **接入方式**：由于 W1-1b 规定 Runtime 内部自动 `processManager.register`（F2 强制入口），胶水层**不 register**；改调 `processManager.attachTempFiles(pid, paths)` 追加临时文件清单。
- adapter 改造：
  - `prepareLaunch(config)` 行为不变（仍在 spawn 前把 `systemPrompt` 写 `/tmp/mteam-codex-prompt-*.md` 并在 args 里引用）——文件必须先于 spawn 存在。
  - 暴露 `listTempFiles(): string[]`（返回 `this.promptFile ? [this.promptFile] : []`）。
  - `cleanup()` 保持现状（spawn 失败路径仍由 adapter 自己 unlink；见下方流程）。
- 胶水层流程（`primary-agent.start` / `member-driver/lifecycle.startMember`）：
  ```ts
  const spec = mergeHostEnv(adapter.prepareLaunch(config), config);   // 文件此时已在 FS
  let handle: RuntimeHandle;
  try {
    handle = await runtime.spawn(spec);                               // runtime 内部自动 register(pid)
  } catch (err) {
    adapter.cleanup();                                                // spawn 失败：adapter 自己删文件
    throw err;
  }
  processManager.attachTempFiles(handle.pid as number, adapter.listTempFiles());
  // handle.onExit → ProcessManager.unregister → 自动 unlink tempFiles
  ```
- `codex.cleanup` 仍保留幂等（spawn 成功后不调用，ProcessManager 的 exit 回调接管；spawn 失败兜底路径仍需要）。
- 依赖：W1-1 的 `attachTempFiles` + W1-1b 的自动 register。
- 行数：+5 adapter（listTempFiles）/ +8 primary-agent / +8 member-driver/lifecycle。
- 判据：
  - spawn 成功：SIGKILL 进程后 `/tmp/mteam-codex-prompt-*.md` 不残留。
  - spawn 失败（runtime 抛错）：`/tmp/mteam-codex-prompt-*.md` 被 `adapter.cleanup()` 删除。
  - 单测：跨 spawn 失败 / 成功 / 正常退出 / 异常退出四条路径验证文件状态。

### W2-9 · container teardown kill 子进程
- 位置：`packages/backend/src/bus/subscribers/container.subscriber.ts:93-96`
- 行为：teardown cb 改 `await Promise.allSettled(registry.list().map(e => e.entry.handle.kill()))`。
- 行数：+10 / 测试 +20。
- 判据：注册两个 stub handle → unsubscribe → 两个 kill 都被调。

### W2-10 · 集合纳管 MemoryManager（R3 turn 走 aggregator）
- 位置与接入方式：
  - **driverRegistry**（`agent-driver/registry.ts` 构造函数内）：`memoryManager.register('driverRegistry', mapAsCollection(this.map, { touch: true }), { maxSize: 200, strategy: 'lru' })`。
  - **containerRegistry**（`bus/subscribers/container-registry.ts` 的 `createContainerRegistry` 工厂）：同上，maxSize=50, LRU。
  - **subscriptionManager**（`ws/subscription-manager.ts` 构造函数）：包 `this.conns`，maxSize=500, FIFO。
  - **turnHistory（R3 关键）**：**不直接改** `bus/subscribers/turn-store.ts`（turn-store 是纯数据结构，由 aggregator 拥有）。改为在 `bus/index.ts` 里调 `subscribeTurnAggregator` 后、暴露 `getTurnAggregator()` 的同层，新增接线：
    ```ts
    const { aggregator, subscription: turnSub } = subscribeTurnAggregator(eventBus);
    turnAggregator = aggregator;
    // 新增：通过 aggregator 的 public collection getter 接线
    memoryManager.register('turnHistory', aggregator.historyAsCollection(), {
      maxSize: 1000, strategy: 'ttl', ttlMs: 24 * 60 * 60 * 1000,
    });
    ```
    `TurnAggregator` 需新增只读方法 `historyAsCollection(): Collection<string>`，内部把 `turn-store` 的 history Map 包成 Collection（不暴露原 Map，保持封装）。
- 行为：构造/接线时调 `memoryManager.register(...)`；进程 shutdown 时走 `memoryManager.unregister(...)` 或依赖 GC。
- 依赖：W1-5、W1-6；R3 需 `turn-aggregator.subscriber.ts` 暴露 `historyAsCollection`。
- 行数：+5 driverRegistry / +5 containerRegistry / +5 subscriptionManager / +8 turn-aggregator（新方法）+ 5 bus/index.ts。
- 判据：
  - 启动后 `memoryManager.getStats()` 返回四条 record（名字严格一致）。
  - 压测灌 300 driver → driverRegistry.size 稳定在 200（LRU 淘汰验证）。
  - turn-store 未被直接 import 到 `bus/index.ts`（grep 证），接线唯一入口是 aggregator。

### W2-11 · 启动自清扫（S5）
- 位置：新建 `packages/backend/src/process-manager/bootstrap-cleanup.ts`（≤ 60 行）；在 `http/server.ts` startServer 起手段（fatal handler 之后、watcher 之前）调 `await bootstrapCleanup()`。
- 行为：
  - 读 `~/.claude/team-hub/pid.snapshot`（JSON: `{ pids: number[], writtenAt: iso }`）。
  - 对每个 pid：`try { process.kill(-pid, 0) } catch`（判断是否存在）；存在则 `process.kill(-pid, 'SIGTERM')`，2s 后 `SIGKILL`。
  - 完成后覆写空快照 `{ pids: [], writtenAt: now }`。
  - 任何错误 stderr 打印后吞掉（best-effort，不影响启动）。
  - ProcessManager 侧：在 `register`/`unregister` 后 debounce（100ms）写 snapshot。
- 依赖：W1-1（新增 snapshot 字段）。
- 行数：+60 cleanup / +20 manager snapshot。
- 判据：
  - 手工写入含已死 pid + 当前正跑 pid 的 snapshot，启动后不影响正跑 pid，死 pid 无副作用。
  - 手工 spawn 个 `sleep 600` 写 snapshot，杀 backend（不走 shutdown），重启 → `sleep` 被回收。
  - 首次安装（无 snapshot 文件）启动不报错。

---

## Wave 3 · 观测

### W3-1 · GET /api/panel/runtime/status
- 位置：`packages/backend/src/api/panel/runtime-status.ts`（新建）
- 契约：`{ processes: processManager.stats(), memory: memoryManager.getStats() }`。
- 依赖：W1-3、W1-6。
- 行数：≤ 60。
- 判据：handler + 路由接线单测。

### W3-2 · log.subscriber 新事件
- 位置：`packages/backend/src/bus/subscribers/log.subscriber.ts`
- 行为：追加订阅 `runtime.fatal` / `memory.warn` / `process.reaped`，统一 stderr 格式。
- 依赖：W1-7。
- 行数：+15。
- 判据：三类事件各打印一次的单测。

---

## 依赖图

```
W1-1 ─┬─ W1-1b ── W2-4, W2-8, W2-9, W2-11
      │
W1-2 ─┤
W1-2b ┴── W1-3 ── W2-1, W2-4, W2-11, W3-1
W1-4 ── W1-6 ─┬─ W2-10, W3-1
W1-5 ─────────┘
W1-7 ────────── W2-1, W3-2
W1-8 ────────── W2-5   （W2-5 必须在 W1-8 合并后才能上）
独立：W2-2, W2-3, W2-6, W2-7
```

## S3 · WS 白名单迁移两步时序
1. **W1-8 合并**：新增 `ws/event-types.ts`，旧 ws.subscriber 改 re-export，**保留 class**。此时系统仍双 broadcaster，但不冲突。
2. **W2-5 合并**：删 class + 清理 `bus/index.ts` 实例化点。系统回到单一 broadcaster。
- 两步中间任何时刻都可编译、可运行、测试全绿。

## 推荐节奏

1. Wave 1 九个任务并发（非业务，冲突面小；含 W1-1b 接入 runtime），2 天。
2. Wave 1 合并后 Wave 2 十一个任务并发（W2-5 等 W1-8，其他并发），2–3 天。
3. Wave 3 收尾。
4. 每任务合并前：相关 `bun test` 全绿、实现文件 ≤ 200 行、Wave 1 grep 证纯净。
