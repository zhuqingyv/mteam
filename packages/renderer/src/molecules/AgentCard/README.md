# AgentCard
画布上可拖拽的 Agent 卡片，显示状态点、名称和最新消息。拖拽释放时回调坐标。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| name | string | — | Agent 名称 |
| status | 'idle' \| 'thinking' \| 'responding' \| 'offline' | — | 运行状态（对齐后端 agent 状态集；映射到 StatusDot 的 online/thinking/responding/offline） |
| lastMessage | string | — | 最新一条消息预览（可选） |
| x | number | 0 | 初始横坐标（px） |
| y | number | 0 | 初始纵坐标（px） |
| onDragEnd | (x, y) => void | — | 拖拽结束回调，返回新坐标 |

## Usage
```tsx
import AgentCard from './AgentCard';

<AgentCard
  name="Claude"
  status="thinking"
  lastMessage="正在读取 agent-status.json"
  x={120}
  y={80}
  onDragEnd={(x, y) => save({ x, y })}
/>
```
