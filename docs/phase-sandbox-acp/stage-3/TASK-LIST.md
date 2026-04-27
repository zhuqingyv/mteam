# Stage 3 — 成员 Agent 迁移 ACP + 废弃 PTY / TASK-LIST

> 设计文档：`docs/phase-sandbox-acp/stage-3-member-acp.md`
> 工作流规范：`docs/phase-sandbox-acp/WORKFLOW.md`
> 依赖：Stage 1（process-runtime 抽象，供 DockerRuntime 扩展用，Stage 3 仍走默认 HostRuntime）+ Stage 2（AgentDriver 纯协议层，events$ 模式）
> 下游：Stage 4（内置 MCP HTTP 化）

---

## 0. 总体策略

Stage 3 的实质是"成员 agent 从 PTY 切 ACP"+"消息注入从轮询切推模式"+"PTY 代码整体下线"。改动同时跨 **agent-driver、bus/subscribers、comm/router、mcp/tools、domain-sync、types**，模块耦合重，一次性大爆炸会失控。

拆分原则：

1. **非业务模块（Wave 1，可并行）**：纯函数 / 无状态单例，不依赖 bus、db、全局配置，能独立单测。
2. **业务模块（Wave 2，串接胶水）**：依赖 Wave 1 的产物 + bus + db + domain，负责事件编排、时序控制、错误传播。Wave 1 全部合并后才启动。
3. **类型与接口注入点（Wave 1 末尾同步）**：`bus/types.ts` 的新事件字段、`CommRouter` 的 `driverDispatcher` 注入点先定，其他模块并行实现。
4. **旧代码清理（Wave 3）**：`pty/` 目录删除放在集成测试通过之后，独立 PR 合入（不保留回滚开关，PTY 一次性下线）。

所有模块单文件 ≤ 200 行（超过就拆）；README.md 必须写明非业务 vs 业务的差别字段。

---

## 1. 前置契约（架构师冻结，不是任务）

> 这一节由架构师在拆模块之前固化，Wave 1/2 的所有模块都按这些契约编码。契约一旦锁定，各模块并行实现，互不阻塞。

### 1.1 `driverId` 约定

- **成员 driverId === RoleInstance.id**。与 Primary Agent 的 "driverId === primaryAgentRow.id" 同构。
- bus 上的 `driver.*` 事件 `driverId` 字段足够定位到唯一成员 / 主 agent。消费者按 driverId 过滤。

### 1.2 `CommRouter.driverDispatcher` 注入点

`packages/backend/src/comm/router.ts`：

```ts
export type DriverDispatcher = (memberInstanceId: string, text: string)
  => Promise<'delivered' | 'not-ready' | 'not-found'>;

export interface RouterDeps {
  registry: CommRegistry;
  offlineStore?: typeof offline;
  driverDispatcher?: DriverDispatcher;   // ← 新增，可选，测试好 mock
}
```

`dispatch()` 在线分支优先级：

1. `driverDispatcher(id, formattedText)` 返回 `'delivered'` → `route='local-online'` 返回
2. 返回 `'not-ready' | 'not-found'` → 继续按原逻辑试 socket
3. socket 也不通 → `offline.store`

Router **不 import agent-driver**；dispatcher 由 `CommServer` 构造时从外部透传。

### 1.3 `DriverRegistry` 合约

```ts
// packages/backend/src/agent-driver/registry.ts
export class DriverRegistry {
  register(driverId: string, driver: AgentDriver): void;
  unregister(driverId: string): void;
  get(driverId: string): AgentDriver | undefined;
  list(): AgentDriver[];
  clear(): void;
}
export const driverRegistry: DriverRegistry; // 进程级单例
```

- `AgentDriver.start()` 成功后由业务侧（`member-driver.subscriber`、`primary-agent`）显式调 `register()`
- `AgentDriver.stop()` 或 `driver.stopped / driver.error` 后由同一业务侧显式调 `unregister()`
- **registry 不监听 bus**（保持纯净，不 import bus）；注册/注销动作由胶水层负责

### 1.4 `formatMemberMessage` 合约

