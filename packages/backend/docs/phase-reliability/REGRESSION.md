# Phase · Reliability — Regression Checklist

所有 Wave 2 合并后、发版前跑一遍。标注 [auto] 的进 `bun test`；标注 [manual] 的走 dogfood。

## 1. 进程生命周期 [manual 除非注明]

### 1.1 僵尸清零
- [ ] **预备**：发版前手动 `pkill -f spawn-helper` 清一次（463 历史残留）。
- [ ] 启动 backend，跑 30 分钟常规工作流（建 team、发消息、回放）。
- [ ] `pgrep -f spawn-helper | wc -l` == 0。
- [ ] `ps -ef | grep -E "claude\|codex\|npx" | grep -v grep | wc -l` 与 `/api/panel/runtime/status` 返回的 processes.count 一致。

### 1.2 PGID 组播（F1）[auto + manual]
- [auto] `process-runtime/__tests__/host-runtime.test.ts`：spawn 一条 shell 命令，让它内部 `bash -c 'sleep 300 & sleep 300'` 生一个孙子；`handle.kill()` 后 500ms 内 `pgrep -P <pid>` 返回空。
- [auto] `kill` 对 PGID 发送失败（EPERM）时 fallback 到 `child.kill(sig)`，不抛。
- [manual] `bun run ...backend` 起 primary-agent，记录 claude 主进程 pid + spawn-helper pid；`http DELETE /api/panel/primary-agent` → 两者 30s 内都消失。

### 1.3 强制统一入口（F2）[auto]
- [ ] `grep -rn "child_process.spawn\|cp.spawn\|\{ spawn \}" packages/backend/src/` 输出只含：
  - `process-runtime/host-runtime.ts`
  - `process-runtime/docker-runtime.ts`
  - `mcp/server.ts`（独立 MCP server，本阶段非目标）
  - `searchtools/server.ts`（同上）
  - `__tests__/` 下的测试文件
- [ ] 业务 subscriber（`bus/subscribers/*`、`primary-agent/*`、`member-driver/*`）0 处直调 spawn。
- [ ] `processManager.listAll()` 在跑 2 个 primary + 3 个 member 时返回 5 条。

### 1.4 Electron 父死子随（F3 双保险）
- [manual] **stdin EOF 主通道**：启动 Electron，记录 backend pid + 子进程 pid；`kill -9 <electron-main-pid>`；**2 秒内** backend stderr 可见 `shutdown via stdin.end`。
- [manual] **ppid 轮询兜底**：手工把 backend 的 stdin 断开但父进程保留（`ls -l /proc/<pid>/fd/0` + `gdb` 等手段，或代码测试 `process.stdin._readableState.ended = true` 但不 emit end）；ppid 轮询应在 1.5s 内触发 shutdown。
- [ ] 5 秒内所有 backend 子进程退出（`ps` 验证）。
- [ ] 残留文件：`/tmp/mteam-codex-prompt-*.md` 不存在。

### 1.5 backend 崩溃 shutdown
- [ ] 注入 `throw new Error('boom')` 在未 await 路径。
- [ ] stderr 可见 `[v2] runtime.fatal …` + `killAll completed`。
- [ ] 子进程全部退出。
- [ ] `~/.claude/team-hub/pid.snapshot` 非空（crash 时未及时清理）。

### 1.6 启动自清扫（S5）[auto + manual]
- [auto] `bootstrap-cleanup.test.ts`：预写 snapshot 含 1 个已死 pid + 1 个正跑 pid，启动后正跑 pid 活着，死 pid 无影响，snapshot 被清空。
- [manual] 用上一次 crash 残留的 snapshot 重启 backend → 日志 `reaped N stale processes`，所有残留子孙退出。
- [manual] 首次安装（无 snapshot）启动不报错。

### 1.7 Container teardown
- [ ] `bootSubscribers` 后启动一个 sandbox agent。
- [ ] `teardownSubscribers()`。
- [ ] 被 spawn 的容器进程**及其子孙**退出（PGID 组播）；ContainerRegistry.size()==0。

---

## 2. 错误捕获 [auto]

### 2.1 unhandledRejection handler
- [ ] `test/http/fatal-handlers.test.ts`：注入 `Promise.reject('x')`，handler 触发 emit `runtime.fatal` 且不调 `process.exit`。

### 2.2 uncaughtException handler
- [ ] 同上，抛同步错误，handler 触发 + 走 shutdown。

### 2.3 store.insert 异常
- [ ] `test/comm/router.test.ts`：MessageStore stub `insert` 抛错，`dispatch` 返回 `{ route: 'dropped', reason: 'store-failure' }`，不吞错。

---

## 3. 自愈 [auto + manual]

### 3.1 primary-agent host 崩溃重启
- [auto] 单测：stub driver 发 `driver.error`，policy 返回 restart → `start()` 被调一次。
- [auto] stub policy 返回 give_up → 无 `start()` 调用；emit `primary_agent.give_up`。
- [manual] 强杀 claude 进程三次，第三次后 UI 显示 STOPPED 不再自动起。

