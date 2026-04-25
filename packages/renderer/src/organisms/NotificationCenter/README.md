# NotificationCenter
通知中心抽屉：从右侧滑入，展示全部通知，可逐条标记已读。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| notifications | `Notification[]` | — | 全量通知（沿用 `NotificationStack` 的 `Notification` 类型） |
| open | `boolean` | `true` | 是否展开（`false` 平移出屏） |
| acknowledgedIds | `string[]` | `[]` | 已读 id 列表，变暗 + 禁用点击 |
| onAcknowledge | `(id) => void` | — | 点击未读条目时回调 |
| onClose | `() => void` | — | 顶栏 × 关闭 |

## Usage
```tsx
import NotificationCenter from './NotificationCenter';
<NotificationCenter
  notifications={list}
  open={open}
  acknowledgedIds={readIds}
  onAcknowledge={markRead}
  onClose={close}
/>
```
