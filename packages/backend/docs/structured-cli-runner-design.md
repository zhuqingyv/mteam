# 结构化 CLI 运行器设计

---

## 定位

独立原子模块。负责 spawn CLI 进程 + stdio JSON 双向通信 + 解析 NDJSON 输出 + 通过 bus 事件发出去。不关心谁在用它。

---

## 职责

| 做 | 不做 |
|----|------|
| spawn CLI（stdio 模式，非 PTY） | 不管谁在消费 |
| stdin 写入 JSON | 不管消息怎么显示 |
| stdout 读 NDJSON → 解析 → emit bus 事件 | 不管用户输入从哪来 |
| 进程管理（启动/停止/异常/退出） | 不做业务判断 |

---

## 接口

```ts
class StructuredCliRunner {
  constructor(id: string)       // runner 实例 ID（区分多个 runner）

  start(opts: RunnerStartOpts): void
    // spawn CLI 进程 + 开始读 stdout

  write(message: object): void
    // 往 stdin 写一行 JSON

  stop(): void
    // kill 进程 + 清理

  isRunning(): boolean
}

interface RunnerStartOpts {
  command: string;              // CLI 可执行文件路径
  args: string[];               // CLI 参数（含 --output-format stream-json 等）
  env?: Record<string, string>; // 环境变量
  cwd?: string;                 // 工作目录
}
```

---

## 事件

runner 解析 stdout NDJSON，按类型 emit 不同 bus 事件：

```
cli_runner.thinking    — 思考过程
cli_runner.text        — 文本回复
cli_runner.tool_use    — 工具调用
cli_runner.tool_result — 工具返回
cli_runner.error       — 错误
cli_runner.done        — 本轮完成
cli_runner.exited      — 进程退出
```

每个事件都带 `runnerId`，区分多个 runner 实例。

---

## stdout 解析

Claude CLI `--output-format stream-json` 的 NDJSON 每行一个 JSON 对象：

```json
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"...","input":{}}]}}
{"type":"result","cost_usd":0.01,"duration_ms":3000}
```

runner 逐行读 → JSON.parse → 按 type/content.type 分发到对应 bus 事件。

不同 CLI（Codex 等）格式不同 → 抽象一个解析器接口，每个 CLI 一个实现。

---

## 解析器接口

```ts
interface CliOutputParser {
  parse(line: string): RunnerEvent | null;
}
```

每个 CLI 类型一个解析器实现（claude-parser.ts / codex-parser.ts）。runner 构造时传入对应解析器。

---

## 消费方式

主 Agent 或任何其他模块订阅 bus 事件：

```
主 Agent:
  const runner = new StructuredCliRunner('primary');
  runner.start({ command: 'claude', args: ['--output-format', 'stream-json', ...] });

  bus.on('cli_runner.text').subscribe(e => {
    if (e.runnerId === 'primary') → WebSocket 推前端
  });

  // 用户输入
  runner.write({ type: 'user', message: '帮我梳理项目进展' });
```

---

## 与 PTY 的关系

```
StructuredCliRunner — stdio JSON 管道，结构化，给需要实时交互的场景
PTY Manager         — 终端模式，给自主干活不需要人交互的场景

两者并存，各管各的。
```

---

## 文件位置

```
packages/backend/src/cli-runner/
├── types.ts          — RunnerStartOpts / RunnerEvent 类型
├── runner.ts         — StructuredCliRunner 类
├── parsers/
│   ├── parser.ts     — CliOutputParser 接口
│   ├── claude.ts     — Claude CLI 解析器
│   └── codex.ts      — Codex CLI 解析器（后续）
```

---

## 改动清单

| 类型 | 文件 |
|------|------|
| 新增 | cli-runner/types.ts |
| 新增 | cli-runner/runner.ts |
| 新增 | cli-runner/parsers/parser.ts |
| 新增 | cli-runner/parsers/claude.ts |
| 修改 | bus/types.ts（7 个新事件） |
| 修改 | bus/events.ts（re-export） |
| 修改 | bus/subscribers/ws.subscriber.ts（白名单） |
| 不改 | pty/manager.ts（并存） |

---

## 实施计划

| Phase | 内容 |
|-------|------|
| 1 | runner 核心 + Claude 解析器 + bus 事件 |
| 2 | 主 Agent 集成（用 runner 替代 PTY spawn） |
| 3 | Codex 解析器 |
