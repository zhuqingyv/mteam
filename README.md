# mteam

多 Agent 团队协作平台。本地 Electron 桌面应用，让用户管理一支由多个 LLM Agent（Claude / Codex）组成的虚拟团队：用户对 Leader 说话，Leader 把活派给 Member，成员各跑在独立沙箱进程里，消息经统一总线流转，前端实时看到每个成员的思考过程。

## 架构

```
 ┌──────────── Frontend (React + Jotai) ─────────────┐
 │   HTTP REST                WebSocket /ws/events    │
 └──────┬────────────────────────┬───────────────────-┘
        │                        │ subscribe / prompt
        ▼                        ▼
 ┌── HTTP Server ──────┐  ┌── WS Handler ────────────┐
 │ routes/*  REST API   │  │ 订阅表 + 白名单过滤       │
 └──────┬──────────────┘  └──────┬───────────────────┘
        │                        │
        ▼                        ▼
 ┌─────────────────── 业务层 ──────────────────────────┐
 │  CommRouter.dispatch(envelope)                      │
 │    → message-store (SQLite)                         │
 │    → driverDispatcher (agent 通知)                  │
 │    → EventBus (RxJS) → subscribers (通知/过滤/聚合) │
 └──────┬──────────────┬──────────────┬───────────────┘
        ▼              ▼              ▼
 ┌ agent-driver ┐ ┌ process-runtime ┐ ┌ mcp-store ──────┐
 │ ACP 协议适配  │ │ Host / Docker   │ │ 外部 MCP (stdio) │
 │ Claude/Codex │ │ RuntimeHandle   │ │ 内置 MCP (HTTP)  │
 └──────┬───────┘ └────────────────┘ └─────────────────┘
        │ stdio NDJSON (ACP)
        ▼
  ┌─ agent 子进程 ─┐
  │ claude / codex  │
  └────────────────┘
```

## 已完成功能

- **Agent 团队管理** — 角色模板 / 实例 / 状态机（PENDING → ACTIVE → PENDING_OFFLINE → 删除），Team 原子 DAO + Leader 生死绑定
- **统一 ACP 协议** — Claude + Codex 双适配器，11 种 sessionUpdate 全覆盖，完全替代 PTY
- **沙箱化运行时** — DockerRuntime + HostRuntime 抽象层，Driver 只认 RuntimeHandle，业务零改动切容器
- **消息通信** — MessageEnvelope + ActorRef 统一结构，三路分发（DB 持久化 / agent stdin / 前端 WS），先落库再推送
- **WS 双工** — 精细订阅（global/team/instance/user scope）、prompt 投递、Turn 聚合（9 种 block）、断线重连 gap-replay
- **通知系统** — 三种代理模式（direct / proxy_all / custom），可见性与通知分离
- **业务过滤器** — 按角色/团队/用户裁剪事件流，白名单控制下行事件
- **安全策略** — 工具白名单 + 容器生命周期管理 + policy subscriber 权限校验

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript |
| 运行时 | Bun |
| 数据库 | bun:sqlite (SQLite) |
| 事件总线 | RxJS |
| 桌面 | Electron + React 19 + Vite |
| WebSocket | ws |
| Agent 协议 | ACP (Agent Client Protocol) |
| MCP | @modelcontextprotocol/sdk |

## 快速启动

```bash
# 前置：Bun, Node.js 20+
bun install
bun run dev        # 后端 + 前端一键启动
```

## 项目结构

```
packages/
├── backend/           # 后端服务 (HTTP + WS + EventBus + AgentDriver)
│   └── src/
│       ├── http/          # HTTP server + routes
│       ├── ws/            # WebSocket handler + broadcaster
│       ├── bus/           # RxJS EventBus + subscribers
│       ├── comm/          # CommRouter 消息分发
│       ├── agent-driver/  # ACP 适配层 (Claude / Codex)
│       ├── process-runtime/  # Host / Docker 运行时
│       ├── domain/        # 角色模板 / 实例 / 状态机
│       ├── notification/  # 通知代理 (proxy-router)
│       ├── filter/        # 可见性过滤
│       ├── mcp-store/     # 外部 MCP 管理
│       ├── mcp-http/      # 内置 MCP HTTP server
│       └── db/            # SQLite schema + 连接
└── renderer/          # 前端 (React + Vite + Jotai)
```

## 前端对接

完整 API 文档见 [`docs/frontend-api/INDEX.md`](docs/frontend-api/INDEX.md)，包含：

- WebSocket 协议（subscribe / prompt / ping / 事件推送）
- 全部 HTTP REST 端点（消息 / 实例 / 花名册 / 团队 / 模板 / MCP / Turn）
- 数据结构速查（Envelope / TurnBlock / RosterEntry 等）
- 典型场景链路图

## 路线图

| Issue | 方向 |
|---|---|
| [#20](https://github.com/zhuqingyv/mteam/issues/20) | MessageGateway — 消息调度中心 + mlink 多机预留 |
| [#21](https://github.com/zhuqingyv/mteam/issues/21) | Settings Registry — Schema 驱动的动态设置系统 |
| [#22](https://github.com/zhuqingyv/mteam/issues/22) | ActionItem — 统一待办系统（任务/审批/验收/决策） |
| [#23](https://github.com/zhuqingyv/mteam/issues/23) | 账号体系 — 本地免登录 + 注册解锁远程能力 |
| [#24](https://github.com/zhuqingyv/mteam/issues/24) | 中继服务器部署 + 远程认证方案 |
| [#25](https://github.com/zhuqingyv/mteam/issues/25) | 语音系统 — 声纹认证 + 语音交互 + 语音播报 |
| [#3](https://github.com/zhuqingyv/mteam/issues/3)   | 安全密码箱 — Passkey 认证 + 代理注入 |

## 贡献

设计文档、模块方案、接口契约均在 [`docs/`](docs/) 目录。

## License

MIT
