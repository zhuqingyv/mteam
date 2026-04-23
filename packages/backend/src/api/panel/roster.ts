import { roster } from '../../roster/roster.js';
import type { RosterEntry, RosterScope, SearchScope } from '../../roster/types.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseScope(v: string | undefined): SearchScope | undefined {
  if (!v) return undefined;
  if (v === 'team' || v === 'local' || v === 'remote') return v;
  return undefined;
}

export function handleListRoster(query: URLSearchParams): ApiResponse {
  const scope = parseScope(query.get('scope') ?? undefined);
  const caller = query.get('callerInstanceId') ?? undefined;
  if (scope === 'team' && !caller) {
    return errRes(400, 'callerInstanceId is required when scope=team');
  }
  try {
    return { status: 200, body: roster.list(caller, scope) };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export function handleSearchRoster(query: URLSearchParams): ApiResponse {
  const q = query.get('q');
  if (!q) return errRes(400, 'q is required');
  const scope = parseScope(query.get('scope') ?? undefined);
  const caller = query.get('callerInstanceId') ?? '';
  if (scope === 'team' && !caller) {
    return errRes(400, 'callerInstanceId is required when scope=team');
  }
  try {
    return { status: 200, body: roster.search(caller, q, scope) };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export function handleGetRosterEntry(instanceId: string): ApiResponse {
  const entry = roster.get(instanceId);
  if (!entry) return errRes(404, `instance '${instanceId}' not in roster`);
  return { status: 200, body: entry };
}

export function handleAddRoster(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const instanceId = str(body.instanceId);
  const memberName = str(body.memberName);
  const scope = str(body.scope);
  const status = str(body.status);
  const address = str(body.address);
  if (!instanceId) return errRes(400, 'instanceId is required');
  if (!memberName) return errRes(400, 'memberName is required');
  if (scope !== 'local' && scope !== 'remote') return errRes(400, "scope must be 'local' or 'remote'");
  if (!status) return errRes(400, 'status is required');
  if (!address) return errRes(400, 'address is required');

  const alias = str(body.alias) ?? memberName;
  const teamId = str(body.teamId);
  const task = str(body.task);

  const entry: RosterEntry = {
    instanceId, memberName, alias,
    scope: scope as RosterScope,
    status, address, teamId, task,
  };

  if (roster.get(instanceId)) {
    return errRes(409, `instance '${instanceId}' already exists`);
  }
  try {
    roster.add(entry);
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
  const added = roster.get(instanceId);
  return { status: 201, body: added };
}

export function handleUpdateRoster(instanceId: string, body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  if (!roster.get(instanceId)) return errRes(404, `instance '${instanceId}' not in roster`);
  const fields: Partial<RosterEntry> = {};
  if (typeof body.status === 'string') fields.status = body.status;
  if (typeof body.address === 'string') fields.address = body.address;
  if ('teamId' in body) fields.teamId = body.teamId === null ? null : str(body.teamId) ?? undefined;
  if ('task' in body) fields.task = body.task === null ? null : str(body.task) ?? undefined;
  try {
    roster.update(instanceId, fields);
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
  return { status: 200, body: roster.get(instanceId) };
}

export function handleSetAlias(instanceId: string, body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const alias = str(body.alias);
  if (!alias) return errRes(400, 'alias is required');
  if (!roster.get(instanceId)) return errRes(404, `instance '${instanceId}' not in roster`);
  roster.setAlias(instanceId, alias);
  return { status: 200, body: { instanceId, alias } };
}

export function handleDeleteRoster(instanceId: string): ApiResponse {
  if (!roster.get(instanceId)) return errRes(404, `instance '${instanceId}' not in roster`);
  roster.remove(instanceId);
  return { status: 204, body: null };
}
