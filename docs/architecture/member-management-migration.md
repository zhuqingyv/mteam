# 成员管理迁移方案：Panel 主权架构

## 1. 目标

Panel 成为成员状态的唯一数据源（source of truth），Hub 退化为 thin proxy，所有成员读写操作经 Panel API 完成，消除双写冲突。

## 2. 现状问题

| 问题 | 说明 |
|------|------|
| 双写冲突 | Hub 直接读写 `~/.claude/team-hub/members/` 和 `shared/`，Panel 也直接读写同一目录（lock、heartbeat、reservation、MCP store、project），两套进程竞争同一文件系统 |
| 路径硬编码 | Hub（hub.ts:73-76）和 Panel（index.ts:33-37）各自定义 `MEMBERS_DIR`/`SHARED_DIR` 常量，散落在 lock-manager、member-store、memory-store、heartbeat 等子模块中 |
| 状态扫描重复 | Hub 每 60s 心跳巡检 + session 巡检（hub.ts:2585-2651），Panel 每 5s `inspectSessions` + `pushStatus`（index.ts:420-425），两者独立扫描、独立清理，互相踩踏 |

## 3. 目标架构

```
Claude Agent
    │  (stdio)
    ▼
MCP thin proxy  ──HTTP──▶  Hub (hub.ts)  ──HTTP──▶  Panel API (panel-api.ts)
                                                          │
                                                     Panel Store
                                                     (in-memory + 持久化)
                                                          │
                                                     文件系统
                                                 ~/.claude/team-hub/
```

**三层关系**

| 层 | 职责 | 数据权限 |
|----|------|----------|
| MCP thin proxy | stdio ↔ HTTP 转发，无业务逻辑 | 无 |
| Hub (hub.ts) | 工具定义、session 管理、参数校验；成员数据操作全部 `callPanel` | 只读降级（Panel 离线时） |
| Panel (Electron) | member-store-service：CRUD、锁、心跳、reservation、memory、MCP config、project；唯一写入方 | 读写 |

## 4. Panel 新增 API 清单

所有 API 前缀 `/api/member`，JSON body，返回 `{ ok, data?, error? }`。

| Method | Endpoint | 说明 |
|--------|----------|------|
| GET | `/api/member/list` | 列出全部成员（profile + lock + heartbeat + reservation 聚合） |
| GET | `/api/member/:name` | 单成员详情 |
| GET | `/api/member/:name/status` | 成员状态（working/online/offline/reserved） |
| POST | `/api/member/create` | 创建成员 profile（hire_temp） |
| PATCH | `/api/member/:name/profile` | 更新 profile（evaluate_temp 转正等） |
| POST | `/api/member/:name/lock/acquire` | 获取锁（project, task, session_pid, session_start） |
| POST | `/api/member/:name/lock/release` | 释放锁（nonce） |
| POST | `/api/member/:name/lock/update` | 更新锁绑定（project, task） |
| POST | `/api/member/:name/lock/takeover` | 接管锁（session_pid, session_start, project, task） |
| POST | `/api/member/:name/lock/force-release` | 强制释放锁 |
| GET | `/api/member/:name/lock` | 读锁 |
| POST | `/api/member/:name/heartbeat` | 写心跳（session_pid, last_tool） |
| GET | `/api/member/:name/heartbeat` | 读心跳 |
| DELETE | `/api/member/:name/heartbeat` | 删心跳 |
| POST | `/api/member/:name/reservation` | 写预约 |
| GET | `/api/member/:name/reservation` | 读预约 |
| DELETE | `/api/member/:name/reservation` | 删预约 |
| POST | `/api/member/:name/memory/save` | 保存记忆（scope, content, project） |
| GET | `/api/member/:name/memory` | 读记忆（scope, project） |
| POST | `/api/member/:name/worklog` | 追加工作日志 |
| GET | `/api/member/:name/worklog` | 读工作日志（limit） |
| GET | `/api/member/:name/persona` | 读 persona.md |
| POST | `/api/member/:name/evaluate` | 追加评价记录 |
| GET | `/api/shared/experience` | 读共享经验（scope, project） |
| POST | `/api/shared/experience` | 提交经验 |
| GET | `/api/shared/experience/search` | 搜索经验（keyword, scope） |
| GET | `/api/shared/rules` | 读规则 |
| POST | `/api/shared/rules/propose` | 提议规则 |
| GET | `/api/shared/rules/pending` | 待审规则列表 |
| POST | `/api/shared/rules/approve` | 批准规则 |
| POST | `/api/shared/rules/reject` | 拒绝规则 |
| GET | `/api/shared/governance` | 读 governance.json |
| GET | `/api/heartbeat/stale` | 扫描超时心跳 |
| POST | `/api/mcp-store/install` | 安装 MCP 到商店 |
| DELETE | `/api/mcp-store/:name` | 卸载商店 MCP |
| GET | `/api/mcp-store/list` | 列出商店 MCP |
| POST | `/api/member/:name/mcp/install` | 为成员安装 MCP |
| DELETE | `/api/member/:name/mcp/:mcpName` | 卸载成员 MCP |
| GET | `/api/member/:name/mcp/list` | 列出成员 MCP（含运行状态） |
| POST | `/api/member/:name/mcp/mount` | 从商店挂载 MCP |
| DELETE | `/api/member/:name/mcp/mount/:mcpName` | 卸载已挂载 MCP |
| GET | `/api/project/list` | 列出项目 |
| GET | `/api/project/:id` | 项目详情 |
| POST | `/api/project/create` | 创建项目 |
| PATCH | `/api/project/:id` | 更新项目 |
| DELETE | `/api/project/:id` | 删除项目 |
| POST | `/api/project/:id/experience` | 追加项目经验 |
| GET | `/api/project/:id/rules` | 获取项目规则 |
| POST | `/api/project/:id/rule` | 添加项目规则 |

