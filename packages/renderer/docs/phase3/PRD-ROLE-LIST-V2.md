# PRD：角色列表 v2（数字员工面板）

**版本**：2.0  
**创建日期**：2026-04-28  
**目标日期**：2026-05-15  
**设计稿来源**：GPT 拆解设计稿  
**相关文档**：[workers-api.md](../../docs/frontend-api/workers-api.md)

---

## 1 需求背景

### 1.1 演进方向

v1 面向**模板管理**（角色模板 CRUD）。v2 转向**运行时员工视图**，用户不再看"有哪些可用的模板"，而是看"我的数字团队里现在有谁、谁在忙、谁闲着"。

这是从**设计层**到**运行时层**的转变。

### 1.2 概念更新

- **模板** → **数字员工**：同一模板可能在不同团队有多个实例，但用户视角他就是"一个人"
- **在线状态**：聚合该员工(模板)名下所有实例的 `status` 判定
  - `online` — 至少有 1 个 ACTIVE 实例
  - `idle` — 有实例但都不是 ACTIVE（全部 PENDING/PENDING_OFFLINE）
  - `offline` — 该模板名下无任何实例
- **最近协作**：取该员工所有实例的 turn_history 时间最新的一条
- **所在团队**：从该员工的实例关联反查，去重后列出

---

## 2 设计稿拆解

### 2.1 Header（顶部导航栏）

```
┌─────────────────────────────────────────────────────────────────┐
│ M + LEADER + 🟢 │ 搜索框"搜索成员或技能..." │ [+ 新建成员] │ 👥 │
└─────────────────────────────────────────────────────────────────┘
```

**左侧**：
- M logo + 文字 "LEADER"（或登录用户名）+ 在线状态绿点
- 功能：快速身份确认、登出入口（点击展开 dropdown）

**中间**：
- 搜索框，placeholder "搜索成员或技能..."
- 功能：过滤员工卡片（支持按员工名、角色、描述、MCP 工具名搜索）
- 搜索结果实时更新（无需回车）

**右侧**：
- `[+ 新建成员]` 主色按钮
- 功能：跳转到"角色模板"Tab（模板编辑走 `/api/role-templates` 通道，不在本窗口）
- 团队/设置图标（进入管理页面）

### 2.2 副标题区（筛选与统计）

```
┌─────────────────────────────────────┬────────────────────────────┐
│ "数字员工" 大标题                   │ 成员总数 6  在线 4  空闲 2  │
│ 描述："与 MTEAM 协作..."           │                            │
│ Tab：全部成员 | 角色模板 | 在线中 ● │                            │
└─────────────────────────────────────┴────────────────────────────┘
```

**左侧**：
- 大标题："数字员工"
- 描述文案："与 MTEAM 一起协作，让每个角色都充满价值"
- 三个 Tab（筛选）：
  - 「全部成员」— 展示所有员工（status = online/idle/offline）
  - 「角色模板」— 切换视图，展示模板库（走 `/api/role-templates` HTTP 通道管理）
  - 「● 在线中」— 仅显示 status = online 的员工

**右侧**：
- 统计数据（从 `get_workers_response.stats` 读）
  - "成员总数 X" — stats.total
  - "在线中 Y" — stats.online
  - "空闲中 Z" — stats.idle
- 不显示 offline 数（可在 tooltip 或详情页看）

### 2.3 卡片网格（3 列）

```
┌──────────────────────────────────────┐
│ [头像] 名称                          │
│ 角色中文名                           │
│ [🟢 在线]  或  [◯ 空闲]             │
├──────────────────────────────────────┤
│ 描述文案（1-2 行）                   │
│                                      │
├──────────────────────────────────────┤
│ [mteam] [mnemo] [项目 X]             │
│                                      │
├──────────────────────────────────────┤
│ 协作👥 [名字] M 💬 ⋯                 │
└──────────────────────────────────────┘
```

**每张卡片包含**：

| 区块 | 内容 | 数据来源 | 说明 |
|-----|------|--------|------|
| 头部 | 头像(3D质感) + 名字 + 角色中文名 | `worker.avatar` / `worker.name` / `worker.role` | 头像从 `/api/panel/avatars` 库获取 |
| 状态标签 | 在线/空闲/离线 + 彩色圆点 | `worker.status` | 在线=绿, 空闲=黄, 离线=灰 |
| 描述 | 岗位描述文案(截断3行) | `worker.description` | 超出省略号 |
| MCP 标签 | 该员工可用工具标签 | `worker.mcps[]` | 显示前3个，超出 "+N" |
| 底部操作栏 | 最近协作对象 + 消息按钮 + 更多菜单 | `worker.lastActivity` + instance query | 见下文 |

