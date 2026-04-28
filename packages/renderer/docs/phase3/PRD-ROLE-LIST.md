# PRD：角色列表窗口

**版本**：1.0  
**创建日期**：2026-04-27  
**目标日期**：2026-05-10  
**审阅人**：ux-role-list / fe-role-list

---

## 1 需求背景

### 1.1 问题陈述

当前 👥 按钮打开的是 TeamPage（显示"尚未创建团队"），这是错的。正确的行为是打开**角色列表窗口**，展示 11 个内置成员模板。

### 1.2 核心概念（已用户纠正）

- **成员模板**（Role Templates）= 角色配方。后端内置 11 个。对用户叫"成员"。
- **成员实例**（Role Instances）= 基于模板创建的运行时干活的人。对用户叫"成员在干活"。
- **角色列表窗口** = 展示模板的独立 BrowserWindow，用户从此创建实例。
- **TeamCanvas** = 运行时团队画布，展示活跃实例（已分离）。

两个独立入口：
```
👥 按钮 → 角色列表窗口（模板管理）
[创建团队] → TeamCanvas（运行时团队）
```

---

## 2 需求说明

### 2.1 入口

- **触发方**：主窗口 ToolBar 的 👥 按钮（位于"成员面板"按钮位置）
- **行为**：打开独立 BrowserWindow（1200×800），展示角色列表
- **窗口类型**：模态（不要关闭主窗口时被拖走），与 TeamPanel 同类型
- **重复点击**：窗口已开，再点则不打开第二个（focus 存在的窗口即可）

### 2.2 功能范围

角色列表窗口包含：

| 功能 | 说明 | 范围 |
|-----|------|------|
| 查看模板列表 | 显示所有 RoleTemplate，卡片网格展示 | 🟢 本 PRD |
| 创建模板 | 新建自定义模板 | 🟢 本 PRD |
| 编辑模板 | 修改模板配置 | 🟢 本 PRD |
| 删除模板 | 删除模板（检查活跃实例） | 🟢 本 PRD |
| 从模板创建实例 | 快速创建成员实例 | 🟢 本 PRD |
| 头像选择器 | 管理和选择模板头像 | 🟢 本 PRD（与 PRD-TEMPLATES 重叠部分复用） |
| MCP 工具配置 | 设置模板可见工具 | 🟢 本 PRD |

**不包含**：
- ❌ 实例运行时管理（下线、删除）— 那是 TeamCanvas 的事
- ❌ 主 Agent 配置（那是 Primary Agent Config 的事）
- ❌ CLI 扫描器（那是全局设置）

---

## 3 用户故事

### 故事 1：打开角色列表窗口

**场景**：用户在主窗口工作，想查看/管理成员模板

**步骤**：
1. 点击 ToolBar 的 👥 按钮
2. 打开独立 BrowserWindow（1200×800），标题"角色列表"
3. 窗口显示模板卡片网格，默认展示后端内置的 11 个模板

**验收标准**：
- 窗口配置：1200×800，模态，centered，icon 设置为团队图标
- 文档标题：`<title>角色列表 - MCP Team Hub</title>`
- 窗口 class / data-attr 便于测试定位：`data-window="role-list"`
- 重复点击：存在窗口被 focus，不打开新窗口

---

### 故事 2：查看所有模板

**场景**：查看系统里有哪些可用的成员模板

**步骤**：
1. 窗口加载时自动调用 `GET /api/role-templates`
2. 获取 RoleTemplate 数组，按 createdAt 升序
3. 渲染卡片列表（网格布局，3-4 卡/行）

**验收标准**：
- 页面加载 500ms 内发出 GET 请求
- 每张卡片显示：
  - 头像（如果 `avatar` 非 null）
  - 模板名（name）
  - 角色标签（role）
  - 描述摘要（description，截断至 3 行）
  - MCP 工具标签（显示 availableMcps 中的 mcpServer 名，最多 3 个，超出显示 "+N"）
  - 操作按钮：编辑、删除、创建实例
- 空列表：如无任何模板，显示"暂无模板"提示和"新建模板"按钮
- 加载态：显示骨架屏或 loading 旋转

---

### 故事 3：创建新模板

**场景**：创建自定义成员模板