## 5. Hub.ts 改造清单

以下调用点当前直接读写文件系统，需改为 `callPanel()`。

### 5.1 锁操作（lock-manager）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `readLock(MEMBERS_DIR, member)` | 205, 1059, 1087, 1118, 1141, 1188, 1228, 1237, 1448, 1464, 1487, 1510, 1534, 1595, 1616, 1751, 1776, 1883, 2399, 2502, 2593 | `callPanel("GET", "/api/member/:name/lock")` |
| `acquireLock(MEMBERS_DIR, ...)` | 1108, 1525, 1772 | `callPanel("POST", "/api/member/:name/lock/acquire", ...)` |
| `releaseLock(MEMBERS_DIR, ...)` | 208, 1154, 1201, 1513, 1887, 2595 | `callPanel("POST", "/api/member/:name/lock/release", ...)` |
| `updateLock(MEMBERS_DIR, ...)` | 1065 | `callPanel("POST", "/api/member/:name/lock/update", ...)` |
| `takeover(MEMBERS_DIR, ...)` | 1078, 1608 | `callPanel("POST", "/api/member/:name/lock/takeover", ...)` |
| `forceRelease(MEMBERS_DIR, ...)` | 1251 | `callPanel("POST", "/api/member/:name/lock/force-release")` |

### 5.2 成员 profile（member-store）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `listMembers(MEMBERS_DIR)` | 241, 1235, 1444, 1461, 1485, 1905, 2385, 2499 | `callPanel("GET", "/api/member/list")` |
| `getProfile(MEMBERS_DIR, name)` | 259, 1229, 1398, 1589, 1809, 2383 | `callPanel("GET", "/api/member/:name")` |
| `saveProfile(MEMBERS_DIR, profile)` | 1381, 1413 | `callPanel("POST", "/api/member/create")` or `PATCH` |
| `appendWorkLog(MEMBERS_DIR, ...)` | 210, 1067, 1089, 1121, 1160, 1204, 1517, 1536, 1618, 1779, 1892, 2598 | `callPanel("POST", "/api/member/:name/worklog", ...)` |
| `readWorkLog(MEMBERS_DIR, ...)` | 1476 | `callPanel("GET", "/api/member/:name/worklog")` |

