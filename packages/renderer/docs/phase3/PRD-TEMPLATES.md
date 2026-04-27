# PRD：员工模板功能

**版本**：1.0  
**创建日期**：2026-04-27  
**目标日期**：2026-05-10  
**审阅人**：ux-template / fe-template

---

## 1 需求背景

### 1.1 员工模板是什么

员工模板（Role Template）是预定义的角色配置集合，用于快速创建具有相同能力和行为的多个 Agent 实例（角色员工）。模板包含角色名、描述、系统提示词、可用 MCP 工具配置等元数据，一旦确定就不再修改。

### 1.2 用户为什么需要它

- **快速创建角色**：不需要每次都从零开始配置，一次定义、多次复用
- **一致性**：同类角色具有相同的行为特征和能力配置，便于团队协作和可维护性
- **模板库管理**：支持创建、编辑、删除、查看模板，形成可复用的角色库
- **灵活的工具配置**：不同角色可见不同的 MCP 工具，支持首屏展示和搜索白名单分离

### 1.3 与其他模块的关系

```
员工模板
  ├─ 用于创建 RoleInstance（角色实例）
  ├─ 绑定 MCP 工具白名单（首屏 surface + 搜索 search）
  ├─ 关联头像库（avatar id）
  └─ 被 Primary Agent 引用（通过 mteam-primary MCP 创建 Leader）
```

---

## 2 用户故事与流程

### 故事 1：查看所有可用模板

**场景**：产品经理想看当前有哪些模板可用

**步骤**：
1. 打开模板管理页面
2. 页面自动列出所有模板（按创建时间升序）
3. 看到每个模板的基本信息：名称、角色、描述、最后更新时间

**验收标准**：
- 列表能加载所有模板
- 显示字段完整（至少：name / role / description / updatedAt）
- 排序符合 API 返回顺序

---

### 故事 2：创建新模板

**场景**：需要创建一个"前端工程师"角色模板

**步骤**：
1. 点击"新建模板"按钮
2. 填写表单：
   - 模板名称（必填）：`frontend-engineer`
   - 角色（必填）：`engineer`
   - 描述（可选）：`Frontend developer focused on React/TypeScript`
   - 系统提示词（可选，≤8192 字符）
   - 可用 MCP 工具（可选）：勾选 `filesystem`, `git`, `github`
   - 头像：进入表单时由后端随机分配一个（调 `GET /api/panel/avatars/random`），头像旁有"选择头像"入口，点击弹出头像选择面板（详见故事 6）
3. 点击保存
4. 模板创建成功，列表中出现新条目，显示 toast 通知

**验收标准**：
- 表单验证正确（模板名 1-64 字符，无重复）
- 保存时 POST `/api/panel/templates`，request body 符合 API
- 响应 201 返回完整的 RoleTemplate 对象
- 成功后列表自动刷新（或接收 WS `template.created` 事件）
- 重复名称时返回 409，前端显示错误提示
- 打开表单时头像字段默认已填充（随机内置头像），用户不选也能保存

---

### 故事 3：编辑已有模板

**场景**：已有"前端工程师"模板，需要更新系统提示词

**步骤**：
1. 在模板列表中找到模板，点击"编辑"
2. 进入编辑页面（与创建表单相同结构）
3. 修改系统提示词或 MCP 工具配置
4. 点击保存
5. 模板更新成功

**验收标准**：
- 进入编辑时，表单预填当前模板的所有字段
- 只能修改 `role` / `description` / `persona` / `availableMcps` / `avatar`
- 模板名不可改
- PUT `/api/panel/templates/:name`，request body 字段可选
- 响应 200 返回更新后的 RoleTemplate
- 列表自动刷新或接收 WS `template.updated` 事件
- 头像区域显示当前 `avatar` 对应的图片，点击可打开选择面板换头像（详见故事 6）

---

### 故事 4：删除模板

**场景**：某个过时模板不再使用，要删除

**步骤**：
1. 在模板列表中找到模板
2. 点击"删除"按钮，确认对话框
3. 模板删除成功

**验收标准**：
- 删除前显示确认对话框
- 若有活跃实例还在使用此模板，返回 409，前端显示"无法删除：此模板有 N 个活跃实例"
- 删除成功返回 204
- 列表自动刷新或接收 WS `template.deleted` 事件

