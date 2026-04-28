// InstanceChatPanelConnected 纯逻辑单测（S3-G1）。
//
// Connected 组件本身是 React 薄壳（useMessageStore + sendUserPrompt + useInstancePanel），
// React runtime 行为在项目现有测试栈里不跑（见 CanvasNode/CanvasTopBar 测试风格）；
// 这里只测抽出的纯函数 + 通过 messageStore 真实交互验证"两个 iid 消息独立"。

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  decideSendPath,
  deriveStreaming,
} from '../InstanceChatPanelConnected';
import type { Message } from '../../../types/chat';
import { useMessageStore } from '../../../store/messageStore';
import { selectMessagesFor } from '../../../store/messageStore.selectors';
import { usePrimaryAgentStore } from '../../../store/primaryAgentStore';

describe('deriveStreaming', () => {
  test('空列表：false', () => {
    expect(deriveStreaming([])).toBe(false);
  });

  test('只有 pending 占位（无 turnId）：不算 streaming', () => {
    const m: Message = {
      id: 'pending-1', role: 'agent', content: '', time: '10:00',
      streaming: true, thinking: true,
    };
    expect(deriveStreaming([m])).toBe(false);
  });

  test('有 turnId + streaming=true 的 agent 消息：true', () => {
    const m: Message = {
      id: 't1', role: 'agent', content: '', time: '10:00',
      streaming: true, turnId: 't1',
    };
    expect(deriveStreaming([m])).toBe(true);
  });

  test('user 消息带 streaming 标记不算（只认 agent）', () => {
    const m: Message = {
      id: 'u1', role: 'user', content: 'hi', time: '10:00',
      streaming: true, turnId: 't1',
    };
    expect(deriveStreaming([m])).toBe(false);
  });
});

describe('decideSendPath', () => {
  test('peer=user + 非空 → user-prompt', () => {
    expect(decideSendPath('user', 'hello')).toBe('user-prompt');
  });

  test('peer=user + 纯空白 → noop', () => {
    expect(decideSendPath('user', '')).toBe('noop');
    expect(decideSendPath('user', '   ')).toBe('noop');
  });

  test('peer 为其它 instanceId + 非空 → agent-message（S4 路径）', () => {
    expect(decideSendPath('inst-B', 'hi')).toBe('agent-message');
  });

  test('peer 非 user + 纯空白 → noop', () => {
    expect(decideSendPath('inst-B', '  ')).toBe('noop');
  });
});

describe('两个 connected 消息独立（通过 messageStore 验证 AC）', () => {
  beforeEach(() => {
    useMessageStore.setState({ byInstance: {}, messages: [], pendingPrompts: [] });
    usePrimaryAgentStore.setState({ instanceId: null });
  });

  test('selectMessagesFor(state, A) 与 selectMessagesFor(state, B) 互不影响', () => {
    useMessageStore.getState().addMessageFor('A', {
      id: 'a1', role: 'user', content: 'hello A', time: '10:00',
    });
    useMessageStore.getState().addMessageFor('B', {
      id: 'b1', role: 'user', content: 'hello B', time: '10:00',
    });

    const msgsA = selectMessagesFor(useMessageStore.getState(), 'A');
    const msgsB = selectMessagesFor(useMessageStore.getState(), 'B');
    expect(msgsA.map((m) => m.id)).toEqual(['a1']);
    expect(msgsB.map((m) => m.id)).toEqual(['b1']);
  });

  test('streaming 状态按 iid 隔离（deriveStreaming + selectMessagesFor 组合）', () => {
    useMessageStore.getState().addMessageFor('A', {
      id: 't1', role: 'agent', content: '', time: '10:00',
      streaming: true, turnId: 't1',
    });
    // B 桶空
    const s = useMessageStore.getState();
    expect(deriveStreaming(selectMessagesFor(s, 'A'))).toBe(true);
    expect(deriveStreaming(selectMessagesFor(s, 'B'))).toBe(false);
  });
});