```ts
// packages/backend/src/member-agent/format-message.ts
export function formatMemberMessage(payload: {
  from: string;               // 'local:<id>' | 'local:system'
  kind?: 'system' | 'chat';
  summary: string;
  content?: string;
  action?: string;            // system: 'deactivate' / 'member_activated' ...
}): string;
```

规则（与设计文档 §3.2 对齐）：

- `kind === 'system'`：`"[系统消息] ${action ?? 'notice'}: ${summary}"`
- 其他：`"[来自 ${fromDisplay}] ${summary}\n\n${content ?? ''}"`，`fromDisplay` 取 `from` 的 id 部分；找不到就回落到原 address。

### 1.5 离线 replay 时序合约

- `driver.start()` 成功 → 业务侧在 **register 之后、一次性** 调 `offline.replayFor(memberInstanceId)`，把拿到的 `Message[]` 逐条 `driver.prompt(formatMemberMessage(m.payload))`；每条成功后 `offline.markDelivered(m.id)`。
- Replay 全程串行（`for (const m of pending) await driver.prompt(...)`），避免 WORKING 状态冲突。
- Replay 发生在"注册 → 新消息派发"之间，**新消息可能在 replay 期间到达**：派发侧走 router，router 查 registry → 命中 → `driver.prompt(...)` → driver 内部队列保证串行；架构师的假设是"driver.prompt 串行化由 driver 层保证"，这是 Stage 2 的责任；Stage 3 的 member-driver 业务层不做二次队列。竞态分析见 §3.3 业务模块 README。

### 1.6 事件白名单

- `bus/types.ts`：`pty.spawned / pty.exited` 从 `BusEventType` + 联合 + interface 全部删除。
- `bus/subscribers/ws.subscriber.ts`：`WS_EVENT_TYPES` 删除 `pty.*`（`driver.*` 已在 Stage 2 加入，不用动）。
- 所有替代路径走 `driver.*` 系列（已在 Stage 2 落地）。

---

## 2. Wave 1 — 非业务模块（并行开发）

### Task W1-1 · `agent-driver/registry.ts`
**负责人**：待分配 · **状态**：pending

**目录**：`packages/backend/src/agent-driver/`

**输出**：
- `registry.ts` — 按 §1.3 合约实现 `DriverRegistry` + 导出 `driverRegistry` 单例
- `registry.test.ts` — 覆盖：register/get/unregister 正反双向、重复 register 后 get 拿到最新、clear、list
- `README.md` — **非业务模块**：一句话 + 接口签名 + 使用示例 + 注意事项（"不 import bus、不订阅事件、由胶水显式调用"）

**约束**：
- 单文件 ≤ 60 行
- 不 import 任何 `bus/*`、`domain/*`、`db/*`
- 只依赖 `./driver.js` 的类型
- 测试不 mock（Map 操作，天然纯函数）

**验收**：`grep -r "driverRegistry" packages/backend/src` 仅命中本模块 + 后续胶水层

---

### Task W1-2 · `member-agent/prompt.ts` + `format-message.ts`
**负责人**：待分配 · **状态**：pending

**目录**：`packages/backend/src/member-agent/`

**输出**：
- `prompt.ts` — 从 `pty/prompt.ts` **原样迁移** `AssemblePromptInput` + `assemblePrompt()`
- `prompt.test.ts` — 原有测试照搬（若没有就补：leader / 非 leader / 无 task 三种组合的快照）
- `format-message.ts` — §1.4 合约
- `format-message.test.ts` — system action 分支 + chat 分支 + `from` 解析 + 缺字段兜底
- `README.md` — 说明两个纯函数的职责、字段含义、示例输出

**约束**：
- 两个文件各 ≤ 80 行
- 纯函数、零外部依赖（除 node 内建）
- 不 import `pty/`（原 pty/prompt.ts 本期底删，迁移时同步清掉旧文件引用 —— 这一步的"清掉"由 W2-1 完成，W1-2 只负责建新文件）

**验收**：`pty/prompt.ts` 的导出集在新位置 100% 还原；format 规则与设计文档 §3.2 对齐

