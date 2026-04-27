import { describe, it, expect } from 'vitest';
import {
  buildMemberDriverConfig,
  type BuildMemberDriverConfigInput,
} from './driver-config.js';
import type { ResolvedMcpSet, ResolvedMcpSpec } from '../mcp-store/types.js';

function mteamSpec(): ResolvedMcpSpec {
  return {
    kind: 'builtin',
    name: 'mteam',
    env: {
      ROLE_INSTANCE_ID: 'inst-1',
      V2_SERVER_URL: 'http://localhost:58590',
      IS_LEADER: '0',
      MTEAM_TOOL_VISIBILITY: '{"surface":"*","search":"*"}',
    },
    visibility: { surface: '*', search: '*' },
  };
}

function makeResolved(
  overrides: Partial<ResolvedMcpSet> = {},
): ResolvedMcpSet {
  return {
    specs: [mteamSpec()],
    skipped: [],
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<BuildMemberDriverConfigInput> = {},
): BuildMemberDriverConfigInput {
  return {
    instance: {
      id: 'inst-1',
      memberName: 'bob',
      leaderName: 'alice',
      task: '写 driver-config 模块',
    },
    template: {
      persona: '开发',
      role: { cliType: 'claude' },
    },
    resolvedMcps: makeResolved(),
    ...overrides,
  };
}

describe('buildMemberDriverConfig', () => {
  it('装配出 DriverConfig：agentType / systemPrompt / mcpServers / env 全齐', () => {
    const { config, skipped } = buildMemberDriverConfig(makeInput());

    expect(config.agentType).toBe('claude');
    expect(config.systemPrompt).toContain('本轮你的 Leader 是 alice。');
    expect(config.systemPrompt).toContain('你的名字是：bob，你的身份是：开发');
    expect(config.systemPrompt).toContain('# 任务\n写 driver-config 模块');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0]).toMatchObject({
      name: 'mteam',
      transport: 'http',
    });
    expect(config.env).toEqual({
      ROLE_INSTANCE_ID: 'inst-1',
      CLAUDE_MEMBER: 'bob',
      IS_LEADER: '0',
      TEAM_HUB_NO_LAUNCH: '1',
    });
    expect(skipped).toEqual([]);
  });

  it('cliType 缺失默认 claude', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({ template: { persona: '开发', role: {} } }),
    );
    expect(config.agentType).toBe('claude');
  });

  it('cliType=codex → agentType=codex', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({
        template: { persona: '开发', role: { cliType: 'codex' } },
      }),
    );
    expect(config.agentType).toBe('codex');
  });

  it('不支持的 cliType 抛错', () => {
    expect(() =>
      buildMemberDriverConfig(
        makeInput({
          template: { persona: '开发', role: { cliType: 'gpt' } },
        }),
      ),
    ).toThrow(/unsupported cliType/);
  });

  it('systemPrompt 始终按非 leader 装配（IS_LEADER=0）', () => {
    const { config } = buildMemberDriverConfig(makeInput());
    expect(config.systemPrompt).not.toContain('本轮你被指派为 Leader。');
    expect(config.env?.IS_LEADER).toBe('0');
  });

  it('persona / leaderName / task 缺失走 prompt 兜底', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({
        instance: {
          id: 'inst-2',
          memberName: 'carol',
          leaderName: null,
        },
        template: { role: { cliType: 'claude' } },
      }),
    );
    expect(config.systemPrompt).toContain('本轮你尚未绑定 Leader。');
    expect(config.systemPrompt).toContain('你的身份是：（未定义身份）');
    expect(config.systemPrompt).toContain('（暂无具体任务，等待 Leader 分配）');
  });

  it('mcpServers 走 builder：builtin → http transport + host url', () => {
    const { config } = buildMemberDriverConfig(makeInput());
    expect(config.mcpServers[0]).toMatchObject({
      name: 'mteam',
      transport: 'http',
      url: 'http://localhost:58591/mcp/mteam',
    });
    expect(config.mcpServers[0].headers?.['X-Role-Instance-Id']).toBe('inst-1');
  });

  it('runtimeKind=docker 时 builtin url 切到 host.docker.internal', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({
        instance: {
          id: 'inst-1',
          memberName: 'bob',
          leaderName: 'alice',
          runtimeKind: 'docker',
        },
      }),
    );
    expect(config.mcpServers[0].url).toBe(
      'http://host.docker.internal:58591/mcp/mteam',
    );
  });

  it('runtimeKind 未提供时默认 host（Stage 5 TODO）', () => {
    const { config } = buildMemberDriverConfig(makeInput());
    expect(config.mcpServers[0].url).toContain('localhost:58591');
  });

  it('instanceId 透传到 X-Role-Instance-Id header', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({
        instance: {
          id: 'member-xyz',
          memberName: 'zoe',
          leaderName: null,
        },
      }),
    );
    expect(config.mcpServers[0].headers?.['X-Role-Instance-Id']).toBe(
      'member-xyz',
    );
  });

  it('user-stdio mcp 原样透传为 stdio transport', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({
        resolvedMcps: {
          specs: [
            {
              kind: 'user-stdio',
              name: 'fs',
              command: '/usr/bin/node',
              args: ['/a.js'],
              env: { A: '1' },
            },
          ],
          skipped: [],
        },
      }),
    );
    expect(config.mcpServers[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: '/usr/bin/node',
      args: ['/a.js'],
      env: { A: '1' },
    });
  });

  it('skipped 从 resolvedMcps.skipped 透传', () => {
    const resolved = makeResolved({ skipped: ['ghost', 'missing'] });
    const { skipped } = buildMemberDriverConfig(
      makeInput({ resolvedMcps: resolved }),
    );
    expect(skipped).toEqual(['ghost', 'missing']);
  });

  it('cwd 默认 homedir(); 传入 cwd 优先', () => {
    const { config: c1 } = buildMemberDriverConfig(makeInput());
    expect(c1.cwd).toBeTruthy();
    const { config: c2 } = buildMemberDriverConfig(
      makeInput({ cwd: '/tmp/work' }),
    );
    expect(c2.cwd).toBe('/tmp/work');
  });

  it('resolvedMcps.specs 为空 → mcpServers=[] 且不抛', () => {
    const { config } = buildMemberDriverConfig(
      makeInput({ resolvedMcps: { specs: [], skipped: [] } }),
    );
    expect(config.mcpServers).toEqual([]);
  });
});
