# 模板功能组件库缺口评估

**日期**：2026-04-26  
**范围**：前端组件库对"员工模板"（角色模板 CRUD）功能的支持度评估  
**数据源**：API 文档（`docs/frontend-api/templates-and-mcp.md`）+ 现有组件库（`src/atoms/` / `molecules/` / `organisms/`）

---

## 一、功能需求清单

基于 `/api/role-templates` 接口，模板功能需要展示和编辑以下字段：

| 字段 | 类型 | 备注 |
|------|------|------|
| `name` | string (1-64) | 主键，模板标识符，不可编辑后 |
| `role` | string (1-32) | 角色分类 |
| `description` | string \| null (≤1024) | 模板描述 |
| `persona` | string \| null (≤8192) | 系统提示词，可多行 |
| `avatar` | string \| null | 头像 id 引用 |
| `availableMcps` | McpToolVisibility[] | MCP 可见性配置（name, surface[], search[]) |
| `createdAt` / `updatedAt` | ISO string | 时间戳，只读 |

---

## 二、现有组件清单

### 原子层（atoms/）

| 组件 | 用途 | 可复用度 |
|------|------|--------|
| **Button** | 基础按钮（primary/ghost/icon/dots） | ✅ 可复用（Save/Cancel/Delete/Edit） |
| **Icon** | 图标集合 | ✅ 可复用（action icons） |
| **Text** | 文本样式（title/subtitle/caption/badge） | ✅ 可复用（标签、状态文本） |
| **Surface** | 容器（capsule/panel） | ✅ 可复用（表单容器） |
| **StatusDot** | 状态指示点 | ✅ 可复用（模板状态指示） |
| **Dropdown** | 下拉选择器 | ✅ 可复用（role 选择、filter） |
| **VirtualList** | 虚拟滚动列表 | ⚠️ 可用于大列表（模板列表 100+ 时） |
| **Logo** | 头像 Logo | ⚠️ 需定制 avatar 类型支持 |
| **NotificationCard** | 通知卡片 | ✅ 可复用（删除成功/失败提示） |
| **TypingDots** | 加载动画 | ✅ 可复用（数据加载中） |
| **TextBlock** | 流式文本 | ❌ 不适用 |
| **ToolCallItem** | 工具调用项 | ❌ 不适用 |
| **MessageMeta** | 消息元数据 | ❌ 不适用 |
| **TeamSidebarItem** | 团队列表项 | ❌ 不适用 |

### 分子层（molecules/）

| 组件 | 用途 | 可复用度 |
|------|------|--------|
| **Avatar** | 头像组件 | ✅ 可复用（模板头像显示） |
| **ChatInput** | 聊天输入框 | ❌ 不适用 |
| **AgentSwitcher** | Agent 切换器 | ❌ 不适用 |
| **ToolBar** | 工具条 | ❌ 不适用 |
| **MenuDots** | 三点菜单 | ✅ 可复用（模板行操作菜单） |
| **NotificationStack** | 通知栈 | ⚠️ 可复用（但需自定义样式） |
| **MessageBubble** / **MessageRow** | 消息相关 | ❌ 不适用 |
| **ToolCallList** | 工具调用列表 | ❌ 不适用 |
| **TeamSidebar** / **RosterList** | 团队/成员列表 | ⚠️ 结构参考 |
| **TitleBlock** | 标题块 | ✅ 可复用（页面标题） |
| **DragHandle** | 拖拽句柄 | ❌ 不适用 |
| **MessageBadge** | 消息徽章 | ✅ 可复用（模板计数） |
| **ChatHeader** | 聊天头 | ❌ 不适用 |

### 有机体层（organisms/）

| 组件 | 用途 | 可复用度 |
|------|------|--------|
| **TemplateEditor** | **✅ 已存在** | 模板编辑表单（Create/Edit 共用） |
| **AgentList** | 列表参考 | ⚠️ 代码结构参考 |
| **NotificationCenter** | 通知面板 | ❌ 不适用 |
| **PrimaryAgentSettings** | 设置面板 | ⚠️ 布局参考 |
| **ChatPanel** | 聊天面板 | ❌ 不适用 |
| **TeamCanvas** / **TeamMonitorPanel** | 画布相关 | ❌ 不适用 |
| **CapsuleCard** | 胶囊卡片 | ❌ 不适用（但可参考样式） |
| **ExpandedView** | 展开视图 | ❌ 不适用 |

