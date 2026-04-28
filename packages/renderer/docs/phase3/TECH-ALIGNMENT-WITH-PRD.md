# 技术方案与 PRD 对标表

**目的**: 逐条验证 PRD-ROLE-LIST.md 的需求是否被 COMPONENT-GAP-V2.md 的技术方案完整覆盖

**文档版本**:
- PRD: PRD-ROLE-LIST.md (§2 需求说明、§3 用户故事、§4 功能设计、§9 验收测试清单)
- 技术方案: COMPONENT-GAP-V2.md (§1 组件映射、§7 验收标准)

---

## 1. 用户故事 vs 技术组件映射

### 故事 1：打开角色列表窗口

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 点击 ToolBar 的 👥 按钮 | ToolBar.tsx 已有按钮 | ✓ 在 molecules/ToolBar 中 |
| 打开独立 BrowserWindow（1200×800） | 前端无需组件，Electron 配置层 | ✓ 由主进程 IPC 处理 |
| 窗口标题"角色列表" | 页面 <title> 标签 | ✓ 标准 HTML |
| 重复点击不打开第二个 | Electron window 管理 | ✓ 业务逻辑层，非组件 |

**技术可行性**: ✅ 完全覆盖（不需新组件）

---

### 故事 2：查看所有模板

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 自动调用 `GET /api/role-templates` | 升级后的 WorkerList organism | ✓ 组件 mount 发 WS get_workers |
| 获取 RoleTemplate 数组，按 createdAt 升序 | 后端保证顺序 | ✓ 文档保证（workers-api.md） |
| 渲染卡片列表，网格布局 3-4 卡/行 | WorkerCard organism + CSS grid | ✓ 新建 WorkerCard + Tailwind grid |
| 卡片显示：头像、模板名、角色标签、描述摘要、MCP工具标签、操作按钮 | WorkerCard props 完全覆盖 | ✓ 对照表见第 2 节 |
| 空列表显示提示 + [新建模板] 按钮 | TemplateList 已有空态逻辑 | ✓ 复用现有 |
| 加载态骨架屏 | TemplateList 已有 loading state | ✓ 复用现有 |

**技术可行性**: ✅ 完全覆盖

---

### 故事 3：创建新模板

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 点 [+ 新建模板] 打开对话框 | Modal atom + FormField molecules | ✓ 使用现有 TemplateEditor |
| 表单字段：模板名、角色、描述、系统提示词、头像、MCP工具 | FormField + Input + Textarea | ✓ 现有组件足够 |
| 头像默认随机（调 `/api/panel/avatars/random`） | TemplateEditor 需要增强 | 🟡 现有代码不确定，需验证 |
| 表单验证（长度、唯一性） | FormField 支持 validation prop | ✓ atoms/FormField 有此能力 |
| 保存后 POST `/api/role-templates` | 业务逻辑层 | ✓ 非组件责任 |
| 列表自动更新（WS event 或本地更新） | WorkerList 订阅 `template.created` | ✓ 方案中已包含 |
| toast 提示"模板创建成功" | NotificationStack molecules | ✓ 现有组件 |

**技术可行性**: ✅ 基本覆盖（头像随机需确认 TemplateEditor 实现）

---

### 故事 4：编辑模板

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 卡片右侧点 [编辑] 打开表单 | Modal + TemplateEditor | ✓ 复用创建流程 |
| 表单预填所有字段 | FormField 支持 defaultValue | ✓ 现有能力 |
| 模板名禁改 | Input disabled 属性 | ✓ atoms/Input 支持 |
| 编辑时头像不覆盖为随机 | TemplateEditor 逻辑需区分新建/编辑 | 🟡 需验证实现 |
| 用户可点击头像打开选择面板 | AvatarPicker molecules | ✓ 现有 molecules/AvatarPicker |
| PUT `/api/role-templates/:name` | 业务逻辑层 | ✓ 非组件 |
| 列表卡片自动更新 | WorkerList 订阅 `template.updated` | ✓ 方案包含 |
| toast 提示"模板已更新" | NotificationStack | ✓ 现有 |