---

### 故事 5：用模板创建 Agent 实例

**场景**：选择"前端工程师"模板，快速创建一个成员实例

**步骤**：
1. 在模板列表中，点击模板右侧的"创建实例"按钮
2. 弹出对话框，要求输入实例名（如 `alice-frontend`）
3. 确认后调用 `/api/panel/instances` POST，使用模板配置预填
4. 实例创建成功，列表更新

**验收标准**：
- 对话框简洁（只问实例名，其他从模板继承）
- 发送 POST `/api/panel/instances` with `{ name: ..., templateName: ... }`
- 实例 list 自动刷新

---

### 故事 6：选择/更换模板头像

**场景**：用户在创建或编辑模板时，想换掉默认头像

**步骤**：
1. 进入创建/编辑表单后，"头像"区域显示当前头像（创建时是随机默认头像，编辑时是模板已有头像）
2. 点击头像（或其旁边的"选择头像"入口）
3. 弹出头像选择面板，面板顶部有一个 🎲 "随机"按钮，下方是内置头像网格（默认 20 张：`avatar-01.png` ~ `avatar-20.png`）+ 可能存在的用户自定义头像
4. 点击任一头像，面板关闭，所选头像 id 回填到表单的 `avatar` 字段，表单头像区预览随之更新
5. 点击 🎲 随机，前端调 `GET /api/panel/avatars/random` 拿到一个随机头像，回填 + 更新预览（不关闭面板，可继续再点）
6. 点面板外/关闭按钮，不回填，保留之前的选中

**验收标准**：
- 打开创建表单时，前端立即调用 `GET /api/panel/avatars/random`，把返回的 `avatar.id` 填到表单，并在头像区渲染对应图片
- 进入编辑表单时，直接使用模板已有的 `avatar` 字段渲染，**不要**覆盖为随机头像
- 选择面板的头像网格来自 `GET /api/panel/avatars`，内置 + 自定义统一展示
- 网格中当前已选中的头像有选中样式（如描边高亮）
- 随机按钮每次点击都 fetch 一次 `/avatars/random`，正确处理库空情况（`avatar: null` → toast 提示"无可用头像"）
- 选中/随机切换后，表单 state 中的 `avatar` 字段立即更新，保存时 POST/PUT body 带正确的 `avatar` id
- 头像 id → 图片 URL 的映射：内置 `avatar-NN` 映射到 `packages/renderer/src/assets/avatars/avatar-NN.png`；自定义头像按 `AvatarRow.filename` 映射到对应 URL

---

### 故事 7：通过 ToolBar 打开成员面板

**场景**：用户在主窗口工作，需要快速查看/管理团队成员

**步骤**：
1. 主窗口底部 ToolBar 展开态布局为：`[Claude ▾] ... [成员面板] [⚙设置]`，"成员面板"按钮位于设置齿轮左边
2. 点击"成员面板"按钮
3. 如果成员面板窗口未打开，调用 `window.electronAPI.openTeamPanel()` 打开独立 BrowserWindow（1200×800）；按钮切换到"激活"视觉态
4. 如果成员面板窗口已打开，再次点击按钮则关闭窗口（toggle 行为）；按钮回到默认态
5. 用户直接关闭成员面板窗口时，主窗口按钮应感知并回到默认态

**验收标准**：
- ToolBar 展开态可见"成员面板"按钮，位置在设置齿轮左侧，顺序为 `[Claude ▾] ... [成员面板] [⚙设置]`
- ToolBar 收起态不显示该按钮（与其它非核心操作一致）
- 点击按钮通过 `window.electronAPI.openTeamPanel()` 打开/关闭 Team Panel 独立窗口
- 按钮有激活/默认两种视觉态，与面板窗口实际显示/隐藏状态一致
- 通过外部（点窗口关闭、快捷键等）关闭面板后，主窗口按钮状态能正确回退（可通过 IPC 事件或轮询同步，实现细节待前端决定）

---

## 3 功能描述

### 3.1 模板管理页面整体布局

