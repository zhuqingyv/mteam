// Roster —— 活跃成员表的 DAO（Data Access Object），不是缓存。
// 全部操作直接读写 DB，不维护内存 Map，确保永远与 role_instances 表一致。
//
// 约定：
//   - scope='local' 的成员对应 role_instances 表；scope='remote' 对应 remote_peers（未实现，返回空）。
//   - add 是幂等 upsert：存在就更新 alias，不存在就插入（domain 层通常已经插好行，这里只覆盖 alias）。
//   - 所有读操作每次都查 DB，不缓存。
import { getDb } from '../db/connection.js';
import type { RosterEntry, SearchResult, SearchScope } from './types.js';

// role_instances 表一行的裸结构。
interface RoleInstanceRow {
  id: string;
  member_name: string;
  alias: string | null;
  status: string;
  team_id: string | null;
  task: string | null;
}

// 把 DB 行映射为 RosterEntry。scope 固定 local，address 统一 local:<id>。
function rowToEntry(r: RoleInstanceRow): RosterEntry {
  return {
    instanceId: r.id,
    memberName: r.member_name,
    alias: r.alias ?? r.member_name,
    scope: 'local',
    status: r.status,
    address: `local:${r.id}`,
    teamId: r.team_id,
    task: r.task,
  };
}

// 统一的 SELECT 字段，避免各处重复拼列名。
const SELECT_COLS = `id, member_name, alias, status, team_id, task`;

// 读取某 instanceId 对应的 local 成员（role_instances 行）。
function selectLocalById(id: string): RosterEntry | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM role_instances WHERE id = ?`)
    .get(id) as RoleInstanceRow | undefined;
  return row ? rowToEntry(row) : null;
}

// 读取全部 local 成员。
function selectAllLocal(): RosterEntry[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM role_instances`)
    .all() as RoleInstanceRow[];
  return rows.map(rowToEntry);
}

export class Roster {
  // add：把 entry 同步进 DB。
  //   - local scope：role_instances 行一般已由 domain 层插好，这里只 UPDATE alias。
  //                  若行不存在且 alias 需要落地，则报错（调用方应先创建 role_instance）。
  //   - remote scope：remote_peers 表暂未实现，直接忽略。
  add(entry: RosterEntry): void {
    const alias = entry.alias || entry.memberName;
    if (entry.scope === 'local') {
      // upsert 语义：存在就把 alias 写进去，不存在就抛错提示调用方先 create role_instance。
      const existed = selectLocalById(entry.instanceId);
      if (!existed) {
        throw new Error(
          `instance '${entry.instanceId}' not in role_instances; create it first`,
        );
      }
      getDb()
        .prepare(`UPDATE role_instances SET alias = ? WHERE id = ?`)
        .run(alias, entry.instanceId);
      return;
    }
    // remote: 当前不支持，静默忽略，等 remote_peers 表落地再补。
  }

  // remove：local scope 直接删 role_instances 行。
  // 注意：domain 层 RoleInstance.delete() 已会 DELETE，这里属补偿路径。
  remove(instanceId: string): void {
    const existed = selectLocalById(instanceId);
    if (!existed) {
      throw new Error(`instance '${instanceId}' not in roster`);
    }
    getDb().prepare(`DELETE FROM role_instances WHERE id = ?`).run(instanceId);
  }

  // get：按 instanceId 查单条，没有返回 null。
  get(instanceId: string): RosterEntry | null {
    return selectLocalById(instanceId);
  }

  // setAlias：改 alias 字段，local 直接落库，remote 暂不支持。
  setAlias(instanceId: string, alias: string): void {
    const existed = selectLocalById(instanceId);
    if (!existed) throw new Error(`instance '${instanceId}' not in roster`);
    getDb()
      .prepare(`UPDATE role_instances SET alias = ? WHERE id = ?`)
      .run(alias, instanceId);
  }

  // update：支持 status / address / teamId / task 四个字段。
  //   - address 当前仅按约定 local:<id>，没有独立列，写入被忽略但不报错。
  //   - 其余三项直接映射到 role_instances 列。
  update(instanceId: string, fields: Partial<RosterEntry>): void {
    const existed = selectLocalById(instanceId);
    if (!existed) throw new Error(`instance '${instanceId}' not in roster`);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.status !== undefined) {
      sets.push('status = ?');
      args.push(fields.status);
    }
    if (fields.teamId !== undefined) {
      sets.push('team_id = ?');
      args.push(fields.teamId);
    }
    if (fields.task !== undefined) {
      sets.push('task = ?');
      args.push(fields.task);
    }
    // address 暂无独立列，按语义忽略；若将来有 remote_peers 再扩展。
    if (sets.length === 0) return;
    args.push(instanceId);
    getDb()
      .prepare(`UPDATE role_instances SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args);
  }

  // 取 caller 所在 teamId，用于 scope=team 过滤。
  private callerTeamId(callerInstanceId: string): string | null {
    const entry = selectLocalById(callerInstanceId);
    if (!entry) throw new Error(`caller '${callerInstanceId}' not in roster`);
    return entry.teamId;
  }

  // 根据 scope 过滤候选集合。
  private filterByScope(
    entries: RosterEntry[],
    callerInstanceId: string | undefined,
    scope: string | undefined,
  ): RosterEntry[] {
    if (!scope) return entries;
    if (scope === 'team') {
      if (!callerInstanceId) throw new Error('callerInstanceId required for scope=team');
      const tid = this.callerTeamId(callerInstanceId);
      if (!tid) return [];
      return entries.filter((e) => e.teamId === tid);
    }
    if (scope === 'local') return entries.filter((e) => e.scope === 'local');
    if (scope === 'remote') return []; // remote_peers 未实现
    throw new Error(`unknown scope '${scope}'`);
  }

  // search：alias 模糊匹配（大小写不敏感），按 scope 过滤。
  search(callerInstanceId: string, query: string, scope?: SearchScope): SearchResult {
    if (!query) return { match: 'none', query };
    const q = query.toLowerCase();
    const all = selectAllLocal();
    const scoped = this.filterByScope(all, callerInstanceId, scope);
    const hits = scoped.filter((e) => e.alias.toLowerCase().includes(q));
    if (hits.length === 0) return { match: 'none', query };
    if (hits.length === 1) return { match: 'unique', target: hits[0]! };
    return { match: 'multiple', candidates: hits };
  }

  // resolve：search 的唯一返回封装，多/零均报错。
  resolve(callerInstanceId: string, query: string): RosterEntry {
    const result = this.search(callerInstanceId, query);
    if (result.match === 'unique') return result.target;
    if (result.match === 'none') throw new Error(`no member matches '${query}'`);
    const names = result.candidates.map((c) => c.alias).join(', ');
    throw new Error(`multiple matches for '${query}': ${names}`);
  }

  // list：按 scope 过滤返回全部成员。
  list(callerInstanceId?: string, scope?: string): RosterEntry[] {
    const all = selectAllLocal();
    return this.filterByScope(all, callerInstanceId, scope);
  }

  // reset：兼容旧测试签名，纯 DB 实现下无需重置状态，但保留空实现防破坏调用方。
  reset(): void {
    // 无状态；DB 由测试自行 closeDb/getDb 重建。
  }
}

// 全局单例，供 api handler 和 sync 辅助使用。
export const roster = new Roster();
