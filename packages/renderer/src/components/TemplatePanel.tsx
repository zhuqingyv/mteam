// 角色模板面板：创建/列表/编辑/删除 + 响应展示。
import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { templateResponseAtom } from '../store/atoms';
import { ResponseBox } from './ResponseBox';
import { TemplateForm, type TemplateFormValue } from './template/TemplateForm';

// 后端返回的模板结构（只用到前端关心的字段）
interface Template {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  availableMcps: string[];
}

// 将表单字符串转成后端期望的格式
function toPayload(v: TemplateFormValue): Record<string, unknown> {
  const mcps = v.availableMcps
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    name: v.name,
    role: v.role,
    description: v.description || null,
    persona: v.persona || null,
    availableMcps: mcps,
  };
}

export function TemplatePanel() {
  const [list, setList] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [response, setResponse] = useAtom(templateResponseAtom);

  // 刷新列表并把原始响应写入状态盒
  const refresh = async (): Promise<void> => {
    const r = await apiGet<Template[]>('/api/role-templates');
    setResponse(r);
    if (r.ok && Array.isArray(r.data)) setList(r.data);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async (v: TemplateFormValue): Promise<void> => {
    const r = await apiPost('/api/role-templates', toPayload(v));
    setResponse(r);
    await refresh();
  };

  const onUpdate = async (v: TemplateFormValue): Promise<void> => {
    // PUT 不传 name，按 backend 的 validate 规则只发可更新字段
    const payload = toPayload(v);
    delete (payload as { name?: unknown }).name;
    const r = await apiPut(`/api/role-templates/${encodeURIComponent(v.name)}`, payload);
    setResponse(r);
    setEditing(null);
    await refresh();
  };

  const onDelete = async (name: string): Promise<void> => {
    const r = await apiDelete(`/api/role-templates/${encodeURIComponent(name)}`);
    setResponse(r);
    await refresh();
  };

  const initialEdit: Partial<TemplateFormValue> | undefined = editing
    ? {
        name: editing.name,
        role: editing.role,
        description: editing.description ?? '',
        persona: editing.persona ?? '',
        availableMcps: editing.availableMcps.join(','),
      }
    : undefined;

  return (
    <section>
      <TemplateForm mode="create" onSubmit={onCreate} />
      {editing && (
        <div style={{ marginTop: 12 }}>
          <TemplateForm mode="edit" initial={initialEdit} onSubmit={onUpdate} />
          <button onClick={() => setEditing(null)} style={{ marginTop: 4 }}>
            取消编辑
          </button>
        </div>
      )}

      <table
        data-testid="template-list"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 13 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>name</th>
            <th style={{ textAlign: 'left', padding: 6 }}>role</th>
            <th style={{ textAlign: 'left', padding: 6 }}>mcps</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.name} data-testid={`template-row-${t.name}`} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{t.name}</td>
              <td style={{ padding: 6 }}>{t.role}</td>
              <td style={{ padding: 6 }}>{t.availableMcps.join(',')}</td>
              <td style={{ padding: 6 }}>
                <button data-testid={`template-edit-${t.name}`} onClick={() => setEditing(t)}>
                  编辑
                </button>{' '}
                <button data-testid={`template-delete-${t.name}`} onClick={() => void onDelete(t.name)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ResponseBox testId="template-response" result={response} />
    </section>
  );
}