```
┌─────────────────────────────────────────┐
│  角色模板                               │
│  [+ 新建模板]  [搜索/筛选]              │
├─────────────────────────────────────────┤
│                                         │
│  ┌─ 模板卡片 ────────────────────────┐ │
│  │ Name: frontend-engineer           │ │
│  │ Role: engineer                    │ │
│  │ Desc: Frontend developer focused  │ │
│  │ Updated: 2026-04-27 10:30         │ │
│  │ Tools: filesystem, git, github    │ │
│  │ [编辑] [删除] [创建实例]           │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌─ 模板卡片 ────────────────────────┐ │
│  │ Name: qa-engineer                 │ │
│  │ ...                               │ │
│  └───────────────────────────────────┘ │
│                                         │
└─────────────────────────────────────────┘
```

### 3.2 新建/编辑模板表单

```
┌─────────────────────────────────────┐
│ 新建模板                             │
├─────────────────────────────────────┤
│                                     │
│ 模板名 *          [           ]     │
│ (1-64 字符)                         │
│                                     │
│ 角色 *            [           ]     │
│ (1-32 字符)                         │
│                                     │
│ 描述              [           ]     │
│ (≤1024 字符)      [           ]     │
│                                     │
│ 系统提示词        [           ]     │
│ (≤8192 字符)      [           ]     │
│                                     │
│ 头像              [ 🖼️ avatar-03 ]   │
│ (点击打开选择面板，默认随机填充)     │
│                                     │
│ 可用 MCP 工具                       │
│ ☐ filesystem      ☑ git            │
│ ☑ github          ☐ shell          │
│ ...                                 │
│                                     │
│ [保存]  [取消]                       │
│                                     │
└─────────────────────────────────────┘
```

### 3.3 头像选择面板

```
┌──────────────── 选择头像 ──────────┐
│  [ 🎲 随机 ]                        │
├────────────────────────────────────┤
│  [01] [02] [03] [04] [05]           │
│  [06] [07] [08] [09] [10]           │
│  [11] [12] [13] [14] [15]           │
│  [16] [17] [18] [19] [20]           │
│  ── 自定义 ──                       │
│  [custom-abc] [custom-def] ...      │
│                                     │
│  当前选中：avatar-03（高亮描边）    │
└────────────────────────────────────┘
```

- 触发：表单中点击头像预览区或"选择头像"入口
- 数据源：`GET /api/panel/avatars`（列出所有可见头像，内置 + 自定义）
- 随机按钮：点击即调 `GET /api/panel/avatars/random`，回填并刷新预览，不关闭面板
- 选中一张头像：关闭面板，`avatar` 字段更新
- 关闭不保存：点面板外/关闭按钮，保留之前的 `avatar`

### 3.4 ToolBar 展开态布局（成员面板入口）

```
┌──────────────────────────────────────────────┐
│ [Claude ▾]   ...中间区域...   [成员面板] [⚙] │
└──────────────────────────────────────────────┘
```

- 仅展开态展示"成员面板"按钮；收起态隐藏
- 位置固定：设置齿轮（⚙）左侧，紧邻
- 点击行为：toggle 独立 Team Panel 窗口（1200×800）
  - 关 → 开：调 `window.electronAPI.openTeamPanel()` 打开窗口，按钮切换到 active 视觉态
  - 开 → 关：再次点击关闭窗口，按钮恢复默认态
- 按钮视觉态须与面板窗口真实显隐状态同步，包括用户直接关窗口的场景

### 3.5 API 调用流程

#### 列表加载
```
GET /api/panel/templates
→ RoleTemplate[]
→ 前端渲染列表
```

#### 创建
```
POST /api/panel/templates
body: {
  name: string,           // 1-64 chars, unique
  role: string,           // 1-32 chars
  description?: string,   // ≤1024
  persona?: string,       // ≤8192
  avatar?: string,        // avatar id or null
  availableMcps?: [{name, surface, search}]
}
→ 201 RoleTemplate
→ WS event: template.created
→ 列表刷新或推送新条目
```

#### 编辑
```
PUT /api/panel/templates/:name
body: {
  role?: string,
  description?: string,
  persona?: string,
  avatar?: string,
  availableMcps?: [...]
}
→ 200 RoleTemplate
→ WS event: template.updated
→ 列表刷新对应条目
```

#### 删除
```
DELETE /api/panel/templates/:name
→ 204 (成功) / 409 (有活跃实例)
→ WS event: template.deleted
→ 列表移除条目
```

