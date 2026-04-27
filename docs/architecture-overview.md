# mteam 整体架构总览

> **面向**：后端开发者（模块总览）+ 前端对接人员（通读以理解三方数据流）。具体接口按面向维度拆分见 `frontend-api/*`。

## 一句话定位

**mteam** 是一个 Electron 桌面应用，让用户同时管理一支由多个 LLM Agent（Claude / Codex …）组成的"虚拟团队"：用户对 Leader 说话，Leader 把活派给 Member，Member 各跑在独立进程里，消息全部经由一条总线流转，前端实时看到每个成员的思考过程。后端是 Node.js 单进程（HTTP + WS + Unix Socket + MCP），数据落 SQLite，前端是 React Web 面板。

---

## 大 ASCII 架构图

```
 ┌─────────────── Frontend (React + Jotai) ──────────────────────────┐
 │   HTTP fetch (REST)              WebSocket /ws/events              │
 └──────┬───────────────────────────────┬────────────────────────────┘
        │                               │ subscribe / prompt / ping
        ▼                               ▼
 ┌── HTTP Server (58590) ──────┐  ┌── WS upgrade + handler ─────────┐
 │ router.ts → routes/*         │  │ ws-handler  (上行路由)           │
 │ /api/panel/*  /api/messages/*│  │ ws-broadcaster (下行过滤推送)    │
 │ /api/teams/*  /driver/:id/…  │  │ subscription-manager (订阅表)    │
 └──────┬───────────────────────┘  └──────┬─────────────┬────────────┘
        │                                 │ 白名单过滤   │ 可见性过滤
        │                                 ▼             ▼
        │                       ┌── filter/visibility-filter ──┐
        │                       └──────────────┬───────────────┘
        ▼                                      │
 ┌──────────────── 业务层 ───────────────────────────────────────────┐
 │                                                                  │
 │  CommRouter.dispatch(envelope) ──┐                                │
 │    ├─ system handler              │  ┌── EventBus (RxJS) ────┐   │
 │    ├─ driverDispatcher ──────────┤  │                        │   │
 │    │    (notifyLine → prompt)    ├─►│ emit comm.* driver.*   │   │
 │    └─ socket write (legacy)      │  │ turn.* team.* role.*   │   │
 │                                  │  └──┬────────┬──────┬─────┘   │
 │  message-store (SQLite 同步) ────┘     ▼        ▼      ▼         │
 │                                 turn-aggregator  notify   log …   │
 │                                 (→turn.*)  (→proxy-router)        │
 └──────┬──────────────────────┬──────────────────┬──────────────────┘
        │                      │                  │
        ▼                      ▼                  ▼
 ┌ agent-driver ┐   ┌ process-runtime ┐   ┌ mcp-store / mcp-http ──────────┐
 │ AgentDriver  │   │ HostRuntime     │   │ mcp-manager (外部 stdio)        │
 │  + Claude /  │──►│ DockerRuntime    │   │ mteam (成员/Leader 用)          │
 │    Codex     │   │ spawn/kill/exit  │   │ mteam-primary (主 Agent 专属)   │
 │  (ACP JSON)  │   └──────┬──────────┘   │ searchTools                     │
 └──────┬───────┘          │              │ (内置 Streamable HTTP :58591)   │
        │ stdio NDJSON     │              └────────────────────────────────┘
        │ (ACP v0.20)     │
        ▼                  ▼
  ┌──────────────────┐  ┌──────────────────────────────────┐
  │ agent 子进程(host)│  │ agent 容器(docker)                │
  │ claude/codex/…   │  │ host.docker.internal:58591/mcp/* │
  └──────────────────┘  └──────────────────────────────────┘
```

---

## 模块清单

| 模块 | 一句话 |
|------|------|
| `http/` | HTTP 入口，`server.ts` 组装所有子系统；`router.ts` 分派到 `routes/*`。|
| `ws/` | WebSocket 上行（subscribe/prompt/ping）+ 下行广播 + 订阅表。|
| `bus/` | RxJS EventBus，跨模块唯一"广播协议"；12 个 subscriber 消费事件做副作用。|
| `comm/` | `CommRouter.dispatch` 是消息唯一入口，同步落 SQLite 再推流；agent→agent/user→agent 都走这里。|
| `filter/` | 可见性过滤：按 user/instance/team 规则决定一个 WS 订阅者能看哪些事件。|
| `notification/` | 通知代理：决定 Member 事件"谁收"（direct / proxy_all / custom）。|
| `process-runtime/` | 子进程抽象层：HostRuntime 本机 spawn、DockerRuntime 容器（`TEAM_HUB_RUNTIME_KIND=docker` 切换），Driver 只认 `RuntimeHandle`。主 Agent 和成员 agent 均支持 host/docker 两种 runtime。|
| `agent-driver/` | ACP 协议适配层：initialize → newSession → prompt；适配 Claude / Codex。|
| `mcp-store/` | 外部 MCP 清单与 stdio 进程管理（npx / uvx / 自定义）。|
| `mcp-primary/` | 主 Agent 专属 MCP server（mteam-primary）：`create_leader` / `send_to_agent` / `list_addresses` / `get_team_status`。|
| `mcp-http/` | 内置 mteam / mteam-primary / searchTools MCP 的 Streamable HTTP Server（:58591），容器里 agent 通过 `host.docker.internal:58591/mcp/*` 反向访问。|
| `member-agent/` | Member driver 的配置与 prompt 组装。|
| `primary-agent/` | 主 Agent（对外通信门面+通知代理目标）的生命周期与 MCP 注入（通过 `mcpManager.resolveForPrimary()` 注入 mteam-primary + searchTools + mnemo）。|
| `http/routes/` | cli / instances / mcp-tools / messages / primary-agent / roster / sessions / teams / templates / driver-turns 共 10+ REST 模块。|
| `roster/` `team/` `domain/` | role 实例与团队状态的领域模型与持久化。|

