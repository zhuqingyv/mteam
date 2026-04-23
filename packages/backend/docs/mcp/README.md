// filepath: packages/mcp-server/src/v2/docs/mcp/README.md
# mteam MCP — agent 调用 V2 能力的内置 MCP

mteam MCP 是内置的 stdio MCP server。agent CLI 启动时作为子进程拉起，给 agent 提供「激活自己 / 下线自己 / 给别人发消息 / 查收件箱 / 请求他人下线（仅 leader）/ 查找通信目标」六件事。

---

## 1. 概述

**是什么**

一个 MCP server（stdio / JSON-RPC）。跑在 agent CLI 的子进程里，不是 V2 server 进程内。

**跟 V2 server 怎么连**

| 能力 | 通道 | 原因 |
|---|---|---|
| activate / deactivate | HTTP → V2 server `/api/role-instances/...` | 需要写 DB，走已有的 REST 层最自然 |
| send_msg / check_inbox | Unix socket → comm server | comm 本来就用 socket，直接复用 |

**身份来自 env**

agent 子进程从 env 拿以下值，mteam MCP 继承这份 env：

- `ROLE_INSTANCE_ID` — 自己是谁
- `TEAM_HUB_COMM_SOCK` — comm socket 路径（pty/manager.ts 注入）
- `V2_SERVER_URL` — V2 server base URL（默认 `http://localhost:${V2_PORT}`）

---

## 2. 六个工具

### activate

agent 启动后第一件事。把自己从 PENDING 推到 ACTIVE。

- **inputSchema**：`{}`（无参数，instance_id 从 env 读）
- **实现**：`POST ${V2_SERVER_URL}/api/role-instances/${ROLE_INSTANCE_ID}/activate`
- **返回**：
  ```json
  { "status": "ACTIVE", "persona": "...", "task": "...", "leaderName": "..." }
  ```
- **错误**：V2 返回 4xx/5xx 时，透传 `{ error: "<msg>" }`

### deactivate

agent 收到 leader 下线批准后自觉退出。**只有 PENDING_OFFLINE 状态才能调用成功**。

- **inputSchema**：`{}`
- **实现**：`DELETE ${V2_SERVER_URL}/api/role-instances/${ROLE_INSTANCE_ID}`
- **前置**：当前实例 `status === 'PENDING_OFFLINE'`。
  - `status === 'ACTIVE'` → V2 返回 409，MCP 透传 `{ error: "需要 leader 批准下线" }`
  - `status === 'PENDING'` → V2 返回 409，MCP 透传 `{ error: "尚未 activate，不能 deactivate" }`
- **返回**：`{ "status": "deleted" }`
- **语义**：agent 不能自己决定下线；必须由 leader 通过 `request_offline` 把状态推到 `PENDING_OFFLINE`，成员才能走完这步。

### request_offline

leader 批准某个成员下线。仅 leader 实例可调（`is_leader = 1`），普通成员调用 V2 返回 403。

- **inputSchema**：
  ```json
  {
    "instanceId": { "type": "string", "description": "目标成员的 role_instances.id" }
  }
  ```
- **实现**：`POST ${V2_SERVER_URL}/api/role-instances/${instanceId}/request-offline`
- **V2 侧处理**：
  1. 校验调用者（`ROLE_INSTANCE_ID` 从 env 读，由 MCP 透传到 header 或 body）对应的实例 `is_leader = 1`，否则 403。
  2. 目标实例 `status` 必须为 `ACTIVE`；否则 409（`PENDING` / `PENDING_OFFLINE` / 不存在）。
  3. 原子事务：`UPDATE role_instances SET status='PENDING_OFFLINE', status_since=now WHERE id=?` + 写 `role_state_events(from='ACTIVE', to='PENDING_OFFLINE', trigger_event='request_offline', actor=<leader instanceId>)`。
  4. 通过 comm socket 推一条系统消息给目标：`{ summary: "leader 批准你下线", content: "你已进入 PENDING_OFFLINE，请调用 deactivate 完成退出。" }`（走 comm 的正常 `message` 流，`from=system:v2`）。
- **返回**：`{ "status": "PENDING_OFFLINE" }`
- **错误**：403 / 409 透传为 `{ error: "<msg>" }`。

### send_msg

给另一个 agent 发消息。

- **inputSchema**：
  ```json
  {
    "to": { "type": "string", "description": "目标 memberName 或 instanceId" },
    "summary": { "type": "string", "maxLength": 200 },
    "content": { "type": "string" }
  }
  ```
- **实现**：
  1. `to` 若是 memberName，先 `GET /api/role-instances` 找到对应 instanceId（阶段一简化：只接收 instanceId，后面再加 memberName 解析）
  2. 连 comm socket，发 `register { address: "local:${ROLE_INSTANCE_ID}" }`（若未连过）
  3. 发 `message` 消息：`from=local:<self>`、`to=local:<peer>`、`payload={ summary, content }`
  4. 等 `ack`
- **返回**：`{ "delivered": true }`（ack 收到即成功；在线/离线由 comm 自己判断）

### check_inbox

看自己的收件箱。