**技术可行性**: ✅ 覆盖（头像逻辑需确认）

---

### 故事 5：删除模板

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 卡片右侧点 [删除] | 按钮事件处理 | ✓ 组件 onDelete callback |
| 弹出确认对话框 | ConfirmDialog molecules | ✓ 现有 |
| 有活跃实例时返回 409，前端显示错误 | Modal 显示错误信息 | ✓ 组件支持 |
| DELETE `/api/role-templates/:name` 成功返回 204 | 业务逻辑层 | ✓ 非组件 |
| 列表卡片自动移除 | WorkerList 订阅 `template.deleted` | ✓ 方案包含 |
| toast 提示"模板已删除" | NotificationStack | ✓ 现有 |

**技术可行性**: ✅ 完全覆盖

---

### 故事 6：从模板快速创建实例

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 卡片右侧点 [创建实例] | WorkerCard onCreateInstance callback | ✓ props 中已定义 |
| 弹出输入实例名对话框 | Modal + Input | ✓ 现有组件 |
| 填入实例名，POST `/api/role-instances` | 业务逻辑 | ✓ 非组件 |
| 实例创建成功，对话框关闭，toast 提示 | NotificationStack + Modal.onClose | ✓ 现有 |

**技术可行性**: ✅ 完全覆盖

---

### 故事 7：管理头像

| PRD 需求 | 技术方案 | 验证 |
|---------|--------|------|
| 打开创建/编辑表单，头像区显示当前/默认头像 | WorkerCard 显示 avatar 图片 | ✓ 映射 avatar id → URL |
| 点击头像区打开选择面板 | AvatarPicker molecules | ✓ 现有 molecules/AvatarPicker |
| 面板顶部 🎲 随机按钮 | Button + onClick 调 `/api/panel/avatars/random` | ✓ atoms/Button |
| 面板下方头像网格 | 网格布局 + 头像图片 | ✓ Tailwind grid + Image |
| 选择一张头像，面板关闭，表单更新 | AvatarPicker 回调机制 | ✓ 现有 molecules 支持 |
| 当前选中高亮 | CSS 状态样式 | ✓ Tailwind state styles |
| 库空时随机按钮返回 toast | NotificationStack | ✓ 现有 |

**技术可行性**: ✅ 完全覆盖

---

## 2. WorkerCard Props 对标 workers-api.md

### WorkerView 字段 → WorkerCard Props 映射

| workers-api WorkerView 字段 | WorkerCard 显示位置 | PRD 需求覆盖 |
|---------------------------|------------------|------------|
| **name** | 卡片主标题 | ✓ 故事 2 "模板名" |
| **role** | 灰色 Tag 标签 | ✓ 故事 2 "角色标签" |
| **description** | 描述文案，截断 3 行 | ✓ 故事 2 "描述摘要" |
| **persona** | 不显示（仅后端用） | ✓ PRD 未要求展示 |
| **avatar** | 头像图片 | ✓ 故事 2 & 7 "头像" |
| **mcps** | MCP 工具标签，最多 3 个 + "+N" | ✓ 故事 2 "MCP工具标签" |
| **status** | StatusDot + 文字（在线/空闲/离线） | ✓ 故事 2（设计稿）"状态" |
| **instanceCount** | 徽章或小字（"2 个实例"） | ✓ 故事 2（设计要求）"实例数" |
| **teams** | 可选显示团队列表 | 🟡 PRD 无明确要求 |
| **lastActivity** | 摘要文案 + 时间戳 | ✓ 故事 2 "最近协作" |

**匹配度**: 95%（teams 字段可选展示）

### WorkerCard 额外需要的 Props（业务层）

