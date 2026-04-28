# MenuDots
六点图标。默认等价 `<Button variant="dots" />`；`asDragHandle` 模式作为 Electron 窗口拖动手柄（`-webkit-app-region: drag`，hover `grab` / active `grabbing`），无点击语义。

## Props
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| onClick | `() => void` | - | 点击（仅按钮模式） |
| disabled | `boolean` | `false` | 禁用（仅按钮模式） |
| asDragHandle | `boolean` | `false` | 作为窗口拖动手柄 |

## Usage
```tsx
// 作菜单按钮
<MenuDots onClick={openMenu} />
// 作窗口拖动手柄（Electron）
<MenuDots asDragHandle />
```
