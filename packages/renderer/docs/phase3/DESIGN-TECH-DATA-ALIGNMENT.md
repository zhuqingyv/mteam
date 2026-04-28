# 三维对齐表：视觉稿 × 技术 × 数据

**目的**: 将 GPT 设计稿的每个视觉区域映射到技术实现和数据来源

**三个维度**:
1. **设计稿** (PRD-ROLE-LIST.md §4) — 长什么样、有哪些区域
2. **技术实现** (COMPONENT-GAP-V2.md) — 用什么组件、怎么渲染
3. **数据来源** (workers-api.md / templates-and-mcp.md) — 数据从哪来、字段叫什么

---

## 1. 角色列表窗口整体布局

### 设计稿（PRD §4.1）
```
┌─────────────────────────────────────────────┐
│ 角色列表                              [×]    │  ← 标题栏
├─────────────────────────────────────────────┤
│ [+ 新建模板]  [搜索框]  [筛选]             │  ← A: TopBar
│                                           │
│ ┌─────────────────────────────────────┐   │
│ │ [统计卡片: 总数/在线/空闲/离线]     │   │  ← B: StatsBar
│ └─────────────────────────────────────┘   │
│                                           │
│ ┌─ 卡片 ──┬─ 卡片 ──┬─ 卡片 ────┐        │  ← C: WorkerCard Grid
│ │ ...     │ ...     │ ...       │        │
│ │ ...     │ ...     │ ...       │        │
│ └─────────┴─────────┴───────────┘        │
│                                           │
│ 暂无模板 [+ 新建模板]  （空态）          │  ← D: EmptyState
│                                           │
└─────────────────────────────────────────┘
```

---

## A. TopBar 区域

### 设计稿
- [+ 新建模板] 按钮
- [搜索框] 输入框
- [筛选] 三个 Tab（全部 / 角色模板 / 在线中）

### 技术实现
| 子区域 | 组件 | Props | 备注 |
|--------|------|-------|------|
| [+ 新建模板] | atoms/Button | variant='primary', onClick | 现有，直用 |
| [搜索框] | atoms/Input | placeholder='搜索...', onChange | 现有，直用 |
| [筛选] | **molecules/TabFilter** | tabs[], activeTab, onChange | **新建** |

### 数据来源
| 子区域 | API | 字段 | 格式 |
|--------|-----|------|------|
| [+ 新建模板] | 无 | 无 | UI 交互 |
| [搜索框] | 前端本地过滤 | workers 数组搜索 query | 客户端 filter |
| [筛选] | WS get_workers 响应 + 本地计算 | stats.total / .online / .idle / .offline | 统计数字 |

### 完整流程
```
用户输入搜索词或切换 Tab
  ↓
前端对 workers[] 数组过滤（按 name/role/description + status）
  ↓
重新渲染 WorkerCard 网格
  ↓
无需后端请求（纯前端过滤）
```

---

## B. StatsBar 区域

### 设计稿
```
┌──────────────────────────────────────┐
│ 成员总数: 11    在线中: 4    空闲中: 2 │
└──────────────────────────────────────┘
```

### 技术实现
| 元素 | 组件 | Props | 备注 |
|------|------|-------|------|
| 整体容器 | **molecules/StatsBar** | total, online, idle, offline, onClick | **新建** |
| 单个统计 | 内部组件 | 数字 + 标签文案 | StatBar 内部实现 |

### 数据来源
| 字段 | 来源 | API 响应 |
|------|------|---------|
| total | workers-api `get_workers_response.stats.total` | 11 |
| online | workers-api `get_workers_response.stats.online` | 4 |
| idle | workers-api `get_workers_response.stats.idle` | 2 |
| offline | 计算 (total - online - idle) | 5 |

### 完整流程
```
页面 mount 或订阅事件触发
  ↓
WS 发送 {op: 'get_workers', requestId}
  ↓
后端返回 {
  workers: [...],
  stats: { total: 11, online: 4, idle: 2, offline: 5 }
}
  ↓
StatsBar 组件接收 stats 数据，渲染四个卡片
```

