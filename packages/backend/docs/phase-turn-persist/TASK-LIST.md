# phase-turn-persist · TASK-LIST

> 目标：主 Agent 对话持久化 + 启动时历史注入 system prompt。
>
> 范围边界：
> 1. Turn 持久化模块纯净，**不**感知 primary-agent，任何 driver 的 turn.completed 都会入库（为未来复用兜底；查询时按 driverId 过滤就只看主 Agent）。
> 2. 启动注入只写在 `primary-agent.ts` / `driver-config.ts`，成员 agent 路径（member-driver.*）不接入。
> 3. 历史对话只写进 system prompt 末尾，不作为 user prompt；不触发推理。
> 4. 每次 `primaryAgent.start()` 都是全新 session；不碰 session/load/resume。

## 用户需求原话映射

| 需求原话 | 本方案对应点 |
| --- | --- |
| "主Agent的通话记录存起来，完整的，包括工具调用等等一切细节" | Wave 1 T1/T2：`turn_history` 表 + blocks JSON 整包存 |
| "默认近期10条对话记录，正在活跃的对话是从启动那10条以后完整的" | Wave 2 T4：启动读 10 条拼 prompt；新 session 从 11 起增量 |
| "历史对话不要直接引起推理，用户问答以后才推理" | Wave 2 T4：只注入 system prompt 末尾，不作为 prompt 发送 |
| "仅仅主Agent生效，这个是主Agent的定制逻辑" | Wave 2 T4：仅在 `primary-agent.ts#start()` 读 DB 拼 prompt |
| "在主Agent这块特殊注入一个提示词就行了，然后加一个DB" | Wave 1 建表 + Wave 2 提示词拼装 |
| "每一次主Agent都是启动一个新的Session" | Wave 2 T4：不走 resume / load，`driver.start()` 不带 sessionId |

---

## Wave 1 · 非业务（纯净持久化模块）

三个任务可并行，互相无依赖。完成后 Wave 2 接入。

### T1 · 新 DB schema + 迁移

**目标**：新增 `turn_history` 表承载所有 driver 的完整 Turn 快照。

**代码位置 / 产出**：
- 新建 `packages/backend/src/db/schemas/turn_history.sql`（预估 25 行）
- 无迁移脚本（新表，首次 applySchemas 即可；不改现有表）。

**表结构**（字段一一对应 `Turn` 接口）：
```sql
CREATE TABLE IF NOT EXISTS turn_history (
  turn_id       TEXT PRIMARY KEY,        -- Turn.turnId
  driver_id     TEXT NOT NULL,           -- Turn.driverId
  status        TEXT NOT NULL            -- 'done' | 'error'
                CHECK(status IN ('done','error')),
  user_input    TEXT NOT NULL,           -- JSON: UserInput（text/attachments/ts）
  blocks        TEXT NOT NULL,           -- JSON: TurnBlock[]（thinking/text/tool_call/...）
  stop_reason   TEXT,                    -- StopReason 字面量
  usage         TEXT,                    -- JSON: TurnUsage | NULL
  start_ts      TEXT NOT NULL,           -- Turn.startTs
  end_ts        TEXT NOT NULL            -- Turn.endTs（finish 时一定写入）
);

-- 主 Agent 查询主路径：(driver_id, end_ts DESC, turn_id DESC)
-- 复合索引含 turn_id 是给 T2 keyset 游标分页做 tie-breaker（同毫秒 Turn 不漂移）。
CREATE INDEX IF NOT EXISTS idx_turn_hist_driver_end
  ON turn_history(driver_id, end_ts DESC, turn_id DESC);
```

**完成判据**：
1. `applySchemas()` 跑完后 `PRAGMA table_info(turn_history)` 返回 9 列，列名/类型与上面完全一致。
2. 新建空库 + 重启均不报错（`bun run typecheck && bun test packages/backend/src/db/` 绿）。
3. 老库（现有开发库 `~/.claude/team-hub/v2.db`）重启不报错（schemas 目录字母顺序 `turn_history.sql` 排在最后，不影响 `primary_agent.sql` / `messages.sql`）。

