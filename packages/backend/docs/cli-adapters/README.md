# CLI Adapter 调研：HOME 隔离可行性 & 各 CLI 的 MCP 配置注入

**调研时间**：2026-04-21
**调研背景**：mteam 需要为不同 agent 动态注入不同的 MCP 配置。Claude 有 `--mcp-config` 可避免写文件，其他 CLI 只能写配置文件，而配置文件落在用户 HOME 会污染用户自己的 CLI 环境。
**核心命题**：设 `env.HOME = 临时目录` 是否可行？还是各 CLI 有自己的专用环境变量更稳？

---

## TL;DR 结论

> **不要用 HOME 隔离。每个主流 CLI 都有专用环境变量或 CLI flag 可精确覆盖配置路径，影响面远小于 HOME 隔离。**

| CLI | 推荐注入方式 | 需要 HOME 隔离？ |
|-----|------------|-----------------|
| Claude Code | `--mcp-config` / `--strict-mcp-config` / `CLAUDE_CONFIG_DIR` | **不需要** |
| OpenAI Codex | `CODEX_HOME=/path/to/dir`（指向 `.codex` 的父目录或直接是 codex home） | **不需要** |
| Gemini CLI | `GEMINI_CLI_HOME=/path/to/home`（会取 `$HOME/.gemini/`） | **不需要** |
| Cursor Agent CLI | `CURSOR_CONFIG_DIR=/path/to/dir`（全局 `cli-config.json`）+ project `.cursor/mcp.json`（cwd） | **不需要** |
| Trae Agent | `--config-file` / `TRAE_CONFIG_FILE=/path/to/trae_config.yaml` | **不需要** |

HOME 隔离是"万能锤"，所有 CLI 在 macOS/Linux 都读 `$HOME`（通过各自的 home 解析函数），所以**能**，但代价大：会同时影响该 CLI 对认证缓存、shell 历史、SSH 密钥、git 全局配置、其他子目录（`.config/`、`.cache/`、`.npm/`、`.aws/`、`.gitconfig`）的读取行为。除非某个 CLI 真没有专用变量，否则**优先专用变量**。

---

## 详细对照表

| 维度 | Claude Code | Codex | Gemini | Cursor | Trae |
|------|-------------|-------|--------|--------|------|
| **MCP 配置主路径** | `~/.claude/settings.json`（或 `~/.claude.json`）/ 可用 `.mcp.json` / `--mcp-config` | `~/.codex/config.toml`（`mcp_servers` 段） | `~/.gemini/settings.json`（含 `mcpServers`） | 全局 `~/.cursor/mcp.json` + 项目 `.cursor/mcp.json` | `trae_config.yaml`（`mcp_servers` 段，默认 cwd 相对路径） |
| **路径由什么决定** | 先看 `CLAUDE_CONFIG_DIR`，否则 `~/.claude/` | 先看 `CODEX_HOME`，否则 `dirs::home_dir()` + `.codex` | `Storage.getGlobalGeminiDir()` = `homedir()` + `.gemini`，其中 `homedir()` 先看 `GEMINI_CLI_HOME` 再回退 `os.homedir()` | 先看 `CURSOR_CONFIG_DIR`，否则 `~/.cursor/`（Linux 还会看 `XDG_CONFIG_HOME`）；项目级用 cwd 的 `.cursor/` | `--config-file` 参数 / `TRAE_CONFIG_FILE` 环境变量 / 默认 `./trae_config.yaml`（cwd） |
| **HOME 隔离可行？** | 可行但多余 —— 有 `CLAUDE_CONFIG_DIR` | 可行但多余 —— 有 `CODEX_HOME` | 可行但多余 —— 有 `GEMINI_CLI_HOME` | 可行但多余 —— 有 `CURSOR_CONFIG_DIR` | 不需要 —— `TRAE_CONFIG_FILE` 指定单个文件即可 |
| **cwd 里会被读的配置** | `./CLAUDE.md`、`./.claude/settings.json`、`./.mcp.json` | `./AGENTS.md` | `./GEMINI.md`、`./.gemini/settings.json`（工作区级） | `./.cursor/mcp.json`、`./.cursorrules` / `./.cursor/rules/` | `./trae_config.yaml` 默认就是 cwd |
| **HOME 隔离副作用** | 切掉 `~/.claude/agents/`、`~/.claude/skills/`、OAuth 凭证、session history、插件、hooks；需手工迁移或拷贝 | 切掉 `~/.codex/history.jsonl`、`~/.codex/.credentials.json`（OAuth keyring fallback）、session DB、`AGENTS.md` 全局 | 切掉 `~/.gemini/oauth_creds.json`、`mcp-oauth-tokens.json`、`installation_id`、`google_accounts.json` | 切掉 `~/.cursor/cli-config.json`（permissions/editor 等全局设置）、OAuth 状态 | 无 —— 只影响这一次 CLI 启动，不涉及 HOME |
| **推荐注入方式** | `--mcp-config <json-file>` + `--strict-mcp-config`（**零文件污染，最干净**） | 把 MCP 段写入 `$CODEX_HOME/config.toml`（CODEX_HOME 指向 team-hub 生成的临时目录） | 把 MCP 段写入 `$GEMINI_CLI_HOME/.gemini/settings.json` | **二选一**：① 写入 `$CURSOR_CONFIG_DIR/mcp.json`；② 在用户指定的 project cwd 下写 `.cursor/mcp.json`（注意：会污染用户仓库，需文件级清理） | 写一份 `trae_config.yaml` 到临时目录，启动时 `TRAE_CONFIG_FILE=/tmp/xxx/trae_config.yaml` |

