# policy

策略模块。负责判断一次工具调用是否被允许。

当前阶段（Stage 5）包含：

- `rule-matcher.ts` — 规则字符串匹配与两级评估
- `rule-loader.ts` — yaml 全局规则 + 模板白名单的 IO 层（本文件 M2a 段）
- `rule-merger.ts` — 两级白名单 + 全局 deny 的纯函数合并（本文件 M2b 段）

## rule-matcher

纯字符串处理，零依赖、零副作用。只解决「一个 toolName 在给定 allow/deny 列表下应当得到什么判定」。

### 规则语法

| 形态 | 例子 | 语义 |
|------|------|------|
| 精确匹配 | `Bash` / `mcp__mteam__search_members` | 字符串完全相等，大小写敏感 |
| 末位通配 | `mcp__mteam__*` | 前缀匹配，`toolName` 以 `mcp__mteam__` 开头即命中 |
| 全通配 | `*` | 匹配一切 |

> 只支持末位 `*`。中间出现的 `*` 不识别为通配，退化为字符串完全相等（不会抛错）。这条边界是为了在未来引入更强的 glob 语法前，保持「不符合语法的 pattern 不会静默放行」的安全默认。

### 接口

```ts
import { matchPattern, evaluate } from './rule-matcher.js';

matchPattern('mcp__mteam__*', 'mcp__mteam__search'); // true
matchPattern('Bash', 'bash');                         // false（大小写敏感）

evaluate('Bash', { allow: ['*'], deny: ['Bash'] });
// → { verdict: 'deny', matchedPattern: 'Bash' }
```

返回值：

```ts
interface PolicyDecision {
  verdict: 'allow' | 'deny' | 'no_match';
  matchedPattern: string | null; // 命中的规则原文，no_match 时为 null
}
```

### 评估顺序

1. 先扫 `deny` 列表，任一命中立即返回 `deny`。
2. 否则扫 `allow`，命中返回 `allow`。
3. 都未命中返回 `no_match`。调用方（见 M7 policy.subscriber）据此配合「是否已配置白名单」决定默认放行或拦截。

### 注意事项

- **无副作用**：纯函数，可自由在事件回调内调用。
- **不读配置**：allow/deny 由调用方提供，规则来源（yaml / DB）由 M2a + M2b 负责。
- **`matchedPattern` 用于审计**：便于下游 `log.subscriber` 记录「被哪条规则拦下/放行」。
- **性能**：O(N) 扫列表；Stage 5 规则集规模（<< 1000 条）下无需索引优化。

## rule-loader

只管 IO 的一层：把"全局 yaml 规则"和"模板级白名单（DB 注入）"拉到进程内，给 `rule-merger` / `policy.subscriber` 直接取快照。不做合并判定，也不触碰事件总线。

### 接口

```ts
import { createRuleLoader, type RuleLoader } from './rule-loader.js';

const loader: RuleLoader = createRuleLoader({
  configPath: '~/.claude/team-hub/policy.yaml', // 默认值；测试里可覆盖
  watch: true,                                   // 默认 true；测试里可关
  readTemplateWhitelist: (instanceId) =>
    db.getTemplate(instanceId)?.toolWhitelist ?? null, // 注入式
});

loader.getGlobalRules();          // { allow: string[]; deny: string[] }（内存快照）
loader.getTemplateAllow('inst-1'); // string[] | null（透传注入函数）
loader.close();                    // 关 fs.watch，进程 shutdown 用
```

### yaml 示例

```yaml
# ~/.claude/team-hub/policy.yaml
global_allow:
  - Read
  - Bash
  - mcp__mteam__*
global_deny:
  - Write
  - Edit
```

- 只识别两个顶层键：`global_allow` / `global_deny`。其它键忽略。
- 支持 `- item` 块列表或同行 flow 数组 `[a, b]`；支持 `#` 行尾注释和 `"..."` / `'...'` 包裹。
- 解析器是自带的极简实现（不引入 `js-yaml`）。复杂 yaml 语法（锚点、嵌套对象、多行字符串）**不支持**；策略文件不应超出上面的 shape。