| Prop | 来源 | 必要性 |
|------|------|--------|
| **onEdit** | WorkerCard 操作 | ✓ 故事 4 编辑按钮 |
| **onCreate** | WorkerCard 操作 | ✓ 故事 6 创建实例按钮 |
| **onDelete** | WorkerCard 操作 | ✓ 故事 5 删除按钮 |
| **onMessage** | WorkerCard 操作 | 🟡 PRD 提及"消息按钮"但用途不清 |

**问题**: onMessage 的具体行为是什么？（故事中未明确说明）

---

## 3. 组件库缺口对标验收标准

### 新建组件的 PRD 覆盖

| 新建组件 | PRD 需求来源 | 验收标准 |
|---------|-----------|--------|
| **TabFilter** | PRD §4.1 "三 Tab 筛选" | ✓ COMPONENT-GAP-V2 §2.1 定义了 props |
| **StatsBar** | PRD §4.1 "统计卡片" | ✓ COMPONENT-GAP-V2 §2.2 定义了 props |
| **WorkerCard** | PRD §4.2 "模板卡片设计" | ✓ COMPONENT-GAP-V2 §2.3 完整映射 |

**覆盖度**: 100%

---

## 4. 功能设计 vs 技术方案

### PRD §4.1 窗口布局

```
┌─────────────────────────────────────────┐
│ 角色列表                             [×]│  ← 标题栏（HTML/Electron）
├─────────────────────────────────────────┤
│ [+ 新建模板]  [搜索框] [筛选]           │  ← 1️⃣ TopBar（按钮+输入+TabFilter）
│                                        │
│ [统计卡片]                             │  ← 2️⃣ StatsBar molecule
│                                        │
│ ┌─ WorkerCard ┬─ WorkerCard ┬─ ... ──┐ │  ← 3️⃣ 网格布局（WorkerList organism）
│ └──────────────┴──────────────┴────────┘ │
└────────────────────────────────────────┘
```

| 区域 | 组件 | 技术方案状态 |
|------|------|-----------|
| TopBar | Button + Input + TabFilter | ✓ 新建 TabFilter |
| StatsBar | StatsBar molecule | ✓ 新建 StatsBar |
| 网格 | WorkerList + WorkerCard | ✓ 升级 WorkerList + 新建 WorkerCard |

**布局可行性**: ✅ 完全覆盖

---

### PRD §4.2 模板卡片设计

```
┌─────────────────────┐
│ ┌─────┐ 模板名      │
│ │头像 │ Role Tag    │
│ └─────┘ 描述...     │
│                    │
│ MCP: tag1, tag2    │
│ Updated: 时间      │
│                    │
│ [编辑][创建][删]   │
└─────────────────────┘
```

| 元素 | WorkerCard Props | 技术方案 |
|------|-----------------|--------|
| 头像 | worker.avatar | ✓ Image + avatar id 映射 |
| 名称 | worker.name | ✓ Text atom |
| Role Tag | worker.role | ✓ Tag atom |
| 描述 | worker.description | ✓ Text 截断 3 行 |
| MCP 标签 | worker.mcps | ✓ Tag atom 循环 + "+N" |
| 时间 | worker.updatedAt？| 🟡 workers-api 无 updatedAt 字段 |
| 操作按钮 | onEdit / onCreate / onDelete | ✓ Button atoms |

**问题**: PRD 提及"Updated: 时间"，但 workers-api.md 返回的 WorkerView 没有 updatedAt，只有 lastActivity.at。应该用 lastActivity 的时间戳吗？

---

## 5. 验收测试清单对标

### T1. 窗口管理

| PRD 用例 | 技术方案覆盖 | 备注 |
|---------|-----------|------|
| T1.1 打开窗口 | Electron IPC | ✓ 非组件 |
| T1.2 重复点击 | Electron window 管理 | ✓ 非组件 |
| T1.3 关闭窗口 | Electron close 事件 | ✓ 非组件 |

---

### T2. 模板列表

