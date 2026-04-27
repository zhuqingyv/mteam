# AgentDriver 设计

---

## 定位

AgentDriver 是 mteam 与各类 ACP agent 之间的统一驱动层。内置不同 agent 的适配器，屏蔽差异，对上层暴露一致的接口。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    上层消费方                         │
│         主 Agent / 角色实例 / 未来其他场景             │
└────────────────────┬────────────────────────────────┘
                     │ 统一接口
                     ▼
┌─────────────────────────────────────────────────────┐
│                  AgentDriver                         │
│                                                      │
│  ┌─────────┐  ┌───────────┐  ┌─────────────────┐   │
│  │ 生命周期 │  │ 输入/输出  │  │ bus 事件发射     │   │
│  │ 管理    │  │ 管道      │  │ (可被订阅)       │   │
│  └─────────┘  └───────────┘  └─────────────────┘   │
│                     │                                │
│          ┌──────────┼──────────┐                     │
│          ▼          ▼          ▼                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Claude   │ │ Codex    │ │ Qwen     │            │
│  │ Adapter  │ │ Adapter  │ │ Adapter  │            │
│  │          │ │          │ │          │            │
│  │ prompt:  │ │ prompt:  │ │ prompt:  │            │
│  │ _meta    │ │ file+flag│ │ cli flag │            │
│  │          │ │          │ │          │            │
│  │ output:  │ │ output:  │ │ output:  │            │
│  │ thinking │ │ item     │ │ (TBD)    │            │
│  │ +text    │ │ +turn    │ │          │            │
│  │ +tool_use│ │          │ │          │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                     │                                │
└─────────────────────┼────────────────────────────────┘
                      │ ACP JSON-RPC over stdio
                      ▼
              ┌───────────────┐
              │ ACP Agent     │
              │ 子进程         │
              │ (npx 启动)     │
              └───────────────┘
```

---

## 1. 生命周期

```
                    create(config)
                         │
                         ▼
                    ┌─────────┐
                    │  IDLE   │ ← 已配置，未启动
                    └────┬────┘
                         │ start()
                         ▼
                    ┌─────────┐
                    │STARTING │ ← spawn 子进程 + ACP initialize + session/new
                    └────┬────┘
                         │ 握手成功
                         ▼
                    ┌─────────┐
                    │  READY  │ ← 可以收发消息
                    └────┬────┘
                         │ prompt(message)
                         ▼
                    ┌─────────┐
                    │ WORKING │ ← 正在处理，流式输出中
                    └────┬────┘
                         │ 输出完成
                         ▼
                    ┌─────────┐
                    │  READY  │ ← 等待下一条输入
                    └────┬────┘
                         │ stop()
                         ▼
                    ┌─────────┐
                    │ STOPPED │ ← 子进程已退出，资源已清理
                    └─────────┘

异常路径：
  任何状态 → 子进程崩溃 → STOPPED + emit driver.error
  STARTING → 握手超时 → STOPPED + emit driver.error
```

---

## 2. 对外接口

```ts
class AgentDriver {
  readonly id: string;          // driver 实例 ID
  readonly status: DriverStatus;

  constructor(id: string, config: DriverConfig)

  start(): Promise<void>
    // spawn ACP 子进程 → initialize → session/new
    // 内部按 config.agentType 选适配器
    // 成功 → READY + emit driver.started
    // 失败 → STOPPED + emit driver.error

  prompt(message: string): void
    // 发 session/prompt → WORKING
    // 流式输出通过 bus 事件推出

  stop(): Promise<void>
    // kill 子进程 → 清理临时文件 → STOPPED + emit driver.stopped

  isReady(): boolean
}

interface DriverConfig {
  agentType: 'claude' | 'codex' | 'qwen';  // 决定用哪个适配器
  systemPrompt: string;                      // 系统提示词
  mcpServers: McpServerSpec[];               // MCP 配置
  cwd: string;                               // 工作目录
  env?: Record<string, string>;              // 额外环境变量
}
```

---

## 3. 订阅方式

所有输出通过 bus 事件发射，消费方按 driverId 过滤订阅：

```
driver.started        — 启动成功（READY）
driver.stopped        — 已停止
driver.error          — 异常（含错误信息）
driver.thinking       — 思考过程（实时流式）
driver.text           — 文本回复（实时流式）
driver.tool_call      — 工具调用
driver.tool_result    — 工具返回
driver.turn_done      — 本轮处理完成
```

每个事件都带 `driverId`，支持多个 driver 实例并存。

```
消费示例：

bus.on('driver.thinking').subscribe(e => {
  if (e.driverId === 'primary') → WebSocket 推前端显示思考气泡
});

bus.on('driver.text').subscribe(e => {
  if (e.driverId === 'primary') → WebSocket 推前端显示回复
});

bus.on('driver.tool_call').subscribe(e => {
  if (e.driverId === 'primary') → WebSocket 推前端显示"正在调用 xxx"
});
```

---

## 数据流

```
用户输入
  │
  ▼
前端 → WebSocket → backend
  │
  ▼
AgentDriver.prompt("帮我梳理项目进展")
  │
  ▼ ACP session/prompt (JSON-RPC stdin)
  │
ACP Agent 子进程处理中...
  │
  ▼ ACP session/update (JSON-RPC stdout, 流式)
  │
AgentDriver 内部：
  │
  ├─ adapter.parse(update) → 统一事件
  │
  ├─ agent_thought_chunk → bus.emit('driver.thinking', { driverId, content })
  ├─ agent_message_chunk → bus.emit('driver.text', { driverId, content })
  ├─ tool_call           → bus.emit('driver.tool_call', { driverId, name, input })
  └─ turn complete       → bus.emit('driver.turn_done', { driverId })
        │
        ▼
    ws.subscriber 自动推 WebSocket → 前端实时渲染
```

---

## 适配器接口

```ts
interface AgentAdapter {
  // spawn 前准备（写 prompt 文件、拼 CLI 参数等）
  prepareSpawn(config: DriverConfig): SpawnSpec;

  // session/new 的额外参数（_meta 等）
  sessionParams(config: DriverConfig): Record<string, unknown>;

  // 解析 ACP session/update → 统一事件
  parseUpdate(update: AcpSessionUpdate): DriverEvent | null;

  // 清理（删临时文件等）
  cleanup(): void;
}
```

每个 agent 一个适配器实现：

| 适配器 | prompt 注入 | 输出解析 |
|--------|-----------|---------|
| ClaudeAdapter | `_meta.systemPrompt = { append }` | thinking + text + tool_use |
| CodexAdapter | 落盘文件 + `-c model_instructions_file` | item.completed + turn |
| QwenAdapter | `--system-prompt` CLI flag | TBD |

---

## 文件位置

```
packages/backend/src/agent-driver/
├── types.ts              — DriverConfig / DriverStatus / DriverEvent
├── driver.ts             — AgentDriver 类
├── adapters/
│   ├── adapter.ts        — AgentAdapter 接口
│   ├── claude.ts         — ClaudeAdapter
│   ├── codex.ts          — CodexAdapter
│   └── qwen.ts           — QwenAdapter（后续）
```

---

## 改动清单

| 类型 | 文件 |
|------|------|
| 新增 | agent-driver/ 整个目录 |
| 修改 | bus/types.ts（8 个 driver 事件） |
| 修改 | bus/events.ts（re-export） |
| 修改 | bus/subscribers/ws.subscriber.ts（白名单） |
| 修改 | primary-agent/primary-agent.ts（用 AgentDriver 替代直接 spawn） |
| 可删 | cli-runner/（被 AgentDriver 替代） |
