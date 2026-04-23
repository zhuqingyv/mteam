// Team 生命周期联动集成测试：WS 收事件 + HTTP 调接口组合验证。
// 模式：Bun.spawn 起 server + :memory: DB + 随机端口。
// 每 case 前 clearEvents，HTTP 调接口后 waitForEvent 验证 bus 推送。
// server 进程长驻，:memory: 跨 case 不重建 → template/instance 名必须加时间戳避唯一约束。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  activateInstance, addMember, createInstance, createTeam, createTemplate,
  deleteInstance, disbandTeam, removeMember, requestOffline, waitForEvent,
} from './helpers/ws-test-helpers.js';

const PORT = 50000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/events`;
const SOCK = `/tmp/test-lifecycle-${process.pid}-${PORT}.sock`;

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
const events: Array<Record<string, unknown>> = [];

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/role-templates`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready within 5s');
}

beforeAll(async () => {
  serverProc = Bun.spawn(['bun', 'run', 'packages/backend/src/server.ts'], {
    env: {
      ...process.env, V2_PORT: String(PORT), TEAM_HUB_V2_DB: ':memory:',
      TEAM_HUB_CLI_BIN: '/usr/bin/true', TEAM_HUB_COMM_SOCK: SOCK,
    },
    cwd: '/Users/zhuqingyu/project/mcp-team-hub', stdout: 'ignore', stderr: 'ignore',
  });
  await waitReady();
  ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout 3s')), 3000);
    ws!.onopen = (): void => { clearTimeout(timer); resolve(); };
    ws!.onerror = (): void => { clearTimeout(timer); reject(new Error('ws connect error')); };
  });
  ws.onmessage = (msg: MessageEvent): void => {
    try { events.push(JSON.parse(msg.data as string)); } catch { /* ignore non-JSON */ }
  };
});

afterAll(() => {
  try { ws?.close(); } catch { /* ignore */ }
  serverProc?.kill();
});

function clearEvents(): void { events.length = 0; }

let seq = 0;
const uniq = (p: string): string => `${p}-${Date.now()}-${seq++}`;
const idOf = (r: { data: unknown }): string => (r.data as { id: string }).id;

// 建 leader + team 公用工具。addLeaderAsMember=true 把 leader 也加进 team_members，
// 这样 leader.role_instances.team_id 被设上，leader 被 delete 时 payload 才会带 teamId。
async function setup(activateLeader: boolean, addLeaderAsMember = false): Promise<{
  tpl: string; leaderId: string; teamId: string;
}> {
  const tpl = uniq('tpl');
  expect((await createTemplate(BASE, tpl)).status).toBe(201);
  const l = await createInstance(BASE, tpl, uniq('leader'), true);
  const leaderId = idOf(l);
  if (activateLeader) expect((await activateInstance(BASE, leaderId)).status).toBe(200);
  const t = await createTeam(BASE, uniq('team'), leaderId);
  const teamId = idOf(t);
  if (addLeaderAsMember) expect((await addMember(BASE, teamId, leaderId)).status).toBe(201);
  return { tpl, leaderId, teamId };
}

async function addActive(tpl: string, teamId: string): Promise<string> {
  const r = await createInstance(BASE, tpl, uniq('m'), false);
  const id = idOf(r);
  expect((await activateInstance(BASE, id)).status).toBe(200);
  expect((await addMember(BASE, teamId, id)).status).toBe(201);
  return id;
}

async function waitMatch(
  type: string, match: (e: Record<string, unknown>) => boolean, timeout = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = events.find((e) => e.type === type && match(e));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`event ${type} matching predicate not received within ${timeout}ms`);
}

