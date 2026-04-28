import { useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import InstanceChatPanel from '../organisms/InstanceChatPanel';
import Input from '../atoms/Input';
import type { Message } from '../types/chat';
import './CanvasDebugPage.css';

const MOCK_A: Message[] = [
  { id: 'a1', role: 'user', content: '帮我看下 handler 这段报错', time: '10:01', kind: 'turn' },
  { id: 'a2', role: 'agent', content: '这是一个类型不匹配，driverId 没传。', time: '10:02', kind: 'turn', agentName: 'claude' },
];

const MOCK_B: Message[] = [
  { id: 'b1', role: 'user', content: '另一条 instance 的消息', time: '10:05', kind: 'turn' },
  { id: 'b2', role: 'agent', content: '收到，消息流独立。', time: '10:06', kind: 'turn', agentName: 'codex' },
];

interface DebugColumnProps {
  title: string;
  defaultInstanceId: string;
  messages: Message[];
}

function DebugColumn({ title, defaultInstanceId, messages }: DebugColumnProps) {
  const [instanceId, setInstanceId] = useState(defaultInstanceId);
  const [input, setInput] = useState('');

  return (
    <div className="canvas-debug-page__column">
      <div className="canvas-debug-page__iid">
        <span className="canvas-debug-page__iid-label">{title}</span>
        <Input
          value={instanceId}
          onChange={setInstanceId}
          placeholder="instanceId"
        />
      </div>
      <div className="canvas-debug-page__panel">
        <InstanceChatPanel
          instanceId={instanceId}
          peerId="user"
          peerName={instanceId || 'peer'}
          messages={messages}
          inputValue={input}
          onInputChange={setInput}
          onSend={() => setInput('')}
          emptyHint="mock 会话，输入 instanceId 观察列渲染"
        />
      </div>
    </div>
  );
}

export default function CanvasDebugPage() {
  return (
    <PanelWindow>
      <div className="canvas-debug-page">
        <DebugColumn title="Column A" defaultInstanceId="iid-a" messages={MOCK_A} />
        <DebugColumn title="Column B" defaultInstanceId="iid-b" messages={MOCK_B} />
      </div>
    </PanelWindow>
  );
}