**非目标**：
- 不建 FK 到 `primary_agent(id)`——表复用给未来其他 driver。
- 不做按天分区、不做 TTL；留给后续运维。

---

### T2 · Turn ⇄ Row 序列化工具 + DAO

**目标**：纯函数 `turnToRow / rowToTurn` + DAO（insert / listBy / count）。单测独立跑，不依赖 bus / primary-agent。

**代码位置 / 产出**：
- 新建 `packages/backend/src/turn-history/serializer.ts`（预估 50 行）
  - `export function turnToRow(turn: Turn): TurnHistoryRow`
  - `export function rowToTurn(row: TurnHistoryRow): Turn`
  - `export interface TurnHistoryRow { turn_id; driver_id; status; user_input; blocks; stop_reason; usage; start_ts; end_ts }`
- 新建 `packages/backend/src/turn-history/repo.ts`（预估 100 行）
  - `export function insertTurn(turn: Turn): void` —— PK 冲突走 **`INSERT OR IGNORE`**（首次落库为准；重发/崩溃恢复后的二次写入**不覆盖**。语义选择理由：`turn.completed` 在 aggregator 正常路径只发一次，但若 error+completed 同 turnId 重入，先到的是正式终态，不让后到的把它抹掉）。
  - `export function listRecentByDriver(driverId: string, opts: { limit: number; before?: TurnCursor }): Turn[]`
    - **游标定义**：`export interface TurnCursor { endTs: string; turnId: string; }` —— 复合键，解决"同毫秒多条 Turn"导致的翻页漂移/重复/漏读。
    - **排序**：`ORDER BY end_ts DESC, turn_id DESC`（复合索引一致的 tie-breaker）。
    - **WHERE（before 存在时）**：`(end_ts < :beforeEndTs) OR (end_ts = :beforeEndTs AND turn_id < :beforeTurnId)`——标准的 keyset pagination。
    - 前端首页传 `before: undefined`；下一页用上页最后一条返回的 `{ endTs, turnId }` 原样回传。
  - `export function countByDriver(driverId: string): number`
  - **T1 索引补强**：`idx_turn_hist_driver_end` 需升级为复合索引 `(driver_id, end_ts DESC, turn_id DESC)` 支撑 keyset；T1 的 sql 文件同步修改。
- 新建 `packages/backend/src/turn-history/repo.test.ts`（预估 150 行，覆盖：
  - Turn 圆环（insert → listRecent → 对比深相等）
  - `usage=undefined` / `stopReason=undefined` / `attachments` 有无
  - `blocks` 里所有 9 种 TurnBlockType 都能来回序列化
  - **OR IGNORE 语义**：同 turn_id 二次 insert **不覆盖**第一次（构造第一次 status=done，第二次 status=error 且 blocks 不同 → listRecent 读出来必须是第一次的 done 版本）
  - **复合游标分页**：insert 5 条；`listRecent(limit=2)` 返回第 4/5；传 `before={endTs, turnId}=第 3 条` 返回第 1/2
  - **同毫秒冲突**：insert 3 条 end_ts 完全相同但 turn_id 不同的 Turn；`listRecent(limit=2)` + 翻下一页能完整拿到所有 3 条、不重不漏
  - 不同 driver_id 互不污染

**完成判据**：
1. `bun test packages/backend/src/turn-history/repo.test.ts` 全绿（含同毫秒冲突测试）。
2. `wc -l` 确认 `serializer.ts ≤ 80`、`repo.ts ≤ 130`、`repo.test.ts ≤ 180`（每文件 ≤ 200 红线）。
3. `bun run typecheck` 绿。
4. `repo.ts` 里除 `bun:sqlite` / 本模块外 0 依赖（`grep -E "^import" packages/backend/src/turn-history/repo.ts | grep -v 'bun:sqlite\\|./serializer\\|agent-driver/turn-types\\|db/connection'` 应为空）。
5. `EXPLAIN QUERY PLAN` 看 listRecentByDriver 走 `idx_turn_hist_driver_end` 复合索引，不全表扫。

**边界契约**：
- `rowToTurn` 必须吃 `turnToRow` 的输出原样返回（不做字段兜底猜测）。
- 时间戳保持字符串，不转 Date（与 Turn 原始形状一致）。
- **游标契约**：`TurnCursor` 是不透明结构体，前端应原样回传；不要前端拼字符串。T5 HTTP 端点负责把它序列化成 URL query（见 T5）。

