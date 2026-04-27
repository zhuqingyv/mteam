// Unit 测试：McpManager.resolve() 对每个实例无条件注入 searchTools MCP
// searchTools 不在 store、不在模板 availableMcps 里，由 resolve 强制产出。

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager } from '../mcp-store/mcp-manager.js';
import type { ResolvedMcpSpec } from '../mcp-store/types.js';

const originalHome = process.env.HOME;

beforeAll(() => {
  // 隔离 store 目录：默认 HOME 下 .claude/team-hub/mcp-store 会被 boot() 扫描，
  // 这里重定向到临时目录避免读到测试外的 builtin 配置。
  process.env.HOME = mkdtempSync(
    join(tmpdir(), 'mcp-manager-searchtools-'),
  );
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

describe('McpManager.resolve searchTools 注入', () => {
  it('空模板时也注入 searchTools', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolve([], {
      instanceId: 'inst-1',
      hubUrl: 'http://localhost:58580',
      commSock: '/tmp/x.sock',
      isLeader: false,
    });
    const spec = findSpec(r.specs, 'searchTools');
    expect(spec).toBeDefined();
    expect(spec?.kind).toBe('builtin');
    if (spec?.kind === 'builtin') {
      expect(spec.env.ROLE_INSTANCE_ID).toBe('inst-1');
      expect(spec.env.V2_SERVER_URL).toBe('http://localhost:58580');
    }
    mgr.teardown();
  });

  it('resolve 产物只含 specs + skipped（已无 configJson / visibility 顶层字段）', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolve([], {
      instanceId: 'inst-2',
      hubUrl: 'http://h',
      commSock: '/tmp/y.sock',
      isLeader: false,
    });
    expect(Object.keys(r).sort()).toEqual(['skipped', 'specs']);
    mgr.teardown();
  });

  it('searchTools 不会因为 store 不存在而进 skipped', () => {
    const mgr = new McpManager();
    mgr.boot();
    const r = mgr.resolve([], {
      instanceId: 'inst-3',
      hubUrl: 'http://h',
      commSock: '/tmp/z.sock',
      isLeader: true,
    });
    expect(r.skipped).not.toContain('searchTools');
    mgr.teardown();
  });
});
