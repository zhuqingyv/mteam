export interface HttpResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  error: string | null;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === 'string') return e;
  }
  if (typeof body === 'string' && body.length > 0) return body;
  return fallback;
}

export async function httpJson<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<HttpResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `network error: ${(e as Error).message}`,
    };
  }
  const body = await parseBody(res);
  if (res.ok) {
    return { ok: true, status: res.status, body: body as T, error: null };
  }
  return {
    ok: false,
    status: res.status,
    body: body as T,
    error: extractError(body, `HTTP ${res.status}`),
  };
}

export function buildQuery(params: Record<string, string | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
