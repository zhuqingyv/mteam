# Stage 2 — 回归测试清单

> 测试员产出口径：**只看这一份**（WORKFLOW §6.7）。
> 开发员不参与执行，产出和验证分离（WORKFLOW §6.6）。
> 每条用例标注：
> - **对象**：验哪个模块
> - **前置**：怎么搭环境
> - **步骤**：按序操作
> - **预期**：断言点
> - **失败回退**：测不过要给修复员留什么信息

---

## 0. 执行原则

1. **不 mock db/bus**（WORKFLOW §6.3），用真实 `EventBus` / `memoryDb` / 内存 repo。
2. **不起真 ACP agent 子进程**：用 `MockRuntime` / `MockRuntimeHandle`（Stage 1 提供）
   配合 `FakeAdapter`（测试内定义，实现 `AgentAdapter` 4 个方法）。
3. **每条用例独立 setup / teardown**，不共享全局状态。
4. **覆盖率门槛**：
   - `driver.ts` 行覆盖 ≥ 90%
   - `bus-bridge.ts` 行覆盖 100%（翻译穷举）
   - `primary-agent.ts` 行覆盖 ≥ 80%
5. **eslint 兜底**：`agent-driver/` 目录下无 `node:child_process` / `node:stream` / `node-pty` import。

---

## 1. mod-driver-decouple 用例

### 1.1 构造注入 handle 后能完成 ACP 握手

- **对象**：`AgentDriver.start()`
- **前置**：
  - `const mock = new MockRuntimeHandle()`
  - `const driver = new AgentDriver('d1', minimalConfig, mock, new FakeAdapter())`
- **步骤**：
  1. 触发 `const p = driver.start()`（不 await）
  2. `await mock.expectRequest('initialize')` → `mock.respond({ protocolVersion: acp.PROTOCOL_VERSION, ... })`
  3. `await mock.expectRequest('session/new')` → `mock.respond({ sessionId: 'sess-1' })`
  4. `await p`
- **预期**：
  - `driver.status === 'READY'`
  - `driver.events$` 接收过一条 `{ type: 'driver.started' }`
  - `mock` 的 `stdin` 累计写过 2 条 JSON-RPC（initialize + session/new）
- **失败回退**：
  - 若 driver 调用了 `spawn` → mod-driver-decouple 未完成耦合删除
  - 若 `events$` 收不到 started → Subject 未连到 emit 通道

### 1.2 events$ 按顺序发出 started / text / turn_done

- **对象**：`AgentDriver.prompt()` 的事件流
- **前置**：同 1.1 完成握手到 READY
- **步骤**：
  1. `const events: DriverOutputEvent[] = []`
  2. `driver.events$.subscribe((ev) => events.push(ev))`（早订可补发即可）
  3. `const promptP = driver.prompt('hi')`
  4. `mock.pushSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })`
  5. `mock.respondPrompt({ stopReason: 'end_turn' })`
  6. `await promptP`
- **预期**：
  - `events.map(e => e.type)` 包含 `['driver.started', 'driver.text', 'driver.turn_done']`（顺序匹配）
  - `driver.status === 'READY'`（回到 READY，不卡在 WORKING）
- **失败回退**：
  - text 缺失 → adapter.parseUpdate 未挂钩
  - turn_done 缺失 → prompt 响应处理退化

### 1.3 runtime exit 时 driver 进入 STOPPED 并发 error + stopped

- **对象**：`handle.onExit` 订阅
- **前置**：1.1 完成握手到 READY
- **步骤**：
  1. 订阅 `events$` 到数组 `events`
  2. `mock.simulateExit(137, 'SIGKILL')`（模拟 OOM 被杀）
- **预期**：
  - `driver.status === 'STOPPED'`
  - `events` 末尾有 `{ type: 'driver.error', message: /code=137.*signal=SIGKILL/ }`
  - `events` 末尾还有 `{ type: 'driver.stopped' }`（顺序：error 先、stopped 后）
  - 不再后续 emit（Subject complete）
- **失败回退**：
  - 只有 error 没有 stopped → 未按"关键决策 A"实现
  - 状态仍为 READY → onExit 未挂钩

### 1.4 start() 超时（> 30s）会 teardown 并抛错

