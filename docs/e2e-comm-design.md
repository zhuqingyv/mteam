# 端到端通信链路设计

---

## 功能 Case 清单

### Case 1: leader 创建并激活

```
外部触发
  → POST /api/role-instances (isLeader: true)
  → RoleInstance.create(PENDING) + emit instance.created
  → pty.subscriber: McpManager.resolve() → spawn CLI
  → CLI 启动 → mteam MCP 启动 → CommClient 立即连 socket → register local:<leaderId>
  → roster 写入
  → 实例化最后一步：自动创建 team（leader instance 生命周期的一部分，不是独立操作）
  → [外部触发激活] → ACTIVE
  → emit instance.activated
```

### Case 2: leader 拉人

```
leader agent 调 add_member(templateName, memberName, task?)
  → mteam handler:
      1. 用 env.instanceId 查自己的 team（leader 创建时 teamId 已有）
      2. POST /api/role-instances (isLeader: false, leaderName: leaderId)
         → RoleInstance.create(PENDING) + emit instance.created
         → pty.subscriber: spawn member CLI
         → member CLI 启动 → mteam MCP 启动 → CommClient 立即连 socket → register local:<memberId>
         → roster 写入
      3. POST /api/teams/:teamId/members (instanceId: memberId)
         → team.addMember + emit team.member_joined
  → 返回 { instanceId, memberName, teamId }
```

### Case 3: member 激活 + 通知 leader

```
member agent 调 activate
  → POST /api/role-instances/:id/activate
  → PENDING → ACTIVE
  → emit instance.activated
  → comm-notify.subscriber: 检测到非 leader 激活 → 通过 comm 给 leader 发系统消息 "xxx 上线了"
  → leader 的 comm socket 收到通知
```

### Case 4: leader → member 发消息

```
leader agent 调 send_msg(to: "member名字", summary, content)
  → mteam handler:
      1. lookup("member名字") → roster 模糊搜 alias → 返回 local:<memberId>
      2. CommClient.send({ from: local:<leaderId>, to: local:<memberId>, payload })
  → CommServer → CommRouter:
      查 registry → memberId 在线 → 直接推 socket
  → member 的 mteam MCP 子进程收到消息
```

### Case 5: member → leader 发消息

```
member agent 调 send_msg(to: "leader名字", summary, content)
  → 同 Case 4 反向
```

### Case 6: member 查收消息

```
member agent 调 check_inbox
  → mteam handler: GET /api/role-instances/:id/inbox（或 comm 离线消息查询）
  → 返回未读消息列表
```

### Case 7: member 下线

```
leader agent 调 request_offline(instanceId: memberId)
  → POST /api/role-instances/:id/request-offline
  → ACTIVE → PENDING_OFFLINE
  → emit instance.offline_requested
  → comm-notify.subscriber: 通过 comm 给 member 发系统消息 "leader 已批准你下线"
  → team.subscriber: removeMember
  → member agent 收到通知 → 调 deactivate → 进程退出
```

### Case 8: leader 下线 → team 消失 → 成员跟随

```
[外部触发 leader 下线]
  → leader instance.offline_requested
  → team.subscriber: 级联所有 ACTIVE 成员 request_offline
  → 每个成员收到 comm 通知 → deactivate → 退出
  → team.disband(leader_gone)
  → leader 自己退出
```

---

## 全景数据流图

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Backend Server                                │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ roster   │  │ team     │  │ pty      │  │mcp-store │            │
│  │ (DAO)    │  │ (DAO)    │  │ (spawn)  │  │(全局仓库) │            │
│  └────▲─────┘  └────▲─────┘  └────▲─────┘  └────▲─────┘            │
│       │              │              │              │                  │
│  ┌────┴──────────────┴──────────────┴──────────────┴──────┐          │
│  │                   RxJS Event Bus                        │          │
│  │  instance.created / activated / deleted / offline_req   │          │
│  │  team.created / disbanded / member_joined / member_left │          │
│  └────▲──────────────────────────────────────────▲────────┘          │
│       │                                          │                   │
│  ┌────┴─────────────┐                  ┌─────────┴──────────┐       │
│  │  HTTP API        │                  │  CommServer         │       │
│  │  :58590          │                  │  Unix socket        │       │
│  │                  │                  │                     │       │
│  │  /role-templates │                  │  registry(addr→sock)│       │
│  │  /role-instances │                  │  router(在线直推)    │       │
│  │  /teams          │                  │  offline(DB存/重放)  │       │
│  │  /roster         │                  │                     │       │
│  │  /mcp-store      │                  │                     │       │
│  └──────────────────┘                  └──────┬──────────────┘       │
│                                               │                      │
└───────────────────────────────────────────────┼──────────────────────┘
                                                │ Unix socket
                    ┌───────────────────────────┼───────────────────┐
                    │                           │                   │
          ┌─────────▼─────────┐       ┌─────────▼─────────┐       ...
          │  Leader CLI       │       │  Member CLI       │
          │                   │       │                   │
          │  mteam MCP        │       │  mteam MCP        │
          │  ├ send_msg       │       │  ├ activate       │
          │  ├ check_inbox    │       │  ├ send_msg       │
          │  ├ add_member     │       │  ├ check_inbox    │
          │  ├ list_members   │       │  ├ deactivate     │
          │  ├ request_offline│       │  ├ lookup         │
          │  └ lookup         │       │  └ ...            │
          │                   │       │                   │
          │  CommClient       │       │  CommClient       │
          │  local:<leaderId> │       │  local:<memberId> │
          └───────────────────┘       └───────────────────┘

消息流：
  leader send_msg("member名字")
    → CommClient → socket → CommServer → router → socket → member CommClient
    
  member activate
    → HTTP API → bus emit → comm-notify subscriber → CommServer → leader CommClient
```

---

## 当前代码缺口

| # | 缺口 | 影响的 Case | 改动 |
|---|------|------------|------|
| 1 | CommClient 懒连接，不是启动即连 | 所有 Case（可能丢消息） | mcp/server.ts 启动时连 |
| 2 | member activate 不通知 leader | Case 3 | comm-notify.subscriber 加 instance.activated 订阅 |
| 3 | leader 的 teamId 是否在 env 里 | Case 2 | 确认 McpManager.resolve 注入或 handler 查询 |
| 4 | leader 实例化时不自动创建 team | Case 1 | instance.created subscriber 检测 isLeader → 自动 team.create |
