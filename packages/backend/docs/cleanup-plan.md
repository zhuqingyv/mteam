# 旧代码清理方案

## 盘点原则

- V2 = `packages/mcp-server/src/v2/` 下的全部代码（新实现，保留）
- 旧代码 = `packages/mcp-server/src/` 下除 `v2/` 以外的一切（删除）
- Panel 旧代码 = 与旧 mcp-server HTTP API 耦合的部分（要么删、要么改成对接 V2）
- 项目根目录过期文档（删）

## V2 对旧代码的依赖检查（前置结论）

已通过 grep 验证：**V2 代码 0 处 import 旧代码**，完全独立。
- V2 内部 `import` 全部落在 `./v2/` 子目录内（如 `./db/connection.js`、`../domain/...`）
- 没有 `../../` 跨越到 v2 外
- 没有 `import` 引用 `member-store.ts` / `memory-store.ts` / `session-manager.ts` / `rule-manager.ts` / `lock-manager.ts` / `mcp-proxy.ts` / `panel-launcher.ts` / `hub.ts` / `constants.ts` / `db.ts` / `dao/` / `infra/` / `mcp-store/`（旧版）/ `tools/mteam/`（旧版）

**结论：旧代码可直接删除，V2 无任何阻塞。**

---

## 1. `packages/mcp-server/src/` 下要删的文件

### 1.1 根文件（7 个）

| 文件 | 是什么 | 为什么可以删 |
|---|---|---|
| `cli.ts` | 旧 CLI 入口（mt start/stop/restart/status/dev），拉起 `hub.ts` + panel | V2 自带 `server.ts` 自启，启动逻辑要迁走；旧 CLI 绑定 `hub.ts` 路径 |
| `hub.ts` | 旧 Hub 主进程（3029 行），集中了所有旧 API 与调度逻辑 | V2 的 `server.ts`（283 行）+ `api/panel/*` + `mteam-mcp/` 已完整替代 |
| `index.ts` | 旧 MCP stdio 薄代理，转发到 `hub.ts` HTTP | V2 的 `mteam-mcp/server.ts` 是新的 stdio MCP 入口 |
| `lock-manager.ts` | 旧文件锁管理器 | V2 用 `role_instances` 表 + 状态机管理占位 |
| `heartbeat.ts` | 旧心跳检测 | V2 心跳逻辑融入 `domain/role-instance.ts` + `reconcileStaleInstances` |
| `panel-launcher.ts` | 旧 panel 唤起工具 | V2 panel 启动迁到新 CLI 或 panel 包自启 |
| `constants.ts` | 旧常量（DEFAULT_PORT 等） | V2 `server.ts` 内联常量 |
| `db.ts` | 旧 SQLite 连接封装 | V2 `v2/db/connection.ts` 替代 |
| `member-store.ts` | 旧成员数据文件系统/SQLite 混合存储 | V2 `domain/role-instance.ts` + `roster/roster.ts` 替代 |
| `rule-manager.ts` | 旧项目规则管理 | V2 `project_rules` 表 + `dao` 归属 V2，但当前 V2 尚未实现规则模块（见风险点） |
| `mcp-proxy.ts` | 旧 MCP 代理逻辑 | V2 `mteam-mcp/` 子树替代 |

### 1.2 子目录（7 个）

| 目录 | 是什么 | 是否要删 |
|---|---|---|
| `__tests__/` | 旧测试套件（19 个测试文件，共 6561 行） | **全删**。测试都针对旧 `hub.ts` / `member-store.ts` / `mcp-proxy.ts` 等，V2 要写自己的测试 |
| `bootstrap/` | `paths.ts`（HUB_DIR 等路径常量） | V2 代码直接用 `homedir()` 拼路径，不依赖这里 → 删 |
| `dao/` | `locks.ts` / `members.ts` / `projects.ts` / `rules.ts` | 旧 DAO 层，V2 用 `domain/` + `roster/` + `api/panel/` 分层替代 → 删 |
| `infra/` | `panel-client.ts`（panel 客户端调用） | 旧 hub→panel 通讯通道，V2 目前不需要 → 删 |
| `mcp-store/` | `builtin-provider.ts` / `registry.ts` / `search-tools.ts` 等（旧 MCP 商店） | V2 `v2/mcp-store/` 替代 → 删 |
| `phase1/` | 只含 `README.md`（历史规划文档） | 已归档价值不高，且与 V2 `docs/phase1/` 冲突 → 删（或移到 V2） |
| `scripts/` | `migrate-fs-to-sqlite.ts`（一次性迁移脚本） | 已执行过、无复用价值 → 删 |
| `tools/mteam/` | 旧 MCP 工具集（38 个 .ts 文件：activate/deactivate/send_msg/...） | V2 `mteam-mcp/tools/` 已有 6 个新工具；旧 32 个需要按需在 V2 重写（见风险点） → 删 |