---

## 产品场景数据流（用户视角）

### A · 打开 App 到连上后端

```
用户双击 App → Electron 拉起 backend 子进程
  → backend: http.createServer + comm.start(Unix sock)
             + mcpManager.boot() + primaryAgent.boot() + bootSubscribers()
  → 前端加载 → GET /api/panel/roster (初始化列表)
  → new WebSocket('ws://localhost:58590/ws/events')
  → ws.send({op:'subscribe', scope:'user', id:<userId>}) → ack
```

连上后前端就从 `/ws/events` 实时收归属自己的 bus 事件。

### B · 给一个 Agent 发消息（核心链路）

```
前端:  ws.send({op:'prompt', instanceId:'bob', text:'帮我写脚本'})
         │
         ▼
ws-handler.handlePrompt
  → lookupAgent + driver.isReady() 校验
  → buildEnvelope(from=user:<uid>, to=local:bob, content=text)
  → CommRouter.dispatch(env)
       ├─ messageStore.insert(env)                  (同步落库)
       ├─ emit comm.message_sent                    (EventBus)
       └─ driverDispatcher(bob, notifyLine)         (带 [msg_id=<id>])
              ↓
          AgentDriver.prompt → ACP conn.prompt(sessionId, text)
              ↓ (agent 回吐 sessionUpdate × N)
          adapter.parseUpdate → emit driver.thinking/text/tool_call/...
              ↓
          turn-aggregator → emit turn.block_updated / turn.completed
              ↓
        ws-broadcaster（白名单+可见性过滤）→ ws.send({type:'event', …})
              ↓
          前端 driverStore 按 blockId upsert 渲染流式输出
```

**关键**：`store.insert` 必须同步于 dispatch 前。Agent 下一轮可能立刻 `read_message MCP(msg_id)`，DB 必须已有行，否则 404。

### C · 主 Agent 建团队 + Leader 派活给 Member（agent→agent）

```
用户对主 Agent 说"帮我建个团队做 X"
  → 主 Agent tool_call: mteam-primary.create_leader(...)  // 专属 MCP
  → HTTP 创建 Leader instance + Team → bus 事件 → WS 广播

Leader (Claude) 产出 tool_call: mteam.send_msg(to='local:bob', text='做X')  // 成员 MCP
  → stdout → mcp-http/mteam-handler
  → CommRouter.dispatch(envelope{from=local:leader, to=local:bob})
  → driverDispatcher(bob, …) → Member Bob 的 driver.prompt
  → Bob 的 driver.* / turn.* 回到 bus
  → 按可见性，Leader 可收 turn 摘要；用户按订阅范围也看得到
```

### D · 通知代理（三档）

Member 产生关键事件（turn_done / policy.violation 等）时，`proxy-router` 按策略分流：

- **direct**：事件直推前端（当前用户可见性内）。
- **proxy_all**：打包成 notification 投给 Leader，Leader 决定是否回复/升级；Leader 离线时 fallback 回 direct。
- **custom**：规则表自顶向下首命中。

切换策略不重启 driver，只换规则表。

---

## 关键设计决策

1. **消息先同步落库再推送**。`CommRouter.dispatch` 里 `store.insert` 走在 dispatch 前。*理由*：agent 的 notifyLine 带 `[msg_id=<id>]`，Agent 下一轮可能立刻 `read_message`，DB 必须已有行。
2. **EventBus 是后端唯一"广播协议"**。跨模块禁止直接调用，必须 emit/subscribe。*理由*：订阅方可热插拔（notification / policy / container / turn-aggregator 都是订阅者）。
3. **ACP 替代 PTY**。agent 通信走 `@agentclientprotocol/sdk` ndjson（stdin/stdout），不再解析终端控制字符。*理由*：结构化可靠，一套代码管 Claude/Codex/Qwen。
4. **process-runtime 抽象掉 Host/Docker**。Driver 只认 `RuntimeHandle`。*理由*：沙箱化可无感切容器，业务代码零改动。
5. **内置 MCP 走 HTTP，外部 MCP 走 stdio**。mteam / mteam-primary / searchTools 在 backend 同进程开 Streamable HTTP（:58591）；store 里 npx/uvx 仍 stdio。*理由*：容器内 agent 用 `host.docker.internal:58591/mcp/*` 反向访问，免自研 bridge。
6. **可见性与通知分离**。可见性过滤在出口（WsBroadcaster），通知代理决定"谁收"（ProxyMode）。*理由*：同事件对不同用户可见性可能不同，订阅端决定比发布端决定更简单正确。
7. **Turn 不持久化**。Hub 重启即丢；历史走 HTTP 快照 `GET /api/panel/driver/:id/turns` + 前端 localStorage。*理由*：turn 是瞬时聚合产物，持久化成本远高于收益。

---

**阅读顺序**：`bus/events.ts` → `comm/router.ts` → `agent-driver/driver.ts` → `ws/ws-handler.ts` → `http/server.ts` → `notification/proxy-router.ts`。更细的协议/事件目录见 `frontend-api/*`。
