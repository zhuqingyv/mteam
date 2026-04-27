# member-agent

成员 Agent 纯函数工具集。**非业务模块** — 不 import bus / db / domain / mcp-manager，仅依赖 node 内建。

Stage 3 从 `pty/` 目录迁出后统一落在这里，胶水逻辑由 `bus/subscribers/member-driver/` 编排。

---

## 1. `prompt.ts` — 成员 system prompt 组装

### 职责

一句话：根据成员身份、Leader 关系和当前任务生成 CLI `--append-system-prompt` 内容。

### 接口

```ts
export interface AssemblePromptInput {
  memberName: string;         // 成员展示名
  isLeader: boolean;          // 是否本轮 Leader
  leaderName: string | null;  // 上级 Leader 的展示名；null / '' 都视为未绑定
  persona: string | null;     // 角色模板 persona；null 用 '（未定义身份）'
  task: string | null;        // 当前任务正文；空 / 仅空白都视为无任务
}

export function assemblePrompt(input: AssemblePromptInput): string;
```

### 输出示例

```text
# 系统提示
你是 M-Team 体系内的一个 Agent。你的工作围绕两件事展开：
1、利用 mnemo 完成用户的任何任务
2、围绕 mteam 完成团队协作

# 角色
本轮你的 Leader 是 alice。
你的名字是：bob，你的身份是：开发

# 任务
写 registry 模块
```

### 分支规则

- `isLeader=true` → 第 1 行：`本轮你被指派为 Leader。`
- `isLeader=false && leaderName` 非空 → `本轮你的 Leader 是 ${leaderName}。`
- `isLeader=false && !leaderName` → `本轮你尚未绑定 Leader。`
- `persona` 为空 → `（未定义身份）`
- `task` 为空或全空白 → `# 任务\n（暂无具体任务，等待 Leader 分配）`

### 注意

- 本函数对应旧 `pty/prompt.ts` 的原样迁移，字段语义不变。
- 调用方负责从 domain / template 里把字段取齐；本模块不读 DB。

---

## 2. `format-message.ts` — 注入成员的消息通知行（W2-F v2）

### 职责

把一条信封（envelope）渲染成**一行**通知字符串，喂给 `driver.prompt(text)`。成员 CLI 看到这行后，自行决定是否用 `read_message(msg_id)` 拉全文。

### 接口

```ts
export interface FormatNotifyInput {
  envelopeId: string;       // MessageEnvelope.id，形如 'msg_xxx'
  fromDisplayName: string;  // from.displayName（alias 优先，否则 memberName / User / 系统）
  summary: string;          // envelope.summary
}

export function formatNotifyLine(input: FormatNotifyInput): string;

// @deprecated shim；下个 Phase 删。老签名 delegate 到 formatNotifyLine，
//   envelopeId 占位为 'msg_legacy'。新代码禁止调。
export function formatMemberMessage(payload: FormatMemberMessageInput): string;
```

### 输出契约

```
@${fromDisplayName}>${summary}  [msg_id=${envelopeId}]
```

严格匹配正则：`/^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$/`（两空格分隔）。

### 示例

```ts
formatNotifyLine({ envelopeId: 'msg_abc', fromDisplayName: 'Alice', summary: '帮我看下 bug' });
// → "@Alice>帮我看下 bug  [msg_id=msg_abc]"

formatNotifyLine({ envelopeId: 'msg_sys1', fromDisplayName: '系统', summary: 'offline approved' });
// → "@系统>offline approved  [msg_id=msg_sys1]"
```

### 注意事项

- 通知行不含 `content`、`kind`、`action`；agent 想看详情调 `read_message(msg_id)`。
- 成员侧所有入口（`send_msg` 投递、系统通知、离线 replay）统一走这个格式。
- 不做 HTML / shell 转义；summary 由上游（`buildEnvelope`）保证 trim 后非空。

---

## 3. `driver-config.ts` — 成员 AgentDriver DriverConfig 装配（纯函数）

### 职责

