import { useEffect, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import TemplateList, { type RoleTemplate as TplListRow } from '../organisms/TemplateList';
import TemplateEditor, { type TemplateDraft } from '../organisms/TemplateEditor';
import Modal from '../atoms/Modal';
import ConfirmDialog from '../molecules/ConfirmDialog';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Input from '../atoms/Input';
import FormField from '../molecules/FormField';
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate, type RoleTemplate,
} from '../api/templates';
import { listAvatars, randomAvatar, type AvatarRow } from '../api/avatars';
import { createInstance } from '../api/instances';
import { useTemplateStore, selectTemplates } from '../store';
import { useLocale } from '../i18n';
import './RoleListPage.css';

function toDraft(t: RoleTemplate): TemplateDraft {
  return {
    name: t.name,
    role: t.role,
    description: t.description ?? '',
    persona: t.persona ?? '',
    avatar: t.avatar ?? null,
    availableMcps: t.availableMcps.map((m) => m.name),
  };
}

export default function RoleListPage() {
  const { t } = useLocale();
  const templates = useTemplateStore(selectTemplates);
  const setTemplates = useTemplateStore((s) => s.setTemplates);
  const [avatars, setAvatars] = useState<AvatarRow[]>([]);
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [instanceFor, setInstanceFor] = useState<string | null>(null);
  const [instanceName, setInstanceName] = useState('');
  const [instanceErr, setInstanceErr] = useState('');

  useEffect(() => {
    listTemplates().then((r) => { if (r.ok && r.data) setTemplates(r.data); });
    listAvatars().then((r) => { if (r.ok && r.data) setAvatars(r.data.avatars); });
  }, [setTemplates]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editorOpen && !pendingDelete && !instanceFor) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, pendingDelete, instanceFor]);

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

  const handleEdit = (name: string) => {
    const t = templates.find((x) => x.name === name);
    if (t) { setEditing(t); setEditorOpen(true); }
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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteTemplate(pendingDelete);
    setPendingDelete(null);
    const list = await listTemplates();
    if (list.ok && list.data) setTemplates(list.data);
  };

  const confirmCreateInstance = async () => {
    const name = instanceName.trim();
    if (!name) { setInstanceErr(t('roles.instance_name_required')); return; }
    if (name.length > 64) { setInstanceErr(t('roles.instance_name_too_long')); return; }
    if (!instanceFor) return;
    const res = await createInstance({ templateName: instanceFor, memberName: name, isLeader: false });
    if (res.ok) setInstanceFor(null);
    else setInstanceErr(res.error ?? t('roles.create_failed'));
  };

  const mcpOptions = Array.from(new Set(templates.flatMap((t) => t.availableMcps.map((m) => m.name))));
  const existingNames = templates.map((t) => t.name);
  const isEdit = !!(editing && editing.name);

  return (
    <PanelWindow>
      <div className="role-list-page__head">
        <h1 className="role-list-page__title">{t('roles.title')}</h1>
        <div className="role-list-page__actions">
          <Button variant="primary" size="sm" onClick={handleCreate}>
            <span className="role-list-page__btn-label">
              <Icon name="plus" size={12} /><span>{t('roles.create')}</span>
            </span>
          </Button>
          <div className="role-list-page__close">
            <Button variant="icon" size="sm" onClick={() => window.close()}>
              <Icon name="close" size={20} />
            </Button>
          </div>
        </div>
      </div>
      <div className="role-list-page__body">
        <TemplateList
          templates={templates as TplListRow[]}
          onSelect={(n) => { setInstanceFor(n); setInstanceName(''); setInstanceErr(''); }}
          onEdit={handleEdit}
          onDelete={(n) => setPendingDelete(n)}
        />
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={isEdit ? t('roles.edit_prefix', { name: editing!.name }) : t('roles.create')}
        size="lg"
      >
        <TemplateEditor
          template={editing ? toDraft(editing) : undefined}
          mcpOptions={mcpOptions}
          avatars={avatars}
          existingNames={existingNames}
          isEdit={isEdit}
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

      <Modal
        open={!!instanceFor}
        onClose={() => setInstanceFor(null)}
        title={t('roles.create_instance_title', { name: instanceFor ?? '' })}
        size="sm"
      >
        <div className="role-list-page__inst-form">
          <FormField label={t('roles.instance_name_label')} required error={instanceErr}>
            <Input value={instanceName} onChange={setInstanceName} placeholder={t('roles.instance_name_placeholder')} error={!!instanceErr} />
          </FormField>
          <div className="role-list-page__inst-actions">
            <Button variant="primary" size="sm" onClick={confirmCreateInstance}>{t('common.create')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setInstanceFor(null)}>{t('common.cancel')}</Button>
          </div>
        </div>
      </Modal>
    </PanelWindow>
  );
}
