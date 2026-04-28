// messageStore 分桶单测（S1-M1）。
// 覆盖：两 iid 独立 / 跨桶 turnId 不串 / markPeerRead 只标指定 peer /
//      A 排队 3 条 + B 正常发 1 条 → A cancel 后 B 队列不动 / 1000 条上限按桶独立 /
//      旧顶层镜像随 primary iid 切换同步。
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  useMessageStore,
  selectMessagesFor,
  selectPendingFor,
  selectBucketFor,
  selectPrimaryMessages,
  MAX_MESSAGES,
} from '../store/messageStore';
import type { Message, TurnBlock } from '../types/chat';
import { usePrimaryAgentStore } from '../store/primaryAgentStore';

function makeMsg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: 'agent', content: `m-${id}`, time: '00:00', ...over };
}

function resetStore() {
  useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
  usePrimaryAgentStore.setState({ instanceId: null });
}

describe('messageStore 分桶', () => {
  beforeEach(() => resetStore());

  it('两个 iid 独立 add / 互不串', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('a1'));
    s.addMessageFor('B', makeMsg('b1'));
    s.addMessageFor('A', makeMsg('a2'));

    const st = useMessageStore.getState();
    expect(selectMessagesFor(st, 'A').map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(selectMessagesFor(st, 'B').map((m) => m.id)).toEqual(['b1']);
  });

  it('clearFor 只清指定桶', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('a1'));
    s.addMessageFor('B', makeMsg('b1'));
    s.clearFor('A');

    const st = useMessageStore.getState();
    expect(selectMessagesFor(st, 'A')).toEqual([]);
    expect(selectMessagesFor(st, 'B').map((m) => m.id)).toEqual(['b1']);
  });

  it('selectBucketFor 对未知 iid 返回空桶，不是 undefined', () => {
    const bucket = selectBucketFor(useMessageStore.getState(), 'missing');
    expect(bucket).toEqual({ messages: [], pendingPrompts: [] });
  });

  it('replaceMessageFor 只改对应桶里的消息', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('x'));
    s.addMessageFor('B', makeMsg('x')); // 同 id 在不同桶
    s.replaceMessageFor('A', 'x', makeMsg('x', { content: 'changed-A' }));

    const st = useMessageStore.getState();
    expect(selectMessagesFor(st, 'A')[0].content).toBe('changed-A');
    expect(selectMessagesFor(st, 'B')[0].content).toBe('m-x');
  });

  it('updateTurnBlockFor 跨桶 turnId 不互串', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('a1', { turnId: 't1', blocks: [] }));
    s.addMessageFor('B', makeMsg('b1', { turnId: 't1', blocks: [] })); // 同 turnId 在不同桶

    const block: TurnBlock = { type: 'text', blockId: 'blk', content: 'hello' };
    s.updateTurnBlockFor('A', 't1', block);

    const st = useMessageStore.getState();
    const aBlocks = selectMessagesFor(st, 'A')[0].blocks ?? [];
    const bBlocks = selectMessagesFor(st, 'B')[0].blocks ?? [];
    expect(aBlocks).toHaveLength(1);
    expect(aBlocks[0]).toEqual(block);
    expect(bBlocks).toHaveLength(0); // B 桶不受影响
  });

  it('completeTurnFor 清 thinking block 并关 streaming，限本桶', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('a1', {
      turnId: 't1',
      streaming: true,
      thinking: true,
      blocks: [
        { type: 'thinking', blockId: 'tk', content: 'x' },
        { type: 'text', blockId: 'tx', content: 'y' },
      ],
    }));
    s.addMessageFor('B', makeMsg('b1', { turnId: 't1', streaming: true, blocks: [{ type: 'thinking', blockId: 'tk', content: 'x' }] }));

    s.completeTurnFor('A', 't1');

    const st = useMessageStore.getState();
    const a = selectMessagesFor(st, 'A')[0];
    const b = selectMessagesFor(st, 'B')[0];
    expect(a.streaming).toBe(false);
    expect(a.thinking).toBe(false);
    expect(a.blocks?.map((x) => x.type)).toEqual(['text']);
    expect(b.streaming).toBe(true); // B 桶不受影响
    expect(b.blocks?.[0].type).toBe('thinking');
  });

  it('markPeerRead 只标匹配 peerId 的消息', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('u1', { peerId: 'user' }));
    s.addMessageFor('A', makeMsg('a1', { peerId: 'other' }));
    s.addMessageFor('A', makeMsg('u2', { peerId: 'user' }));
    s.addMessageFor('B', makeMsg('ub', { peerId: 'user' })); // 另一个桶同 peer

    s.markPeerRead('A', 'user');

    const st = useMessageStore.getState();
    const aMsgs = selectMessagesFor(st, 'A');
    expect(aMsgs.find((m) => m.id === 'u1')?.read).toBe(true);
    expect(aMsgs.find((m) => m.id === 'u2')?.read).toBe(true);
    expect(aMsgs.find((m) => m.id === 'a1')?.read).toBeUndefined(); // 未被标
    expect(selectMessagesFor(st, 'B')[0].read).toBeUndefined(); // B 桶未被标
  });

  it('pendingPrompts 按桶独立：A cancel 后 B 队列不动', () => {
    const s = useMessageStore.getState();
    s.enqueuePromptFor('A', 'a-1');
    s.enqueuePromptFor('A', 'a-2');
    s.enqueuePromptFor('A', 'a-3');
    s.enqueuePromptFor('B', 'b-1');

    s.clearPendingFor('A');

    const st = useMessageStore.getState();
    expect(selectPendingFor(st, 'A')).toEqual([]);
    expect(selectPendingFor(st, 'B')).toEqual(['b-1']);
  });

  it('dequeuePromptFor 返回队首并缩减队列', () => {
    const s = useMessageStore.getState();
    s.enqueuePromptFor('A', 'one');
    s.enqueuePromptFor('A', 'two');
    expect(s.dequeuePromptFor('A')).toBe('one');
    expect(selectPendingFor(useMessageStore.getState(), 'A')).toEqual(['two']);
    expect(s.dequeuePromptFor('A')).toBe('two');
    expect(s.dequeuePromptFor('A')).toBeUndefined();
  });

  it('MAX_MESSAGES 按桶独立生效，不会被另一桶的条数占名额', () => {
    const s = useMessageStore.getState();
    for (let i = 0; i < MAX_MESSAGES + 5; i++) {
      s.addMessageFor('A', makeMsg(`a-${i}`));
    }
    s.addMessageFor('B', makeMsg('b-1'));

    const st = useMessageStore.getState();
    const a = selectMessagesFor(st, 'A');
    const b = selectMessagesFor(st, 'B');
    expect(a).toHaveLength(MAX_MESSAGES);
    expect(a[0].id).toBe('a-5'); // 前 5 条被裁掉
    expect(a[a.length - 1].id).toBe(`a-${MAX_MESSAGES + 4}`);
    expect(b.map((m) => m.id)).toEqual(['b-1']); // B 桶不受裁剪
  });

  it('setMessagesFor 也按桶独立且遵守 MAX_MESSAGES', () => {
    const s = useMessageStore.getState();
    const big = Array.from({ length: MAX_MESSAGES + 3 }, (_, i) => makeMsg(`x-${i}`));
    s.setMessagesFor('A', big);
    s.setMessagesFor('B', [makeMsg('only-b')]);
    const st = useMessageStore.getState();
    expect(selectMessagesFor(st, 'A')).toHaveLength(MAX_MESSAGES);
    expect(selectMessagesFor(st, 'A')[0].id).toBe('x-3');
    expect(selectMessagesFor(st, 'B').map((m) => m.id)).toEqual(['only-b']);
  });
});

