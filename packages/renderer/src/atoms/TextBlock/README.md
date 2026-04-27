# TextBlock
流式文本块。展示 content，`streaming` 为真时尾部显示闪烁光标。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| content | `string` | - | 文本内容 |
| streaming | `boolean` | `false` | 是否流式（尾部光标） |

## Usage
```tsx
import TextBlock from './TextBlock';
<TextBlock content="你好" streaming />
```
