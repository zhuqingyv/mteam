# Phase 3 组件库缺口评估 & 开发方案

**评估日期**: 2026-04-28  
**对标设计稿**: PRD-ROLE-LIST.md + DESIGN-REFERENCE.md（前端 40.png 聊天面板、39.png 思考态、31/38.png 胶囊）  
**目标**: 补齐组件库，支撑"角色列表窗口 + 完整聊天 UI"的完整交付

---

## 1. 设计稿区域 → 组件映射

### 1.1 角色列表窗口主体 （PRD §4.1-4.3）

| 设计区域 | 需要的组件 | 现有? | 状态 |
|---------|----------|-------|------|
| **列表顶部** | — | — | — |
| [+ 新建模板] 按钮 | `Button variant='primary'` | ✓ atoms | 直用 |
| 搜索框 + 搜索图标 | `Input` + `Icon name='search'` | ✓ atoms | 直用 |
| 筛选三 Tab（全部/角色模板/在线中） | **`TabFilter`** | ✗ 新建 | **新建 molecules** |
| **统计卡片** | **`StatsBar`** | ✗ 新建 | **新建 molecules** |
| | 成员总数/在线中/空闲中 | | |
| **列表网格** | — | — | — |
| 模板卡片网格骨架 | `TemplateList` organism | ✓ | 直用 |
| 单张模板卡片（升级版） | **`WorkerCard`** | ✗ 升级需要 | **升级 organisms** |
| | 头像+名称+角色+状态标签+描述+MCP 标签+最近协作+消息按钮+更多菜单 | | |
| **空态** | 文案 + [新建模板] 按钮 | ✓ 文本组件 | 直用 |

### 1.2 创建/编辑表单对话框 （PRD §4.3）

| 设计区域 | 需要的组件 | 现有? | 状态 |
|---------|----------|-------|------|
| 对话框容器 | `Modal` | ✓ atoms | 直用 |
| 表单字段 | `FormField` | ✓ molecules | 直用 |
| 输入框 | `Input` | ✓ atoms | 直用 |
| 多行文本 | `Textarea` | ✓ atoms | 直用 |
| 头像预览 + 点击打开选择 | 头像 + 按钮 | ✓ 分散 | 组合用 |
| MCP 工具多选 | **`CheckboxList`** 或 `FormField variant='checkbox'` | ✗ 可能缺 | **待补或用 atoms** |
| [保存] [取消] 按钮 | `Button` | ✓ atoms | 直用 |

### 1.3 头像选择面板 （PRD §4.4）

| 设计区域 | 需要的组件 | 现有? | 状态 |
|---------|----------|-------|------|
| 面板容器 | `Modal` 或自定义浮层 | ✓ atoms | 直用 |
| 🎲 随机按钮 | `Button` | ✓ atoms | 直用 |
| 头像网格 | 网格布局 + 头像小卡片 | ✗ 可能缺 | **可用 Tailwind grid，或抽 `AvatarGrid` molecules** |
| 当前选中高亮 | CSS 状态 | ✓ | 直用 |
| [关闭] 按钮 | `Button` | ✓ atoms | 直用 |

### 1.4 完整聊天面板 （DESIGN-REFERENCE 40.png）

| 设计区域 | 需要的组件 | 现有? | 状态 |
|---------|----------|-------|------|
| **顶栏** | `ChatHeader` | ✓ molecules | 直用 |
| | M Logo + 标题 | | |
| **消息列表** | — | — | — |
| 左气泡（Agent） | `MessageBubble variant='agent'` | ✓ molecules | 直用 |
| | + Avatar（M Logo）| ✓ molecules | 直用 |
| | + agent 名（蓝色） + 时间戳 | ✓ 内含 | 直用 |
| 右气泡（User） | `MessageBubble variant='user'` | ✓ molecules | 直用 |
| | + 时间戳 | ✓ 内含 | 直用 |
| Thinking 态气泡 | `MessageBubble variant='thinking'` | ✓ molecules | 直用 |
| | + TypingDots 三点动画 | ✓ atoms | 直用 |
| **Agent Tab Bar** | `AgentSwitcher` | ✓ molecules | 直用 |
| | 三个 chip + [+] 按钮 | ✓ | 直用 |
| **输入框** | `ChatInput` | ✓ molecules | 直用 |
| | 文本区 + 发送按钮 | ✓ | 直用 |
| **整体容器** | `ChatPanel` organism | ✓ | 直用 |