---

## 各 CLI 单项详细证据

### 1. Claude Code CLI

**最强武器：不用写文件**。

- `--mcp-config <configs...>`：加载 JSON 文件或 JSON 字符串里的 MCP 配置，空格分隔。官方 `claude --help` 里有。
- `--strict-mcp-config`：只用 `--mcp-config` 里的，忽略其他所有 MCP 配置来源。**完美隔离**。
- `--settings <file-or-json>`、`--agents <json>`、`--plugin-dir <path>`：agent、插件、其他 settings 也能 flag 注入。
- `--bare`：关掉 hooks、LSP、auto-memory、CLAUDE.md 自动发现等，最小环境。适合"洁净室"启动。

**配置目录覆盖**（若必须用文件方式）：
- `CLAUDE_CONFIG_DIR`（官方 env-vars 文档明确记录）：完全替代 `~/.claude`。所有 settings、credentials、session history、plugins 都落到这个目录。
- 官方文档原话：`alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`。

**Claude 不支持 `XDG_CONFIG_HOME`**。

**结论**：Claude Code 的 MCP 注入用 `--mcp-config + --strict-mcp-config` 一行搞定，**根本不需要动 HOME 或 CLAUDE_CONFIG_DIR**。

---

### 2. OpenAI Codex CLI

**源码路径**：`codex-rs/utils/home-dir/src/lib.rs`

```rust
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
    let codex_home_env = std::env::var("CODEX_HOME").ok().filter(|val| !val.is_empty());
    find_codex_home_from_env(codex_home_env.as_deref())
}
// CODEX_HOME 不存在时：dirs::home_dir() + ".codex"
```

- `CODEX_HOME` 优先级最高，需要是已存在的目录，会被 canonicalize。
- 否则 `dirs::home_dir()`（Rust `dirs` crate），在 macOS/Linux 上读 `$HOME`；Windows 读 `USERPROFILE`。
- 所以 **HOME 隔离也能生效**（dirs 读 HOME），但 `CODEX_HOME` 更精确。

**MCP 注入方式**：把 `mcp_servers = [...]` 段写入 `$CODEX_HOME/config.toml`。

**cwd 相关**：Codex 会自动读 cwd 下的 `AGENTS.md`（项目指令）。这是"期望的行为"，跟 HOME 无关，不用隔离。

**其他被读的 HOME 子路径**（若做 HOME 隔离会一起丢）：
- `~/.codex/history.jsonl`
- `~/.codex/.credentials.json`（OAuth keyring fallback，keyring 不可用时就落到这里）
- `$CODEX_SQLITE_HOME` 或 `$CODEX_HOME` 下的 sqlite state DB
- `~/.codex/log/`

---

### 3. Google Gemini CLI

**源码路径**：`packages/core/src/utils/paths.ts`

```ts
export function homedir(): string {
  const envHome = process.env['GEMINI_CLI_HOME'];
  if (envHome) return envHome;
  return os.homedir();
}
```

**Storage 类**（`packages/core/src/config/storage.ts`）：

```ts
static getGlobalGeminiDir(): string {
  const homeDir = homedir();          // 上面那个，读 GEMINI_CLI_HOME
  if (!homeDir) return path.join(os.tmpdir(), GEMINI_DIR);
  return path.join(homeDir, GEMINI_DIR);   // GEMINI_DIR = '.gemini'
}

static getGlobalSettingsPath(): string {
  return path.join(Storage.getGlobalGeminiDir(), 'settings.json');
}
```