**步骤**：
1. 点击列表顶部"+ 新建模板"按钮
2. 打开"新建模板"对话框或抽屉（表单）
3. 填写：
   - 模板名（必填，1-64）
   - 角色（必填，1-32）
   - 描述（可选，≤1024）
   - 系统提示词（可选，≤8192）
   - 头像（创建时自动调 `GET /api/panel/avatars/random` 作为默认值，用户可点击切换）
   - 可用 MCP 工具（多选 availableMcps，内置 mteam + 用户安装的 MCP）
4. 点保存
5. 模板创建成功，列表更新

**验收标准**：
- 表单验证：name 长度 1-64，role 1-32，persona ≤8192，description ≤1024
- 名称唯一性：重复时返回 409，前端显示"模板已存在"
- 头像默认随机：打开创建表单时立即调 `GET /api/panel/avatars/random`，填到 `avatar` 字段，头像区预览该头像对应的图片
- 用户不改头像也能保存：用默认随机头像点保存，POST body 包含 `avatar` 非 null
- 保存后 POST `/api/role-templates`，返回 201 + RoleTemplate
- 列表自动更新（或接收 WS `template.created` 事件）
- toast 提示"模板创建成功"

---

### 故事 4：编辑模板

**场景**：修改已有模板的配置

**步骤**：
1. 在卡片右侧点"编辑"按钮
2. 打开"编辑模板"对话框，表单预填所有字段
3. 修改 role/description/persona/availableMcps/avatar
4. 点保存
5. 模板更新成功

**验收标准**：
- 模板名不可改（禁用输入框或隐藏）
- 编辑时头像显示当前 `avatar` 对应的图片，**不调 `/avatars/random`**（复用当前值）
- 用户可点击头像区打开选择面板换头像
- PUT `/api/role-templates/:name`，返回 200 + RoleTemplate
- 列表对应卡片自动更新（或接收 WS `template.updated` 事件）
- toast 提示"模板已更新"

---

### 故事 5：删除模板

**场景**：删除过时模板

**步骤**：
1. 在卡片右侧点"删除"按钮
2. 弹出确认对话框："确定删除模板 {name} 吗？此操作不可撤销。"
3. 确认后发送 DELETE，模板被删除

**验收标准**：
- 删除前显示确认对话框，含模板名
- 若有活跃实例引用，返回 409，前端显示"无法删除：有 N 个实例正在使用此模板"，不删除
- 删除成功返回 204
- 列表对应卡片自动移除（或接收 WS `template.deleted` 事件）
- toast 提示"模板已删除"

---

### 故事 6：从模板快速创建实例

**场景**：选择某个模板，快速创建一个成员实例

**步骤**：
1. 在卡片右侧点"创建实例"按钮
2. 弹出对话框，要求输入实例名（memberName）
3. 填入实例名（如 "alice-frontend"），点确认
4. 调用 POST `/api/role-instances`，使用 templateName + memberName + isLeader（默认 false）
5. 实例创建成功，对话框关闭，toast 提示"实例创建成功"

**验收标准**：
- 对话框简洁：仅包含"实例名"输入框 + [确认] [取消] 按钮
- 实例名验证：1-64 字符，非空
- POST body：`{ templateName, memberName, isLeader: false }`
- 返回 201 + RoleInstance（status = 'PENDING'）
- 实例创建后自动激活（或让后端自动处理）

---

### 故事 7：管理头像

**场景**：在创建/编辑模板时选择头像

**步骤**：
1. 打开创建/编辑表单，头像区显示当前/默认头像
2. 点击头像区，弹出"头像选择面板"
3. 面板顶部有 🎲 随机按钮，下方是头像网格（内置 + 自定义）
4. 选择一张头像，面板关闭，表单 `avatar` 字段更新
5. 或点 🎲，自动调 `GET /api/panel/avatars/random` 更新预览，面板保持打开
6. 点面板外/关闭按钮，保留之前选中

**验收标准**：
- 创建时头像默认随机（已在故事 3 里说明）
- 编辑时显示模板原有头像，不覆盖为随机
- 选择面板数据来自 `GET /api/panel/avatars`（所有可见头像）
- 内置头像映射：`avatar-NN` → `/packages/renderer/src/assets/avatars/avatar-NN.png`
- 自定义头像映射：`avatar.id` → 对应 URL（后端 AvatarRow.filename）
- 当前选中头像高亮（描边或背景色）
- 随机按钮每次点击调一次 `/avatars/random`，更新预览
- 库空时随机按钮返回 `{ avatar: null }`，显示 toast"无可用头像"，不改动表单
- 选中后表单 `avatar` 字段立即更新，保存时 POST/PUT body 带该 id

