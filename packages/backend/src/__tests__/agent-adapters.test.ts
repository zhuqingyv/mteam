// Claude/Codex adapter 分支覆盖：prepareLaunch / sessionParams / parseUpdate / cleanup。
// 不起真实子进程，只验证数据流与文件落盘/清理。
import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { ClaudeAdapter } from '../agent-driver/adapters/claude.js';
import { CodexAdapter } from '../agent-driver/adapters/codex.js';
import type { DriverConfig } from '../agent-driver/types.js';
import { isLaunchSpec } from '../process-runtime/types.js';

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    agentType: 'claude',
    systemPrompt: 'you are test',
    mcpServers: [],
    cwd: '/tmp',
    ...overrides,
  };
}

describe('ClaudeAdapter.prepareLaunch', () => {
  it('runtime=host + command=process.execPath + args 含 acp 入口 + cwd/env 透传', () => {
    const a = new ClaudeAdapter();
    const spec = a.prepareLaunch(
      baseConfig({ cwd: '/workdir', env: { FOO: 'bar' } }),
    );
    expect(isLaunchSpec(spec)).toBe(true);
    expect(spec.runtime).toBe('host');
    expect(spec.command).toBe(process.execPath);
    expect(spec.args.length).toBe(1);
    expect(spec.args[0]).toContain('claude-agent-acp');
    expect(spec.args[0]).toMatch(/\.js$/);
    expect(spec.cwd).toBe('/workdir');
    expect(spec.env).toEqual({ FOO: 'bar' });
  });

  it('不 spread process.env — env 只含 config.env 的 key（合并父 env 由 glue 层负责）', () => {
    const a = new ClaudeAdapter();
    const spec = a.prepareLaunch(baseConfig({ env: { FOO: 'bar' } }));
    expect(Object.keys(spec.env).sort()).toEqual(['FOO']);
    expect(spec.env.PATH).toBeUndefined();
  });

  it('config.env 缺省 → env 为空对象', () => {
    const a = new ClaudeAdapter();
    const spec = a.prepareLaunch(baseConfig({}));
    expect(spec.env).toEqual({});
  });
});

describe('ClaudeAdapter.sessionParams', () => {
  it('有 systemPrompt → _meta.systemPrompt.append', () => {
    const a = new ClaudeAdapter();
    const params = a.sessionParams(baseConfig({ systemPrompt: 'hello' })) as {
      _meta?: { systemPrompt?: { append?: string } };
    };
    expect(params._meta?.systemPrompt?.append).toBe('hello');
  });

  it('空 systemPrompt → 返回空对象', () => {
    const a = new ClaudeAdapter();
    expect(a.sessionParams(baseConfig({ systemPrompt: '' }))).toEqual({});
  });
});

// ClaudeAdapter.parseUpdate 11 种 sessionUpdate 分支覆盖 —— 详见 claude-parse-update.test.ts。
// 此处仅保留跨 adapter 通用的 smoke（非对象 / 未知 sessionUpdate）。

describe('ClaudeAdapter.listTempFiles', () => {
  it('始终返回空数组（不落盘）', () => {
    const a = new ClaudeAdapter();
    expect(a.listTempFiles()).toEqual([]);
    a.prepareLaunch(baseConfig({ systemPrompt: 'hello' }));
    expect(a.listTempFiles()).toEqual([]);
  });
});

describe('ClaudeAdapter.parseUpdate smoke', () => {
  const a = new ClaudeAdapter();

  it('未知 sessionUpdate / 非对象 → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'unknown' })).toBeNull();
    expect(a.parseUpdate(null)).toBeNull();
    expect(a.parseUpdate('x')).toBeNull();
    expect(a.parseUpdate({})).toBeNull();
  });
});

describe('CodexAdapter.prepareLaunch + cleanup', () => {
  it('runtime=host + 写临时文件 + args 含 model_instructions_file=<path> + cleanup 删除文件', () => {
    const a = new CodexAdapter();
    const spec = a.prepareLaunch(baseConfig({ systemPrompt: 'codex prompt' }));

    expect(isLaunchSpec(spec)).toBe(true);
    expect(spec.runtime).toBe('host');
    expect(spec.command).toBe('npx');
    expect(spec.args[0]).toBe('-y');
    expect(spec.args[1]).toBe('@zed-industries/codex-acp');

    const flagIdx = spec.args.indexOf('-c');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const kv = spec.args[flagIdx + 1];
    expect(kv).toMatch(/^model_instructions_file=/);

    const path = kv!.slice('model_instructions_file='.length);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('codex prompt');

    a.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('无 systemPrompt → 不落盘、args 不含 model_instructions_file；cleanup 幂等', () => {
    const a = new CodexAdapter();
    const spec = a.prepareLaunch(baseConfig({ systemPrompt: '' }));
    expect(isLaunchSpec(spec)).toBe(true);
    expect(
      spec.args.some((x) => x.startsWith('model_instructions_file=')),
    ).toBe(false);
    expect(() => a.cleanup()).not.toThrow();
  });

  it('listTempFiles —— 有 systemPrompt 返回 promptFile；无返回空；cleanup 后清零（W2-8）', () => {
    const a = new CodexAdapter();
    expect(a.listTempFiles()).toEqual([]);

    const spec = a.prepareLaunch(baseConfig({ systemPrompt: 'hi' }));
    const kv = spec.args[spec.args.indexOf('-c') + 1]!;
    const path = kv.slice('model_instructions_file='.length);
    expect(a.listTempFiles()).toEqual([path]);

    a.cleanup();
    expect(a.listTempFiles()).toEqual([]);
  });

  it('不 spread process.env — env 只含 config.env 的 key', () => {
    const a = new CodexAdapter();
    const spec = a.prepareLaunch(
      baseConfig({ systemPrompt: '', env: { CODEX_KEY: 'x' } }),
    );
    expect(Object.keys(spec.env).sort()).toEqual(['CODEX_KEY']);
    expect(spec.env.PATH).toBeUndefined();
    a.cleanup();
  });
});

describe('CodexAdapter.sessionParams', () => {
  it('Codex 不走 _meta，始终返回空对象', () => {
    const a = new CodexAdapter();
    expect(a.sessionParams(baseConfig({ systemPrompt: 'x' }))).toEqual({});
  });
});

// CodexAdapter.parseUpdate 11 种 sessionUpdate 分支覆盖 —— 详见 codex-parse-update.test.ts。
// 此处仅保留跨 adapter 通用的 smoke（非对象 / 未知 sessionUpdate）。

describe('CodexAdapter.parseUpdate smoke', () => {
  const a = new CodexAdapter();

  it('未知 sessionUpdate / 非对象 → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'unknown' })).toBeNull();
    expect(a.parseUpdate(null)).toBeNull();
    expect(a.parseUpdate('x')).toBeNull();
    expect(a.parseUpdate({})).toBeNull();
  });
});
