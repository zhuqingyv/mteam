import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { RoleStatus, resolveTransition } from './state-machine.js';
import { EVENTS, roleEvents } from './events.js';

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
  leader_name: string | null; task: string | null; created_at: string;
}

function rowToProps(r: Row): RoleInstanceProps {
  return {
    id: r.id, templateName: r.template_name, memberName: r.member_name,
    isLeader: r.is_leader === 1, teamId: r.team_id, projectId: r.project_id,
    status: r.status as RoleStatus, sessionId: r.session_id, sessionPid: r.session_pid,
    claudeSessionId: r.claude_session_id,
    leaderName: r.leader_name, task: r.task, createdAt: r.created_at,
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
  readonly createdAt: string;

  private constructor(p: RoleInstanceProps) {
    this.id = p.id; this.templateName = p.templateName; this.memberName = p.memberName;
    this.isLeader = p.isLeader; this.teamId = p.teamId; this.projectId = p.projectId;
    this.status = p.status; this.sessionId = p.sessionId; this.sessionPid = p.sessionPid;
    this.claudeSessionId = p.claudeSessionId; this.leaderName = p.leaderName;
    this.task = p.task; this.createdAt = p.createdAt;
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
    db.transaction(() => {
      db.prepare(
        `INSERT INTO role_instances
           (id, template_name, member_name, is_leader, team_id, project_id,
            status, session_id, session_pid, leader_name, task, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?, ?)`,
      ).run(id, input.templateName, input.memberName, isLeader ? 1 : 0,
            teamId, projectId, leaderName, task, now);
      db.prepare(
        `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
         VALUES (?, NULL, 'PENDING', 'create', NULL, ?)`,
      ).run(id, now);
    })();

    roleEvents.emit(EVENTS.ROLE_CREATED, {
      instanceId: id, templateName: input.templateName, memberName: input.memberName, at: now,
    });

    return new RoleInstance({
      id, templateName: input.templateName, memberName: input.memberName, isLeader,
      teamId, projectId, status: 'PENDING',
      sessionId: null, sessionPid: null, claudeSessionId: null,
      leaderName, task, createdAt: now,
    });
  }

  static findById(id: string): RoleInstance | null {
    const row = getDb().prepare(`SELECT * FROM role_instances WHERE id = ?`).get(id) as Row | undefined;
    return row ? new RoleInstance(rowToProps(row)) : null;
  }

  static listAll(): RoleInstance[] {
    const rows = getDb()
      .prepare(`SELECT * FROM role_instances ORDER BY created_at DESC`)
      .all() as Row[];
    return rows.map((r) => new RoleInstance(rowToProps(r)));
  }

  activate(actor: string | null = null): void {
    const now = this.applyTransition('activate', actor, null);
    roleEvents.emit(EVENTS.ROLE_ACTIVATED, { instanceId: this.id, actor, at: now });
  }

  registerSession(sessionId: string, pid: number): void {
    const now = this.applyTransition('register_session', null, { sessionId, pid });
    this.sessionId = sessionId; this.sessionPid = pid;
    roleEvents.emit(EVENTS.ROLE_ACTIVATED, { instanceId: this.id, actor: null, at: now });
  }

  requestOffline(actor: string | null = null): void {
    this.applyTransition('request_offline', actor, null);
  }

  private applyTransition(
    event: 'activate' | 'register_session' | 'request_offline',
    actor: string | null,
    sp: { sessionId: string; pid: number } | null,
  ): string {
    const from = this.status;
    const to = resolveTransition(event, from);
    if (to === null) throw new Error(`transition '${event}' resolved to null`);
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      const sql = sp
        ? `UPDATE role_instances SET session_id = ?, session_pid = ?, status = ? WHERE id = ?`
        : `UPDATE role_instances SET status = ? WHERE id = ?`;
      const args = sp ? [sp.sessionId, sp.pid, to, this.id] : [to, this.id];
      db.prepare(sql).run(...args);
      db.prepare(
        `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(this.id, from, to, event, actor, now);
    })();
    this.status = to;
    return now;
  }

  delete(): void {
    const from = this.status;
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
         VALUES (?, ?, 'DELETED', 'delete', NULL, ?)`,
      ).run(this.id, from, now);
      db.prepare(`DELETE FROM role_instances WHERE id = ?`).run(this.id);
    })();
    roleEvents.emit(EVENTS.ROLE_DELETED, { instanceId: this.id, at: now });
  }

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
      task: this.task, createdAt: this.createdAt,
    };
  }
}
