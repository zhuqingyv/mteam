# Phase · Reliability — Milestone

## 1. 背景

Dogfood 运行时发现宿主机残留 **463 个 `spawn-helper` 僵尸进程**。这是多层缺陷叠加的结果，不是单点 bug：

1. node-pty 遗留的 `spawn-helper` 不被回收。
2. 后端崩溃 / Electron 父进程非正常退出时，没有兜底 kill 子进程。
3. host / docker runtime 在 `container teardown` 路径不等待子进程确认退出。
4. `unhandledRejection` / `uncaughtException` 未挂 handler，进程静默死。

本阶段目标：**把"进程"和"内存"上升为一等公民**，通过两个纯净模块 `ProcessManager` + `MemoryManager` 接管所有 spawn / 常驻集合，同时修复 P0 九条已知可靠性缺陷。

## 2. 架构位置

```
                     ┌─────────────────────────────────────┐
                     │            Business Layer           │
                     │  primary-agent / member-driver/…    │
                     │  container.subscriber / replay      │
                     └────────┬──────────────────┬─────────┘
                              │ register/unreg   │ register
                              ▼                  ▼
                     ┌────────────────┐  ┌───────────────────┐
                     │ ProcessManager │  │  MemoryManager    │
                     │ (纯净, 无业务) │  │  (纯净, 无业务)   │
                     └────────┬───────┘  └─────────┬─────────┘
                              │ spawn/kill         │ cleanup tick
                              ▼                    ▼
                     ┌────────────────┐  ┌───────────────────┐
                     │ process-runtime│  │ driverRegistry    │
                     │ (HostRuntime / │  │ containerRegistry │
                     │  DockerRuntime)│  │ subscriptionMgr   │
                     └────────────────┘  │ turn-store        │
                                         └───────────────────┘
```

### ProcessManager 定位

- **不做业务决策**：重启策略、crash 翻译、回放、DB 写入仍在业务 subscriber 里。
- **只管台账**：这台机器上跑了哪些进程、pid 多少、什么状态、谁 own 它。
- **PGID 组播 kill（F1）**：所有子进程用 `detached: true` 起，自成进程组（leader pid == child pid）。kill 走 `process.kill(-pid, sig)`，把 `spawn-helper` / node-pty 孙子进程一起带走。`RuntimeHandle.kill` 内部实现从 `child.kill(sig)` 改为 `try { process.kill(-pid, sig) } catch (EPERM/ESRCH) { child.kill(sig) }` 兜底。
- **强制统一入口（F2）**：注册动作**下沉到 Runtime 实现**——`HostRuntime.spawn` / `DockerRuntime.spawn` 返回 `RuntimeHandle` **前** 自动调 `processManager.register(...)`；`onExit` 内部自动 `unregister`。业务层（`primary-agent` / `member-driver/lifecycle` / `container.subscriber`）**零改动**，也无法绕过。这样即使未来新增 Runtime 实现，也强制走 Manager。
- **父死子随（F3 双保险）**：**stdin EOF 主通道 + ppid 轮询兜底**。Electron 侧 `spawn` 改 `stdio: ['pipe','inherit','inherit']`，main 进程 crash 即刻 EOF；backend 在 `server.ts` 启动**第一行**（`startServer` 起手、在 `createServer()` 和路由挂载之前）挂 `process.stdin.on('end', shutdown)`。ppid 轮询以 `intervalMs = 500`（写死，不可配）为兜底，应对 stdin 被意外 repipe 的情况。两者任一触发即走 shutdown 流程。
- **shutdown 路径**：单点 `killAll('SIGTERM')` → 2s grace → `killAll('SIGKILL')`。`killAll` 内部遍历 `listAll()` 并发 `Promise.allSettled(kill)`，不被单个阻塞。
- **启动自清扫（S5）**：进程启动时扫描上轮残留。见 §3.5。

### MemoryManager 定位

