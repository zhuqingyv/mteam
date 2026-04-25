# ChatPanel
展开态主面板：虚拟消息列表 + Agent 切换 + 输入框。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| messages | `Message[]` | `[]` | 消息列表 |
| agents | `Agent[]` | `[]` | Agent 列表（带 `active`） |
| inputPlaceholder | `string` | `'给 MTEAM 发送消息...'` | 输入框占位符 |

## Usage
```tsx
import ChatPanel from './ChatPanel';
<ChatPanel messages={msgs} agents={agents} />
```
