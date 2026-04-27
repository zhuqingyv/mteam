# mteam 项目进度

## 项目概述

mteam 是多 agent 团队协作平台。管理角色模板/实例、进程生命周期、agent 间通信、MCP 工具注入。

## 技术栈

- 后端：TypeScript + bun:sqlite + RxJS（事件总线）+ Unix socket + WebSocket（ws）
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
│   │   ├── bus/            # RxJS 事件总线（EventBus + 6 个 subscriber + WS 推送）
│   │   ├── domain/         # 领域对象（角色模板、角色实例、状态机）
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
- [x] 事件系统（RxJS EventBus，16 种强类型事件，WebSocket 推送）
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
- [x] 后端单测 301/301 通过（bun:test）
- [x] 覆盖：state-machine + role-template + role-instance + roster + API handlers + HTTP server + EventBus + subscriber + 集成 + team DAO + team subscriber + team 集成 + 全接口 HTTP 集成测试 + WebSocket 组合测试
- [x] HTTP 集成测试 6 组（真实 server + fetch，覆盖全部 28 个接口）
- [x] WebSocket + HTTP 组合测试 8 用例（连 WS 收事件 + HTTP 操作，覆盖 team 生命周期 7 个 Case）
- [x] Playwright e2e 15/15 通过（模板 3 + 实例 4 + 花名册 4 + MCP Store 4）

### RxJS 事件总线（Phase 3）
- [x] EventBus 核心（Subject<BusEvent> + 16 种强类型事件 + on/onPrefix/emit/destroy）
- [x] 6 个 subscriber（roster / pty / domain-sync / comm-notify / log / ws-broadcaster）
- [x] handler 解耦（role-instances / sessions / templates / mcp-store 副作用改 emit）
- [x] WebSocket 推送（ws 包 + /ws/events upgrade，前端就绪）
- [x] 旧代码清理（删 EventEmitter + 手动 roster sync）
- [x] 修复 handleRegisterSession activate 后 roster 未同步的 bug

### Team 模块（Phase 4）
- [x] team DAO（create/disband/addMember/removeMember/listMembers/findByInstance/findActiveByLeader）
- [x] team.subscriber（5 个订阅：instance.offline_requested/deleted/created + team.disbanded/member_left）
- [x] 生命周期联动（leader 下线→成员跟随下线、踢人→成员下线、手动 disband→级联）
- [x] 防循环（reason 分流 + findByInstance 过滤 ACTIVE）
- [x] CASCADE 时序处理（event payload 快照 teamId+isLeader + role_instances.team_id 反查）
- [x] 一个 leader 只能有一个 ACTIVE team（partial unique index + DAO 校验 + API 409）
- [x] 前端 TeamPanel（创建/展开成员/添加移除/解散）
- [x] HTTP API 7 端点 /api/teams
- [x] bus 事件 4 种（team.created/disbanded/member_joined/member_left）+ WS 推送

### 基础设施
- [x] better-sqlite3 → bun:sqlite（全栈 bun）
- [x] 后端 CORS 支持（前端跨域调用）
- [x] bun --watch 热更新
- [x] 前端 activate + request-offline 按钮补齐
- [x] DB 建表外键顺序修复（PRAGMA foreign_keys=OFF/ON 包裹）
- [x] 默认端口 58580→58590 避免冲突
- [x] 前端端口 5180（避免与 AionUi 5173 冲突）
- [x] 一键启动 `bun run dev`（后端+前端）

### 项目结构改造
- [x] 旧代码全删（hub.ts/panel/旧 docs）
- [x] v2 平铺到 src/（v2 目录消失）
- [x] mteam-mcp → mcp 改名
- [x] docs 提到包级
- [x] mcp-server → backend 改名
- [x] V1 特效迁移到 fx/

### Phase 5 — 沙箱化 + ACP 统一（34 模块）
- [x] process-runtime 抽象层（HostRuntime / DockerRuntime 双实现，统一 RuntimeHandle 接口）
- [x] AgentDriver 解耦 runtime（注入 RuntimeHandle，不再直接依赖 PTY）
- [x] 成员 Agent 迁移 ACP 协议（完全废弃 PTY 通信路径）
- [x] 内置 mteam MCP 迁移 Streamable HTTP（stdio → HTTP，支持远程接入）
- [x] 安全策略订阅器（container.subscriber 生命周期管理 + policy.subscriber 权限校验）
- [x] server.ts 拆包（423 行 → 11 个文件，职责单一）
- [x] node-pty 依赖标记废弃（pty.subscriber 删除）

### Phase 6 — 通信管道（14 模块）
- [x] MessageEnvelope + ActorRef 统一数据结构（取代裸 string 地址）
- [x] 消息三路分发（agent 通知行 / 前端 JSON / DB 持久化并行）
- [x] mteam MCP 工具改造（send_msg / read_message / check_inbox 适配 envelope）
- [x] 前端 HTTP API（消息 CRUD + 按会话分页查询）
- [x] DB migration（messages 表 + 索引）