- **对象**：`START_TIMEOUT_MS` 分支
- **前置**：
  - `vi.useFakeTimers()` 或等价
  - `const mock = new MockRuntimeHandle()`（不回应 initialize）
  - `const driver = new AgentDriver('d1', cfg, mock, new FakeAdapter())`
- **步骤**：
  1. `const p = driver.start()`
  2. 推进假时钟 31s
  3. `await expect(p).rejects.toThrow(/start timeout/)`
- **预期**：
  - `driver.status === 'STOPPED'`
  - `events$` 发过 `driver.error`（message 含 "start timeout"）
  - `mock.kill` **未**被调用（默认不杀，由调用方处理）
- **失败回退**：
  - 若调到 `mock.kill` → teardown 里仍有杀进程残留代码

### 1.5 stop() 不 kill handle（责任在调用方）

- **对象**：`AgentDriver.stop()`
- **前置**：1.1 完成握手到 READY
- **步骤**：
  1. `const killSpy = vi.fn()`; 把 `mock.kill` 替换为 `killSpy`
  2. `await driver.stop()`
- **预期**：
  - `killSpy` 调用次数 = 0
  - `driver.status === 'STOPPED'`
  - `events$` 末尾有 `{ type: 'driver.stopped' }`
  - `adapter.cleanup()` 被调一次（Codex 临时文件场景）
- **失败回退**：
  - 若 killSpy 被调 → driver 越权杀进程，未按 §4.3 实现

### 1.6 重复 stop() 幂等

- **对象**：`AgentDriver.stop()` 的幂等性
- **步骤**：1.5 后再调 `await driver.stop()`
- **预期**：不抛错，`events$` 不会再发新事件（Subject 已 complete）

### 1.7 agent-driver/ 无 child_process / stream import

- **对象**：目录约束
- **步骤**：
  - `grep -RE "from 'node:(child_process|stream)'" packages/backend/src/agent-driver/`
  - `grep -R "require\('node:(child_process|stream)'\)" packages/backend/src/agent-driver/`
- **预期**：两条 grep 均无结果
- **失败回退**：指定文件删 import，把能力搬进 `process-runtime/`

---

## 2. mod-adapter-launch 用例

### 2.1 ClaudeAdapter.prepareLaunch 返回 LaunchSpec

- **对象**：`ClaudeAdapter.prepareLaunch`
- **步骤**：
  1. `const adapter = new ClaudeAdapter()`
  2. `const spec = adapter.prepareLaunch({ agentType: 'claude', systemPrompt: '', mcpServers: [], cwd: '/tmp', env: { FOO: 'bar' } })`
- **预期**：
  - `spec.runtime === 'host'`
  - `spec.command === 'npx'`
  - `spec.args` 包含 `'@agentclientprotocol/claude-agent-acp'`
  - `spec.env.FOO === 'bar'`
  - `spec.env.PATH` 存在（合并了 `process.env`）
  - `spec.cwd === '/tmp'`

### 2.2 CodexAdapter.prepareLaunch 写临时文件并传 -c 参数

- **对象**：`CodexAdapter.prepareLaunch`
- **步骤**：
  1. `const adapter = new CodexAdapter()`
  2. `const spec = adapter.prepareLaunch({ agentType: 'codex', systemPrompt: 'hello', mcpServers: [], cwd: '/tmp' })`
- **预期**：
  - `spec.runtime === 'host'`
  - `spec.args` 包含 `-c` 和一个形如 `model_instructions_file=/tmp/.../mteam-codex-prompt-*.md` 的 pair
  - 对应文件存在且内容 `=== 'hello'`
- **清理**：`adapter.cleanup()` 后文件被删

### 2.3 SpawnSpec 类型已删除

- **对象**：`agent-driver/types.ts`
- **步骤**：`grep -R "SpawnSpec" packages/backend/src/agent-driver/`
- **预期**：结果只能出现在迁移文档注释里或为空

### 2.4 prepareSpawn 旧名称清零

- **对象**：整个 `agent-driver/`
- **步骤**：`grep -R "prepareSpawn" packages/backend/src/agent-driver/`
- **预期**：无结果（连注释都清理掉更干净）

---

## 3. mod-bus-bridge 用例

### 3.1 attachDriverToBus 翻译 driver.started

