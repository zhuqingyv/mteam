// Instances（Agent 实例）—— /api/panel/instances* facade，对应后端 /api/role-instances*。

import { panelGet, panelPost, panelDelete, type ApiResult } from './client';

export type InstanceStatus = 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE' | 'OFFLINE' | 'DELETED';

export interface RoleInstance {
  id: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  status: InstanceStatus;
  teamId: string | null;
  task: string | null;
  leaderName: string | null;
  createdAt: string;
  claudeSessionId?: string | null;
}

export interface CreateInstanceBody {
  templateName: string;
  memberName: string;
  isLeader?: boolean;
  task?: string | null;
  leaderName?: string | null;
}

export function listInstances(): Promise<ApiResult<RoleInstance[]>> {
  return panelGet<RoleInstance[]>('/instances');
}

export function getInstance(id: string): Promise<ApiResult<RoleInstance>> {
  return panelGet<RoleInstance>(`/instances/${encodeURIComponent(id)}`);
}

export function createInstance(body: CreateInstanceBody): Promise<ApiResult<RoleInstance>> {
  return panelPost<RoleInstance>('/instances', body);
}

export function activateInstance(id: string): Promise<ApiResult<RoleInstance>> {
  return panelPost<RoleInstance>(`/instances/${encodeURIComponent(id)}/activate`);
}

export function requestOffline(id: string, callerInstanceId: string): Promise<ApiResult<RoleInstance>> {
  const url = `/instances/${encodeURIComponent(id)}/request-offline`;
  return panelPost<RoleInstance>(url, { callerInstanceId });
}

export function deleteInstance(id: string, force = false): Promise<ApiResult<null>> {
  return panelDelete<null>(`/instances/${encodeURIComponent(id)}${force ? '?force=1' : ''}`);
}