---

## 4 功能设计

### 4.1 窗口布局

```
┌───────────────────────────────────────────────┐
│ 角色列表                                    [×]│
├───────────────────────────────────────────────┤
│                                               │
│ [+ 新建模板]  [搜索框] [筛选]                  │
│                                               │
│ ┌─ 模板卡片 ──────┬─ 模板卡片 ──┬─ 卡片 ──┐   │
│ │ [头像]           │ [头像]      │ [头像] │   │
│ │ frontend-eng...  │ qa-engineer │ ...    │   │
│ │ Role: engineer   │ Role: qa    │        │   │
│ │ Frontend...      │ QA & test.. │        │   │
│ │ MCP: git,github  │ MCP: shell  │        │   │
│ │ [编辑][创建][删] │ [编辑][...] │ [...]  │   │
│ └──────────────────┴─────────────┴────────┘   │
│                                               │
│ ┌─ 卡片 ──┬─ 卡片 ──┬─ 卡片 ────┐             │
│ │ ...     │ ...     │ ...       │             │
│ └─────────┴─────────┴───────────┘             │
│                                               │
│ 暂无模板 [+ 新建模板]  （空态）              │
│                                               │
└───────────────────────────────────────────────┘
```

### 4.2 模板卡片设计

每张卡片包含（参考 TemplateList organism）：

```
┌─────────────────────────────────────┐
│ ┌─────┐  frontend-engineer          │
│ │ [头] │  Role: engineer             │
│ │ 像 │                               │
│ └─────┘  Frontend developer focused │
│         on React/TypeScript...      │
│                                     │
│ MCP: git, github, +1                │
│ Updated: 2026-04-27 10:30           │
│                                     │
│ [编辑] [创建实例] [删除]             │
└─────────────────────────────────────┘
```

**字段**：
- 头像：左上角小圆形，如果 `avatar` 非 null 则渲染对应图片，否则显示缺省图标
- 名称：粗体，1 行
- Role Tag：灰色标签，显示 `role` 值
- 描述：截断至 3 行，悬停显示完整（title 属性）
- MCP 标签：列出 availableMcps 里的 mcpServer 名，最多 3 个，超出显示 "+N"
- 最后更新时间：小灰字
- 操作按钮：三个按钮，均为 secondary style，鼠标悬停时浮出

### 4.3 创建/编辑表单

```
┌─────────────────────────────────────┐
│ 新建模板                             │
├─────────────────────────────────────┤
│                                     │
│ 模板名 *               [         ]   │
│ 1-64 字符                           │
│                                     │
│ 角色 *                 [         ]   │
│ 1-32 字符                           │
│                                     │
│ 描述                   [         ]   │
│ ≤1024 字符             [         ]   │
│                                     │
│ 系统提示词             [         ]   │
│ ≤8192 字符             [         ]   │
│                        [         ]   │
│                                     │
│ 头像 (可选)                         │
│ [ 🖼️ avatar-03 ] [选择头像]          │
│                                     │
│ 可用 MCP 工具                       │
│ ☐ mteam      ☐ filesystem          │
│ ☑ git        ☑ github              │
│ ...                                 │
│                                     │
│ [保存]  [取消]                       │
│                                     │
└─────────────────────────────────────┘
```

**说明**：
- 模板名：创建时可填，编辑时禁用
- 头像：显示当前/默认头像预览 + 点击打开选择面板的入口
- MCP 工具：列出 `GET /api/mcp-store` 返回的所有 MCP（含内置），用户勾选要暴露给此模板的 MCP

### 4.4 头像选择面板

