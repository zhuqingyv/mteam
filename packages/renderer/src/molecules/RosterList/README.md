# RosterList
通讯录列表：名字 + alias（可编辑）+ scope 标签。

## Props
| Prop | Type | Description |
|------|------|-------------|
| entries | `RosterListEntry[]` | `{ id, name, alias?, scope }` |
| onEditAlias | `(id, alias) => void` | 别名提交（Enter 或失焦）|

## 交互
- 点击 alias 进入编辑（Enter 提交 / Esc 取消 / blur 提交）
- 空 alias 显示 "set alias" 占位

## 服务端对接
- `GET /api/panel/roster` → 列表
- `PUT /api/panel/roster/:id/alias { alias }` → 改别名
