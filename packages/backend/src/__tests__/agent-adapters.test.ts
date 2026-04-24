// Claude/Codex adapter 分支覆盖：prepareSpawn / sessionParams / parseUpdate / cleanup。
// 不 spawn 真实子进程，只验证数据流与文件落盘/清理。
import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { ClaudeAdapter } from '../agent-driver/adapters/claude.js';
import { CodexAdapter } from '../agent-driver/adapters/codex.js';
import type { DriverConfig } from '../agent-driver/types.js';

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    agentType: 'claude',
    systemPrompt: 'you are test',
    mcpServers: [],
    cwd: '/tmp',
    ...overrides,
  };
}

describe('ClaudeAdapter.prepareSpawn', () => {
  it('command=npx + args 含 @agentclientprotocol/claude-agent-acp + cwd/env 透传', () => {
    const a = new ClaudeAdapter();
    const spec = a.prepareSpawn(
      baseConfig({ cwd: '/workdir', env: { FOO: 'bar' } }),
    );
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp']);
    expect(spec.cwd).toBe('/workdir');
    expect(spec.env.FOO).toBe('bar');
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

describe('ClaudeAdapter.parseUpdate', () => {
  const a = new ClaudeAdapter();

  it('agent_thought_chunk → driver.thinking(content)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '思考中' },
      }),
    ).toEqual({ type: 'driver.thinking', content: '思考中' });
  });

  it('agent_message_chunk → driver.text(content)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '你好' },
      }),
    ).toEqual({ type: 'driver.text', content: '你好' });
  });

  it('tool_call → driver.tool_call(toolCallId/name/input)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        rawInput: { path: '/a' },
      }),
    ).toEqual({
      type: 'driver.tool_call',
      toolCallId: 'tc-1',
      name: 'Read',
      input: { path: '/a' },
    });
  });

  it('tool_call_update status=completed → driver.tool_result(ok=true)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { bytes: 42 },
      }),
    ).toEqual({
      type: 'driver.tool_result',
      toolCallId: 'tc-1',
      output: { bytes: 42 },
      ok: true,
    });
  });

  it('tool_call_update status=pending → null（非终态忽略）', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'pending',
      }),
    ).toBeNull();
  });

  it('未知 / 非对象 → null', () => {
    expect(a.parseUpdate({ sessionUpdate: 'unknown_type' })).toBeNull();
    expect(a.parseUpdate(null)).toBeNull();
    expect(a.parseUpdate('str')).toBeNull();
  });
});

describe('CodexAdapter.prepareSpawn + cleanup', () => {
  it('写临时文件 + args 含 model_instructions_file=<path> + cleanup 删除文件', () => {
    const a = new CodexAdapter();
    const spec = a.prepareSpawn(baseConfig({ systemPrompt: 'codex prompt' }));

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
    const spec = a.prepareSpawn(baseConfig({ systemPrompt: '' }));
    expect(
      spec.args.some((x) => x.startsWith('model_instructions_file=')),
    ).toBe(false);
    expect(() => a.cleanup()).not.toThrow();
  });
});

describe('CodexAdapter.sessionParams', () => {
  it('Codex 不走 _meta，始终返回空对象', () => {
    const a = new CodexAdapter();
    expect(a.sessionParams(baseConfig({ systemPrompt: 'x' }))).toEqual({});
  });
});

describe('CodexAdapter.parseUpdate', () => {
  const a = new CodexAdapter();

  it('agent_message_chunk → driver.text', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'codex 回答' },
      }),
    ).toEqual({ type: 'driver.text', content: 'codex 回答' });
  });

  it('agent_thought_chunk → driver.thinking', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'r' },
      }),
    ).toEqual({ type: 'driver.thinking', content: 'r' });
  });

  it('tool_call_update status=failed → driver.tool_result(ok=false)', () => {
    expect(
      a.parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        status: 'failed',
      }),
    ).toEqual({
      type: 'driver.tool_result',
      toolCallId: 'tc-2',
      output: null,
      ok: false,
    });
  });
});