### 2.4 卡片底部操作栏

```
👥 [最近协作对象] M [💬] [⋯]
```

**从左到右**：

| 元素 | 含义 | 交互 | 数据源 |
|-----|------|------|--------|
| 👥 icon | 最近协作图标 | 静态 | — |
| [对象名字] | 该员工最近一次 turn 中协作的其他成员名 | 点击 → 高亮对应卡片或滚动到卡片位置 | 从 `worker.lastActivity?.summary` 解析 |
| M logo | MCP Team Hub logo | 静态品牌标记 | — |
| 💬 | 聊天按钮 | 点击 → 查询 `/api/role-instances?templateName=X` 找该员工的 ACTIVE 实例，取 teamId 后跳 teamCanvas；无 ACTIVE 则提示创建 | `worker.name` + HTTP instances API |
| ⋯ | 更多菜单（dropdown） | 查看详情 / 工作统计（打开 get_worker_activity） | — |

**"最近协作对象"的提取逻辑**：
- 读 `worker.lastActivity?.summary`（摘要）
- 从摘要中提取主体名字（需自然语言处理或正则）
- 无活动记录时显示"-"或隐藏
- **不包含编辑/删除**（那些走 `/api/role-templates` 或实例下线，不在此窗口）

### 2.5 Footer（底部鼓励与活跃度）

```
┌─────────────────────────────────────────────────────────────────┐
│ ✨ "团队协作让工作事半功倍..." │ 右端：[团队活跃度] →      │
└─────────────────────────────────────────────────────────────────┘
```

**左侧**：
- 鼓励文案（i18n 多语言）
- 示例：
  - "✨ 团队协作让工作事半功倍，看看大家最近都做了什么"
  - "✨ 数字团队越来越强大，现在已有 6 位成员"

**右侧**：
- [团队活跃度] 入口链接（→ 跳转到活跃度分析页 / 弹出折线图）

---

## 3 数据流与 API 对应

### 3.1 初始化流程

```
页面加载
  ↓
WS 发 { op: 'get_workers', requestId: 'r-w-1' }
  ↓
后端聚合员工数据（role_templates + role_instances + turn_history + teams）
  ↓
下行 get_workers_response
  {
    workers: WorkerView[],
    stats: { total, online, idle, offline }
  }
  ↓
前端渲染卡片网格 + 统计数据
```

### 3.2 关键 API 端点

| API | 方法 | 用途 | 返回 |
|-----|------|------|------|
| **workers（WS）** | `get_workers` | 拉全部员工列表 + 统计 | `WorkerView[]` + `stats` |
| **workers（WS 推送）** | `worker.status_changed` | 员工 status/instanceCount/teams 变化时推送 | 增量更新，不需轮询 |
| `/api/role-instances` | GET (HTTP) | 查询实例（聊天时用 `?templateName=X` 找 ACTIVE） | `RoleInstance[]` |
| `/api/panel/avatars` | GET (HTTP) | 获取头像库 | `AvatarRow[]` |
| `/api/role-templates` | GET/POST/PUT/DELETE (HTTP) | 模板 CRUD（在"角色模板"Tab） | `RoleTemplate[]` / 单条 |

### 3.3 WebSocket 协议详解

#### 3.3.1 初始化请求：`get_workers`

**上行**（前端 → 后端）：
```json
{ "op": "get_workers", "requestId": "r-w-1" }
```

**下行**（后端 → 前端）：
```json
{
  "type": "get_workers_response",
  "requestId": "r-w-1",
  "workers": [
    {
      "name": "frontend-dev",
      "role": "前端开发专家",
      "description": "负责 React/TypeScript 组件开发",
      "persona": "专业、务实、讲究细节",
      "avatar": "avatar-01",
      "mcps": ["mteam", "mnemo"],
      "status": "online",
      "instanceCount": 2,
      "teams": ["官网重构", "移动端适配"],
      "lastActivity": {
        "summary": "和 Leader 协作完成登录页样式",
        "at": "2026-04-27T10:32:15.420Z"
      }
    }
  ],
  "stats": { "total": 11, "online": 4, "idle": 2, "offline": 5 }
}
```

#### 3.3.2 增量推送：`worker.status_changed`

