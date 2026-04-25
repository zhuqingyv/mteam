# Button
按钮，四种样式+三种尺寸；dots 变体为六点菜单。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | `'primary' \| 'ghost' \| 'icon' \| 'dots'` | `'primary'` | 样式 |
| size | `'sm' \| 'md' \| 'lg'` | `'md'` | 尺寸 |
| onClick | `() => void` | - | 点击 |
| disabled | `boolean` | - | 禁用 |
| children | `ReactNode` | - | 内容 |

## Usage
```tsx
import Button from './Button';
<Button variant="primary" onClick={handle}>Send</Button>
```
