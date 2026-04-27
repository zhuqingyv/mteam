// AgentDriver 状态机单测。不起真实 ACP 子进程（外部依赖 npx + 网络），
// 注入 fake RuntimeHandle 仅覆盖 IDLE 初值、状态守卫、幂等 stop、未实现 agentType。
// adapter 的分支覆盖见 agent-adapters.test.ts；进程句柄通信全链路见 primary-agent.test.ts。
import { describe, it, expect } from 'bun:test';
import { firstValueFrom, take, toArray } from 'rxjs';
import { AgentDriver } from '../agent-driver/driver.js';
import type { DriverConfig, DriverEvent } from '../agent-driver/types.js';
import type { DriverOutputEvent } from '../agent-driver/driver-events.js';
import type { RuntimeHandle } from '../process-runtime/types.js';

function baseConfig(overrides: Partial<DriverConfig> = {}): DriverConfig {
  return {
    agentType: 'claude',
    systemPrompt: 'you are test',
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
    onExit() { /* 状态机测试不需要触发 exit */ },
  };
}

// W2-6 专用：可触发 onExit 的 handle；records 里记录 trigger 函数。
function exitableHandle(): { handle: RuntimeHandle; triggerExit: (code?: number, signal?: string) => void } {
  let cb: ((code: number | null, signal: string | null) => void) | null = null;
  return {
    handle: {
      stdin: new WritableStream<Uint8Array>({ write() { /* noop */ } }),
      stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      pid: 0,
      async kill() { /* noop */ },
      onExit(fn) { cb = fn; },
    },
    triggerExit(code = 0, signal = 'SIGTERM') { cb?.(code, signal); },
  };
}

describe('AgentDriver 状态机', () => {
  it('构造后 status=IDLE、isReady()=false', () => {
    const d = new AgentDriver('drv-1', baseConfig(), fakeHandle());
    expect(d.status).toBe('IDLE');
    expect(d.isReady()).toBe(false);
    expect(d.id).toBe('drv-1');
  });

  it('agentType=qwen 构造即抛（未实现）', () => {
    expect(
      () => new AgentDriver('drv-q', baseConfig({ agentType: 'qwen' }), fakeHandle()),
    ).toThrow(/qwen/);
  });

  it('start 非 IDLE 状态直接抛（二次 start 守卫）', async () => {
    const d = new AgentDriver('drv-2', baseConfig(), fakeHandle());
    // 人为推进状态避免 ACP 握手
    d.status = 'READY';
    await expect(d.start()).rejects.toThrow(/not in IDLE/);
  });

  it('stop 在 STOPPED 态幂等（不抛）', async () => {
    const d = new AgentDriver('drv-3', baseConfig(), fakeHandle());
    d.status = 'STOPPED';
    await expect(d.stop()).resolves.toBeUndefined();
  });

  it('prompt 非 READY 抛（保护状态机）', async () => {
    const d = new AgentDriver('drv-4', baseConfig(), fakeHandle());
    await expect(d.prompt('hi')).rejects.toThrow(/not READY/);
  });

  it('prompt 第一条事件是 driver.turn_start 且 turn_done 复用同一 turnId（T-6）', async () => {
    const d = new AgentDriver('drv-5', baseConfig(), fakeHandle());
    // 注入假 conn / sessionId 绕过 ACP 握手，直接走 prompt 路径
    const fakeConn = {
      async prompt() { return { stopReason: 'end_turn' as const }; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).conn = fakeConn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).sessionId = 'sess-1';
    d.status = 'READY';

    // 捕获前 2 条事件（turn_start + turn_done）
    const collect = firstValueFrom(d.events$.pipe(take(2), toArray())) as Promise<DriverOutputEvent[]>;
    await d.prompt('hello world');
    const events = await collect;

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('driver.turn_start');
    expect(events[1]!.type).toBe('driver.turn_done');

    const start = events[0] as Extract<DriverEvent, { type: 'driver.turn_start' }>;
    const done = events[1] as Extract<DriverEvent, { type: 'driver.turn_done' }>;
    expect(start.turnId).toMatch(/^turn_/);
    expect(start.userInput.text).toBe('hello world');
    expect(typeof start.userInput.ts).toBe('string');
    expect(done.turnId).toBe(start.turnId);
    expect(done.stopReason).toBe('end_turn');
  });
});

