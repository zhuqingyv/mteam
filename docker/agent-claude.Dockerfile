# syntax=docker/dockerfile:1
#
# agent-claude — 运行 Claude ACP agent 的沙箱镜像
#
# 构建: docker build -f docker/agent-claude.Dockerfile -t mteam/agent-claude:dev .
# 运行: docker run --rm -i mteam/agent-claude:dev
#
# 设计契约见 docs/phase-sandbox-acp/stage-4-mcp-http.md §4.1
# 入口是 claude-acp 可执行文件，stdin/stdout 直连 ACP JSON-RPC。
# 不 COPY backend 代码 —— mteam/searchTools 在 host backend 进程里通过 HTTP 暴露。

FROM node:20-slim

# 最小系统依赖：ca-certificates 用于 TLS（claude-acp 要打 Anthropic API）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 预装 Claude ACP 包
# TODO: 待 packages/backend/package.json 添加 @anthropic-ai/claude-acp 依赖后，把版本 pin 到这里
RUN npm install -g @anthropic-ai/claude-acp

ENTRYPOINT ["claude-acp"]
CMD []
