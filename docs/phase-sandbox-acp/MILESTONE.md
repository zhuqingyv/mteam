# Phase：沙箱化 + ACP 统一 — 进度总表

**版本**：v1 · **创建日期**：2026-04-25 · **状态**：🔲 规划中

---

## 1. Phase 概述

当前 mteam 的 Agent 运行模型是"两套并行"：
- **主 Agent**（PrimaryAgent）走 AgentDriver → `child_process.spawn` → ACP 协议
- **成员 Agent**（RoleInstance）走 PtyManager → `node-pty` spawn → 纯终端文本交互

两条路径并存带来三个痛点：
1. **安全**：所有 CLI 直接跑在 host 上，拥有完整文件系统/网络/环境变量权限，无法做最小权限隔离
2. **协议割裂**：主 Agent 已用上 ACP 的结构化消息（thinking / text / tool_call），成员 Agent 仍靠屏幕抓取文本，思考过程和工具调用都丢失
3. **可扩展性**：未来跨机分发、容器化多租户、远程 Agent 等场景，每条路径都要重写一遍

本 Phase 的终极目标：
- **统一协议**：主 Agent 和成员 Agent 全部走 ACP，废弃 PTY 屏幕抓取
- **可沙箱化**：抽出 process-runtime 运行时抽象层，主 Agent 可平滑切到 Docker 容器执行，host 文件系统零暴露
- **内置 MCP 标准化**：把 `__builtin__` 的 mteam / searchTools 从 stdio 改为 MCP Streamable HTTP，容器内可访问，符合 MCP Spec 2025-03 官方方向

完成后，新增的 Runtime/Agent 类型（远程 Runtime、新的 CLI 适配器）只需实现一个薄接口即可挂入系统。

---

## 2. 架构全景图

### 2.1 改造前（现状）

```
                         ┌─────────────────────────────┐
                         │         mteam 后端           │
                         │       (Node host 进程)        │
                         └──────┬──────────────┬─────────┘
                                │              │
              主 Agent 路径 ────┘              └──── 成员 Agent 路径
                    │                                 │
                    ▼                                 ▼
       ┌────────────────────────┐        ┌───────────────────────────┐
       │     PrimaryAgent        │        │      RoleInstance          │
       │  (primary-agent/*)      │        │   (domain/role-instance)   │
       └──────────┬──────────────┘        └─────────────┬──────────────┘
                  │ driver.start()                       │ ptyManager.spawn()
                  ▼                                       ▼
       ┌────────────────────────┐        ┌───────────────────────────┐
       │      AgentDriver        │        │        PtyManager          │
       │   (agent-driver/*)      │        │        (pty/*)             │
       │                         │        │                            │
       │  child_process.spawn()  │        │    node-pty.spawn()        │
       │  stdio JSON-RPC         │        │    终端字节流 (xterm)      │
       └──────────┬──────────────┘        └─────────────┬──────────────┘
                  │                                      │
                  ▼                                      ▼
       ┌────────────────────────┐        ┌───────────────────────────┐
       │   claude / codex CLI    │        │      claude CLI            │
       │   (ACP Agent 子进程)    │        │  (--append-system-prompt)  │
       │                         │        │                            │
       │  结构化消息:            │        │  屏幕文本 + READY 正则      │
       │  thinking/text/tool_use │        │  RingBuffer 抓取           │
       └──────────┬──────────────┘        └─────────────┬──────────────┘
                  │                                      │
                  │  MCP stdio                           │  MCP stdio
                  ▼                                      ▼
       ┌──────────────────────────────────────────────────────────┐
       │              内置 MCP (`__builtin__`)                      │
       │   mteam / searchTools  —— stdio 子进程 spawn              │
       │   依赖 unix socket (TEAM_HUB_COMM_SOCK)                    │
       │   依赖 localhost:V2_PORT (V2_SERVER_URL)                   │
       └──────────────────────────────────────────────────────────┘

问题：
  1. 两条 spawn 路径，生命周期/环境变量/cwd 各管一套
  2. 成员 Agent 的 thinking / tool_call 信息全部丢失
  3. 内置 MCP 绑定 host 本机，容器内根本启不起来
  4. 所有 CLI 进程共享 host 权限，没有隔离边界
```

### 2.2 改造后（目标）

