# comm — agent 消息总线

comm 是 agent 之间收发消息的底层通信模块。通过 Unix socket 在本机 agent 之间传递消息。

---

## 1. 概述

**comm 是什么**

agent 之间的消息总线。提供「从 instance A 发一条消息到 instance B」的能力。

**comm 不是什么**

- 不管 team（谁和谁在一个组）
- 不管角色（architect / coder / reviewer）
- 不管业务逻辑（审查、结对、任务分发）
- 不管外部协议（comm 内部自用）

comm 只是一根管道。上层业务决定往管道里塞什么。

---

## 2. 架构

```
Agent A ──┐
Agent B ──┤── Unix socket ──► comm server ──► 路由到目标 agent
Agent C ──┘
          ~/.claude/team-hub/comm.sock
```

- **comm server**：进程内常驻，监听 Unix socket `~/.claude/team-hub/comm.sock`。
- **Agent 连接**：每个 agent 进程启动后，通过 env 拿到 socket 路径，建一条长连接。
- **消息转发**：agent 发消息给 comm，comm 查本地注册表找到目标 agent 的连接，把消息写过去。

**对外只暴露一种接口：socket**。无论是 agent 自己收发消息，还是上层业务工具（如 `send_msg`）想往某个 instance 推消息，统一都是连这个 Unix socket、发同一种 JSON 消息。comm 不提供 HTTP 端点、不提供 RPC、不提供函数导出。

单向依赖：客户端（agent / 上层业务） → comm server。comm server 不主动连客户端，只回应连接进来的连接。

---

## 3. 协议

就是 JSON 消息。**agent write 一条 JSON，comm read 一条 JSON**。一条 JSON = 一条消息。

### 消息类型

| type | 方向 | 用途 |
|---|---|---|
| `register` | agent → server | 连接建立后第一条，注册自己的完整地址 |
| `message` | 双向 | 发消息 / 收消息 |
| `ping` | agent → server | 保活 |
| `pong` | server → agent | 保活回应 |
| `ack` | server → agent | 对 register / message 的受理确认 |

### 地址格式：`[scope]:[id]`

`from` 和 `to` 字段统一使用 `[scope]:[id]` 格式。

- **scope**
  - `local`：本机
  - `app_uuid`：远程设备的 UUID（mlink 层分配）
- **id**
  - `system`：系统（comm 内部）
  - `instance_id`：agent 实例

| 地址示例 | 含义 |
|---|---|
| `local:system` | 本机系统 |
| `local:abc-123-def` | 本机某个 agent 实例 |
| `a1b2c3d4:system` | 远程设备 a1b2c3d4 的系统 |
| `a1b2c3d4:abc-456-ghi` | 远程设备上的某个 agent |

> 约定：instanceId 不允许等于 `system`，避免与特殊 id 冲突。

本机的 `app_uuid` 从 `~/.mlink/daemon.json` 读取；comm server 启动时读一次并缓存，用于判定「哪些地址是自己」。

### 消息结构（普通 message）

```json
{
  "type": "message",
  "id": "msg-uuid",
  "from": "local:instance-a",
  "to": "local:instance-b",
  "payload": {
    "summary": "review request",
    "content": "please check src/foo.ts"
  },
  "ts": "2026-04-21T10:00:00.000Z"
}
```

### 消息结构（system 消息）

`id = system` 的消息由 comm server 内部处理，不走 socket 投递。典型用途是远程设备同步"我这边有哪些成员在工作"。

```json
{
  "type": "message",
  "from": "a1b2c3d4:system",
  "to": "local:system",
  "payload": {
    "kind": "peer_status",
    "members": [
      { "name": "成员A", "status": "online", "role": "dev", "task": "修bug" },
      { "name": "成员B", "status": "offline" }
    ]
  },
  "ts": "2026-04-21T10:00:00.000Z"
}
```

`payload.kind` 标识系统消息的子类型，由 system handler 分发到对应回调。目前定义的 kind：

