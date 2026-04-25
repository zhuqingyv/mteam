# ChatHeader
展开态顶栏：Logo + 名称 + 状态点 + 关闭。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| name | `string` | `'M-TEAM'` | 团队名 |
| online | `boolean` | `true` | 在线 |
| onClose | `() => void` | - | 关闭回调 |

## Usage
```tsx
import ChatHeader from './ChatHeader';
<ChatHeader name="M-TEAM" online onClose={collapse} />
```