describe('messageStore 兼容层（顶层镜像 + deprecated 代理）', () => {
  beforeEach(() => resetStore());

  it('primary iid 未设置时，deprecated addMessage 是 no-op', () => {
    const s = useMessageStore.getState();
    s.addMessage(makeMsg('x'));
    expect(useMessageStore.getState().byInstance).toEqual({});
    expect(useMessageStore.getState().messages).toEqual([]);
  });

  it('primary iid 设置后，deprecated addMessage 落到 primary 桶，并同步镜像到顶层 messages', () => {
    usePrimaryAgentStore.setState({ instanceId: 'PRIMARY' });
    const s = useMessageStore.getState();
    s.addMessage(makeMsg('p1'));
    const st = useMessageStore.getState();
    expect(selectMessagesFor(st, 'PRIMARY').map((m) => m.id)).toEqual(['p1']);
    expect(st.messages.map((m) => m.id)).toEqual(['p1']);
  });

  it('non-primary 桶变化不污染顶层 messages 镜像', () => {
    usePrimaryAgentStore.setState({ instanceId: 'PRIMARY' });
    const s = useMessageStore.getState();
    s.addMessageFor('OTHER', makeMsg('o1'));
    expect(useMessageStore.getState().messages).toEqual([]);
  });

  it('primary iid 切换时，顶层镜像指向新 primary 桶', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('A', makeMsg('a1'));
    s.addMessageFor('B', makeMsg('b1'));

    usePrimaryAgentStore.setState({ instanceId: 'A' });
    expect(useMessageStore.getState().messages.map((m) => m.id)).toEqual(['a1']);

    usePrimaryAgentStore.setState({ instanceId: 'B' });
    expect(useMessageStore.getState().messages.map((m) => m.id)).toEqual(['b1']);

    usePrimaryAgentStore.setState({ instanceId: null });
    expect(useMessageStore.getState().messages).toEqual([]);
  });

  it('selectPrimaryMessages: primaryIid=null 返回 []; 非 null 返回对应桶', () => {
    const s = useMessageStore.getState();
    s.addMessageFor('P', makeMsg('p1'));
    const st = useMessageStore.getState();
    expect(selectPrimaryMessages(st, null)).toEqual([]);
    expect(selectPrimaryMessages(st, 'P').map((m) => m.id)).toEqual(['p1']);
  });
});
