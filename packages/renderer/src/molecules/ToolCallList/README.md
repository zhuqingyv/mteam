# ToolCallList
可折叠工具调用列表，折叠时只显示最后一条。

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
