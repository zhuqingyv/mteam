# NotificationCard
通知卡片，左侧彩色条区分类型。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| title | `string` | - | 标题 |
| message | `string` | - | 内容 |
| time | `string` | - | 时间 |
| type | `'info' \| 'task' \| 'error'` | `'info'` | 类型 |

## Usage
```tsx
import NotificationCard from './NotificationCard';
<NotificationCard title="完成" message="Bug 已修复" time="刚刚" type="task" />
```
