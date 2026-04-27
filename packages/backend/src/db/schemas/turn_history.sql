-- ============================================================
-- turn_history —— 所有 driver 的完整 Turn 快照（phase-turn-persist）
-- ============================================================
-- 纯净持久化表：不感知 primary-agent，任何 driver 的 turn.completed 都可落库。
-- 查询时按 driver_id 过滤即可只看单个 driver 的历史。
-- 字段与 Turn 接口（agent-driver/turn-types.ts）一一对应：
--   user_input / blocks / usage 以 JSON 存原样，rowToTurn 反序列化。
-- Why 不建 FK 到 primary_agent(id)：
--   本表给所有 driver 复用，不应绑死单表；业务层按 driver_id 解释即可。
CREATE TABLE IF NOT EXISTS turn_history (
  turn_id       TEXT PRIMARY KEY,
  driver_id     TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK(status IN ('done','error')),
  user_input    TEXT NOT NULL,
  blocks        TEXT NOT NULL,
  stop_reason   TEXT,
  usage         TEXT,
  start_ts      TEXT NOT NULL,
  end_ts        TEXT NOT NULL
);

-- 主查询：按 driver_id 倒序翻页。
-- 复合键含 turn_id 是给 keyset 游标分页做 tie-breaker（同毫秒多条不漂移/重复/漏读）。
CREATE INDEX IF NOT EXISTS idx_turn_hist_driver_end
  ON turn_history(driver_id, end_ts DESC, turn_id DESC);