### Phase 7 — WS 双工 + 过滤器 + 通知（14+ 模块）
- [x] WS 精细订阅协议（subscribe / unsubscribe / prompt / ping 四类消息）
- [x] 业务过滤器（visibility rules，按角色/团队/可见性裁剪事件流）
- [x] 通知系统三种代理模式（direct / proxy_all / custom）
- [x] 用户注册 comm 地址（SocketShim 把浏览器会话桥入 comm 网络）
- [x] Turn 聚合器（11 种 sessionUpdate → 9 种 TurnBlock，前端渲染友好）
- [x] Claude adapter 补全（4 → 11 种 sessionUpdate 全覆盖）
- [x] Codex adapter 补全（4 → 11 种 sessionUpdate 全覆盖）
- [x] HTTP Turn 快照接口（GET /api/panel/driver/:id/turns，断线重连恢复）
- [x] WS 白名单切换（driver.* 生命周期保留 + turn.* 聚合事件替换零散事件）

### 前端对接文档（14 份）
- [x] `docs/architecture-overview.md` — 整体架构总览 + 大 ASCII 图 + 关键设计决策
- [x] `docs/frontend-api/ws-protocol.md` — WS 上下行协议 + 4 种错误码
- [x] `docs/frontend-api/bus-events.md` — 34+ bus 事件类型
- [x] `docs/frontend-api/message-flow.md` — 消息三路分发（DB / agent / 前端）
- [x] `docs/frontend-api/turn-events.md` — Turn 聚合前端对接 + 9 种 block 渲染
- [x] `docs/frontend-api/notification-and-visibility.md` — 通知 + 可见性规则
- [x] `docs/frontend-api/notification-config.md` — 通知配置接口（HTTP 端点建议）
- [x] `docs/frontend-api/messages-api.md` / `roster-api.md` / `teams-api.md` / `instances-api.md`
- [x] `docs/frontend-api/templates-and-mcp.md` / `primary-agent-api.md` / `sessions-and-auth.md`

## 已知 Bug / 技术债

| # | 类型 | 描述 | 优先级 | 状态 |
|---|------|------|--------|------|
| 1 | ~~Bug~~ | ~~roster.add 重复~~ | ~~中~~ | ✅ 已修（改纯 DB） |
| 2 | ~~Bug~~ | ~~roster.update 静默失败~~ | ~~低~~ | ✅ 已修（改纯 DB） |
| 3 | Bug | handleUpdateRoster 非法类型静默丢弃 | 低 | 待修 |
| 4 | Known Limitation | SqliteError code 字符串依赖 | 极低 | 不动 |
| 5 | ~~Bug~~ | ~~删 leader instance 返回 500（pty.subscriber kill 相关）~~ | ~~中~~ | ✅ 已修（Phase 5 废弃 PTY） |
| 6 | Known Limitation | team.create 不自动加 leader 到 team_members，需手动 addMember | 低 | 设计如此，可优化 |

## 待做

### 近期
- [ ] comm + mlink 多机通信（Issue #20 + MessageGateway，远端 peer 路由）
- [ ] 前端正式 UI（聊天界面 + Turn 渲染，替换当前测试面板）
- [ ] 端到端联调（启动 server → 创建团队 → agent 完成真实任务闭环）
- [ ] 通知配置 HTTP 端点（三种代理模式可配置）
- [ ] node-pty 依赖清理确认（package.json + import 残留扫描）
- [ ] Bug #3 修复（handleUpdateRoster 非法类型静默丢弃）
- [ ] Project 模块（更高层业务概念，与 team 解耦）

### 中期
- [ ] mnemo 内置（git submodule）
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
| RxJS 事件总线设计 | docs/rxjs-event-bus-design.md |
| Team 模块技术方案 | docs/teams/team-manager-design.md |
| Team 生命周期联动方案 | docs/teams/team-lifecycle-sync.md |
| MCP 动态注入机制 | docs/mcp-dynamic-injection-design.md |
| 整体架构总览 | docs/architecture-overview.md |
| Phase ws 任务清单 | docs/phase-ws/TASK-LIST.md |
| Phase ws Turn 聚合方案 | docs/phase-ws/turn-aggregator-design.md |
| Phase comm 任务清单 | docs/phase-comm/TASK-LIST.md |
| 前端对接目录 | docs/frontend-api/ |

## 关键设计决策

1. **角色模板/实例分离** — 模板是配置，实例是运行时对象，生死一体（创建=spawn 进程，删除=kill 进程）
2. **状态机极简** — PENDING → ACTIVE → PENDING_OFFLINE → 物理删除，不要锁/预约码/心跳/nonce
3. **comm 是管道** — 只认地址，不管业务。寻址协议 [scope]:[id]
4. **roster 是 DAO** — 纯 DB 读写，不缓存，不做业务判断
5. **MCP Store 文件存储** — 每个 MCP 一个 JSON 文件，spawn 时取交集动态注入
6. **mteam MCP 内置不可卸载** — command="__builtin__"，其他 MCP 可装可卸
7. **成员不能自己下线** — 必须 leader 批准（request_offline → PENDING_OFFLINE → 才能 deactivate）
8. **RxJS 事件总线** — handler 只做 domain 操作 + emit，副作用由 subscriber 自动触发，模块间零耦合
9. **WebSocket 推前端** — bus 事件通过 /ws/events 实时推送，前端不再轮询
10. **Team 是原子 DAO** — 只管"谁和谁一组"，不绑 project，不做业务编排
11. **Leader 和 team 生死绑定** — leader 下线→team 解散→成员跟随下线；成员走光不解散（leader 可再拉人）
12. **WebSocket + HTTP 组合测试** — 后续所有功能测试标准：连 WS 收事件 + HTTP 模拟操作 + 验证响应和事件