---

### T3 · turn-history 订阅器（纯模块，订阅 bus 写 DB）

**目标**：独立订阅器，监听 `turn.completed` → 调 `insertTurn`，包含崩溃轮次。**零** primary-agent 依赖。

**代码位置 / 产出**：
- 新建 `packages/backend/src/bus/subscribers/turn-history.subscriber.ts`（预估 55 行）
  - `export function subscribeTurnHistory(eventBus: EventBus = defaultBus): Subscription`
  - **订阅两个事件**：`turn.completed`（正常终态） + `turn.error`（崩溃）。注意 aggregator 对 error 轮次**两个事件都会 emit**（见 `turn-aggregator.subscriber.ts#finish()`），本订阅器**只**从 `turn.completed` 取 `turn` 字段落库；`turn.error` 不再二次落库（turn.error 无 `turn` 字段、只有 message，aggregator 已经先 emit 过 completed）。**落库条件**：`ev.type==='turn.completed'` 且 `turn.status ∈ {'done','error'}`。
  - **block 过滤**：落库前 `turn.blocks = turn.blocks.filter((b) => !isSessionScopeBlock(b))` —— session-scope（commands/mode/config/session_info）是驱动级元数据、不属于"对话记录"，持久化它们会污染翻页视图和注入视图。`isSessionScopeBlock` 直接复用 `agent-driver/turn-types.ts` 导出的守卫。
  - **写库失败**：catch 后 `process.stderr.write('[turn-history] insert failed: ...')`，不抛、不断流（一条写失败不能把订阅流炸掉）。TODO 注释："后续补 turn_history.write_failed bus 事件供运维告警"（见本文件末尾 §未来工作 F1）。
- 修改 `packages/backend/src/bus/index.ts`：在 `bootSubscribers` 里 T-9 聚合器 `subscribeTurnAggregator` 之后追加 `masterSub.add(subscribeTurnHistory(eventBus))`（3 行）。
- 新建 `packages/backend/src/bus/subscribers/turn-history.subscriber.test.ts`（预估 100 行，真 EventBus，真 in-memory db）：
  - `turn.completed` with status='done' → DB 能读到相同 Turn（按 turn_id get；含 text/thinking/tool_call blocks）
  - **崩溃轮次**：`turn.completed` with status='error' + stopReason='crashed' → DB 能读到；断言 row.status='error'
  - **session-scope 过滤**：blocks 含 [text, mode, config, session_info, tool_call] → 落库 row.blocks 只剩 [text, tool_call]；断言所有 session 类型都被过滤
  - 同 turnId 连发两次 → DB 只留一条（T2 的 INSERT OR IGNORE 生效，后发的**被忽略**，以**先落库**为准）。**测试细节**：第二次 emit 用不同 blocks/status 构造，断言 DB 仍是第一次的版本。
  - 写库 mock 抛异常 → 订阅器不断流（继续 emit 下一条仍能处理）；断言 `process.stderr.write` 调到
  - 订阅退订后新 emit 不再落库
  - `turn.error` 事件**不**触发二次落库（emit 顺序：先 completed（落库）→ 再 error（被动跳过））

**完成判据**：
1. `bun test packages/backend/src/bus/subscribers/turn-history.subscriber.test.ts` 全绿。
2. `bootSubscribers` 单测未因新订阅器挂掉（`bun test packages/backend/src/bus/index.test.ts` 绿）。
3. 文件 ≤ 90 行、测试 ≤ 130 行（红线 ≤ 200 行）。
4. `grep -l "primary-agent" packages/backend/src/bus/subscribers/turn-history.subscriber.ts` 空——禁止依赖 primary-agent。
5. 崩溃轮次可查：按 `listRecentByDriver(driverId, {limit: N})` 能在结果里看到 status='error' 的 Turn。

**非目标**：
- 不在这里做快照压缩 / 裁剪。
- 不改 aggregator（T-9）；in-memory history 环形（cap 50）继续保留，DB 是独立副本。
- 写库失败的 bus 告警事件（§F1）本期不做。

