# agent-driver / turn-types

Turn 聚合方案的共享数据模型。**纯类型 + 类型守卫**，零业务依赖（不 import `bus/*`、`comm/*`、`ws/*`、`db/*`），可被服务端 agent-driver / bus / ws-broadcaster 和前端同时引用。

权威合约：`docs/phase-ws/turn-aggregator-design.md` §1.2 / §1.3。

## 模块定位

- `TurnBlockType`、`BlockScope`、`Vendor`、`ToolKind`、`ToolStatus`、`AcpContent`、`Location`
- `VendorPayload` / `VendorOutput`（adapter 必须填 `display`）
- 9 种 Block：`ThinkingBlock` / `TextBlock` / `ToolCallBlock` / `PlanBlock` / `UsageBlock` / `CommandsBlock` / `ModeBlock` / `ConfigBlock` / `SessionInfoBlock` → 并集 `TurnBlock`
- `Turn` / `TurnStatus` / `StopReason` / `TurnUsage` / `UserInput`
- 类型守卫：`isTurnBlockType` / `isSessionScopeBlock` / `is{XXX}Block`

## 设计要点（同步自设计文档）

- **不拆两层**：`scope: 'turn' | 'session'` 字段区分正文 / 顶栏，而不是两个数组（reviewer E）。
- **seq 每 turn 从 0 重开**：`Turn.blocks[*].seq` 首次出现时分配；前端按 seq 固定位置，content 原地更新（reviewer G + P3）。
- **vendor 归一化**：`VendorPayload.display` 由 adapter 提取人类可读短串；`data` 透传原始 rawInput/rawOutput（reviewer B）。
- **Turn.userInput 必填**：前端渲染需要用户气泡 + agent 块（reviewer I）。
- **StopReason 含 `crashed`**：聚合器可在 `driver.error`/`driver.stopped` 时强制关闭 active Turn（reviewer A）。
- **TurnUsage ≠ UsageBlock**：前者来自 `session/prompt` 响应（Claude 有、Codex 无），为 turn 结束账单；后者来自 `usage_update` 事件，为 context 窗口进度条（reviewer S3）。

## 合并 key（blockId）约定

| block | blockId |
|-------|---------|
| thinking / text | `messageId` 存在则用之；否则 `thinking-{turnId}` / `text-{turnId}` |
| tool_call | `toolCallId` |
| plan | `plan-{turnId}` |
| usage | `usage-{turnId}` |
| commands / mode / config / session_info | 固定字符串 `commands` / `mode` / `config` / `session_info` |

> 本模块只声明类型，实际的 blockId 拼接由 `turn-aggregator.subscriber.ts` 负责（T-9）。

## 使用

```typescript
import type { Turn, TurnBlock, VendorPayload } from './turn-types.js';
import { isToolCallBlock, isSessionScopeBlock } from './turn-types.js';

function renderTurnBody(turn: Turn) {
  return turn.blocks
    .filter((b) => !isSessionScopeBlock(b))
    .sort((a, b) => a.seq - b.seq);
}

if (isToolCallBlock(block)) {
  // block.toolCallId / block.input.vendor 可安全访问
}
```

## 禁止

- 不 import `bus/*`、`comm/*`、`ws/*`、`filter/*`、`db/*`。
- 不写运行时逻辑（解析 ACP、构造 block、维护状态等一律放 `adapters/normalize.ts` 或 `turn-aggregator.subscriber.ts`）。
- 不 mock DB / bus（本模块纯类型，无外部依赖可 mock）。

## 测试

`__tests__/turn-types.test.ts` —— 覆盖 9 种 block 的 type/scope 配对、守卫真值表（每个守卫只对目标类型返回 true），以及 `Turn` 装配形状。