---

## 三、缺失组件清单

### A. 原子层缺失

#### 1️⃣ **Input** (必需)
```typescript
interface InputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'code';  // code 用于 prompt 输入
}
```
**用途**：模板名称、角色字段输入  
**工作量**：1-2h（含样式、focus state、error state）

#### 2️⃣ **Textarea** (必需)
```typescript
interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
  error?: string;
  monospace?: boolean;  // 用于 persona/prompt
}
```
**用途**：描述、系统提示词（persona）编辑  
**工作量**：1-2h（含自适应高度、行数提示）

#### 3️⃣ **Toggle/Switch** (可选)
```typescript
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md';
}
```
**用途**：MCP 可见性配置（surface/search 开关）  
**工作量**：1h（含动画）  
**替代方案**：用 Checkbox（HTML native）+ 样式

#### 4️⃣ **Tag/Badge** (必需)
```typescript
interface TagProps {
  text: string;
  onRemove?: () => void;
  variant?: 'default' | 'primary' | 'error';
  size?: 'sm' | 'md';
  closable?: boolean;
}
```
**用途**：MCP 列表、模板标签展示  
**工作量**：1h

#### 5️⃣ **Modal/Dialog** (必需)
```typescript
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}
```
**用途**：删除确认、MCP 配置详情弹窗  
**工作量**：2-3h（含遮罩、动画、焦点陷阱）

#### 6️⃣ **Toast/Alert** (可选)
```typescript
interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  action?: { label: string; onClick: () => void };
}
```
**用途**：保存/删除成功/失败提示  
**工作量**：1-2h  
**替代方案**：复用 NotificationStack（已有）

### B. 分子层缺失

#### 1️⃣ **FormField** (推荐)
```typescript
interface FormFieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;  // 包裹 Input / Textarea
}
```
**用途**：label + input 的组合组件，统一标记和验证提示  
**工作量**：1h  
**复用率**：表单的每个字段都用

#### 2️⃣ **ConfirmDialog** (必需)
```typescript
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}
```
**用途**：删除模板确认  
**工作量**：1h（复用 Modal）

#### 3️⃣ **CardList** (可选)
```typescript
interface CardListProps {
  items: Array<{ id: string; title: string; subtitle?: string }>;
  renderCard?: (item) => ReactNode;
  onSelect?: (id: string) => void;
  empty?: ReactNode;
}
```
**用途**：模板列表卡片布局  
**工作量**：1-2h  
**替代方案**：在 TemplateList 里直接用 map（代码长度可接受）

### C. 有机体层缺失

#### 1️⃣ **TemplateList** (必需)
```typescript
interface TemplateListProps {
  templates: RoleTemplate[];
  loading?: boolean;
  onEdit: (name: string) => void;
  onCreate: () => void;
  onDelete: (name: string) => void;
}
```
**结构**：
- 顶部：标题 + "Create" 按钮
- 中间：列表（卡片或行）
  - 每卡/行：模板名 + role + 描述摘要 + 头像
  - 操作：编辑、删除、菜单
- 空态：提示
- 删除确认弹窗

**工作量**：3-4h（含 API 集成、实时事件订阅、加载/错误态）

#### 2️⃣ **TemplateForm** (已有 + 需增强)
现有 `TemplateEditor` 需增强：
- 支持 `description` 字段
- 支持 `avatar` 字段（头像选择器）
- 支持嵌套 MCP 配置编辑（`McpToolVisibility[]`）
- 表单验证提示（目前无）
- 字数限制显示

**工作量**：2-3h 增强

#### 3️⃣ **TemplateDetailPanel** (可选)
用于展开单个模板的详情页（非必需，现有 TemplateEditor 可以 Edit in place）。

---

## 四、技术决策

### 关键选项

#### 表单输入方案
- **选项 A**：创建 Input/Textarea 原子组件，复用标准 HTML + styled-components
- **选项 B**：暂不创建，直接在 TemplateEditor 中用原生 `<input>` / `<textarea>` + CSS Module
- **推荐**：**选项 A** — 便于后续复用（MCP 配置、其他表单都需要）；投入只多 2-3h

