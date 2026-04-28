import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { readMaxAgents } from '../system/quota-config.js';
import { RoleStatus, resolveTransition } from './state-machine.js';
import { stmt } from './role-instance-statements.js';
import { QuotaExceededError } from './errors.js';

export { QuotaExceededError };

export interface RoleInstanceProps {
  id: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  projectId: string | null;
  status: RoleStatus;
  sessionId: string | null;
  sessionPid: number | null;
  claudeSessionId: string | null;
  leaderName: string | null;
  task: string | null;
  /** true = DockerRuntime（沙箱）；false = HostRuntime。成员默认 false。 */
  sandbox: boolean;
  /** true = 自动同意 ACP 权限请求；false = 一律 cancelled。成员默认 false。 */
  autoApprove: boolean;
  createdAt: string;
}

export interface CreateRoleInstanceInput {
  templateName: string;
  memberName: string;
  isLeader?: boolean;
  teamId?: string | null;
  projectId?: string | null;
  leaderName?: string | null;
  task?: string | null;
  id?: string;
}

interface Row {
  id: string; template_name: string; member_name: string; is_leader: number;
  team_id: string | null; project_id: string | null; status: string;
  session_id: string | null; session_pid: number | null; claude_session_id: string | null;
  leader_name: string | null; task: string | null;
  sandbox: number; auto_approve: number;
  created_at: string;
}

function rowToProps(r: Row): RoleInstanceProps {
  return {
    id: r.id, templateName: r.template_name, memberName: r.member_name,
    isLeader: r.is_leader === 1, teamId: r.team_id, projectId: r.project_id,
    status: r.status as RoleStatus, sessionId: r.session_id, sessionPid: r.session_pid,
    claudeSessionId: r.claude_session_id,
    leaderName: r.leader_name, task: r.task,
    sandbox: r.sandbox === 1, autoApprove: r.auto_approve === 1,
    createdAt: r.created_at,
  };
}

export class RoleInstance {
  readonly id: string;
  readonly templateName: string;
  readonly memberName: string;
  readonly isLeader: boolean;
  teamId: string | null;
  projectId: string | null;
  status: RoleStatus;
  sessionId: string | null;
  sessionPid: number | null;
  claudeSessionId: string | null;
  leaderName: string | null;
  task: string | null;
  sandbox: boolean;
  autoApprove: boolean;
  readonly createdAt: string;

  private constructor(p: RoleInstanceProps) {
    this.id = p.id; this.templateName = p.templateName; this.memberName = p.memberName;
    this.isLeader = p.isLeader; this.teamId = p.teamId; this.projectId = p.projectId;
    this.status = p.status; this.sessionId = p.sessionId; this.sessionPid = p.sessionPid;
    this.claudeSessionId = p.claudeSessionId; this.leaderName = p.leaderName;
    this.task = p.task;
    this.sandbox = p.sandbox; this.autoApprove = p.autoApprove;
    this.createdAt = p.createdAt;
  }

  static create(input: CreateRoleInstanceInput): RoleInstance {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const isLeader = input.isLeader === true;
    const teamId = input.teamId ?? null;
    const projectId = input.projectId ?? null;
    const leaderName = input.leaderName ?? null;
    const task = input.task ?? null;

    const db = getDb();
    // 配额检查在事务内做：SQLite 默认 serialized 事务，COUNT+INSERT 原子，
    // 天然防并发双写超限。limit=0 → 不限。详见 docs/phase5/agent-quota-design.md §2.2。
    db.transaction(() => {
      const limit = readMaxAgents();
      if (limit > 0) {
        const row = db
          .prepare('SELECT COUNT(*) AS c FROM role_instances')
          .get() as { c: number };
        if (row.c >= limit) {
          throw new QuotaExceededError({ current: row.c, limit });
        }
      }
      stmt.insertRow().run(id, input.templateName, input.memberName, isLeader ? 1 : 0,
        teamId, projectId, leaderName, task, now);
      stmt.insertCreateEvent().run(id, now);
    })();

    return new RoleInstance({
      id, templateName: input.templateName, memberName: input.memberName, isLeader,
      teamId, projectId, status: 'PENDING',
      sessionId: null, sessionPid: null, claudeSessionId: null,
      leaderName, task,
      // 成员默认保守：不沙箱、不自动批准。schema DEFAULT 已落库，这里只是 JS 侧镜像。
      sandbox: false, autoApprove: false,
      createdAt: now,
    });
  }

  static findById(id: string): RoleInstance | null {
    const row = stmt.findById().get(id) as Row | undefined;
    return row ? new RoleInstance(rowToProps(row)) : null;
  }

  static listAll(): RoleInstance[] {
    const rows = stmt.listAll().all() as Row[];
    return rows.map((r) => new RoleInstance(rowToProps(r)));
  }

  activate(actor: string | null = null): void {
    this.applyTransition('activate', actor, null);
  }

  registerSession(sessionId: string, pid: number): void {
    this.applyTransition('register_session', null, { sessionId, pid });
    this.sessionId = sessionId; this.sessionPid = pid;
  }

  requestOffline(actor: string | null = null): void {
    this.applyTransition('request_offline', actor, null);
  }

  private applyTransition(
    event: 'activate' | 'register_session' | 'request_offline',
    actor: string | null,
    sp: { sessionId: string; pid: number } | null,
  ): void {
    const from = this.status;
    const to = resolveTransition(event, from);
    if (to === null) throw new Error(`transition '${event}' resolved to null`);
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      if (sp) stmt.updateSession().run(sp.sessionId, sp.pid, to, this.id);
      else stmt.updateStatus().run(to, this.id);
      stmt.insertTransitionEvent().run(this.id, from, to, event, actor, now);
    })();
    this.status = to;
  }

  delete(): void {
    const from = this.status;
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      stmt.insertDeleteEvent().run(this.id, from, now);
      stmt.deleteRow().run(this.id);
    })();
  }

  // setField: 列名动态；热度低，逐次 prepare。
  private setField(col: string, value: unknown): void {
    getDb().prepare(`UPDATE role_instances SET ${col} = ? WHERE id = ?`).run(value as never, this.id);
  }
  setSessionId(v: string | null): void { this.setField('session_id', v); this.sessionId = v; }
  setSessionPid(v: number | null): void { this.setField('session_pid', v); this.sessionPid = v; }
  setClaudeSessionId(v: string | null): void { this.setField('claude_session_id', v); this.claudeSessionId = v; }
  setTask(v: string | null): void { this.setField('task', v); this.task = v; }
  setTeamId(v: string | null): void { this.setField('team_id', v); this.teamId = v; }
  setProjectId(v: string | null): void { this.setField('project_id', v); this.projectId = v; }

  toJSON(): RoleInstanceProps {
    return {
      id: this.id, templateName: this.templateName, memberName: this.memberName,
      isLeader: this.isLeader, teamId: this.teamId, projectId: this.projectId,
      status: this.status, sessionId: this.sessionId, sessionPid: this.sessionPid,
      claudeSessionId: this.claudeSessionId, leaderName: this.leaderName,
      task: this.task,
      sandbox: this.sandbox, autoApprove: this.autoApprove,
      createdAt: this.createdAt,
    };
  }
}
