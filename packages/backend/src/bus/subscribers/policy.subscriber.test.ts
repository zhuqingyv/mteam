// policy.subscriber 单测 —— 真 EventBus + 真 rule-loader/matcher/merger（注入假的
// readTemplateWhitelist / watch=false）。不 mock bus / policy 非业务模块。
import { describe, it, expect } from 'bun:test';
import { EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { createRuleLoader } from '../../policy/rule-loader.js';
import { subscribePolicy } from './policy.subscriber.js';
import type { BusEvent, InstanceOfflineRequestedEvent, DriverToolCallEvent } from '../events.js';

interface Ctx {
  bus: EventBus;
  offlineEvents: InstanceOfflineRequestedEvent[];
  allEvents: BusEvent[];
  emitToolCall: (driverId: string, name: string, correlationId?: string) => void;
}

function setup(
  templateMap: Record<string, string[] | null>,
  global: { allow: string[]; deny: string[] } = { allow: [], deny: [] },
  enabled = true,
): Ctx {
  // 用不存在的 configPath + watch=false → loader 走 ENOENT 分支拿到 EMPTY_RULES，
  // 再通过注入 readTemplateWhitelist 控制模板白名单；全局规则通过偷换 getGlobalRules 实现。
  const loader = createRuleLoader({
    configPath: '/nonexistent/policy.yaml',
    watch: false,
    readTemplateWhitelist: (id) => (id in templateMap ? templateMap[id] : null),
  });
  // 覆写 getGlobalRules，避免真写 yaml。
  (loader as { getGlobalRules: () => { allow: string[]; deny: string[] } }).getGlobalRules =
    () => global;

  const bus = new EventBus();
  const offlineEvents: InstanceOfflineRequestedEvent[] = [];
  const allEvents: BusEvent[] = [];
  bus.events$.subscribe((e) => {
    allEvents.push(e);
    if (e.type === 'instance.offline_requested') offlineEvents.push(e);
  });

  subscribePolicy({ enabled }, { ruleLoader: loader }, bus);

  const emitToolCall = (driverId: string, name: string, correlationId?: string): void => {
    const evt: DriverToolCallEvent = {
      ...makeBase('driver.tool_call', 'test', correlationId),
      driverId,
      name,
      input: {},
    };
    bus.emit(evt);
  };

  return { bus, offlineEvents, allEvents, emitToolCall };
}

describe('policy.subscriber', () => {
  it('命中 allow → 无下游事件', () => {
    const ctx = setup({ i1: ['Bash', 'Read'] });
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(0);
    // 仅原始 tool_call 在 allEvents 里
    expect(ctx.allEvents.filter((e) => e.type !== 'driver.tool_call')).toHaveLength(0);
  });

  it('命中 deny → emit offline_requested(reason=explicit_deny)', () => {
    const ctx = setup({ i1: ['*'] }, { allow: [], deny: ['Bash'] });
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(1);
    const ev = ctx.offlineEvents[0];
    expect(ev.instanceId).toBe('i1');
    expect(ev.requestedBy).toBe('policy-enforcer');
    expect(ev.reason).toBe('explicit_deny');
  });

  it('configured=true 未命中 → emit offline_requested(reason=not_in_whitelist)', () => {
    const ctx = setup({ i1: ['Read'] });
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(1);
    expect(ctx.offlineEvents[0].reason).toBe('not_in_whitelist');
    expect(ctx.offlineEvents[0].instanceId).toBe('i1');
  });

  it('configured=false（templateAllow=null）未命中 → default allow，无下游事件', () => {
    // 没在 templateMap 里 → readTemplateWhitelist 返回 null
    const ctx = setup({});
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(0);
  });

  it('空白名单 configured=true（templateAllow=[]）→ 全部违规 not_in_whitelist', () => {
    const ctx = setup({ i1: [] });
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(1);
    expect(ctx.offlineEvents[0].reason).toBe('not_in_whitelist');
  });

  it('offline_requested.instanceId === event.driverId（口径验证）', () => {
    const ctx = setup({ 'driver-abc': ['Read'] });
    ctx.emitToolCall('driver-abc', 'Bash');
    expect(ctx.offlineEvents[0].instanceId).toBe('driver-abc');
  });

  it('correlationId 透传：tool_call.correlationId → offline.correlationId', () => {
    const ctx = setup({ i1: ['Read'] });
    ctx.emitToolCall('i1', 'Bash', 'corr-xyz');
    expect(ctx.offlineEvents[0].correlationId).toBe('corr-xyz');
  });

  it('config.enabled=false → 不注册订阅（emit tool_call 完全静默）', () => {
    const ctx = setup({ i1: [] }, { allow: [], deny: [] }, /* enabled */ false);
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(0);
    // 禁用时也不该有任何 subscriber 副作用事件
    expect(ctx.allEvents.filter((e) => e.type !== 'driver.tool_call')).toHaveLength(0);
  });

  it('deny 优先级：即便模板 allow 同名，全局 deny 命中仍 explicit_deny', () => {
    const ctx = setup({ i1: ['Bash'] }, { allow: [], deny: ['Bash'] });
    ctx.emitToolCall('i1', 'Bash');
    expect(ctx.offlineEvents).toHaveLength(1);
    expect(ctx.offlineEvents[0].reason).toBe('explicit_deny');
  });

  it('通配符 allow 命中 → 放行', () => {
    const ctx = setup({ i1: ['mcp__mteam__*'] });
    ctx.emitToolCall('i1', 'mcp__mteam__search_members');
    expect(ctx.offlineEvents).toHaveLength(0);
  });
});
