// envelope.ts 单测 —— 对齐 REGRESSION.md §1.1 U-01 ~ U-06
// 不 mock：纯类型守卫，直接跑真实函数。
import { describe, it, expect } from 'bun:test';
import {
  isActorRef,
  isMessageEnvelope,
  type ActorRef,
  type MessageEnvelope,
} from '../envelope.js';

const agentActor: ActorRef = {
  kind: 'agent',
  address: 'local:inst_1',
  displayName: '老王',
  instanceId: 'inst_1',
  memberName: 'wang',
  origin: 'local',
};

const userActor: ActorRef = {
  kind: 'user',
  address: 'user:local',
  displayName: 'User',
};

const systemActor: ActorRef = {
  kind: 'system',
  address: 'local:system',
  displayName: '系统',
  instanceId: null,
  memberName: null,
};

function baseEnv(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg_abc',
    from: userActor,
    to: agentActor,
    teamId: null,
    kind: 'chat',
    summary: 'hi',
    replyTo: null,
    ts: '2026-04-25T00:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('isActorRef — U-01 / U-02', () => {
  it('U-01: 3 条合法 ActorRef → true', () => {
    expect(isActorRef(agentActor)).toBe(true);
    expect(isActorRef(userActor)).toBe(true);
    expect(isActorRef(systemActor)).toBe(true);
  });

  it('U-02: 3 条非法入参 → false', () => {
    // 缺 address 字段
    expect(isActorRef({ kind: 'user', displayName: 'X' })).toBe(false);
    // kind 非法值
    expect(isActorRef({ kind: 'robot', address: 'x:y', displayName: 'X' })).toBe(false);
    // 非 object
    expect(isActorRef('not-object')).toBe(false);
  });
});

describe('isMessageEnvelope — U-03 / U-04', () => {
  it('U-03: 3 条合法 envelope → true', () => {
    // 完整
    expect(isMessageEnvelope(baseEnv({ content: 'full body' }))).toBe(true);
    // 仅必填（无 content / attachments）
    expect(isMessageEnvelope(baseEnv())).toBe(true);
    // 带 attachments
    const withAtt = baseEnv({
      attachments: [{ type: 'file', url: '/tmp/a.pdf' }],
    });
    expect(isMessageEnvelope(withAtt)).toBe(true);
  });

  it('U-04: 3 条非法 envelope → false', () => {
    // 缺 id
    const { id: _id, ...noId } = baseEnv();
    expect(isMessageEnvelope(noId)).toBe(false);
    // kind 非法
    expect(isMessageEnvelope(baseEnv({ kind: 'weird' as never }))).toBe(false);
    // to 不是 ActorRef（缺 address）
    expect(
      isMessageEnvelope(baseEnv({ to: { kind: 'agent', displayName: 'x' } as never })),
    ).toBe(false);
  });
});
