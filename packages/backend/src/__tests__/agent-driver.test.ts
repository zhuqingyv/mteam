// AgentDriver 状态机单测。不 spawn 真实 ACP 子进程（外部依赖 npx + 网络），
// 只验证 IDLE 初值、状态守卫、幂等 stop、未实现 agentType 构造即抛。
// adapter 的分支覆盖见 agent-adapters.test.ts。
import { describe, it, expect } from 'bun:test';
import { AgentDriver } from '../agent-driver/driver.js';
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

describe('AgentDriver 状态机', () => {
  it('构造后 status=IDLE、isReady()=false', () => {
    const d = new AgentDriver('drv-1', baseConfig());
    expect(d.status).toBe('IDLE');
    expect(d.isReady()).toBe(false);
    expect(d.id).toBe('drv-1');
  });

  it('agentType=qwen 构造即抛（未实现）', () => {
    expect(
      () => new AgentDriver('drv-q', baseConfig({ agentType: 'qwen' })),
    ).toThrow(/qwen/);
  });

  it('start 非 IDLE 状态直接抛（二次 start 守卫）', async () => {
    const d = new AgentDriver('drv-2', baseConfig());
    // 人为推进状态避免真实 spawn
    d.status = 'READY';
    await expect(d.start()).rejects.toThrow(/not in IDLE/);
  });

  it('stop 在 STOPPED 态幂等（不抛）', async () => {
    const d = new AgentDriver('drv-3', baseConfig());
    d.status = 'STOPPED';
    await expect(d.stop()).resolves.toBeUndefined();
  });

  it('prompt 非 READY 抛（保护状态机）', async () => {
    const d = new AgentDriver('drv-4', baseConfig());
    await expect(d.prompt('hi')).rejects.toThrow(/not READY/);
  });
});
