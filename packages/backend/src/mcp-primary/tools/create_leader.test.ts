// create_leader 工具集成测试。
// 起真实 http.Server（:memory: SQLite），走 hubUrl 调 3 条 HTTP 接口，
// 断言 role_instance / team / team_members 都落库。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.TEAM_HUB_V2_DB = ':memory:';

import { createServer } from '../../http/server.js';
import { RoleTemplate } from '../../domain/role-template.js';
import { closeDb, getDb } from '../../db/connection.js';
import { roster } from '../../roster/roster.js';
import type { PrimaryMcpEnv } from '../config.js';
import { runCreateLeader } from './create_leader.js';

let server: http.Server;
let hubUrl: string;

function resetAll(): void {
  closeDb();
  getDb();
  roster.reset();
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  hubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  resetAll();
});

function env(): PrimaryMcpEnv {
  return { instanceId: 'primary', hubUrl };
}

interface CreateLeaderResult {
  memberName?: string;
  teamName?: string;
  error?: string;
}

async function httpGet<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${hubUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

describe('runCreateLeader', () => {
  it('正常流程：创建 leader + team + member 三步都成功', async () => {
    RoleTemplate.create({ name: 'tpl', role: 'w' });

    const result = (await runCreateLeader(env(), {
      templateName: 'tpl',
      memberName: 'alice',
      teamName: 'T1',
      description: 'my team',
      task: 'kick off',
    })) as CreateLeaderResult;

    expect(result.error).toBeUndefined();
    expect(result.memberName).toBe('alice');
    expect(result.teamName).toBe('T1');
    // 返回值不再暴露 instanceId/teamId — 主 Agent 不需要底层 id
    expect((result as Record<string, unknown>).instanceId).toBeUndefined();
    expect((result as Record<string, unknown>).teamId).toBeUndefined();

    // 核验 role_instance 建好且是 leader（靠 memberName 定位，不用 instanceId）
    const inst = await httpGet<{
      id: string;
      isLeader: boolean;
      memberName: string;
      task: string | null;
    }[]>('/api/role-instances');
    expect(inst.status).toBe(200);
    const self = inst.body.find((r) => r.memberName === 'alice' && r.isLeader);
    expect(self).toBeDefined();
    expect(self!.task).toBe('kick off');

    // 核验 team 存在且 leader + 描述都正确，members 里包含 leader
    const teams = await httpGet<{
      id: string;
      name: string;
      description: string | null;
      leaderInstanceId: string;
    }[]>('/api/teams');
    const createdTeam = teams.body.find((t) => t.name === 'T1');
    expect(createdTeam).toBeDefined();
    expect(createdTeam!.description).toBe('my team');
    expect(createdTeam!.leaderInstanceId).toBe(self!.id);

    const team = await httpGet<{
      id: string;
      name: string;
      description: string | null;
      leaderInstanceId: string;
      members: { instanceId: string }[];
    }>(`/api/teams/${createdTeam!.id}`);
    expect(team.status).toBe(200);
    expect(team.body.members.map((m) => m.instanceId)).toContain(self!.id);
  });

  it('模板不存在 -> 返回 error', async () => {
    const result = (await runCreateLeader(env(), {
      templateName: 'nope',
      memberName: 'alice',
      teamName: 'T',
    })) as CreateLeaderResult;
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('nope');
    // 返回值不含底层 id
    expect((result as Record<string, unknown>).instanceId).toBeUndefined();
    expect((result as Record<string, unknown>).teamId).toBeUndefined();
  });

  it('teamName 为空 -> 返回 error（前置校验，不落库）', async () => {
    RoleTemplate.create({ name: 'tpl', role: 'w' });
    const result = (await runCreateLeader(env(), {
      templateName: 'tpl',
      memberName: 'alice',
      teamName: '',
    })) as CreateLeaderResult;
    expect(result.error).toBe('teamName is required');

    // 不应创建任何 role_instance
    const inst = await httpGet<unknown[]>('/api/role-instances');
    expect(inst.body.length).toBe(0);
  });

  it('templateName 为空 -> 返回 error', async () => {
    const result = (await runCreateLeader(env(), {
      templateName: '',
      memberName: 'a',
      teamName: 'T',
    })) as CreateLeaderResult;
    expect(result.error).toBe('templateName is required');
  });

  it('memberName 为空 -> 返回 error', async () => {
    const result = (await runCreateLeader(env(), {
      templateName: 'tpl',
      memberName: '',
      teamName: 'T',
    })) as CreateLeaderResult;
    expect(result.error).toBe('memberName is required');
  });
});
