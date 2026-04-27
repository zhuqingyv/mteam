# ToolCallList
可折叠工具调用列表，折叠时只保留 header，body 完全隐藏（1 条也能收起）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| calls | `ToolCall[]` | - | `{ id, toolName, status, summary?, duration? }[]` |
| defaultCollapsed | `boolean` | `false` | 默认收起 |

## Usage
```tsx
import ToolCallList from './ToolCallList';
<ToolCallList calls={calls} defaultCollapsed />
```
