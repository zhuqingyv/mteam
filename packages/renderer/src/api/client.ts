// 前端 API 客户端基础设施。
//
// 硬门禁（PRD §0.2 · mnemo 共识 feedback_no_direct_backend_api）：
// 前端只允许调用 /api/panel/* 下的端点。其他顶级路径（/api/teams、
// /api/role-instances、/api/messages 等）由服务端保留给 agent/内部调用，
// 前端绝不能直连。D6 缺口（/api/panel/ facade 层）落地前，大部分领域
// 函数只提供占位（panelPending）返回统一错误。
//
// 当前 /api/panel/ 下唯一合规端点：GET /api/panel/driver/:driverId/turns（见 ./driver-turns）。

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:58590';

export const PANEL_BASE = `${API_BASE}/api/panel`;

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

async function apiFetch<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const resp = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (resp.status === 204) {
      return { ok: true, status: 204, data: null, error: null };
    }

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

// path 不带 '/api/panel' 前缀，本函数自动补上，确保不会误调顶级 /api/*。
export function panelGet<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(`${PANEL_BASE}${path}`, { method: 'GET' });
}

export function panelPost<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiFetch<T>(`${PANEL_BASE}${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function panelPut<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiFetch<T>(`${PANEL_BASE}${path}`, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function panelDelete<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(`${PANEL_BASE}${path}`, { method: 'DELETE' });
}

// D6 占位：服务端 /api/panel/ facade 未覆盖的领域统一返回此错误。
// 调用方把 ok:false + D6 错误当作"UI 骨架模式"，展示空态或假数据。
export function panelPending<T = unknown>(feature: string): Promise<ApiResult<T>> {
  return Promise.resolve({
    ok: false,
    status: 0,
    data: null,
    error: `D6: /api/panel/ facade pending (${feature})`,
  });
}
