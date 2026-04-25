# TeamCanvas
Agent 可视化画布，按坐标渲染一组 `AgentCard`，支持拖拽回传新坐标。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| agents | Array<{ id; name; status; lastMessage?; x; y }> | — | Agent 列表及坐标 |
| onAgentDragEnd | (id, x, y) => void | — | 某 Agent 拖拽结束回调 |

## Usage
```tsx
import TeamCanvas from './TeamCanvas';

<TeamCanvas
  agents={[{ id: 'c', name: 'Claude', status: 'idle', x: 40, y: 60 }]}
  onAgentDragEnd={(id, x, y) => persist(id, x, y)}
/>
```
