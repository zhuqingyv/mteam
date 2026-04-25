# MessageBadge
未读徽章，`count<=0` 不渲染。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| count | `number` | - | 计数（>99 显示 99+） |
| variant | `'dot' \| 'number'` | `'number'` | 样式 |

## Usage
```tsx
import MessageBadge from './MessageBadge';
<MessageBadge count={5} variant="number" />
```
