// Instances（Agent 实例）领域 —— [待 D6]
//
// 服务端现有端点挂在顶级 /api/role-instances，前端硬门禁禁止直连。
// D6 facade 未落地前，所有调用返回统一 D6 pending 错误。
//
// 未来服务端 facade 映射参考：
//   listInstances   → GET    /api/panel/instances
//   getInstance     → GET    /api/panel/instances/:id
//   createInstance  → POST   /api/panel/instances
//   activate        → POST   /api/panel/instances/:id/activate
//   requestOffline  → POST   /api/panel/instances/:id/request-offline
//   deleteInstance  → DELETE /api/panel/instances/:id?force=1

import { panelPending, type ApiResult } from './client';

export type InstanceStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PENDING_OFFLINE'
  | 'OFFLINE'
  | 'DELETED';

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
  return panelPending<RoleInstance[]>('instances.list');
}

export function getInstance(_id: string): Promise<ApiResult<RoleInstance>> {
  return panelPending<RoleInstance>('instances.get');
}

export function createInstance(_body: CreateInstanceBody): Promise<ApiResult<RoleInstance>> {
  return panelPending<RoleInstance>('instances.create');
}

export function activateInstance(_id: string): Promise<ApiResult<RoleInstance>> {
  return panelPending<RoleInstance>('instances.activate');
}

export function requestOffline(
  _id: string,
  _callerInstanceId: string,
): Promise<ApiResult<RoleInstance>> {
  return panelPending<RoleInstance>('instances.requestOffline');
}

export function deleteInstance(_id: string, _force = false): Promise<ApiResult<null>> {
  return panelPending<null>('instances.delete');
}