---

## Wave 2 · 业务胶水（依赖 Wave 1 完成）

### T4 · primaryAgent.start() 注入历史对话到 system prompt

**目标**：`start()` 时读 DB 最近 N 条 Turn，拼成静默提示块（XML 结构），追加到 `config.systemPrompt` 末尾。

> **"10 条" 定义（team-lead 确认）**：10 个**完整 Turn**（一问一答算一轮），**不是** 10 条用户消息。
> 每个 Turn = 用户输入 + agent 的全部 blocks（thinking/text/tool_call/tool_result/...）都已由 T1/T2 完整落库。
> 但注入 system prompt 时**必须精简**：
> - `userInput.text` → `<user>` 节点
> - 所有 `type==='text'` 的 `block.content` 顺序拼接 → `<assistant>` 节点
> - 所有 `type==='tool_call'` 的 block 抽 `[工具 <title>: <input.display> → <output.display>]` 一行摘要 → **追加**到 `<assistant>` 末尾（保留"我用过工具"语义线索，但不泄漏具体 payload）
> - **禁止**把 thinking / tool_result 原始 content 塞进 prompt——前者是 CoT 中间态、后者结构化数据会爆 token

**注入格式（XML，team-lead 裁决）**：

```
<past_conversation>
请注意：以下是你和用户的历史对话，仅供你了解背景，不要主动回复这些内容，也不要在当前回复里引用它们。
<turn>
<user>帮我查进度</user>
<assistant>当前 3 个 Agent 在线，正在执行 XXX。
[工具 list_roster: 查看在线成员 → 3 个成员在线]</assistant>
</turn>
<turn>
<user>把登录页改了</user>
<assistant>好的，已安排小王修改登录页样式。
[工具 send_message: to=xiaowang 改登录页 → 已送达]</assistant>
</turn>
</past_conversation>
```

关键格式约束：
- **指令放块首**（进入 `<past_conversation>` 后第一行），不是块尾——模型读到标签时已经知道"这是历史，不要回复"。
- 每个 `<turn>` 独立完整，顺序从旧到新。
- 转义：user/assistant/tool 摘要里的 `<` / `>` / `&` 做最小 XML 转义，防止对话内容被误读成下一级标签。

**代码位置 / 产出**：
- 新建 `packages/backend/src/primary-agent/history-injector.ts`（预估 100 行）
  - **顶部常量块**（可调参 + 下游测试可 import 做断言）：
    ```ts
    export const DEFAULT_HISTORY_LIMIT = 10;           // 注入 Turn 条数
    export const MAX_USER_CHARS = 500;                 // 单条 user 文本截断
    export const MAX_ASSISTANT_CHARS = 2000;           // 单条 assistant 文本截断
    export const MAX_TOOL_DISPLAY_CHARS = 120;         // 单条 tool_call 摘要截断
    export const MAX_HISTORY_BYTES = 30 * 1024;        // 总拼接块 UTF-8 字节上限
    // TODO(phase-2): 按 DriverConfig.agentType 差异化这些阈值
    //   —— codex 更省 token 可放宽；claude 窗口大可更宽松。
    //   phase-1 全口径共用，避免提前抽象。
    ```
  - `export function buildHistoryPromptBlock(driverId: string, limit = DEFAULT_HISTORY_LIMIT): string`
    - 读 DB：`listRecentByDriver(driverId, { limit })`，返回 DESC → 本函数内 reverse 为 ASC。
    - 空结果 → 返回空串（不加任何包裹标签）。
    - 非空：外层 `<past_conversation>\n<指令行>\n{turns}\n</past_conversation>\n`。
    - 每个 Turn 由 `renderTurn(turn)` 子函数生成：
      * `userText = truncate(escapeXml(turn.userInput.text), MAX_USER_CHARS)`
      * `assistantText = truncate(escapeXml(turn.blocks.filter(b=>b.type==='text').map(b=>b.content).join('')), MAX_ASSISTANT_CHARS)`
      * `toolLines = turn.blocks.filter(b=>b.type==='tool_call').map(b => truncate(`[工具 ${b.title}: ${b.input?.display ?? ''} → ${b.output?.display ?? '(无输出)'}]`, MAX_TOOL_DISPLAY_CHARS))`；再 escapeXml
      * 输出 `<turn>\n<user>${userText}</user>\n<assistant>${assistantText}${toolLines.length ? '\n'+toolLines.join('\n') : ''}</assistant>\n</turn>\n`
    - **总字节上限**：拼完后若 `Buffer.byteLength(result, 'utf8') > MAX_HISTORY_BYTES`，**按最早 Turn 优先丢弃**重拼（不是截尾；截尾会砍掉"最近话题"）；单轮就超就只保留最新一轮、再砍半 user/assistant 文本。
  - 辅助函数：
    * `escapeXml(s: string): string`（只转义 `<` / `>` / `&`——文本节点不需要处理引号）
    * `truncate(s: string, max: number): string`（超 max 加 `…`）
