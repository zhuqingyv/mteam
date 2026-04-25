# AgentList
Agent 实例列表：状态点 + 名字 + 当前任务 + 操作按钮（激活 / 请求下线 / 删除）。

## Props
| Prop | Type | Description |
|------|------|-------------|
| agents | `AgentListItem[]` | 列表数据 `{ id, name, status, task? }` |
| onActivate | `(id) => void` | 仅 `offline` 显示 |
| onRequestOffline | `(id) => void` | `idle`/`running` 显示 |
| onDelete | `(id) => void` | 总是显示 |

## 服务端对接
- `GET /api/panel/instances` → 列表
- `POST /api/panel/instances/:id/activate`
- `POST /api/panel/instances/:id/request-offline`
- `DELETE /api/panel/instances/:id`