// W2-6 三路 race：conn.prompt / 超时 / onExit 提前 reject。
describe('W2-6 driver.prompt 三路 race', () => {
  it('超时：永不 resolve 的 prompt 在 promptTimeoutMs 后被 setTimeout 打掉，status 回 READY', async () => {
    const d = new AgentDriver('drv-to', baseConfig({ promptTimeoutMs: 50 }), fakeHandle());
    const neverResolve = new Promise<{ stopReason: 'end_turn' }>(() => { /* 永不 resolve */ });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).conn = { prompt: () => neverResolve };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).sessionId = 'sess-to';
    d.status = 'READY';

    const seen: DriverOutputEvent[] = [];
    const sub = d.events$.subscribe((ev) => seen.push(ev));

    await expect(d.prompt('hello')).rejects.toThrow(/prompt timeout/);
    expect(d.status).toBe('READY');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any).pendingPromptReject).toBeNull();

    // 超时属于非 exit 错误，catch 分支 emit 一条 driver.error（message 含 'prompt timeout'）
    const errors = seen.filter((e) => e.type === 'driver.error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toMatch(/prompt timeout/);

    sub.unsubscribe();
  });

  it('exit 中断：onExit 触发时立即 reject "process exited during prompt"，status=STOPPED，driver.error 仅 emit 一次', async () => {
    const { handle, triggerExit } = exitableHandle();
    const d = new AgentDriver('drv-exit', baseConfig({ promptTimeoutMs: 60_000 }), handle);
    const neverResolve = new Promise<{ stopReason: 'end_turn' }>(() => { /* 永不 resolve */ });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).conn = { prompt: () => neverResolve };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).sessionId = 'sess-exit';
    d.status = 'READY';

    const seen: DriverOutputEvent[] = [];
    const sub = d.events$.subscribe((ev) => seen.push(ev));

    const p = d.prompt('hello');
    // 让 turn_start 先 emit，pendingPromptReject 已登记；再触发 exit
    await new Promise((r) => setTimeout(r, 10));
    triggerExit(1, 'SIGTERM');

    await expect(p).rejects.toThrow(/process exited during prompt/);
    expect(d.status as string).toBe('STOPPED');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any).pendingPromptReject).toBeNull();

    // Q1：driver.error 只 emit 一次（exit 回调里），prompt catch 看到 STOPPED 不再 emit
    const errors = seen.filter((e) => e.type === 'driver.error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toMatch(/runtime exited/);

    sub.unsubscribe();
  });

  it('正常完成：timer 被 clear，pendingPromptReject 回 null，status=READY', async () => {
    const d = new AgentDriver('drv-ok', baseConfig({ promptTimeoutMs: 60_000 }), fakeHandle());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).conn = { prompt: async () => ({ stopReason: 'end_turn' as const }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).sessionId = 'sess-ok';
    d.status = 'READY';

    await d.prompt('hi');
    expect(d.status).toBe('READY');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any).pendingPromptReject).toBeNull();
  });

  it('并发安全：顺序两条 prompt，finally 清空残留 reject，第二条按自己的结果结束', async () => {
    const d = new AgentDriver('drv-seq', baseConfig({ promptTimeoutMs: 60_000 }), fakeHandle());
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).conn = {
      prompt: async () => {
        callCount += 1;
        return { stopReason: 'end_turn' as const };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).sessionId = 'sess-seq';
    d.status = 'READY';

    await d.prompt('first');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any).pendingPromptReject).toBeNull();
    await d.prompt('second');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any).pendingPromptReject).toBeNull();
    expect(callCount).toBe(2);
    expect(d.status).toBe('READY');
  });
});
