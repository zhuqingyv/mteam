// 后端 API 封装：统一 base URL + 错误包装。
// 返回 { ok, status, data } 结构，由面板自行决定如何展示。
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:58590';

// 面板用的响应壳，失败时 data 里会带 error 字段。
export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

// 核心 fetch，任何异常都归一化成 ApiResult，避免面板处理 throw。
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const url = `${API_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    // 204 无返回体
    if (resp.status === 204) {
      return { ok: true, status: 204, data: null, error: null };
    }

    // 解析 JSON（容忍空）
    const text = await resp.text();
    const parsed: unknown = text ? JSON.parse(text) : null;

    if (!resp.ok) {
      const err =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${resp.status}`;
      return { ok: false, status: resp.status, data: parsed as T | null, error: err };
    }

    return { ok: true, status: resp.status, data: parsed as T, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, error: msg };
  }
}

// 常用动词快捷方式，body 会自动 JSON 序列化。
export function apiGet<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: 'GET' });
}

export function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult<T>> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

export function apiPut<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiFetch<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

// Team API
export const apiListTeams = () => apiGet('/api/teams');
export const apiGetTeam = (id: string) => apiGet(`/api/teams/${encodeURIComponent(id)}`);
export const apiCreateTeam = (body: { name: string; leaderInstanceId: string }) =>
  apiPost('/api/teams', body);
export const apiDisbandTeam = (id: string) =>
  apiPost(`/api/teams/${encodeURIComponent(id)}/disband`);
export const apiAddTeamMember = (
  teamId: string,
  body: { instanceId: string; roleInTeam?: string },
) => apiPost(`/api/teams/${encodeURIComponent(teamId)}/members`, body);
export const apiRemoveTeamMember = (teamId: string, instanceId: string) =>
  apiDelete(
    `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(instanceId)}`,
  );
export const apiListTeamMembers = (teamId: string) =>
  apiGet(`/api/teams/${encodeURIComponent(teamId)}/members`);
