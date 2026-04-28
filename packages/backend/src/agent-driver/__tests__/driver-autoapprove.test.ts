// AgentDriver.requestPermission permissionMode 行为回归。
// auto：选 options[0]；manual：推 onPermissionRequest + await ws pending；timeout → cancelled。
// 真跑 ACP client/server pair（不 mock），验证 SDK 侧收到的 outcome。
import { describe, it, expect } from 'bun:test';
import * as acp from '@agentclientprotocol/sdk';
import { AgentDriver } from '../driver.js';
import type { DriverConfig, DriverPermissionRequest } from '../types.js';
import type { RuntimeHandle } from '../../process-runtime/types.js';
import {
  resolvePermission,
  cancelAllPending,
  pendingSize,
} from '../../ws/handle-permission.js';

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    agentType: 'claude',
    systemPrompt: '',
    mcpServers: [],
    cwd: '/tmp',
    ...overrides,
  };
}

interface PermOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

function pairStreams(): {
  aIn: ReadableStream<Uint8Array>;
  aOut: WritableStream<Uint8Array>;
  bIn: ReadableStream<Uint8Array>;
  bOut: WritableStream<Uint8Array>;
} {
  let aInCtl!: ReadableStreamDefaultController<Uint8Array>;
  let bInCtl!: ReadableStreamDefaultController<Uint8Array>;
  const aIn = new ReadableStream<Uint8Array>({ start: (c) => { aInCtl = c; } });
  const bIn = new ReadableStream<Uint8Array>({ start: (c) => { bInCtl = c; } });
  const aOut = new WritableStream<Uint8Array>({ write: (chunk) => { bInCtl.enqueue(chunk); } });
  const bOut = new WritableStream<Uint8Array>({ write: (chunk) => { aInCtl.enqueue(chunk); } });
  return { aIn, aOut, bIn, bOut };
}

async function setupDriver(
  overrides: Partial<DriverConfig> = {},
): Promise<{ driver: AgentDriver; agentConn: acp.AgentSideConnection }> {
  const pipes = pairStreams();
  const handle: RuntimeHandle = {
    stdin: pipes.aOut,
    stdout: pipes.aIn,
    pid: 0,
    async kill() {},
    onExit() {},
  };
  const driver = new AgentDriver('drv-perm', baseConfig(overrides), handle);
  const agentConn = new acp.AgentSideConnection(
    () => ({
      initialize: async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }),
      newSession: async () => ({ sessionId: 'sess-x' }),
      loadSession: async () => ({}),
      authenticate: async () => ({}),
      prompt: async () => ({ stopReason: 'end_turn' as const }),
      cancel: async () => {},
    }),
    acp.ndJsonStream(pipes.bOut, pipes.bIn),
  );
  await driver.start();
  return { driver, agentConn };
}

describe('AgentDriver.requestPermission permissionMode', () => {
  it("permissionMode='auto' → selected options[0]（自动批准）", async () => {
    const { driver, agentConn } = await setupDriver({ permissionMode: 'auto' });
    const options: PermOption[] = [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-rej', name: 'Reject', kind: 'reject_once' },
    ];
    const res = await agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-1' } as never,
    });
    expect(res.outcome.outcome).toBe('selected');
    if (res.outcome.outcome === 'selected') {
      expect(res.outcome.optionId).toBe('opt-allow-once');
    }
    await driver.stop();
  });

  it("permissionMode 未设置（默认 auto）→ selected options[0]", async () => {
    const { driver, agentConn } = await setupDriver();
    const options: PermOption[] = [
      { optionId: 'opt-first', name: 'Allow', kind: 'allow_always' },
    ];
    const res = await agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-default' } as never,
    });
    expect(res.outcome.outcome).toBe('selected');
    if (res.outcome.outcome === 'selected') {
      expect(res.outcome.optionId).toBe('opt-first');
    }
    await driver.stop();
  });

  it("permissionMode='manual' + 用户批准 → selected optionId", async () => {
    const captured: DriverPermissionRequest[] = [];
    const { driver, agentConn } = await setupDriver({
      permissionMode: 'manual',
      onPermissionRequest: (req) => { captured.push(req); },
    });
    const options: PermOption[] = [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-rej', name: 'Reject', kind: 'reject_once' },
    ];
    // fire-and-forget：driver 会 await pending，等我们 resolve
    const reqPromise = agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-manual' } as never,
    });
    // 等 onPermissionRequest 被回调
    for (let i = 0; i < 100 && captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(captured.length).toBe(1);
    expect(captured[0].instanceId).toBe('drv-perm');
    expect(captured[0].options).toHaveLength(2);
    // 模拟前端回应：resolvePermission
    const ok = resolvePermission(captured[0].requestId, 'opt-rej');
    expect(ok).toBe(true);
    const res = await reqPromise;
    expect(res.outcome.outcome).toBe('selected');
    if (res.outcome.outcome === 'selected') {
      expect(res.outcome.optionId).toBe('opt-rej');
    }
    await driver.stop();
  });

  it("permissionMode='manual' + 超时/cancelAll → cancelled", async () => {
    const captured: DriverPermissionRequest[] = [];
    const { driver, agentConn } = await setupDriver({
      permissionMode: 'manual',
      onPermissionRequest: (req) => { captured.push(req); },
    });
    const options: PermOption[] = [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
    ];
    const reqPromise = agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-timeout' } as never,
    });
    for (let i = 0; i < 100 && captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(captured.length).toBe(1);
    // 不等 30s 真超时；直接 cancelAll 触发 reject → driver 降级 cancelled
    cancelAllPending('test-timeout');
    const res = await reqPromise;
    expect(res.outcome.outcome).toBe('cancelled');
    expect(pendingSize()).toBe(0);
    await driver.stop();
  });

  it("permissionMode='manual' 没注入 onPermissionRequest → cancelled（降级）", async () => {
    const { driver, agentConn } = await setupDriver({ permissionMode: 'manual' });
    const res = await agentConn.requestPermission({
      sessionId: 'sess-x',
      options: [{ optionId: 'opt-a', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 'tc-nocb' } as never,
    });
    expect(res.outcome.outcome).toBe('cancelled');
    await driver.stop();
  });
});
