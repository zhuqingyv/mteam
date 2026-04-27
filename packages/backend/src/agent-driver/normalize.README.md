# normalize.ts — ACP 原始载荷归一化

## 一句话

把 ACP SessionUpdate 里五花八门的原始字段（`content` / `rawInput` / `rawOutput` / `entries` / ...）拍扁成 `turn-types.ts` 约定的干净形状，**adapter 层唯一的数据转换入口**。

## 为什么单拎一层

- Claude / Codex adapter 共享同一套 ACP schema，转换逻辑 90% 相同 —— 抽出来避免两边 drift（reviewer H）
- 类型守卫过滤替代裸 `.filter(Boolean)`（TS 不窄化 `(T|null)[] → T[]`，reviewer P1）
- 纯函数零依赖：**禁止 import `bus/*` / `comm/*` / `ws/*` / `db/*`**，只 import 本目录 `turn-types.js`。方便 adapter 复用 + 前端未来走 workspace 共享包时零重写

## 导出清单（按用途分组）

### ContentBlock / ToolCallContent → AcpContent

ACP `ContentBlock`（5 种）和 `ToolCallContent`（3 种）两套形状，拍扁成我们自己的 `AcpContent`（6 种，含 diff）。

| 函数 | 用途 |
|------|------|
| `contentBlockToAcpContent(cb)` | text/image/audio/resource_link → `AcpContent`；resource 不支持返 null |
| `toolCallContentToAcpContent(tcc)` | `{type:'content'\|'diff'\|'terminal'}` → `AcpContent` |
| `compactAcpContent(raw)` | 批量转换 **+ 类型守卫过滤 null**，adapter 用这个而不是裸 `.map().filter(Boolean)` |
| `extractContentText(content)` | `sessionUpdate.content`（单块或数组）→ 纯文本；非 text 块忽略 |

### 结构化字段归一

| 函数 | 用途 |
|------|------|
| `normalizePlanEntries(raw)` | plan sessionUpdate 的 entries → `PlanEntry[]`（priority/status 走白名单或默认） |
| `normalizeCommands(raw)` | available_commands_update.availableCommands → `CommandDescriptor[]` |
| `normalizeConfigOptions(raw)` | config_option_update.configOptions → `ConfigOption[]`（category/type/value 白名单校验） |
| `normalizeLocations(raw)` | tool_call.locations → `Location[]`；空数组返 undefined |
| `mapToolKind(raw)` | ToolKind 字面量白名单；未匹配返 undefined |
| `mapToolStatus(raw)` | ToolStatus 字面量白名单；未匹配返 `'pending'` |

### VendorPayload（厂商 display 提取入口）

工具卡片默认渲 `input.display` / `output.display`（人类可读短串），`data` 字段透传原始 vendor 形状给高级用户展开。

```typescript
normalizeToolInput(vendor, title, rawInput): VendorPayload
normalizeToolOutput(vendor, rawOutput): VendorOutput   // codex 额外带 exitCode
```

| vendor | rawInput display 策略 | rawOutput display 策略 |
|--------|---------------------|-----------------------|
| `claude` | `file_path` > `command` > `path` 三选一，format 为 `"title: X"` | 字符串直接用；object.content 作退路 |
| `codex` | `parsed_cmd[0].cmd` > `command[last]`（unified_exec 形状） | `formatted_output` > `aggregated_output` |

`exitCode` 仅 Codex 填（claude 工具非 shell 语义）。

## 使用示例（adapter 里）

```typescript
import {
  extractContentText, compactAcpContent,
  normalizeToolInput, normalizeToolOutput, normalizeLocations,
  mapToolKind, mapToolStatus,
} from '../normalize.js';

// tool_call sessionUpdate → DriverEvent
return {
  type: 'driver.tool_call',
  toolCallId: t.toolCallId,
  title: t.title ?? '',
  kind: mapToolKind(t.kind),
  status: mapToolStatus(t.status ?? 'pending'),
  locations: normalizeLocations(t.locations),
  input: normalizeToolInput('claude', t.title ?? '', t.rawInput),
  content: compactAcpContent(t.content),
};
```

## 红线

- **禁止**在本文件里 import `bus/*` / `comm/*` / `ws/*` / `db/*`
- **禁止**裸 `.filter(Boolean)`（用 `.filter((c): c is T => c !== null)` 或 `compactAcpContent`）
- 新增函数必须是 pure function（无 side-effect，输入相同返回相同）
- 文件总行数 ≤ 200（当前 199）

## 测试

`__tests__/normalize.test.ts` · 36 case 覆盖 happy path + 脏输入 + 两家厂商 display 差异。
