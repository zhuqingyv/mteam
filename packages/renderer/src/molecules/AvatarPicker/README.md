# AvatarPicker
网格头像选择器。顶部随机按钮，网格展示可选头像，选中态边框高亮 + check 角标。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| avatars | `AvatarRow[]` | - | 头像列表（来自 `GET /api/panel/avatars`） |
| value | `string \| null` | - | 当前选中头像 id |
| onChange | `(id: string) => void` | - | 选中变更回调 |
| onRandom | `() => void` | - | 随机按钮回调；未传则不显示随机按钮 |
| columns | `number` | `5` | 网格列数 |
| disabled | `boolean` | `false` | 整体禁用 |
| loading | `boolean` | `false` | 加载中（显示骨架屏） |

## AvatarRow
```ts
interface AvatarRow {
  id: string;         // 如 "avatar-01"
  filename: string;   // 如 "avatar-01.png"
  builtin: boolean;   // true = 内置，false = 用户上传
  createdAt?: string;
}
```
内置头像（`builtin=true`）从 `src/assets/avatars/<filename>` 解析。自定义走 `/avatars/<filename>` 占位，待后端静态目录落地。

## Usage
```tsx
import AvatarPicker from './AvatarPicker';

<AvatarPicker
  avatars={avatars}
  value={selected}
  onChange={setSelected}
  onRandom={handleRandom}
  columns={5}
/>
```