- **inputSchema**：
  ```json
  { "peek": { "type": "boolean", "default": false } }
  ```
- **实现**：调 V2 server 读 `messages` 表
  - `GET /api/role-instances/${ROLE_INSTANCE_ID}/inbox?peek=<bool>`（V2 要加这个路由）
  - 不 peek → 同时 mark read（更新 `read_at`）
- **返回**：
  ```json
  { "messages": [ { "id": "...", "from": "...", "summary": "...", "content": "...", "ts": "..." } ] }
  ```

> 为什么 check_inbox 走 HTTP 而不是 socket？socket 是推送型（comm 已经在 register 时 replay 过未读），这里提供一个「主动拉一次」的入口，实现简单、幂等、不依赖长连接状态。

### lookup

查找通信目标。**默认模糊匹配 alias**，没设 alias 时 fallback 到 member_name，支持按范围过滤（team / local / remote）。

- **inputSchema**：
  ```json
  {
    "query": { "type": "string", "description": "搜索关键词，默认模糊匹配 alias；alias 未设置时 fallback 到 member_name" },
    "scope": {
      "type": "string",
      "enum": ["team", "local", "remote"],
      "description": "可选。team=当前 team 内的成员；local=本机所有活跃实例；remote=远程设备（remote_peers 表）。不填则三者合并"
    }
  }
  ```
- **搜索字段**：
  - 本机实例（`role_instances`）：优先匹配 `alias LIKE '%query%'`；由于 alias 默认 = member_name（插入时兜底），等价于同时覆盖 member_name 的模糊搜索。
  - 远程 peers（`remote_peers`）：同上，匹配 `alias LIKE '%query%'`。
  - 为了兼容历史数据中 alias 为空的情况，SQL 写成 `WHERE COALESCE(alias, member_name) LIKE '%query%'`，保证备注名和原名都能被搜到。
- **实现逻辑**：
  - `scope === 'team'`：`team_members` JOIN `role_instances`，`WHERE COALESCE(role_instances.alias, role_instances.member_name) LIKE '%query%'`
  - `scope === 'local'`：`role_instances` 活跃实例，`WHERE COALESCE(alias, member_name) LIKE '%query%'`
  - `scope === 'remote'`：`remote_peers` 表，`WHERE COALESCE(alias, member_name) LIKE '%query%'`
  - 不填 `scope`：三个都查，合并结果（本机 + 远程 peers 合并成一张"活跃成员名单"，详见 §7）
- **返回**：
  ```json
  // 唯一匹配
  { "match": "unique", "target": { "name": "...", "alias": "...", "address": "...", "scope": "team|local|remote", "status": "..." } }

  // 多个匹配
  { "match": "multiple", "candidates": [ { "name": "...", "alias": "...", "address": "...", "scope": "...", "status": "..." } ] }

  // 没匹配
  { "match": "none", "query": "<原始 query>" }
  ```
- **与 send_msg 的关系**：
  - `send_msg` 内部调 `lookup` 解析 `to`（走 alias 优先的模糊匹配）
  - 唯一匹配 → 直接发
  - 多个匹配 → 返回错误「有多个匹配，请指定具体名字（alias 或 member_name）或 instance_id」
  - 0 个匹配 → 返回错误「找不到目标」

> **alias 语义**：alias 是成员的"备注名"，默认 = member_name，可由上层工具或 Panel 修改。本机实例物理删除时 alias 随之消失；远程 peer 断开连接后 alias 保留在 `remote_peers` 表中，直到被清理策略删除。搜索必须同时覆盖 alias 和 member_name（见 `COALESCE` 写法），才能让改过名的人也能按原名找到。

---

## 3. 文件结构

```
v2/mteam-mcp/
├── server.ts          # stdio MCP server 主入口（@modelcontextprotocol/sdk）
├── tools/
│   ├── activate.ts
│   ├── deactivate.ts
│   ├── send_msg.ts
│   ├── check_inbox.ts
│   ├── request_offline.ts
│   └── lookup.ts
├── comm-client.ts     # 连 comm socket 的轻客户端（register / send / ack 等待）
├── http-client.ts     # 调 V2 server 的 fetch 封装（读 V2_SERVER_URL）
└── index.ts           # 可执行入口：`node v2/mteam-mcp/index.js`
```

每个 tool 文件 < 80 行，只做参数校验 + 调用 client + 格式化返回。

---

## 4. spawn 时怎么起

当前 `pty/manager.ts` 对 `command === '__builtin__'` 的处理是内联的 `node -e` 脚本（仅 `fetch register` 后 `stdin.resume()`，没有任何 MCP 工具）。**要改掉**。

改成：

```ts
if (cfg.command === '__builtin__') {
  mcpServers[name] = {
    command: process.execPath,
    args: [join(__dirname, '../mteam-mcp/index.js')],
    env: {
      ROLE_INSTANCE_ID: opts.instanceId,
      TEAM_HUB_COMM_SOCK: process.env.TEAM_HUB_COMM_SOCK ?? '',
      V2_SERVER_URL: hubUrl,
    },
  };
}
```

