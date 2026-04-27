# Agent CLI 管理器设计

---

## 定位

独立原子模块，负责实时维护本地 agent CLI 的可用状态。跟 roster、team 平级。本身可被订阅 — 状态变更通过 bus 事件通知，前端通过 WebSocket 自动收到。

---

## 白名单

```
claude  — Claude Code CLI
codex   — OpenAI Codex CLI
```

后续扩展加条目，不改模块逻辑。

---

## 职责

| 职责 | 说明 |
|------|------|
| 启动扫描 | 启动时全量扫描白名单 CLI |
| 内存状态 | 维护 Map<name, CliInfo> 快照 |
| 变更检测 | 定时轮询（间隔可配，默认 30s）重新扫描，对比差异 |
| 事件通知 | CLI 新装/卸载 → emit bus 事件（cli.available / cli.unavailable） |
| 查询接口 | getAll() / isAvailable(name) / getInfo(name) 读内存 |

---

## 数据结构

```ts
interface CliInfo {
  name: string;           // 'claude' | 'codex'
  available: boolean;
  path: string | null;    // 绝对路径
  version: string | null;
}
```

---

## 模块接口

```ts
class CliManager {
  boot(): void           // 全量扫描 + 启动轮询
  teardown(): void       // 停止轮询
  getAll(): CliInfo[]
  isAvailable(name: string): boolean
  getInfo(name: string): CliInfo | null
}
```

---

## 与其他模块的关系

```
CliManager（内存快照 + 轮询 + bus 事件）
  │
  ├→ pty/manager.ts: spawn 时 isAvailable(cli) 校验
  ├→ 角色模板: 可选 CLI 类型受约束
  ├→ 前端: GET /api/cli 展示可用 CLI
  └→ bus: emit cli.available / cli.unavailable
```

---

## HTTP 接口

```
GET /api/cli          → CliInfo[]（读内存，不重新扫描）
POST /api/cli/refresh → CliInfo[]（立即重新扫描一次）
```

---

## 文件位置

```
packages/backend/src/cli-scanner/
├── manager.ts    — CliManager 类
└── types.ts      — CliInfo 类型
```

---

## 改动清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新增 | cli-scanner/manager.ts | CliManager |
| 新增 | cli-scanner/types.ts | 类型 |
| 新增 | api/panel/cli.ts | HTTP 接口 |
| 修改 | server.ts | 启动 boot + 挂路由 + shutdown teardown |
| 修改 | pty/manager.ts | spawn 时从 CliManager 取 path |
| 修改 | bus/types.ts | 新增 cli.available / cli.unavailable 事件 |