---

### Task W1-3 · `member-agent/driver-config.ts`（纯函数版）
**负责人**：待分配 · **状态**：pending
**依赖**：W1-2（import `assemblePrompt`）

**目录**：`packages/backend/src/member-agent/`

**输出**：
- `driver-config.ts` — 导出纯函数 `buildMemberDriverConfig()`；**不 import `mcp-store/mcp-manager`，不 import `domain/*`，不访问全局单例**
- `driver-config.test.ts` — 纯内存 fixture（普通对象即可，不起 SQLite、不起 mcpManager）：构造 input 对象 → 断言产物；无 mock、无测试 DB
- `README.md` — 说明输入 → 输出映射；强调"本模块是纯函数，所有外部状态（template、instance、resolved mcp）由调用方（Wave 2 胶水层）先解析好再传进来"；`isLeader=false`、`systemPrompt=assemblePrompt(...)`、`ROLE_INSTANCE_ID` env 约定

**接口（新版，纯函数）**：
```ts
import type { ResolvedMcpSet } from '../mcp-store/types.js';  // 仅 import type
import type { DriverConfig } from '../agent-driver/types.js';  // 仅 import type

export interface BuildMemberDriverConfigInput {
  // 调用方先从 domain/db 里取出来再塞进来——本模块不碰仓储
  instance: {
    id: string;
    memberName: string;
    leaderName: string;
    task?: string;
    runtimeKind?: 'host' | 'docker';
  };
  template: {
    persona?: string;
    role?: { cliType?: string };
  };
  // 调用方先跑 mcpManager.resolve() 再把产物传进来——本模块不调 mcpManager
  resolvedMcps: ResolvedMcpSet;
  cwd?: string;
}
export function buildMemberDriverConfig(input: BuildMemberDriverConfigInput): {
  config: DriverConfig;
  skipped: string[];
};
```

- `agentType` 取 `template.role.cliType`，为空默认 `'claude'`；需复用 primary 的 `cliTypeToAgentType()` 时**通过 import 复用**，不复制字符串映射
- `systemPrompt`：`assemblePrompt({ memberName: instance.memberName, isLeader: false, leaderName: instance.leaderName, persona: template.persona, task: instance.task })`
- `mcpServers`：**Stage 3 阶段**直接把 `resolvedMcps.configJson.mcpServers` 透传（保持与 Stage 3 设计一致，stdio 链路不断）；**Stage 4 W2-B 会把 mcp 产物的组装收口到 `launch-spec-builder`**，本模块届时改成接收 `McpServerSpec[]` 或由 builder 调用
- `env`：`ROLE_INSTANCE_ID=instance.id`、`CLAUDE_MEMBER=instance.memberName`、`IS_LEADER='0'`、`TEAM_HUB_NO_LAUNCH='1'`

**约束**：
- ≤ 120 行（比旧版更小，因为不做 resolve 调用）
- **不** import `bus/*`、`pty/*`、`domain/*`、`mcp-store/mcp-manager`；只允许 `import type` 跨模块类型
- 不起 SQLite、不访问任何全局单例

**验收**：
- `grep -n "mcpManager\|RoleInstance\|RoleTemplate " packages/backend/src/member-agent/driver-config.ts` 无命中（只能出现 `import type` 的类型别名）
- 装配结果 `config.mcpServers` 与旧 `pty/manager.ts` 写 tmp JSON 的结果逻辑一致（diff 只剩 transport 字段字符串差）
- `config.systemPrompt === assemblePrompt(...)` 全等

**与 Wave 2 胶水层的职责边界**：
- 谁去 `RoleTemplate.findByName` / `RoleInstance.findById` → W2-1（member-driver-lifecycle 胶水）
- 谁去 `mcpManager.resolve(...)` → W2-1 胶水
- 本 W1-3 只做"拿齐的数据 → DriverConfig"这一步的纯函数转换——归类回 Wave1（非业务）

---

### Task W1-4 · `bus/types.ts` 删除 `pty.*` 事件 + `ws.subscriber.ts` 白名单同步
**负责人**：待分配 · **状态**：pending