#### MCP 配置编辑
MCP 结构复杂（`McpToolVisibility { name, surface[], search[] }`）：
- **选项 A**：创建专用 MCP 配置编辑面板
- **选项 B**：简化为"多选列表"（假设 surface/search 都填一样的），像现有 Checkbox chips
- **推荐**：**选项 B** — MVP 可接受；若需复杂配置，后期单开组件

#### 删除确认
- **选项 A**：创建 ConfirmDialog 通用组件
- **选项 B**：硬编码在 TemplateList 里，用 Modal
- **推荐**：**选项 A** — 同样投入小，可复用

---

## 五、开发工作量估算

### 新建组件

| 层级 | 组件 | 优先级 | 工作量 | 备注 |
|-----|------|--------|--------|------|
| atom | Input | 必需 | 2h | 含 focus/error/maxLen |
| atom | Textarea | 必需 | 2h | 含自适应高度 |
| atom | Tag | 必需 | 1h | 含关闭按钮 |
| atom | Modal | 必需 | 3h | 含遮罩、焦点管理 |
| atom | Toggle | 可选 | 1h | 可用 native checkbox 替代 |
| molecule | FormField | 推荐 | 1h | label + input 容器 |
| molecule | ConfirmDialog | 必需 | 1h | 复用 Modal |
| organism | TemplateList | 必需 | 4h | 含列表、API 集成、实时更新 |
| organism | TemplateEditor 增强 | 必需 | 2h | 加 description/avatar/验证 |

**必需小计**：15h  
**推荐小计**：16h  
**完整小计**：17h

### 新增测试
- 单测：每组件 +0.5h
- 集成测试（模板 CRUD 流程）：+2h
- **测试合计**：+6h

### 集成任务（不含组件编码）
- API 封装（HTTP CRUD + WS 订阅）：+2h
- Playground 注册（演示）：+0.5h
- 文档更新：+0.5h

---

## 六、优先级建议

### Wave 1（必需，第一周）
1. Input + Textarea + Tag（原子基础）
2. Modal（交互核心）
3. TemplateEditor 增强（含 description/avatar）
4. TemplateList（主界面）

**累计**：~12h 代码 + 3h 测试 = 15h

### Wave 2（推荐，第二周）
1. FormField（代码复用）
2. ConfirmDialog（交互完善）
3. API 集成 + 实时推送

**累计**：~4h 代码 + 2h 测试 = 6h

### Wave 3（可选，后续）
1. Toggle / CardList（UI 多样性）
2. TemplateDetailPanel（展开阅读）

---

## 七、验收标准

**模板列表页面**
- [ ] 加载显示骨架屏或 Loading 状态
- [ ] 列表展示所有模板（卡片/行）
- [ ] 支持创建新模板（Create 按钮 → TemplateEditor 模态）
- [ ] 支持编辑模板（Edit 按钮 → TemplateEditor 模态）
- [ ] 支持删除模板（Delete → 确认弹窗 → 成功 Toast）
- [ ] 实时更新（后端事件 → 列表自动刷新）

**表单编辑**
- [ ] name、role、description、persona 字段均可编辑
- [ ] avatar 可选择（从头像库）
- [ ] MCP 可见性配置可编辑（多选）
- [ ] 字数限制显示（persona ≤8192）
- [ ] 表单验证反馈（name/role 必填）
- [ ] Save/Cancel 按钮可用

**网络交互**
- [ ] POST `/api/role-templates` 创建成功 → 201
- [ ] PUT `/api/role-templates/:name` 更新成功 → 200
- [ ] DELETE `/api/role-templates/:name` 删除成功 → 204
- [ ] 处理错误响应（409 name 重复、404 不存在等）

---

## 附录：API 最小化示例

