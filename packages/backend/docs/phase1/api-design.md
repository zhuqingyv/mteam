# V2 Phase 1 — HTTP API 设计（RoleTemplate CRUD）

> 本文档定义 V2 Phase 1 的 HTTP 接口（服务端 → 前端）。
> Phase 1 仅覆盖**角色模板（RoleTemplate）**的增删改查。
> RoleInstance / Team / Project / Message / Governance / SSE 等接口留到后续 Phase。

---

## 1. 项目结构

接口层按调用方拆成两个目录：前端 Electron Panel 与 MCP 工具（agent）调用方式、权限、参数格式、错误处理都不同，分开组织更清晰。

```
v2/
├── db/              # 数据层（已完成）
├── domain/          # 领域对象（已完成）
├── api/             # 接口层
│   ├── panel/       # Panel（前端 Electron）调的接口
│   │   ├── role-templates.ts   # 模板 CRUD（Phase 1）
│   │   ├── role-instances.ts   # 实例接口（Phase 2）
│   │   ├── teams.ts            # Team 接口（Phase 2）
│   │   └── projects.ts         # Project 接口（Phase 2）
│   └── mcp/         # MCP 工具（agent）调的接口
│       └── ...                 # Phase 2
├── server.ts        # HTTP server 入口，挂载 api/ 下所有路由
└── index.ts         # 统一导出
```