**下行**（后端主动推送）：
```json
{
  "type": "event",
  "id": "evt_abc123",
  "event": {
    "type": "worker.status_changed",
    "name": "frontend-dev",
    "status": "online",
    "instanceCount": 2,
    "teams": ["官网重构"],
    "ts": "2026-04-27T10:32:15.420Z"
  }
}
```

**触发条件**：
- 员工 `status` / `instanceCount` / `teams` 任一改变
- 由后端监听 `instance.created/activated/deleted` 等事件后重算全量员工，diff 有变化才 emit

**不会触发**：
- `lastActivity` 变化（不在 status 口径）
- 模板的 `role/description/avatar/mcps` 改变（听 `template.updated` 事件）

**前端处理策略**：
1. 页面加载 → 发 `get_workers` 拉全量快照
2. 之后只靠 `worker.status_changed` 增量更新本地缓存（按 `name` upsert）
3. **不需轮询**；如需更新 `lastActivity`，在关键节点（如 `turn.completed`）主动重拉 `get_workers`

### 3.4 搜索与筛选

**搜索**：
- 前端维护搜索关键词
- 针对 `worker.name` / `worker.role` / `worker.description` / `worker.mcps` 做子串匹配（大小写不敏感）
- 后端不做过滤，由前端本地过滤

**Tab 筛选**：
- 「全部成员」— 无过滤
- 「● 在线中」— `worker.status === 'online'`
- 「角色模板」— 切换至 v1 模板视图（走不同的组件/页面）

---

## 4 每个区域需要的组件

### 4.1 原子组件（atoms/）

| 组件 | 用途 | 备注 |
|-----|------|------|
| `StatusDot` | 在线/空闲/离线状态圆点 | 已有，支持 online/idle/offline/thinking/responding |
| `Avatar` | 员工头像 | 需补：支持自定义图片 + fallback |
| `Badge` | MCP 工具标签 | 可复用现有 Tag，或新建 Badge |
| `Icon` | 图标（👥/💬/⋯/✨等） | 需扩展：team/chat/more 等 |
| `Button` | 按钮（新建、搜索、更多等） | 已有 |

### 4.2 分子组件（molecules/）

| 组件 | 用途 | 新增/已有 |
|-----|------|---------|
| `SearchInput` | 搜索框（带 placeholder + 清除按钮） | 新增 |
| `WorkerCard` | 单个员工卡片（包含头像、状态、描述、MCP 标签、操作栏） | **新增** |
| `WorkerActivityBar` | 底部活跃度进度条/鼓励文案 | 新增 |
| `StatusBadge` | 状态标签（在线/空闲/离线） | 需补或复用 Tag |
| `MCPTagGroup` | MCP 标签组（最多 3 个 + "+N"） | 新增 |
| `CollaborationIndicator` | 最近协作对象条（👥 + 名字 + 操作按钮） | 新增 |

### 4.3 器官组件（organisms/）

| 组件 | 用途 | 新增/已有 |
|-----|------|---------|
| `WorkerListPanel` | 整个员工列表页面（含 Header + Filter + CardGrid + Footer） | **新增** |
| `WorkerCardGrid` | 卡片网格容器（3列响应式布局） | 新增 |
| `WorkerStatistics` | 右侧统计数据显示 | 新增 |
| `FilterTabBar` | 筛选 Tab（全部/在线/模板） | 新增 |

### 4.4 模板组件（templates/）

| 组件 | 用途 | 新增/已有 |
|-----|------|---------|
| `PanelWindow` | 窗口框架（已有，复用） | 已有 |

---

## 5 组件缺口分析

### 5.1 确定缺失的组件

根据设计稿和现有组件库对比：

| 优先级 | 组件 | 原因 | 依赖 |
|-------|------|------|-----|
| **P1** | `WorkerCard` | 核心展示单元 | Avatar/StatusDot/Badge/Icon |
| **P1** | `WorkerListPanel` | 整页容器 | WorkerCard/FilterTabBar/WorkerStatistics |
| **P1** | `SearchInput` | 搜索功能 | Icon |
| **P2** | `FilterTabBar` | Tab 筛选 | Button |
| **P2** | `MCPTagGroup` | MCP 标签展示 | Badge |
| **P2** | `CollaborationIndicator` | 最近协作显示 | Icon/Button |
| **P3** | `WorkerCardGrid` | 网格布局容器 | CSS Grid |
| **P3** | `WorkerStatistics` | 统计数据 | 纯文案 + CSS |
| **P3** | `WorkerActivityBar` | 底部鼓励文案 | 纯文案 + Link |

