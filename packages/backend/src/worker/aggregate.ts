// Workers 聚合：角色模板面向用户的包装（一个模板 = 一个数字员工）。
// 只读，不加表不改表；join role_templates / role_instances / teams / turn_history。
import { getDb } from '../db/connection.js';
import { driverRegistry } from '../agent-driver/registry.js';
import type {
  WorkerListResult,
  WorkerStats,
  WorkerStatus,
  WorkerView,
} from './types.js';

interface TemplateRow {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  avatar: string | null;
  available_mcps: string;
}
interface InstanceRow { id: string; template_name: string; status: string }
interface TeamJoinRow { template_name: string; team_name: string }
interface TurnRow { template_name: string; user_input: string; end_ts: string }

function parseMcps(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .map((e) =>
        typeof e === 'string'
          ? e
          : e && typeof e === 'object' && 'name' in e
            ? String((e as { name: unknown }).name)
            : '',
      )
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function summarizeUserInput(raw: string): string {
  try {
    const o = JSON.parse(raw) as { text?: unknown };
    return typeof o.text === 'string' ? o.text.slice(0, 30) : '';
  } catch {
    return '';
  }
}

export function getWorkerList(): WorkerListResult {
  const db = getDb();

  const templates = db
    .prepare(
      `SELECT name, role, description, persona, avatar, available_mcps
         FROM role_templates ORDER BY created_at ASC`,
    )
    .all() as TemplateRow[];

  const instances = db
    .prepare(`SELECT id, template_name, status FROM role_instances`)
    .all() as InstanceRow[];

  const teamRows = db
    .prepare(
      `SELECT ri.template_name AS template_name, t.name AS team_name
         FROM role_instances ri
         JOIN team_members tm ON tm.instance_id = ri.id
         JOIN teams t ON t.id = tm.team_id`,
    )
    .all() as TeamJoinRow[];

  // 每个 template 取 end_ts 最大那条 turn。
  const turnRows = db
    .prepare(
      `SELECT ri.template_name AS template_name,
              th.user_input     AS user_input,
              th.end_ts         AS end_ts
         FROM turn_history th
         JOIN role_instances ri ON ri.id = th.driver_id
         WHERE th.end_ts = (
           SELECT MAX(th2.end_ts) FROM turn_history th2
             JOIN role_instances ri2 ON ri2.id = th2.driver_id
            WHERE ri2.template_name = ri.template_name
         )`,
    )
    .all() as TurnRow[];

  const instByTpl = new Map<string, InstanceRow[]>();
  for (const r of instances) {
    const arr = instByTpl.get(r.template_name) ?? [];
    arr.push(r);
    instByTpl.set(r.template_name, arr);
  }
  const teamsByTpl = new Map<string, Set<string>>();
  for (const r of teamRows) {
    const s = teamsByTpl.get(r.template_name) ?? new Set<string>();
    s.add(r.team_name);
    teamsByTpl.set(r.template_name, s);
  }
  const lastTurnByTpl = new Map<string, TurnRow>();
  for (const r of turnRows) {
    const p = lastTurnByTpl.get(r.template_name);
    if (!p || r.end_ts > p.end_ts) lastTurnByTpl.set(r.template_name, r);
  }

  const stats: WorkerStats = { total: templates.length, online: 0, idle: 0, offline: 0 };
  const workers: WorkerView[] = templates.map((tpl) => {
    const insts = instByTpl.get(tpl.name) ?? [];
    const status: WorkerStatus =
      insts.length === 0
        ? 'offline'
        : insts.some((i) => i.status === 'ACTIVE' && !!driverRegistry.get(i.id))
          ? 'online'
          : 'idle';
    stats[status]++;
    const turn = lastTurnByTpl.get(tpl.name);
    return {
      name: tpl.name,
      role: tpl.role,
      description: tpl.description,
      persona: tpl.persona,
      avatar: tpl.avatar,
      mcps: parseMcps(tpl.available_mcps),
      status,
      instanceCount: insts.length,
      teams: Array.from(teamsByTpl.get(tpl.name) ?? []),
      lastActivity: turn
        ? { summary: summarizeUserInput(turn.user_input), at: turn.end_ts }
        : null,
    };
  });

  return { workers, stats };
}