- **不感知业务含义**：只认 `{ size(), evict(key) }` 接口。
- **统一策略**：上限 + TTL + LRU，每个集合独立配置。
- **水位监控**：超过 `warnThreshold` 打 stderr + emit `memory.warn` 事件（不 kill 任何东西，让业务或 oncall 决定）。
- **定期巡检**：`setInterval` 扫一遍所有 registered 集合，驱动 TTL 淘汰。

## 3. P0 九条修复方案

| # | 问题 | 定位 | 修复方案 |
|---|------|------|---------|
| 1 | 缺 `unhandledRejection`/`uncaughtException` | `http/server.ts:57-136` | `startServer` 起手挂两个 handler：stderr 打印 + emit `runtime.fatal` + shutdown 流程。Promise rejection 不 exit，只记录。 |
| 2 | `store.insert` 异常未捕获 | `comm/router.ts:71` | `try { this.store.insert } catch`：落 `route: 'dropped', reason: 'store-failure'`，stderr 打印原因；不吞，让调用方知道。 |
| 3 | host 模式 primary-agent 崩溃无自愈 | `primary-agent/primary-agent.ts:135-156` | **独立创建**一个 `createRestartPolicy(...)` 实例，和 `container.subscriber` **物理隔离**（S4）。算法复用，状态不共享——避免一个模块耗尽预算导致另一个受连累。`give_up` 时 emit `primary_agent.give_up`。 |
| 4 | Electron 父死子不随 | `renderer/electron-main/backend.ts` + `http/server.ts` 起手 | 前端：`spawn(..., { detached: true, stdio: ['pipe','inherit','inherit'] })`；`stopBackend` 用 `process.kill(-child.pid, 'SIGTERM')` 组播 + 2s SIGKILL（S1）；`app.on('before-quit', stopBackend)`。后端：**server.ts 起手第一行** `process.stdin.on('end', shutdown)` + `watchParentAlive(shutdown, { intervalMs: 500 })` 双保险（F3）。 |
| 5 | 新旧 WsBroadcaster 并存 | `bus/subscribers/ws.subscriber.ts:69-117` vs `ws/ws-broadcaster.ts` | 两步迁移，边界清晰（S3）：**W1-8** 新增 `ws/event-types.ts` 并把 `bus/subscribers/ws.subscriber.ts` 改为 re-export + 保留 `WsBroadcaster` class（暂不删，保证导入不破）；**W2-5** 删除 class + 清理 `bus/index.ts:27,73,82` 的 `wsBroadcaster` 实例化点，改全部走 `http/server.ts` 已有的 `ws/ws-broadcaster.ts` 新实现。W1-8 与 W2-5 中间任何时刻均可编译运行。 |
| 6 | `driver.prompt` 悬挂 | `agent-driver/driver.ts:63-81` | `PROMPT_TIMEOUT_MS = 2 * 60 * 1000`（2 分钟，S2），可由 `DriverConfig.promptTimeoutMs` 覆写。**双路 race**：timeout 定时器 + `handle.onExit` 立即 reject，任一先触发即 `status = READY` + emit `driver.error`。避免进程早死但 prompt 卡 2 分钟。 |
| 7 | replay `markRead` 先于 write | `bus/subscribers/member-driver/replay.ts:40-42` | 改为 `await driver.prompt(text)` 成功 **之后** 才 `markRead`（当前已是这个顺序，但未保证 prompt 成功的语义）—— 加入 prompt 成功判断：`driver.status === 'READY'` 视为成功；失败不 markRead，留下一轮重试。 |
| 8 | Codex 临时文件 crash 时泄漏 | `agent-driver/adapters/codex.ts:40-51, 166-174` | 临时文件路径登记进 ProcessManager 的 `onExit` hook；进程死亡时统一 unlink。adapter 不再自己 try-finally。 |
| 9 | container teardown 不 kill 子进程 | `bus/subscribers/container.subscriber.ts:93-96` | master.add 的 teardown cb 里：对所有仍在 `registry.list()` 的 entry 调 `entry.handle.kill()`（await Promise.allSettled）；由于 F1 已组播，子孙一起走。 |

