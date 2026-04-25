// Roster —— /api/panel/roster* facade（通讯录 CRUD + 别名）。

import { panelGet, panelPut, panelDelete, type ApiResult } from './client';

export type RosterScope = 'local' | 'remote';
export type SearchScope = 'team' | 'local' | 'remote';

export interface RosterEntry {
  instanceId: string;
  memberName: string;
  alias: string;
  scope: RosterScope;
  status: string;
  address: string;
  teamId: string | null;
  task: string | null;
}

export function listRoster(params?: { scope?: SearchScope; callerInstanceId?: string }): Promise<ApiResult<RosterEntry[]>> {
  const q = new URLSearchParams();
  if (params?.scope) q.set('scope', params.scope);
  if (params?.callerInstanceId) q.set('callerInstanceId', params.callerInstanceId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return panelGet<RosterEntry[]>(`/roster${suffix}`);
}

export function searchRoster(q: string, params?: { scope?: SearchScope; callerInstanceId?: string }): Promise<ApiResult<RosterEntry[]>> {
  const u = new URLSearchParams({ q });
  if (params?.scope) u.set('scope', params.scope);
  if (params?.callerInstanceId) u.set('callerInstanceId', params.callerInstanceId);
  return panelGet<RosterEntry[]>(`/roster/search?${u.toString()}`);
}

export function setRosterAlias(instanceId: string, alias: string): Promise<ApiResult<{ instanceId: string; alias: string }>> {
  return panelPut(`/roster/${encodeURIComponent(instanceId)}/alias`, { alias });
}

export function deleteRosterEntry(instanceId: string): Promise<ApiResult<null>> {
  return panelDelete<null>(`/roster/${encodeURIComponent(instanceId)}`);
}