### 1.5 其他支撑组件

| 功能 | 需要的组件 | 现有? | 状态 |
|------|----------|-------|------|
| 确认删除对话框 | `ConfirmDialog` | ✓ molecules | 直用 |
| 创建实例输入对话框 | `Modal` + `Input` | ✓ atoms | 组合用 |
| Toast 通知 | `NotificationStack` | ✓ molecules | 直用 |
| 底部鼓励文案 | 文本 + 样式 | ✓ | 直用 |

---

## 2. 新建组件清单

### 2.1 TabFilter （molecules）

**用途**: 三 Tab 筛选（全部成员/角色模板/在线中）

**Props 接口设计**:
```tsx
interface TabFilterProps {
  tabs: Array<{
    id: string;
    label: string;
    icon?: string;      // 可选图标名
    count?: number;     // 计数
  }>;
  activeTab: string;
  onChange: (tabId: string) => void;
  variant?: 'default' | 'compact';
}
```

**视觉特征**:
- 三个按钮并列，当前激活者背景/字色加深
- 每个 tab 可显示计数徽章（小灰字或圆点数字）
- 圆角 `--radius-md`，间距 `--space-2`

**使用场景**: 角色列表窗口顶部筛选

---

### 2.2 StatsBar （molecules）

**用途**: 统计卡片（成员总数/在线中/空闲中），支持交互筛选

**Props 接口设计**:
```tsx
interface StatsBarProps {
  total: number;
  online: number;
  idle: number;
  offline?: number;    // 可选
  variant?: 'horizontal' | 'vertical';
  onClick?: (stat: 'total' | 'online' | 'idle' | 'offline') => void;
}
```

**视觉特征**:
- 三张或四张小卡片并列
- 每张卡片：大数字 + 小文案标签 + 圆点指示器
- 背景 `surface-glass-light`，圆角 `--radius-md`
- ✨ **可点击触发筛选**（新增交互，2026-04-28 pm-role-v2 审阅确认）

**交互规则**（pm-role-v2 审阅补充）:
- 点击"成员总数 X" → 切换 TabFilter 到"全部成员"
- 点击"在线 Y" → 切换 TabFilter 到"在线中"
- 点击"空闲 Z" → 切换 TabFilter 到"在线中"（仅显示空闲）
- 卡片响应状态：按下阴影加深、指示点高亮

**使用场景**: 角色列表窗口顶部统计展示 + 快捷筛选入口

---

### 2.3 WorkerCard （organisms，升级现有 TemplateCard）

**用途**: 升级版角色卡片，展示员工全景

**当前 TemplateCard 展示**:
- 头像 + 模板名 + role 标签 + 描述 + MCP 标签 + 更新时间 + 操作按钮

**升级需求** (对照 workers-api.md，2026-04-28 pm-role-v2 审阅补充):
```tsx
interface WorkerCardProps {
  worker: {
    name: string;           // 员工身份锚点
    role: string;           // 岗位名
    description: string | null;
    persona: string | null;
    avatar: string | null;  // 头像 id
    mcps: string[];         // MCP 名称列表
    status: 'online' | 'idle' | 'offline';
    instanceCount: number;
    teams: string[];        // 所在团队列表（待确认是否显示在卡片上）
    lastActivity?: {
      summary: string;      // 自然语言文案（待确认格式）
      at: string;           // ISO 时间
    } | null;
  };
  // 核心交互
  onMessage?: (workerName: string) => void;         // 聊天按钮
  onEdit?: (workerName: string) => void;           // 编辑模板
  onCreate?: (workerName: string) => void;         // 创建实例
  onDelete?: (workerName: string) => void;         // 删除模板
  onViewMore?: (action: 'detail' | 'activity') => void;  // 更多菜单（查详情/工作统计）
  
  // 显示模式控制
  lastActivityDisplayMode?: 'compact' | 'full';    // compact: 仅显示协作对象名字; full: 完整文案
}
```