### 3.5 启动自清扫（S5）

backend 进程**首次** `startServer()` 调用的最前段（fatal handler 之后、parent-watcher 之前），执行 **best-effort** 扫描：

- 读 `~/.claude/team-hub/pid.snapshot`（ProcessManager 正常退出时写入 pid 清单；crash 时文件残留）。
- 对清单中每个 pid，`try { process.kill(-pid, 'SIGTERM') } catch {}`，2s 后再 `SIGKILL`。
- 清理完成后**覆盖写**新的空快照。
- ProcessManager 运行中每隔 10s / 有 register/unregister 时都同步写快照。

**范围限制**：只 kill 快照内的 pid，不做 `pgrep -f spawn-helper` 盲扫（盲扫会误杀用户其他项目的 Electron / 测试进程）。如果当前的 463 僵尸没有快照作证据，**需手动 `pkill -f spawn-helper`**（发版说明里写一次清理指令）。后续靠 F1 组播 + F2 统一入口 + F3 父死子随联合保证不再累积。

## 4. 验收标准

### 4.1 功能性

- [ ] Dogfood 运行 30 分钟后 `pgrep -f spawn-helper | wc -l` == 0（当前：463；手动清零后）。
- [ ] **F1 组播**：随便 kill 一个 `claude` / `codex` 主进程，其 `spawn-helper` / node-pty 子孙 30s 内全退（`pgrep -P <pid>` 为空）。
- [ ] **F2 强制入口**：grep `child_process.spawn` 只出现在 `process-runtime/*.ts`、`renderer/electron-main/backend.ts`、`mcp/server.ts`、`searchtools/server.ts`；业务 subscriber 无 `spawn` 直调。
- [ ] **F3 双保险**：Electron 强杀（`kill -9 <electron-main-pid>`）后 **2 秒内** backend 走 shutdown（stdin EOF 路径）；人为 repipe 模拟 stdin 假死，ppid 轮询 500ms 内接管，最多 1.5s 触发 shutdown。
- [ ] backend 崩溃（模拟：`throw` 未捕获 promise）后 shutdown 日志包含 `killAll completed`，所有子进程在 grace 内退出。
- [ ] `store.insert` 抛错不导致后续 envelope 丢失；router `dispatch` 返回 `{ route: 'dropped', reason }`。
- [ ] primary-agent 主动 crash 三次后自动停止并 emit `primary_agent.give_up`；DB status = STOPPED。primary 与 container 的 restartPolicy 预算不共享（S4 验证：container 达到 give_up 不影响 primary 的首次重启）。
- [ ] 单 ws 连接推同一事件一次（去重 id 稳定），无重复下发。
- [ ] **S2**：`driver.prompt` 超时 **2 分钟**自动返回；进程早死时 `onExit` 立即 reject，不等满超时；driver 状态回到 READY，不卡死。
- [ ] replay markRead 只在 prompt 成功时发生；模拟 driver.stop 期间收到的 5 条未读，下次上线全部可见。
- [ ] Codex 进程 SIGKILL 后 `/tmp/mteam-codex-prompt-*.md` 不残留。
- [ ] **S5**：启动时读 `pid.snapshot` 清单内残留 pid 全部被回收；首次安装（无快照）启动不报错。

### 4.2 模块纯净性

- [ ] `process-manager/*.ts` `import` 语句不出现 `bus/` / `domain/` / `db/` / `http/` 路径。
- [ ] `memory-manager/*.ts` 同上。
- [ ] 每个新文件 ≤ 200 行。
- [ ] 两个模块各带独立单测，测试不启动真实 server（用 stub ProcessRuntime / stub 集合）。

### 4.3 观测

- [ ] 水位事件 `memory.warn`、`process.reaped`、`runtime.fatal` 三个新事件类型进入 `BusEventType` 并写入 log.subscriber。
- [ ] HTTP `/api/panel/runtime/status` 暴露当前 process / memory stats（只读）。