注意 `TEAM_HUB_COMM_SOCK` 必须由 V2 server 启动时写到自己的 env（comm server 启动时拿到 path 后 `process.env.TEAM_HUB_COMM_SOCK = path`），pty manager 再从 env 透传。

---

## 5. V2 server 新增路由

现有路由：`GET/POST /api/role-instances`、`DELETE /api/role-instances/:id`（见 `v2/api/panel/role-instances.ts`）。

需要新加三条：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/role-instances/:id/activate` | 调 `RoleInstance.findById(id).activate(actor=null)`，`PENDING → ACTIVE`，返回 `{ status, persona, task, leaderName }`。persona 从 `RoleTemplate.findByName(templateName).persona` 取。|
| `POST` | `/api/role-instances/:id/request-offline` | leader 批准目标成员下线。校验调用者 `is_leader=1`；目标 `status=ACTIVE` → `PENDING_OFFLINE`；写 `role_state_events`；通过 comm 推系统消息通知目标。返回 `{ status: 'PENDING_OFFLINE' }`。非 leader 403；目标非 ACTIVE 409。|
| `DELETE` | `/api/role-instances/:id` | **行为更新**：要求目标 `status = PENDING_OFFLINE` 才允许物理删除（原有接口沿用）；`ACTIVE` → 409（`需要 leader 批准下线`）；`PENDING` → 409。Panel 侧管理员操作可带 `?force=1` 绕过（内部仍走 crash 路径，写 `role_state_events`）。|
| `GET`  | `/api/role-instances/:id/inbox?peek=<bool>` | 读 `messages` 表 `to_instance_id = id`；peek=false 时 UPDATE `read_at`。|

实现放在 `v2/api/panel/role-instances.ts` 里同一组 handler。

调用者身份识别：`request-offline` 依赖调用者 instanceId。MCP 侧从 env 的 `ROLE_INSTANCE_ID` 读出，随请求发送给 V2（例如 `X-Role-Instance-Id` header 或 body 里带）；V2 侧据此查 `is_leader` 判权限。

---

## 6. 活跃成员名单

mteam 对外（lookup / send_msg / Panel）呈现的"谁现在在线"是本机实例和远程 peers 合并后的统一视图，而不是两张表拼接。调用方不需要关心数据来自哪张表。

**活跃成员名单 = 本地实例（`role_instances`，当前 ACTIVE / PENDING / PENDING_OFFLINE）+ 远程 peers（`remote_peers`，`status = online`）**

统一视图字段：

| 字段 | 来源 |
|------|------|
| `instance_id` | 本地：`role_instances.id` ／ 远程：`remote_peers.id` |
| `member_name` | 本地：`role_instances.member_name` ／ 远程：`remote_peers.member_name` |
| `alias` | 本地：`role_instances.alias`（默认 = member_name）／ 远程：`remote_peers.alias`（默认 = member_name） |
| `scope` | `local` ／ `remote` |
| `status` | 本地：`PENDING` / `ACTIVE` / `PENDING_OFFLINE` ／ 远程：`online` / `offline` |
| `address` | 本地：`local:${instance_id}` ／ 远程：`${app_uuid}:${instance_id}` |

生命周期规则：

- **alias 默认**：创建实例 / 收到远程 peer 上线消息时，若未显式设置 alias，DB 层用 `member_name` 兜底写入。保证查询永远不需要处理 `alias IS NULL`。
- **本地实例下线**：物理删除 `role_instances` 行，alias 随之自然消失（见 phase2 `deactivate` / `crash` 路径）。
- **远程 peer 断开**：`remote_peers.status` 置为 `offline`，但 alias 保留，直到被清理策略（例如超过 N 天未上线）删除。这样即便对端重连，Panel 上的备注名不丢。
- **搜索路径**：`lookup` 和 `send_msg` 的 `to` 解析都走这张统一视图，按 `alias` 优先模糊匹配（用 `COALESCE(alias, member_name)` 兜底旧行），原名也能被搜到。

> 实现建议：在查询层写一个 `getActiveMemberRoster(scope?)` helper（放在 `v2/domain/roster.ts` 或 API 层），统一 SELECT + UNION，供 lookup / Panel / send_msg 复用；不要各自拼 SQL。

---

## 7. TODO（后续阶段）

- **mteam 客户端启动时让用户起名字**：首次运行时询问 `alias`，按设备持久化（落到 `~/.claude/team-hub/client-identity.json` 之类的文件），后续 spawn 出的每个实例默认继承这个 alias。本期不做，先用 `alias = member_name` 兜底。

---

## 8. 不做（本阶段）

- 不做 `search_tools`（发现其他 agent / 查 team / 查 project）
- 不做 `create_team` / `assign_task`（只 leader 该有的能力，后面加权限）
- 不做跨机 `to` 地址（scope ≠ `local` 由 mlink 兜底，mteam 不关心）
- 不做权限校验（ACL 在 V2 server 层加，不在 MCP 侧）
- 不做离线消息 replay（comm 的 register 流程已经替 agent 做了）
- 不做 alias 的唯一性约束（允许重名；模糊匹配命中多个时返回 `match: "multiple"` 让调用方消歧）
- 不做客户端 alias 持久化（见 §7 TODO）