#### 从模板创建实例
```
POST /api/panel/instances
body: {
  name: string,
  templateName: string,  // 使用此模板的配置
  ...
}
→ 201 RoleInstance
```

#### 头像列表（选择面板）
```
GET /api/panel/avatars
→ { avatars: AvatarRow[] }   // 内置 + 自定义，全部 hidden=0
→ 用于渲染选择面板网格
```

#### 随机头像（创建默认 / 🎲 随机按钮）
```
GET /api/panel/avatars/random
→ { avatar: AvatarRow | null }   // 库空返回 null
→ 进入创建表单时调用一次作为默认 avatar
→ 选择面板里点 🎲 时调用
```

详细头像接口文档见 [docs/frontend-api/avatars-api.md](../../../docs/frontend-api/avatars-api.md)。

---

## 4 数据模型

### 4.1 RoleTemplate

```typescript
interface RoleTemplate {
  name: string;                    // PK, 1-64 字符，英文数字下划线
  role: string;                    // 角色简称, 1-32 字符
  description: string | null;      // 描述，≤1024 字符
  persona: string | null;          // 系统提示词，≤8192 字符
  avatar: string | null;           // 头像 id，如 "avatar-01"；null 表示未指定
  availableMcps: McpToolVisibility[]; // MCP 工具配置
  createdAt: string;               // ISO 8601
  updatedAt: string;               // ISO 8601
}
```

### 4.2 McpToolVisibility

```typescript
interface McpToolVisibility {
  name: string;                   // MCP server 名，如 "mteam"
  surface: string[] | '*';        // 首屏展示工具，'*' = 全部
  search: string[] | '*';         // 搜索可见工具，'*' = 全部
}
```

**示例**：
```json
{
  "name": "frontend-engineer",
  "role": "engineer",
  "description": "Frontend developer focused on React/TypeScript",
  "persona": "You are a skilled frontend engineer...",
  "avatar": "avatar-03",
  "availableMcps": [
    {
      "name": "mteam",
      "surface": ["send_msg", "read_message"],
      "search": "*"
    },
    {
      "name": "filesystem",
      "surface": "*",
      "search": "*"
    }
  ],
  "createdAt": "2026-04-27T10:00:00Z",
  "updatedAt": "2026-04-27T10:30:00Z"
}
```

---

## 5 验收测试用例

### 5.1 列表页

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 页面加载时自动拉取列表 | 打开模板页面 | GET 发出，列表显示，按 createdAt 升序 |
| 2 | 空列表提示 | 若无模板 | 显示"暂无模板"提示，"新建模板"按钮可用 |
| 3 | 模板卡片显示完整信息 | 列表有模板 | 显示 name/role/description/updatedAt |

### 5.2 创建功能

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 必填项验证 | 提交空表单 | 提示"模板名/角色为必填" |
| 2 | 模板名长度验证 | 输入 65 个字符 | 提示"模板名不超过 64 字符" |
| 3 | 模板名唯一性 | 重复现有模板名 | 提示"模板已存在" |
| 4 | 成功创建 | 填完表单，点保存 | 201 返回，列表新增条目，toast 成功 |
| 5 | 可用 MCP 多选 | 勾选多个 MCP | availableMcps 数组包含全部选中项 |
| 6 | 头像默认随机分配 | 打开创建表单 | 前端调 `GET /api/panel/avatars/random`，表单 avatar 字段被填充，头像区渲染对应图片 |
| 7 | 用户不改头像也能保存 | 用默认随机头像直接保存 | POST body 带有 avatar（非 null），创建成功 |
| 8 | 系统提示词长度验证 | 输入超 8192 字符 | 提示或截断 |

### 5.3 编辑功能

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 编辑时预填表单 | 点编辑 | 所有字段预填当前值 |
| 2 | 模板名不可改 | 尝试改模板名 | 输入框禁用或隐藏 |
| 3 | 更新成功 | 改某字段，保存 | 200 返回，列表更新 |
| 4 | 更新 MCP 配置 | 改 availableMcps | PUT body 包含正确的数组 |
| 5 | 编辑时不覆盖已有头像 | 打开编辑表单 | 头像区直接显示模板原有 `avatar`，不调 `/avatars/random` |

