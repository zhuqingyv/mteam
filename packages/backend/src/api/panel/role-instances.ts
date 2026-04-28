// 角色实例 HTTP 接口。负责实例生命周期（创建/激活/请求下线/删除）。
// 副作用（roster 同步 / driver 启停）由 bus subscriber 自动处理：
//   instance.created → member-driver.start + roster.add
//   instance.activated → roster.update ACTIVE
//   instance.offline_requested → roster.update PENDING_OFFLINE
//   instance.deleted → member-driver.stop + roster.remove
import { RoleTemplate } from '../../domain/role-template.js';
import { RoleInstance, QuotaExceededError } from '../../domain/role-instance.js';
import type { CreateRoleInstanceInput } from '../../domain/role-instance.js';
import type { ApiResponse } from './role-templates.js';
import { bus } from '../../bus/index.js';
import { makeBase, newCorrelationId } from '../../bus/helpers.js';
import { pushNotification } from '../../notification-center/repo.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateRequiredString(v: unknown, field: string, max: number): string | null {
  if (typeof v !== 'string') return `${field} is required`;
  if (v.length < 1 || v.length > max) return `${field} must be 1~${max} chars`;
  return null;
}

function validateOptionalString(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return `${field} must be string or null`;
  if (v.length > max) return `${field} must be ≤ ${max} chars`;
  return null;
}

// 从 body 取并校验 create 所需字段。失败返回错误消息，成功返回 null。
function validateCreateBody(body: Record<string, unknown>): string | null {
  const tplErr = validateRequiredString(body.templateName, 'templateName', 64);
  if (tplErr) return tplErr;
  const memberErr = validateRequiredString(body.memberName, 'memberName', 64);
  if (memberErr) return memberErr;
  if ('isLeader' in body && body.isLeader !== undefined && typeof body.isLeader !== 'boolean') {
    return 'isLeader must be boolean';
  }
  const taskErr = validateOptionalString(body.task, 'task', 2048);
  if (taskErr) return taskErr;
  const leaderErr = validateOptionalString(body.leaderName, 'leaderName', 64);
  if (leaderErr) return leaderErr;
  return null;
}

// 创建角色实例：校验 → 查模板 → 入库 → 发 instance.created。
// 副作用（member-driver 启动 / roster.add / session_pid 回写）由 bus subscriber 自动处理。
export function handleCreateInstance(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const verr = validateCreateBody(body);
  if (verr) return errRes(400, verr);

  const templateName = body.templateName as string;
  const template = RoleTemplate.findByName(templateName);
  if (!template) return errRes(404, `template '${templateName}' not found`);

  const input: CreateRoleInstanceInput = {
    templateName,
    memberName: body.memberName as string,
    isLeader: (body.isLeader as boolean | undefined) ?? false,
    task: (body.task as string | null | undefined) ?? null,
    leaderName: (body.leaderName as string | null | undefined) ?? null,
  };
  let instance: RoleInstance;
  try {
    instance = RoleInstance.create(input);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      const { message: error, code, resource, current, limit } = err;
      emitQuotaLimitNotification(err);
      return { status: 409, body: { error, code, resource, current, limit } };
    }
    throw err;
  }

  bus.emit({
    ...makeBase('instance.created', 'api/panel/role-instances', newCorrelationId()),
    instanceId: instance.id,
    templateName: instance.templateName,
    memberName: instance.memberName,
    isLeader: instance.isLeader,
    teamId: instance.teamId,
    task: instance.task,
  });

  return { status: 201, body: instance.toJSON() };
}

export function handleListInstances(): ApiResponse {
  const list = RoleInstance.listAll();
  return { status: 200, body: list.map((i) => i.toJSON()) };
}