---

## C. WorkerCard Grid 区域

### 设计稿（PRD §4.2）
```
┌─────────────────────────────────┐
│ ┌─────┐  frontend-engineer      │
│ │ [头] │  Role: engineer         │
│ │ 像 │                           │
│ └─────┘  Frontend developer ... │
│         (3 行截断)             │
│                                 │
│ MCP: git, github, +1            │
│ Updated: 2026-04-27 10:30       │
│                                 │
│ [编辑] [创建实例] [删除]        │
└─────────────────────────────────┘
```

### 技术实现

| 设计元素 | 组件 | Props | 数据来源 |
|---------|------|-------|---------|
| **头像** | Avatar molecule 或 Image + CircleFrame | avatar id | worker.avatar |
| **名称（粗体）** | Text atom | variant='title', text={worker.name} | worker.name |
| **Role Tag** | Tag atom | label={worker.role} | worker.role |
| **描述（3 行截断）** | Text atom | variant='body', maxLines=3, title={full} | worker.description |
| **MCP 标签** | Tag atom 循环 | map(mcps.slice(0,3)) + "+N" 显示 | worker.mcps.map(m => m.name) |
| **时间戳** | Text atom | variant='caption', color='secondary' | worker.lastActivity.at 或 updatedAt |
| **[编辑] 按钮** | Button atom | variant='secondary', onEdit | worker.name 作参数 |
| **[创建实例] 按钮** | Button atom | variant='secondary', onCreate | worker.name 作参数 |
| **[删除] 按钮** | Button atom | variant='secondary', danger, onDelete | worker.name 作参数 |

### 新建组件：WorkerCard (organisms)

**Props 设计** (对标 workers-api WorkerView):
```tsx
interface WorkerCardProps {
  worker: {
    name: string;                    // ← worker.name
    role: string;                    // ← worker.role
    description: string | null;      // ← worker.description
    avatar: string | null;           // ← worker.avatar (avatar id)
    mcps: string[];                  // ← worker.mcps[].name
    status: 'online' | 'idle' | 'offline';  // ← worker.status
    instanceCount: number;           // ← worker.instanceCount
    teams: string[];                 // ← worker.teams
    lastActivity?: {
      summary: string;               // ← worker.lastActivity.summary（暂时不显示）
      at: string;                    // ← worker.lastActivity.at (ISO 时间)
    } | null;
  };
  // 操作回调
  onEdit?: (name: string) => void;
  onCreate?: (name: string) => void;  // 创建实例
  onDelete?: (name: string) => void;
  onMessage?: (name: string) => void; // 消息按钮（待确认）
}
```

### 数据来源

| Props 字段 | workers-api 路径 | 示例值 |
|-----------|-----------------|--------|
| worker.name | WorkerView.name | "frontend-dev" |
| worker.role | WorkerView.role | "前端开发专家" |
| worker.description | WorkerView.description | "负责 React/TypeScript..." |
| worker.avatar | WorkerView.avatar | "avatar-01" |
| worker.mcps | WorkerView.mcps[].name | ["mteam", "git", "github"] |
| worker.status | WorkerView.status | "online" |
| worker.instanceCount | WorkerView.instanceCount | 2 |
| worker.teams | WorkerView.teams | ["官网重构", "移动端"] |
| worker.lastActivity.at | WorkerView.lastActivity.at | "2026-04-27T10:32:15.420Z" |

### 完整流程
```
页面 mount
  ↓
WS 发送 {op: 'get_workers'}
  ↓
后端返回 workers[] = [
  {
    name: "frontend-dev",
    role: "前端开发专家",
    description: "...",
    avatar: "avatar-01",
    mcps: ["mteam", "git"],
    status: "online",
    instanceCount: 2,
    teams: ["官网重构"],
    lastActivity: { summary: "...", at: "2026-04-27T10:32:15.420Z" }
  },
  ...
]
  ↓
WorkerList organism 循环渲染 WorkerCard
  ↓
每张 WorkerCard 接收 worker 对象 + 回调函数
  ↓
用户点击 [编辑] → onEdit("frontend-dev") 被触发 → 打开 TemplateEditor
```

