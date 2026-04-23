// WS + HTTP 组合集成测试共用 helper。给 team-lifecycle-ws.test.ts 等使用。
// 设计：由测试文件提供 BASE（http URL）和共享 events 数组，helper 封装 HTTP 调接口 +
// 等待事件的动作。event 收集逻辑由测试文件的 beforeAll 统一挂到 ws.onmessage。

export interface ApiResult {
  status: number;
  data: unknown;
}

export async function apiCall(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export function createTemplate(base: string, name: string): Promise<ApiResult> {
  return apiCall(base, 'POST', '/api/role-templates', { name, role: 'dev' });
}

export function createInstance(
  base: string,
  templateName: string,
  memberName: string,
  isLeader = false,
): Promise<ApiResult> {
  return apiCall(base, 'POST', '/api/role-instances', {
    templateName,
    memberName,
    isLeader,
  });
}

export function activateInstance(base: string, id: string): Promise<ApiResult> {
  return apiCall(base, 'POST', `/api/role-instances/${id}/activate`);
}

export function requestOffline(
  base: string,
  id: string,
  callerId: string,
): Promise<ApiResult> {
  return apiCall(base, 'POST', `/api/role-instances/${id}/request-offline`, {}, {
    'X-Role-Instance-Id': callerId,
  });
}

export function deleteInstance(
  base: string,
  id: string,
  force = false,
): Promise<ApiResult> {
  return apiCall(base, 'DELETE', `/api/role-instances/${id}${force ? '?force=1' : ''}`);
}

export function createTeam(
  base: string,
  name: string,
  leaderInstanceId: string,
): Promise<ApiResult> {
  return apiCall(base, 'POST', '/api/teams', { name, leaderInstanceId });
}

export function addMember(
  base: string,
  teamId: string,
  instanceId: string,
): Promise<ApiResult> {
  return apiCall(base, 'POST', `/api/teams/${teamId}/members`, { instanceId });
}

export function removeMember(
  base: string,
  teamId: string,
  instanceId: string,
): Promise<ApiResult> {
  return apiCall(base, 'DELETE', `/api/teams/${teamId}/members/${instanceId}`);
}

export function disbandTeam(base: string, teamId: string): Promise<ApiResult> {
  return apiCall(base, 'POST', `/api/teams/${teamId}/disband`);
}

// 轮询 events 数组等特定 type 出现。找不到就抛超时错误。
export async function waitForEvent(
  events: ReadonlyArray<Record<string, unknown>>,
  type: string,
  timeout = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`event ${type} not received within ${timeout}ms`);
}