### 5.2 已有但需要扩展的组件

| 组件 | 现状 | 需要扩展 |
|-----|------|--------|
| `Avatar` | `AgentCard` 用的头像可能不够灵活 | 支持图片 ID + fallback + 大小参数 |
| `Icon` | 现有 close/send/chevron/settings/plus/check/team | 需要：chat/info/more/users |
| `Button` | 已有 | 可能需要 icon + text 组合、dropdown 变体 |
| `Tag` | 已有 | Badge 样式可能需要新增 |

### 5.3 后端接口确认（严格按 workers-api.md）

| 接口 | 状态 | 备注 |
|-----|------|------|
| `WS get_workers` | ✅ 已有 | 拉全部员工列表 + 统计，见 workers-api.md §2 |
| `WS worker.status_changed` | ✅ 已有 | 增量推送（员工状态/实例数/团队变化），见 workers-api.md §3 |
| `GET /api/panel/avatars` | ✅ 已有 | 头像库（映射 worker.avatar） |
| `GET /api/role-instances` | ✅ 已有 | 聊天按钮查询实例用（`?templateName=X` 找 ACTIVE） |
| `GET /api/role-templates` | ✅ 已有 | 「角色模板」Tab 展示 |
| `POST /api/role-templates` | ✅ 已有 | 「+ 新建成员」创建模板 |
| `PUT /api/role-templates/:name` | ✅ 已有 | 模板编辑 |
| `DELETE /api/role-templates/:name` | ✅ 已有 | 模板删除 |
| **WS 事件订阅** | ✅ 已有 | `template.updated/deleted` 触发重拉；`instance.*` 触发 worker.status_changed 推送 |
| **搜索** | ✅ 前端实现 | 本地过滤（`name/role/description/mcps`），无后端 API |

---

## 6 验收 Case

### Case 1：页面初始化

**前置**：系统已有 11 个内置员工模板 + 若干实例

**步骤**：
1. 打开角色列表窗口
2. 页面加载，WS 发 `get_workers` 请求
3. 显示员工卡片网格（3 列）
4. 右上角显示统计数据（总数/在线/空闲）

**验收**：
- [ ] 500ms 内发出 WS 请求
- [ ] 卡片正确渲染（无空白、无错误）
- [ ] 统计数据准确（total = 显示卡片数）
- [ ] 默认 Tab 是「全部成员」

### Case 2：搜索功能

**步骤**：
1. 在搜索框输入 "react"
2. 卡片列表实时过滤

**验收**：
- [ ] 支持按员工名、角色、描述、MCP 搜索
- [ ] 无搜索结果时显示"暂无匹配成员"
- [ ] 清除搜索词后恢复所有卡片

### Case 3：Tab 筛选

**步骤**：
1. 点击「● 在线中」Tab
2. 仅显示 status = online 的员工

**验收**：
- [ ] 卡片数量 ≤ stats.online
- [ ] 所有显示卡片都有绿色状态点
- [ ] 切换回「全部成员」恢复所有卡片

### Case 4：卡片交互 - 聊天按钮

**步骤**：
1. 鼠标悬停员工卡片
2. 点击 💬 消息按钮

**验收**：
- [ ] 前端调用 HTTP `GET /api/role-instances?templateName=frontend-dev` 查询该员工的实例
- [ ] 若存在 `ACTIVE` 实例，提取 `teamId`，跳转到 teamCanvas
- [ ] 若无 `ACTIVE` 实例，显示提示"该成员暂无活跃任务，请先创建实例"

### Case 5：卡片交互 - 更多菜单

**步骤**：
1. 点击卡片右下角 ⋯ 按钮
2. 出现 dropdown 菜单

**验收**：
- [ ] 包含：查看详情、工作统计（活跃度）、... 等选项
- [ ] **不包含编辑/删除**（那些在"角色模板"Tab 管理）

### Case 6：新建成员

**步骤**：
1. 点击 Header 的 [+ 新建成员] 按钮
2. 行为

**验收**：
- [ ] 切换到「角色模板」Tab（不是打开对话框）
- [ ] 在模板管理页创建新 RoleTemplate（走 `POST /api/role-templates`）
- [ ] 创建成功后回到「全部成员」Tab，新卡片出现

### Case 7：活跃度入口

**步骤**：
1. 看到底部鼓励文案 + [团队活跃度] 链接
2. 点击链接

