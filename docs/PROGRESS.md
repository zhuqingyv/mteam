# mteam 项目进度

## 项目概述

mteam 是多 agent 团队协作平台。管理角色模板/实例、进程生命周期、agent 间通信、MCP 工具注入。

## 技术栈

- 后端：TypeScript + Node.js + better-sqlite3 + Unix socket
- 前端：React 19 + Vite + TypeScript + Jotai（测试面板阶段）
- MCP：@modelcontextprotocol/sdk
- PTY：node-pty
- 包管理：bun（monorepo）

## monorepo 结构

```
packages/
├── backend/       # 后端服务
│   ├── src/
│   │   ├── server.ts       # HTTP server 入口（端口 58580）
│   │   ├── domain/         # 领域对象（角色模板、角色实例、状态机、事件）
│   │   ├── db/             # SQLite 连接 + schemas/（11 张表，每张一个 SQL 文件）
│   │   ├── api/panel/      # HTTP 接口（模板 CRUD、实例管理、花名册、MCP Store、session 注册）
│   │   ├── comm/           # 通信模块（Unix socket，NDJSON 协议）
│   │   ├── roster/         # 活跃名单管理器（纯 DB 读写的 DAO）
│   │   ├── mcp-store/      # MCP 配置管理（文件存储 ~/.claude/team-hub/mcp-store/）
│   │   ├── mcp/            # 内置 mteam MCP stdio server（6 个工具）
│   │   ├── pty/            # PTY 进程管理（spawn/kill/提示词注入）
│   │   └── fx/             # 视觉特效（liquid border + 触手，从 V1 迁移，待接入前端）
│   ├── docs/               # 设计文档
│   └── package.json
├── renderer/      # 前端（React 测试面板）
│   ├── src/
│   └── package.json
└── mnemo/         # 知识库 MCP（待接入，git submodule）
```

## 已完成模块

### Phase 1 — 数据层 + 领域对象
- [x] DB schema（11 张表，每张一个 SQL 文件）
- [x] 角色模板 RoleTemplate（CRUD）
- [x] 角色实例 RoleInstance（create/findById/listAll/activate/delete）
- [x] 状态机（PENDING → ACTIVE → PENDING_OFFLINE → 物理删除）
- [x] 事件系统（EventEmitter，SSE 预留）
- [x] 模板 HTTP 接口（5 个端点）
- [x] 实例 HTTP 接口（创建/列表/删除/activate/request-offline）

### Phase 2 — 进程 + 通信 + 名单
- [x] PTY 管理器（spawn CLI/kill/ring buffer/CLI ready 检测）
- [x] 提示词注入（leader/member 两个 case，从模板 persona 读取）
- [x] comm 本机通信（Unix socket server + 注册 + 路由 + 离线补发）
- [x] comm 协议（[scope]:[id] 寻址，local/remote/system 三种接收方）
- [x] roster 活跃名单（纯 DB 读写 DAO，7 个 HTTP 接口，模糊搜索 alias）
- [x] MCP Store（文件存储，安装/卸载/列表，spawn 时动态拼 --mcp-config）
- [x] mteam MCP server（6 个工具：activate/deactivate/send_msg/check_inbox/request_offline/lookup）
- [x] instance → roster 打通（创建/激活/下线/删除自动同步）
- [x] 状态保护（ACTIVE 不能直接删，需 leader 批准）
- [x] session 注册（CLI 启动后回调绑定 instance）
- [x] server 启动时 reconcile（清理僵尸实例）

### 前端
- [x] React + Vite + TS + Jotai 骨架
- [x] 测试面板 4 个模块（模板/实例/花名册/MCP Store）
- [x] 所有元素带 data-testid（Playwright 就绪）

### 测试
- [x] 后端单测 176/176 通过（vitest）
- [x] 覆盖：state-machine + role-template + role-instance + roster + API handlers + HTTP server
- [x] Playwright e2e 15/15 通过（模板 3 + 实例 4 + 花名册 4 + MCP Store 4）

