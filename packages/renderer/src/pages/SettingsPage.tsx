import { useEffect, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import PrimaryAgentSettings from '../organisms/PrimaryAgentSettings';
import CliList, { type CliEntry } from '../molecules/CliList';
import TemplateList, { type RoleTemplate as TplListRow } from '../organisms/TemplateList';
import TemplateEditor, { type TemplateDraft } from '../organisms/TemplateEditor';
import Modal from '../atoms/Modal';
import ConfirmDialog from '../molecules/ConfirmDialog';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import { listCli, refreshCli, type CliInfo } from '../api/cli';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  type RoleTemplate,
} from '../api/templates';
import { listAvatars, randomAvatar, type AvatarRow } from '../api/avatars';
import {
  usePrimaryAgentStore,
  selectOnline,
  selectPaConfig,
  useTemplateStore,
  selectTemplates,
} from '../store';
import { useLocale } from '../i18n';
import './SettingsPage.css';

type Tab = 'primary' | 'cli' | 'template';

function toCliEntries(list: CliInfo[]): CliEntry[] {
  return list.map((c) => ({ name: c.name, path: c.path ?? '', available: c.available }));
}

function toDraft(tpl: RoleTemplate): TemplateDraft {
  return {
    name: tpl.name,
    role: tpl.role,
    description: tpl.description ?? '',
    persona: tpl.persona ?? '',
    avatar: tpl.avatar ?? null,
    availableMcps: tpl.availableMcps.map((m) => m.name),
  };
}

export default function SettingsPage() {
  const { t } = useLocale();
  const config = usePrimaryAgentStore(selectPaConfig);
  const online = usePrimaryAgentStore(selectOnline);
  const templates = useTemplateStore(selectTemplates);
  const setTemplates = useTemplateStore((s) => s.setTemplates);
  const removeTemplate = useTemplateStore((s) => s.removeTemplate);

  const [tab, setTab] = useState<Tab>('primary');
  const [clis, setClis] = useState<CliEntry[]>([]);
  const [avatars, setAvatars] = useState<AvatarRow[]>([]);
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    listCli().then((res) => { if (res.ok && res.data) setClis(toCliEntries(res.data)); });
    listTemplates().then((res) => { if (res.ok && res.data) setTemplates(res.data); });
    listAvatars().then((res) => { if (res.ok && res.data) setAvatars(res.data.avatars); });
  }, [setTemplates]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editorOpen && !pendingDelete) window.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, pendingDelete]);

  const handleRefresh = async () => {
    const res = await refreshCli();
    if (res.ok && res.data) setClis(toCliEntries(res.data));
  };

  const handleCreate = () => { setEditing(null); setEditorOpen(true); };
  const handleEdit = (name: string) => {
    const tpl = templates.find((t) => t.name === name);
    if (!tpl) return;
    setEditing(tpl);
    setEditorOpen(true);
  };
  const handleDelete = (name: string) => setPendingDelete(name);

  const handleSave = async (draft: TemplateDraft) => {
    const availableMcps = draft.availableMcps.map((name) => ({ name, surface: '*' as const, search: '*' as const }));
    if (editing) {
      const res = await updateTemplate(editing.name, {
        role: draft.role,
        description: draft.description || null,
        persona: draft.persona || null,
        avatar: draft.avatar,
        availableMcps,
      });
      if (res.ok) setEditorOpen(false);
    } else {
      const res = await createTemplate({
        name: draft.name,
        role: draft.role,
        description: draft.description || null,
        persona: draft.persona || null,
        avatar: draft.avatar,
        availableMcps,
      });
      if (res.ok) setEditorOpen(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const res = await deleteTemplate(pendingDelete);
    // settings 是独立 BrowserWindow，templateStore 是独立 Zustand 实例 — 跨窗口 WS template.deleted
    // 到不了本窗口 store，删除成功后在本地同步移除，避免卡片残留。
    if (res.ok) removeTemplate(pendingDelete);
    setPendingDelete(null);
  };

  const handleRandomAvatar = async () => {
    const res = await randomAvatar();
    if (res.ok && res.data?.avatar) {
      const row = res.data.avatar;
      setAvatars((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
      setEditing((prev) => (prev ? { ...prev, avatar: row.id } : prev));
    }
  };

  const mcpOptions = Array.from(new Set(templates.flatMap((t) => t.availableMcps.map((m) => m.name))));
  const existingNames = templates.map((t) => t.name);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'primary', label: t('settings.tab.primary') },
    { id: 'cli', label: t('settings.tab.cli') },
    { id: 'template', label: t('settings.tab.template') },
  ];

  return (
    <PanelWindow>
      <div className="settings-page__close">
        <Button variant="icon" size="sm" onClick={() => window.close()}>
          <Icon name="close" size={24} />
        </Button>
      </div>
      <div className="settings-page__content">
        <div className="settings-page__tabs" role="tablist">
          {tabs.map((t) => (
            <Button
              key={t.id}
              variant={tab === t.id ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {tab === 'primary' && <PrimaryAgentSettings config={config} running={online} />}
        {tab === 'cli' && <CliList clis={clis} onRefresh={handleRefresh} />}
        {tab === 'template' && (
          <TemplateList
            templates={templates as TplListRow[]}
            onCreate={handleCreate}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? t('roles.edit_prefix', { name: editing.name }) : t('settings.template.new')}
        size="md"
      >
        <TemplateEditor
          template={editing ? toDraft(editing) : undefined}
          mcpOptions={mcpOptions}
          avatars={avatars}
          existingNames={existingNames}
          isEdit={!!editing}
          onSave={handleSave}
          onCancel={() => setEditorOpen(false)}
          onRandomAvatar={handleRandomAvatar}
        />
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title={t('roles.delete_template_title')}
        message={t('roles.delete_template_message', { name: pendingDelete ?? '' })}
        variant="danger"
        confirmLabel={t('common.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </PanelWindow>
  );
}