- 修改 `packages/backend/src/primary-agent/driver-config.ts`：
  - `buildDriverConfig` 新增可选入参 `historyPromptBlock?: string`；有值且非空则 `systemPrompt: (row.systemPrompt ?? '') + historyPromptBlock`。保持可选参数不破坏老测试；本层不读 DB。
- 修改 `packages/backend/src/primary-agent/primary-agent.ts#start()`：
  - `buildDriverConfig` 调用前插 `const historyPromptBlock = buildHistoryPromptBlock(row.id);`，随入参传入。**必须 try/catch**：注入失败返回空串、不能把主 Agent start 拖挂。
- 新建 `packages/backend/src/primary-agent/history-injector.test.ts`（预估 180 行）：
  - 空 DB → 返回空串（不带 `<past_conversation>`）
  - 单 Turn (纯 text) → 输出含 `<past_conversation>` / 指令行 / `<turn><user>` / `<assistant>`; **不含** thinking/tool_call 字样
  - Turn 含 tool_call block → `<assistant>` 末尾出现 `[工具 <title>: <display> → <display>]`
  - Turn 含 thinking block → 输出**不含** `thinking.content` 原文（断言原文不在输出里）
  - tool_call 无 `output` → 摘要显示 `→ (无输出)`
  - XML 转义：userInput.text 含 `<script>&amp;` → 输出 `&lt;script&gt;&amp;amp;`
  - 超长截断：user=1000 字符 → 输出 user ≤ `MAX_USER_CHARS+1`；assistant=3000 字符 → ≤ `MAX_ASSISTANT_CHARS+1`
  - 超总字节：构造 20 条每条 2KB（总 40KB > 30KB）→ `Buffer.byteLength(result,'utf8') ≤ MAX_HISTORY_BYTES`，**保留最新的**（断言最后一条 user 在、最早一条不在）
  - 单轮就超限：user 50KB + assistant 50KB → 不爆栈、输出 ≤ 上限、至少保留部分内容
  - 时间序：DB DESC → 输出 `<turn>` 内 ASC（最早在前、最新在后）
  - 读 DB 抛异常 → 返回空串（不上抛）

**完成判据**：
1. `bun test packages/backend/src/primary-agent/history-injector.test.ts` 全绿（≥ 10 case）。
2. `bun test packages/backend/src/primary-agent/` 整个目录绿（self-heal / launch-spec 老测试不被 driver-config 签名改动破坏——若破坏必须更新调用点）。
3. 手测：干净 DB + 模拟 3 条 completed turn 入库（含 tool_call），重启 primary agent，临时 log 打印 `config.systemPrompt` 末尾，贴 log 截图：
   - 含 `<past_conversation>` / 指令行 / `<turn>` / `[工具 …]`
   - **不含** thinking.content 原文
4. `grep -rn history-injector packages/backend/src/bus/subscribers/member-driver/` 为空——成员 agent 路径未被 import。
5. 文件 ≤ 200 行；`primary-agent.ts` +5 行（含 try/catch），`driver-config.ts` +5 行。`history-injector.ts` 若 > 140 行就拆 `render.ts` 子模块。

**非目标**：
- 不做 token 精确计算；字符长度 + 总字节兜底即可（TODO 预留 agentType 差异化）。
- 不做 vendor 差异化模板（共用同一段 XML，指令行中文——与用户原话一致）。
- 不做注入审计 bus 事件（§F2 未来工作）。