### 3.2 S4 restartPolicy 物理隔离
- [auto] 同一测试里同时跑 container.subscriber 和 primary-agent：让 container 达到 `give_up`，触发 primary 的第一次 crash，policy 仍返回 restart（证明两者 map 不共享）。
- [auto] 反向：primary 达到 give_up，container 的 policy 仍能正常 onCrash。

### 3.2 member-driver 崩溃（不在本阶段范围）
- [ ] 无回归要求，记录当前行为：崩溃后不重启，等 `instance.offline_requested`。

---

## 4. WebSocket [auto]

### 4.1 白名单迁移中间态（W1-8 合并后、W2-5 未合并时）
- [ ] grep `export const WS_EVENT_TYPES` 只在 `ws/event-types.ts`。
- [ ] `bus/subscribers/ws.subscriber.ts` 可 import 成功（re-export + 保留 class）。
- [ ] `bun test` 全绿 — 保证 W1-8 合并中间态不破。

### 4.2 删除后状态（W2-5 合并）
- [ ] `test/bus-integration.test.ts`：emit 单条 `instance.created`，单连接收 1 条 WsEventDown（删前可能 2 条）。
- [ ] 事件 id 稳定（两个连接收到的 id 相同）。
- [ ] grep `new WsBroadcaster` 只剩 `http/server.ts:65`。
- [ ] grep `export.*wsBroadcaster` 为 0。

---

## 5. driver.prompt 超时（S2 双路 race）[auto]

- [ ] `test/agent-driver.test.ts`：
  - stub conn.prompt 永不 resolve → **2 分钟**后超时；status=='READY'；emit `driver.error` message=='prompt timeout'；后续 prompt 可正常发起。
  - stub 中途 handle.onExit 触发 → **立即** reject（不等 2 分钟，通过 fake timer 验证 setTimeout 未触发）；status=='STOPPED'；emit `driver.error` message 含 'process exited'。
  - 正常 prompt 完成 → 定时器被 clear（fake timer 计数 == 0）。

---

## 6. Replay markRead 顺序 [auto]

- [ ] 注入 5 条未读；第 3 条 prompt 抛错。
- [ ] `store.findUnreadFor` 返回剩余 3 条（被抛错这条 + 后续 2 条）。
- [ ] 未抛错的前 2 条 `markRead` 被调用。

---

## 7. Codex 临时文件 [auto + manual]

- [auto] `test/agent-adapters.test.ts`：`prepareLaunch` + `SIGKILL` 模拟 → 文件被 ProcessManager 清理回调 unlink。
- [manual] 启动 codex 主 agent，`kill -9 <codex pid>` → `/tmp/mteam-codex-prompt-*.md` 消失。

---

## 8. MemoryManager 水位 [auto]

- [ ] 注册 Map，maxSize=10，warnThreshold=0.8。
- [ ] 灌 9 条 → emit `memory.warn`。
- [ ] 灌 11 条（LRU 策略）→ 最旧一条被 evict；size === 10。
- [ ] `unregister` 后 tick 不再扫描该集合。

### 8.1 集合纳管验证
- [ ] 启动后 `/api/panel/runtime/status` 返回至少四个集合：
      `driverRegistry` / `containerRegistry` / `subscriptionManager` / `turnHistory`。
- [ ] 压测灌 300 driver → driverRegistry.size 稳定在 200（LRU）。

---

## 9. 兼容性回归 [auto，全量]

- [ ] `bun test` 全绿。
- [ ] `packages/backend/src/__tests__/*` 的以下文件人肉 review：
  - `bus-integration.test.ts`（broadcaster 去重）
  - `primary-agent.test.ts`（自愈）
  - `team-lifecycle-ws.test.ts`（WS 白名单）
  - `agent-driver.test.ts`（prompt 超时 + status 回退）
  - `comm/router.test.ts`（store.insert 异常分支）
- [ ] 无新 `console.log`（用 stderr）。
- [ ] 无新 `any`（类型契约不降质量）。

---

## 10. 人工烟雾 [manual]

- [ ] 建 team（3 成员）→ 每人发两轮 → 全部在线可见。
- [ ] 其中一成员下线时群发 → 下次上线 replay，消息顺序不乱。
- [ ] 强杀其中一成员 pty → 短时重连 → 消息恢复，markRead 正确（不重发已读）。
- [ ] Electron 切后台 / 前台反复 5 次 → 连接数在 subscriptionManager stats 不泄漏。
- [ ] 持续运行 2 小时 → `/api/panel/runtime/status` 的 memory stats 无线性增长。

---

## 交付前 checklist

- [ ] 本文所有 [auto] 全绿。
- [ ] 本文所有 [manual] 至少跑过一次并截图 / 日志存档。
- [ ] 残留 `spawn-helper` 复测：0。
- [ ] dogfood 一晚无 OOM / 僵尸。
- [ ] 发版说明写明：**首次升级需手动 `pkill -f spawn-helper` 清历史残留一次**（S5 非目标）。

## 失败回滚

- Wave 2 内任务如回归发现破坏性行为（例如 W2-5 导致 WS 消息彻底不推），允许回滚该单任务 commit；Wave 1 不允许回滚（纯新增，不影响现有路径）。
- 回滚优先级：W2-5 > W2-4 > W2-6 > 其他（越贴近核心路径越优先回滚）。
