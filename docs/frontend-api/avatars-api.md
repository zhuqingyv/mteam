# Avatars API

> **面向**：前端 UI（头像库页 / 角色创建页的头像选择器）。头像库负责管理内置头像 + 用户自定义头像，角色模板的 `avatar` 字段存的就是头像库里的 `id`。
>
> **前端调用前缀**：一律走 `/api/panel/avatars/*` 门面层，不直接调 `/api/avatars/*`。

全部返回 JSON。成功 2xx，错误 4xx/5xx + `{ error: string }`。

## TS 类型

```ts
interface AvatarRow {
  id: string;           // 主键，例如 "avatar-01" / "avatar-custom-abc"
  filename: string;     // 文件名，例如 "avatar-01.png"
  builtin: boolean;     // true = 内置；false = 用户上传
  hidden: boolean;      // 仅内置头像可隐藏；GET 列表默认不返回 hidden=true 的
  createdAt: string;    // ISO
}
```
- 内置头像的 `id` 形如 `avatar-01` ~ `avatar-20`；对应文件在 `packages/renderer/src/assets/avatars/avatar-01.png` ~ `avatar-20.png`，128x128 透明背景像素风。
- 用户自定义头像的 `id` 由前端自行生成（建议 `avatar-custom-<uuid 或 hash>`），`filename` 同样由前端决定（文件上传/存储不在本接口范围内，本接口只注册 DB 记录）。

## 内置 vs 自定义：删除/还原语义

| 类型      | `builtin` | DELETE 行为          | restore 行为       |
|-----------|-----------|----------------------|---------------------|
| 内置头像  | `true`    | 软删除（`hidden=1`） | 恢复全部内置        |
| 自定义头像| `false`   | 真删除（DB 移除）    | 不受影响            |

`restore` 只把被隐藏的内置头像 `hidden` 置回 `0`，**不会**恢复已经被真删的用户自定义头像。

---

## `GET /api/panel/avatars`

列所有可见头像（`hidden=0`），包含内置 + 用户自定义。

Response `200`:
```json
{
  "avatars": [
    { "id": "avatar-01", "filename": "avatar-01.png", "builtin": true,  "createdAt": "2026-04-27T10:00:00Z" },
    { "id": "avatar-custom-abc", "filename": "my-avatar.png", "builtin": false, "createdAt": "2026-04-27T12:34:56Z" }
  ]
}
```

空库 → `{ "avatars": [] }`。

---

## `POST /api/panel/avatars`

添加自定义头像（**只注册 DB 记录，不含文件上传**）。`builtin` 恒为 `false`，前端不用传。

Request:
```json
{
  "id": "avatar-custom-abc",
  "filename": "my-avatar.png"
}
```

必填：`id`、`filename`。

Response `201`:
```json
{
  "id": "avatar-custom-abc",
  "filename": "my-avatar.png",
  "builtin": false,
  "createdAt": "2026-04-27T12:34:56Z"
}
```

错误：
- `400` 缺 `id` / `filename`
- `409` `id` 已存在

---

## `DELETE /api/panel/avatars/:id`

删除头像。**行为取决于 `builtin`**：
- 内置头像 → 软删除（`hidden=1`，可通过 restore 还原）
- 自定义头像 → 真删除（DB 移除）

Response `200`:
```json
{ "ok": true }
```

错误：
- `404` `id` 不存在

---

## `POST /api/panel/avatars/restore`

还原所有被隐藏的内置头像（把 `hidden=1` 的内置条目改回 `hidden=0`）。用户自定义头像不受影响。

Request: 无 body。

Response `200`:
```json
{ "restored": 5 }
```

`restored` = 本次被恢复的条目数（可能为 `0`）。

---

## `GET /api/panel/avatars/random`

随机返回一个可见头像（仅从 `hidden=0` 中抽取）。

典型用途：创建角色模板时默认头像。

Response `200`:
```json
{
  "avatar": { "id": "avatar-13", "filename": "avatar-13.png", "builtin": true, "createdAt": "..." }
}
```

库空（所有头像都被隐藏或删光） → `{ "avatar": null }`。

---

## 和角色模板的联动

`RoleTemplate.avatar` 字段存的就是本接口返回的 `AvatarRow.id`：

```ts
interface RoleTemplate {
  // ...
  avatar: string | null;  // 头像 id，如 "avatar-01"；null = 未指定
}
```

前端典型流程：
1. 创建模板时，先 `GET /api/panel/avatars` 列表或 `GET /api/panel/avatars/random` 给个默认；
2. `POST /api/panel/templates` 时带上 `avatar: "avatar-01"`；
3. 渲染时用 `avatar` id 映射到 `packages/renderer/src/assets/avatars/<id>.png`（内置）或用户自定义的文件路径。

模板字段细节见 [templates-and-mcp.md §types](./templates-and-mcp.md)。

---

## 错误码汇总

| Status | 场景                                     |
|--------|------------------------------------------|
| 400    | POST 缺 `id` / `filename`                |
| 404    | DELETE 的 `id` 不存在                    |
| 409    | POST 的 `id` 已存在                      |
