# Icon
SVG 图标集，支持 close/send/chevron/chevron-down/settings/plus/check/check-double/team。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| name | `'close' \| 'send' \| 'chevron' \| 'chevron-down' \| 'settings' \| 'plus' \| 'check' \| 'check-double' \| 'team'` | - | 图标名 |
| size | `number` | `16` | 尺寸 px |
| color | `string` | `'currentColor'` | 颜色 |

## Usage
```tsx
import Icon from './Icon';
<Icon name="send" size={24} color="#fff" />
<Icon name="team" size={18} />
```
