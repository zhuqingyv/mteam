# ask_user 弹窗交互技术方案（最终版）

## 概述

`ask_user` 是一个 MCP tool，允许任何 Agent（leader 或成员）向用户发起桌面弹窗交互。采用**同步阻塞模式**：单个 MCP tool 调用，HTTP 请求阻塞直到用户回答或超时，默认 2 分钟。

**核心决策：**
- **同步模式**，不是异步轮询。一个 tool 搞定，不需要 `check_response`
- **堆叠不排队**：多个弹窗同时显示，像卡片堆叠（每张 y+20 x+10 偏移），最多 3 张可见，超出排队
- **通用边框模块**：流动边框 + 触手从 `lib/liquid-border.ts` + `lib/tentacle-renderer.ts` 复用
- **弹窗视觉**：流动边框颜色 = 发起者成员颜色，触手连到发起者终端窗口，跟随聚焦窗口弹出，显示倒计时

---

## 1. MCP Tool 定义

**位置**：`packages/mcp-server/src/hub.ts`

```typescript
{
  name: "ask_user",
  description: "向用户发起交互式确认/选择/输入弹窗。弹窗会直接出现在用户桌面上，用户可以选择答案或等待超时。超时默认 2 分钟，自动返回拒绝。",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["confirm", "single_choice", "multi_choice", "input"],
        description: "交互类型：confirm=是/否, single_choice=单选, multi_choice=多选, input=纯输入"
      },
      title: { type: "string", description: "弹窗标题（简短）" },
      question: { type: "string", description: "详细问题描述" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "选项列表（仅 single_choice/multi_choice 需要）"
      },
      timeout_ms: {
        type: "number",
        description: "超时毫秒数，默认 120000（2分钟）"
      }
    },
    required: ["type", "title", "question"]
  }
}
```

**权限**：所有人（leader + 成员）均可调用。

### 返回值

```typescript
// 用户回答了
{ answered: true, choice: "A" }                // confirm / single_choice
{ answered: true, choice: ["A", "C"] }         // multi_choice
{ answered: true, input: "some text" }         // input

// 超时
{ answered: false, reason: "timeout" }

// 用户取消（关闭窗口）
{ answered: false, reason: "cancelled" }
```

### 参数校验

- `type` 为 `single_choice` / `multi_choice` 时，`options` 必须是非空数组，否则返回错误
- `type` 为 `confirm` / `input` 时，`options` 可选忽略
- `timeout_ms` 缺省 120000（2 分钟）

---

## 2. HTTP API

**端点**：`POST /api/ask-user`

**位置**：`packages/panel/src/main/panel-api.ts`

**请求体**：
```json
{
  "member_name": "adian",
  "type": "confirm",
  "title": "确认部署",
  "question": "是否部署到 production？",
  "options": ["staging", "production"],
  "timeout_ms": 120000
}
```

**行为**：同步阻塞。HTTP 连接挂起直到用户回答或超时。Hub 端设置 HTTP 超时 = `timeout_ms + 5000`（5 秒余量）。

**响应**：与 MCP tool 返回值相同（`{ answered, choice?, input?, reason? }`）。

---

## 3. 弹窗架构

### 3.1 数据流

```
Agent (PTY)
  │
  │ MCP tool: ask_user(...)
  ↓
Hub (hub.ts handler)
  │
  │ callPanel("POST", "/api/ask-user", ..., timeout_ms + 5000)
  ↓
Panel HTTP API (panel-api.ts)
  │
  │ createAskUserRequest(params) → Promise<AskUserResponse>  ← 阻塞
  ↓
ask-user-window.ts
  │
  │ new BrowserWindow (frameless, transparent, alwaysOnTop)
  │ load ask-user.html
  │ send('show-ask-user', request)
  ↓
Renderer (ask-user.html + React)
  │
  │ 用户操作 → ipcRenderer.send('ask-user-response', id, response)
  │                        或 'ask-user-cancel'
  ↓
ask-user-window.ts
  │
  │ resolveRequest(pending, response) → Promise resolves
  ↓
Panel HTTP API
  │
  │ jsonResponse(res, 200, response)
  ↓
Hub → MCP → Agent 拿到结果
```

### 3.2 核心模块

| 文件 | 职责 |
|------|------|
| `mcp-server/src/hub.ts` | ask_user tool 定义 + handler，参数校验，推断 member_name |
| `panel/src/main/panel-api.ts` | HTTP 路由 `POST /api/ask-user`，调用 createAskUserRequest |
| `panel/src/main/ask-user-window.ts` | BrowserWindow 生命周期、堆叠管理、超时控制、IPC |
| `panel/src/preload/ask-user-preload.ts` | contextBridge 暴露安全 API |
| `panel/src/renderer/ask-user.html` + React | 弹窗 UI 渲染 |

### 3.3 BrowserWindow 配置

```typescript
{
  width: 420, height: 360,
  resizable: false, frame: false,
  transparent: true, backgroundColor: '#00000000',
  hasShadow: true, alwaysOnTop: true,
  skipTaskbar: true, show: false,   // ready-to-show 后再 show
  webPreferences: {
    preload: 'ask-user-preload.js',
    sandbox: false, nodeIntegration: false, contextIsolation: true,
  }
}
```

---

## 4. 堆叠机制

