# filter-store (W1-F)

`visibility_rules` 表的 SQLite DAO。纯数据访问层，不碰业务规则判定（那是 W2-4 `visibility-filter.ts` 的事）。

## 一句话

给定 `VisibilityRule`（类型契约见 `./types.ts`），提供 CRUD + 按 principal 索引查询。

## 接口

```typescript
export function createFilterStore(): FilterStore;

interface FilterStore {
  list(): VisibilityRule[];
  listForPrincipal(p: ActorPrincipal): VisibilityRule[];
  upsert(rule: VisibilityRule): void;
  remove(id: string): void;
}
```

## 使用示例

```typescript
import { createFilterStore } from './filter-store.js';

const store = createFilterStore();

store.upsert({
  id: 'r_1',
  principal: { kind: 'user', userId: 'u1' },
  target: { kind: 'agent', instanceId: 'inst_leak' },
  effect: 'deny',
  createdAt: new Date().toISOString(),
});

const u1Rules = store.listForPrincipal({ kind: 'user', userId: 'u1' });
store.remove('r_1');
```

## Schema

见 `packages/backend/src/db/schemas/visibility_rules.sql`（由 `db/connection.ts::applySchemas` 启动时合并执行；无需单独迁移脚本）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 规则 id，调用方生成（通常 uuid） |
| `principal_kind` | TEXT CHECK | `'user' / 'agent' / 'system'` |
| `principal_ref` | TEXT NULL | userId / instanceId；`kind='system'` 时 NULL |
| `target_kind` | TEXT CHECK | `'user' / 'agent' / 'system' / 'team'` |
| `target_ref` | TEXT NULL | 对应 id；`kind='system'` 时 NULL |
| `effect` | TEXT CHECK | `'allow' / 'deny'` |
| `note` | TEXT NULL | 规则说明（可选） |
| `created_at` | TEXT NOT NULL | ISO-8601 字符串，由调用方填 |

两条索引：`(principal_kind, principal_ref)` 与 `(target_kind, target_ref)`。

## 方法对照表

| 方法 | SQL | 备注 |
|---|---|---|
| `list()` | `SELECT * ORDER BY created_at, id` | 按时间升序稳定排序，便于 UI 列表展示 |
| `listForPrincipal(p)` | 非 system：`WHERE principal_kind=? AND principal_ref=?`；system：`WHERE principal_kind='system' AND principal_ref IS NULL` | 见下方"为何 system 单独一支" |
| `upsert(rule)` | `INSERT OR REPLACE` by `id` | 同 id 整条替换，调用方不需要先 delete |
| `remove(id)` | `DELETE WHERE id=?` | 不存在的 id 不抛错（静默） |

### 为何 principal_ref 允许 NULL

`ActorPrincipal` 的 `system` 分支没有任何 id（就是"后端自己"这一个单一主体）。把 `principal_ref` 写成 NULL 比写成假 id（`'system'` / 空串）更诚实 —— 未来 `system` 继续单一，我们不改 schema；若有一天真的要分"系统子模块"，加一个新列或放宽 NULL 语义都比收回假 id 容易。

`target_ref` 同理，且未来也许会加更多"无 ref 的聚合目标"（例如 `kind='broadcast'`）。

### 为何 system principal 查询要单独一支

SQLite 里 `ref = ?` 这种等值匹配永远匹配不到 `NULL`（SQL 语义：`NULL = NULL` 结果是 `NULL` 不是 `TRUE`）。如果把所有查询统一成 `principal_ref = ?`，`listForPrincipal({ kind:'system' })` 会永远返回空。因此 system 分支单独走 `principal_ref IS NULL`。

两个分支共用同一个映射函数 `principalToRow`，保证写入和查询的枚举值不会漂。

## 并行读写

DAO 方法都是同步 `better-sqlite3` / `bun:sqlite` 接口，`upsert` / `remove` 是单语句事务，天然原子。多线程/多进程场景靠 SQLite 自身的 busy_timeout（`connection.ts` 设了 5s）+ WAL 模式；本模块不做额外锁。

## 不负责什么

- **规则判定**：`canSee` / deny 短路等语义归 `visibility-filter.ts`（W2-4），DAO 不懂"规则打不打得起"。
- **CHECK 校验之外的业务语义**：例如"同 principal 对同 target 既 deny 又 allow 是否合法"—— DAO 如实存储，判定层决定生效策略。
- **规则变更事件**：W2-4 胶水层需要时可以在 upsert/remove 外围自己发 bus 事件。DAO 保持静默。

## 测试

`__tests__/filter-store.test.ts` 用 `TEAM_HUB_V2_DB=:memory:` 真 SQLite（不 mock）：

- upsert/list/remove 基础闭环
- `listForPrincipal` 命中 / 不命中 / system 单独分支
- 同 id 覆盖 upsert
- `target` 四种 kind 的往返一致性（含 team）
- `note` undefined ↔ NULL ↔ 回读仍 undefined
- 非业务静态检查（不 import bus / comm / visibility-filter）
- schema 无外键 + principal_ref/target_ref 允许 NULL + CHECK 约束生效

运行：

```
cd packages/backend && bun test src/filter/__tests__/filter-store.test.ts
```