**删除总量**：旧文件 10 个根文件 + 7 个子目录（合计约 50+ 源码文件 + 19 个测试文件）。

---

## 2. `packages/panel/src/` 下要删/重写的

### 2.1 panel 不 import 旧 mcp-server

已验证：`packages/panel/src/` 下 **0 处** `import from '../../mcp-server/...'`。
Panel 和 mcp-server 通过 HTTP API 耦合，不是源码层耦合。
**结论**：panel 可以留着，仅需改 API URL / 端口指向 V2（58580）+ 对齐 V2 响应结构。

### 2.2 Panel 内部需要审查的文件

| 文件 | 行数 | 处理 |
|---|---|---|
| `main/member-store-service.ts` | 531 | **删**。直接访问 `~/.claude/team-hub` 旧 FS 存储。V2 数据全在 SQLite，panel 应改为调 V2 HTTP API |
| `main/panel-api.ts` | 1252 | **重写**。是 panel→hub 的 HTTP 客户端集合，要全部指向 V2 的 `/api/role-instances` / `/api/role-templates` / `/api/roster` / `/api/mcp-store` |
| `main/index.ts` | 938 | **改**。引用了 `message-router`、`panel-api` 等，需要对齐 V2 |
| `main/message-router.ts` | 275 | **重写或删**。V2 通信走 `comm.sock` + `CommServer`，panel 如果要收消息要接 Unix socket，不再是 IPC |
| `main/pty-manager.ts` | 322 | **删**。V2 `pty/manager.ts` 已接管 PTY 会话 |
| `main/ready-detector.ts` / `idle-detector.ts` | 84 / 108 | 评估：V2 状态机是否要接管，如要则删 |
| `main/message-queue.ts` | 139 | **删**。V2 有自己的 offline 队列（`comm/offline.ts`） |
| `main/api-proxy.ts` / `api-registry.ts` / `vault-manager.ts` | 共 849 | 保留（Vault / API key 是 V2 没实现的独立功能） |
| `main/ask-user-window.ts` / `overlay-window.ts` / `terminal-window.ts` / `agent-cli-scanner.ts` | UI 组件 | **保留**（UI 能力与后端无关） |
| `main/__tests__/` | 2 个测试（api-registry / vault-manager） | 保留（测试的是 panel 自身模块） |
| `renderer/*` + `preload/*` | React 组件 + IPC 桥接 | **保留**，但组件（MemberList / MemberDetail 等）的数据源要对齐 V2 |
| `e2e/*.test.ts` | 3 个 e2e（共 ~55K 行） | **全删**。针对旧 hub API，要对 V2 重写 |
| `spike-pty.ts` | prototype 验证脚本 | **删** |
| `out/` | 构建产物 | 不用管，.gitignore 应该已覆盖（实际没有，见风险点 5） |

---

## 3. 项目根目录要清理的

### 3.1 `docs/` 目录（25 个文件）

| 路径 | 处理 |
|---|---|
| `docs/acceptance-criteria.md` | **删**。针对旧系统的验收标准 |
| `docs/agent-cli-cases.md` | **删**或**移到 V2 docs**（v2/docs/cli-adapters/ 已有新版） |
| `docs/agent-message-protocol.md` | **删**。V2 已重新设计（v2/docs/comm/） |
| `docs/agent-ux-audit.md` / `-2.md` / `-round2-a.md` / `-round2-b.md`（共 4 份） | **删**。历史审计报告 |
| `docs/api-key-vault-design.md` | 保留（Vault 仍保留在 panel） |
| `docs/architecture/member-management-migration.md` | **删**。旧架构迁移文档 |
| `docs/architecture-current.md` | **删**。当前 = 旧实现 |
| `docs/architecture-new-design.md` | **评估**：如与 V2 `docs/` 重叠则删，否则移入 V2 |
| `docs/ask-user-design.md` | 保留（panel Ask User 保留） |
| `docs/fix-activate-session-leader.md` / `fix-send-msg-dequeue.md` | **删**。历史修复记录 |
| `docs/multi-screen-overlay-design.md` | 保留（overlay 保留） |
| `docs/role-templates.md` | **评估**：V2 `api/panel/role-templates.ts` 是新实现，若文档过期则删 |
| `docs/technical-design.md` | **删**。旧技术设计 |
| `docs/test-cases.md` | **删**。旧测试规划 |
| `docs/tool-cleanup-plan.md` / `tool-injection-plan.md` / `tool-metadata-annotations.json` | **删**。旧工具体系规划 |
| `docs/sqlite-migration/*.md`（5 份） | **删**。SQLite 迁移已完成 |
| `docs/screenshots/*.png` | 保留 |

**净结果**：保留 3-4 份（vault、ask-user、overlay、panel 截图），其余全删。

