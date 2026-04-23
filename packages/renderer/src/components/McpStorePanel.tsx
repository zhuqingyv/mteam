// MCP Store 面板：列表/安装/卸载。
import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { apiGet, apiPost, apiDelete } from '../api/client';
import { mcpStoreResponseAtom } from '../store/atoms';
import { ResponseBox } from './ResponseBox';

interface McpConfig {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: 'stdio' | 'sse';
  builtin?: boolean;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 6 };
const label: React.CSSProperties = { width: 110, fontSize: 13 };
const input: React.CSSProperties = { flex: 1, padding: 4, fontSize: 13 };

export function McpStorePanel() {
  const [list, setList] = useState<McpConfig[]>([]);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState(''); // 空白分隔
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio');
  const [response, setResponse] = useAtom(mcpStoreResponseAtom);

  const refresh = async (): Promise<void> => {
    const r = await apiGet<McpConfig[]>('/api/mcp-store');
    setResponse(r);
    if (r.ok && Array.isArray(r.data)) setList(r.data);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onInstall = async (): Promise<void> => {
    const argList = args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const payload = {
      name,
      displayName: displayName || name,
      description,
      command,
      args: argList,
      transport,
    };
    const r = await apiPost('/api/mcp-store/install', payload);
    setResponse(r);
    await refresh();
  };

  const onUninstall = async (n: string): Promise<void> => {
    const r = await apiDelete(`/api/mcp-store/${encodeURIComponent(n)}`);
    setResponse(r);
    await refresh();
  };

  return (
    <section>
      <div
        data-testid="mcp-create-form"
        style={{ border: '1px solid #ccc', padding: 12, borderRadius: 4 }}
      >
        <h3 style={{ margin: '0 0 8px' }}>安装 MCP</h3>
        <div style={row}>
          <label style={label}>name</label>
          <input data-testid="mcp-create-name" style={input} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={row}>
          <label style={label}>displayName</label>
          <input
            data-testid="mcp-create-display"
            style={input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>description</label>
          <input
            data-testid="mcp-create-description"
            style={input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>command</label>
          <input
            data-testid="mcp-create-command"
            style={input}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>args</label>
          <input
            data-testid="mcp-create-args"
            style={input}
            placeholder="空白分隔"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>transport</label>
          <select
            data-testid="mcp-create-transport"
            style={input}
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'sse')}
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
          </select>
        </div>
        <button data-testid="mcp-create-submit" onClick={() => void onInstall()}>
          安装
        </button>
      </div>

      <table
        data-testid="mcp-list"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>name</th>
            <th style={{ textAlign: 'left', padding: 6 }}>command</th>
            <th style={{ textAlign: 'left', padding: 6 }}>builtin</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.name} data-testid={`mcp-row-${m.name}`} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{m.name}</td>
              <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 12 }}>
                {m.command} {m.args.join(' ')}
              </td>
              <td style={{ padding: 6 }}>{m.builtin ? 'yes' : 'no'}</td>
              <td style={{ padding: 6 }}>
                <button
                  data-testid={`mcp-uninstall-${m.name}`}
                  disabled={m.builtin}
                  onClick={() => void onUninstall(m.name)}
                >
                  卸载
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ResponseBox testId="mcp-response" result={response} />
    </section>
  );
}