```
┌──────────────────────── 选择头像 ────────┐
│                                         │
│  [ 🎲 随机 ]                             │
│                                         │
├─────────────────────────────────────────┤
│  ── 内置 ──                              │
│  [01] [02] [03] [04] [05]               │
│  [06] [07] [08] [09] [10]               │
│  [11] [12] [13] [14] [15]               │
│  [16] [17] [18] [19] [20]               │
│                                         │
│  ── 自定义 ──                            │
│  [custom-abc] [custom-def] ...          │
│                                         │
│  当前选中：avatar-03 ✓（高亮描边）     │
│                                         │
│  [关闭]                                  │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5 API 契约

### 5.1 端点映射

```
前端操作                              → 后端接口
─────────────────────────────────────────────────
GET 模板列表                          → GET /api/role-templates
POST 创建模板                         → POST /api/role-templates
PUT 编辑模板                          → PUT /api/role-templates/:name
DELETE 删除模板                       → DELETE /api/role-templates/:name
GET 头像列表                          → GET /api/panel/avatars
GET 随机头像                          → GET /api/panel/avatars/random
POST 创建实例                         → POST /api/role-instances
GET MCP 列表                          → GET /api/mcp-store
```

### 5.2 关键 API 行为

详见 [docs/frontend-api/templates-and-mcp.md](../../../docs/frontend-api/templates-and-mcp.md) 和 [docs/frontend-api/instances-api.md](../../../docs/frontend-api/instances-api.md)。

**核心要点**：
- `GET /api/role-templates` 返回按 createdAt 升序的数组
- `POST /api/role-templates` 名称重复返回 409
- `PUT /api/role-templates/:name` 增量更新，name 不可改
- `DELETE /api/role-templates/:name` 有活跃实例时返回 409
- 所有写操作 emit bus 事件：`template.created` / `template.updated` / `template.deleted`
- `GET /api/panel/avatars` 返回所有可见头像（内置 + 自定义）
- `GET /api/panel/avatars/random` 返回一个随机头像（库空返回 `{ avatar: null }`）
- `POST /api/role-instances` 创建实例（status = 'PENDING'）

### 5.3 错误处理

| 状态码 | 场景 | 前端处理 |
|--------|------|---------|
| 400 | 参数无效（超长、格式错误） | 显示表单验证错误提示 |
| 404 | 模板/实例/头像不存在 | 刷新列表，显示"数据已删除"toast |
| 409 | 名称重复 / 有活跃实例使用此模板 | 显示 modal 对话框，描述冲突原因 |
| 500 | 服务器错误 | 显示 toast 错误，建议重试 |

---

## 6 状态管理

### 6.1 前端 Store

使用 Zustand 或类似管理：

```typescript
interface RoleListStore {
  // 模板相关
  templates: RoleTemplate[];
  loadingTemplates: boolean;
  
  // 操作
  fetchTemplates: () => Promise<void>;
  createTemplate: (data: CreateTemplateDTO) => Promise<void>;
  updateTemplate: (name: string, data: UpdateTemplateDTO) => Promise<void>;
  deleteTemplate: (name: string) => Promise<void>;
  
  // 头像相关
  avatars: AvatarRow[];
  randomAvatar: AvatarRow | null;
  getRandomAvatar: () => Promise<void>;
  