**WorkerCard 更新明细** (pm-role-v2 审阅后确认):
1. ✅ `lastActivityDisplayMode` 支持两个模式
   - `compact`（默认）：从 summary 正则提取第一个协作对象名字
     - 正则规则: `/与\s*(\S+?)\s*(?:和|协作)/`（待后端确认格式）
     - 显示格式: `👥 [名字] M 💬`
     - 降级：解析失败时显示 `👥 最近协作`
   - `full`：直接显示完整 summary 文案
2. ✅ `teams` 字段保留在 props 中，但暂不在卡片上显示（设计空间限制）
   - 可在"详情页"或"工作统计"页展示
3. ✅ 新增 `onViewMore` callback，统一处理"查详情"和"工作统计"两个操作

**新增视觉**:
- 状态标签（在线/空闲/离线），用 `StatusDot` + 文字
- 实例计数徽章（如 "2 个实例"）
- 最近协作摘要（如 "和 Leader 协作完成登录页样式"）+ 时间
- 新增"消息按钮"（聊天图标）

**使用场景**: 替换 TemplateList 中的单张卡片，升级到"员工卡"

---

## 3. 升级组件清单

### 3.1 TemplateList → WorkerList （organisms）

**现状**: 已有 `TemplateList` organism 展示模板网格

**升级点**:
1. 将单张卡片从 `TemplateCard` 改为新的 `WorkerCard`
2. 适配 workers-api.md 返回的数据结构（多了 `status`, `instanceCount`, `teams`, `lastActivity`）
3. 新增顶部筛选（`TabFilter`）和统计（`StatsBar`）
4. 列表顶部新增 [+ 新建模板] 按钮（现有）+ 搜索框 + 筛选 Tab

**不改动**: 网格骨架、加载态、空态逻辑

---

### 3.2 ChatPanel （organisms） - 可选微调

**现状**: 已有完整 ChatPanel，支持消息列表、输入框、Agent 切换

**微调点**（对照 DESIGN-REFERENCE 40.png）:
1. ✓ `ChatHeader` 已支持 M Logo + 标题
2. ✓ `MessageBubble` 已支持 agent/user/thinking 三态
3. ✓ `ChatInput` 已支持文本 + 发送按钮
4. ✓ `AgentSwitcher` 已支持 chip 切换 + [+] 按钮
5. 可选：微调气泡 max-width (~78%)、间距、时间戳样式，以贴近设计稿

**不需要新建组件**，现有架构已满足

---

## 4. 开发任务拆分

### Wave 1（基础组件库补齐）- 工期 2-3 天

**目标**: 补齐 `TabFilter` 和 `StatsBar` molecules，完成 Phase 3 底层

| 任务 | 详情 | 工期 | 负责 |
|------|------|------|------|
| **T1.1** | 新建 `src/molecules/TabFilter/`，支持 props 接口、playground 注册 | 1 天 | @fe-dev-1 |
| **T1.2** | 新建 `src/molecules/StatsBar/`，支持 props 接口、playground 注册 | 1 天 | @fe-dev-2 |
| **T1.3** | 升级 playground 版本号（minor 升，含 2 个新 molecules） | 0.5 天 | @fe-dev-1 |
| **T1.4** | 单测覆盖（两个新 molecules 的交互 + 无障碍） | 0.5 天 | @qa-1 |

---

### Wave 2（角色列表窗口组件）- 工期 3-4 天

**目标**: 完成 `WorkerCard` 升级、`TemplateList` → `WorkerList` 适配、集成 API