**规则**：最多 3 张弹窗同时可见，超出排队等待。

### 位置计算

- 以当前聚焦窗口为锚点，居中弹出
- 每张卡片在前一张基础上偏移 `x+10, y+20`，形成堆叠视觉
- 边界 clamp 到屏幕工作区内

```
┌──────────┐
│  Card 1  │
│ ┌──────────┐
│ │  Card 2  │
│ │ ┌──────────┐
└─│ │  Card 3  │
  └─│          │
    └──────────┘
```

### 排队逻辑

```
visibleStack (max 3)    waitingQueue (FIFO)
┌───┬───┬───┐           ┌───┬───┬───┐
│ 1 │ 2 │ 3 │           │ 4 │ 5 │ 6 │
└───┴───┴───┘           └───┴───┴───┘
                              │
     Card 1 resolved ─────────┘
     → Card 4 moves to visible
```

**实现位置**：`ask-user-window.ts` 中的 `visibleStack` / `waitingQueue` + `resolveRequest` 自动推进。

---

## 5. 通用边框模块

流动边框和触手从原有 terminal-border / panel-border / overlay 提取为通用模块：

| 模块 | 路径 | 用途 |
|------|------|------|
| `liquid-border.ts` | `panel/src/renderer/lib/liquid-border.ts` | WebGL 流动边框渲染 |
| `tentacle-renderer.ts` | `panel/src/renderer/lib/tentacle-renderer.ts` | Bezier 触手渲染 |

弹窗直接复用这两个模块：
- 流动边框颜色 = 发起者的成员颜色
- 触手从弹窗窗口连接到发起者的终端窗口

---

## 6. 视觉设计

### 弹窗外观

```
┌─ 流动边框（发起者颜色）────────┐
│                                │
│  [标题]                 ⏱ 1:45 │
│                                │
│  问题描述文本                  │
│                                │
│  ◉ 选项 A                     │
│  ◯ 选项 B                     │
│  ◯ 选项 C                     │
│                                │
│  [ 确认 ]    [ 取消 ]          │
│                                │
└────────────────────────────────┘
       ╲
        ╲  ← 触手（Bezier 曲线）
         ╲
    ┌─ 发起者终端 ─┐
```

### 关键视觉元素

- **流动边框**：颜色跟随发起者成员颜色，使用 `liquid-border.ts` 渲染
- **触手连接**：从弹窗连到发起者终端窗口，使用 `tentacle-renderer.ts` 渲染
- **倒计时**：右上角显示剩余时间（分:秒），接近超时时变红
- **窗口**：frameless + transparent，macOS 风格圆角阴影
- **位置**：跟随用户当前聚焦窗口弹出

### 4 种交互类型 UI

| 类型 | 控件 |
|------|------|
| `confirm` | 两个按钮：是 / 否 |
| `single_choice` | Radio 单选列表 + 确认/取消按钮 |
| `multi_choice` | Checkbox 多选列表 + 确认/取消按钮 |
| `input` | 文本输入框 + 提交/取消按钮 |

---

## 7. 边界情况处理

### 超时

- 由 `ask-user-window.ts` 的 `setTimeout` 控制
- 超时后自动 resolve `{ answered: false, reason: "timeout" }`
- 关闭弹窗窗口，推进排队

### 用户手动关窗

- `BrowserWindow.on('closed')` 捕获
- resolve `{ answered: false, reason: "cancelled" }`

### Panel 未运行

- Hub 端 `callPanel` 抛异常
- Handler 返回 `{ error: "Panel 未运行，无法执行此操作" }`

### 多个 Agent 同时 ask_user

- 前 3 个立即显示（堆叠），第 4 个起排队
- 每个请求独立 Promise，独立超时
- 先回答的先 resolve，空出槽位自动显示下一个

### Hub / Panel 崩溃

- 请求全部在内存中，崩溃即丢失
- Agent 端收到 HTTP 错误，可选择重试

### Hub 端 HTTP 超时

- Hub 的 `callPanel` 超时设为 `timeout_ms + 5000`
- 比弹窗超时多 5 秒余量，确保弹窗超时先触发
- 如果 Hub HTTP 超时先到，返回 `{ error: "ask_user 失败: ..." }`

---

## 8. Agent 使用示例

```typescript
// 确认
const result = await ask_user({
  type: "confirm",
  title: "确认部署",
  question: "是否将 v2.3.1 部署到 production？"
})
// → { answered: true, choice: "yes" } 或 { answered: false, reason: "timeout" }

// 单选
const result = await ask_user({
  type: "single_choice",
  title: "选择环境",
  question: "部署到哪个环境？",
  options: ["staging", "production", "canary"],
  timeout_ms: 60000  // 1 分钟
})
// → { answered: true, choice: "staging" }

// 多选
const result = await ask_user({
  type: "multi_choice",
  title: "选择模块",
  question: "哪些模块需要回滚？",
  options: ["auth", "payment", "notification", "user-service"]
})
// → { answered: true, choice: ["auth", "payment"] }

// 自由输入
const result = await ask_user({
  type: "input",
  title: "备注",
  question: "请输入部署备注信息"
})
// → { answered: true, input: "hotfix for login bug" }
```

---

**文档版本**：2.0 (最终版)
**最后更新**：2026-04-16
**状态**：已实现
