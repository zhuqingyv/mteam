# 端到端通信链路设计

---

## 完整链路

```
外部触发（用户/中心 agent）
  │
  ▼
创建 leader instance(isLeader: true)
  → spawn CLI → mteam MCP 启动 → CommClient 立即连 socket 注册 local:<leaderId>
  → leader 自动激活（不走 activate 工具）
  → team 自动创建，leader 知道自己的 teamId
  │
  ▼
leader 调 add_member(templateName, memberName, task?)
  → 系统创建 member instance → spawn CLI → mteam MCP 启动 → CommClient 立即连 socket 注册
  → member 此时 PENDING，但 comm 已在线
  │
  ▼
member agent 调 activate
  → PENDING → ACTIVE
  → 系统自动通过 comm 给 leader 发消息："xxx 上线了"
  → leader 收到，知道 member 准备好了
  │
  ▼
双方通过 send_msg 互发消息，走 comm socket
```

---

## 需要确认/修改的代码点

### 1. CommClient 启动时机

**现状**：send_msg 被调用时才懒连接
**应改为**：mteam MCP server 启动时（runMteamServer）立即连 socket 并 register

改动文件：`mcp/server.ts`

### 2. member activate 时自动通知 leader

**现状**：activate 只改状态 + emit bus 事件，不发 comm 消息
**应加**：activate 成功后，系统通过 comm 给 leader 发系统消息 "xxx 上线了"

实现方式：bus subscriber 订阅 `instance.activated`，查 instance 的 leaderName/teamId，通过 CommRouter 发系统消息给 leader

改动文件：`bus/subscribers/comm-notify.subscriber.ts`（已有 offline_requested 通知，加一个 activated 通知）

### 3. leader 的 teamId

**现状**：leader 创建时 team 自动创建，但 teamId 可能没写到 instance 上
**应确认**：leader instance 的 teamId 字段在创建时就有值，mteam MCP 子进程通过 env 或 HTTP 能拿到

### 4. 离线消息重放

**现状**：CommServer 已实现。register 时自动重放未读消息
**无需改动**：member 在 PENDING 时 comm 已连，如果 leader 在 member activate 前发消息，消息会在线直接推（因为 socket 已连），不会丢

---

## 状态流转

```
leader:  创建 → [自动激活] → ACTIVE → 调 add_member/send_msg/...
member:  创建 → PENDING(comm 已连) → [调 activate] → ACTIVE → 通知 leader → 调 send_msg/...
```

---

## 测试验证点

| # | 验证项 | 方式 |
|---|--------|------|
| 1 | leader spawn 后 comm 已注册 | 查 CommServer registry |
| 2 | member spawn 后 comm 已注册（PENDING 状态） | 查 CommServer registry |
| 3 | member activate 后 leader 收到上线通知 | leader check_inbox |
| 4 | leader send_msg → member check_inbox 收到 | 双向验证 |
| 5 | member send_msg → leader check_inbox 收到 | 反向验证 |
| 6 | member 离线前的消息不丢 | send_msg 在 register 之后立即可达 |
