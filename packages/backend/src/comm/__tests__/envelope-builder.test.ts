// envelope-builder 单测 — 覆盖 TASK-LIST W1-B U-10 ~ U-23。
// 不 mock DB / bus；所有事实通过入参注入。
import { describe, it, expect } from 'bun:test';
import type { MessageEnvelope } from '../envelope.js';
import {
  buildEnvelope,
  type BuildEnvelopeInput,
} from '../envelope-builder.js';

const FIXED_DATE = new Date('2026-04-25T12:00:00.000Z');
const fixedNow = () => FIXED_DATE;
const fixedId = () => 'msg_fixed_01';

function baseAgentToAgent(): BuildEnvelopeInput {
  return {
    fromKind: 'agent',
    fromAddress: 'local:inst_alice',
    fromLookup: {
      instanceId: 'inst_alice',
      memberName: 'alice',
      displayName: 'Alice(alias)',
    },
    toAddress: 'local:inst_bob',
    toLookup: {
      instanceId: 'inst_bob',
      memberName: 'bob',
      displayName: 'Bob',
    },
    summary: 'hi',
    content: 'full body',
    now: fixedNow,
    generateId: fixedId,
  };
}

describe('buildEnvelope', () => {
  // U-10
  it('agent→agent: displayName 取 lookup，kind=chat，from.kind=agent', () => {
    const env = buildEnvelope(baseAgentToAgent());
    expect(env.from.kind).toBe('agent');
    expect(env.from.displayName).toBe('Alice(alias)');
    expect(env.from.instanceId).toBe('inst_alice');
    expect(env.from.memberName).toBe('alice');
    expect(env.to.kind).toBe('agent');
    expect(env.to.displayName).toBe('Bob');
    expect(env.kind).toBe('chat');
    expect(env.ts).toBe(FIXED_DATE.toISOString());
    expect(env.id).toBe('msg_fixed_01');
    expect(env.readAt).toBeNull();
  });

  // U-11
  it('user→agent: fromKind=user + displayName override 生效', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      fromKind: 'user',
      fromAddress: 'user:local',
      fromLookup: null,
      fromDisplayNameOverride: '老板',
    });
    expect(env.from.kind).toBe('user');
    expect(env.from.address).toBe('user:local');
    expect(env.from.displayName).toBe('老板');
    expect(env.from.instanceId).toBeNull();
    expect(env.from.memberName).toBeNull();
  });

  it('user→agent: 不传 override → 默认 "User"', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      fromKind: 'user',
      fromAddress: 'user:local',
      fromLookup: null,
    });
    expect(env.from.displayName).toBe('User');
  });

  // U-12
  it('system→agent: fromKind=system，address 强制改 local:system，默认 displayName="系统"', () => {
    const env = buildEnvelope(
      {
        ...baseAgentToAgent(),
        fromKind: 'system',
        fromAddress: 'whatever:ignored',
        fromLookup: null,
        kind: 'system',
      },
      { allowSystemKind: true },
    );
    expect(env.from.kind).toBe('system');
    expect(env.from.address).toBe('local:system');
    expect(env.from.displayName).toBe('系统');
    expect(env.kind).toBe('system');
  });

  // U-13
  it('summary 空串 / null / undefined → 填 "给你发了一条消息"', () => {
    const base = baseAgentToAgent();
    for (const s of [undefined, null, '', '   ']) {
      const env = buildEnvelope({ ...base, summary: s as string | null | undefined });
      expect(env.summary).toBe('给你发了一条消息');
    }
    const kept = buildEnvelope({ ...base, summary: '有内容' });
    expect(kept.summary).toBe('有内容');
  });

  // U-14
  it('kind="system" + allowSystemKind=false → throw', () => {
    expect(() =>
      buildEnvelope({
        ...baseAgentToAgent(),
        kind: 'system',
      }),
    ).toThrow(/system.*not allowed/i);
  });

  // U-15
  it('kind="system" + allowSystemKind=true → 放行', () => {
    expect(() =>
      buildEnvelope(
        {
          ...baseAgentToAgent(),
          kind: 'system',
        },
        { allowSystemKind: true },
      ),
    ).not.toThrow();
  });

  // U-16
  it('fromKind="agent" 缺 fromLookup → throw', () => {
    expect(() =>
      buildEnvelope({
        ...baseAgentToAgent(),
        fromLookup: null,
      }),
    ).toThrow(/fromLookup required/i);
  });

  // U-17
  it('teamId 缺省 → envelope.teamId=null（不查 DB）', () => {
    const env = buildEnvelope(baseAgentToAgent());
    expect(env.teamId).toBeNull();

    const withTeam = buildEnvelope({ ...baseAgentToAgent(), teamId: 'team_1' });
    expect(withTeam.teamId).toBe('team_1');
  });

  // U-18
  it('attachments 透传', () => {
    const attachments: MessageEnvelope['attachments'] = [
      { type: 'file', url: 'https://x/y.pdf' },
      { type: 'link', href: 'https://x/z' },
    ];
    const env = buildEnvelope({ ...baseAgentToAgent(), attachments });
    expect(env.attachments).toEqual(attachments);
  });

  // U-19
  it('now / generateId 注入生效', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      generateId: () => 'msg_custom_42',
    });
    expect(env.ts).toBe('2030-01-01T00:00:00.000Z');
    expect(env.id).toBe('msg_custom_42');
  });

  // U-20 非业务检查：静态断言 —— 见 describe.it('source only imports node/envelope')
  it('源文件不 import DB/bus/comm-router（由独立 grep 断言）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../envelope-builder.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"][^'"]*db\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*bus\//);
    expect(src).not.toMatch(/comm\/router/);
    // 允许的 import 只有 ./envelope.js 和 node:crypto
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    for (const imp of imports) {
      expect(
        imp === './envelope.js' || imp === 'node:crypto',
      ).toBe(true);
    }
  });

  // U-21
  it('replyTo 默认 null；传值透传', () => {
    const def = buildEnvelope(baseAgentToAgent());
    expect(def.replyTo).toBeNull();
    const linked = buildEnvelope({ ...baseAgentToAgent(), replyTo: 'msg_prev' });
    expect(linked.replyTo).toBe('msg_prev');
  });

  // U-22
  it('fromKind="user" + fromAddress="user:local" → envelope.from.address 同步', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      fromKind: 'user',
      fromAddress: 'user:local',
      fromLookup: null,
    });
    expect(env.from.address).toBe('user:local');
  });

  // U-23
  it('toLookup=null 且 toAddress 是 agent 地址（local:xxx）→ throw', () => {
    expect(() =>
      buildEnvelope({
        ...baseAgentToAgent(),
        toLookup: null,
      }),
    ).toThrow(/toLookup is required/i);
  });

  it('toAddress=user:xxx + toLookup=null → 推断为 user kind', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      toAddress: 'user:alice',
      toLookup: null,
    });
    expect(env.to.kind).toBe('user');
    expect(env.to.address).toBe('user:alice');
    expect(env.to.displayName).toBe('User');
  });

  it('toAddress=local:system + toLookup=null → 推断为 system kind', () => {
    const env = buildEnvelope({
      ...baseAgentToAgent(),
      toAddress: 'local:system',
      toLookup: null,
    });
    expect(env.to.kind).toBe('system');
    expect(env.to.displayName).toBe('系统');
  });

  it('kind 默认 chat；显式传 task / broadcast 透传', () => {
    expect(buildEnvelope({ ...baseAgentToAgent(), kind: 'task' }).kind).toBe('task');
    expect(buildEnvelope({ ...baseAgentToAgent(), kind: 'broadcast' }).kind).toBe('broadcast');
  });
});