- **前置**：
  - `const subject = new Subject<DriverOutputEvent>()`
  - `const received: BusEvent[] = []; const spy = bus.events$.subscribe((e) => received.push(e))`
- **步骤**：
  1. `const sub = attachDriverToBus('d1', subject.asObservable())`
  2. `subject.next({ type: 'driver.started' })`
- **预期**：`received` 最后一条形如 `{ type: 'driver.started', source: 'agent-driver', driverId: 'd1', ...base }`
- **清理**：`sub.unsubscribe(); spy.unsubscribe()`

### 3.2 翻译全量 7 种事件

对以下输入各跑一次断言：

| 输入 event | 预期 BusEvent 字段 |
|-----------|------------------|
| `{ type: 'driver.started' }` | `{ type: 'driver.started', driverId: 'd1' }` |
| `{ type: 'driver.stopped' }` | `{ type: 'driver.stopped', driverId: 'd1' }` |
| `{ type: 'driver.error', message: 'boom' }` | `{ type: 'driver.error', driverId: 'd1', message: 'boom' }` |
| `{ type: 'driver.thinking', content: 'x' }` | `{ type: 'driver.thinking', driverId: 'd1', content: 'x' }` |
| `{ type: 'driver.text', content: 'y' }` | `{ type: 'driver.text', driverId: 'd1', content: 'y' }` |
| `{ type: 'driver.tool_call', toolCallId: 't1', name: 'read', input: { a: 1 } }` | `{ type: 'driver.tool_call', driverId: 'd1', name: 'read', input: { a: 1 } }` |
| `{ type: 'driver.tool_result', toolCallId: 't1', output: {}, ok: true }` | `{ type: 'driver.tool_result', driverId: 'd1' }` |
| `{ type: 'driver.turn_done', stopReason: 'end_turn' }` | `{ type: 'driver.turn_done', driverId: 'd1' }` |

### 3.3 多 driverId 并存不串线

- **步骤**：
  1. `attachDriverToBus('a', subjA)` / `attachDriverToBus('b', subjB)`
  2. `subjA.next({ type: 'driver.started' })`
  3. `subjB.next({ type: 'driver.error', message: 'e' })`
- **预期**：bus 上收到 2 条事件，driverId 分别为 `a` / `b`，互不错乱

### 3.4 events$ complete 后 Subscription 自动结束

- **步骤**：
  1. `const sub = attachDriverToBus('d1', subj.asObservable())`
  2. `subj.complete()`
  3. 之后 bus 订阅再无新事件
- **预期**：`sub.closed === true`（RxJS Subscription 状态）

### 3.5 emitToBus 旧导出已删

- **步骤**：`grep -R "emitToBus" packages/backend/src/`
- **预期**：无结果（或仅剩测试的历史注释）

---

## 4. glue-primary-agent 用例

### 4.1 start 全流程 — runtime.spawn → driver.start → RUNNING

- **前置**：
  - `const runtime = new MockRuntime()`（Stage 1 提供）
  - `const primaryAgent = new PrimaryAgent(bus, runtime)`
  - `primaryAgent.configure({ cliType: 'claude', name: 't', ... })` 预置 row
- **步骤**：
  1. `const p = primaryAgent.start()`
  2. `runtime` 拿到 `spec` 后返回 `MockRuntimeHandle`
  3. 让 handle 完成 ACP 握手响应（initialize + session/new）
  4. `await p`
- **预期**：
  - `runtime.spawn` 被调用 1 次，`spec.command === 'npx'`、`spec.runtime === 'host'`
  - `readRow().status === 'RUNNING'`
  - bus 上有 `primary_agent.started` + `driver.started` 事件
  - `primaryAgent.isRunning() === true`

### 4.2 runtime.spawn 抛错 → driver 不创建

- **步骤**：
  1. 让 `runtime.spawn` reject（模拟镜像缺失）
  2. `await expect(primaryAgent.start()).rejects.toThrow(/spawn failed/)`
- **预期**：
  - `primaryAgent.isRunning() === false`
  - `readRow().status !== 'RUNNING'`
  - bus 上无 `driver.started`

### 4.3 driver.start 失败 → handle.kill 被调