---

### T5 · HTTP 翻页查询端点

**目标**：前端翻页查历史 Turn：`GET /api/panel/driver/:driverId/turn-history?beforeEndTs=<endTs>&beforeTurnId=<turnId>&limit=10`。

**代码位置 / 产出**：
- 新建 `packages/backend/src/http/routes/driver-turn-history.routes.ts`（预估 70 行）
  - 路径匹配：前缀 `/api/panel/driver/`、后缀 `/turn-history`，中间段即 `driverId`（规则照抄 `driver-turns.routes.ts` §T-10）。
  - method 只接受 GET，其他 404。
  - query：
    - `limit`（默认 10，上限 50）
    - `beforeEndTs`（可选 ISO 字符串）
    - `beforeTurnId`（可选 string）
    - `beforeEndTs` 和 `beforeTurnId` **必须成对**出现；缺一方当首页处理（不报错）。
  - 调 `listRecentByDriver(driverId, { limit: limit + 1, before: beforeEndTs && beforeTurnId ? { endTs: beforeEndTs, turnId: beforeTurnId } : undefined })` 多查 1 条判 hasMore，再裁回 limit。
  - 返回：
    ```ts
    {
      items: Turn[],
      hasMore: boolean,
      nextCursor: { endTs: string; turnId: string } | null  // items 长度 < limit 时为 null
    }
    ```
  - `nextCursor` 取 `{ endTs: last.endTs!, turnId: last.turnId }`（last.endTs 在 done/error 终态下一定有值；理论不可能为 undefined，但加 `!` + 断言防御）。
