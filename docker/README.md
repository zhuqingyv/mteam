# docker/ — agent 运行时镜像

本目录存放 Stage 4+ 用于沙箱化 agent 运行时的 Dockerfile。

## 设计契约

见 `packages/backend/docs/phase-sandbox-acp/stage-4-mcp-http.md` §4.1。

核心约束：
- **不 COPY backend 代码** — mteam / searchTools 留在 host backend 进程里，通过 MCP HTTP listener 暴露。容器里只跑 ACP agent 本体。
- **stdin/stdout 直通** — `docker run -i` 下，ACP JSON-RPC 管道透明穿过 docker CLI。
- **最小权限** — spawn 侧（`docker-runtime.ts`）默认加 `--cap-drop ALL --security-opt no-new-privileges --rm`。
- **网络** — 默认进 `mteam-bridge` 自建网络；Linux 自动加 `--add-host=host.docker.internal:host-gateway` 以便容器回连 host 上的 MCP HTTP listener（58591）。

## 镜像

### agent-claude.Dockerfile

运行 Claude ACP agent 的镜像。

**基础镜像：** `node:20-slim`
**预装：** `@anthropic-ai/claude-acp`
**ENTRYPOINT：** `claude-acp`

#### 构建

```bash
# 在仓库根目录执行
docker build -f docker/agent-claude.Dockerfile -t mteam/agent-claude:dev .
```

#### 命名规范

- 开发调试：`mteam/agent-claude:dev`
- 发布版本：`mteam/agent-claude:<backend-version>`（与 `packages/backend/package.json` 的 `version` 字段对齐）
- latest 别名：`mteam/agent-claude:latest` 指向最新 release

#### 运行验证

最小冒烟测试（容器能起、ENTRYPOINT 可执行、stdin 可写）：

```bash
# 喂一个空 JSON 对象，确认 claude-acp 进程能启动读 stdin
docker run --rm -i mteam/agent-claude:dev <<< '{}'
```

实际使用时由 `DockerRuntime.spawn()`（`packages/backend/src/process-runtime/docker-runtime.ts`，W1-C 交付）拉起，配合 `-e` 注入 env、`--network mteam-bridge` 接入自建网络。

#### 版本 pin TODO

当前 Dockerfile **未 pin** `@anthropic-ai/claude-acp` 版本 —— 因为 `packages/backend/package.json` 还未把该包作为 dep（只有 `@agentclientprotocol/sdk`）。

后续步骤：
1. backend 添加 `@anthropic-ai/claude-acp` 到 dependencies（或 devDependencies）并 pin 具体版本。
2. 同步更新本 Dockerfile 的 `npm install -g` 行为 `npm install -g @anthropic-ai/claude-acp@<pinned>`。
3. 保证 host 与容器里运行的 claude-acp 版本一致，便于排查行为差异。

### agent-codex.Dockerfile（TODO · Stage 4 后续）

对称做法，基础镜像和层级相同，ENTRYPOINT 换成 codex adapter 二进制。Stage 4 先交付 claude，codex 跟进。

## 不在本目录做的事

- 语言运行时镜像（Python / Ruby / Go）— 走 volume 挂载方案，Stage 5 细化。
- 外部用户 MCP server 的依赖（npx / uvx）— 同上。
- 密钥注入策略（ANTHROPIC_API_KEY 等）— Stage 5 讨论密钥隔离，当前通过 `-e` 环境变量直传。