**验收**：
- [ ] 调用 WS `get_worker_activity` with `range='day'`（无 workerName = 全员）
- [ ] 打开活跃度分析面板或弹窗
- [ ] 展示折线图（按天聚合，显示 turns + toolCalls）

### Case 8：状态同步（增量推送）

**前置**：窗口已开，后台新创建一个员工的 ACTIVE 实例

**步骤**：
1. 后端发送 `worker.status_changed` 推送事件
2. 前端接收并更新

**验收**：
- [ ] 本地缓存按 `name` upsert，`status/instanceCount/teams` 字段更新
- [ ] 对应卡片视觉变化（如绿色在线点）
- [ ] 统计数据自动更新
- [ ] **无需轮询或手动刷新**

### Case 9：模板编辑（角色模板 Tab）

**步骤**：
1. 切换到「角色模板」Tab
2. 编辑或删除模板

**验收**：
- [ ] 后端 emit `template.updated` 或 `template.deleted` 事件
- [ ] 前端监听后回到「全部成员」Tab
- [ ] 卡片列表自动刷新（重新拉 `get_workers`）
- [ ] 删除时卡片消失

---

## 7 界面交互细节

### 7.1 响应式布局

- **宽屏** (≥1400px)：4 列网格
- **中屏** (1200-1399px)：3 列网格（设计稿基准）
- **小屏** (<1200px)：2 列网格
- **极小屏** (<768px)：1 列网格（移动 fallback）

### 7.2 加载态

- **骨架屏**：显示 6 个灰色占位符卡片，动画加载中
- **加载完成**：骨架屏消失，真实卡片显示
- **加载失败**：显示错误提示 + 重试按钮

### 7.3 空态

- **无员工时**：显示插图 + "暂无成员，点击新建" + [新建按钮]
- **无搜索结果**：显示"未找到匹配的成员"

### 7.4 动画

- **卡片悬停**：微妙阴影提升、鼠标指针变手
- **Tab 切换**：内容淡出/淡入
- **进度条**：底部统计区域的活跃度百分比柱状图

### 7.5 可访问性

- Tab 键导航卡片和按钮
- 屏幕阅读器支持（ARIA labels）
- 状态颜色不是唯一信号（配合文字 + icon）

---

## 8 国际化（i18n）

以下文案需要 i18n：

| 中文 | 建议 key | 用途 |
|-----|---------|------|
| 数字员工 | `page.workers.title` | 页面大标题 |
| 与 MTEAM 一起协作... | `page.workers.desc` | 描述文案 |
| 搜索成员或技能... | `page.workers.search_placeholder` | 搜索框 placeholder |
| 全部成员 | `page.workers.tab_all` | Tab 标签 |
| 角色模板 | `page.workers.tab_templates` | Tab 标签 |
| 在线中 | `page.workers.tab_online` | Tab 标签 |
| 新建成员 | `page.workers.btn_new` | 按钮文案 |
| 在线 / 空闲 / 离线 | `worker.status.*` | 状态标签 |
| 暂无成员 | `page.workers.empty` | 空态提示 |
| 团队活跃度 | `page.workers.activity_link` | 底部链接 |

---

## 9 技术栈与性能

### 9.1 技术栈

- **前端框架**：React 18
- **状态管理**：本地 useState + WS 推送
- **通信**：WebSocket (workers-api WS 协议)
- **样式**：CSS-in-JS / CSS Modules（按项目规范）
- **组件库**：mcp-team-hub renderer 组件库（atoms/molecules/organisms）

### 9.2 性能指标

- **首屏加载**：< 2s（包括 WS 请求）
- **网格渲染**：≤ 100 个卡片时 < 500ms
- **搜索响应**：< 50ms（前端本地过滤）
- **事件同步**：收到 WS 事件后 < 1s 更新 UI

### 9.3 缓存策略

- 员工列表缓存在内存中，订阅 `instance.*` 事件后重新 fetch
- 头像库（avatars）请求后缓存
- WS 连接复用（不重复创建）

---

## 10 风险与缓解

| 风险 | 影响 | 缓解方案 |
|-----|------|--------|
| WS 连接断开 | 无法接收 worker.status_changed 推送 | 自动重连；连接断 >30s 显示"连接中..." |
| 增量推送丢失（重连时） | 本地缓存与后端不一致 | 重连后主动拉 `get_workers` 全量同步 |
| 员工数过多（>1000） | 渲染性能下降 | 虚拟滚动（`react-window` 等）+ 分页 |
| 头像加载缓慢 | 页面显示卡顿 | 默认 fallback 头像 + 懒加载图片 |
| 搜索关键词为空 | 无后端支持 | 前端本地过滤全部，默认展示所有卡片 |
| lastActivity 不实时 | 最近工作显示延迟 | 文档明确说 lastActivity 不在推送口径，仅在关键节点手动重拉 `get_workers` |

