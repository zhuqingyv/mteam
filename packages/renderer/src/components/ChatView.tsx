// 展开态：玻璃质感聊天窗口
// 参考 design-chat-expanded.jpeg：上方消息区（agent 左 / user 右）+ 输入框 + CLI chip 行
// 顶部右上角有收起按钮，点击回到桌面宠物形态

import { useState } from 'react';

type Msg = {
  role: 'agent' | 'user';
  name?: string;
  time?: string;
  text: string;
  attachment?: { title: string; sub: string; icon: string };
};

const demoMessages: Msg[] = [
  {
    role: 'user',
    text: '帮我梳理一下本周项目的进展和风险。',
    time: '10:39',
  },
  {
    role: 'agent',
    name: 'mteam Agent',
    time: '10:40',
    text: '好的，已汇总本周项目进展与风险要点，详见下方总结。\n如需查看具体任务或风险详情，请告诉我。',
    attachment: { title: '项目周报（第 20 周）', sub: '文档 · 12 KB', icon: '📄' },
  },
  {
    role: 'user',
    text: '请重点分析一下风险 3 的影响。',
    time: '10:41',
  },
  {
    role: 'agent',
    name: 'mteam Agent',
    time: '10:41',
    text: '风险 3 可能导致核心模块交付延期，影响范围包括 API 接口联调与前端适配。建议优先修正资源处理依赖项，并建立每日同步机制以降低延迟风险。',
  },
];

type Props = {
  onCollapse: () => void;
};

export default function ChatView({ onCollapse }: Props) {
  const [input, setInput] = useState('');

  return (
    <div className="chat-root">
      <button
        className="collapse-btn"
        onClick={onCollapse}
        type="button"
        title="收起"
        aria-label="收起"
      >
        <span aria-hidden>⌄</span>
      </button>

      <div className="chat-panel">
        <div className="chat-scroll">
          {demoMessages.map((m, i) => (
            <MsgBubble key={i} msg={m} />
          ))}
        </div>
      </div>

      <div className="input-box">
        <textarea
          placeholder="输入你的问题、任务或指令..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="input-row">
          <div className="input-actions">
            <button className="icon-btn" title="添加" type="button">
              +
            </button>
            <button className="icon-btn" title="附件" type="button">
              ⏚
            </button>
          </div>
          <button className="icon-btn send-btn" title="发送" type="button">
            ↑
          </button>
        </div>
      </div>

      <div className="chip-row">
        <Chip icon="✴" label="Claude CLI" />
        <Chip icon="◎" label="Codex CLI" />
        <Chip icon="⟨⟩" label="CodeBuddy CLI" />
        <Chip icon="＋" label="Custom Agent" />
      </div>
    </div>
  );
}

function Chip({ icon, label }: { icon: string; label: string }) {
  return (
    <button className="chip" type="button">
      <span className="chip-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function MsgBubble({ msg }: { msg: Msg }) {
  return (
    <div className={`msg-row ${msg.role}`}>
      {msg.role === 'agent' && <div className="msg-avatar">m</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {msg.role === 'agent' && msg.name && (
          <span className="msg-meta">
            {msg.name} {msg.time ?? ''}
          </span>
        )}
        <div className={`msg-bubble ${msg.role}`}>
          {msg.text.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {msg.attachment && (
            <div className="attachment">
              <div className="attachment-icon">{msg.attachment.icon}</div>
              <div className="attachment-meta">
                <span className="attachment-title">{msg.attachment.title}</span>
                <span className="attachment-sub">{msg.attachment.sub}</span>
              </div>
            </div>
          )}
        </div>
        {msg.role === 'user' && msg.time && (
          <span
            className="msg-meta"
            style={{ alignSelf: 'flex-end', marginTop: 4 }}
          >
            {msg.time} ✓✓
          </span>
        )}
      </div>
    </div>
  );
}