| kind | 触发源 | handler 行为 |
|---|---|---|
| `peer_status` | 远程设备代理 agent 上线/成员状态变更 | upsert `remote_peers` 表对应行 |

后续扩展新的跨机元数据同步，在此表增加 kind 即可，comm 本身不改。

### 消息结构（register）

```json
{ "type": "register", "address": "local:instance-a" }
```

### 消息结构（ping / pong）

```json
{ "type": "ping", "ts": "..." }
{ "type": "pong", "ts": "..." }
```

---

## 4. 注册表

注册表分两层：本机内存，远程 DB。

### 本机在线注册表（内存）

```
Map<address, SocketConnection>   // address 形如 "local:instance-a"
```

- agent 连上并发 `register` → 写入 Map（key 为完整地址 `local:<instanceId>`）。
- socket 断开（`close` / `error`）→ 从 Map 移除。
- 重复 register 同一地址 → 替换旧连接（agent 重启后续接）。

### 远程 peers 表（DB）

本机知道"其他机器上有哪些成员在工作"，由 system 消息驱动更新（非 agent socket register）。

```sql
CREATE TABLE remote_peers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_uuid    TEXT NOT NULL,
  device_name TEXT,
  member_name TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'online',
  role        TEXT,
  task        TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_rp_uuid ON remote_peers(app_uuid);
CREATE INDEX idx_rp_status ON remote_peers(status);
```

- `app_uuid`：远程设备唯一标识（mlink 层分配）。
- `(app_uuid, member_name)` 逻辑唯一，system handler upsert。
- status：`online` / `offline`（具体语义由上层定义，comm 只照搬写入）。
- 查询：本机上层业务可读此表展示"跨设备协作者列表"，comm 自己不读它做路由（路由凭地址 scope 直接走 mlink）。

### 历史表（DB，可选）

`comm_peers` 表记录曾经注册过的本机地址、最近在线时间。用于审计和离线消息定位。不是路由的必要条件。

---

## 5. 路由

收到 `message` 消息时，先 `parseAddress(to)` 拿到 `{ scope, id }`，按以下规则分发：

1. **scope = `local` + id = `system`** → 不走 socket，调 comm 内部注册的 system handler（`payload.kind` 分发）。handler 负责写 `remote_peers` 等 DB。
2. **scope = `local` + id = instanceId** → 查本机在线注册表：
   - **在线** → 直接写过去（一条 JSON 消息）。发送方可选 ack。
   - **不在线** → 写 `messages` 表（`read_at = NULL`）。目标下次上线（收到新 register）时查表补发，补发成功 UPDATE `read_at`。
3. **scope = app_uuid（非 local）** → 走 mlink 转发：`mlink.send(app_uuid, message)`。本机不查注册表、不写 socket。mlink 未接入时返回 "not implemented"。对端 comm 收到后按对端本地规则再分发（id = `system` 触发对端 system handler，id = instanceId 投递到对端 agent）。

三条路径互斥，先按 scope 判走向，再按 id 判本机细节。system 和 remote 不走本机离线队列（system 是即时回调，remote 的离线由对端自己管）。

广播 / 群发不在 comm 范畴。上层业务如果要"发给一个 team 的所有人"，自己拆成 N 条 1:1 发给 comm。

---

## 6. 跨机通信（mlink 预留）

comm 本身只管本机。跨机能力通过 **mlink** 隧道外接，接口预留但本阶段不实现。

- **mlink 是什么**：两台机器之间的跨机隧道（底层由 mlink 自己实现，comm 不关心）。
- **room 码**：6 位数字，两台机器各自输入同一个码 = 配对成功。跟 team / project 无关。
- **路由判定**：`parseAddress(to).scope !== "local"` 就走 mlink；否则本机处理。不需要查表判断。
- **对端行为**：对端 comm 收到后，按对端本地的地址规则再分发一次（id = `system` 触发对端 system handler，否则找对端 agent）。
- **元数据同步**：远程成员上线/下线/状态变更，通过 `to = "local:system"`、`kind = peer_status` 的消息推到本机，本机 system handler 更新 `remote_peers`。