### 5.4 删除功能

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 删除确认 | 点删除 | 弹出确认对话框 |
| 2 | 成功删除 | 确认删除 | 204 返回，列表移除条目 |
| 3 | 有活跃实例时禁删 | 模板被实例使用 | 返回 409，显示"有 N 个实例使用此模板" |

### 5.5 从模板创建实例

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 创建实例对话框 | 点"创建实例" | 弹出输入框，要求输入实例名 |
| 2 | 实例创建成功 | 输入实例名，确认 | POST /api/panel/instances 发出，实例列表更新 |

### 5.6 头像选择器

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 打开选择面板 | 点击表单头像区 | 弹出面板，顶部有 🎲 随机按钮，下方是头像网格 |
| 2 | 网格数据来自后端 | 打开面板 | 前端调 `GET /api/panel/avatars`，渲染返回的每一项（内置 + 自定义） |
| 3 | 当前头像高亮 | 打开面板时表单已有 `avatar: avatar-03` | 网格中 `avatar-03` 有选中样式（描边高亮） |
| 4 | 点击头像回填 | 点网格中某头像 | 面板关闭，表单 `avatar` 字段 = 该头像 id，头像区预览更新 |
| 5 | 随机按钮 | 点 🎲 随机 | 调 `GET /api/panel/avatars/random`，预览更新为新头像，面板不关闭 |
| 6 | 随机遇到空库 | 所有头像都被隐藏时点随机 | API 返回 `{ avatar: null }`，前端显示 toast"无可用头像"，不改动表单 |
| 7 | 关闭不保存 | 点面板外或关闭按钮 | 面板关闭，表单 `avatar` 保留之前值 |
| 8 | 自定义头像能选 | 库里有 `avatar-custom-xxx` | 网格显示该头像，可选中并回填 |

### 5.7 ToolBar 成员面板按钮

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 展开态按钮可见 | ToolBar 处于展开态 | 可见"成员面板"按钮，位置在 `[⚙设置]` 左侧 |
| 2 | 收起态按钮隐藏 | ToolBar 处于收起态 | 不显示"成员面板"按钮 |
| 3 | 打开面板 | 面板未开，点击按钮 | 调用 `window.electronAPI.openTeamPanel()`，Team Panel 窗口打开（1200×800），按钮切到 active 态 |
| 4 | 关闭面板（toggle） | 面板已开，再点按钮 | Team Panel 窗口关闭，按钮回到默认态 |
| 5 | 外部关窗同步态 | 面板已开，用户点窗口关闭 | 主窗口按钮回到默认态（非 active） |
| 6 | 按钮位置顺序 | 查看展开态 ToolBar DOM | 顺序为 `[Claude ▾] ... [成员面板] [⚙设置]` |

### 5.8 实时事件

| # | 用例 | 步骤 | 期望结果 |
|---|------|------|---------|
| 1 | 其他客户端创建模板 | 另一窗口创建 | 当前窗口收到 WS template.created，列表更新 |
| 2 | 其他客户端编辑模板 | 另一窗口编辑 | 当前窗口收到 WS template.updated，卡片更新 |
| 3 | 其他客户端删除模板 | 另一窗口删除 | 当前窗口收到 WS template.deleted，卡片移除 |

---

## 6 API 契约

### 6.1 端点映射

```
前端路径                          → 后端路径
/api/panel/templates              → /api/role-templates
/api/panel/templates/:name        → /api/role-templates/:name
/api/panel/templates/:name        → /api/role-templates/:name (PUT/DELETE)
/api/panel/avatars                → /api/avatars
/api/panel/avatars/random         → /api/avatars/random
/api/panel/avatars/:id            → /api/avatars/:id (DELETE)
/api/panel/avatars/restore        → /api/avatars/restore
```

### 6.2 详细规范

详见 [docs/frontend-api/templates-and-mcp.md](../../../docs/frontend-api/templates-and-mcp.md)

**关键点**：
- GET `/api/panel/templates` 返回按 createdAt 升序排序的数组
- POST 创建时 name 重复返回 409
- PUT 增量更新（name 不可改）
- DELETE 当有活跃实例时返回 409
- 所有写操作 emit bus 事件：`template.created` / `template.updated` / `template.deleted`

### 6.3 错误处理