**目录**：`packages/backend/src/bus/`

**输出**：
- `types.ts` patch：从 `BusEventType` 联合删 `'pty.spawned' | 'pty.exited'`，删 `PtySpawnedEvent / PtyExitedEvent` interface，删 `BusEvent` 联合对应两项
- `ws.subscriber.ts` patch：`WS_EVENT_TYPES` 去掉 `'pty.spawned' / 'pty.exited'`
- 同步修改 `ws.subscriber.test.ts`（若有）
- README 不需要（改动在已有模块）

**约束**：
- 本 task 只做删除 + 同步 ws 白名单，不动任何其他订阅者
- 删除后 `tsc --noEmit` 必须还能通过（预期会报错：`pty.subscriber.ts`、`domain-sync.subscriber.ts`、`bus/index.ts` 仍在引用）
- 所以**本 task 在 Wave 1 最后合并**，合并前给 W2-1、W2-2、W2-3 留口子；为了避免 TS 报错卡住主线，W1-4 写成"带 @deprecated JSDoc 但保留类型导出"，真正的物理删除由 W2-3 接手在最后一刀

**修订**：W1-4 的实质工作是**给 pty 事件加 `@deprecated` 注释 + 在 `ws.subscriber.ts` 的白名单里注释掉**，让 Wave 2 订阅者代码拿到明确信号："不要再新增 pty.* 的订阅"。物理删除由 W2-3 完成。

---

### Task W1-5 · `CommRouter.driverDispatcher` 注入点
**负责人**：待分配 · **状态**：pending

**目录**：`packages/backend/src/comm/`

**输出**：
- `router.ts` patch：§1.2 合约，新增 `DriverDispatcher` 类型 + `RouterDeps.driverDispatcher` 可选字段 + `dispatch()` 在线分支优先试 driver 再回退 socket
- `router.test.ts` 补用例：
  - 注入 fake dispatcher 返回 `'delivered'` → 不调 socket
  - 返回 `'not-ready'` → 走 socket（同在线分支）
  - 返回 `'not-found'` 且 registry 也没连接 → 走 offline
  - dispatcher 抛异常 → 吞异常 + 走 socket（防止成员挂掉拖垮 leader 发消息）
- `README.md`（在 comm/ 下首次建，可简）：说明注入点存在的意义

**约束**：
- router 本身**绝对不 import `agent-driver/*`**，保持"comm 只知道有个 dispatcher 函数"
- 单文件 ≤ 200 行（当前 92 行，加 dispatcher 后约 130 行）

**验收**：`grep -n "import.*agent-driver" packages/backend/src/comm/router.ts` 无结果

---

### Task W1-6 · `CommServer` 暴露 dispatcher 透传
**负责人**：待分配 · **状态**：pending
**依赖**：W1-5（需要 `DriverDispatcher` 类型）

**目录**：`packages/backend/src/comm/`

**输出**：
- `server.ts` patch：`CommServer` 构造 / `start()` 接受可选 `driverDispatcher`，透传给内部 `new CommRouter({ registry, driverDispatcher })`
- 测试：保留现有 `CommServer` 测试；新增"透传路径"用例（用 fake dispatcher 走一次 register→dispatch→driver 分支）

**约束**：
- 接口保持向后兼容（不传 dispatcher 时退化成旧行为）
- server 本身也不 import `agent-driver`

**验收**：`server.ts` 的 `new CommRouter(...)` 调用携带 dispatcher；现有单测全绿

---

## 3. Wave 2 — 业务模块（Wave 1 全完才启动）

### Task W2-1（统筹：业务胶水三拆）

原 W2-1 装了 4 件事（driver 生命周期 + mcp/domain 解析 + offline replay + pid 写回 + registry 注册），预估 220-260 行，必超 200 行红线。

**拆成三个独立任务，单文件各 ≤ 150 行，目录：`packages/backend/src/bus/subscribers/member-driver/`**

```
bus/subscribers/member-driver/
├── index.ts                      ~20 行，导出 subscribeMemberDriver()，聚合挂载三个子模块
├── lifecycle.ts                  W2-1a
├── replay.ts                     W2-1b
└── pid-writeback.ts              W2-1c
```

