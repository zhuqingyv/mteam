# Stage 2 测试报告

- 执行日期：2026-04-25
- 执行者：tester

## 全量单测

命令：`bun test packages/backend/src/`

稳定性（连续 6 次运行）：

| 运行 | pass | fail | errors | 说明 |
|------|------|------|--------|------|
| 1 | 419 | 0 | 3 | exit 1（unhandled rxjs boom） |
| 2 | 437 | 0 | 3 | exit 1（同上） |
| 3 | 437 | 1 | 4 | bun runner 竞争：docker-runtime.test.ts 模块 late-load |
| 4 | 437 | 0 | 3 | exit 1（同上） |
| 5 | 437 | 0 | 3 | exit 1（同上） |
| 6 | 437 | 0 | 3 | exit 1（同上） |

偶发的 `1 fail` 经定位不是业务用例失败，而是 bun test runner 在并行调度时把 `docker-runtime.test.ts` 计数成 late-loaded 模块，报错 `Cannot call describe() after the test run has completed`。该文件独立跑 3 次 3 pass。与 Stage 2 代码无关。

关键目标模块独立运行均稳定：

| 测试文件 | pass | fail |
|----------|------|------|
| `src/__tests__/agent-driver.test.ts` | 5 | 0 |
| `src/__tests__/primary-agent.test.ts` | 16 | 0 |
| `src/__tests__/http-primary-agent.test.ts` | 7 | 0 |
| `src/agent-driver/__tests__/bus-bridge.test.ts` | 12 | 0 |

## TypeScript 编译

`cd packages/backend && bunx tsc --noEmit` — 零错误，零告警。

## 行数检查

| 文件 | 行数 | 上限 | 通过 |
|------|------|------|------|
| `agent-driver/driver.ts` | 147 | ≤150 | ✅ |
| `agent-driver/driver-events.ts` | 29 | ≤80 | ✅ |
| `agent-driver/bus-bridge.ts` | 58 | ≤100 | ✅ |
| `primary-agent/primary-agent.ts` | 186 | ≤200 | ✅ |

## 禁止 import 检查

- `grep -E "child_process|node-pty|emitToBus|new Subject" agent-driver/driver.ts` → 无匹配 ✅
- `grep -E "child_process|node-pty" primary-agent/primary-agent.ts` → 无匹配 ✅
- `grep -rn "SpawnSpec" packages/backend/src/ --include="*.ts"`（排除 tests） → 无匹配 ✅

## 契约一致性（对照 INTERFACE-CONTRACTS.md §4.1）

- `DriverLifecycleEvent` 三分支（started / stopped / error{message}） ✅
- `DriverOutputEvent = DriverEvent | DriverLifecycleEvent` ✅
- `driver-events.ts` 只暴露 `events$`（Observable），不暴露 Subject ✅
- 生命周期事件本体无 `driverId`（由 bus-bridge 注入） ✅
- 注意：`driver.tool_result` 在 `types.ts` 有 `output: unknown; ok: boolean` 字段，契约 §4.1 简写只列 `toolCallId`；根据契约 §4.1 原注释"对齐 types.ts Stage 2 前已有，保留不改"，判定为契约文档简写，非实现漂移。

## Stage 1 回归

`bun test packages/backend/src/process-runtime/` → 41 pass / 0 fail（3 文件） ✅

## README 完整性

- `packages/backend/src/agent-driver/adapters/README.md` — 存在（2776 字节） ✅
- `packages/backend/src/primary-agent/README.md` — 存在（7500 字节） ✅

## 总结

**通过**。

说明：
- 全量测试套件中偶发的 `1 fail` 为 bun test runner 并行调度的 late-load 竞争问题（`docker-runtime.test.ts` 模块在 run 结束后被解析），与 Stage 2 交付无关；独立运行该文件稳定 3 pass / 0 fail。
- Stage 2 所有交付目标（driver 解耦、adapter.prepareLaunch、bus-bridge 翻译、primary-agent 胶水、README）均达标。
- 行数 / 禁止 import / 契约 / Stage 1 回归 / README 全绿。

建议（非阻塞）：
- 与修复员一起看一下 bun runner 并行 shard 下 `Cannot call describe() after the test run has completed` 的偶发现象，可能需要将 `docker-runtime.test.ts` 放到更早 shard 或改用 `preload`；不影响本次交付。
- 全量 `bun test` 在 subscriber `boom` 单测后仍遗留 3 个 rxjs unhandled error（来自 `subscribers/comm-notify.subscriber` 的故意抛错测试），导致 exit 1。与 Stage 2 无关，但会让 CI 挂。可选后续清理。