## 5. 非目标（本阶段不做）

- **替换 `process-runtime` 接口**：ProcessManager 挂在 Runtime 内部，**不改** `ProcessRuntime` / `RuntimeHandle` 对外契约。调用方看到的 `handle.kill` 行为升级（组播），签名不变。
- 跨机器进程管理 / systemd 级别集成。
- 前端展示内存水位图（数据先出来，UI 下一阶段）。
- MCP stdio 服务进程统一纳管（当前由 mcpManager 自己持有，Wave 3 再看）。
- **系统级 pgrep 盲扫**：本阶段不做，只清 pid.snapshot 清单。463 僵尸需发版前手动 `pkill -f spawn-helper` 清一次，靠 F1/F2/F3 保证不再累积。

## 6. 风险

- **`detached: true` + PGID 的跨平台限制**：macOS / Linux 上 `process.kill(-pid, sig)` 正确组播；**Windows 不适用**（没有进程组概念）。当前 Electron 仅支持 macOS，backend 部署目标同样是 mac/linux，可接受；若未来支持 Windows 必须换 `taskkill /T /F`。
- **`detached: true` 的 stdio 副作用**：detached 进程默认从父进程 stdio 分离；本设计显式传 `stdio: ['pipe','inherit','inherit']` 保留 ACP 协议通道（stdin/stdout pipe），不调 `child.unref()`——unref 会导致父进程不等子进程退出，与"父死子随 + shutdown 等待子退出"的语义冲突。Electron 侧的 `child.unref()` **取消**（原方案错误，本版修正）。
- **stdin EOF 与 bun `stdio:'ignore'` 冲突**：Electron backend 启动必须 `stdio: ['pipe', ...]` 才能让 backend 的 `process.stdin` 产生 `'end'` 事件。renderer 侧 backend.ts 必须保持 pipe；backend 侧不能调 `process.stdin.resume()` 之外的读，否则 EOF 语义丢失。
- **ppid 轮询在 Linux/macOS 的行为差异**：父死后进程 reparent 到 `init (1)` / `launchd (1)`，ppid 变 1；intervalMs=500 写死，1s 内一定能检测；stdin EOF 通道在 99% 场景先触发，轮询只兜底。
- `store.insert` 改异常路径后，上游 `route: 'dropped'` 分支需要回归：member-driver 上线回灌是否会无限 retry？ — 设计上不会，replay 只走 `findUnreadFor`，只读。
- **restartPolicy 独立实例 vs 共享算法**：primary-agent 和 container 各自 `createRestartPolicy()` 拿各自的 map。未来若要"总预算限制"，需新的聚合层——本阶段明确不做。
- **R4 · ProcessManager 入口唯一性靠契约而非运行时检测**：F2 强制入口的保证依赖 grep 守门（REGRESSION §1.3）+ code review，不在运行时拦截"绕过 Runtime 直接 spawn"。未来若新增 adapter 绕过 Runtime（例如为特殊 CLI 写原生 spawn），grep 判据会失效。防御方案：所有新增 spawn 必须走 `process-runtime/*.ts`，PR checklist 显式勾选；若必须在业务层起子进程，需架构师评审并在 `processManager` 上显式 `register`（公开 API 允许，但 grep 规则需同步放行白名单）。
- **R4（附）· tempFiles 两段接线的时间窗**：`adapter.prepareLaunch` 先写文件 → `runtime.spawn` 成功后调 `attachTempFiles` 之间存在一个短时窗。若此刻进程 crash，Runtime 的 onExit 先跑（tempFiles 尚未附着），临时文件不会被 Manager 清理。本阶段通过 spawn 失败分支的 `adapter.cleanup()` 兜底；正常 spawn 后 pid 存活到 attach 完成的时间窗可忽略（微秒级）。未来若改为 spawn 前就能拿到 pid（例如 fork-exec 分离），可把 attach 提前到 spawn 内部闭合。