  // 实例创建
  createInstance: (data: CreateInstanceDTO) => Promise<void>;
}
```

### 6.2 WS 事件订阅

订阅以下事件用于实时更新列表：

- `template.created` — 添加新卡片
- `template.updated` — 更新对应卡片
- `template.deleted` — 移除卡片

---

## 7 交付清单

### 前端

- [ ] **RoleListWindow 组件**
  - [ ] 窗口容器（BrowserWindow 配置）
  - [ ] 标题栏
  - [ ] 关闭按钮
  - [ ] 最小化按钮（可选）

- [ ] **TemplateList organism**
  - [ ] 卡片网格布局（3-4 卡/行，responsive）
  - [ ] 模板卡片渲染（avatar/name/role/description/mcp-tags/updatedAt/actions）
  - [ ] 空态提示
  - [ ] 加载骨架屏
  - [ ] [+ 新建模板] 按钮

- [ ] **TemplateEditor 组件**（创建/编辑表单）
  - [ ] 表单字段：name/role/description/persona/avatar/availableMcps
  - [ ] 字段验证（长度、必填、唯一性）
  - [ ] 创建时默认头像随机分配（调 `/api/panel/avatars/random`）
  - [ ] 编辑时复用已有头像
  - [ ] MCP 工具多选
  - [ ] 保存/取消按钮

- [ ] **AvatarPicker 组件**（头像选择面板）
  - [ ] 拉取头像列表 `GET /api/panel/avatars`
  - [ ] 顶部 🎲 随机按钮（调 `GET /api/panel/avatars/random`）
  - [ ] 头像网格（内置 + 自定义分组）
  - [ ] 当前选中高亮
  - [ ] 点选回填并关闭
  - [ ] 点外/关闭按钮不回填
  - [ ] 库空时随机按钮给 toast 提示

- [ ] **ToolBar 改造**
  - [ ] 展开态新增"👥 角色列表"按钮（或简化为直接的图标），位置在"⚙设置"左侧
  - [ ] 点击触发 `window.electronAPI.openRoleList()`
  - [ ] 按钮视觉态与窗口显隐同步

- [ ] **状态管理**
  - [ ] `useRoleListStore` 或 `useTemplateStore`（管理模板列表、头像、操作）
  - [ ] WS 事件订阅（template.created / updated / deleted）
  - [ ] 窗口显隐状态管理

- [ ] **路由/导航**
  - [ ] 独立 BrowserWindow 渲染入口（如 `role-list-window.html`）
  - [ ] React Router 配置（或直接渲染）
  - [ ] 导出入口组件

### 后端

- [ ] `/api/role-templates` CRUD 端点（前端门面已有）
- [ ] 模板验证与去重
- [ ] 实例活跃检查（删除时）
- [ ] Bus 事件发送（template.created / updated / deleted）

### Playground

- [ ] 注册 `TemplateList` 组件卡片
- [ ] 注册 `TemplateEditor` 组件卡片（mock 创建/编辑表单）
- [ ] 注册 `AvatarPicker` 组件卡片
- [ ] 升版号（新增多个组件 → minor 升）

### QA

- [ ] 功能测试：列表/创建/编辑/删除/实例创建
- [ ] 集成测试：end-to-end 从打开窗口到创建实例
- [ ] WS 实时性：多窗口创建/编辑/删除同步
- [ ] 边界条件：超长字符、特殊字符、并发操作、库空头像
- [ ] 视觉测试：卡片布局、响应式、头像渲染

### 文档

- [ ] 更新 `docs/frontend-api/INDEX.md` 新增 role-list 入口说明
- [ ] 更新 `packages/renderer/docs/COMPONENT-GAP.md`（补充 TemplateList / AvatarPicker / TemplateEditor）

---

## 8 关键设计决策

### 8.1 角色列表 ≠ TeamCanvas

- **角色列表**（本 PRD）：模板管理，静态配置，支持 CRUD
- **TeamCanvas**：运行时团队，实例管理，展示活跃成员

两个独立窗口，入口不同，功能正交。

### 8.2 头像管理

- 创建时自动随机分配（改善 UX，用户无需感知"无头像"情况）
- 编辑时保留原有头像（避免无意覆盖）
- 用户可随时打开选择面板换头像

### 8.3 MCP 工具可见性

- 支持 surface（首屏展示）+ search（搜索可见）两种白名单
- 模板编辑时可调整哪些 MCP 可见
- 实例继承模板的 availableMcps 配置

### 8.4 WS 推送

- 所有模板写操作都通过 bus event 推送
- 多窗口场景下自动同步（不需要轮询）

---

## 9 验收测试清单

### T1. 窗口管理

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 1.1 | 打开角色列表 | 点击 ToolBar 👥 按钮 | 打开独立 BrowserWindow（1200×800），标题"角色列表" |
| 1.2 | 重复点击 | 窗口已开，再点 👥 | 不打开第二个，focus 存在的窗口 |
| 1.3 | 关闭窗口 | 点关闭按钮 | 窗口关闭，ToolBar 按钮回到默认态 |

### T2. 模板列表

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 2.1 | 列表加载 | 打开角色列表窗口 | GET `/api/role-templates` 发出，列表渲染 RoleTemplate[] |
| 2.2 | 卡片显示 | 列表有模板 | 每卡显示 avatar/name/role Tag/description/mcp-tags/updatedAt/操作按钮 |
| 2.3 | 空状态 | 无任何模板 | 显示"暂无模板"提示 + [新建模板] 按钮 |
| 2.4 | 加载态 | 网络延迟 | 显示骨架屏或 loading 旋转 |
| 2.5 | MCP 标签截断 | 模板有 5 个 MCP | 显示前 3 个，后面显示 "+2" |

### T3. 创建模板

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 3.1 | 打开创建表单 | 点 [+ 新建模板] | 弹出对话框，表单为空（除头像） |
| 3.2 | 头像默认随机 | 打开创建表单 | 前端调 `GET /api/panel/avatars/random`，头像区显示随机头像 |
| 3.3 | 验证模板名 | 提交空表单 | 提示"模板名为必填" |
| 3.4 | 验证角色 | 角色字段空 | 提示"角色为必填" |
| 3.5 | 名称长度 | 输入 65 字符 | 提示"模板名不超过 64 字符" |
| 3.6 | 名称唯一性 | 重复现有模板名 | 提示"模板已存在" |
| 3.7 | 成功创建 | 填完表单，点保存 | POST `/api/role-templates` 发出，201 返回，列表新增卡片，toast 成功 |
| 3.8 | MCP 多选 | 勾选多个 MCP | availableMcps 数组包含全部选中项 |
| 3.9 | 用户不改头像 | 用默认随机头像直接保存 | 成功，POST body 含有 avatar（非 null） |

### T4. 编辑模板

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 4.1 | 打开编辑表单 | 点卡片 [编辑] | 表单预填所有字段 |
| 4.2 | 模板名禁改 | 点模板名输入框 | 输入框禁用或隐藏 |
| 4.3 | 头像不覆盖 | 打开编辑表单 | 头像区显示模板原有 avatar，不调 `/avatars/random` |
| 4.4 | 修改成功 | 改 description，点保存 | PUT `/api/role-templates/:name` 发出，200 返回，卡片更新 |
| 4.5 | 修改 MCP | 改 availableMcps | PUT body 包含新的工具配置 |

### T5. 删除模板

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 5.1 | 删除确认 | 点卡片 [删除] | 弹出确认对话框，含模板名 |
| 5.2 | 取消删除 | 点对话框 [取消] | 对话框关闭，模板保留 |
| 5.3 | 成功删除 | 确认删除 | DELETE `/api/role-templates/:name` 发出，204 返回，卡片移除 |
| 5.4 | 有活跃实例 | 模板被活跃实例使用 | 返回 409，显示"有 N 个实例使用此模板，无法删除" |

### T6. 创建实例

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 6.1 | 打开实例创建 | 点卡片 [创建实例] | 弹出对话框，要求输入实例名 |
| 6.2 | 实例名验证 | 提交空名字 | 提示"实例名为必填" |
| 6.3 | 创建成功 | 输入实例名，确认 | POST `/api/role-instances` 发出，201 返回，toast 成功 |

### T7. 头像选择

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 7.1 | 打开选择面板 | 点表单头像区 | 弹出面板，顶部有 🎲 随机，下方是网格 |
| 7.2 | 网格来源 | 打开面板 | 前端调 `GET /api/panel/avatars`，渲染返回的头像 |
| 7.3 | 当前高亮 | 表单已有 avatar-03，打开面板 | 网格中 avatar-03 有选中样式（描边/背景） |
| 7.4 | 点选回填 | 点网格中某头像 | 面板关闭，表单 avatar 字段 = 该 id，预览更新 |
| 7.5 | 随机按钮 | 点 🎲 | 调 `GET /api/panel/avatars/random`，预览更新，面板保持打开 |
| 7.6 | 库空提示 | 所有头像被隐藏时点 🎲 | API 返回 `{ avatar: null }`，显示 toast"无可用头像" |
| 7.7 | 关闭不保存 | 点面板外或 [关闭] | 面板关闭，表单 avatar 保留之前值 |
| 7.8 | 自定义头像 | 库里有 custom-xxx | 网格显示，可选中 |

### T8. 实时事件

| # | 用例 | 步骤 | 期望结果 |
|----|------|------|--------|
| 8.1 | 其他客户端创建 | 另一窗口创建模板 | 当前窗口收到 WS `template.created`，列表新增卡片 |
| 8.2 | 其他客户端编辑 | 另一窗口编辑模板 | 当前窗口收到 WS `template.updated`，卡片内容更新 |
| 8.3 | 其他客户端删除 | 另一窗口删除模板 | 当前窗口收到 WS `template.deleted`，卡片移除 |

---

## 10 与其他模块的关系

```
主窗口 ToolBar
    ↓
👥 按钮 ← 触发打开角色列表窗口
    ↓
角色列表窗口（本 PRD）
    ├─ 模板管理（创建/编辑/删除）
    ├─ 快速创建实例
    └─ 头像管理
         ↓
    RoleInstance 创建（status = PENDING）
         ↓
    TeamCanvas（单独的窗口，实例运行时管理）
```

---

## 11 后期演进

- **搜索/筛选**（Phase 4）：按模板名/角色/MCP 搜索
- **模板导入导出**（Phase 4）：支持模板打包分享
- **模板分类**（Phase 5）：为模板添加分类标签，支持按类别组织
- **模板版本管理**（Phase 5）：跟踪模板演变历史

---

**签署**：

- **产品**：_____________________ 日期：_____
- **前端 Lead**：_____________________ 日期：_____
- **后端 Lead**：_____________________ 日期：_____