### 5.3 心跳（heartbeat）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `touchHeartbeat(MEMBERS_DIR, ...)` | 1049, 1806 | `callPanel("POST", "/api/member/:name/heartbeat", ...)` |
| `readHeartbeat(MEMBERS_DIR, ...)` | 1230, 1238, 1908, 2502 | `callPanel("GET", "/api/member/:name/heartbeat")` |
| `removeHeartbeat(MEMBERS_DIR, ...)` | 224, 1168, 1217, 1891, 2611 | `callPanel("DELETE", "/api/member/:name/heartbeat")` |
| `scanStaleHeartbeats(MEMBERS_DIR, ...)` | 2586 | `callPanel("GET", "/api/heartbeat/stale")` |

### 5.4 记忆（memory-store）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `saveMemory(MEMBERS_DIR, ...)` | 1268 | `callPanel("POST", "/api/member/:name/memory/save", ...)` |
| `readMemory(MEMBERS_DIR, ...)` | 1281, 1815, 1816 | `callPanel("GET", "/api/member/:name/memory")` |
| `submitExperience(...)` | 1294 | `callPanel("POST", "/api/shared/experience", ...)` |
| `readShared(SHARED_DIR, ...)` | 1310, 1817, 1982, 2184 | `callPanel("GET", "/api/shared/...")` |
| `searchExperience(SHARED_DIR, ...)` | 1318 | `callPanel("GET", "/api/shared/experience/search")` |

### 5.5 规则（rule-manager）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `proposeRule(SHARED_DIR, ...)` | 1331 | `callPanel("POST", "/api/shared/rules/propose", ...)` |
| `reviewRules(SHARED_DIR)` | 1337 | `callPanel("GET", "/api/shared/rules/pending")` |
| `approveRule(SHARED_DIR, ...)` | 1346 | `callPanel("POST", "/api/shared/rules/approve", ...)` |
| `rejectRule(SHARED_DIR, ...)` | 1352 | `callPanel("POST", "/api/shared/rules/reject", ...)` |

### 5.6 预约（reservation）— hub.ts 内联实现

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `writeReservationFile(member, ...)` | 162, 1636, 1693 | `callPanel("POST", "/api/member/:name/reservation", ...)` |
| `readReservationFile(member)` | 169, 1673, 1737, 1755, 1910 | `callPanel("GET", "/api/member/:name/reservation")` |
| `deleteReservationFile(member)` | 176, 1738, 1768, 2631-2636 | `callPanel("DELETE", "/api/member/:name/reservation")` |

### 5.7 项目（projects）— hub.ts 内联实现

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `readProjectFile(id)` | 285-292, 2239, 2261, 2280, 2295, 2305, 2322 | `callPanel("GET", "/api/project/:id")` |
| `writeProjectFile(project)` | 294-296, 2231, 2273, 2287, 2301 | `callPanel("POST/PATCH", "/api/project/...")` |
| `listAllProjects()` | 298-309, 1839, 2169, 2247 | `callPanel("GET", "/api/project/list")` |
| `fs.rmSync(projectFile)` | 2323 | `callPanel("DELETE", "/api/project/:id")` |

### 5.8 MCP 配置（mcp-proxy）

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `loadMemberMcps(MEMBERS_DIR, ...)` | 2019 | `callPanel("GET", "/api/member/:name/mcp/list")` |
| `installMcpConfig(MEMBERS_DIR, ...)` | 2049 | `callPanel("POST", "/api/member/:name/mcp/install", ...)` |
| `uninstallMcpConfig(MEMBERS_DIR, ...)` | 2066 | `callPanel("DELETE", "/api/member/:name/mcp/:mcpName")` |
| `loadStore()` | 2023, 2094, 2105 | `callPanel("GET", "/api/mcp-store/list")` |
| `addToStore(config)` | 2093 | `callPanel("POST", "/api/mcp-store/install", ...)` |
| `removeFromStore(name)` | 2100 | `callPanel("DELETE", "/api/mcp-store/:name")` |
| `mountMcp(MEMBERS_DIR, ...)` | 2115 | `callPanel("POST", "/api/member/:name/mcp/mount", ...)` |
| `unmountMcp(MEMBERS_DIR, ...)` | 2149 | `callPanel("DELETE", "/api/member/:name/mcp/mount/:mcpName")` |

### 5.9 治理 / 其他

