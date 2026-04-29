// Phase 4 E2E 专用 helpers：封装后端清理 / 造数 / store 断言。
//
// - 后端 HTTP 统一走 /api/panel/* 门面层（前端契约，见 docs/frontend-api/INDEX.md）。
//   注意：role-instance 的 panel 路径是 /api/panel/instances（不是 role-instances）。
// - 前端 store 断言通过 page.evaluate 读 window.__teamStore / __messageStore。
//   假定另一路任务已暴露这些 zustand store（有 getState()）。
// - 所有等待使用 expect.poll；React 18 flush 需要 ~200ms，调用方在 prompt 后 wait(200)。
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const API_BASE = process.env.MTEAM_BACKEND_URL ?? 'http://localhost:58580';

// ---- 唯一名 ----

// 带时间戳+随机后缀，避免并发/多次 run 冲突。
export function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000)}`;
}

// ---- 清理 ----

// GET /api/panel/teams → POST /api/panel/teams/:id/disband 挨个解散。
// 不 force-delete instance / template，后端 subscriber 会级联清成员；
// 保留 instance/template 让其他 spec 复用。
export async function cleanTeams(page: Page): Promise<void> {
  const r = await page.request.get(`${API_BASE}/api/panel/teams`);
  if (!r.ok()) return;
  const teams = (await r.json()) as Array<{ id: string; status: string }>;
  for (const t of teams) {
    if (t.status === 'ACTIVE') {
      await page.request
        .post(`${API_BASE}/api/panel/teams/${encodeURIComponent(t.id)}/disband`)
        .catch(() => {});
    }
  }
}

// ---- 造数 ----

export interface CreateLeaderOpts {
  templateName: string;         // 必须已存在模板
  memberName?: string;          // 默认 uniqueName('leader')
  teamName?: string;            // 默认 uniqueName('team')
  description?: string;         // team 描述
}

export interface CreateLeaderResult {
  instanceId: string;
  memberName: string;
  teamId: string;
  teamName: string;
}

// 两步：POST /api/panel/instances（isLeader=true） → POST /api/panel/teams。
// 失败抛 Error，带 HTTP status + body 方便定位。
export async function createLeader(
  page: Page,
  opts: CreateLeaderOpts,
): Promise<CreateLeaderResult> {
  const memberName = opts.memberName ?? uniqueName('leader');
  const teamName = opts.teamName ?? uniqueName('team');

  const instResp = await page.request.post(`${API_BASE}/api/panel/instances`, {
    data: {
      templateName: opts.templateName,
      memberName,
      isLeader: true,
    },
  });
  if (!instResp.ok()) {
    throw new Error(`createLeader: instance failed ${instResp.status()} ${await instResp.text()}`);
  }
  const instance = (await instResp.json()) as { id: string };

  const teamResp = await page.request.post(`${API_BASE}/api/panel/teams`, {
    data: {
      name: teamName,
      leaderInstanceId: instance.id,
      description: opts.description ?? '',
    },
  });
  if (!teamResp.ok()) {
    throw new Error(`createLeader: team failed ${teamResp.status()} ${await teamResp.text()}`);
  }
  const team = (await teamResp.json()) as { id: string; name: string };

  return { instanceId: instance.id, memberName, teamId: team.id, teamName: team.name };
}

// 新建成员实例 + 加入指定 team。
export async function addMember(
  page: Page,
  teamId: string,
  templateName: string,
  memberName?: string,
  roleInTeam?: string,
): Promise<{ instanceId: string; memberName: string }> {
  const mName = memberName ?? uniqueName('member');

  const instResp = await page.request.post(`${API_BASE}/api/panel/instances`, {
    data: {
      templateName,
      memberName: mName,
      isLeader: false,
    },
  });
  if (!instResp.ok()) {
    throw new Error(`addMember: instance failed ${instResp.status()} ${await instResp.text()}`);
  }
  const instance = (await instResp.json()) as { id: string };

  const joinResp = await page.request.post(
    `${API_BASE}/api/panel/teams/${encodeURIComponent(teamId)}/members`,
    { data: { instanceId: instance.id, roleInTeam: roleInTeam ?? null } },
  );
  if (!joinResp.ok()) {
    throw new Error(`addMember: join failed ${joinResp.status()} ${await joinResp.text()}`);
  }

  return { instanceId: instance.id, memberName: mName };
}

// ---- Store / DOM 断言 ----

// 在 page 里反复求值直到 predicate 返回 truthy。失败抛带 name 的诊断错误。
// expr 会被 new Function 包装执行，访问 window 即可读 store。
export async function waitForStoreState<T = unknown>(
  page: Page,
  expr: string,
  timeoutMs: number = 5_000,
): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        last = (await page.evaluate(expr)) as T;
        return last;
      },
      { timeout: timeoutMs, message: `waitForStoreState timeout: ${expr.slice(0, 80)}` },
    )
    .toBeTruthy();
  return last as T;
}

// ---- 窗口查找 ----

// 在所有 BrowserContext 的所有 Page 里找第一个 URL 含 window=team 的。
// 与 cdp-helpers.getTeamPage 等价，但接收 context 数组形式签名（team-lead 契约）。
export async function findTeamPage(
  contextOrBrowser: BrowserContext | Browser | BrowserContext[],
  timeoutMs: number = 5_000,
): Promise<Page> {
  const contexts: BrowserContext[] = Array.isArray(contextOrBrowser)
    ? contextOrBrowser
    : 'contexts' in contextOrBrowser
      ? contextOrBrowser.contexts()
      : [contextOrBrowser];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        if (p.url().includes('window=team')) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`findTeamPage timeout: no page with window=team within ${timeoutMs}ms`);
}

export { API_BASE };