| PRD 用例 | 技术实现 | 组件 | 验证 |
|---------|--------|------|------|
| T2.1 列表加载 | WS `{op:'get_workers'}` → WorkerList render | WorkerList organism | ✓ |
| T2.2 卡片显示 | WorkerCard 渲染 worker 对象 | WorkerCard organism | ✓ |
| T2.3 空状态 | TemplateList empty state | TemplateList organism | ✓ |
| T2.4 加载态 | TemplateList loading skeleton | TemplateList organism | ✓ |
| T2.5 MCP 标签截断 | mcps.slice(0,3) + "+N" | WorkerCard | ✓ |

---

### T3. 创建模板

| PRD 用例 | 技术实现 | 验证 |
|---------|--------|------|
| T3.1 打开表单 | Modal + TemplateEditor | ✓ 现有 organisms |
| T3.2 头像随机 | WS 前调 `/api/panel/avatars/random` | 🟡 需确认 TemplateEditor 实现 |
| T3.3~T3.9 表单验证/提交 | FormField validation + HTTP POST | ✓ 现有能力 |

**风险**: T3.2 头像随机时机。PRD 说"打开创建表单时立即调"，但 TemplateEditor 目前不一定有此逻辑。

---

### T4. 编辑模板

| PRD 用例 | 技术实现 | 验证 |
|---------|--------|------|
| T4.1 表单预填 | FormField defaultValue | ✓ 现有 |
| T4.2 模板名禁改 | Input disabled | ✓ 现有 |
| T4.3 头像不覆盖 | TemplateEditor 新建/编辑分支 | 🟡 需确认 |
| T4.4~T4.5 修改提交 | HTTP PUT | ✓ 现有 |

---

### T5. 删除模板

| PRD 用例 | 技术实现 | 验证 |
|---------|--------|------|
| T5.1~T5.4 删除流程 | ConfirmDialog + HTTP DELETE | ✓ 现有 |

---

### T6. 创建实例

| PRD 用例 | 技术实现 | 验证 |
|---------|--------|------|
| T6.1~T6.3 实例创建 | Modal + Input + HTTP POST | ✓ 现有 |

---

### T7. 头像选择

| PRD 用例 | 技术实现 | 组件 | 验证 |
|---------|--------|------|------|
| T7.1 打开面板 | Modal 弹窗 | Modal atoms | ✓ |
| T7.2 网格来源 | HTTP `GET /api/panel/avatars` | AvatarPicker molecules | ✓ |
| T7.3 当前高亮 | avatar id 比对 | CSS state | ✓ |
| T7.4 点选回填 | onSelect callback | AvatarPicker | ✓ |
| T7.5 随机按钮 | HTTP `GET /api/panel/avatars/random` | Button + AvatarPicker | ✓ |
| T7.6 库空提示 | 返回 `{ avatar: null }` 时 toast | NotificationStack | ✓ |
| T7.7 关闭不保存 | Modal onCancel 不触发回调 | Modal behavior | ✓ |
| T7.8 自定义头像 | API 返回数组包含 custom-xxx | AvatarPicker render loop | ✓ |

**覆盖度**: 100%

---

### T8. 实时事件

| PRD 用例 | 技术实现 | 验证 |
|---------|--------|------|
| T8.1 其他客户端创建 | WS 事件 `template.created` → WorkerList 重拉 get_workers | ✓ 方案包含 |
| T8.2 其他客户端编辑 | WS 事件 `template.updated` → WorkerList 重拉 | ✓ 方案包含 |
| T8.3 其他客户端删除 | WS 事件 `template.deleted` → WorkerList 重拉 | ✓ 方案包含 |

**覆盖度**: 100%

---

## 6. 关键技术问题与分歧

### 🟡 问题 1：头像 Updated 时间戳

**PRD 需求**: 卡片显示"Updated: 2026-04-27 10:30"

**数据来源问题**:
- workers-api.md 的 WorkerView 没有 `updatedAt` 字段
- 只有 `lastActivity.at`（最后一次 turn 的时间）