### 网格布局
- Tailwind CSS: `grid grid-cols-3 gap-4`（3 列网格，间距 1rem）
- 响应式：`md:grid-cols-2 lg:grid-cols-4`（可调）
- WorkerCard 整体使用 `molecules/Surface` 作底座

---

## D. 模态对话框区域

### 创建/编辑表单（PRD §4.3）

#### 设计稿
```
┌─────────────────────────────────────┐
│ 新建模板                             │
├─────────────────────────────────────┤
│ 模板名 *               [  frontend ]  │
│ 角色 *                 [  engineer ]  │
│ 描述                   [  ......... ]  │
│ 系统提示词             [  ......... ]  │
│ 头像 (可选) [ 🖼️ avatar-03 ] [选择]    │
│ 可用 MCP 工具  ☑git  ☐github ...    │
│ [保存]  [取消]                       │
└─────────────────────────────────────┘
```

#### 技术实现
| 设计元素 | 组件 | 数据来源 |
|---------|------|---------|
| 对话框 | atoms/Modal | 业务层控制 show/hide |
| 模板名输入 | atoms/Input | templates-and-mcp.md: RoleTemplate.name |
| 角色输入 | atoms/Input | RoleTemplate.role |
| 描述文本 | atoms/Textarea | RoleTemplate.description |
| 提示词文本 | atoms/Textarea | RoleTemplate.persona |
| 头像预览 + 选择 | molecules/AvatarPicker | avatars-api.md: GET /api/panel/avatars |
| MCP 多选 | atoms/Checkbox 循环 或 FormField variant='checkbox' | `/api/mcp-store`: McpConfig[] |
| [保存][取消] | atoms/Button | Modal action |

#### 数据来源

**创建模式**:
```
用户点 [+ 新建模板]
  ↓
Modal 打开，Form 为空
  ↓
自动调 GET /api/panel/avatars/random
  ↓
返回 { avatar: "avatar-05" }
  ↓
头像区预览 avatar-05
  ↓
用户填表，POST /api/role-templates {
  name, role, description, persona,
  avatar: "avatar-05",
  availableMcps: [{ name: "mteam", surface: [...], search: "*" }, ...]
}
```

**编辑模式**:
```
用户点卡片 [编辑]
  ↓
Modal 打开，Form 预填原有值
  ↓
不调 /avatars/random，显示原有 avatar
  ↓
用户修改，PUT /api/role-templates/:name { 增量更新 }
```

#### 关键字段映射

| 表单字段 | templates-and-mcp API 字段 | 约束 |
|---------|---------------------------|------|
| 模板名 | RoleTemplate.name | 1-64 字符，创建时可填，编辑时禁用 |
| 角色 | RoleTemplate.role | 1-32 字符 |
| 描述 | RoleTemplate.description | ≤1024 字符 |
| 系统提示词 | RoleTemplate.persona | ≤8192 字符 |
| 头像 | RoleTemplate.avatar | 头像 id（avatar-NN 或 custom-xxx） |
| MCP 工具 | RoleTemplate.availableMcps | McpToolVisibility[] 多选 |

---

## E. 头像选择面板（PRD §4.4）

### 设计稿
```
┌──────────────────────── 选择头像 ────────┐
│ [ 🎲 随机 ]                              │
├─────────────────────────────────────────┤
│ ── 内置 ──                               │
│ [01] [02] [03] ... [20]                │
│                                         │
│ ── 自定义 ──                             │
│ [custom-abc] [custom-def] ...          │
│                                         │
│ 当前选中：avatar-03 ✓                  │
│                                         │
│ [关闭]                                   │
└─────────────────────────────────────────┘
```

