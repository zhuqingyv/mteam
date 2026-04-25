# NotificationStack
通知堆叠卡片。由 `acknowledgedIds` 驱动签收动画（打勾→淡出→滑走）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| notifications | `Notification[]` | - | `{ id, title, message, time, type? }[]` |
| acknowledgedIds | `string[]` | `[]` | 已签收 id，触发动画 |
| maxVisible | `number` | `3` | 最多显示层数 |

## Usage
```tsx
import NotificationStack from './NotificationStack';
<NotificationStack notifications={list} acknowledgedIds={acked} />
```