### 热加载行为

- `createRuleLoader` 同步读一次 yaml 填充初始快照。
- 随后用 `fs.watch(configPath, { persistent: false })` 监听；文件变更触发同步重读 + 原子替换 `snapshot`。
- `getGlobalRules()` 永远返回当前快照引用，调用方**不要就地修改**返回对象（共享内存）。
- `{ persistent: false }` 保证 watcher 不阻止进程退出。

### 容错

| 情况 | 行为 |
|------|------|
| yaml 文件不存在 | 初始快照 = `{ allow: [], deny: [] }`，不抛；`fs.watch` 若同时 ENOENT 静默跳过 |
| yaml 解析/读取异常（如 EISDIR） | log warn，**保留上次快照**（别让坏配置炸整个 bus）|
| watcher 运行时抛错 | log warn，不中断主流程 |
| 热加载中途文件被删 | 保留上次快照（下次变更仍会尝试读）|

### getTemplateAllow 行为

- 纯粹透传注入的 `readTemplateWhitelist(instanceId)`，不加额外缓存。
- 未注入函数 → 恒返 `null`（等价"未配置模板白名单"，调用方按 default allow 处理）。
- 参数名钉死为 `instanceId`（与 Stage 3 `driverId === instanceId` 口径一致，见 `INTERFACE-CONTRACTS.md` §4.2），Loader 不做翻译。

### close 时机

- 关 `fs.watch` 句柄，之后文件变更不会再触发 reload。
- 进程 shutdown（`bus.teardownSubscribers()` / M8）时调用；单测 afterEach 也建议调一次避免 watcher 泄漏。
- 幂等：二次 close 静默 no-op。

### 依赖

- `node:fs` / `node:path` / `node:os`（zero npm dep）。
- DB 层通过 `readTemplateWhitelist` 注入式解耦，loader 本身不 import 业务代码。

## rule-merger

把"模板级 allow 数组"与"全局规则（allow / deny）"合并成调用方可直接用的 `EffectiveRules`。纯函数，零 IO。

### 接口

```ts
import { mergeRules, type GlobalRules, type EffectiveRules } from './rule-merger.js';

const rules: EffectiveRules = mergeRules(
  ['Bash'],                                  // 模板 allow；传 null 表示未配置
  { allow: ['Read'], deny: ['Kill'] },       // 全局规则
);
// → { allow: ['Bash', 'Read'], deny: ['Kill'], configured: true }
```

### 合并规则

- 有效 `allow` = `templateAllow ∪ global.allow`，**模板在前**、按首次出现顺序去重。
- 有效 `deny`  = `global.deny`（模板**不设** deny；deny 是全局安全底线，模板不能绕过）。
- `templateAllow === null` → `configured=false`，调用方按 default allow（未配置白名单的 instance 不拦截）。
- `templateAllow === []`   → `configured=true`，显式空白名单；调用方仍需调 `evaluate`，未命中即拦截。

### configured 语义（调用方必读）

`configured` 区分两种"未命中"场景：

| 场景 | configured | 调用方决策 |
|------|------------|-----------|
| 该 instance 未配置模板白名单 | `false` | default allow，`policy.subscriber` 放行所有 |
| 已配置白名单但 `toolName` 未命中 | `true`  | 违规，按 `reason='not_in_whitelist'` 强制下线 |

> merger **不做** deny vs allow 的优先级判定 —— 那是 `rule-matcher.evaluate` 的活。
> merger 只负责"把两个来源合并成 allow/deny 两张表"，把合并结果丢给 matcher 判优。

### 边界行为

- **纯函数**：不修改入参（`templateAllow` / `global` 保持原样），返回对象里的 `allow` / `deny` 是新数组。
- 空入参（`null` + 空全局）返回 `{ allow: [], deny: [], configured: false }`。
- 去重保证 allow 合并和 global.deny 都不出现重复项（防误配）。

### 依赖

零。纯字符串 + 数组。同文件自带 `GlobalRules` / `EffectiveRules` 类型导出，调用方（M2a / M7）可直接 import 使用。
