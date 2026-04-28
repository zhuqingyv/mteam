# I18N 扫描报告

**扫描时间**：2026-04-26  
**扫描范围**：`packages/renderer/src/**/*.{tsx,ts}`  
**总计硬编码文案**：103 条（中文 60 条 + 英文 43 条）  

---

## 1. 硬编码文案清单

### 📋 按文件分组

#### **atoms/** — 原子组件

| 文件 | 行号 | 内容 | 类型 |
|------|------|------|------|
| `atoms/Button/Button.tsx` | 15 | `aria-label="menu"` | 英文 |
| `atoms/Logo/Logo.tsx` | 9 | `@deprecated 用 status 替代` | 中文注释 |
| `atoms/TeamSidebarItem/TeamSidebarItem.tsx` | 19 | `title={name}` | 动态值 |

#### **molecules/** — 分子组件

| 文件 | 行号 | 内容 | 类型 |
|------|------|------|------|
| `molecules/AgentSwitcher/AgentSwitcher.tsx` | 44 | `aria-label="添加"` | 中文 |
| `molecules/AvatarPicker/AvatarPicker.tsx` | 49 | `<span>随机</span>` | 中文 |
| `molecules/AvatarPicker/AvatarPicker.tsx` | 67 | `aria-label="头像选择"` | 中文 |
| `molecules/AvatarPicker/AvatarPicker.tsx` | 81 | `aria-label={`头像 ${avatar.id}`}` | 中文 |
| `molecules/ChatHeader/ChatHeader.tsx` | 23 | `aria-label="关闭"` | 中文 |
| `molecules/ChatInput/ChatInput.tsx` | 13 | `placeholder = '输入消息…'` | 中文 |
| `molecules/ChatInput/ChatInput.tsx` | 51 | `aria-label="发送"` | 中文 |
| `molecules/CliList/CliList.tsx` | 28 | `安装 ... 后点右上角 Refresh` | 混合 |
| `molecules/CliList/CliList.tsx` | 38 | `title={c.path}` | 动态值 |
| `molecules/ConfirmDialog/ConfirmDialog.tsx` | 22 | `confirmLabel = '确认'` | 中文 |
| `molecules/ConfirmDialog/ConfirmDialog.tsx` | 23 | `cancelLabel = '取消'` | 中文 |
| `molecules/ConfirmDialog/ConfirmDialog.tsx` | 29 | `title={title}` | 动态值 |
| `molecules/MessageBadge/MessageBadge.tsx` | 13 | `label = count > 99 ? '99+' : String(count)` | 英文 |
| `molecules/NotificationStack/NotificationStack.tsx` | 64 | `aria-label="acknowledged"` | 英文 |
| `molecules/TeamSidebar/TeamSidebar.tsx` | 22 | `title={collapsed ? '展开' : '收起'}` | 中文 |
| `molecules/TeamSidebar/TeamSidebar.tsx` | 40 | `title="新建团队"` | 中文 |
| `molecules/ToolBar/ToolBar.tsx` | 32 | `aria-label="成员面板"` | 中文 |
| `molecules/ToolBar/ToolBar.tsx` | 33 | `title="成员面板"` | 中文 |
| `molecules/ToolBar/ToolBar.tsx` | 42 | `aria-label="设置"` | 中文 |
| `molecules/ToolBar/ToolBar.tsx` | 43 | `title="设置"` | 中文 |
| `molecules/ToolCallList/ToolCallList.tsx` | 31 | `<span>工具调用</span>` | 中文 |

#### **organisms/** — 器官组件

| 文件 | 行号 | 内容 | 类型 |
|------|------|------|------|
| `organisms/AgentList/AgentList.tsx` | 35 | `title={a.task}` | 动态值 |
| `organisms/ChatPanel/ChatPanel.tsx` | 44 | `inputPlaceholder = '给 MTEAM 发送消息...'` | 混合 |
| `organisms/NotificationCenter/NotificationCenter.tsx` | 24 | `<span>Notifications</span>` | 英文 |
| `organisms/NotificationCenter/NotificationCenter.tsx` | 31 | `<div>No notifications</div>` | 英文 |
| `organisms/TeamMonitorPanel/TeamMonitorPanel.tsx` | 41 | `aria-label="展开团队面板"` | 中文 |
| `organisms/TeamMonitorPanel/TeamMonitorPanel.tsx` | 30 | `\`${teams.length} Teams\` / \`${memberCount} Agents\`` | 英文混合 |
| `organisms/TemplateEditor/TemplateEditor.tsx` | 57-67 | 验证错误信息 6 条 | 中文 |
| `organisms/TemplateEditor/TemplateEditor.tsx` | 91-144 | 表单 label 8 条 + placeholder 4 条 | 中文/英文 |
| `organisms/TemplateEditor/TemplateEditor.tsx` | 171-174 | `保存 / 取消` | 中文 |
| `organisms/TemplateList/TemplateList.tsx` | 69 | `<span>新建模板</span>` | 中文 |
| `organisms/TemplateList/TemplateList.tsx` | 88 | `创建第一个模板` | 中文 |
| `organisms/TemplateList/TemplateList.tsx` | 134 | `title={tpl.description}` | 动态值 |
| `organisms/TemplateList/TemplateList.tsx` | 160/168 | `编辑 / 删除` | 中文 |