共享依赖：
- `driverRegistry`（Stage 3 W1-1）
- `buildMemberDriverConfig`（Stage 3 W1-3，纯函数）
- `mcpManager.resolve(...)`（由 lifecycle 统一调用，把产物传给 W1-3 纯函数）
- `RoleTemplate.findByName` / `RoleInstance.findById` / `instance.setSessionPid`（由 lifecycle / pid-writeback 分别调用）

---

### Task W2-1a · `member-driver/lifecycle.ts`
**负责人**：待分配 · **状态**：blocked(W1-1, W1-3, W1-4)

**目录**：`packages/backend/src/bus/subscribers/member-driver/`

**输出**：
- `lifecycle.ts` — 订阅 `instance.created` / `instance.deleted`，管 driver start/stop + registry 注册解注册
- `lifecycle.test.ts` — 用内存 SQLite + 真实 mcpManager（不 mock）：
  - `instance.created` 非 leader → resolve mcp → 调 `buildMemberDriverConfig` 得 DriverConfig → `new AgentDriver(instanceId, config).start()` 被调（stub AgentDriver 类验证 config 对齐）
  - `start` 成功后 `driverRegistry.get(instanceId)` 非空
  - `start` 抛异常 → 不注册 registry，不触发 replay，log 记一条
  - `instance.deleted` → `registry.unregister` + `driver.stop()`
  - `instance.created` 是 leader / template 不存在 / instance 不存在 → skip
  - 同一 instanceId 重复 `instance.created` → 先 teardown 旧 driver 再起新的（或 skip，需在 README 明确策略）
- `README.md` — 说明 lifecycle 子模块职责：只管 driver 生命周期 + registry；replay 与 pid 写回由兄弟模块承担

业务逻辑：
```text
instance.created (e)
  → template = RoleTemplate.findByName(e.templateName)
  → instance = RoleInstance.findById(e.instanceId)
  → skip if (template null | instance null | instance.isLeader)
  → resolvedMcps = mcpManager.resolve(template.availableMcps, { instanceId, hubUrl, commSock, isLeader: false })
  → { config } = buildMemberDriverConfig({ instance, template, resolvedMcps })
  → driver = new AgentDriver(e.instanceId, config)
  → try { await driver.start(); registry.register(e.instanceId, driver); emit 'member.driver.started' { instanceId, driver } }
  → catch: log + return

instance.deleted (e)
  → d = registry.get(e.instanceId); if !d return;
  → registry.unregister(e.instanceId); await d.stop();

bus 'driver.error' where driverId === member in registry
  → registry.unregister(driverId);
```

**约束**：
- ≤ 150 行
- **不**订阅 `pty.*`
- **绝对不 writeFileSync 任何 tmp MCP 配置**
- 不含 replay 逻辑、不含 pid 写回逻辑（交给兄弟模块，通过本模块 emit 的 `member.driver.started` 事件或直接 await 链式触发）

**竞态分析（README 必写）：**
- **C1**：start 未完成时又来 `instance.deleted` → 用 `driver.status` 状态机守卫，等 start resolve/reject 后再 stop
- **C2**：`driver.error` 与手动 `stop()` 并发 → `registry.unregister` 幂等
- **C3**：同一 instanceId 重复 `instance.created` → 先查 registry 命中则 teardown 旧 driver

---

### Task W2-1b · `member-driver/replay.ts`
**负责人**：dev-replay · **状态**：done（lifecycle 已 import 纯函数 `replayForDriver`）

**目录**：`packages/backend/src/bus/subscribers/member-driver/`

**输出**：
- `replay.ts` — 离线消息重放逻辑。订阅 W2-1a emit 的 `member.driver.started` 事件（或提供 `replayForDriver(instanceId, driver)` 纯函数由 lifecycle 直接调用，二选一，README 说明选定的接法）
- `replay.test.ts` — fixture：在 offline store 写 3 条 pending message → 触发 replay → 断言按顺序 prompt 了 3 次 + 全部 markDelivered
- `README.md` — 说明时序：driver started → `offline.replayFor(instanceId)` → 对每条串行 `await driver.prompt(formatMemberMessage(m.payload))` → `offline.markDelivered(m.id)`

