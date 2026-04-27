# filter

业务过滤器模块：统一承载"谁能看到什么事件"的规则。

Phase WS Wave 1 本期只落地 **W1-E 类型层**（本文件夹当前只有 `types.ts`）。`filter-store.ts`（W1-F，SQLite DAO）与 `visibility-filter.ts`（W2-4，业务胶水）稍后跟进。

## 这个模块是什么

纯类型契约，让 Phase WS 的 comm 层与事件广播层在"可见性"判定上有一份共享的语言。

- 非业务模块：不 import 任何业务代码，不依赖 bus / db / config
- 消费方（ws-broadcaster / visibility-filter / filter-store）靠 `import type` 吃契约

## 类型概览

`types.ts` 导出：

| 名称 | 作用 |
|------|------|
| `ActorPrincipal` | 可观测主体：`user` / `agent` / `system` 三选一 |
| `RuleTarget` | 规则的目标方：`ActorPrincipal` ∪ `{ kind:'team'; teamId }` |
| `VisibilityRule` | 一条规则：principal + target + effect('allow'\|'deny') + note? + createdAt |
| `VisibilityDecision` | 过滤判定结果：allow+byRuleId(含 `'default_allow'`) 或 deny+byRuleId |
| `FilterStore` | DAO 接口：`list` / `listForPrincipal` / `upsert` / `remove` |
| `isActorPrincipal` / `isRuleTarget` / `isVisibilityRule` | 运行时类型守卫 |

## 使用示例

```typescript
import type { VisibilityRule, FilterStore } from './filter/types.js';
import { isVisibilityRule } from './filter/types.js';

function addRule(store: FilterStore, raw: unknown): void {
  if (!isVisibilityRule(raw)) throw new Error('invalid rule payload');
  store.upsert(raw);
}

const rule: VisibilityRule = {
  id: 'r1',
  principal: { kind: 'user', userId: 'u1' },
  target: { kind: 'agent', instanceId: 'inst_leak' },
  effect: 'deny',
  createdAt: new Date().toISOString(),
};
```

## 为什么 team 不能作为 principal

**principal 描述"谁在看事件"。team 不是一个会订阅 WS / 读消息的实体 —— 真正的可观测主体永远是 user（前端连接）或 agent（driver 进程）或 system（后端内部）。**

团队作为"分发入口"的语义在 **target** 侧仍然合法：

- `{ kind:'team', teamId:'t1' }` 作为 target 表示"该条规则针对发给/来自 t1 的事件"
- visibility-filter 在判定时会把事件的 teamId 抽出来与 target.teamId 匹配

把 team 塞进 principal 会让两类问题同时出现：

1. 运行时无法回答"某条事件该不该给 team 看" —— team 没有 WS 连接
2. DB 侧 `principal_kind IN ('user','agent','system')` CHECK 约束与类型漂移脱钩

所以契约层直接用 `ActorPrincipal` discriminated union 排除 team。`RuleTarget` 则是 `ActorPrincipal` 的超集，用来把"允许 team 当目标"这件事明码写在类型里。

## VisibilityDecision 里的 `default_allow`

无规则命中时的兜底判定是 "allow"（MILESTONE §功能 2：default_allow）。`byRuleId` 此时用字面量 `'default_allow'` 而非真实 uuid，便于日志与 UI 区分"显式放行"与"兜底放行"。

`deny` 分支不存在兜底，因此 `byRuleId` 必须指向具体规则 id。

## 边界行为

- `isVisibilityRule` 要求 `id` / `createdAt` 均为非空字符串；`note` 可省，若存在必须是 string
- 类型守卫**不做**规则之间的冲突检查（deny 优先短路等语义属 visibility-filter）
- 类型守卫**不校验** `createdAt` 是否为合法 ISO-8601；DAO 层自己保证写入格式

## 测试

`types.test.ts`：

- 类型级断言用 `@ts-expect-error` + 显式结构赋值确保契约冻结（如 team 不能当 principal）
- 运行时守卫覆盖 `isActorPrincipal` / `isRuleTarget` / `isVisibilityRule` 的所有分支与反例

运行：`cd packages/backend && bun test src/filter/types.test.ts`
