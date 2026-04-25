# CliList
CLI 可用性列表（设置页使用）。展示 name / path / 在线状态点，支持刷新。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| clis | `CliEntry[]` | — | CLI 列表，`{ name, path, available }` |
| onRefresh | `() => void` | — | 刷新回调 |

## Usage
```tsx
import CliList from './CliList';
<CliList clis={clis} onRefresh={refresh} />
```
