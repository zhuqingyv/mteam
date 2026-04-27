import { describe, it, expect } from 'vitest';
import {
  buildMcpServerSpecs,
  type LaunchSpecBuilderInput,
} from './launch-spec-builder.js';
import type { ResolvedMcpSet, ResolvedMcpSpec } from '../mcp-store/types.js';

function mteamSpec(
  overrides: Partial<Extract<ResolvedMcpSpec, { kind: 'builtin' }>> = {},
): ResolvedMcpSpec {
  return {
    kind: 'builtin',
    name: 'mteam',
    env: {
      ROLE_INSTANCE_ID: 'inst-1',
      V2_SERVER_URL: 'http://localhost:58590',
      IS_LEADER: '1',
      MTEAM_TOOL_VISIBILITY: '{"surface":"*","search":"*"}',
    },
    visibility: { surface: '*', search: '*' },
    ...overrides,
  };
}

function searchSpec(): ResolvedMcpSpec {
  return {
    kind: 'builtin',
    name: 'searchTools',
    env: {
      ROLE_INSTANCE_ID: 'inst-1',
      V2_SERVER_URL: 'http://localhost:58590',
    },
    visibility: { surface: '*', search: '*' },
  };
}

function userStdioSpec(): ResolvedMcpSpec {
  return {
    kind: 'user-stdio',
    name: 'fs',
    command: '/usr/bin/node',
    args: ['/opt/fs-mcp/index.js'],
    env: { TOKEN: 'x' },
  };
}

function input(
  overrides: Partial<LaunchSpecBuilderInput> = {},
): LaunchSpecBuilderInput {
  const resolved: ResolvedMcpSet = { specs: [mteamSpec(), searchSpec()], skipped: [] };
  return {
    resolved,
    runtimeKind: 'host',
    instanceId: 'inst-1',
    mcpHttpBaseForHost: 'http://localhost:58591',
    mcpHttpBaseForDocker: 'http://host.docker.internal:58591',
    ...overrides,
  };
}

describe('buildMcpServerSpecs', () => {
  it('host + builtin mteam → http url localhost:58591/mcp/mteam', () => {
    const specs = buildMcpServerSpecs(input());
    const mteam = specs.find((s) => s.name === 'mteam');
    expect(mteam).toMatchObject({
      name: 'mteam',
      transport: 'http',
      url: 'http://localhost:58591/mcp/mteam',
    });
  });

  it('docker + builtin mteam → http url host.docker.internal', () => {
    const specs = buildMcpServerSpecs(input({ runtimeKind: 'docker' }));
    const mteam = specs.find((s) => s.name === 'mteam');
    expect(mteam?.url).toBe('http://host.docker.internal:58591/mcp/mteam');
  });

  it('host + builtin searchTools → http url localhost', () => {
    const specs = buildMcpServerSpecs(input());
    const search = specs.find((s) => s.name === 'searchTools');
    expect(search).toMatchObject({
      name: 'searchTools',
      transport: 'http',
      url: 'http://localhost:58591/mcp/searchTools',
    });
  });

  it('builtin mteam headers: 包含 X-Role-Instance-Id / X-Is-Leader / X-Tool-Visibility', () => {
    const specs = buildMcpServerSpecs(input());
    const mteam = specs.find((s) => s.name === 'mteam');
    expect(mteam?.headers).toEqual({
      'X-Role-Instance-Id': 'inst-1',
      'X-Is-Leader': '1',
      'X-Tool-Visibility': '{"surface":"*","search":"*"}',
    });
  });

  it('builtin mteam IS_LEADER=0 → X-Is-Leader=0', () => {
    const m = mteamSpec({
      env: {
        ROLE_INSTANCE_ID: 'inst-1',
        V2_SERVER_URL: 'http://localhost:58590',
        IS_LEADER: '0',
        MTEAM_TOOL_VISIBILITY: '{}',
      },
    });
    const specs = buildMcpServerSpecs(
      input({ resolved: { specs: [m], skipped: [] } }),
    );
    expect(specs[0].headers?.['X-Is-Leader']).toBe('0');
  });

  it('builtin searchTools headers: 只有 X-Role-Instance-Id，没有 leader/visibility', () => {
    const specs = buildMcpServerSpecs(input());
    const search = specs.find((s) => s.name === 'searchTools');
    expect(search?.headers).toEqual({ 'X-Role-Instance-Id': 'inst-1' });
  });

  it('builtin mteam visibility 非 * 时正确序列化进 header', () => {
    const m = mteamSpec({
      visibility: { surface: ['Bash'], search: ['Grep'] },
    });
    const specs = buildMcpServerSpecs(
      input({ resolved: { specs: [m], skipped: [] } }),
    );
    expect(specs[0].headers?.['X-Tool-Visibility']).toBe(
      '{"surface":["Bash"],"search":["Grep"]}',
    );
  });

  it('user-stdio (host) → 原样透传 stdio', () => {
    const specs = buildMcpServerSpecs(
      input({
        resolved: { specs: [userStdioSpec()], skipped: [] },
      }),
    );
    expect(specs[0]).toEqual({
      name: 'fs',
      transport: 'stdio',
      command: '/usr/bin/node',
      args: ['/opt/fs-mcp/index.js'],
      env: { TOKEN: 'x' },
    });
  });

  it('user-stdio (docker) → Stage 4 暂原样透传 stdio（Stage 5 再处理）', () => {
    const specs = buildMcpServerSpecs(
      input({
        runtimeKind: 'docker',
        resolved: { specs: [userStdioSpec()], skipped: [] },
      }),
    );
    expect(specs[0].transport).toBe('stdio');
    expect(specs[0].command).toBe('/usr/bin/node');
  });

  it('instanceId 透传到 X-Role-Instance-Id header（member 复用场景）', () => {
    const specs = buildMcpServerSpecs(
      input({
        instanceId: 'member-xyz',
        resolved: { specs: [mteamSpec()], skipped: [] },
      }),
    );
    expect(specs[0].headers?.['X-Role-Instance-Id']).toBe('member-xyz');
  });

  it('空 specs → 返回空数组', () => {
    const specs = buildMcpServerSpecs(
      input({ resolved: { specs: [], skipped: [] } }),
    );
    expect(specs).toEqual([]);
  });

  it('混合 builtin + user-stdio 保持输入顺序', () => {
    const specs = buildMcpServerSpecs(
      input({
        resolved: {
          specs: [mteamSpec(), userStdioSpec(), searchSpec()],
          skipped: [],
        },
      }),
    );
    expect(specs.map((s) => s.name)).toEqual(['mteam', 'fs', 'searchTools']);
    expect(specs[0].transport).toBe('http');
    expect(specs[1].transport).toBe('stdio');
    expect(specs[2].transport).toBe('http');
  });
});