### 技术实现
| 设计元素 | 组件 | Props |
|---------|------|-------|
| 面板容器 | atoms/Modal | title="选择头像" |
| [🎲 随机] | atoms/Button | onClick={getRandomAvatar} |
| 头像网格 | CSS grid 或 AvatarGrid molecule | grid-cols-5 gap-2 |
| 单个头像 | Image + click handler | 可点击切换选中 |
| 当前高亮 | CSS :selected or border | avatar id 比对 |
| [关闭] | atoms/Button | onClose |

### 数据来源

| 操作 | API | 响应 |
|------|-----|------|
| 打开面板 | GET /api/panel/avatars | 返回 AvatarRow[]（内置 + 自定义）|
| 点 🎲 随机 | GET /api/panel/avatars/random | 返回 { avatar: "avatar-05" } |
| 点某个头像 | 本地 callback | avatar id 回填 Form |
| 关闭面板 | 本地 Modal.onClose | 不保存 |

#### 现有组件
- **molecules/AvatarPicker** 已存在，支持选择 + 随机 + 当前高亮

---

## 2. 聊天面板布局（DESIGN-REFERENCE 40.png）

### 设计稿（聊天窗口）
```
┌────────────────────────────┐
│ [M] M-TEAM              [×] │  ← ChatHeader (Logo + 标题)
├────────────────────────────┤
│                            │
│ [M] Claude                 │  ← 左气泡 (Agent)
│      你好！...  20:48      │     MessageBubble variant='agent'
│                            │
│             帮我总结...     │  ← 右气泡 (User)
│                   20:49    │     MessageBubble variant='user'
│                            │
│ [M] Claude                 │  ← 右气泡 + thinking 态
│      · · ·                │     MessageBubble variant='thinking'
│                            │
├────────────────────────────┤
│ [Claude] [Codex] [+]       │  ← AgentSwitcher
│ ┌─────────────────────┐    │
│ │ 发送消息...    [➤] │    │  ← ChatInput
│ └─────────────────────┘    │
└────────────────────────────┘
```

### 技术实现

| 设计元素 | 组件 | 数据来源 |
|---------|------|---------|
| **顶栏** | molecules/ChatHeader | — |
| · Logo + 标题 | Logo atom + Text atom | 静态 |
| · 关闭按钮 | Button atom | Electron IPC |
| **消息列表** | atoms/VirtualList | — |
| · Agent 气泡 | molecules/MessageBubble | turn-events.md: turn.block_updated |
| · · 头像 | molecules/Avatar | agent Logo |
| · · agent 名 | Text atom | Turn 元数据 |
| · · 时间戳 | Text atom | turn.at (ISO) |
| · User 气泡 | molecules/MessageBubble | turn.block_updated (user block) |
| · · 时间戳 | Text atom | turn.at |
| · Thinking 态 | molecules/MessageBubble variant='thinking' | turn.status = 'thinking' |
| · · 三点动画 | atoms/TypingDots | CSS keyframes |
| **Agent Tab Bar** | molecules/AgentSwitcher | — |
| · Tab chip | Button atom variant='chip' | agents[] 数组 |
| · [+] 按钮 | Button atom | 添加 agent 回调 |
| **输入框** | molecules/ChatInput | — |
| · 文本区 | atoms/Textarea | 用户输入 |
| · [➤] 发送 | Button atom variant='primary' | 发送回调 |

### 数据来源

| 元素 | API | 来源文档 |
|------|-----|---------|
| 消息列表 | WS turn.* 事件 | turn-events.md § 消息流 |
| Agent 列表 | primary-agent-api.md 或 agents[] config | primary-agent-api.md |
| 时间戳 | turn.at (ISO 8601) | turn-events.md |