- Gemini **有专用环境变量** `GEMINI_CLI_HOME`，优先级高于 `os.homedir()`。设置后，CLI 会读 `$GEMINI_CLI_HOME/.gemini/settings.json`。
- 还有 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`：覆盖系统级 settings（macOS 默认 `/Library/Application Support/GeminiCli/settings.json`）。
- `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`：覆盖 system-defaults 路径。

**MCP 注入方式**：把 `mcpServers` 段写入 `$GEMINI_CLI_HOME/.gemini/settings.json`。

**cwd 相关**：Gemini 会读 cwd 下的 `GEMINI.md`（项目指令）和 workspace settings（`<cwd>/.gemini/settings.json`）。这两个是 cwd 语义，隔离不了也不该隔离。

**HOME 隔离副作用**：`~/.gemini/` 下还有 `oauth_creds.json`、`google_accounts.json`、`mcp-oauth-tokens.json`、`a2a-oauth-tokens.json`、`installation_id` —— HOME 隔离后这些都没了，用户要重新登录。

---

### 4. Cursor Agent CLI

**官方文档**：https://cursor.com/docs/cli/reference/configuration.md

| 类型 | 平台 | 路径 |
|------|------|------|
| Global CLI config | macOS/Linux | `~/.cursor/cli-config.json` |
| Global CLI config | Windows | `$env:USERPROFILE\.cursor\cli-config.json` |
| Project CLI config | 全部 | `<project>/.cursor/cli.json` |

**覆盖环境变量**：
- `CURSOR_CONFIG_DIR`：完全替代 `~/.cursor/`
- `XDG_CONFIG_HOME`（仅 Linux/BSD）：`$XDG_CONFIG_HOME/cursor/cli-config.json`

**MCP 配置**（https://cursor.com/docs/mcp.md）：
- 项目级：`<project>/.cursor/mcp.json`
- 全局：`~/.cursor/mcp.json`
- 配置内容兼容 `mcpServers` 标准格式（跟 Claude Desktop / VSCode Copilot 一样）。支持 `${env:NAME}`、`${userHome}`、`${workspaceFolder}` 插值。

**注入方案抉择**：
- **方案 A（推荐）**：`CURSOR_CONFIG_DIR=/tmp/mteam-xxx cursor-agent ...`，在临时目录写 `mcp.json` 和 `cli-config.json`。不动用户 HOME，不动用户仓库。
- **方案 B（污染风险）**：在用户指定的 project cwd 下写 `.cursor/mcp.json`。缺点：如果这是个 git 仓库，会污染工作区；需要在 agent 退出后清理（且要小心不要覆盖用户自己的 `.cursor/mcp.json`）。
- **不推荐**：HOME 隔离。会同时失去 `~/.cursor/cli-config.json` 里用户设的 permissions、vim mode、OAuth 状态。

---

### 5. Trae Agent（字节豆包）

**源码路径**：`trae_agent/cli.py`

```python
@click.option(
    "--config-file",
    help="Path to configuration file",
    default="trae_config.yaml",
    envvar="TRAE_CONFIG_FILE",
)
```

- 默认值 `trae_config.yaml` 是**相对路径**，Python 会从 cwd 解析。
- 可以用 `--config-file <path>` CLI 参数或 `TRAE_CONFIG_FILE` 环境变量**完全指定配置文件路径**。
- `trae_config.yaml` 里直接可写 `mcp_servers:` 段（官方文档有）。

**注入方案**：最简单的一个 —— 生成一份临时 `trae_config.yaml` 到临时目录，启动时 `TRAE_CONFIG_FILE=/tmp/mteam-xxx/trae_config.yaml trae-cli run ...` 即可。**无需 HOME 隔离**，甚至不用改 cwd。

**优先级**（官方 README）：命令行 > 配置文件 > 环境变量 > 默认值。

---

## 关于"cwd 下的配置文件"的处理

cwd 是用户指定的项目目录（代码仓库），不能用 HOME 隔离的办法屏蔽。以下文件各 CLI 会从 cwd 读：

| 文件 | 被谁读 | 怎么办 |
|------|------|--------|
| `CLAUDE.md` | Claude Code | 尊重用户仓库里的。想禁用：`--bare` |
| `AGENTS.md` | Codex | 尊重。这是 project-level 指令，用户自己放的 |
| `GEMINI.md` | Gemini | 尊重 |
| `.mcp.json` | Claude Code（项目级 MCP） | 用 `--strict-mcp-config` 忽略 |
| `.cursor/mcp.json` | Cursor | 要么写进去（污染），要么用 `CURSOR_CONFIG_DIR` 走全局 |
| `.cursor/rules/` | Cursor | 尊重 |
| `.cursorrules` | Cursor | 尊重 |
| `./trae_config.yaml` | Trae | 用 `TRAE_CONFIG_FILE` 指向别处就不会读 |

**原则**：cwd 配置是用户有意放在项目里的，mteam 不该代替用户决定。想注入额外 MCP，走全局/用户级（通过专用 env var 隔离到临时目录），不要去 cwd 里写文件。唯一例外是 Cursor 的项目级 MCP（如果必须用项目级），但要在 agent 退出时做文件级清理。

---

## 最终推荐方案

**核心原则**：每个 CLI 都有自己的专用 env var，用它们比 HOME 隔离更精确、副作用更小。

### 注入流程（每个 agent 启动前）

1. 在 team-hub 的 temp 区创建 per-agent 临时目录：`/tmp/mteam/<agent_id>/`
2. 根据 agent 使用的 CLI 类型，写入对应的配置文件：
   - Claude Code：**不写文件**，启动时直接 `--mcp-config /path/to/generated.json --strict-mcp-config`
   - Codex：写 `/tmp/mteam/<agent_id>/codex/config.toml`，启动时 `CODEX_HOME=/tmp/mteam/<agent_id>/codex`
   - Gemini：写 `/tmp/mteam/<agent_id>/gemini-home/.gemini/settings.json`，启动时 `GEMINI_CLI_HOME=/tmp/mteam/<agent_id>/gemini-home`
   - Cursor：写 `/tmp/mteam/<agent_id>/cursor/mcp.json`（+ 必要的 `cli-config.json`），启动时 `CURSOR_CONFIG_DIR=/tmp/mteam/<agent_id>/cursor`
   - Trae：写 `/tmp/mteam/<agent_id>/trae_config.yaml`，启动时 `TRAE_CONFIG_FILE=/tmp/mteam/<agent_id>/trae_config.yaml`
3. agent 退出时，删 `/tmp/mteam/<agent_id>/`。

### 认证怎么办？

用户的登录态（OAuth、API key、installation_id）都在真正的 `~/.xxx/` 下。用 env var 隔离 **会丢这些登录态** —— agent 启动会要求重新登录。

两种选法：
- **A 完全隔离**：agent 用独立身份（独立 API key 注入到 env）。最安全、无污染，但需要 team-hub 自己管 key。
- **B 继承用户登录态**：在写临时配置目录时，把关键认证文件 **拷贝或 symlink** 过去。例如：
  - `ln -s ~/.codex/.credentials.json $CODEX_HOME/.credentials.json`
  - `ln -s ~/.gemini/oauth_creds.json $GEMINI_CLI_HOME/.gemini/oauth_creds.json`
  - `ln -s ~/.cursor/cli-config.json $CURSOR_CONFIG_DIR/cli-config.json`
  - `ln -s ~/.claude/.credentials.json $CLAUDE_CONFIG_DIR/.credentials.json`（若用 CLAUDE_CONFIG_DIR）
- 推荐走 B 的 symlink：保留用户身份，但只新增/覆盖 MCP 段。风险：agent 意外写回这些文件会污染用户登录态。所以最好 **只 symlink 只读取的认证文件，settings/mcp 单独写新文件**。

### 为什么不用 HOME 隔离

- 会同时切掉：`~/.config/`、`~/.cache/`、`~/.npm/`（Node CLI 用）、`~/.local/`、`~/.gitconfig`、`~/.ssh/`、`~/.aws/`、`~/.docker/` …… 各种不属于目标 CLI 的东西。
- git 全局配置丢了，agent 里跑 `git commit` 就炸（没有 user.name/user.email）
- npm/bunx 启动 MCP 服务器时找不到 `~/.npmrc`
- 任何工具链的全局 hook/alias 都失效
- 对 subprocess（shell、node-pty 启动的子进程）有级联污染

**一句话**：HOME 是"太大一块"，各 CLI 的专用变量是"刚好的一小块"。能用小块就别动大块。

---

## 附录：关键源码/文档引用

- Claude Code env-vars: https://code.claude.com/docs/en/env-vars.md（搜 `CLAUDE_CONFIG_DIR`）
- Claude Code CLI help：`claude --help`（`--mcp-config`、`--strict-mcp-config`、`--settings`、`--agents`、`--bare`）
- Codex home 解析：https://github.com/openai/codex/blob/main/codex-rs/utils/home-dir/src/lib.rs
- Codex config 文档：https://github.com/openai/codex/blob/main/docs/config.md
- Gemini `homedir()` & Storage：
  - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/paths.ts
  - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts
- Gemini settings 优先级（system/user/workspace）：`packages/cli/src/config/settings.ts`
- Cursor CLI config：https://cursor.com/docs/cli/reference/configuration.md
- Cursor MCP：https://cursor.com/docs/mcp.md
- Trae CLI argv：https://github.com/bytedance/trae-agent/blob/main/trae_agent/cli.py（搜 `--config-file`）
