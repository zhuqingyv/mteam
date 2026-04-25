# CapsuleCard
胶囊卡片（收起/展开态）。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| name | `string` | `'M-TEAM'` | 团队名 |
| agentCount | `number` | - | Agent 数 |
| taskCount | `number` | - | Task 数 |
| messageCount | `number` | - | 消息数 |
| online | `boolean` | - | 在线 |
| expanded | `boolean` | `false` | 展开态 |
| animating | `boolean` | `false` | 动画中 |
| onToggle | `() => void` | - | 切换 |

## Usage
```tsx
import CapsuleCard from './CapsuleCard';
<CapsuleCard name="M-TEAM" agentCount={3} taskCount={2} messageCount={5} online />
```