把**已经解析好**的 `template / instance / resolvedMcps` 转成 `DriverConfig`，交给 `new AgentDriver(id, config)`。**本模块不碰仓储、不调 mcpManager、不起 SQLite、不访问全局单例**。

Wave 2 的 `bus/subscribers/member-driver/lifecycle.ts` 负责：
1. `RoleTemplate.findByName` / `RoleInstance.findById` 取数据；
2. `mcpManager.resolve(...)` 算出 `ResolvedMcpSet`；
3. 把这些塞进本函数；拿到 `DriverConfig` 再 `new AgentDriver(...)`。

### 接口

```ts
export interface BuildMemberDriverConfigInput {
  instance: {
    id: string;
    memberName: string;
    leaderName: string | null;
    task?: string | null;
    runtimeKind?: 'host' | 'docker';
  };
  template: {
    persona?: string | null;
    role?: { cliType?: string };
  };
  resolvedMcps: ResolvedMcpSet;   // mcpManager.resolve() 的产物
  cwd?: string;
}

export function buildMemberDriverConfig(input: BuildMemberDriverConfigInput): {
  config: DriverConfig;
  skipped: string[];
};
```

### 字段映射

| DriverConfig 字段 | 来源 |
|------------------|------|
| `agentType`      | `cliTypeToAgentType(template.role?.cliType ?? 'claude')`（复用 primary-agent 映射） |
| `systemPrompt`   | `assemblePrompt({ memberName, isLeader: false, leaderName, persona, task })` |
| `mcpServers`     | `buildMcpServerSpecs({ resolved, runtimeKind, instanceId, mcpHttpBaseForHost, mcpHttpBaseForDocker })`（S4 W2-B §1.5） |
| `cwd`            | `input.cwd ?? homedir()` |
| `env`            | `ROLE_INSTANCE_ID / CLAUDE_MEMBER / IS_LEADER='0' / TEAM_HUB_NO_LAUNCH='1'` |

`skipped` 透传 `resolvedMcps.skipped`，上层决定是否 stderr 告警。

### 使用示例（胶水层）

```ts
import { mcpManager } from '../../mcp-store/mcp-manager.js';
import { buildMemberDriverConfig } from '../../member-agent/driver-config.js';

const resolved = mcpManager.resolve(template.availableMcps, {
  instanceId: instance.id, hubUrl, commSock, isLeader: false,
});
const { config, skipped } = buildMemberDriverConfig({
  instance, template, resolvedMcps: resolved,
});
const driver = new AgentDriver(instance.id, config);
```

### 注意事项 / 边界

- **`isLeader` 恒为 false** — 成员专用；leader 装配走 `primary-agent/driver-config.ts::buildDriverConfig()`。
- **不写 tmp MCP 配置文件** — ACP 版直接用 `McpServerSpec[]`；旧 pty 链路的 `writeFileSync(tmpdir(), ...)` 在本模块废弃。
- **不支持的 `cliType` 抛错** — `cliTypeToAgentType` 对 claude/codex/qwen 之外直接 throw，调用方自己捕获后打到 `driver.error`。
- **纯函数** — 同样的输入必出同样的输出（除 `homedir()` 兜底 `cwd` 会随环境变化）。
- **Stage 4 W2-B 已收口** — mcp 产物装配统一走 `primary-agent/launch-spec-builder::buildMcpServerSpecs()`：
  - `builtin` MCP（mteam / searchTools）→ HTTP（host 走 `localhost:58591`，docker 走 `host.docker.internal:58591`）
  - `user-stdio` MCP → 原样 stdio 透传（Stage 5 再补 docker volume 挂载）
  - HTTP 请求头按 `instance.runtimeKind` + `X-Role-Instance-Id`/`X-Is-Leader`/`X-Tool-Visibility` 注入
- **`instance.runtimeKind` 缺省 `'host'`** — Stage 5 持久化到实例表后由 lifecycle 读入；缺省仅为 Stage 4 过渡期 fallback。