---

## 11 后续迭代方向（Phase 4+）

- [ ] 员工详情页（单员工的工作历史、技能详细信息）
- [ ] 员工排序定制（拖拽排序、保存布局）
- [ ] 批量操作（选中多个 → 批量下线）
- [ ] 实时协作指示器（正在打字、正在思考）
- [ ] 员工对比视图（A vs B 能力对比）
- [ ] 集成度量指标（工作效率、错误率等）

---

## 附录 A：设计稿全景图

```
┌────────────────────────────────────────────────────────────────┐
│ 【Header】                                                     │
│ M LEADER 🟢 │ 搜索框 │ [+ 新建成员] │ 👥                     │
├────────────────────────────────────────────────────────────────┤
│ 【副标题】                    【统计】                         │
│ 数字员工        [全部]|[模板]|[在线●]  成员 6 在线 4 空闲 2  │
│ 与 MTEAM 协作...                                              │
├────────────────────────────────────────────────────────────────┤
│ 【卡片网格 3 列】                                              │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│ │ [头像]   │  │ [头像]   │  │ [头像]   │                      │
│ │ 名称     │  │ 名称     │  │ 名称     │                      │
│ │ 角色     │  │ 角色     │  │ 角色     │                      │
│ │ [●在线]  │  │ [◯空闲]  │  │ [灰离线] │                      │
│ │ 描述...  │  │ 描述...  │  │ 描述...  │                      │
│ │ [mteam]  │  │ [mnemo]  │  │ [proj]   │                      │
│ │ 协作👥   │  │ 协作👥   │  │ 协作👥   │                      │
│ │ M 💬 ⋯   │  │ M 💬 ⋯   │  │ M 💬 ⋯   │                      │
│ └──────────┘  └──────────┘  └──────────┘                      │
│ ... （更多卡片）                                               │
├────────────────────────────────────────────────────────────────┤
│ 【Footer】                                                     │
│ ✨ 团队协作让工作事半功倍...          [团队活跃度] →         │
└────────────────────────────────────────────────────────────────┘
```

---

## 附录 B：数据结构参考

### WorkerView（从后端 get_workers_response 返回）

```typescript
interface WorkerView {
  name: string;                          // 员工身份锚点 = role_templates.name
  role: string;                          // 岗位名
  description: string | null;            // 岗位描述
  persona: string | null;                // 人设/tone
  avatar: string | null;                 // 头像 id（对应 /api/panel/avatars 返回的 id）
  mcps: string[];                        // 可用工具列表，例 ["mteam", "mnemo"]
  status: 'online' | 'idle' | 'offline'; // 聚合实例状态
  instanceCount: number;                 // 实例数
  teams: string[];                       // 所在团队列表
  lastActivity: {                        // 最近工作记录
    summary: string;                     // 摘要
    at: string;                          // ISO 时间
  } | null;
}
```

### WorkerStats（统计数据）

```typescript
interface WorkerStats {
  total: number;                // 员工总数
  online: number;               // 在线
  idle: number;                 // 空闲
  offline: number;              // 离线
}
```

---

## 附录 C：API 调用示例

### 初始化请求

```javascript
// 前端发送
websocket.send(JSON.stringify({
  op: 'get_workers',
  requestId: 'r-w-' + Date.now()
}));

// 后端响应
{
  type: 'get_workers_response',
  requestId: 'r-w-1234567890000',
  workers: [
    // WorkerView[] 数组
  ],
  stats: {
    total: 11,
    online: 4,
    idle: 2,
    offline: 5
  }
}
```

### 事件订阅

```javascript
// 订阅实例状态变化
websocket.subscribe({
  scope: 'global',
  event: 'instance.created'   // 或 instance.activated / instance.deleted
});

// 监听事件，重新拉取
websocket.on('instance.created', () => {
  websocket.send(JSON.stringify({
    op: 'get_workers',
    requestId: 'r-w-' + Date.now()
  }));
});
```

---

**版本历史**：
- v2.0 (2026-04-28)：从模板管理 → 运行时员工视图，完整设计稿拆解
- v1.0 (2026-04-27)：模板管理功能 PRD