### 创建模板
```bash
POST /api/role-templates
Content-Type: application/json

{
  "name": "frontend-lead",
  "role": "engineer",
  "description": "主导前端架构和 UI 组件设计",
  "persona": "你是前端技术负责人...",
  "avatar": "avatar-02",
  "availableMcps": [
    { "name": "mteam", "surface": ["*"], "search": "*" }
  ]
}

Response: 201
{
  "name": "frontend-lead",
  "role": "engineer",
  "description": "...",
  "persona": "...",
  "avatar": "avatar-02",
  "availableMcps": [...],
  "createdAt": "2026-04-26T...",
  "updatedAt": "2026-04-26T..."
}
```

### 实时更新事件
```json
{
  "type": "template.created",
  "payload": { "templateName": "frontend-lead" }
}
```

---

## 结论

**核心结论**：
1. 现有组件库**基础完备**（Button、Dropdown、Surface 等），但**缺少表单控件**（Input、Textarea、Modal）
2. **TemplateEditor** 已存在但需功能扩展，**TemplateList** 需新建
3. **建议分阶段**：Wave 1 补齐基础原子 → Wave 2 组装页面 → Wave 3 可选增强
4. **总投入** ~15h 代码 + 6h 测试，合理范围内

**关键风险**：
- Modal 焦点管理（需测试键盘导航）
- 实时推送订阅生命周期（防内存泄漏）
- 表单验证提示 UX（避免误导用户）

---

## 八、补充缺口（2026-04-26 追加）

> 以下为组件缺口补评估。原始评估已覆盖表单基础组件，本节补充头像选择和 ToolBar 扩展两项。

### A. 新增 molecule：AvatarPicker

**定位**：molecule 层级。内部使用 atoms/Avatar（molecules/Avatar 实为头像原子显示组件）+ atoms/Button。

**Props**：
```typescript
interface AvatarPickerProps {
  avatars: AvatarRow[];        // 从 GET /api/panel/avatars 获取
  value: string | null;        // 当前选中的 avatar id（null = 未指定）
  onChange: (id: string) => void;
  onRandom?: () => void;       // 触发 GET /api/panel/avatars/random
  size?: 'sm' | 'md';          // 缩略图尺寸，默认 md（48×48）
  columns?: number;            // 网格列数，默认 6
  disabled?: boolean;
}

interface AvatarRow {
  id: string;         // 如 "avatar-01" / "avatar-custom-abc"
  filename: string;   // 如 "avatar-01.png"
  builtin: boolean;
  createdAt: string;
}
```

**内部结构**：
- 顶部工具行：标题「选择头像」+ 右侧「随机」Button（variant=ghost，icon=shuffle/dice）
- 主体：网格布局（CSS Grid）展示头像缩略图
  - 每项：`<button>` 包裹 `<img src={resolveAvatarUrl(avatar)} />`
  - 选中态：边框高亮 + check 角标（复用 Icon atom 的 `check`）
  - 悬停态：轻微缩放 + 发光（与 Dropdown/ToolBar 一致的玻璃胶囊风）
- 空态：`avatars=[]` 时显示「暂无头像，点击随机加载」
- 禁用态：整体降透明度 + pointer-events:none

**数据来源**（确认自 `docs/frontend-api/avatars-api.md`）：
- 列表接口：`GET /api/panel/avatars` → `{ avatars: AvatarRow[] }`（仅返回 `hidden=0` 的）
- 随机接口：`GET /api/panel/avatars/random` → `{ avatar: AvatarRow | null }`
- URL 解析规则：
  - 内置（`builtin=true`）：映射到 `packages/renderer/src/assets/avatars/<id>.png`
  - 自定义（`builtin=false`）：用户上传文件路径（文件上传不在本接口范围，另行处理）
  - 建议封装 `resolveAvatarUrl(row: AvatarRow): string` util

**使用场景**：
- 角色模板创建/编辑（TemplateEditor 内嵌）
- 角色实例头像修改（未来 InstanceSettings）

**工作量**：2-3h（含网格样式、选中动画、随机交互、单测）

**放置位置建议**：
- `packages/renderer/src/molecules/AvatarPicker/`
  - `AvatarPicker.tsx`
  - `AvatarPicker.module.css`
  - `index.ts`
  - `__tests__/AvatarPicker.test.tsx`
- Playground 注册：`playground/registry/molecules.ts` 新增一项

**依赖关系**：
- 依赖 atoms/Icon（新增 `shuffle` 或 `dice` 图标，用于随机按钮）
- 依赖 atoms/Button（variant=ghost）
- 复用 molecules/Avatar（作为单项展示原子）

