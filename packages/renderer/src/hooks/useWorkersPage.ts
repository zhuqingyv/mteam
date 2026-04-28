import { useEffect, useState } from 'react';
import {
  listTemplates, createTemplate, updateTemplate,
  type RoleTemplate,
} from '../api/templates';
import { listAvatars, randomAvatar, type AvatarRow } from '../api/avatars';
import { listInstances } from '../api/instances';
import { useTemplateStore } from '../store';
import type { TemplateDraft } from '../organisms/TemplateEditor';

// RoleListPage 页面级状态 + 动作。抽出去保持页面 tsx ≤ 200 行。

export interface UseWorkersPage {
  templates: RoleTemplate[];
  avatars: AvatarRow[];
  editing: RoleTemplate | null;
  editorOpen: boolean;
  query: string;
  chatHint: string | null;
  setQuery: (q: string) => void;
  setChatHint: (h: string | null) => void;
  setEditorOpen: (open: boolean) => void;
  handleCreate: () => Promise<void>;
  handleSave: (d: TemplateDraft) => Promise<void>;
  handleRandomAvatar: () => Promise<void>;
  handleChat: (workerName: string) => Promise<void>;
  handleViewMore: (workerName: string, action: 'detail' | 'activity') => void;
  openTemplate: (name: string) => void;
}

export function useWorkersPage(): UseWorkersPage {
  const templates = useTemplateStore((s) => s.templates);
  const setTemplates = useTemplateStore((s) => s.setTemplates);
  const [avatars, setAvatars] = useState<AvatarRow[]>([]);
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chatHint, setChatHint] = useState<string | null>(null);

  useEffect(() => {
    listTemplates().then((r) => { if (r.ok && r.data) setTemplates(r.data); });
    listAvatars().then((r) => { if (r.ok && r.data) setAvatars(r.data.avatars); });
  }, [setTemplates]);

  const handleCreate = async () => {
    const res = await randomAvatar();
    const row = res.ok && res.data?.avatar ? res.data.avatar : null;
    if (row) setAvatars((p) => (p.some((a) => a.id === row.id) ? p : [...p, row]));
    setEditing({
      name: '', role: '', description: null, persona: null,
      avatar: row?.id ?? null, availableMcps: [], createdAt: '', updatedAt: '',
    } as RoleTemplate);
    setEditorOpen(true);
  };

  const handleSave = async (d: TemplateDraft) => {
    const availableMcps = d.availableMcps.map((n) => ({ name: n, surface: '*' as const, search: '*' as const }));
    const body = {
      role: d.role,
      description: d.description || null,
      persona: d.persona || null,
      avatar: d.avatar,
      availableMcps,
    };
    const res = editing && editing.name
      ? await updateTemplate(editing.name, body)
      : await createTemplate({ name: d.name, ...body });
    if (res.ok) {
      setEditorOpen(false);
      const list = await listTemplates();
      if (list.ok && list.data) setTemplates(list.data);
    }
  };

  const handleRandomAvatar = async () => {
    const res = await randomAvatar();
    if (res.ok && res.data?.avatar) {
      const row = res.data.avatar;
      setAvatars((p) => (p.some((a) => a.id === row.id) ? p : [...p, row]));
      setEditing((p) => (p ? { ...p, avatar: row.id } : p));
    }
  };

  const handleChat = async (workerName: string) => {
    const res = await listInstances();
    if (!res.ok || !res.data) { setChatHint('查询实例失败'); return; }
    const active = res.data.find((i) => i.templateName === workerName && i.status === 'ACTIVE');
    if (!active) { setChatHint(`${workerName} 当前无活跃任务，去团队里为 TA 分派一个吧`); return; }
    window.electronAPI?.openTeamPanel();
  };

  const openTemplate = (name: string) => {
    const tpl = templates.find((t) => t.name === name);
    if (tpl) { setEditing(tpl); setEditorOpen(true); }
  };

  const handleViewMore = (workerName: string, action: 'detail' | 'activity') => {
    if (action === 'detail') openTemplate(workerName);
  };

  return {
    templates, avatars, editing, editorOpen,
    query, chatHint,
    setQuery, setChatHint, setEditorOpen,
    handleCreate, handleSave, handleRandomAvatar,
    handleChat, handleViewMore, openTemplate,
  };
}