```
                         ┌─────────────────────────────┐
                         │         mteam 后端           │
                         │       (Node host 进程)        │
                         └─────────────┬────────────────┘
                                       │
                                       ▼ 统一入口
                         ┌────────────────────────────────┐
                         │         AgentDriver             │
                         │   (agent-driver/*, 解耦后)      │
                         │                                 │
                         │   不再自己 spawn，接收         │
                         │   RuntimeHandle 做 IO           │
                         └──────────────┬──────────────────┘
                                        │ 注入
                                        ▼
                         ┌────────────────────────────────┐
                         │    process-runtime (新增)       │
                         │                                 │
                         │    RuntimeHandle 接口:          │
                         │      start() / stdin / stdout   │
                         │      stderr / stop() / wait()   │
                         └──┬───────────────────┬──────────┘
                            │                   │
                       实现 1                实现 2
                            │                   │
              ┌─────────────▼──────┐   ┌────────▼──────────────┐
              │   HostRuntime      │   │   DockerRuntime        │
              │                    │   │                        │
              │ child_process.spawn│   │ docker run --rm -i     │
              │ 主机执行            │   │ 容器内执行              │
              │ (兼容现有行为)      │   │ 零 host FS 权限        │
              └──────────┬─────────┘   └───────────┬────────────┘
                         │                         │
                         ▼                         ▼
              ┌──────────────────┐       ┌────────────────────┐
              │  ACP Agent 子进程 │       │ ACP Agent 容器      │
              │  (claude/codex)   │       │ (claude/codex)      │
              │   主 or 成员      │       │   主 Agent 默认      │
              └──────────┬────────┘       └──────────┬─────────┘
                         │  MCP (stdio + http)       │  MCP (http only)
                         │                            │
                         ▼                            ▼
              ┌───────────────────────────────────────────────────┐
              │             MCP 分流（Phase 4）                    │
              │                                                    │
              │   内置 MCP:  Streamable HTTP Server                │
              │             (host 启动，容器通过 host.docker.internal) │
              │                                                    │
              │   外部 MCP:  stdio + Volume 挂载 (npm/uvx cache)   │
              └───────────────────────────────────────────────────┘

关键变化：
  ★ 只剩一条协议路径：ACP
  ★ spawn 能力从 driver/pty 抽到 runtime，driver 只负责协议
  ★ Docker 化对 driver 透明 —— 换 Runtime 实现即可
  ★ 内置 MCP HTTP 化，跨进程/跨容器/跨机都能直连
  ★ PTY 模块整体废弃
```

---

## 3. Stage 列表

| # | 名称 | 目标 | 工时 | 依赖 | 状态 |
|---|------|------|------|------|------|
| 1 | process-runtime 运行时抽象层 | 抽出 `RuntimeHandle` 接口 + `HostRuntime` 实现，行为等价现有 `child_process.spawn` | 2d | — | 🔲 |
| 2 | AgentDriver 解耦 | driver 不再直接 spawn，改为接收 `RuntimeHandle`，保持对外事件契约不变 | 1d | Stage 1 | 🔲 |
| 3 | 成员 Agent 迁移 ACP + 废弃 PTY | RoleInstance 换用 AgentDriver，`pty/` 模块整体删除，前端屏幕输出改用 driver 事件流 | 2d | Stage 2 | 🔲 |
| 4 | 内置 MCP HTTP 化 + DockerRuntime | mteam/searchTools 改 MCP Streamable HTTP；实现 `DockerRuntime`；主 Agent 默认跑容器 | 2d | Stage 2 | 🔲 |
| 5 | 安全策略 + 测试收尾 | 容器生命周期管理（cleanup / OOM / 超时）、挂载白名单、网络策略、全量集成测试 | 1d | Stage 3, Stage 4 | 🔲 |

**预估总工时**：8 个工作日（可 Stage 3/4 并行推进，实际墙钟约 6 天）

---

## 4. 依赖关系图

