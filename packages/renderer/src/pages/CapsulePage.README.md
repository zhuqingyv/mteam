# CapsulePage
胶囊主窗口入口：`CapsuleWindow` + `CapsuleCard` + `ExpandedView`。
收起/展开动画状态由 `useCapsuleToggle` 管理。

## Entry
URL 无 `window` 参数时默认渲染该页（见 `App.tsx` 路由）。

## Composes
- `templates/CapsuleWindow`
- `organisms/CapsuleCard`
- `organisms/ExpandedView`
- `hooks/useCapsuleToggle`