- 修改 `packages/backend/src/http/router.ts`：在 `handleDriverTurnsRoute` 之后串联 `handleDriverTurnHistoryRoute`（参考 T-10 注册位置）。
- 修改 `packages/backend/src/http/routes/panel.routes.ts#25`：`if (pathname.startsWith(PREFIX + '/driver/')) return null;` 保持不变（现有逻辑已把 /driver/* 让给独立路由文件）。
- 新建 `packages/backend/src/http/routes/driver-turn-history.routes.test.ts`（预估 140 行）：
  - 无数据 → `{ items: [], hasMore: false, nextCursor: null }`
  - 3 条数据 + limit=2 → 拿最新 2 条 + hasMore=true + `nextCursor={endTs, turnId}` 指向第 2 条
  - 传第 2 条 `beforeEndTs`/`beforeTurnId` → 拿第 3 条 + hasMore=false + nextCursor=null
  - **同毫秒**：3 条 end_ts 相同、turn_id 不同 → 三次 limit=1 翻页能完整取到所有 3 条、无重无漏
  - limit 非法（负数 / 非数字）→ 回落默认 10
  - 只传 beforeEndTs 不传 beforeTurnId（或反之）→ 忽略游标、当首页处理（不 400）
  - method POST/PUT → 404
  - driverId 含 `/` → 不消费（返回 null）

**完成判据**：
1. `bun test packages/backend/src/http/routes/driver-turn-history.routes.test.ts` 全绿（含同毫秒场景）。
2. panel.routes 回归测试绿。
3. 与 T-10 `/turns`（active + in-memory recent）**不冲突**：路径后缀 `/turns` vs `/turn-history`，前端按需：快照态用 `/turns`，翻旧账用 `/turn-history`。
4. curl 真实环境（交付时贴输出作证据）：
   - `curl 'http://localhost:58590/api/panel/driver/<primaryId>/turn-history?limit=5'` 返 200 + items + nextCursor 对象。
   - `curl 'http://localhost:58590/api/panel/driver/<primaryId>/turn-history?limit=5&beforeEndTs=<x>&beforeTurnId=<y>'` 返下一页。

**非目标**：
- 本端点**不**负责 in-memory active（那是 `/turns` 的事），只查 DB 冷数据。
- 不做 driverId 鉴权——与 panel 其他端点一致。

---

## 全局完成判据（交付 gate）

> 交付者必须逐条贴证据，漏一条打回。

- [ ] **T1**：贴 `sqlite3 v2.db '.schema turn_history'` 输出
- [ ] **T2**：贴 `bun test packages/backend/src/turn-history/` 全绿截图，贴 `wc -l` 文件行数
- [ ] **T3**：贴 `bun test` 中新订阅器全绿 + `bus/index.test.ts` 全绿
- [ ] **T4**：贴手测场景里 `config.systemPrompt` 末尾的 prompt 拼接截图（或 log 贴文本），以及 `history-injector.test.ts` 全绿
- [ ] **T5**：贴两次 curl 翻页 JSON 输出
- [ ] **回归**：`bun test packages/backend && bun run typecheck` 全绿
- [ ] **红线**：`find packages/backend/src -name '*.ts' -newer <phase 起点> -exec wc -l {} \\;` 新增 / 修改文件无 > 200 行

---

## 依赖图

```
T1 (schema) ──┐
              ├──→ T2 (repo) ──┬──→ T3 (subscriber)
              │                └──→ T4 (injector) ──→ primary-agent.start()
              └──────────────────→ T5 (HTTP)
```

- Wave 1：T1 / T2 / T3 可并行；T3 消费 T2，T2 消费 T1 表结构，但可用接口约定先起（T2 先出接口给 T3 mock）。
- Wave 2：T4 与 T5 并行；均只消费 T2 的 DAO。
- 共 5 任务，3 人可做到：A 做 T1+T2（DB 侧），B 做 T3（订阅器），C 做 T4+T5（业务胶水 + HTTP）。

## 不做清单（明确排除）

- ❌ 不搞 sessionId 复用；每次 start 新 session（用户原话 6）
- ❌ 不改 aggregator in-memory 行为；DB 是独立副本
- ❌ 不对 member-driver 做历史注入（用户原话 4）
- ❌ 不注入 thinking / tool_result 原始 content（tool_call 保留 display 摘要行）
- ❌ 不做 TTL / 压缩 / 归档——用户没要求，先跑起来
- ❌ 不做前端改动；只留 HTTP 契约给前端自行消费

---

## 未来工作（本期**不做**，仅作为 TODO 标记源头供后续引用）

> 这些项 team-lead 确认本期不动，但为防止"改完就忘"，在此登记，方便下一期接手人直接立项。

### F1 · turn-history 写库失败 → bus 告警事件

- 位置：`bus/subscribers/turn-history.subscriber.ts` 的 catch 分支
- 现状：只 `process.stderr.write` 打日志，运维层无感
- 未来：emit `{ type: 'turn_history.write_failed', driverId, turnId, error, ts }`，在 notification / log 订阅器里做告警
- 触发条件：DB 磁盘满 / SQLite busy / schema 漂移都会触发
- 代码锚点：T3 subscriber 的 catch 块内保留 `// TODO(F1): emit turn_history.write_failed` 注释

### F2 · 历史注入审计 bus 事件

- 位置：`primary-agent/primary-agent.ts#start()` 调用 `buildHistoryPromptBlock` 之后
- 现状：静默注入，不知道哪次 start 拼了多少条 / 多长
- 未来：emit `{ type: 'primary_agent.history_injected', agentId, turnCount, bytes, ts }`，前端调试面板可显示 "本次启动注入 X 条历史"
- 触发条件：每次 primary agent start 成功
- 代码锚点：start() 方法内 `// TODO(F2): emit primary_agent.history_injected`

### F3 · MAX_HISTORY_BYTES 按 agentType 差异化

- 位置：`primary-agent/history-injector.ts` 顶部常量
- 现状：phase-1 全口径共用（500 / 2000 / 120 / 30KB）
- 未来：接 `DriverConfig.agentType`，codex 放宽、claude 放宽、qwen 保守
- 代码锚点：常量定义上方的 `// TODO(F3): 按 DriverConfig.agentType 差异化这些阈值`

### F4 · TTL / 压缩 / 归档

- 位置：`turn-history/repo.ts` + 新建清理任务
- 现状：DB 无限增长
- 未来：按 `end_ts < now - 30d` 或 `count > 10000` 按 driver 归档；可能需要单独 `turn_history_archive` 表
- 触发条件：用户侧汇报 "DB 文件过大" 或开发侧观察到查询变慢
