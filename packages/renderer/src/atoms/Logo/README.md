# Logo
M-TEAM 徽标图片，三态联动连接生命周期。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| size | `number` | `56` | 尺寸 px |
| status | `'online' \| 'connecting' \| 'offline'` | `'online'` | 三态：在线彩色 / 连接中灰+呼吸 / 离线灰度 |
| online | `boolean` | — | **deprecated**，未传 status 时 `true→online`、`false→offline` |

## 状态语义
- `online`：主 Agent RUNNING，彩色 + opacity 1。
- `connecting`：主 Agent STOPPED 且无错误（WS 建连 / 启动中），灰度 + 0.4↔0.8 呼吸循环（2s）。
- `offline`：主 Agent STOPPED 且有 lastError（启动失败），灰度静态 + opacity 0.6。

## Usage
```tsx
import Logo from './Logo';
<Logo size={56} status="connecting" />
```
