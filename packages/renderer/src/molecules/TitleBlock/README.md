# TitleBlock
主标题 + 副标题 + 徽章。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| title | `string` | - | 主标题 |
| subtitle | `string` | - | 副标题 |
| badgeText | `string` | - | 徽章文本 |
| badgeCount | `number` | `0` | 徽章计数（>0 显示圆点） |

## Usage
```tsx
import TitleBlock from './TitleBlock';
<TitleBlock title="M-TEAM" subtitle="3 Agents" badgeText="5 New" badgeCount={5} />
```