describe('Team 生命周期联动', () => {
  beforeEach(() => clearEvents());

  it('Case 1: 成员 request_offline → team.member_left(offline_requested)', async () => {
    const { tpl, leaderId, teamId } = await setup(true);
    const memberId = await addActive(tpl, teamId);
    clearEvents();
    expect((await requestOffline(BASE, memberId, leaderId)).status).toBe(200);
    const e = await waitMatch('team.member_left',
      (x) => x.instanceId === memberId && x.reason === 'offline_requested');
    expect(e.teamId).toBe(teamId);
  });

  it('Case 2: 成员 deleted → team.member_left(instance_deleted)', async () => {
    const { tpl, teamId } = await setup(true);
    const m = await createInstance(BASE, tpl, uniq('m'), false);
    const memberId = idOf(m);
    expect((await addMember(BASE, teamId, memberId)).status).toBe(201);
    clearEvents();
    expect((await deleteInstance(BASE, memberId, true)).status).toBe(204);
    const e = await waitMatch('team.member_left',
      (x) => x.instanceId === memberId && x.reason === 'instance_deleted');
    expect(e.teamId).toBe(teamId);
  });

  it('Case 3: leader request_offline → team disbanded + 成员级联下线', async () => {
    const { tpl, leaderId, teamId } = await setup(true);
    const m1 = await addActive(tpl, teamId);
    const m2 = await addActive(tpl, teamId);
    clearEvents();
    // leader 自己批准自己下线
    expect((await requestOffline(BASE, leaderId, leaderId)).status).toBe(200);
    await waitMatch('team.disbanded', (x) => x.teamId === teamId && x.reason === 'leader_gone');
    await waitMatch('instance.offline_requested', (x) => x.instanceId === m1);
    await waitMatch('instance.offline_requested', (x) => x.instanceId === m2);
  });

  it('Case 4: leader deleted → team disbanded + 成员 force deleted', async () => {
    // leader 必须 addLeaderAsMember=true：role_instances.team_id 才会设上。
    const { tpl, leaderId, teamId } = await setup(true, true);
    const m = await createInstance(BASE, tpl, uniq('m'), false);
    const memberId = idOf(m);
    expect((await addMember(BASE, teamId, memberId)).status).toBe(201);
    clearEvents();
    expect((await deleteInstance(BASE, leaderId, true)).status).toBe(204);
    await waitMatch('team.disbanded', (x) => x.teamId === teamId && x.reason === 'leader_gone');
    await waitMatch('instance.deleted', (x) => x.instanceId === memberId);
  });

  it('Case 5: 手动 disband → 成员级联下线', async () => {
    const { tpl, teamId } = await setup(true);
    const activeId = await addActive(tpl, teamId);
    clearEvents();
    expect((await disbandTeam(BASE, teamId)).status).toBe(204);
    await waitMatch('team.disbanded', (x) => x.teamId === teamId && x.reason === 'manual');
    await waitMatch('instance.offline_requested', (x) => x.instanceId === activeId);
  });

  it('Case 6: 创建 team 唯一约束 → 409', async () => {
    const tpl = uniq('tpl');
    expect((await createTemplate(BASE, tpl)).status).toBe(201);
    const l = await createInstance(BASE, tpl, uniq('leader'), true);
    const leaderId = idOf(l);
    expect((await createTeam(BASE, uniq('team'), leaderId)).status).toBe(201);
    const dup = await createTeam(BASE, uniq('team'), leaderId);
    expect(dup.status).toBe(409);
  });

  it('Case 7: 踢人 → 成员下线', async () => {
    const { tpl, teamId } = await setup(true);
    const activeId = await addActive(tpl, teamId);
    clearEvents();
    expect((await removeMember(BASE, teamId, activeId)).status).toBe(204);
    await waitMatch('team.member_left', (x) => x.instanceId === activeId && x.reason === 'manual');
    await waitMatch('instance.offline_requested', (x) => x.instanceId === activeId);
  });

  it('骨架烟雾测试：创建模板触发 WS template.created 事件', async () => {
    const name = uniq('smoke');
    expect((await createTemplate(BASE, name)).status).toBe(201);
    const e = await waitForEvent(events, 'template.created');
    expect((e as { templateName: string }).templateName).toBe(name);
  });
});

export { BASE, events };
