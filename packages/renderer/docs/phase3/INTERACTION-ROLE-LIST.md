# 角色列表窗口交互设计

**日期**：2026-04-27  
**版本**：v1.0  
**范围**：renderer 前端  

## 1. 功能定位

角色列表窗口是成员管理的独立入口，展示内置 11 个基础成员模板 + 用户创建的模板。用户可以：
- 浏览所有模板卡片
- 点击卡片查看/编辑模板详情
- 从模板快速创建成员实例
- 创建新的成员模板

## 2. 入口与触发

### 2.1 ToolBar 入口

在 `ExpandedView` 的 `ToolBar` 右侧按钮组中新增 **👥 成员面板** 按钮。

```
[Model Dropdown]           [👥 成员面板] [⚙️ 设置]
```

- **位置**：齿轮图标（设置）左侧，间距 4px
- **样式**：共用 `.toolbar__icon-btn` 样式
- **状态**：
  - 默认态：灰色图标
  - 激活态：`[data-active='true']`，背景加深 + 高光效果
  - Hover 态：亮度提升

### 2.2 打开方式

点击 👥 按钮 → 调用 `onTeamPanel()` 回调 → Electron 层通过 `window.electronAPI.openTeamPanel()` 打开独立窗口。

---

## 3. 窗口布局

### 3.1 窗口容器

使用 `PanelWindow` 模板包裹：
- 顶部：`DragHandle` 提供拖动区域
- 主体：`<div className="role-list">` 内部填充

### 3.2 顶部工具栏

**组成**：
```
[标题 "成员管理"] ┇ [新建成员] [❌ 关闭]
```

- **标题**：`<h1>成员管理</h1>`，字体 24px，粗体
- **新建成员**：`Button(variant="primary", size="sm")`，文案 "+ 新建成员"
- **关闭**：`Button(variant="ghost", icon=close)`，位于最右角

**样式类**：`.role-list__header`（flex 行，space-between，padding 16px）

### 3.3 主体区域

使用 **TemplateList** organism 展示卡片网格，继承现有样式：
- 卡片网格布局（grid 3 列，gap 16px）
- 每卡展示：
  - 头像（avatar 48×48）
  - 模板名称
  - 角色 Tag（如 "backend-engineer"）
  - 描述（最多 100 字，超出…截断）
  - MCP 工具 Tag（最多显示 3 个，超出显示 "+N"）
  - 操作按钮（编辑、删除）

**空态**：暂无模板时显示 "📋 暂无模板"，下方 "新建第一个" 按钮

### 3.4 样式布局

```css
.role-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
  padding: 16px;
}

.role-list__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}

.role-list__body {
  flex: 1;
  overflow-y: auto;
}
```

---

## 4. 交互流程

### 4.1 查看/编辑模板

```
点击卡片 → 打开 Modal
├─ 显示 TemplateEditor
├─ 填充模板数据（name/role/description/persona/avatar/mcps）
├─ 编辑字段
├─ 点"保存" → PATCH /api/templates/:name → 刷新列表
└─ 点"取消" → 关闭 Modal，无数据变更
```

**Modal 组件**：需补充 `Modal` / `Dialog` atom（目前无）  
**临时方案**：使用 `PanelWindow` 内嵌第二个区域（侧栏展开）

### 4.2 创建成员实例

每张卡片底部 **"创建实例"** 按钮（补充 TemplateList 组件）：

```
点击"创建实例" → 打开实例创建 Modal
├─ 显示模板信息（只读）
├─ 输入成员名称（必填）
├─ 是否为 Leader（Checkbox）
├─ 确认 → POST /api/role-instances 创建实例
└─ 返回列表，刷新 TeamCanvas
```

**数据流**：
- 实例创建后 WS 事件 `instance.created` 触发
- `agentStore` 更新
- TeamCanvas 实时渲染新成员

### 4.3 创建新模板

点 **"新建成员"** 按钮 → 打开 TemplateEditor Modal：

```
打开 TemplateEditor（新建模式）
├─ 名称字段可编辑
├─ 头像随机生成（GET /avatars/random）
├─ 填充字段
├─ 点"保存" → POST /api/templates → 刷新列表
└─ 点"取消" → 关闭 Modal
```

### 4.4 编辑现有模板

点卡片操作栏的 **"编辑"** 按钮 → 打开 TemplateEditor Modal（编辑模式）：

```
打开 TemplateEditor（编辑模式）
├─ 名称字段禁用（prevents 重命名风险）
├─ 头像沿用已有（不重新随机）
├─ 修改字段
├─ 点"保存" → PATCH /api/templates/:name → 刷新列表
└─ 点"取消" → 关闭 Modal
```

### 4.5 删除模板

点卡片操作栏的 **"删除"** 按钮：

```
弹确认对话框
├─ "确定删除模板 X ？此操作不可撤销"
├─ 确认 → DELETE /api/templates/:name → 刷新列表
└─ 取消 → 关闭对话框
```

---

## 5. 和 TeamCanvas 的关系

### 5.1 窗口隔离

- **角色列表窗口**：独立 Electron 窗口，用于浏览 / 管理模板
- **TeamCanvas**：主窗口内嵌面板（ expandedView 中的 TeamMonitorPanel），用于实时渲染团队成员

### 5.2 交互流向