### 基础设施
- [x] better-sqlite3 → bun:sqlite（全栈 bun）
- [x] 后端 CORS 支持（前端跨域调用）
- [x] bun --watch 热更新
- [x] 前端 activate + request-offline 按钮补齐

### 项目结构改造
- [x] 旧代码全删（hub.ts/panel/旧 docs）
- [x] v2 平铺到 src/（v2 目录消失）
- [x] mteam-mcp → mcp 改名
- [x] docs 提到包级
- [x] mcp-server → backend 改名
- [x] V1 特效迁移到 fx/

## 已知 Bug / 技术债

| # | 类型 | 描述 | 优先级 | 状态 |
|---|------|------|--------|------|
| 1 | ~~Bug~~ | ~~roster.add 重复~~ | ~~中~~ | ✅ 已修（改纯 DB） |
| 2 | ~~Bug~~ | ~~roster.update 静默失败~~ | ~~低~~ | ✅ 已修（改纯 DB） |
| 3 | Bug | handleUpdateRoster 非法类型静默丢弃 | 低 | 待修 |
| 4 | Known Limitation | SqliteError code 字符串依赖 | 极低 | 不动 |

## 待做

### 近期
- [ ] Playwright e2e 测试
- [ ] Bug #3 修复
- [ ] 端到端联调（启动 server → 创建实例 → agent 用 mteam-mcp 工具完成任务）
- [ ] Team + Project（自动建 team、自动拉人、项目管理）
- [ ] comm 跨机（mlink 接入 + remote_peers + system handler）

### 中期
- [ ] 前端终端渲染（xterm.js + WebSocket 连 PTY）
- [ ] SSE 实时状态推送
- [ ] mnemo 内置（git submodule）
- [ ] 多 CLI adapter（Gemini/Codex/Trae 支持）
- [ ] 前端特效接入（liquid border + 触手）

### 长期
- [ ] mlink 跨机通信
- [ ] 设备名持久化（mteam 客户端启动时用户起名）
- [ ] MCP Store 一键安装（npm/pip 自动拉包）
- [ ] 总代理（mteam 的门面 agent，对外通信网关）

## 设计文档索引

| 文档 | 路径 |
|------|------|
| 项目结构改造计划 | packages/backend/docs/restructure-plan.md |
| Phase 1 数据库设计 | packages/backend/docs/phase1/README.md |
| Phase 1 项目结构 | packages/backend/docs/phase1/project-structure.md |
| Phase 1 接口设计 | packages/backend/docs/phase1/api-design.md |
| Phase 2 生命周期 | packages/backend/docs/phase2/README.md |
| comm 通信模块 | packages/backend/docs/comm/README.md |
| MCP Store | packages/backend/docs/mcp-store/README.md |
| mteam MCP 工具 | packages/backend/docs/mcp/README.md |
| roster 活跃名单 | packages/backend/docs/roster/README.md |
| CLI adapter 调研 | packages/backend/docs/cli-adapters/README.md |
| 旧代码清理方案 | packages/backend/docs/cleanup-plan.md |
| 角色模板定义 | docs/role-templates.md |

## 关键设计决策

1. **角色模板/实例分离** — 模板是配置，实例是运行时对象，生死一体（创建=spawn 进程，删除=kill 进程）
2. **状态机极简** — PENDING → ACTIVE → PENDING_OFFLINE → 物理删除，不要锁/预约码/心跳/nonce
3. **comm 是管道** — 只认地址，不管业务。寻址协议 [scope]:[id]
4. **roster 是 DAO** — 纯 DB 读写，不缓存，不做业务判断
5. **MCP Store 文件存储** — 每个 MCP 一个 JSON 文件，spawn 时取交集动态注入
6. **mteam MCP 内置不可卸载** — command="__builtin__"，其他 MCP 可装可卸
7. **成员不能自己下线** — 必须 leader 批准（request_offline → PENDING_OFFLINE → 才能 deactivate）
