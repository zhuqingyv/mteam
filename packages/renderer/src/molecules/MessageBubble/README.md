# MessageBubble
消息气泡，agent/user/thinking 三态。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | `'agent' \| 'user' \| 'thinking'` | - | 气泡类型 |
| children | `ReactNode` | - | 内容（thinking 忽略） |
| time | `string` | - | 时间 |
| read | `boolean` | - | user 已读标识 |
| agentName | `string` | - | agent/thinking 的名称 |

## Usage
```tsx
import MessageBubble from './MessageBubble';
<MessageBubble variant="agent" agentName="Claude" time="10:24">你好</MessageBubble>
```
