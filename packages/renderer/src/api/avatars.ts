// Avatars 头像库 — 走 /api/panel/avatars/* 门面。
// 仅暴露 list + random；add/delete/restore 暂未接入 UI。

import { panelGet, type ApiResult } from './client';

export interface AvatarRow {
  id: string;
  filename: string;
  builtin: boolean;
  createdAt?: string;
}

export function listAvatars(): Promise<ApiResult<{ avatars: AvatarRow[] }>> {
  return panelGet<{ avatars: AvatarRow[] }>('/avatars');
}

export function randomAvatar(): Promise<ApiResult<{ avatar: AvatarRow | null }>> {
  return panelGet<{ avatar: AvatarRow | null }>('/avatars/random');
}
