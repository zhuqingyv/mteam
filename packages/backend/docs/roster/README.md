# roster — 活跃名单管理器

## 1. 概述

roster 维护"现在有谁在、叫什么、怎么到达"。

**是什么**：活跃成员名单的状态管理器。mteam-mcp 的 lookup / send_msg 都通过它查人。

**不是什么**：
- 不是 comm（不管消息投递）
- 不是 role-instance（不管生命周期）
- 不管业务逻辑

## 2. 数据来源

- 本地：role_instances 表（活跃实例）
- 远程：remote_peers 表（其他机器广播过来的）

## 3. 成员字段

| 字段 | 说明 |
|------|------|
| instanceId | 唯一标识 |
| memberName | 原名（模板名/远程名） |
| alias | 备注名（默认 = memberName） |
| scope | local / remote |
| status | PENDING / ACTIVE / PENDING_OFFLINE |
| address | comm 地址（local:xxx / app_uuid:xxx） |
| teamId | 所属 team（可空） |
| task | 当前任务（可空） |

## 4. 核心能力

- add(instance) — 实例创建时加入名单
- remove(instanceId) — 实例删除时移除
- setAlias(instanceId, alias) — 设置备注名
- search(callerInstanceId, query, scope?) — 按 alias 模糊搜索（LIKE '%query%'），scope 可选 team/local/remote，不填全搜。scope="team" 时根据 callerInstanceId 自动查所属 teamId，调用方不需要传 teamId
- resolve(callerInstanceId, query) — search 的便捷版：唯一匹配返回地址，多匹配报错，0 匹配报错
- list(callerInstanceId?, scope?) — 列出名单，可按 scope 过滤。scope="team" 时自动取调用者的 team

## 5. alias 规则

- 默认 = member_name，创建时自动设
- 可通过 setAlias 手动修改
- search 默认搜 alias，alias 没设就等于搜 member_name
- 本地实例下线 → 随实例物理删除，alias 自然失效
- 远程 peers 断开 → 标 offline，alias 保留直到被清理

## 6. 与其他模块关系

| 模块 | 关系 |
|------|------|
| mteam-mcp | lookup / send_msg 调 roster.search / roster.resolve |
| role-instance | 创建时调 roster.add，删除时调 roster.remove |
| comm | 不知道 roster 存在。roster 查到地址后交给 comm 投递 |
| remote_peers | roster 读这张表获取远程成员信息 |

## 7. HTTP 接口

### GET /api/roster — 列出活跃名单

- 参数（query string）：scope?=team|local|remote，callerInstanceId?（scope=team 时必填）
- Response 200: `[{ instanceId, memberName, alias, scope, status, address, teamId, task }, ...]`

### GET /api/roster/search — 模糊搜索

- 参数（query string）：q（搜索关键词，必填）、scope?、callerInstanceId?
- Response 200:
  - 唯一匹配：`{ match: "unique", target: { instanceId, memberName, alias, scope, status, address } }`
  - 多个匹配：`{ match: "multiple", candidates: [...] }`
  - 零匹配：`{ match: "none", query: "xxx" }`

### PUT /api/roster/:instanceId/alias — 设置备注名

- Body: `{ alias: "小明" }`
- Response 200: `{ instanceId, alias }`
- 404: 实例不存在

### GET /api/roster/:instanceId — 查看单个成员

- Response 200: `{ instanceId, memberName, alias, scope, status, address, teamId, task }`
- 404: 不存在

### POST /api/roster — 添加成员到名单

- Body: `{ instanceId, memberName, alias?, scope, status, address, teamId?, task? }`
- Response 201: 添加后的完整记录
- 409: instanceId 已存在

### DELETE /api/roster/:instanceId — 从名单移除

- Response 204
- 404: 不存在

### PUT /api/roster/:instanceId — 更新成员状态

- Body: `{ status?, address?, teamId?, task? }`（部分更新）
- Response 200: 更新后的完整记录
- 404: 不存在

> roster 是活跃名单的唯一收口。role-instance 创建/删除/状态变更时通过 roster 接口同步，不直接操作名单。

## 8. 文件结构

```
v2/roster/
├── roster.ts    # Roster 类（add/remove/search/resolve/list/setAlias）
└── types.ts     # RosterEntry 类型
```

## 8. TODO（本期不做）

- mteam 客户端启动时让用户起一个设备名
- 设备名跟随设备持久化，不因关闭消失
- 用于跨机通信时标识"这台机器的主人是谁"