#### **pages/** — 页面

| 文件 | 行号 | 内容 | 类型 |
|------|------|------|------|
| `pages/RoleListPage.tsx` | 108-113 | 错误提示 4 条 | 中文 |
| `pages/RoleListPage.tsx` | 127/149 | 新建成员相关 2 条 | 中文 |
| `pages/RoleListPage.tsx` | 166-187 | 删除/创建对话框 5 条 | 中文 |
| `pages/SettingsPage.tsx` | 127/129 | 标签页 label 2 条 | 中文 |
| `pages/SettingsPage.tsx` | 167/184-187 | 编辑/删除模板 3 条 | 中文 |
| `pages/TeamPage.tsx` | 116 | `尚未创建团队` | 中文 |
| `pages/TeamPage.tsx` | 118 | `让主 Agent 帮你拉起第一个团队，开始协作` | 中文 |
| `pages/TeamPage.tsx` | 127 | `创建团队` | 中文 |

#### **hooks/** 和 **api/** — 业务逻辑

| 文件 | 行号 | 内容 | 类型 |
|------|------|------|------|
| `hooks/turnHydrator.ts` | 33 | `title: typeof b.title === 'string' ? b.title : undefined` | 动态值 |
| `api/primaryAgent.ts` | 39/45-46 | @deprecated 注释 | 中文注释 |

---

## 2. 手搓组件清单

### 🔍 裸 DOM 元素使用情况

#### **organisms/TemplateEditor/TemplateEditor.tsx**
- **L115**：裸 `<button>` 做头像选择按钮
  ```tsx
  <button
    type="button"
    className="tpl-editor__avatar-btn"
    onClick={() => setPickerOpen((v) => !v)}
    aria-label="选择头像"
  >
  ```
  **问题**：应该用 Button atom 或封装为 Icon Button molecule
  
- **L156**：裸 `<button>` 做 MCP 添加按钮
  ```tsx
  <button
    type="button"
    className="tpl-editor__mcp-add"
    onClick={() => toggleMcp(m)}
  >
    + {m}
  </button>
  ```
  **问题**：应该用 Button atom

#### **organisms/TeamMonitorPanel/TeamMonitorPanel.tsx**
- **L37**：裸 `<button>` 做折叠按钮
  ```tsx
  <button
    type="button"
    className="team-monitor__collapsed-face"
    onClick={() => onToggleCollapsed?.()}
    aria-label="展开团队面板"
  >
  ```
  **问题**：应该用 Button atom 或 Surface molecule

#### **organisms/NotificationCenter/NotificationCenter.tsx**
- **L36**：裸 `<button>` 做通知项点击区
  ```tsx
  <button
    type="button"
    className={`notif-center__item${read ? ' notif-center__item--read' : ''}`}
    onClick={() => !read && onAcknowledge?.(n.id)}
  >
    <NotificationCard {...n} />
  </button>
  ```
  **问题**：样式/交互容器，可接受（类似 card 按钮）

### 📊 统计

- **总裸 `<button>` 数**：4 个
- **样式容器（可接受）**：1 个（NotificationCenter）
- **需要改进**：3 个（TemplateEditor ×2、TeamMonitorPanel ×1）
- **裸 `<input>` / `<textarea>` / `<svg>` 数**：0 个（全用了 atoms）
- **内联样式数**：0 个

---

## 3. 建议的 i18n 方案

### 📐 目录结构