```
       ┌─────────────┐
       │   Stage 1    │   process-runtime 抽象层
       │ RuntimeHandle│   + HostRuntime
       └──────┬───────┘
              │
              ▼
       ┌─────────────┐
       │   Stage 2    │   AgentDriver 解耦
       │ Driver 收     │   不再自己 spawn
       │ RuntimeHandle │
       └──────┬───────┘
              │
        ┌─────┴──────┐
        │            │
        ▼            ▼
   ┌─────────┐  ┌─────────┐
   │ Stage 3 │  │ Stage 4 │   (可并行)
   │ 成员迁移 │  │ MCP HTTP│
   │ 废弃 PTY │  │ +Docker │
   └────┬────┘  └────┬────┘
        │            │
        └─────┬──────┘
              ▼
       ┌─────────────┐
       │   Stage 5    │   安全 + 测试收尾
       │ 生命周期     │
       │ 安全策略     │
       │ 全量测试     │
       └─────────────┘
```

---

## 5. 验收标准

完成 Phase 需同时满足：

- [ ] 所有 Agent（主 / 成员）统一走 ACP 协议，`session/update` 结构化事件（thinking / text / tool_call / tool_result）全路径可订阅
- [ ] 主 Agent 可在 Docker 容器中运行，容器对 host 文件系统零挂载权限（仅允许显式 whitelist 目录）
- [ ] 内置 MCP（mteam / searchTools）以 Streamable HTTP 暴露，容器内通过 `host.docker.internal` 可正常调用
- [x] `packages/backend/src/pty/` 目录被完全删除，依赖 `node-pty` 的 import 清零（Stage 3 W2-3 完成）
- [ ] `RoleInstance.registerSession` 不再写入 PID，改为关联 `driverId`（schema 向前兼容）
- [ ] 现有测试（单测 + 集成测）全部通过，且新增覆盖：Runtime 切换、容器挂掉恢复、MCP HTTP 握手、权限拒绝场景
- [ ] 测试覆盖率不低于 Phase 开始前的基线（以 `vitest run --coverage` 输出为准）
- [ ] 前端看到的成员 Agent 输出质量不低于 PTY 时代（能展示思考、工具调用、结果，不丢信息）

---

## 6. 关键设计决策

1. **不自研 MCP Bridge，走 MCP Streamable HTTP 标准**
   理由：MCP Spec 2025-03 已原生支持 Streamable HTTP，造 stdio→SSE 网关是造轮子；HTTP 化后天然支持跨机扩展，改动 ~300 行（自研 Bridge 约 ~600 行）。参见知识 351。

2. **process-runtime 抽象统一覆盖 host / docker / remote 三类运行时**
   理由：只抽 host/docker 会留尾巴；一开始就把接口定成"能描述进程 IO 的最小集"，未来接远程 Runtime（SSH / k8s exec）零重构。

3. **成员 Agent 本 Phase 同步迁移 ACP，不推迟**
   理由：PTY 屏幕抓取丢失 thinking / tool_call，前端体验落后于主 Agent；继续并存两条路径让 AgentDriver 抽象没有收益。沉没成本不如一次还清。

4. **HostRuntime 为默认 Runtime，DockerRuntime 按配置显式启用**
   理由：开发/测试环境用 Host 最省事；生产主 Agent 切 Docker；成员 Agent 短期仍走 Host（容器成本高、孤立 Agent 没价值）。两者通过配置位切换，代码同一套。

5. **内置 MCP HTTP Server 作为后端进程的一部分启动，不是独立服务**
   理由：builtin 强依赖 comm socket + hub 本机状态，独立起 HTTP 服务会反向依赖后端单例；就地嵌入 HTTP listener 最简，容器通过 `host.docker.internal` 直连。

6. **PTY 模块整体删除，不保留兼容层**
   理由：用户偏好"代码必须一目了然"，保留未使用的兼容层只会让下一个 agent 困惑；现有前端的终端渲染组件继续存在，只是数据源从 PTY ring buffer 换成 driver 事件流重放。

---

## 7. 相关文档

- 架构决策：mnemo 知识 #351（混合分流方案）、#356（Phase 架构设计）
- Stage 详细设计文档（本目录下）：
  - `stage-1-process-runtime.md`
  - `stage-2-driver-decouple.md`
  - `stage-3-member-acp.md`
  - `stage-4-mcp-http.md`
  - `stage-5-security.md`
- 历史设计参考：`../agent-driver-design.md` / `../primary-agent-design.md`

---

## 8. 状态图例

- 🔲 待开始
- 🟡 进行中
- ✅ 已完成
- ⚠️ 受阻
- ⏸️ 暂缓

更新本表：每个 Stage 开始/结束时直接修改第 3 节的状态列。
