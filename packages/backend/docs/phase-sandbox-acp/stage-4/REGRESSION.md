# Stage 4 · 回归测试清单

> 测试员唯一依据。逐条跑，逐条标 ✅/❌；❌ 的交给修复员。
> 产出物 `packages/backend/docs/phase-sandbox-acp/stage-4/TEST-REPORT.md`（格式：每条 case 的命令、输出、结论）。
> 测试员与开发员不得是同一人。

## 0. 准备

- Wave 1 + Wave 2 **全部**模块交付（`TASK-LIST.md` 状态栏 in-review 或 done）
- 宿主 docker daemon 启动；`docker ps` 不报错
- backend workspace 干净：`cd packages/backend && pnpm install && pnpm build` 零报错
- 预构建 claude agent 镜像：`docker build -f docker/agent-claude.Dockerfile -t mteam/agent-claude:dev .`
- 预创建 network：`docker network inspect mteam-bridge || docker network create --driver bridge mteam-bridge`

## 1. 单元/集成测（命令级）

| # | case | 命令 | 断言 |
|---|---|---|---|
| 1.1 | mteam createMteamServer | `pnpm --filter backend test mcp/server.test.ts` | 全绿；ListTools 返回 leader 全集 / 非 leader 裁剪集 |
| 1.2 | searchTools createSearchToolsServer | `pnpm --filter backend test searchtools/server.test.ts` | 全绿；ListTools 返回 `search` 工具 |
| 1.3 | mcp-http listener 回环 | `pnpm --filter backend test mcp-http/index.test.ts` | 真 HTTP + 真 bus，CallTool `send_msg` → bus.on('comm.send') 收到事件 |
| 1.4 | mcp-manager.resolve 产物形状 | `pnpm --filter backend test mcp-store/mcp-manager.test.ts` | `resolve()` 返回 `{ specs, skipped }`；`specs` 含 `kind: 'builtin'` 和 `kind: 'user-stdio'`；不再含 `configJson` |
| 1.5 | launch-spec-builder 分流 | `pnpm --filter backend test primary-agent/launch-spec-builder.test.ts` | host+builtin→http localhost；docker+builtin→http host.docker.internal；headers 齐全 |
| 1.6 | DockerRuntime spawn/kill/onExit | `pnpm --filter backend test process-runtime/docker-runtime.test.ts` | 回显镜像跑通；SIGTERM 2s 内 onExit；镜像缺失 onExit 非零 code |
| 1.7 | 全量单测 | `pnpm --filter backend test` | 无回归失败，新旧 case 全绿 |
| 1.8 | build | `pnpm --filter backend build` | tsc 零错误，产物在 `dist/` |

## 2. listener 启动验证

| # | case | 步骤 | 断言 |
|---|---|---|---|
| 2.1 | MCP HTTP listener 起得来 | 1. `MCP_HTTP_PORT=58591 pnpm --filter backend start`<br>2. `curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:58591/mcp/mteam` | 返回 4xx（不是 000/connection refused），证明 listener 在监听 |
| 2.2 | 不绑 0.0.0.0 | 2.1 启动后另起 terminal：`nc -zv <本机内网 IP> 58591` | 拒绝连接 / timeout；仅 loopback 可达 |
| 2.3 | 关停清理 | 2.1 启动后发 SIGTERM | 进程退出 code=0；`lsof -i :58591` 无残留 |

## 3. 端到端集成

| # | case | 步骤 | 断言 |
|---|---|---|---|
| 3.1 | host 模式内置 MCP 走 HTTP | 1. 启 backend（host 模式）<br>2. 创建一个 primary agent row，`runtimeKind='host'`<br>3. 观察 `driver.started` bus 事件<br>4. 发 prompt："用 mteam send_msg 给自己发 hello" | driver 收 `tool_call{name=send_msg}` → bus 收 `comm.send`（from = 该 instanceId，to = 自己）→ driver 收 `tool_result{ok=true}` |
| 3.2 | docker 模式完整链路 | 1. 启 backend（docker 镜像 `mteam/agent-claude:dev` 已 build）<br>2. 创建 primary agent row，`runtimeKind='docker'`<br>3. `docker ps` 验证容器起来了<br>4. 发同样 prompt | 同 3.1；同时 `docker ps` 在 driver.stop 后 3s 内容器消失（`--rm` 生效） |
| 3.3 | searchTools 集成 | 在 3.1 或 3.2 prompt："用 searchTools search 找 git 相关工具" | driver 收 `tool_result`；内容 `hits` 非空（至少一个命中来自真实 V2 API `/api/mcp-tools/search`） |
| 3.4 | 容器↔host 通道 | 3.2 期间 `docker exec -it <container> nslookup host.docker.internal` | 解析到 host gateway（Linux 需 `--add-host` 已生效） |

