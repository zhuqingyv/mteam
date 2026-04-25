import { registry, type Layer } from './registry';
import ComponentCard from './ComponentCard';
import CapsuleCard from '../src/organisms/CapsuleCard';
import ChatHeader from '../src/molecules/ChatHeader';
import ChatPanel from '../src/organisms/ChatPanel';
import StatusDot from '../src/atoms/StatusDot';
import Button from '../src/atoms/Button';
import Logo from '../src/atoms/Logo';
import NotificationCard from '../src/atoms/NotificationCard';
import MessageBubble from '../src/molecules/MessageBubble';

const LAYER_ORDER: Layer[] = ['atoms', 'molecules', 'organisms'];
const LAYER_TITLE: Record<Layer, string> = {
  atoms: 'Atoms',
  molecules: 'Molecules',
  organisms: 'Organisms',
};

const SCENE_MESSAGES = [
  { id: '1', role: 'agent' as const, agentName: 'Claude', content: '你好！我是 MTEAM，你的智能开发助手。有什么可以帮你的吗？😊', time: '20:48' },
  { id: '2', role: 'user' as const, content: '帮我总结一下当前 Agent 的状态', time: '20:48', read: true },
  {
    id: '3',
    role: 'agent' as const,
    agentName: 'Claude',
    content: '好的，当前 3 个 Agent 均在线：\n• claude-code：空闲\n• codex-agent：运行中（任务：修复 UI Bug）\n• qwen-dev：空闲',
    time: '20:49',
    toolCalls: [
      { id: 't1', toolName: 'list_agents', status: 'done' as const, summary: '列出所有 Agent', duration: '0.2s' },
      { id: 't2', toolName: 'get_status', status: 'done' as const, summary: '查询运行状态', duration: '0.5s' },
      { id: 't3', toolName: 'read_tasks', status: 'running' as const, summary: '读取任务队列' },
    ],
  },
  { id: '4', role: 'user' as const, content: '帮我优化 MTEAM 窗口的 UI 设计', time: '20:50', read: true },
  { id: '5', role: 'agent' as const, agentName: 'Claude', content: '', time: '', thinking: true },
];

const SCENE_AGENTS = [
  { id: 'claude', name: 'Claude', active: true },
  { id: 'codex', name: 'Codex' },
  { id: 'qwen', name: 'Qwen' },
];

export default function App() {
  return (
    <div className="playground">
      <header className="playground__header">
        <h1 className="playground__title">MTEAM Component Library</h1>
        <p className="playground__subtitle">
          Dark glass components · atoms · molecules · organisms · scenes
        </p>
      </header>
      {LAYER_ORDER.map((layer) => {
        const entries = registry.filter((e) => e.layer === layer);
        if (entries.length === 0) return null;
        return (
          <section key={layer} className="playground__section">
            <h2 className="playground__section-title">{LAYER_TITLE[layer]}</h2>
            <div className="playground__grid">
              {entries.map((entry) => (
                <ComponentCard key={entry.name} entry={entry} />
              ))}
            </div>
          </section>
        );
      })}
      <section className="playground__section">
        <h2 className="playground__section-title">Scenes</h2>
        <div className="scenes">
          <div className="scenes__item">
            <div className="scenes__label">收起态 · Capsule</div>
            <div className="scenes__stage scenes__stage--capsule">
              <CapsuleCard name="M-TEAM" agentCount={3} taskCount={2} messageCount={5} online />
            </div>
          </div>
          <div className="scenes__item">
            <div className="scenes__label">展开态 · Expanded Panel</div>
            <div className="scenes__stage scenes__stage--expanded">
              <div className="scenes__panel">
                <ChatHeader name="M-TEAM" online />
                <ChatPanel messages={SCENE_MESSAGES} agents={SCENE_AGENTS} inputPlaceholder="给 MTEAM 发送消息..." />
              </div>
            </div>
          </div>
        </div>
        <h3 className="playground__subsection-title">Component States</h3>
        <div className="states">
          <div className="states__item">
            <div className="states__label">StatusDot · 三态</div>
            <div className="states__stage">
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <StatusDot status="online" />
                <StatusDot status="busy" />
                <StatusDot status="offline" />
              </div>
            </div>
          </div>
          <div className="states__item">
            <div className="states__label">Button · 四态</div>
            <div className="states__stage">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="primary">Primary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="dots" />
                <Button variant="primary" disabled>Disabled</Button>
              </div>
            </div>
          </div>
          <div className="states__item">
            <div className="states__label">MessageBubble · 三态</div>
            <div className="states__stage">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 400 }}>
                <MessageBubble variant="agent" agentName="Claude">Agent 消息示例</MessageBubble>
                <MessageBubble variant="user">用户消息示例</MessageBubble>
                <MessageBubble variant="thinking" agentName="Claude" />
              </div>
            </div>
          </div>
          <div className="states__item">
            <div className="states__label">Logo · 在线/离线</div>
            <div className="states__stage">
              <div style={{ display: 'flex', gap: 16 }}>
                <Logo size={44} online={true} />
                <Logo size={44} online={false} />
              </div>
            </div>
          </div>
          <div className="states__item">
            <div className="states__label">NotificationCard · 三种类型</div>
            <div className="states__stage">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <NotificationCard title="任务完成" message="UI Bug 已修复" time="刚刚" type="task" />
                <NotificationCard title="新消息" message="收到一条消息" time="2分钟前" type="info" />
                <NotificationCard title="构建失败" message="vite build 报错" time="5分钟前" type="error" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