| 任务 | 详情 | 工期 | 负责 |
|------|------|------|------|
| **T2.1** | 新建 `src/organisms/WorkerCard/`（升级版角色卡片），含新 props、操作按钮 | 1.5 天 | @fe-dev-3 |
| **T2.2** | 升级 `src/organisms/TemplateList/` 改名 → `WorkerList`，适配 workers API 数据结构 | 1 天 | @fe-dev-1 |
| **T2.3** | 集成 `get_workers` WS 接口 + 状态管理（Zustand store） | 1 天 | @fe-dev-2 |
| **T2.4** | 顶部筛选 + 搜索 + 统计渲染，关联 `TabFilter` + `StatsBar` | 1 天 | @fe-dev-3 |
| **T2.5** | playground 注册新/升级后的 organisms，版本号 minor 升 | 0.5 天 | @fe-dev-1 |
| **T2.6** | 集成测试 + 视觉验证（设计稿对齐） | 1 天 | @qa-1 |

---

### Wave 3（聊天面板微调）- 工期 1-2 天

**目标**: 确保聊天 UI 贴近设计稿，完整验证

| 任务 | 详情 | 工期 | 负责 |
|------|------|------|------|
| **T3.1** | 微调 `ChatPanel` 气泡布局、间距、时间戳（对照 DESIGN-REFERENCE 40.png） | 0.5 天 | @fe-dev-3 |
| **T3.2** | 验证 `MessageBubble` thinking 态动画（三点跳动） | 0.5 天 | @fe-dev-2 |
| **T3.3** | 端到端测试：打开聊天窗口 → 发送消息 → 接收 Agent 回复 → thinking 态 | 1 天 | @qa-1 |

---

## 5. 工时估算与优先级

| Wave | 任务数 | 预期工期 | 优先级 | 阻碍因素 |
|------|--------|---------|--------|---------|
| 1 | 4 | 2-3 天 | 🔴 P0 | 无，独立 |
| 2 | 6 | 3-4 天 | 🔴 P0 | 需 Wave 1 完成 + WS API 稳定 |
| 3 | 3 | 1-2 天 | 🟡 P1 | 需 Wave 1/2 + 后端消息流就绪 |

**总工期**: 6-9 天（三 Wave 顺序执行）

**并行空间**:
- Wave 1 的 T1.1 和 T1.2 可并行（各 1 天）
- Wave 2 的 T2.1/T2.2 可部分并行（数据结构协调）
- Wave 3 可独立验证，不阻塞交付

---

## 6. 新建/升级组件明细

### 新建

```
src/molecules/
├── TabFilter/
│   ├── TabFilter.tsx
│   ├── TabFilter.css（可选）
│   └── index.ts
└── StatsBar/
    ├── StatsBar.tsx
    ├── StatsBar.css
    └── index.ts

src/organisms/
└── WorkerCard/
    ├── WorkerCard.tsx
    ├── WorkerCard.css
    └── index.ts
```

### 升级

```
src/organisms/
├── TemplateList/ → WorkerList/（改名 + 适配新数据结构）
│   └── ... 内部调整
└── ChatPanel/（微调，架构不变）
    └── ... 间距/样式微调
```

### Playground 更新

```
playground/
├── registry.ts（新增 TabFilter + StatsBar + WorkerCard，升级 WorkerList）
├── App.tsx（版本号 minor 升）
└── index.html（版本号同步）
```

---

## 7. 验收标准

### 组件库层面（基础）

- [ ] ✓ 0 个 playground 组件注册失败
- [ ] ✓ 所有新/升级组件在 playground 展示正常、props 可调、Events 有日志
- [ ] ✓ 0 个组件缺 TypeScript 类型定义
- [ ] ✓ 单测覆盖新组件交互（TabFilter 切换、StatsBar 点击、WorkerCard 操作）

### StatsBar 层面（pm-role-v2 审阅新增）

- [ ] ✓ T1.4 StatsBar 点击交互验收
  - 点击"在线 4" → TabFilter 自动切换到"在线中"
  - 点击"成员总数 6" → TabFilter 自动切换到"全部成员"
  - 卡片按下时有视觉反馈（阴影/高亮）
  - 列表实时过滤，无闪烁

### WorkerCard 层面（pm-role-v2 审阅补充）

- [ ] ✓ lastActivityDisplayMode='compact' 时，能正确提取协作对象名字
  - 规则：`/与\s*(\S+?)\s*(?:和|协作)/`
  - 示例验证：summary="与 Alice 和 Bob 协作发起 PR" → 显示"👥 Alice M 💬"
  - 失败降级：显示"👥 最近协作"
