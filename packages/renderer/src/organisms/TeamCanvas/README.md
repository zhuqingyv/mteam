# TeamCanvas
Agent 可视化画布。按坐标渲染 `AgentCard`，支持节点拖拽、画布平移、滚轮缩放、双击重置。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| agents | Array<{ id; name; status; cliType?; lastMessage?; x; y }> | — | Agent 列表及坐标 |
| onAgentDragEnd | (id, x, y) => void | — | 节点拖拽结束回调（坐标已换算到画布坐标系） |

## 交互
- 空白处按下并拖动 → 画布平移（所有节点同步移动）
- 滚轮 / 触控板 pinch → 以鼠标位置为中心缩放（0.25 ~ 3，默认 1）
- 空白处双击 → 还原 pan=0,0 zoom=1
- 节点上的 mousedown 不会触发画布平移
- 节点拖动 delta 按当前 zoom 换算，视觉跟手

## 实现
- viewport 层 `transform: translate(...) scale(...)` 由 `useCanvasTransform` 直接写 DOM（useRef + style，避免 React 状态抖动）
- viewport `pointer-events: none`，其子节点 `pointer-events: auto`，让空白处穿透到 container

## Usage
```tsx
import TeamCanvas from './TeamCanvas';

<TeamCanvas
  agents={[{ id: 'c', name: 'Claude', status: 'idle', x: 40, y: 60 }]}
  onAgentDragEnd={(id, x, y) => persist(id, x, y)}
/>
```