| 当前调用 | hub.ts 行号 | 改为 |
|----------|-------------|------|
| `loadGovernance()` | 246-253, 1821, 2179, 1937-1943, 1984-1989 | `callPanel("GET", "/api/shared/governance")` |
| `fs.appendFileSync(evalPath, ...)` | 1409 | `callPanel("POST", "/api/member/:name/evaluate", ...)` |
| `fs.readdirSync(MEMBERS_DIR, ...)` — 心跳巡检 | 2622-2638 | `callPanel("GET", "/api/heartbeat/stale")` + `callPanel("DELETE", ...)` |
| `fs.readdirSync(MEMBERS_DIR, ...)` — session 清理 | 201-219, 2393-2405 | `callPanel("GET", "/api/member/list")` |

## 6. Panel 停写清单

以下位置当前 Panel 直接写 `MEMBERS_DIR` / `SHARED_DIR`，迁移后需改为走内部 service 或改为只读。

### 6.1 index.ts（主进程）

| 行号 | 操作 | 迁移方案 |
|------|------|----------|
| 198 | `rmSync(reservationPath)` — TTL 过期清理 reservation | 改为调内部 member-store-service |
| 270 | `rmSync(sessionPath)` — inspectSessions 清理死进程 session 文件 | Phase 2 改为只读检测，写操作走 service |
| 294-295 | `rmSync(lockPath)` / `rmSync(heartbeatPath)` — 死进程锁清理 | 改为调内部 service |
| 302-303 | `rmSync(lockPath)` / `rmSync(heartbeatPath)` — PID 复用锁清理 | 改为调内部 service |
| 311 | `rmSync(heartbeatPath)` — 心跳超时清理 | 改为调内部 service |
| 615 | `rmSync(reservationPath2)` — getMemberDetail 中过期 reservation 清理 | 改为只读（不在读函数中写） |
| 682 | `writeFileSync(projectFile)` — saveProject | 改为调内部 project-service |
| 704 | `rmSync(path)` — deleteProject | 改为调内部 project-service |
| 734-744 | `writeFileSync(storePath)` — install-store-mcp IPC | 改为调内部 mcp-store-service |
| 748-757 | `writeFileSync(storePath)` — uninstall-store-mcp IPC | 改为调内部 mcp-store-service |
| 761-781 | `writeFileSync(mcpsPath)` — mount-member-mcp IPC | 改为调内部 mcp-store-service |
| 785-794 | `writeFileSync(mcpsPath)` — unmount-member-mcp IPC | 改为调内部 mcp-store-service |

### 6.2 terminal-window.ts

| 行号 | 操作 | 迁移方案 |
|------|------|----------|
| 248-256 | `writeFileSync(lockPath, ...)` — 打开终端窗口时写 lock.json | 改为调 Panel member-store-service API |
| 288 | `rmSync(lockPath)` — 关闭窗口时删 lock.json | 改为调 Panel member-store-service API |

### 6.3 panel-api.ts

| 行号 | 操作 | 迁移方案 |
|------|------|----------|
| 115-133 | `writeFileSync(claudeJsonPath)` — 预写 workspace trust | 保留（写的是 `~/.claude.json`，不是 team-hub 目录） |

## 7. 分阶段计划

### Phase 0：Panel 建 member-store-service + 新增 API 路由（不动 Hub）

- 在 Panel 中新建 `src/main/member-store-service.ts`，封装所有 `MEMBERS_DIR` / `SHARED_DIR` 读写操作
- 将 index.ts 和 terminal-window.ts 中的直接文件操作改为调内部 service
- 在 `panel-api.ts` 中新增第 4 节列出的全部 API 路由，内部调 service
- Panel IPC handler（install-store-mcp、mount-member-mcp 等）也改为调 service
- **Hub 不动**，继续直接读写文件，Panel API 仅供新 Hub 使用
- 交付标准：所有新 API 可用，Panel 自身读写全部收敛到 service 层

### Phase 1：Hub 逐个 case 改为 callPanel，保留 fallback