- **api/panel/** — 给前端 Electron UI 用，RESTful，返回 JSON，场景是人在操作。
- **api/mcp/** — 给 agent 用，通过 MCP 协议调工具，场景是 LLM 在调。
- 两者权限、参数格式、错误处理不同，所以分开。
- **server.ts** — HTTP server 入口，创建 `Bun.serve` / `http.createServer`，按路径前缀分发到 `panel/` 或 `mcp/`。
- Phase 1 只实现 `api/panel/role-templates.ts`。

---

## 2. 设计原则

1. **RESTful 风格** — 资源型 URL，HTTP 方法语义标准（GET 读 / POST 建 / PUT 改 / DELETE 删）。
2. **路径前缀 `/api/`** — 与旧版接口物理隔离，避免路由冲突。
3. **响应 JSON** — 所有请求/响应均 `Content-Type: application/json; charset=utf-8`。
4. **PUT 幂等** — 同一 payload 多次调用 PUT 结果一致；不存在则 404（不做 upsert，创建走 POST）。
5. **资源标识走 URL 路径参数** — `/role-templates/:name`，不用 query string（因为 name 是 PK 而非过滤条件）。
6. **字段命名 camelCase** — 与领域对象 `RoleTemplate` 的 TS 字段保持一致，前端无需映射。
7. **时间戳 ISO 8601 字符串** — `createdAt` / `updatedAt` 均为 `"2026-04-21T08:30:00.000Z"` 格式。
8. **统一错误结构** — 任何 4xx / 5xx 响应均返回 `{ "error": "<描述>" }`。
9. **无需鉴权（Phase 1）** — Panel 与 Hub 同机通信，走 loopback；鉴权方案留待 Phase 3+。

---

## 3. 接口总览

| 方法 | 路径 | 说明 | 成功状态码 |
|------|------|------|:---------:|
| POST | `/api/role-templates` | 创建新模板 | 201 |
| GET | `/api/role-templates` | 列出所有模板 | 200 |
| GET | `/api/role-templates/:name` | 获取单个模板 | 200 |
| PUT | `/api/role-templates/:name` | 更新模板（部分字段） | 200 |
| DELETE | `/api/role-templates/:name` | 删除模板 | 204 |

---

## 4. 资源字段定义

`RoleTemplate` 对象的 JSON 表示（所有接口的返回体和请求体共享此结构）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | Y | 模板唯一名（PK），如 `"刺猬"`、`"老锤"`；**创建后不可改** |
| `role` | string | Y | 职业标签：`"dev"` / `"qa"` / `"leader"` / `"architect"` / `"product"` / `"ux"` 等（自由字符串，不强枚举） |
| `description` | string \| null | N | 岗位描述，默认 `null` |
| `persona` | string \| null | N | 身份提示词，实例化时注入 agent，默认 `null` |
| `availableMcps` | string[] | N | 可用 MCP 列表，如 `["mteam", "mnemo"]`，默认 `[]` |
| `createdAt` | string | — | 服务端生成的创建时间（ISO 8601），**只读** |
| `updatedAt` | string | — | 服务端维护的更新时间（ISO 8601），**只读**；任何字段变更都会刷新 |

### 字段校验规则

| 字段 | 规则 | 违规响应 |
|------|------|---------|
| `name` | 非空字符串，长度 1~64；创建时不允许与已有模板重名 | 400 / 409 |
| `role` | 非空字符串，长度 1~32 | 400 |
| `description` | 可为 null 或字符串；长度 ≤ 1024 | 400 |
| `persona` | 可为 null 或字符串；长度 ≤ 8192 | 400 |
| `availableMcps` | 必须是字符串数组；每项长度 1~64；不允许重复项 | 400 |

---

## 5. 接口详细设计

### 5.1 POST `/api/role-templates` — 创建模板

创建一个新的角色模板。`name` 冲突时返回 409。

**请求 Body**

```json
{
  "name": "刺猬",
  "role": "qa",
  "description": "严厉的 QA，擅长破坏性测试",
  "persona": "你是刺猬，一个不放过任何 bug 的 QA 工程师……",
  "availableMcps": ["mteam", "mnemo"]
}
```

| 字段 | 必填 | 说明 |
|------|:----:|------|
| `name` | Y | 模板唯一名 |
| `role` | Y | 职业标签 |
| `description` | N | 默认 `null` |
| `persona` | N | 默认 `null` |
| `availableMcps` | N | 默认 `[]` |

**成功响应**

- 状态码：`201 Created`
- Body：完整的 `RoleTemplate` 对象（包含服务端生成的 `createdAt` / `updatedAt`）

```json
{
  "name": "刺猬",
  "role": "qa",
  "description": "严厉的 QA，擅长破坏性测试",
  "persona": "你是刺猬，一个不放过任何 bug 的 QA 工程师……",
  "availableMcps": ["mteam", "mnemo"],
  "createdAt": "2026-04-21T08:30:00.000Z",
  "updatedAt": "2026-04-21T08:30:00.000Z"
}
```

**错误响应**

| 状态码 | 场景 | 响应示例 |
|:------:|------|---------|
| 400 | 缺少必填字段 / 字段格式不合法 | `{ "error": "name is required" }` |
| 400 | availableMcps 非数组或含非字符串项 | `{ "error": "availableMcps must be an array of strings" }` |
| 409 | `name` 已存在 | `{ "error": "template '刺猬' already exists" }` |
| 500 | 服务端错误 | `{ "error": "internal server error" }` |

**curl 示例**

```bash
curl -X POST http://localhost:PORT/api/role-templates \
  -H "Content-Type: application/json" \
  -d '{
    "name": "刺猬",
    "role": "qa",
    "persona": "你是刺猬……",
    "availableMcps": ["mteam", "mnemo"]
  }'
```

---

### 5.2 GET `/api/role-templates` — 列出所有模板

列出全部模板，按 `createdAt` 升序排序。Phase 1 不做分页 / 过滤。

**请求**

- 无 Body，无 Query。

**成功响应**

- 状态码：`200 OK`
- Body：`RoleTemplate` 对象数组（可能为空数组）

```json
[
  {
    "name": "刺猬",
    "role": "qa",
    "description": "严厉的 QA",
    "persona": "你是刺猬……",
    "availableMcps": ["mteam", "mnemo"],
    "createdAt": "2026-04-21T08:30:00.000Z",
    "updatedAt": "2026-04-21T08:30:00.000Z"
  },
  {
    "name": "老锤",
    "role": "dev",
    "description": null,
    "persona": null,
    "availableMcps": [],
    "createdAt": "2026-04-21T09:00:00.000Z",
    "updatedAt": "2026-04-21T09:00:00.000Z"
  }
]
```

**错误响应**

| 状态码 | 场景 | 响应示例 |
|:------:|------|---------|
| 500 | 服务端错误 | `{ "error": "internal server error" }` |

**curl 示例**

```bash
curl http://localhost:PORT/api/role-templates
```

---

### 5.3 GET `/api/role-templates/:name` — 获取单个模板

按模板名查询。

**请求**

- URL 参数：`:name` — 模板名（URL-encoded，支持中文）
- 无 Body

**成功响应**

- 状态码：`200 OK`
- Body：单个 `RoleTemplate` 对象

```json
{
  "name": "刺猬",
  "role": "qa",
  "description": "严厉的 QA",
  "persona": "你是刺猬……",
  "availableMcps": ["mteam", "mnemo"],
  "createdAt": "2026-04-21T08:30:00.000Z",
  "updatedAt": "2026-04-21T08:30:00.000Z"
}
```

**错误响应**

| 状态码 | 场景 | 响应示例 |
|:------:|------|---------|
| 404 | 模板不存在 | `{ "error": "template '刺猬' not found" }` |
| 500 | 服务端错误 | `{ "error": "internal server error" }` |

**curl 示例**

```bash
curl http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC
```

---

### 5.4 PUT `/api/role-templates/:name` — 更新模板

更新指定模板的字段。`name` 不可改；其它字段均可选，只传要改的字段即可（PATCH 语义，但走 PUT 保持幂等性）。

**请求 Body**

```json
{
  "role": "senior-qa",
  "description": "资深 QA",
  "persona": "你是刺猬，十年经验的 QA……",
  "availableMcps": ["mteam", "mnemo", "mcp-playwright"]
}
```

| 字段 | 必填 | 说明 |
|------|:----:|------|
| `role` | N | 新职业标签 |
| `description` | N | 传 `null` 可清空 |
| `persona` | N | 传 `null` 可清空 |
| `availableMcps` | N | 传 `[]` 可清空，整体替换（非合并） |

- **请求 Body 不得包含 `name`** — 若包含会被忽略（以 URL 中的 `:name` 为准）。
- **`createdAt` / `updatedAt` 在 Body 中会被忽略** — 由服务端维护。
- **更新成功后 `updatedAt` 自动刷新为当前时间**，即使 Body 中无任何字段变化（幂等写入）。
- **空 Body `{}` 是合法请求**，仅刷新 `updatedAt`。

**成功响应**

- 状态码：`200 OK`
- Body：更新后的完整 `RoleTemplate` 对象

```json
{
  "name": "刺猬",
  "role": "senior-qa",
  "description": "资深 QA",
  "persona": "你是刺猬，十年经验的 QA……",
  "availableMcps": ["mteam", "mnemo", "mcp-playwright"],
  "createdAt": "2026-04-21T08:30:00.000Z",
  "updatedAt": "2026-04-21T10:15:00.000Z"
}
```

**错误响应**

| 状态码 | 场景 | 响应示例 |
|:------:|------|---------|
| 400 | 字段格式不合法 | `{ "error": "availableMcps must be an array of strings" }` |
| 404 | 模板不存在（不做 upsert） | `{ "error": "template '刺猬' not found" }` |
| 500 | 服务端错误 | `{ "error": "internal server error" }` |

**curl 示例**

```bash
curl -X PUT http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC \
  -H "Content-Type: application/json" \
  -d '{
    "role": "senior-qa",
    "availableMcps": ["mteam", "mnemo", "mcp-playwright"]
  }'
```

---

### 5.5 DELETE `/api/role-templates/:name` — 删除模板

删除指定模板。若有 `role_instances` 引用（外键），返回 409。

**请求**

- URL 参数：`:name` — 模板名
- 无 Body

**成功响应**

- 状态码：`204 No Content`
- 无 Body

**错误响应**

| 状态码 | 场景 | 响应示例 |
|:------:|------|---------|
| 404 | 模板不存在 | `{ "error": "template '刺猬' not found" }` |
| 409 | 有活跃实例引用该模板（外键约束冲突） | `{ "error": "template '刺猬' is still referenced by active role instances" }` |
| 500 | 服务端错误 | `{ "error": "internal server error" }` |

**curl 示例**

```bash
curl -X DELETE http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC
```

---

## 6. 错误响应规范

### 6.1 统一错误格式

所有 4xx / 5xx 响应 Body 均为：

```json
{ "error": "<人类可读的错误描述>" }
```

- 不使用 `code` 字段（前端靠 HTTP 状态码判断语义）。
- 不使用 `message` / `details` 等额外字段。
- `error` 文案用于前端 toast / 日志展示，英文或中文均可（Phase 1 固定英文，便于日志检索）。

### 6.2 状态码映射

| 状态码 | 含义 | 使用场景 |
|:------:|------|---------|
| 200 | OK | GET / PUT 成功 |
| 201 | Created | POST 成功 |
| 204 | No Content | DELETE 成功 |
| 400 | Bad Request | 请求 Body 字段缺失 / 格式不合法 |
| 404 | Not Found | 模板不存在 |
| 409 | Conflict | 模板名重复 / 被外键引用无法删除 |
| 500 | Internal Server Error | 未预期的服务端错误（DB 崩溃等） |

### 6.3 前端应处理的典型错误

| 操作 | 可能的错误码 | 前端建议 |
|------|:-----------:|---------|
| POST | 400 / 409 | 表单校验提示 / "名字已存在" |
| GET list | 500 | 列表页 toast 并保留上次数据 |
| GET by name | 404 / 500 | 详情页跳回列表 |
| PUT | 400 / 404 / 500 | 表单保留草稿；提示"已被删除" |
| DELETE | 404 / 409 / 500 | 提示"已被删除"或"有实例引用，先下线实例" |

---

## 7. 请求/响应示例（端到端流程）

### 7.1 完整 CRUD 流程

```bash
# 1. 创建
curl -X POST http://localhost:PORT/api/role-templates \
  -H "Content-Type: application/json" \
  -d '{"name":"刺猬","role":"qa","persona":"你是刺猬"}'
# → 201 { "name":"刺猬", ..., "createdAt":"...", "updatedAt":"..." }

# 2. 列表
curl http://localhost:PORT/api/role-templates
# → 200 [ { "name":"刺猬", ... } ]

# 3. 详情
curl http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC
# → 200 { "name":"刺猬", ... }

# 4. 更新
curl -X PUT http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC \
  -H "Content-Type: application/json" \
  -d '{"role":"senior-qa"}'
# → 200 { "name":"刺猬", "role":"senior-qa", ..., "updatedAt":"<刷新>" }

# 5. 删除
curl -X DELETE http://localhost:PORT/api/role-templates/%E5%88%BA%E7%8C%AC
# → 204
```

### 7.2 典型错误流程

```bash
# 重复创建
curl -X POST .../role-templates -d '{"name":"刺猬","role":"qa"}'
# → 409 { "error": "template '刺猬' already exists" }

# 查不存在的
curl .../role-templates/ghost
# → 404 { "error": "template 'ghost' not found" }

# 删除仍被引用的
curl -X DELETE .../role-templates/leader-tpl
# → 409 { "error": "template 'leader-tpl' is still referenced by active role instances" }
```

---

## 8. 未来扩展预留（Phase 1 不实现）

以下接口在后续 Phase 中陆续引入，本次不做设计，仅列出规划标题：

- **RoleInstance 接口** — `/api/role-instances`
  创建 / 查询 / 状态转换（activate / deactivate / clock_out）/ 下线审计

- **Team 接口** — `/api/teams`
  Team CRUD / 成员加入离开 / 团队解散

- **Project 接口** — `/api/projects`
  Project CRUD / 成员关联 / 规则（forbidden / rules）管理 / 进度与经验

- **Message 接口** — `/api/messages`
  点对点消息 / 广播 / 未读标记 / 回复链

- **Governance 接口** — `/api/governance`
  团队级 KV 规则存取

- **SSE 事件流** — `/api/events`
  订阅 `role:created` / `role:transition` / `role:destroyed` / `message:new` 等实时事件，
  供 Panel 做状态同步与未读通知。

- **鉴权层** — 在 Phase 3+ 引入 token / session 校验，所有 `/api/*` 统一经过鉴权中间件。

---

## 9. 与领域对象的映射

本节说明 HTTP 接口与 `v2/domain/role-template.ts` 的一一对应关系，便于服务端实现时对号入座。

| HTTP 接口 | 领域方法 |
|-----------|---------|
| POST `/role-templates` | `RoleTemplate.create(input)` |
| GET `/role-templates` | `RoleTemplate.listAll()` |
| GET `/role-templates/:name` | `RoleTemplate.findByName(name)` |
| PUT `/role-templates/:name` | `RoleTemplate.update(name, patch)` |
| DELETE `/role-templates/:name` | `RoleTemplate.delete(name)` |

**字段映射**：接口 JSON 字段与 `RoleTemplateProps` 完全一致（camelCase），
无需额外转换。`toJSON()` 直接作为 HTTP 响应 Body 即可。

**错误映射**：

| 领域层异常 | HTTP 状态码 |
|-----------|:----------:|
| SQLite UNIQUE 约束冲突（name 重复） | 409 |
| `findByName` 返回 null 且是 GET / PUT / DELETE | 404 |
| 参数校验失败（类型 / 长度 / 必填） | 400 |
| SQLite 外键约束冲突（DELETE 时有引用） | 409 |
| 其它未预期异常 | 500 |
