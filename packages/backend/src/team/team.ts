// Team —— 团队关系表的 DAO（teams + team_members 两张表）。
// 纯数据访问，不做业务判断、不调用其他 domain。
//
// 约定：
//   - addMember / removeMember 同时维护 role_instances.team_id 冗余列，
//     该列的唯一写入者是 team 模块（见 docs/teams/team-manager-design.md §2.3）。
//   - 每个方法都直接读写 DB，不缓存。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import type {
  TeamRow,
  TeamMemberRow,
  CreateTeamInput,
  TeamStatus,
} from './types.js';

// teams 表一行的裸结构。
interface TeamDbRow {
  id: string;
  name: string;
  leader_instance_id: string;
  description: string;
  status: TeamStatus;
  created_at: string;
  disbanded_at: string | null;
}

// team_members 表一行的裸结构。
interface TeamMemberDbRow {
  id: number;
  team_id: string;
  instance_id: string;
  role_in_team: string | null;
  joined_at: string;
}

const TEAM_COLS = `id, name, leader_instance_id, description, status, created_at, disbanded_at`;
const TM_COLS = `id, team_id, instance_id, role_in_team, joined_at`;

function rowToTeam(r: TeamDbRow): TeamRow {
  return {
    id: r.id,
    name: r.name,
    leaderInstanceId: r.leader_instance_id,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    disbandedAt: r.disbanded_at,
  };
}

function rowToMember(r: TeamMemberDbRow): TeamMemberRow {
  return {
    id: r.id,
    teamId: r.team_id,
    instanceId: r.instance_id,
    roleInTeam: r.role_in_team,
    joinedAt: r.joined_at,
  };
}

export class Team {
  // create：插入一行 teams，返回新记录。不自动把 leader 加入 team_members。
  // 三层防御之应用层：创建前先查有无 ACTIVE team；有就抛错。
  // DB 层 uq_teams_active_leader 兜底；API 层 catch 转 409。
  create(input: CreateTeamInput): TeamRow {
    const existing = this.findActiveByLeader(input.leaderInstanceId);
    if (existing) {
      throw new Error(
        `leader '${input.leaderInstanceId}' already has active team '${existing.id}'`,
      );
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO teams (id, name, leader_instance_id, description, status, created_at, disbanded_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)`,
      )
      .run(id, input.name, input.leaderInstanceId, input.description ?? '', now);
    const created = this.findById(id);
    if (!created) throw new Error(`team '${id}' not found after insert`);
    return created;
  }

  // findActiveByLeader：按 leader instance id 查 ACTIVE team。配合 create 做唯一校验。
  findActiveByLeader(leaderInstanceId: string): TeamRow | null {
    const row = getDb()
      .prepare(
        `SELECT ${TEAM_COLS} FROM teams WHERE leader_instance_id=? AND status='ACTIVE'`,
      )
      .get(leaderInstanceId) as TeamDbRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // findById：按 id 查 team；不过滤 status（disbanded 也返回）。
  findById(teamId: string): TeamRow | null {
    const row = getDb()
      .prepare(`SELECT ${TEAM_COLS} FROM teams WHERE id=?`)
      .get(teamId) as TeamDbRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // listAll：列出所有 team（含 disbanded）按创建时间倒序。
  listAll(): TeamRow[] {
    const rows = getDb()
      .prepare(`SELECT ${TEAM_COLS} FROM teams ORDER BY created_at DESC`)
      .all() as TeamDbRow[];
    return rows.map(rowToTeam);
  }

  // disband：软删；status='DISBANDED' + disbanded_at=now。幂等。
  disband(teamId: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE teams SET status='DISBANDED', disbanded_at=? WHERE id=? AND status='ACTIVE'`,
      )
      .run(now, teamId);
  }

  // addMember：插入 team_members + 同步 role_instances.team_id。
  // 幂等：同 (teamId, instanceId) 已存在则静默返回。
  addMember(teamId: string, instanceId: string, roleInTeam: string | null = null): void {
    const db = getDb();
    db.transaction(() => {
      const existed = db
        .prepare(`SELECT id FROM team_members WHERE team_id=? AND instance_id=?`)
        .get(teamId, instanceId) as { id: number } | undefined;
      if (existed) {
        db.prepare(`UPDATE role_instances SET team_id=? WHERE id=?`).run(teamId, instanceId);
        return;
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO team_members (team_id, instance_id, role_in_team, joined_at)
         VALUES (?, ?, ?, ?)`,
      ).run(teamId, instanceId, roleInTeam, now);
      db.prepare(`UPDATE role_instances SET team_id=? WHERE id=?`).run(teamId, instanceId);
    })();
  }

  // removeMember：删 team_members 行 + 清 role_instances.team_id。不存在则 no-op。
  // team_id 同时匹配避免把 instance 已经 re-assigned 后的 team_id 清掉。
  removeMember(teamId: string, instanceId: string): boolean {
    const db = getDb();
    let changed = false;
    db.transaction(() => {
      const res = db
        .prepare(`DELETE FROM team_members WHERE team_id=? AND instance_id=?`)
        .run(teamId, instanceId);
      changed = (res.changes as number) > 0;
      if (changed) {
        db.prepare(`UPDATE role_instances SET team_id=NULL WHERE id=? AND team_id=?`)
          .run(instanceId, teamId);
      }
    })();
    return changed;
  }

  // listMembers：返回 team 的成员行，按 joined_at 升序。
  listMembers(teamId: string): TeamMemberRow[] {
    const rows = getDb()
      .prepare(`SELECT ${TM_COLS} FROM team_members WHERE team_id=? ORDER BY joined_at ASC`)
      .all(teamId) as TeamMemberDbRow[];
    return rows.map(rowToMember);
  }

  // findByInstance：查 instance 当前所属 ACTIVE team（最多一个，受 uq_tm_member 约束）。
  // 只返 ACTIVE team 是防 subscriber 循环的关键：disbanded/CASCADE 的 team 查不到，
  // 级联事件进入 handler 直接 return。
  findByInstance(instanceId: string): TeamRow | null {
    const row = getDb()
      .prepare(
        `SELECT t.id AS id, t.name AS name, t.leader_instance_id AS leader_instance_id,
                t.description AS description, t.status AS status,
                t.created_at AS created_at, t.disbanded_at AS disbanded_at
         FROM teams t
         INNER JOIN team_members tm ON tm.team_id=t.id
         WHERE tm.instance_id=? AND t.status='ACTIVE'`,
      )
      .get(instanceId) as TeamDbRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // countMembers：返回 team 当前成员数。
  countMembers(teamId: string): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM team_members WHERE team_id=?`)
      .get(teamId) as { c: number };
    return row.c;
  }
}

// 全局单例，供 api handler 和 subscriber 使用。
export const team = new Team();
