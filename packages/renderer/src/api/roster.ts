// Roster —— /api/panel/roster* facade（通讯录 CRUD + 别名）。
import { panelGet, panelPut, panelDelete, type ApiResult } from './client';

export type RosterScope = 'local' | 'remote';
export type SearchScope = 'team' | 'local' | 'remote';

export interface RosterEntry {
  instanceId: string; memberName: string; alias: string; scope: RosterScope;
  status: string; address: string; teamId: string | null; task: string | null;
}
export type SearchResult =
  | { match: 'unique'; target: RosterEntry }
  | { match: 'multiple'; candidates: RosterEntry[] }
  | { match: 'none'; query: string };

function qs(p: URLSearchParams) { const s = p.toString(); return s ? `?${s}` : ''; }

export function listRoster(
  params?: { scope?: SearchScope; callerInstanceId?: string },
): Promise<ApiResult<RosterEntry[]>> {
  const q = new URLSearchParams();
  if (params?.scope) q.set('scope', params.scope);
  if (params?.callerInstanceId) q.set('callerInstanceId', params.callerInstanceId);
  return panelGet<RosterEntry[]>(`/roster${qs(q)}`);
}

export function searchRoster(
  q: string, params?: { scope?: SearchScope; callerInstanceId?: string },
): Promise<ApiResult<SearchResult>> {
  const u = new URLSearchParams({ q });
  if (params?.scope) u.set('scope', params.scope);
  if (params?.callerInstanceId) u.set('callerInstanceId', params.callerInstanceId);
  return panelGet<SearchResult>(`/roster/search?${u.toString()}`);
}

export const getRosterEntry = (id: string) =>
  panelGet<RosterEntry>(`/roster/${encodeURIComponent(id)}`);

export function updateRosterEntry(
  id: string,
  body: { status?: string; address?: string; teamId?: string | null; task?: string | null },
): Promise<ApiResult<RosterEntry>> {
  return panelPut<RosterEntry>(`/roster/${encodeURIComponent(id)}`, body);
}

export const setRosterAlias = (id: string, alias: string) =>
  panelPut<{ instanceId: string; alias: string }>(`/roster/${encodeURIComponent(id)}/alias`, { alias });

export const deleteRosterEntry = (id: string) =>
  panelDelete<null>(`/roster/${encodeURIComponent(id)}`);
