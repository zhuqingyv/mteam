// Instances（Agent 实例）—— /api/panel/instances* facade，对应后端 /api/role-instances*。

import { panelGet, panelPost, panelDelete, type ApiResult } from './client';

export type RoleStatus = 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE';

export interface RoleInstance {
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

export interface CreateInstanceBody {
  templateName: string;
  memberName: string;
  isLeader?: boolean;
  task?: string;
  leaderName?: string;
}

export function listInstances(): Promise<ApiResult<RoleInstance[]>> {
  return panelGet<RoleInstance[]>('/instances');
}

export function createInstance(body: CreateInstanceBody): Promise<ApiResult<RoleInstance>> {
  return panelPost<RoleInstance>('/instances', body);
}

export function activateInstance(id: string): Promise<ApiResult<RoleInstance>> {
  return panelPost<RoleInstance>(`/instances/${encodeURIComponent(id)}/activate`);
}

export function requestOffline(id: string, callerInstanceId: string): Promise<ApiResult<RoleInstance>> {
  return panelPost<RoleInstance>(
    `/instances/${encodeURIComponent(id)}/request-offline`,
    { callerInstanceId },
  );
}

export function deleteInstance(id: string, force = false): Promise<ApiResult<null>> {
  return panelDelete<null>(`/instances/${encodeURIComponent(id)}${force ? '?force=1' : ''}`);
}