// Leader 批准某成员下线：ACTIVE -> PENDING_OFFLINE。
// callerInstanceId 优先从 header（X-Role-Instance-Id），body 作 fallback，兼容旧调用方。
// 副作用（roster.update PENDING_OFFLINE）由 bus subscriber 自动处理。
export function handleRequestOffline(
  id: string,
  body: unknown,
  headerCallerId: string | null = null,
): ApiResponse {
  const instance = RoleInstance.findById(id);
  if (!instance) return errRes(404, `role instance '${id}' not found`);

  const obj = isPlainObject(body) ? body : {};
  const bodyCallerId = typeof obj.callerInstanceId === 'string' ? obj.callerInstanceId : null;
  const callerId = headerCallerId ?? bodyCallerId;
  if (!callerId) return errRes(400, 'callerInstanceId is required');
  const caller = RoleInstance.findById(callerId);
  if (!caller) return errRes(404, `caller '${callerId}' not found`);
  if (!caller.isLeader) return errRes(403, 'only leader can request offline');

  if (instance.status !== 'ACTIVE') {
    return errRes(409, `instance status is '${instance.status}', expected ACTIVE`);
  }

  try {
    instance.requestOffline(caller.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'transition failed';
    return errRes(409, msg);
  }

  bus.emit({
    ...makeBase('instance.offline_requested', 'api/panel/role-instances'),
    instanceId: id,
    requestedBy: caller.id,
  });

  return { status: 200, body: instance.toJSON() };
}

// 面板或测试走的激活入口：PENDING -> ACTIVE，不依赖 session register。
// 副作用（roster.update ACTIVE）由 bus subscriber 自动处理。
export function handleActivate(id: string): ApiResponse {
  const instance = RoleInstance.findById(id);
  if (!instance) return errRes(404, `role instance '${id}' not found`);
  if (instance.status !== 'PENDING') {
    return errRes(409, `instance status is '${instance.status}', expected PENDING`);
  }
  try {
    instance.activate(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'transition failed';
    return errRes(409, msg);
  }

  bus.emit({
    ...makeBase('instance.activated', 'api/panel/role-instances'),
    instanceId: id,
    actor: null,
  });

  return { status: 200, body: instance.toJSON() };
}

// 删除实例，状态机保护：
//   PENDING / PENDING_OFFLINE -> 正常删（PENDING 尚未激活可撤销；PENDING_OFFLINE 已批准下线）
//   ACTIVE                    -> 拒绝 409（必须先 request-offline）
//   ?force=1                  -> 强制删（crash 语义，用于清理脏数据/僵尸）
// 副作用（member-driver 停止 / roster.remove）由 bus subscriber 自动处理。
export function handleDeleteInstance(id: string, force = false): ApiResponse {
  const instance = RoleInstance.findById(id);
  if (!instance) return errRes(404, `role instance '${id}' not found`);

  if (!force) {
    if (instance.status === 'ACTIVE') {
      return errRes(409, '需要 leader 批准下线');
    }
    if (instance.status !== 'PENDING' && instance.status !== 'PENDING_OFFLINE') {
      return errRes(
        409,
        `instance status is '${instance.status}', expected PENDING or PENDING_OFFLINE (use ?force=1 to override)`,
      );
    }
  }

  // CASCADE 时序：instance.delete() 会触发 teams / team_members 的级联删除，
  // subscriber 之后再查 findByInstance 会拿到 null。所以必须在 delete 之前抓快照。
  const previousStatus = instance.status;
  const teamId = instance.teamId;
  const isLeader = instance.isLeader;
  instance.delete();

  bus.emit({
    ...makeBase('instance.deleted', 'api/panel/role-instances'),
    instanceId: id,
    previousStatus,
    force,
    teamId,
    isLeader,
  });

  return { status: 204, body: null };
}

// 配额超限 → 落库一条 notification + emit notification.delivered 让 WS 广播。
// delivered 事件本身不带 body（id:853 决策）；前端收到后按 sourceEventId=通知 id 拉详情。
function emitQuotaLimitNotification(err: QuotaExceededError): void {
  try {
    const rec = pushNotification({
      userId: 'local',
      kind: 'quota_limit',
      channel: 'system',
      severity: 'warn',
      title: 'Agent 创建失败',
      body: `已达上限 ${err.current}/${err.limit}，无法创建新 agent`,
      payload: { resource: err.resource, current: err.current, limit: err.limit },
    });
    bus.emit({
      ...makeBase('notification.delivered', 'api/panel/role-instances'),
      target: { kind: 'user', id: 'local' },
      sourceEventType: 'notification.quota_limit',
      sourceEventId: rec.id,
    });
  } catch (e) {
    process.stderr.write(
      `[api/role-instances] emit quota notification failed: ${(e as Error).message}\n`,
    );
  }
}