| 状态码 | 场景 | 前端处理 |
|--------|------|---------|
| 400 | 请求参数无效（如超长、格式错误） | 显示表单错误提示 |
| 409 | 模板名重复 / 有活跃实例使用此模板 | 显示 modal 或 toast 提示用户 |
| 404 | 模板不存在 | 重新拉列表，提示"模板已被删除" |
| 500 | 服务器错误 | 显示 toast 错误，建议重试 |

---

## 7 交付清单

### 前端

- [ ] `TemplateList` 组件（列表页）
  - [ ] 加载动画
  - [ ] 空状态提示
  - [ ] 模板卡片展示
  - [ ] 编辑/删除/创建实例按钮
  
- [ ] `TemplateEditor` 组件（新建/编辑表单）
  - [ ] 已存在，需扩展为完整功能
  - [ ] 字段验证
  - [ ] MCP 工具多选
  - [ ] 头像字段：创建时调 `/avatars/random` 默认填充，编辑时用模板现有 `avatar`
  - [ ] 头像预览区可点击打开选择面板

- [ ] `AvatarPicker` 组件（头像选择面板）
  - [ ] 从 `GET /api/panel/avatars` 拉全部可见头像
  - [ ] 顶部 🎲 随机按钮 → `GET /api/panel/avatars/random`
  - [ ] 内置 20 张 + 自定义头像分组渲染
  - [ ] 当前选中高亮
  - [ ] 点选回填并关闭；点外/关闭按钮不回填
  - [ ] 空库时随机按钮给 toast 提示

- [ ] ToolBar 改造（成员面板入口）
  - [ ] 展开态新增"成员面板"按钮，位置在 `[⚙设置]` 左侧
  - [ ] 点击 toggle `window.electronAPI.openTeamPanel()`
  - [ ] active/默认两种视觉态，与面板窗口真实显隐同步
  - [ ] 用户直接关面板窗口时按钮态回退

- [ ] 状态管理
  - [ ] 模板列表 store（useTemplateStore）
  - [ ] WS 事件订阅（template.created / updated / deleted）
  - [ ] 成员面板窗口显隐状态（或通过 IPC 事件同步）
  
- [ ] 路由
  - [ ] `/templates` 主页面
  - [ ] `/templates/new` 新建页面（或模态）
  - [ ] `/templates/:name/edit` 编辑页面（或模态）

### 后端

- [ ] `/api/panel/templates` CRUD 端点（前端门面）
- [ ] `/api/role-templates` 底层业务逻辑
- [ ] 模板验证（长度、唯一性、格式）
- [ ] 活跃实例检查（删除时）
- [ ] Bus 事件发送（template.created / updated / deleted）

### QA

- [ ] 功能测试：覆盖全部 5 类用例（列表/创建/编辑/删除/事件）
- [ ] 集成测试：从模板创建实例的端到端流程
- [ ] 多客户端测试：WS 实时更新
- [ ] 边界测试：超长字符串、特殊字符、并发操作

---

## 8 附录：UI 草图参考

### 8.1 模板卡片设计

```
┌──────────────────────────────────────┐
│ [头像]  frontend-engineer            │
│         Role: engineer               │
│         Frontend developer focused   │
│         on React/TypeScript          │
│                                      │
│ MCP: filesystem, git, github         │
│ Updated: 2026-04-27 10:30            │
│                                      │
│ [编辑] [创建实例] [删除]              │
└──────────────────────────────────────┘
```

### 8.2 MCP 工具选择器

```
Available MCPs:
☐ mteam (builtin)
  ├─ surface: [send_msg] [read_message]
  └─ search: *

☑ filesystem
  ├─ surface: *
  └─ search: *

☑ git
  ├─ surface: *
  └─ search: *
```

---

## 9 时间表

| 阶段 | 任务 | 完成日期 |
|------|------|---------|
| 分析 | 理解 API 契约，确认设计方案 | 2026-04-27 |
| 设计 | UI 原型、组件拆分 | 2026-04-28 |
| 开发 | 前端模板管理页 + 状态管理 | 2026-04-30 |
| 集成 | 与后端 API 联调 | 2026-05-02 |
| QA | 功能/集成/边界测试 | 2026-05-05 |
| 交付 | 代码审查、文档更新、demo | 2026-05-10 |

---

**签署**：

- **产品**：_____________________ 日期：_____
- **前端 Lead**：_____________________ 日期：_____
- **后端 Lead**：_____________________ 日期：_____