- **步骤**：
  1. `runtime.spawn` 返回 handle
  2. handle 永不响应 initialize（触发 30s 超时；可用 fake timer 快进）
  3. `await expect(primaryAgent.start()).rejects.toThrow(/start timeout/)`
- **预期**：
  - `handle.kill` 被调 1 次（胶水负责杀）
  - `primaryAgent.isRunning() === false`
  - bus 上有 `driver.error` 但无 `primary_agent.started`

### 4.4 stop() 同时关 driver 和 handle

- **前置**：4.1 后到 RUNNING
- **步骤**：`await primaryAgent.stop()`
- **预期**：
  - `driver.stop()` 被调（events$ 收到 `driver.stopped`）
  - `handle.kill()` 被调 1 次（幂等，即使 driver 未 kill）
  - bus 上有 `primary_agent.stopped`
  - `readRow().status === 'STOPPED'`

### 4.5 runtime 进程崩溃 → handleDriverStopped 路径

- **前置**：4.1 后到 RUNNING
- **步骤**：`handle.simulateExit(137, 'SIGKILL')`
- **预期**：
  - driver 内部 emit `driver.error` + `driver.stopped`
  - `handleDriverStopped` 触发
  - `readRow().status === 'STOPPED'`
  - `handle.kill` 被调（幂等，已退出则 no-op）
  - bus 上有 `primary_agent.stopped`

### 4.6 configure 切换 cliType 触发 stop → start

- **前置**：claude 已跑在 RUNNING
- **步骤**：`await primaryAgent.configure({ cliType: 'codex', ... })`
- **预期**：
  - 先 stop（旧 driver + 旧 handle 都清）
  - 再 start（新 runtime.spawn，`spec` 的 command 对应 codex 参数）
  - 最终 `readRow().cliType === 'codex'` 且 status === 'RUNNING'

### 4.7 events$ 被 bus-bridge 正确挂接

- **前置**：4.1 到 RUNNING
- **步骤**：
  1. 让 handle 推 `agent_message_chunk` 模拟 agent 说话
  2. 监听 bus.events$
- **预期**：bus 上能看到 `driver.text` 事件，`driverId === row.id`

---

## 5. 横向回归（现有单测不破）

执行 `pnpm -F backend test` 全量，断言：

- `packages/backend/src/agent-driver/__tests__/*.test.ts` —— 若原有 `driver.test.ts` 依赖真 spawn，需确认已切换到 MockRuntimeHandle
- `packages/backend/src/primary-agent/__tests__/*.test.ts` —— 全部通过
- `packages/backend/src/bus/__tests__/*.test.ts` —— 不受影响
- 其他模块单测（role-instance / cli-scanner / mcp-store 等）—— 不触碰，应全部绿

**若某条原有单测挂掉**：
- 先诊断是"被影响的合理调整"还是"新代码引入的 regression"
- 前者：修单测（调用方升级到新构造签名）
- 后者：退回修复员，不改测试姑息

---

## 6. 静态检查

- `pnpm tsc --noEmit`：全仓绿
- `pnpm lint`：`agent-driver/` 目录的 `no-restricted-imports` 规则触发 0 次
- `grep` 清零项（汇总上文）：
  - `spawn(` 在 `agent-driver/driver.ts` 无结果
  - `prepareSpawn` 全仓无结果
  - `SpawnSpec` 全仓无结果
  - `emitToBus` 全仓无结果（以 `attachDriverToBus` 替代）
  - `node:child_process` / `node:stream` / `node-pty` 在 `agent-driver/` 无结果

---

## 7. 报告模板

测试员执行完后在 `docs/phase-sandbox-acp/stage-2/TEST-REPORT.md` 产出：

```markdown
# Stage 2 测试报告

- 执行日期：YYYY-MM-DD
- 执行者：<name>

## 用例结果

| 用例 | 结果 | 备注 |
|------|------|------|
| 1.1 握手 | ✅ / ❌ | |
| 1.2 events$ 顺序 | | |
| ... | | |

## 静态检查
- tsc：✅
- lint：✅
- grep 清零：✅

## 覆盖率
- driver.ts：__%
- bus-bridge.ts：__%
- primary-agent.ts：__%

## 未通过项的最小复现
- <case>: <reproducer command / diff>

## 结论
- 是否通过：是 / 否
- 若否，需修复员改的文件：[...]
```