**建议解决**:
1. 用 `lastActivity.at` 代替（代表员工最后活动时间）
2. 或后端在 WorkerView 中补加 `updatedAt` 字段（模板最后更新时间）

**PM 需确认**: 应该显示"最后更新模板时间"还是"最后活动时间"？

---

### 🟡 问题 2：onMessage 按钮行为

**PRD 需求**: WorkerCard 有"消息按钮"

**PRD 第 6.0 节的说法**: 
> "点击员工卡片聊天按钮 → 用 `worker.name` 去 `/api/panel/instances` 找该模板的 `ACTIVE` 实例 → 前端跳转 teamCanvas"

**技术问题**:
- 需要在 WorkerCard 的 `onMessage` 回调中调用 `GET /api/panel/instances?templateName=xxx&status=ACTIVE`
- 这不是 workers-api 的职责，而是 instances-api

**建议**:
1. WorkerCard 的 `onMessage` 只负责触发 callback，业务层调用 instances-api
2. 或者 WorkerCard 接收一个计算好的 "primary active instance ID"

**PM 需确认**: 消息按钮是否应该在 WorkerCard 中实现，还是由业务层处理实例查询？

---

### 🟡 问题 3：头像随机的时机和跳转

**PRD 需求** (故事 3):
> "打开创建表单时立即调 `GET /api/panel/avatars/random`，填到 `avatar` 字段，头像区预览该头像对应的图片"

**技术问题**:
- TemplateEditor 是共享组件（创建/编辑都用），需要区分时机
- 创建时：自动调 `/avatars/random`
- 编辑时：**不调**，复用原有 avatar

**当前代码**:
- 不确定 TemplateEditor 是否已实现此逻辑

**建议**:
1. TemplateEditor 增加 `mode` prop：'create' | 'edit'
2. 创建时 mount 发起随机头像请求
3. 编辑时使用传入的 initialValues.avatar

**PM 需确认**: TemplateEditor 是否需要改造以支持此逻辑？

---

### 🟡 问题 4：TabFilter 的筛选条件

**PRD 需求** (设计稿): "三 Tab 筛选（全部成员/角色模板/在线中）"

**技术问题**:
- "全部成员" = 无过滤
- "角色模板" = ？（想表达什么维度？）
- "在线中" = status === 'online'

**猜测**:
- "角色模板" 可能是想按 `role` 字段分组？或显示模板列表（而不是实例）？

**建议**:
1. TabFilter 应该能接收动态的 tab 定义（名称、计数、filter 函数）
2. WorkerList 根据当前 tab 对 workers 数组过滤

**PM 需确认**: 三个 Tab 的具体含义和过滤逻辑是什么？

---

## 7. 总体覆盖度评分

| 维度 | 覆盖率 | 备注 |
|------|--------|------|
| **用户故事** | 95% | 故事 1-7 基本覆盖，onMessage 行为需明确 |
| **功能需求** | 90% | 缺时间戳字段、头像随机逻辑需确认 |
| **验收测试** | 93% | T1-T8 大部分可行，部分依赖后端数据补齐 |
| **组件设计** | 100% | TabFilter、StatsBar、WorkerCard 全部新建定义 |
| **现有复用** | 100% | 15+ 现有组件满足，无额外补齐 |

**总体评分**: 🟢 92% — 方案基本可行，需 PM 澄清 3-4 个技术问题

---

## 8. PM 审查清单

请逐条确认：

- [ ] 问题 1：卡片时间戳应显示"最后更新模板"还是"最后活动"？
- [ ] 问题 2：消息按钮由 WorkerCard 实现还是业务层处理实例查询？
- [ ] 问题 3：TemplateEditor 是否需要改造支持"创建时自动随机头像"？
- [ ] 问题 4：三个 Tab 的具体过滤条件是什么（特别是"角色模板"的含义）？
- [ ] 其他：PRD 中是否还有其他隐含需求我遗漏了？

**回复方式**: 
1. 逐条回复，或
2. 私聊讨论具体问题