**约束**：
- ≤ 100 行
- replay 全程串行（`for (const m of pending) await driver.prompt(...)`），避免 WORKING 状态冲突
- 每条消息用 try/catch 包裹，记失败条数 stderr，不中断后续消息
- import `formatMemberMessage`（W1-2 产物）

**竞态分析（README 必写）：**
- Replay 期间新消息到达：派发侧走 router → registry → driver.prompt，driver 内部队列保证串行（Stage 2 责任）；本模块不做二次队列
- driver 在 replay 中途被 stop → prompt 抛异常 → 跳出 for 循环，未 deliver 的消息留在 offline store 等下次

---

### Task W2-1c · `member-driver/pid-writeback.ts`
**负责人**：待分配 · **状态**：blocked(W2-1a)

**目录**：`packages/backend/src/bus/subscribers/member-driver/`

**输出**：
- `pid-writeback.ts` — pid 写回 domain。订阅 `member.driver.started`（或 `driver.started` 过滤 member），从 `driver.getPid()` 拿 pid，调 `instance.setSessionPid(pid)`
- `pid-writeback.test.ts` — 内存 SQLite：触发 started → 断言 `RoleInstance.findById(id).sessionPid === pid`
- `README.md` — 说明原因：domain-sync.subscriber 原本订阅 `pty.spawned` 写 pid，Stage 3 下线 pty，pid 写回下沉到胶水层（谁持有 driver 引用谁写）

**约束**：
- ≤ 60 行
- 只做 pid 写回这一件事
- `driver.getPid()` 返回 undefined 时不写（留 NULL），记 debug 日志

---

### Task W2-1 · 聚合 `bus/subscribers/member-driver/index.ts`
**负责人**：W2-1a 开发者顺带 · **状态**：blocked(W2-1a, W2-1b, W2-1c)

**输出**：
- `index.ts` — `export function subscribeMemberDriver(): Subscription`，内部聚合 lifecycle + replay + pid-writeback 三个订阅，返回统一 `Subscription`（unsubscribe 时全部撤销）
- 导出给 `bus/index.ts` 替换旧 `subscribePty`

**约束**：
- ≤ 30 行
- 不写业务逻辑，纯聚合
- 建议返回的 Subscription 用 `masterSub.add()` 语义兼容

**验收（整体 W2-1 族）：**
- `wc -l packages/backend/src/bus/subscribers/member-driver/*.ts` 全部 ≤ 150
- `grep -rn "ptyManager\." packages/backend/src` 除 Wave 3 待删的 pty.subscriber.ts 外无命中
- `send_msg` E2E：leader 触发 → member 侧 `driver.text` 事件可被 ws 消费
- pid 在 RoleInstance 行里正确落盘

---

### Task W2-2 · Stage-3 的 `comm.driverDispatcher` 实现 + 装配到 `CommServer`
**负责人**：待分配 · **状态**：blocked(W1-1, W1-5, W1-6, W2-1)

**目录**：`packages/backend/src/bus/subscribers/` 或 `packages/backend/src/comm/`（建议新文件 `comm/driver-dispatcher.ts`）

**输出**：
- `comm/driver-dispatcher.ts` — 导出 `createDriverDispatcher(registry: DriverRegistry): DriverDispatcher`
  - 实现：
    ```text
    async (memberId, text) =>
      const d = registry.get(memberId)
      if (!d) return 'not-found'
      if (!d.isReady()) return 'not-ready'
      try { await d.prompt(text); return 'delivered'; }
      catch { return 'not-ready'; }   // 回退到 socket → offline
    ```
