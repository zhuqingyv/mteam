# 项目结构改造计划

## 1. 目标 monorepo 结构

```
mcp-team-hub/
├── packages/
│   ├── mcp-server/          # 后端服务
│   │   ├── src/
│   │   │   ├── server.ts          # HTTP server 入口
│   │   │   ├── index.ts           # 统一导出
│   │   │   ├── panel.html         # 临时测试页（后面删）
│   │   │   ├── domain/            # 领域对象
│   │   │   │   ├── state-machine.ts
│   │   │   │   ├── role-template.ts
│   │   │   │   ├── role-instance.ts
│   │   │   │   ├── events.ts
│   │   │   │   └── index.ts
│   │   │   ├── db/                # 数据层
│   │   │   │   ├── connection.ts
│   │   │   │   └── schemas/       # 每张表一个 SQL
│   │   │   ├── api/panel/         # HTTP 接口（给前端用）
│   │   │   ├── comm/              # 通信模块（Unix socket）
│   │   │   ├── roster/            # 活跃名单管理器
│   │   │   ├── mcp-store/         # MCP 配置管理（文件存储）
│   │   │   ├── mcp/               # 内置 mteam MCP server（原 mteam-mcp/，改名更简洁）
│   │   │   ├── pty/               # PTY 进程管理
│   │   │   └── fx/                # 视觉特效（border + 触手，后期移到 panel）
│   │   ├── docs/                  # 设计文档（从 src/v2/docs 提到包级）
│   │   └── package.json
│   │
│   ├── panel/                     # 前端（React 19 + Vite + TS + xterm.js）
│   │   ├── src/
│   │   └── package.json
│   │
│   └── mnemo/                     # 知识库 MCP（内置，git submodule）
│
├── package.json                   # monorepo 根
├── README.md
└── bun.lock
```

## 2. 平铺操作（v2/ → src/）

v2/ 下所有内容上提一级：
```
mv packages/mcp-server/src/v2/* packages/mcp-server/src/
rmdir packages/mcp-server/src/v2
```

import 路径不用改（全是相对路径，同级引用不变）。

## 3. 改名

| 当前 | 目标 | 理由 |
|------|------|------|
| mteam-mcp/ | mcp/ | 更简洁，项目内唯一的 MCP server |
| docs/（src 下） | 提到 packages/mcp-server/docs/ | 文档不该在 src 里 |

## 4. 清理

| 文件 | 操作 | 理由 |
|------|------|------|
| db-schema.sql（src 根） | 删 | 孤儿文件，schema 在 db/schemas/ 下 |
| fx/overlay/ 子目录 | diff 后择一保留 | 跟 fx/ 根下重名文件重复 |
| panel.html | 保留（临时）| 前端重建后删 |

## 5. package.json 修正

- bin 入口指向新路径（src/server.ts、src/mcp/index.ts）
- scripts 更新（dev:panel / dev:mcp / build:panel / build:mcp）
- 清理不再需要的依赖

## 6. mnemo 内置

方式：git submodule（版本锁定明确，CI 可复现）
```
git submodule add https://github.com/zhuqingyv/mnemo packages/mnemo
```
mcp-store 里 mnemo 记录的 command 指向 submodule 内的入口。

## 7. 前端重建（已定）

- **技术栈：React 19 + Vite + TypeScript + xterm.js**
- 位置：packages/panel/
- 需求：终端渲染(xterm.js) + 成员管理 + 模板管理 + 实时状态 + 特效(border + 触手，从 fx/ 迁入)

## 8. 执行步骤

1. 平铺 v2/ → src/
2. mteam-mcp/ → mcp/ 改名 + import 修正
3. docs/ 提到包级
4. 清理孤儿文件 + fx 重复
5. package.json 修正
6. mnemo 内置（submodule）
7. 前端 panel 重建（React 19 + Vite + TS + xterm.js）
8. 验收
