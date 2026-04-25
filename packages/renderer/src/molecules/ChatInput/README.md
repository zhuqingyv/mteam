# ChatInput
自适应高度输入框，Enter 发送（Shift+Enter 换行）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| placeholder | `string` | `'输入消息…'` | 占位符 |
| value | `string` | `''` | 输入内容（受控） |
| onChange | `(v: string) => void` | - | 变更 |
| onSend | `() => void` | - | 发送 |

## Usage
```tsx
import ChatInput from './ChatInput';
<ChatInput value={v} onChange={setV} onSend={send} />
```
