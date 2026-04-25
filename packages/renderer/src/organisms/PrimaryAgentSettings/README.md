# PrimaryAgentSettings
总控 Agent 设置面板：展示当前配置 + 启停按钮。毛玻璃暗色。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| config | `{ model?; maxTokens? }` | — | 总控当前配置 |
| running | `boolean` | `false` | 是否运行中（控制按钮与状态点） |
| onStart | `() => void` | — | Start 按钮回调 |
| onStop | `() => void` | — | Stop 按钮回调 |

## Usage
```tsx
import PrimaryAgentSettings from './PrimaryAgentSettings';
<PrimaryAgentSettings config={cfg} running={true} onStart={start} onStop={stop} />
```

## 服务端对接
- `GET /api/panel/primary-agent` → config + status
- `POST /api/panel/primary-agent/start | /stop` → 启停