- Hub `handleToolCall` 中的每个 case，将直接调用子模块函数改为 `callPanel`
- 按第 5 节清单逐类推进：锁 → profile → 心跳 → 记忆 → 规则 → 预约 → 项目 → MCP 配置
- 每个 case 保留 fallback：`callPanel` 失败时降级到原有本地读写（仅读操作）
- Hub 心跳巡检（2585-2651）和 session 巡检（2644-2651）改为调 Panel API
- 同步删除 hub.ts 中的 `writeReservationFile`/`readReservationFile`/`deleteReservationFile` 内联函数
- 同步删除 hub.ts 中的 `readProjectFile`/`writeProjectFile`/`listAllProjects`/`loadGovernance` 内联函数
- **交付标准**：Hub 所有写操作经 Panel API，本地文件操作仅在 fallback 读路径中存在

### Phase 2：Panel 停止所有直写

- `inspectSessions`（index.ts:249-314）改为只读检测 + 通过 service 执行清理
- terminal-window.ts 的 lock 写入/删除（248-256, 288）改为调 service
- `getMemberDetail` 中的 reservation 过期删除（index.ts:615）移到 service 定时任务
- IPC handler 中剩余的直接 writeFileSync 全部迁移到 service
- **交付标准**：Panel 中除 `panel.port`/`panel.pid` 外，无任何直接写 `MEMBERS_DIR`/`SHARED_DIR` 的代码

### Phase 3：清理

- 移除 Hub 中的 fallback 本地读写代码
- 移除 Hub 对 `lock-manager`、`member-store`、`memory-store`、`heartbeat`、`rule-manager` 子模块的 import
- Hub 只保留：session 管理、callPanel、工具定义、参数校验
- 移除 Hub 的 `MEMBERS_DIR`/`SHARED_DIR`/`PROJECTS_DIR` 常量（仅保留 `HUB_DIR` 供 pid/port 文件使用）
- 移除 Hub 的心跳巡检和预约超时巡检定时器（Panel service 统一负责）
- 整理 Panel service 层单测
- **交付标准**：Hub 无直接文件 I/O（除 `hub.pid`/`hub.port`），所有数据操作走 Panel API

## 8. 降级策略

Hub 在 `callPanel` 失败时的行为：

| 操作类型 | Panel 离线时行为 | 说明 |
|----------|-----------------|------|
| 读操作 | 降级读本地文件 | `readLock`/`getProfile`/`readMemory` 等，直接从 `MEMBERS_DIR` 读文件（Phase 1 保留的 fallback） |
| 写操作 | 拒绝并返回错误 | `acquireLock`/`saveMemory`/`appendWorkLog` 等，返回 `{ error: "Panel 未运行，无法执行此操作" }` |
| 心跳 | 静默跳过 | `touchHeartbeat` 失败不影响工具调用主流程，仅 stderr 记录 |
| PTY/消息 | 已有降级 | 当前 `callPanel` 调用（spawn/kill/send_msg）已在 catch 中返回错误 |

## 9. 风险清单

| 风险 | 严重度 | 缓解措施 |
|------|--------|----------|
| Panel 离线导致写操作全部失败 | 高 | Phase 1 保留 fallback；Panel 启动时写 `panel.port`，Hub 据此判断可用性；Panel 应设计为自启动或由系统守护 |
| API 超时导致工具调用卡顿 | 中 | `callPanel` 已有 2s 超时（hub.ts:107）；热路径（心跳）超时后静默跳过；非热路径超时返回错误让 agent 重试 |
| 迁移过程中双写窗口期 | 高 | Phase 1 逐个 case 迁移，每迁一批验证；期间 Panel 和 Hub 可能同时写同一文件，通过 service 层加文件锁保护 |
| Panel 重启丢失内存状态 | 中 | service 层以文件系统为后端，重启后重新从文件加载；不引入独立数据库，保持架构简单 |
| IPC handler 与 API 路由语义不一致 | 低 | Phase 0 统一收敛到 service 层后，IPC 和 HTTP API 调同一个 service 函数，语义天然一致 |
| MCP proxy 进程管理仍在 Hub | 中 | MCP 子进程生命周期管理（spawn/cleanup）保留在 Hub，仅配置读写走 Panel API；后续可考虑 MCP proxy 也迁入 Panel |
| lock 竞争条件（并发 acquire） | 中 | service 层使用进程内互斥（单线程 Node 天然串行），替代当前文件级 CAS；跨进程竞争通过"Panel 唯一写入方"消除 |
