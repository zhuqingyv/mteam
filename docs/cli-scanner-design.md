# Agent CLI 扫描器设计

---

## 功能

backend 启动时扫描本地已安装的 agent CLI，以白名单控制支持的 CLI 类型。扫描结果供角色模板和 PTY spawn 使用 — 只有本机装了的 CLI 才能创建实例。

---

## 白名单

```
claude  — Claude Code CLI
codex   — OpenAI Codex CLI
```

后续扩展直接加白名单条目，不改扫描逻辑。

---

## 扫描逻辑

对白名单中每个 CLI：

1. `which <name>` 或 `command -v <name>` 检测是否在 PATH 中
2. 在 → 记录路径 + 尝试取版本（`<name> --version` 或 `<name> -v`，超时 3 秒）
3. 不在 → 标记不可用

```
扫描结果：
{
  claude: { available: true, path: '/usr/local/bin/claude', version: '2.1.118' },
  codex:  { available: false, path: null, version: null }
}
```

---

## 数据结构

```ts
interface CliInfo {
  name: string;           // 白名单名称：'claude' | 'codex'
  available: boolean;     // 本机是否可用
  path: string | null;    // 可执行文件绝对路径
  version: string | null; // 版本号（取不到为 null）
}

interface CliScanResult {
  scannedAt: string;      // ISO 时间戳
  clis: CliInfo[];
}
```

---

## 执行时机

- **server 启动时**：startServer() 里调一次，结果缓存在内存
- **提供 HTTP 接口**：`GET /api/cli-scan` 返回扫描结果（供前端展示）
- **提供刷新接口**：`POST /api/cli-scan/refresh` 重新扫描（CLI 可能后来装了）

---

## 与现有模块的关系

```
CLI 扫描器（新模块）
  → 启动时扫描，缓存结果
  → PTY spawn 时校验：要用的 CLI 是否 available，不 available 直接拒绝
  → 前端展示：哪些 CLI 可用
  → 角色模板：可选的 CLI 类型受扫描结果约束
```

当前 pty/manager.ts 里 CLI 命令硬编码为 `TEAM_HUB_CLI_BIN` env 或默认 `claude`。改造后从扫描结果取 path。

---

## 文件位置

```
packages/backend/src/cli-scanner/
├── scanner.ts    — 扫描逻辑 + 缓存
└── types.ts      — CliInfo / CliScanResult
```

---

## 改动清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新增 | cli-scanner/scanner.ts | 扫描 + 缓存 + refresh |
| 新增 | cli-scanner/types.ts | 类型定义 |
| 新增 | api/panel/cli-scan.ts | HTTP 接口 |
| 修改 | server.ts | 启动时调扫描 + 挂路由 |
| 修改 | pty/manager.ts | spawn 时从扫描结果取 CLI path |

---

## 实施计划

| 步骤 | 内容 |
|------|------|
| 1 | scanner.ts + types.ts（扫描逻辑） |
| 2 | api/panel/cli-scan.ts + server.ts 路由 |
| 3 | pty/manager.ts 集成 |
| 4 | 测试 |