---

### B. ToolBar 扩展：新增成员面板按钮

**当前状态**（mnemo id=531）：  
molecules/ToolBar 现有结构 = atoms/Dropdown（模型切换，左）+ 原生 button（设置齿轮，右），`space-between` 横排。齿轮按钮复刻 `.dropdown__trigger` 胶囊发光玻璃样式（`border-radius:999px` + 多层 `box-shadow` + `backdrop-filter blur/saturate`），28×28 圆形，悬停 `translateY(-1px)`。

**扩展目标**：右侧从「单齿轮」变为「成员面板 + 齿轮」双按钮胶囊组。

**Props 增量**：
```typescript
interface ToolBarProps {
  // 现有：
  // model, onModelChange, modelOptions, onSettings, ...
  
  // 新增：
  onTeamPanel?: () => void;    // 点击成员面板按钮回调
  teamPanelActive?: boolean;   // 面板是否打开中（按钮高亮态）
  teamBadge?: number;          // 可选：成员数量/未读数徽章
}
```

**右侧布局变化**：
```
旧：[Dropdown ............................. [⚙]]
新：[Dropdown .......................... [👥] [⚙]]
```
- 两个按钮间距 `gap: 4px`（共享胶囊容器，不各自独立发光，避免视觉割裂）
- 「成员面板」按钮使用新增 Icon（`team` 或 `people`）
- 按钮尺寸沿用 28×28，样式复刻齿轮按钮
- `teamPanelActive=true` 时按钮呈激活态（边框/背景加强）
- `teamBadge > 0` 时右上角显示 MessageBadge 数字角标（复用现有 molecule）

**Icon atom 扩展**：  
新增图标名 `team` 或 `people`（在 IconName 联合类型 + PATHS map + README + Playground registry 中登记）。命名参考 mnemo id=603：`team` 更贴合语义（成员面板≈团队）。

**工作量**：1-1.5h（ToolBar 扩展 0.5h + Icon 新增 0.5h + Playground 注册 + 单测）

**放置位置**：
- 修改 `packages/renderer/src/molecules/ToolBar/ToolBar.tsx`
- 修改 `packages/renderer/src/atoms/Icon/`（新增 team 图标 path）
- Playground 更新 ToolBar 示例，展示带 onTeamPanel 的形态

**使用场景**：
- ExpandedView 里打开团队监控面板（mnemo id=533 提到的 team-panel 自动唤起流程）

---

### C. 工作量小结

| 层级 | 组件/改动 | 工作量 | 新建/扩展 |
|-----|----------|--------|----------|
| atom | Icon 新增 `team` 图标 | 0.5h | 扩展 |
| molecule | AvatarPicker 新建 | 2.5h | 新建 |
| molecule | ToolBar 增 onTeamPanel | 1h | 扩展 |
| test | 上述单测 | 1h | 新增 |

**合计**：~5h

### D. 与原有计划的关系

- AvatarPicker 属于 **Wave 1 子项**（TemplateEditor 增强里提到的 avatar 字段，其实现载体就是本组件）
- ToolBar 扩展属于 **独立增量**，不在原 Wave 计划内，优先级取决于团队面板何时落地
- Icon atom 扩展为上述两项共同依赖，排在最前

### E. 验收补充

**AvatarPicker**
- [ ] 加载 `GET /api/panel/avatars` 列表并渲染网格
- [ ] 点击缩略图触发 `onChange(id)`，高亮切换
- [ ] 点击「随机」触发 `onRandom`，调用 `GET /api/panel/avatars/random`
- [ ] 内置/自定义头像都能正确解析 URL 渲染
- [ ] 空态、禁用态、选中态样式正确
- [ ] 键盘可访问（Tab 遍历、Enter/Space 选中）

**ToolBar 成员按钮**
- [ ] `onTeamPanel` 存在时渲染按钮，不存在时保持旧布局
- [ ] 点击触发回调
- [ ] `teamPanelActive=true` 呈激活态
- [ ] `teamBadge` 角标正确显示
- [ ] 按钮样式与齿轮一致（胶囊玻璃发光）