- [ ] ✓ lastActivityDisplayMode='full' 时，完整显示 summary 文案
- [ ] ✓ `onViewMore` callback 生效
  - 点击"查看详情" → `onViewMore('detail')`
  - 点击"工作统计" → `onViewMore('activity')`
- [ ] ✓ 操作按钮底部排列一致，间距规范（对齐设计稿 40.png）

### 角色列表窗口层面

- [ ] ✓ 获取 `get_workers` 响应 < 500ms，列表渲染
- [ ] ✓ TabFilter 点击切换生效（全部/角色模板/在线中）
- [ ] ✓ StatsBar 卡片点击关联筛选
- [ ] ✓ WorkerCard 显示完整信息（头像+名称+角色+状态+实例数+最近协作+MCP 标签）
- [ ] ✓ 卡片操作按钮（编辑/创建/删除/消息/更多） 可点击
- [ ] ✓ 搜索框 + 筛选组合使用无冲突
- [ ] ✓ 聊天按钮点击 → 查 `/api/role-instances` 找 ACTIVE → 跳转 teamCanvas

### 聊天面板层面

- [ ] ✓ 气泡布局、间距贴近 DESIGN-REFERENCE 40.png
- [ ] ✓ Thinking 态三点动画流畅（60fps）
- [ ] ✓ 消息输入 → 发送 → 接收流程完整

### 后端依赖确认（待回复）

- ⏳ `lastActivity.summary` 格式是否统一为"与<name>..."开头？
- ⏳ `get_workers` 响应时间预期（假设 <500ms）
- ⏳ `worker.status_changed` 事件的 emit 条件（status/instanceCount/teams 变化时）

---

## 8. 与其他模块的关系

```
角色列表窗口
  ├─ WorkerList organism
  │   ├─ TabFilter molecules ← 新建
  │   ├─ StatsBar molecules ← 新建
  │   └─ WorkerCard organisms ← 新建
  │       ├─ Avatar molecules
  │       ├─ Button atoms
  │       ├─ Icon atoms
  │       ├─ StatusDot atoms
  │       └─ Tag atoms
  │
  └─ TemplateEditor organism（现有，创建/编辑表单）
      ├─ Modal atoms
      ├─ FormField molecules
      ├─ Input atoms
      ├─ AvatarPicker molecules
      └─ Textarea atoms

聊天面板（微调，非新建）
  ├─ ChatPanel organism
  ├─ ChatHeader molecules
  ├─ MessageBubble molecules
  ├─ ChatInput molecules
  ├─ AgentSwitcher molecules
  └─ VirtualList atoms
```

---

## 9. 备注与风险

1. **数据对齐**: Wave 2 依赖后端稳定提供 `get_workers` / `get_worker_activity` WS 接口，建议先在 E2E 测试环境验证 API 响应体。

2. **状态管理**: WorkerCard 的"最近协作"字段可能需要实时更新（当有新消息时）。确认后端 WS 事件 `instance.activated` / `turn.completed` 的推送策略。

3. **头像管理**: WorkerCard 显示头像需要确保 `avatar` id 与实际图片 URL 的映射关系（见 instances-api.md）。

4. **性能**: 11 个员工卡片网格在 3-4 卡/行时，建议用 `VirtualList` 或分页优化长列表滚动。

5. **设计稿对齐**: Wave 3 聊天面板微调前，建议对照实际设计稿 40.png 逐像素验证气泡、间距、字号。

---

## 10. 后续迭代（Phase 4+）

- **搜索/筛选升级**: 按模板名/角色/MCP 全文搜索 WorkerCard
- **员工工作量图表**: 集成 `get_worker_activity` 接口，展示日 / 周 / 月活跃度折线图
- **聊天 markdown**: React-markdown 支持、代码块高亮
- **实时协作指示**: Agent 正在输入/思考的实时反馈

---

**审核人**: @team-lead  
**完成日期目标**: 2026-05-10