- `driver-dispatcher.test.ts` — 覆盖四种分支 + driver.prompt 抛异常分支（确保不污染 registry）
- `README.md` — **业务模块**，要有：
  - 时序图：`router.dispatch → dispatcher(memberId, text) → registry.get → driver.prompt → session/update 流`
  - 竞态分析：
    - **D1**：driver 在 prompt 执行期间被 stop → driver 内部抛异常 → dispatcher 返回 `'not-ready'` → 走 socket/offline
    - **D2**：同一 memberId 并发两条 message → driver.prompt 串行保障（Stage 2 责任），这里不做队列
    - **D3**：router 侧并发高 → dispatcher 无状态、Promise 并发安全
- `comm/index.ts` 或 `server.ts` 装配点：在 hub bootstrap 处把 `createDriverDispatcher(driverRegistry)` 透进 `CommServer.start(...)`

**约束**：
- Dispatcher 是"胶水"：同时 import `agent-driver/registry`（OK）+ `comm/router` 的类型（OK）
- router 仍不会反向 import agent-driver

**验收**：
- 集成测试：leader `send_msg` 到在线成员 → `driver.prompt` 被触发；成员离线 → `offline.store` 被命中
- 下发路径 stderr 无任何 `[pty]` 日志

---

### Task W2-3 · `domain-sync.subscriber.ts` 订阅切换 + `pty.subscriber / pty/ / node-pty` 物理下线
**负责人**：待分配 · **状态**：blocked(W2-1, W2-2)

**目录**：`packages/backend/src/bus/` + `packages/backend/src/pty/` + `packages/backend/src/bus/index.ts`

**输出**：
1. `bus/subscribers/domain-sync.subscriber.ts`：
   - 删除 `eventBus.on('pty.spawned')` 订阅
   - 新增 `eventBus.on('driver.started')` 订阅：从 driverId 反查 `RoleInstance`（非 member 跳过），从 driver `child.pid` 拿不到 → 只能改约定：事件里加 `pid` 字段 **或** 让胶水层 W2-1 在 start 成功后显式 `instance.setSessionPid(driver.getPid())`
   - **决策**：driver 事件层**不加 pid 字段**（保持与设计文档 §6 的"字段不变"一致）；改法是 W2-1 在 `driver.start()` 返回后立刻 `instance.setSessionPid(driver.getPid())`，domain-sync 仅用 `driver.started` 作为"已就绪可写 DB"的信号——但实际"谁写 pid"简化为由 W2-1 业务胶水层直接调 domain 方法（已经跨 domain，性质一致）。
   - **最终方案**：`domain-sync` 的 `pty.spawned` 订阅整块删除；pid 写入下沉到 W2-1 胶水里（它本来就持有 driver & instance 引用），与本 Stage 的"胶水写回"策略一致。
2. `bus/index.ts`：
   - 移除 `import { subscribePty }` + `masterSub.add(subscribePty())`
   - 新增 `import { subscribeMemberDriver }` + `masterSub.add(subscribeMemberDriver())`
   - 注释里"team 必须在 pty 之前注册"改为"team 必须在 member-driver 之前注册"
3. `bus/subscribers/pty.subscriber.ts` 删除（整个文件）
4. `pty/manager.ts` + `pty/prompt.ts` 删除（prompt.ts 逻辑已迁到 `member-agent/prompt.ts`）
5. `pty/` 目录删空 → 删目录
6. `package.json` 去掉 `node-pty` 依赖（**确认没有其他 import 后才删**；全仓 `grep -r "from 'node-pty'" packages/` 必须 empty）
7. `__tests__/pty-manager.test.ts` 若存在，删除
8. `__tests__/domain-sync-subscriber.test.ts` 更新：`pty.spawned` 断言→ 删除；或改成对 W2-1 行为（可由 W2-1 补位）
9. `bus/types.ts` 物理删除 `pty.spawned / pty.exited`（Wave 1 的 W1-4 只做了 @deprecated，这里最终拔线）
10. `api/panel/role-instances.ts:3-4` 注释链路改 `instance.created → member-driver.start + ...`

**输出文件**：
- 上述 diff 集中在一个 PR（W2-3 本身是"清扫"阶段，没有新 README）
- 更新 `MILESTONE.md` 里 Stage 3 的"废弃文件清单"checklist