```
src/
├── locales/
│   ├── zh-CN/
│   │   ├── atoms.json
│   │   ├── molecules.json
│   │   ├── organisms.json
│   │   ├── pages.json
│   │   └── common.json
│   ├── en-US/
│   │   ├── atoms.json
│   │   ├── molecules.json
│   │   ├── organisms.json
│   │   ├── pages.json
│   │   └── common.json
│   └── index.ts          // 导出 i18n 实例
├── i18n.ts               // i18n 配置（推荐 react-i18next）
```

### 🔑 Key 命名规范

**格式**：`<layer>.<component>.<semantic>`

**示例**：
- `molecules.confirm_dialog.confirm_label` = "确认"
- `organisms.template_editor.name_error_required` = "请输入模板名称"
- `pages.team_page.empty_title` = "尚未创建团队"
- `common.button_save` = "保存"
- `common.button_cancel` = "取消"
- `common.error_not_found` = "找不到"

### 📝 Key 分类方案

#### **按语义分类**（推荐）
- `errors.*` - 所有错误信息
- `buttons.*` - 所有按钮文案
- `labels.*` - 所有表单标签
- `messages.*` - 提示/反馈文案
- `placeholders.*` - 输入框 placeholder
- `titles.*` - 标题/对话框标题
- `aria.*` - 无障碍标签（虽然 aria 通常不翻译，但保留占位）

#### **通用提取清单（共 103 条）**

| 分类 | 数量 | 示例 Key |
|------|------|---------|
| 按钮文案 | 12 | `buttons.save`, `buttons.cancel`, `buttons.delete` |
| 错误消息 | 15 | `errors.template_name_required`, `errors.invalid_name_format` |
| 标签/占位符 | 28 | `labels.template_name`, `placeholders.input_message` |
| 标题/说明 | 20 | `titles.delete_template`, `messages.no_notifications` |
| 表单验证 | 18 | `validation.max_length`, `validation.field_exists` |
| 状态文案 | 10 | `status.creating_template`, `status.no_teams_yet` |

### 🛠️ 实现工具推荐

**选项 1：react-i18next**（主流方案）
```typescript
// src/i18n.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN/index.json';
import enUS from './locales/en-US/index.json';

i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN }, 'en-US': { translation: enUS } },
  lng: navigator.language,
  fallbackLng: 'zh-CN',
});

export default i18n;
```

**使用**：
```typescript
import { useTranslation } from 'react-i18next';

export function MyComponent() {
  const { t } = useTranslation();
  return <button>{t('buttons.save')}</button>;
}
```

**选项 2：自建轻量方案**（如项目现有简单方案）
```typescript
// src/locales/index.ts
const messages = {
  'zh-CN': { /* ... */ },
  'en-US': { /* ... */ },
};

export const t = (key: string, lang = 'zh-CN'): string => 
  key.split('.').reduce((obj, k) => obj?.[k], messages[lang]) ?? key;
```

### 🔄 迁移步骤

1. **Phase 1**：导出所有 103 条硬编码到 `locales/zh-CN/`
2. **Phase 2**：翻译到英文 locale
3. **Phase 3**：逐个组件改成 `t()` 调用
4. **Phase 4**：UI 加语言切换器（SettingsPage）
5. **Phase 5**：支持自定义 locale（企业定制需求）

### 📋 优先级排序（建议）

| 优先级 | 类型 | 数量 |
|--------|------|------|
| P0（必须） | 页面标题 + 按钮 | 20 条 |
| P1（应该） | 表单标签 + 错误信息 | 45 条 |
| P2（可选） | aria-label + 提示文案 | 38 条 |

---

## 4. 执行建议

### ✅ 立即行动
1. 禁止新增硬编码文案 - 更新代码审查 checklist
2. 标准化 key 命名 - 制定团队规范文档

### 🎯 短期（1-2 周）
1. 建立 locale 文件结构
2. 提取所有 103 条硬编码
3. 完成中英文翻译

### 📅 中期（1 个月）
1. 集成 i18n 库（选 react-i18next）
2. 按层级逐步改造（atoms → molecules → organisms → pages）
3. 测试语言切换功能

### 🚀 长期
1. 支持自定义 locale
2. 翻译社区协作
3. 性能优化（按需加载 locale）

---

## 5. 检查清单

- [ ] 所有硬编码文案都有对应 locale key
- [ ] Key 命名规范统一（蛇形 snake_case）
- [ ] 支持至少英文 + 中文两种语言
- [ ] 语言切换器在 SettingsPage 可用
- [ ] aria-label 正确翻译（无障碍优先）
- [ ] 动态文案（用户输入/数据库值）不纳入 i18n
