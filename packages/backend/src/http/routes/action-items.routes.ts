// Phase 4 · ActionItem HTTP 5 端点。
// 业务规则集中在本文件：body 校验 + repo 调用 + bus emit。
// 签名简化版（见 W3 任务书），非 design.md 中的 POST claim/resolve 形态。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { readBody, notFound } from '../http-utils.js';
import {
  createItem,
  findById,
  listByAssignee,
  listByCreator,
  listPending,
  resolve as resolveItem,
  updateStatus,
} from '../../action-item/repo.js';
import type {
  ActionItemKind,
  ActionItemStatus,
  ActorId,
  ActionItemRow,
  CreateActionItemInput,
} from '../../action-item/types.js';
import { bus } from '../../bus/events.js';
import { makeBase } from '../../bus/helpers.js';

const PREFIX = '/api/action-items';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isActorKind = (v: unknown): v is ActorId['kind'] =>
  v === 'user' || v === 'agent' || v === 'system';
const isKind = (v: unknown): v is ActionItemKind =>
  v === 'task' || v === 'approval' || v === 'decision' || v === 'authorization';

function emitCreated(item: ActionItemRow): void {
  bus.emit({ ...makeBase('action_item.created', 'api:action-items'), item });
}
function emitResolved(item: ActionItemRow, outcome: 'done' | 'rejected' | 'cancelled'): void {
  bus.emit({ ...makeBase('action_item.resolved', 'api:action-items'), item, outcome });
}

function parseCreate(body: unknown): CreateActionItemInput | string {
  if (!isObj(body)) return 'body must be an object';
  if (!isKind(body.kind)) return 'kind must be task/approval/decision/authorization';
  if (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > 200)
    return 'title must be 1~200 chars';
  if (body.description !== undefined && typeof body.description !== 'string')
    return 'description must be string';
  if (!isActorKind(body.assigneeKind)) return 'assigneeKind must be user/agent/system';
  if (typeof body.assigneeId !== 'string' || body.assigneeId.length === 0)
    return 'assigneeId is required';
  if (!isActorKind(body.creatorKind)) return 'creatorKind must be user/agent/system';
  if (typeof body.creatorId !== 'string' || body.creatorId.length === 0)
    return 'creatorId is required';
  if (typeof body.deadline !== 'number' || !Number.isFinite(body.deadline))
    return 'deadline must be number';
  if (body.deadline <= Date.now() + 1000) return 'deadline must be > now + 1000ms';
  if (body.relatedMessageUuid !== undefined && typeof body.relatedMessageUuid !== 'string')
    return 'relatedMessageUuid must be string';
  return {
    kind: body.kind,
    title: body.title,
    description: typeof body.description === 'string' ? body.description : '',
    creator: { kind: body.creatorKind, id: body.creatorId },
    assignee: { kind: body.assigneeKind, id: body.assigneeId },
    deadline: body.deadline,
    relatedMessageId: typeof body.relatedMessageUuid === 'string' ? body.relatedMessageUuid : null,
  };
}

function listWithFilters(q: URLSearchParams): ActionItemRow[] {
  const assigneeId = q.get('assigneeId');
  const creatorId = q.get('creatorId');
  const status = q.get('status') as ActionItemStatus | null;
  if (assigneeId) return listByAssignee(assigneeId, status ?? undefined);
  if (creatorId) return listByCreator(creatorId, status ?? undefined);
  return status ? listPending().filter((i) => i.status === status) : listPending();
}

export async function handleActionItemsRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
  query: URLSearchParams,
): Promise<ApiResponse | null> {
  if (pathname === PREFIX) {
    if (method === 'GET') return { status: 200, body: { items: listWithFilters(query) } };
    if (method === 'POST') {
      const parsed = parseCreate(await readBody(req));
      if (typeof parsed === 'string') return errRes(400, parsed);
      const item = createItem(parsed);
      emitCreated(item);
      return { status: 201, body: item };
    }
    return notFound;
  }

  if (!pathname.startsWith(PREFIX + '/')) return null;
  const rest = pathname.slice(PREFIX.length + 1);
  const parts = rest.split('/');
  if (parts.length === 1 && parts[0] && method === 'GET') {
    const row = findById(parts[0]);
    return row ? { status: 200, body: row } : notFound;
  }
  if (parts.length === 2 && parts[0] && parts[1] === 'resolve' && method === 'PUT') {
    const body = await readBody(req);
    if (!isObj(body)) return errRes(400, 'body must be an object');
    if (body.status !== 'done' && body.status !== 'rejected')
      return errRes(400, 'status must be done or rejected');
    const updated = resolveItem(parts[0], body.status);
    if (!updated) return notFound;
    emitResolved(updated, body.status);
    return { status: 200, body: updated };
  }
  if (parts.length === 2 && parts[0] && parts[1] === 'cancel' && method === 'PUT') {
    const updated = updateStatus(parts[0], 'cancelled');
    if (!updated) return notFound;
    emitResolved(updated, 'cancelled');
    return { status: 200, body: updated };
  }
  return notFound;
}
