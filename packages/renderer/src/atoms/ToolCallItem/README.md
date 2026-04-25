# ToolCallItem
单条工具调用，状态+工具名+摘要+耗时。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| toolName | `string` | - | 工具名 |
| status | `'running' \| 'done' \| 'error'` | - | 状态 |
| summary | `string` | - | 摘要 |
| duration | `string` | - | 耗时 |

## Usage
```tsx
import ToolCallItem from './ToolCallItem';
<ToolCallItem toolName="read_file" status="done" summary="读 package.json" duration="0.3s" />
```