本阶段实现方式：

- 路由层加 scope 判断 `if (scope !== "local") return mlink.send(scope, message)`。
- `mlink.send` 是空实现或抛 "not implemented"。
- `remote_peers` 表建好 schema，system handler 的 `peer_status` 分支实现 upsert。
- 本机不主动向远端发 peer_status，等 mlink 接入后由上层驱动。

上层对"是谁"完全感知不到本机还是跨机，只要按 `[scope]:[id]` 约定拼地址即可。

---

## 7. 文件结构

```
v2/comm/
├── server.ts         # Unix socket server：listen / accept / 连接生命周期
├── router.ts         # 消息路由：按 scope 分本机 / 远程两条分支，本机再按 id 分 system / agent
├── registry.ts       # 本机在线注册表：Map<address, conn> + 增删
├── system-handler.ts # system 消息回调：按 payload.kind 分发（peer_status 等）
├── remote-peers.ts   # remote_peers 表读写：upsert / query
├── protocol.ts       # 消息类型定义 + JSON 编解码 + parseAddress(addr) 解析
├── offline.ts        # 离线消息存取：messages 表 INSERT / replayFor
└── types.ts          # 公共类型：Message / Envelope / PeerInfo / RemotePeer
```

每个文件 < 200 行。

| 文件 | 职责 | 预估行数 |
|---|---|---:|
| `types.ts` | 类型定义（含 Address = \`${scope}:${id}\`） | ~80 |
| `protocol.ts` | JSON 序列化 + 消息守卫 + `parseAddress(addr) → { scope, id }` | ~140 |
| `registry.ts` | 内存 Map 管理 + 重复注册替换 | ~100 |
| `server.ts` | socket listen / connection 生命周期 | ~160 |
| `router.ts` | dispatch 决策（按 scope / id 分四种路径） | ~140 |
| `offline.ts` | messages 表读写 + 上线补发 | ~100 |
| `system-handler.ts` | kind 分发表 + 默认的 peer_status 处理 | ~80 |
| `remote-peers.ts` | remote_peers upsert / 按 app_uuid 批量置 offline | ~80 |

`protocol.ts` 对外导出 `parseAddress(addr: string): { scope: string; id: string }`，路由层和 system-handler 都用它判定走向；格式非法时抛错。

---

## 8. 与其他模块的关系

| 模块 | 关系 |
|---|---|
| **role-instance** | 创建 instance 时，通过 env（如 `TEAM_HUB_COMM_SOCK` + `TEAM_HUB_INSTANCE_ID`）把 socket 路径和身份传给 agent；agent 启动自己拼 `local:<instanceId>` 作为地址连 socket 并发 `register`。删除 instance 时，对应 socket 断开，comm 自动从注册表清理。|
| **上层业务工具** | 业务层（如 `send_msg`）和 comm 的唯一交互方式也是连 socket、发 `message` 消息。工具侧保持一条到 comm 的长连接，把调用方地址放在 `from`，要发给谁放在 `to`（按 `[scope]:[id]` 拼）。comm 不关心调用者是谁，只按消息格式处理。|
| **mlink**（未来）| 跨机 peer 的 transport。comm 持有 mlink client 引用，路由看到 `to` 的 scope 不是 `local` 就调 `mlink.send(app_uuid, msg)`。对客户端不可见：上层仍然只发 socket 消息。|
| **DB** | `messages` 表（离线队列）+ `remote_peers` 表（跨机成员状态）+ 可选 `comm_peers`（本机 peer 历史）。comm 不碰其他业务表。|

---

## 9. 不做的

- 不做身份验证（socket 是本机 Unix socket，权限由文件系统控制）
- 不做消息加密（本机单机走内核）
- 不做端到端已读回执（ack 仅到 server 层）
- 不做重试 / 去重（交给上层幂等处理）
- 不做顺序保证（同一对 from/to 的顺序由 socket 串行保证；多对之间不保证全序）
- 不做广播 / 群组（上层拆成 1:1）
- 不自动启动 mlink daemon（用户自己起）
