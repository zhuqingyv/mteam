// AgentDriver.requestPermission autoApprove 行为回归。
// 不起真 ACP 子进程：直接插 handle.stdin / stdout 手写 JSON-RPC，验证 SDK 侧收到的响应。
import { describe, it, expect } from 'bun:test';
import * as acp from '@agentclientprotocol/sdk';
import { AgentDriver } from '../driver.js';
import type { DriverConfig } from '../types.js';
import type { RuntimeHandle } from '../../process-runtime/types.js';

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    agentType: 'claude',
    systemPrompt: '',
    mcpServers: [],
    cwd: '/tmp',
    ...overrides,
  };
}

function fakeHandle(): RuntimeHandle {
  return {
    stdin: new WritableStream<Uint8Array>({ write() { /* noop */ } }),
    stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    pid: 0,
    async kill() { /* noop */ },
    onExit() { /* noop */ },
  };
}

interface PermOption { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

// 调私有 bringUp 拿到 client 的 requestPermission handler。
// driver 里 client 是方法闭包；最直接的办法是通过 ClientSideConnection 反射。
// 改用另一条路：构造 driver 后用 (d as any).config.autoApprove 手工触发一次 client 逻辑的等价函数。
// 精确验证方式：直接读 driver.ts 里导出的 pickAllowOption，但它是 file-local。
// 折中：构造 driver + set config.autoApprove + 走一条最小 ACP stdio 握手，断言 handle.stdin 收到的响应。
// 实际起进程开销大；这里改成端到端功能测试：起一条真 ACP client/server pair，server 端发 session/request_permission，
// 断 client 侧 outcome。

function pairStreams(): {
  aIn: ReadableStream<Uint8Array>;
  aOut: WritableStream<Uint8Array>;
  bIn: ReadableStream<Uint8Array>;
  bOut: WritableStream<Uint8Array>;
} {
  // A.out → B.in ； B.out → A.in
  let aInCtl!: ReadableStreamDefaultController<Uint8Array>;
  let bInCtl!: ReadableStreamDefaultController<Uint8Array>;
  const aIn = new ReadableStream<Uint8Array>({ start: (c) => { aInCtl = c; } });
  const bIn = new ReadableStream<Uint8Array>({ start: (c) => { bInCtl = c; } });
  const aOut = new WritableStream<Uint8Array>({
    write: (chunk) => { bInCtl.enqueue(chunk); },
  });
  const bOut = new WritableStream<Uint8Array>({
    write: (chunk) => { aInCtl.enqueue(chunk); },
  });
  return { aIn, aOut, bIn, bOut };
}

async function setupDriverWithClient(autoApprove: boolean): Promise<{
  driver: AgentDriver;
  agentConn: acp.AgentSideConnection;
}> {
  const pipes = pairStreams();
  // handle 视角：stdin = driver 向"外"写入 → 应流向 agent 端
  // stdout = driver 从"外"读 → 应从 agent 端来
  const handle: RuntimeHandle = {
    stdin: pipes.aOut,  // driver 写到 aOut
    stdout: pipes.aIn,  // driver 从 aIn 读
    pid: 0,
    async kill() {},
    onExit() {},
  };
  const driver = new AgentDriver('drv-perm', baseConfig({ autoApprove }), handle);

  // 服务端（agent）侧：收到 client 的 initialize/session/new 直接应答；
  // 业务 methods 都返回 ok。
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

describe('AgentDriver.requestPermission autoApprove', () => {
  it('autoApprove=true + 典型 options 序列 → selected options[0]', async () => {
    // ACP agent 约定 options[0] 固定是 allow_* 类；driver 只信第一个。
    const { driver, agentConn } = await setupDriverWithClient(true);
    const options: PermOption[] = [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
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

  it('autoApprove=true + options 只有 allow_always → selected options[0]', async () => {
    const { driver, agentConn } = await setupDriverWithClient(true);
    const options: PermOption[] = [
      { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'opt-rej', name: 'Reject', kind: 'reject_once' },
    ];
    const res = await agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-2' } as never,
    });
    expect(res.outcome.outcome).toBe('selected');
    if (res.outcome.outcome === 'selected') {
      expect(res.outcome.optionId).toBe('opt-allow-always');
    }
    await driver.stop();
  });

  it('autoApprove=false / 未设置 → cancelled（历史行为不变）', async () => {
    const { driver, agentConn } = await setupDriverWithClient(false);
    const options: PermOption[] = [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
    ];
    const res = await agentConn.requestPermission({
      sessionId: 'sess-x', options, toolCall: { toolCallId: 'tc-3' } as never,
    });
    expect(res.outcome.outcome).toBe('cancelled');
    await driver.stop();
  });
});