**约束**：
- 本 task **必须在 W2-1（族）、W2-2 的测试全绿之后执行**——它是纯清扫
- 不保留 `TEAM_HUB_MEMBER_RUNTIME=pty` 回滚分支：直接把 `bus/index.ts` 里旧 `subscribePty()` 注册替换为 `subscribeMemberDriver()`，无 env 分支
- 清扫后跑一次 `tsc --noEmit` + 全量单测 + 集成 E2E（见 REGRESSION §2）

**验收**：
- `grep -rn "pty" packages/backend/src` 仅剩文档注释
- `grep -rn "node-pty" packages/` empty
- `grep -rn "pty.spawned\|pty.exited" packages/` empty

---

<!-- W2-4（TEAM_HUB_MEMBER_RUNTIME=pty 回滚开关）已删除：
     用户未要求灰度，PTY 一次性下线，不保留回滚路径。
     W2-3 清扫直接完成物理删除。-->

<!-- W2-5（check_inbox 降级 + send_msg 注释）已删除：
     用户未要求灰度兜底，check_inbox 不保留 Fallback 过渡期。
     若 Stage 3 后完全走推模式，check_inbox 是否保留/移除并入后续决策，不在本 TASK-LIST 范围。-->

---

## 4. Wave 3 — 集成测试与回滚验证

由测试员按 `REGRESSION.md` 逐条跑。本 TASK-LIST 只登记 task 占位。

### Task W3-1 · 集成 E2E 与回归测试
**负责人**：测试员（待分配） · **状态**：blocked(W2-1, W2-2, W2-3)

见 `REGRESSION.md`。测试完产出测试报告；有 bug → 新修复员进场 → W3-2 等循环。

---

## 5. 依赖图

```
W1-1 (registry)         ┐
W1-2 (prompt+format)    ├─ 并行
W1-4 (types deprecate)  │
W1-5 (router inject)    │
W1-6 (server deliver)   ┘

W1-3 (driver-config) ← W1-2           （W1 内部小依赖）

      ▼ （Wave 1 全绿）

W2-1a (member-driver/lifecycle)     ← W1-1, W1-3, W1-4
W2-1b (member-driver/replay)        ← W1-2, W2-1a
W2-1c (member-driver/pid-writeback) ← W2-1a        (可与 W2-1b 并行)
W2-1  (member-driver/index 聚合)    ← W2-1a, W2-1b, W2-1c
W2-2  (driver-dispatcher)           ← W1-1, W1-5, W1-6, W2-1
W2-3  (清扫 pty/ + types 物删)      ← W2-1, W2-2        (最晚合并)

      ▼

W3-1 (E2E + 回归)               ← 全部 W2
```

---

## 6. 状态索引

| Task | 标题 | 负责人 | 状态 | 依赖 |
|------|------|--------|------|------|
| W1-1 | agent-driver/registry.ts | — | pending | — |
| W1-2 | member-agent/prompt+format | — | pending | — |
| W1-3 | member-agent/driver-config.ts（纯函数） | — | pending | W1-2 |
| W1-4 | bus/types.ts 标记 @deprecated + ws 白名单 | — | pending | — |
| W1-5 | CommRouter.driverDispatcher 注入点 | — | pending | — |
| W1-6 | CommServer 透传 dispatcher | — | pending | W1-5 |
| W2-1a | member-driver/lifecycle.ts | — | blocked | W1-1, W1-3, W1-4 |
| W2-1b | member-driver/replay.ts | dev-replay | done | W1-2, W2-1a |
| W2-1c | member-driver/pid-writeback.ts | — | blocked | W2-1a |
| W2-1 | member-driver/index.ts 聚合 | — | blocked | W2-1a, W2-1b, W2-1c |
| W2-2 | comm/driver-dispatcher.ts + 装配 | — | blocked | W1-1, W1-5, W1-6, W2-1 |
| W2-3 | pty/ 目录 + types.pty.* 物理清扫 | — | blocked | W2-1, W2-2 |
| W3-1 | 集成 E2E 与回归 | — | blocked | 全部 W2 |

---

*架构师产出结束。下一步：Leader 按依赖图分配 Wave 1 开发者并行进场。*
