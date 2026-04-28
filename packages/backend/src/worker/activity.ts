// Worker 活跃度：按时间窗口对 turn_history 分桶。
// turns = COUNT(*)，toolCalls = blocks 中 type='tool_call' 的总数。
import { getDb } from '../db/connection.js';

export type ActivityRange = 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface ActivityPoint {
  label: string;
  turns: number;
  toolCalls: number;
}

export interface ActivityResult {
  range: ActivityRange;
  workerName: string | null;
  dataPoints: ActivityPoint[];
  total: { turns: number; toolCalls: number };
}

interface RangeSpec {
  count: number;
  stepMs: number;
  label: (d: Date) => string;
}

const RANGE_SPECS: Record<ActivityRange, RangeSpec> = {
  minute: { count: 60, stepMs: 60_000, label: (d) => d.toISOString().slice(0, 16) },
  hour:   { count: 24, stepMs: 3_600_000, label: (d) => d.toISOString().slice(0, 13) },
  day:    { count: 30, stepMs: 86_400_000, label: (d) => d.toISOString().slice(0, 10) },
  month:  { count: 12, stepMs: 30 * 86_400_000, label: (d) => d.toISOString().slice(0, 7) },
  year:   { count: 5,  stepMs: 365 * 86_400_000, label: (d) => d.toISOString().slice(0, 4) },
};

function countToolCalls(blocksJson: string): number {
  try {
    const arr = JSON.parse(blocksJson) as unknown;
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const b of arr) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_call') n++;
    }
    return n;
  } catch {
    return 0;
  }
}

interface Row {
  end_ts: string;
  blocks: string;
}

export function getWorkerActivity(
  range: ActivityRange,
  workerName: string | null,
): ActivityResult {
  const db = getDb();
  const spec = RANGE_SPECS[range];
  const now = Date.now();
  const windowStart = new Date(now - spec.count * spec.stepMs).toISOString();

  const rows = (
    workerName
      ? db
          .prepare(
            `SELECT th.end_ts AS end_ts, th.blocks AS blocks
               FROM turn_history th
               JOIN role_instances ri ON ri.id = th.driver_id
              WHERE ri.template_name = ? AND th.end_ts >= ?`,
          )
          .all(workerName, windowStart)
      : db
          .prepare(`SELECT end_ts, blocks FROM turn_history WHERE end_ts >= ?`)
          .all(windowStart)
  ) as Row[];

  const buckets: ActivityPoint[] = [];
  for (let i = 0; i < spec.count; i++) {
    const d = new Date(now - i * spec.stepMs);
    buckets.push({ label: spec.label(d), turns: 0, toolCalls: 0 });
  }

  let totalTurns = 0;
  let totalTools = 0;
  for (const r of rows) {
    const t = Date.parse(r.end_ts);
    if (Number.isNaN(t)) continue;
    const idx = Math.floor((now - t) / spec.stepMs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx]!.turns++;
    const tc = countToolCalls(r.blocks);
    buckets[idx]!.toolCalls += tc;
    totalTurns++;
    totalTools += tc;
  }

  return {
    range,
    workerName,
    dataPoints: buckets,
    total: { turns: totalTurns, toolCalls: totalTools },
  };
}

export function parseRange(v: string | null): ActivityRange | null {
  if (v === 'minute' || v === 'hour' || v === 'day' || v === 'month' || v === 'year') return v;
  return null;
}
