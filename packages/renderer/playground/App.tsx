import { registry, type Layer } from './registry';
import ComponentCard from './ComponentCard';
import CapsuleCard from '../src/organisms/CapsuleCard';
import ChatHeader from '../src/molecules/ChatHeader';
import ChatPanel from '../src/organisms/ChatPanel';

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
      </section>
    </div>
  );
}
