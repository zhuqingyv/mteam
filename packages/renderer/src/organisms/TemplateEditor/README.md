# TemplateEditor
角色模板编辑器：name / role / persona / availableMcps（多选）+ Save/Cancel。

## Props
| Prop | Type | Description |
|------|------|-------------|
| template | `Partial<TemplateDraft>` | 初始值 |
| mcpOptions | `string[]` | 可选 MCP 名列表 |
| onSave | `(tpl: TemplateDraft) => void` | 提交回调 |
| onCancel | `() => void` | 取消回调 |

`TemplateDraft = { name; role; persona; availableMcps: string[] }`

## 服务端对接
- `POST/PUT /api/panel/templates/:name` → 创建 / 更新
- 注意：后端 `availableMcps` 是 `McpToolVisibility[]`，前端这里简化为 `string[]`，上层转换可见性。