### 3.2 `scripts/` 目录

| 文件 | 处理 |
|---|---|
| `scripts/pr-automation.sh` / `pr-automation.conf` | 保留（非业务代码，CI 自动化） |

### 3.3 `demo/` 目录

| 文件 | 处理 |
|---|---|
| `demo/liquid-merge.html` | **评估删除**。一次性 UI demo，若 panel 已集成对应效果则删 |

### 3.4 `README.md`

**重写**（约 5901 字节，内容针对旧实现的入口和架构）。

### 3.5 `.claude/`

| 文件 | 处理 |
|---|---|
| `.claude/api-key-vault-research.md` | 保留（研究文档） |
| `.claude/settings.local.json` | 保留 |
| `.claude/skills/` | 保留 |
| `.claude/worktrees/` | 保留（工作区元数据） |

---

## 4. V2 对旧代码的依赖检查（最终复核）

扫描了 `packages/mcp-server/src/v2/**/*.ts` 的所有 `import` 语句：

| 类型 | 数量 | 示例 |
|---|---|---|
| Node 内建 | 大量 | `node:http` / `node:fs` / `node:crypto` / `node:path` |
| npm 依赖 | 少量 | `@modelcontextprotocol/sdk` / `better-sqlite3` / `node-pty` |
| V2 内部相对路径 | 全部 | `./db/connection.js` / `../domain/role-instance.js` / `./tools/activate.js` |
| **旧代码（../../member-store 等）** | **0** | 无 |

**结论**：V2 可安全脱离旧代码单独存在。删除旧代码后，V2 构建/运行不会因源码依赖断裂。

---

## 5. package.json 依赖清理

### 5.1 `packages/mcp-server/package.json`

**当前依赖**：
```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.10.2",  // V2 mteam-mcp 仍用
  "better-sqlite3": "^12.9.0",              // V2 db 仍用
  "node-pty": "^1.1.0",                     // V2 pty 仍用
  "uuid": "^11.1.0"                         // 只被旧 lock-manager.ts 用
}
```

**清理项**：
- `uuid` → 可删（V2 用 `node:crypto.randomUUID()`）

**devDependencies**：
- `playwright` → V2 单测若不用 e2e 可删；若保留 panel e2e 则保留
- 其他（`@types/*` / `typescript` / `vitest`）保留

**scripts**：
- `dev`: `bun run src/index.ts` → 改成 `bun run src/v2/server.ts`（V2 入口）
- `hub`: `bun run src/hub.ts` → 删
- `build`: `bun build src/index.ts ...` → 改为 V2 入口
- `build:hub` → 删
- `bin` 字段的 `mt` / `team-hub` / `mcp-team-hub` → 全部指向 V2 新 CLI（当前 V2 未提供独立 CLI，需要先建）

### 5.2 `packages/panel/package.json`

**无改动**。Panel 依赖都是 Electron / React / xterm，与 mcp-server 解耦。

### 5.3 根 `package.json`

**无改动**（只有 workspace 配置和 tsx devDep）。

---

## 6. 清理步骤（建议顺序）

按依赖风险从低到高排列，保证每一步可独立验证：

### 步骤 1：建立安全网（前置）
- 创建清理分支 `chore/remove-legacy-code`
- 当前 V2 入口先跑通一次：`bun run src/v2/server.ts` + `bun run src/v2/mteam-mcp/index.ts`，截图/日志留证

### 步骤 2：补齐 V2 缺口（必须先做，否则无法删旧）
盘点 V2 还没覆盖的功能（见风险点 1），先在 V2 实现：
- 项目规则管理（对应旧 `rule-manager.ts` + `dao/rules.ts`）
- 剩余 30+ MCP 工具（对应旧 `tools/mteam/`）
- 新 CLI（对应旧 `cli.ts` start/stop/status，但只启 V2）
- Panel HTTP 客户端改对接 V2（对应旧 `hub.ts` 路由）

**只有第 2 步完成且回归通过，才能进入第 3 步删代码。**

### 步骤 3：删 `packages/mcp-server/src/__tests__/` 整个目录
独立删除，不影响运行。

### 步骤 4：删旧根文件（按依赖倒序）
1. 先删 `index.ts`（旧 stdio 入口，V2 有新入口）
2. 再删 `cli.ts`（调用 `hub.ts`）
3. 再删 `hub.ts`（调用 `member-store` / `mcp-proxy` / `lock-manager` / ...）
4. 再删 `mcp-proxy.ts` / `heartbeat.ts` / `rule-manager.ts` / `member-store.ts` / `lock-manager.ts` / `panel-launcher.ts` / `db.ts` / `constants.ts`

每删 1 个跑一次 `bunx tsc --noEmit`，确保没留下野引用。

### 步骤 5：删旧子目录
`bootstrap/` → `dao/` → `infra/` → `mcp-store/` → `phase1/` → `scripts/` → `tools/`

