# AgentSwitcher
Agent 切换 tab 列表，末尾带 + 添加按钮。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| agents | `Agent[]` | - | `{ id, name, icon?, active? }[]` |
| activeId | `string` | - | 当前激活 id（覆盖 `active`） |
| onSelect | `(id: string) => void` | - | 选中 |
| onAdd | `() => void` | - | 点击 + |

## Usage
```tsx
import AgentSwitcher from './AgentSwitcher';
<AgentSwitcher agents={list} activeId="claude" onSelect={setActive} />
```
