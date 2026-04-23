// 模板创建/编辑共用表单组件。
// mode='create' 用于新建；mode='edit' 用于更新已有模板（name 只读）。
import { useState, useEffect } from 'react';

export interface TemplateFormValue {
  name: string;
  role: string;
  description: string;
  persona: string;
  availableMcps: string; // UI 层用逗号分隔，提交时拆
}

interface Props {
  mode: 'create' | 'edit';
  initial?: Partial<TemplateFormValue>;
  onSubmit: (v: TemplateFormValue) => void;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 6 };
const label: React.CSSProperties = { width: 120, fontSize: 13 };
const input: React.CSSProperties = { flex: 1, padding: 4, fontSize: 13 };

export function TemplateForm({ mode, initial, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [availableMcps, setMcps] = useState(initial?.availableMcps ?? '');

  // 编辑时切换对象要重填
  useEffect(() => {
    setName(initial?.name ?? '');
    setRole(initial?.role ?? '');
    setDescription(initial?.description ?? '');
    setPersona(initial?.persona ?? '');
    setMcps(initial?.availableMcps ?? '');
  }, [initial]);

  const prefix = mode === 'create' ? 'template-create' : 'template-edit';
  const submit = (): void => {
    onSubmit({ name, role, description, persona, availableMcps });
  };

  return (
    <div data-testid={`${prefix}-form`} style={{ border: '1px solid #ccc', padding: 12, borderRadius: 4 }}>
      <h3 style={{ margin: '0 0 8px' }}>{mode === 'create' ? '创建模板' : `编辑模板: ${initial?.name ?? ''}`}</h3>

      <div style={row}>
        <label style={label}>name</label>
        <input
          data-testid={`${prefix}-name`}
          style={input}
          value={name}
          disabled={mode === 'edit'}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>role</label>
        <input
          data-testid={`${prefix}-role`}
          style={input}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>description</label>
        <input
          data-testid={`${prefix}-description`}
          style={input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>persona</label>
        <textarea
          data-testid={`${prefix}-persona`}
          style={{ ...input, minHeight: 60 }}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>availableMcps</label>
        <input
          data-testid={`${prefix}-mcps`}
          style={input}
          placeholder="逗号分隔，例如: fs,mem"
          value={availableMcps}
          onChange={(e) => setMcps(e.target.value)}
        />
      </div>

      <button data-testid={`${prefix}-submit`} onClick={submit} style={{ marginTop: 6 }}>
        {mode === 'create' ? '创建' : '更新'}
      </button>
    </div>
  );
}