```
角色列表窗口
  ├─ 创建实例 (POST /api/role-instances)
  │   ├─ Backend 返回 instanceId
  │   └─ WS 广播 instance.created 事件
  │
  ├─ Frontend 收到事件
  │   ├─ agentStore 更新新实例
  │   └─ TeamCanvas 实时渲染
  │
  └─ 窗口间通信（可选）
      └─ 角色列表 → Main 进程 → TeamCanvas
```

### 5.3 状态同步

模板和实例数据来自同一后端 API：
- `GET /api/templates` — 获取模板列表
- `POST /api/templates` — 创建模板
- `PATCH /api/templates/:name` — 编辑模板
- `DELETE /api/templates/:name` — 删除模板
- `POST /api/role-instances` — 创建实例

无需特殊的跨窗口状态管理，WS 事件 + HTTP API 自动同步。

---

## 6. 组件清单

### 新增/改造

| 组件 | 层级 | 状态 | 说明 |
|------|------|------|------|
| TemplateList | organisms | ✅ 已有 | 复用，补充 "创建实例" 按钮 |
| TemplateEditor | organisms | ✅ 已有 | 复用，在 Modal 中使用 |
| Modal / Dialog | atoms | ⚠️ 缺 | 需补充 |
| DragHandle | molecules | ✅ 已有 | 窗口顶部拖动 |
| Button | atoms | ✅ 已有 | 各类操作按钮 |
| Icon | atoms | ✅ 已有 | close/plus/settings 等图标 |
| Confirm Dialog | molecules | ⚠️ 缺 | 删除确认，可用简易 Modal 过渡 |

### 待补充

1. **Modal / Dialog atom**  
   - 透明背景 overlay + 中心卡片
   - props: `title / children / onClose / footer?`
   - 用于编辑/创建/确认

2. **TemplateList 扩展**  
   - 每卡新增 "创建实例" 按钮
   - prop: `onCreateInstance?: (templateName: string) => void`

---

## 7. API 对接

### 模板相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/templates` | 获取所有模板 |
| POST | `/api/templates` | 创建新模板（body: TemplateDraft） |
| PATCH | `/api/templates/:name` | 编辑模板 |
| DELETE | `/api/templates/:name` | 删除模板 |
| GET | `/avatars/random` | 随机头像 |
| GET | `/avatars` | 获取头像列表 |

### 实例相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/role-instances` | 创建实例（body: 包含 templateName / name / isLeader） |
| GET | `/api/role-instances` | 获取所有实例 |

### WS 事件

| 事件 | 监听者 | 作用 |
|------|--------|------|
| `instance.created` | TeamCanvas | 实时加入新成员 |
| `template.created` | TemplateList | 列表追加新模板 |
| `template.updated` | TemplateList | 列表刷新该模板卡片 |
| `template.deleted` | TemplateList | 列表移除该模板卡片 |

---

## 8. 交付检查清单

- [ ] 👥 按钮集成到 ToolBar（位于齿轮左侧）
- [ ] Electron 层实现 `openTeamPanel()` 打开独立窗口
- [ ] 角色列表窗口使用 PanelWindow 包裹
- [ ] TemplateList 组件加入 "创建实例" 按钮
- [ ] 补充 Modal 基础组件（或临时用侧栏方案）
- [ ] TemplateEditor 嵌入 Modal，支持新建/编辑/删除流程
- [ ] API 调用对接（get/post/patch/delete）
- [ ] WS 事件监听并触发列表刷新
- [ ] 实例创建后 TeamCanvas 自动渲染
- [ ] Playground 同步演示流程
- [ ] 截图验证 3+ 步骤端到端流程

---

## 9. 交互状态图

```
[ExpandedView]
  ├─ ToolBar
  │   └─ [👥 按钮] → 点击触发 onTeamPanel()
  │
  └─ [TeamCanvas]

[角色列表独立窗口]
  ├─ [顶部工具栏]
  │   ├─ 标题："成员管理"
  │   ├─ [新建成员] → 打开 TemplateEditor Modal
  │   └─ [关闭]
  │
  ├─ [卡片网格]
  │   └─ 每卡 → 点击查看详情 / 编辑 / 创建实例 / 删除
  │
  └─ [Modals]
      ├─ TemplateEditor (新建 / 编辑)
      │   └─ 保存 → POST/PATCH → 刷新列表 → 更新 TeamCanvas
      │
      ├─ 实例创建
      │   └─ 确认 → POST /api/role-instances → WS instance.created
      │
      └─ 删除确认
          └─ 确认 → DELETE → 刷新列表
```

---

## 补充说明

### 为什么角色列表是独立窗口？

1. **职责分离**：模板管理 vs 实时监控
2. **屏幕利用**：不占用 TeamCanvas 空间
3. **交互频率**：创建/编辑模板频率低，可异步完成
4. **未来扩展**：模板库支持分享/导入，独立窗口更灵活

### 和"成员面板"（TeamMonitorPanel）的区别？

| 对比项 | 角色列表 | 成员面板 |
|--------|----------|---------|
| 内容 | 模板库（模板集合） | 实例监控（当前团队成员） |
| 位置 | 独立 Electron 窗口 | ExpandedView 侧栏 |
| 刷新频率 | 低（管理操作） | 高（实时监控） |
| 操作 | CRUD 模板 | 查看状态、迁移、删除 |
| 用户 | 系统管理员 | 所有用户 |

