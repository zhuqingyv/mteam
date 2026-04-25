// RoleTemplate —— /api/panel/templates* facade（后端 /api/role-templates 转发）。

import { panelGet, panelPost, panelPut, panelDelete, type ApiResult } from './client';

export interface McpToolVisibility {
  name: string;
  surface?: '*' | string[];
  search?: '*' | string[];
}

export interface RoleTemplate {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  availableMcps: McpToolVisibility[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTemplateBody {
  name: string;
  role: string;
  description?: string | null;
  persona?: string | null;
  availableMcps?: McpToolVisibility[];
}

export type UpdateTemplateBody = Partial<Omit<CreateTemplateBody, 'name'>>;

export function listTemplates(): Promise<ApiResult<RoleTemplate[]>> {
  return panelGet<RoleTemplate[]>('/templates');
}

export function getTemplate(name: string): Promise<ApiResult<RoleTemplate>> {
  return panelGet<RoleTemplate>(`/templates/${encodeURIComponent(name)}`);
}

export function createTemplate(body: CreateTemplateBody): Promise<ApiResult<RoleTemplate>> {
  return panelPost<RoleTemplate>('/templates', body);
}

export function updateTemplate(name: string, body: UpdateTemplateBody): Promise<ApiResult<RoleTemplate>> {
  return panelPut<RoleTemplate>(`/templates/${encodeURIComponent(name)}`, body);
}

export function deleteTemplate(name: string): Promise<ApiResult<null>> {
  return panelDelete<null>(`/templates/${encodeURIComponent(name)}`);
}