### 步骤 6：更新 `package.json`
- 删 `uuid` 依赖
- 改 `scripts` 指向 V2
- 改 `bin` 指向 V2 CLI

### 步骤 7：清理 panel
- 删 `member-store-service.ts` / `pty-manager.ts` / `message-queue.ts` / `spike-pty.ts`
- 删 panel `e2e/` 三个旧 e2e 测试
- 按需改 `panel-api.ts` / `index.ts` / `message-router.ts` 指向 V2

### 步骤 8：清理根 docs / demo / README
- 删过期文档（见 3.1 清单）
- 删 `demo/liquid-merge.html`
- 重写 `README.md`

### 步骤 9：验收
- `bun run build` 成功
- `packages/panel` `bun run build` 成功
- V2 端到端冒烟（activate / send_msg / deactivate / panel 可见成员）
- 提交 PR，让 Cyrille + Chenyu review

---

## 7. 风险点

### R1：V2 功能覆盖不完整（高风险）
旧 `tools/mteam/` 有 38 个工具（activate、deactivate、send_msg、check_inbox、checkpoint、handoff、request_member、request_departure、get_roster、team_report、project_dashboard、add_project_rule、propose_rule、spawn_pty_session、kill_pty_session、list_pty_sessions、ask_user、hire_temp、force_release、stuck_scan、work_history、use_api、list_api_keys、create_project、update_project、delete_project、get_project、list_projects、get_project_rules、check_in / check_out / clock_out、scan_agent_clis、cancel_reservation、get_status、handoff ...）。

V2 `mteam-mcp/tools/` 当前只有 6 个（activate、deactivate、request_offline、send_msg、check_inbox、lookup）。

**缺口 30+ 个工具，删旧代码前必须在 V2 补齐**，否则用户功能断崖式回退。

### R2：旧 HTTP API 路由缺失（高风险）
旧 `hub.ts` 暴露大量 `/api/*` 路由给 panel / 成员 / leader。V2 `server.ts` 当前只有：
- `/api/role-templates` / `/api/role-instances` / `/api/roster`
- `/api/mcp-store` / `/api/sessions/register`
- `/panel` HTML

旧 panel 还在调：`/api/tools` / `/api/call` / `/api/session/register` / `/api/session/unregister` / `/api/health` 等。
**panel 对接 V2 之前，不能删 hub.ts**，否则 panel 直接挂。

### R3：`hub.ts` 3029 行 / `panel-api.ts` 1252 行（难度风险）
两个超大文件重写工作量大，建议拆成多个 PR，每个 PR 带单元测试。

### R4：数据迁移（中风险）
旧系统可能存了数据在 `~/.claude/team-hub/` 的文件系统目录下。V2 用 SQLite。
**删代码前要确认**：V2 表结构是否涵盖旧 FS 数据？历史数据是否需要迁移？`scripts/migrate-fs-to-sqlite.ts` 是否已彻底跑过？

### R5：`.gitignore` 未覆盖 `packages/panel/out/` 和 `packages/mcp-server/dist/`（低风险）
当前 `.gitignore` 只写了 `dist/` `node_modules/`，但 panel 的产物目录是 `out/`。git status 里 `packages/panel/out/*` 被追踪了。清理时顺便修 `.gitignore`。

### R6：旧文档可能仍是唯一参考（低风险）
`architecture-new-design.md` 可能是 V2 架构的权威文档，删之前要确认 V2 `docs/` 已经吸收其内容。

### R7：测试断层（中风险）
删 19 个旧测试后，V2 如没同等覆盖，回归能力断崖。**建议**：删旧测试的同时 PR 内补 V2 测试，不要分开删。

### R8：`bin` 字段（用户入口）（中风险）
`package.json` 里 `mt` / `team-hub` / `mcp-team-hub` 是用户和 Claude Code MCP 配置引用的入口。改 `bin` 指向会导致所有已安装用户失效，需要 V2 新 CLI 保持同名命令的兼容行为。

---

## 附：清理总量估算

| 分类 | 文件数 | 行数 |
|---|---|---|
| mcp-server 根文件 | 10 个 `.ts` | ~5000+ 行（含 hub.ts 3029） |
| mcp-server 子目录 | 7 个目录 | ~3000+ 行（tools/mteam 最大） |
| mcp-server 测试 | 19 个 `.ts` | 6561 行 |
| panel main 旧文件 | 5 个 `.ts` | ~1300 行 |
| panel e2e | 3 个 `.ts` | ~55K 字节 |
| 根 docs | ~20 份 `.md` | ~400KB |
| **合计删除** | **60+ 文件** | **~15000+ 行代码 + 400KB 文档** |

V2 保留量：~50 个 `.ts` / `.sql` / `.md`，约 4-5K 行源码 + 9 份设计文档。
