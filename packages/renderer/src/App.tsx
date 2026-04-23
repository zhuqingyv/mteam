// 测试面板入口：4 个 tab 切换（模板/实例/花名册/MCP Store）。
import { useAtom } from 'jotai';
import { currentTabAtom, type TabKey } from './store/atoms';
import { TemplatePanel } from './components/TemplatePanel';
import { InstancePanel } from './components/InstancePanel';
import { RosterPanel } from './components/RosterPanel';
import { McpStorePanel } from './components/McpStorePanel';
import { API_BASE } from './api/client';

// tab 定义
const TABS: { key: TabKey; label: string }[] = [
  { key: 'template', label: '角色模板' },
  { key: 'instance', label: '角色实例' },
  { key: 'roster', label: '花名册' },
  { key: 'mcp-store', label: 'MCP Store' },
];

export function App() {
  const [tab, setTab] = useAtom(currentTabAtom);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>mcp-team-hub 测试面板</h1>
        <small data-testid="api-base" style={{ color: '#666' }}>
          API: {API_BASE}
        </small>
      </header>

      <nav data-testid="tab-bar" style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ccc' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`tab-${t.key}`}
            onClick={() => setTab(t.key)}
            style={{
              padding: '6px 12px',
              border: '1px solid #ccc',
              borderBottom: tab === t.key ? '2px solid #0066cc' : '1px solid #ccc',
              background: tab === t.key ? '#fff' : '#f5f5f5',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div style={{ marginTop: 12 }}>
        {tab === 'template' && <TemplatePanel />}
        {tab === 'instance' && <InstancePanel />}
        {tab === 'roster' && <RosterPanel />}
        {tab === 'mcp-store' && <McpStorePanel />}
      </div>
    </main>
  );
}
