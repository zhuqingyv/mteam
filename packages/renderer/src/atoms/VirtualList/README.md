# VirtualList
虚拟滚动列表，只渲染可见区域。底部自动吸附；顶部回调触发加载更多。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| items | `T[]` | - | 数据 |
| renderItem | `(item, i) => ReactNode` | - | 行渲染 |
| getKey | `(item, i) => string` | - | 行 key |
| itemEstimateHeight | `number` | `80` | 预估行高 |
| overscan | `number` | `3` | 上下额外渲染条数 |
| onScrollTop | `() => void` | - | 滚到顶部触发 |
| className | `string` | `''` | 额外类名 |

## Usage
```tsx
import VirtualList from './VirtualList';
<VirtualList items={list} getKey={(m) => m.id} renderItem={(m) => <Row {...m} />} />
```