#### 完整流程
```
用户在 ChatPanel 输入消息，点发送
  ↓
前端 WS 发送 {op: 'prompt', text: '用户输入', instanceId}
  ↓
后端处理，Agent 开始思考
  ↓
前端收 turn.started 事件，创建消息框
  ↓
前端收 turn.block_updated (type='thinking')
  → 显示 MessageBubble variant='thinking' + TypingDots
  ↓
Agent 返回内容
  ↓
前端收 turn.block_updated (type='text')
  → 更新 MessageBubble 显示内容 + 时间戳
  ↓
前端收 turn.completed 事件
  → 消息完成态，可进行下一轮对话
```

---

## 3. 完整对标总表

### 三维核心清单

| 功能区域 | 设计元素 | 技术组件 | 数据来源 | 状态 |
|--------|--------|--------|--------|------|
| **TopBar** | 按钮+搜索+筛选 | Button+Input+**TabFilter** | 本地过滤 | 🟡 新建 |
| **StatsBar** | 4 张统计卡 | **StatsBar** | get_workers.stats | 🟡 新建 |
| **WorkerCard** | 头像/名/角/状态/MCP/时间/操作 | **WorkerCard** | get_workers.workers[] | 🟡 新建 |
| **TemplateForm** | 输入框+下拉+多选 | Modal+Input+Checkbox | templates-and-mcp.md | ✓ 现有+微调 |
| **AvatarPicker** | 网格+随机+高亮 | **AvatarPicker** (现有 molecules) | avatars-api.md | ✓ 直用 |
| **ChatHeader** | Logo+标题 | ChatHeader (现有) | 静态 | ✓ 直用 |
| **MessageBubble** | 气泡+头像+时间 | MessageBubble (现有) | turn-events.md | ✓ 直用 |
| **ChatInput** | 文本+发送 | ChatInput (现有) | 用户交互 | ✓ 直用 |

### 新建 vs 现有统计

| 组件 | 新建/升级 | 工期 | 依赖 |
|------|---------|------|------|
| TabFilter | 新建 molecules | 1 天 | 无 |
| StatsBar | 新建 molecules | 1 天 | 无 |
| WorkerCard | 新建 organisms | 1.5 天 | TabFilter + StatsBar |
| WorkerList | 升级 organisms | 1 天 | WorkerCard |
| TemplateEditor | 微调 organisms | 0.5 天 | 头像随机逻辑 |
| ChatPanel | 微调 organisms | 0.5 天 | 布局贴合 |

---

## 4. 技术风险与澄清项

### 🔴 待 PM 确认

1. **时间戳字段** — Updated 时间来自 lastActivity.at 还是后端补加 updatedAt？
2. **消息按钮** — 组件内调 instances-api 还是业务层处理？
3. **头像随机** — TemplateEditor 创建/编辑分支改造可行吗？
4. **Tab 含义** — "角色模板" Tab 的过滤逻辑是什么？

### 🟡 待后端确认

1. workers-api 是否需要补加 RoleTemplate.updatedAt 字段（时间戳来源）
2. get_workers_response 是否能在初次请求时返回聚合的 stats
3. 实时事件 instance.* / team.* 触发时是否需要前端重拉 get_workers

### ✅ 技术已验证

- ✓ WorkerCard 的所有 props 都能从 WorkerView 映射
- ✓ 现有 15+ 组件完全覆盖聊天 UI 需求
- ✓ 头像选择、表单验证、事件推送都有现成能力
- ✓ 三 Wave 工期估算保守（包含缓冲）

---

## 5. 交付检查表

- [ ] 设计稿 vs 技术组件一一对应
- [ ] 每个组件的 props 都能从 API 文档提取
- [ ] 新建 3 个 molecules / 1 个 organisms 的设计文档完整
- [ ] 4 个 PM 待确认问题已列清
- [ ] 3 个后端待确认问题已列清
- [ ] WorkerCard 在 playground 注册、可调 props 演示
- [ ] TabFilter / StatsBar 在 playground 注册、可调 props 演示