## 4. 隔离与并发

| # | case | 步骤 | 断言 |
|---|---|---|---|
| 4.1 | 两个 instance session 隔离 | 启 backend；创建两个 primary agent row（同模板，不同 id）；各自触发一次 mteam tool call | bus 上 `comm.send` 事件两条，`from` 字段各为各自 instanceId，互不串 |
| 4.2 | 关停顺序 | 启 backend → 发 SIGTERM → 观察 stderr 日志 | 顺序：teardownSubscribers → mcpManager.teardown → mcpHttp.close → primaryAgent.teardown → wss.close → comm.stop → db close → exit 0 |

## 5. 过渡期兼容

| # | case | 步骤 | 断言 |
|---|---|---|---|
| 5.1 | stdio 入口仍可用 | `ROLE_INSTANCE_ID=test V2_SERVER_URL=http://localhost:58590 TEAM_HUB_COMM_SOCK=/tmp/t.sock node packages/backend/dist/mcp/index.js` | 进程启动，stderr 含 `[mteam] ready instance=test ...`（comm 连不上是预期，send_msg 会失败，但 ListTools 应当工作）—— 如果该脚本已被维护放弃，5.1 从清单删除 |
| 5.2 | 旧 pnpm 脚本 | grep `pnpm.*mteam:dev` / `pnpm.*searchtools:dev` | 有的话跑一遍，无报错即可；无则跳过 |

## 6. 错误路径

| # | case | 步骤 | 断言 |
|---|---|---|---|
| 6.1 | 镜像缺失 | 删除本地 `mteam/agent-claude:dev`；创建 docker 模式 primary agent | `driver.error` 事件触发；row 状态不会卡在 STARTING |
| 6.2 | MCP HTTP 端口被占 | 占用 58591；启 backend | backend 启动失败日志明确，exit 非零（不是默默忽略） |
| 6.3 | 容器拒绝 SIGTERM | agent-claude 里 trap 屏蔽 SIGTERM（临时改 Dockerfile 加 `trap '' TERM`） | driver teardown 里 2s 后 SIGKILL 兜底，`onExit` 最终触发 |

## 7. 文档与交付

| # | case | 断言 |
|---|---|---|
| 7.1 | 每个新/改模块都有 README | `mcp-http/README.md` / `process-runtime/README.md`（DockerRuntime 章节）/ `mcp-store/README.md`（ResolvedMcpSpec 章节）/ `primary-agent/README.md`（launch-spec-builder 章节）/ `docker/README.md` |
| 7.2 | 业务模块 README 含时序图 | W2-A / W2-B / W2-C 的 README 有 ASCII 时序图 + 竞态分析 + 错误传播 |
| 7.3 | 设计文档与实际一致 | `stage-4-mcp-http.md` 的 58580/58590 冲突已在 TASK-LIST §0 更正；若设计文档本体也需要 patch，由修复员一并提 |

## 8. 通过标准

- §1–§6 全部 ✅（§5.1 若脚本废弃则跳过记录为 n/a）
- §7 全部 ✅
- TEST-REPORT.md 包含每条 case 的证据（命令输出片段、docker ps 截图文字、bus 事件 dump）
- Leader 更新 `MILESTONE.md` 将 Stage 4 标为 done；Stage 5 才能开工

## 附：常见失败点自查

1. **58590/58591 混用**：找到就改，跟 TASK-LIST §0 对齐
2. **`InProcessComm.send` 不走真 bus**：会让 3.1 过但 bus 订阅者拿不到，属致命，必须真 publish
3. **`host.docker.internal` 在 Linux 不通**：检查 `docker-runtime.ts` 是否加了 `--add-host` Linux 分支
4. **stateful session 泄漏**：关停时没 close 所有 transport，会看到 `lsof` 残留
5. **driver-config 还在用旧 `configJson`**：编译期就该挂，挂了就是 W2-A/W2-B 没原子提交
