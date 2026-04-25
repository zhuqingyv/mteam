# MessageRow
一条消息（头像+气泡+时间+工具调用）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| role | `'agent' \| 'user'` | - | 角色 |
| content | `string` | - | 消息内容 |
| time | `string` | - | 时间 |
| read | `boolean` | - | user 已读 |
| agentName | `string` | - | agent 名 |
| thinking | `boolean` | - | 思考中 |
| toolCalls | `ToolCall[]` | - | 工具调用列表 |

## Usage
```tsx
import MessageRow from './MessageRow';
<MessageRow role="agent" agentName="Claude" content="hi" time="10:24" />
```
