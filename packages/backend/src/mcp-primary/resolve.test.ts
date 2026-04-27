// Unit 测试：McpManager.resolveForPrimary() 专供主 Agent 的 MCP 注入路径
// - 无条件产出 mteam-primary + searchTools
// - 跳过用户模板里的 mteam（主 Agent 不用成员工具集）
// - 透传其他 user-stdio（如 mnemo）

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager } from '../mcp-store/mcp-manager.js';
import type { ResolvedMcpSpec } from '../mcp-store/types.js';
import { install } from '../mcp-store/store.js';

const originalHome = process.env.HOME;
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mcp-manager-primary-'));
  process.env.HOME = tmpHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function findSpec(
  specs: ResolvedMcpSpec[],
  name: string,
): ResolvedMcpSpec | undefined {
  return specs.find((s) => s.name === name);
}

describe('McpManager.resolveForPrimary', () => {
  it('空模板时产出 mteam-primary + searchTools，不含 mteam', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolveForPrimary([], {
      instanceId: 'primary-1',
      hubUrl: 'http://localhost:58590',
    });
    const primary = findSpec(r.specs, 'mteam-primary');
    const search = findSpec(r.specs, 'searchTools');
    const mteam = findSpec(r.specs, 'mteam');

    expect(primary).toBeDefined();
    expect(primary?.kind).toBe('builtin');
    if (primary?.kind === 'builtin') {
      expect(primary.env.ROLE_INSTANCE_ID).toBe('primary-1');
      expect(primary.env.V2_SERVER_URL).toBe('http://localhost:58590');
    }

    expect(search).toBeDefined();
    expect(search?.kind).toBe('builtin');
    if (search?.kind === 'builtin') {
      expect(search.env.ROLE_INSTANCE_ID).toBe('primary-1');
      expect(search.env.V2_SERVER_URL).toBe('http://localhost:58590');
    }

    expect(mteam).toBeUndefined();
    mgr.teardown();
  });

  it('模板里显式写了 mteam 也会被跳过并记入 skipped', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolveForPrimary(
      [{ name: 'mteam', surface: '*', search: '*' }],
      { instanceId: 'primary-2', hubUrl: 'http://h' },
    );
    expect(findSpec(r.specs, 'mteam')).toBeUndefined();
    expect(r.skipped).toContain('mteam');
  });

  it('透传非 mteam 的 user-stdio（如 mnemo）', () => {
    install({
      name: 'mnemo',
      displayName: 'Mnemo',
      description: 'Shared memory',
      command: '/usr/bin/mnemo',
      args: ['serve'],
      env: { MNEMO_HOME: '/tmp/mnemo' },
      transport: 'stdio',
    });
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolveForPrimary(
      [
        { name: 'mteam', surface: '*', search: '*' },
        { name: 'mnemo', surface: '*', search: '*' },
      ],
      { instanceId: 'primary-3', hubUrl: 'http://h' },
    );
    const mnemo = findSpec(r.specs, 'mnemo');
    expect(mnemo).toBeDefined();
    expect(mnemo?.kind).toBe('user-stdio');
    if (mnemo?.kind === 'user-stdio') {
      expect(mnemo.command).toBe('/usr/bin/mnemo');
      expect(mnemo.args).toEqual(['serve']);
      expect(mnemo.env.MNEMO_HOME).toBe('/tmp/mnemo');
    }
    expect(r.skipped).toContain('mteam');
    expect(r.skipped).not.toContain('mnemo');
    mgr.teardown();
  });

  it('模板里引用了 store 不存在的 MCP，会进 skipped 且不影响 mteam-primary/searchTools', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolveForPrimary(
      [{ name: 'not-installed', surface: '*', search: '*' }],
      { instanceId: 'primary-4', hubUrl: 'http://h' },
    );
    expect(r.skipped).toContain('not-installed');
    expect(findSpec(r.specs, 'mteam-primary')).toBeDefined();
    expect(findSpec(r.specs, 'searchTools')).toBeDefined();
    mgr.teardown();
  });
});
