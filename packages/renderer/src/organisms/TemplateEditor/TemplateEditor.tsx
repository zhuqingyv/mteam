import { useEffect, useMemo, useState } from 'react';
import Button from '../../atoms/Button';
import Input from '../../atoms/Input';
import Textarea from '../../atoms/Textarea';
import Tag from '../../atoms/Tag';
import FormField from '../../molecules/FormField';
import AvatarPicker, { type AvatarRow } from '../../molecules/AvatarPicker';
import { useLocale } from '../../i18n';
import './TemplateEditor.css';

export interface TemplateDraft {
  name: string;
  role: string;
  description: string;
  persona: string;
  avatar: string | null;
  availableMcps: string[];
}

interface TemplateEditorProps {
  template?: Partial<TemplateDraft>;
  mcpOptions?: string[];
  avatars?: AvatarRow[];
  existingNames?: string[];
  isEdit?: boolean;
  onSave?: (tpl: TemplateDraft) => void;
  onCancel?: () => void;
  onRandomAvatar?: () => void;
}

const NAME_MAX = 64;
const ROLE_MAX = 32;
const PERSONA_MAX = 8192;

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export default function TemplateEditor({
  template,
  mcpOptions = [],
  avatars = [],
  existingNames = [],
  isEdit = false,
  onSave,
  onCancel,
  onRandomAvatar,
}: TemplateEditorProps) {
  const { t } = useLocale();
  const [name, setName] = useState(template?.name ?? '');
  const [role, setRole] = useState(template?.role ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [persona, setPersona] = useState(template?.persona ?? '');
  const [avatar, setAvatar] = useState<string | null>(template?.avatar ?? null);
  const [mcps, setMcps] = useState<string[]>(template?.availableMcps ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  // template.avatar 由外部改变时（如 onRandomAvatar 从 API 拿到新头像）同步内部 state。
  useEffect(() => {
    setAvatar(template?.avatar ?? null);
  }, [template?.avatar]);

  const nameError = useMemo(() => {
    if (!touched && !name) return '';
    if (!name.trim()) return t('template.name_required');
    if (name.length > NAME_MAX) return t('template.name_too_long', { max: NAME_MAX });
    if (!NAME_RE.test(name)) return t('template.name_pattern');
    if (!isEdit && existingNames.includes(name)) return t('template.name_duplicate');
    return '';
  }, [name, existingNames, isEdit, touched, t]);

  const roleError = useMemo(() => {
    if (!touched && !role) return '';
    if (!role.trim()) return t('template.role_required');
    if (role.length > ROLE_MAX) return t('template.role_too_long', { max: ROLE_MAX });
    return '';
  }, [role, touched, t]);

  const canSave = !nameError && !roleError && name.trim() && role.trim();

  const toggleMcp = (m: string) =>
    setMcps((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const selectedAvatar = avatars.find((a) => a.id === avatar);
  const avatarSrc = selectedAvatar
    ? selectedAvatar.builtin
      ? new URL(`../../assets/avatars/${selectedAvatar.filename}`, import.meta.url).href
      : `/avatars/${selectedAvatar.filename}`
    : null;

  const handleSave = () => {
    setTouched(true);
    if (!canSave) return;
    onSave?.({ name, role, description, persona, avatar, availableMcps: mcps });
  };

  return (
    <div className="tpl-editor">
      <FormField label={t('template.name_label')} required error={nameError}>
        <Input
          value={name}
          onChange={setName}
          placeholder={t('template.name_placeholder')}
          disabled={isEdit}
          error={!!nameError}
        />
      </FormField>

      <FormField label={t('template.role_label')} required error={roleError}>
        <Input value={role} onChange={setRole} placeholder={t('template.role_placeholder')} error={!!roleError} />
      </FormField>

      <FormField label={t('template.description_label')}>
        <Input value={description} onChange={setDescription} placeholder={t('template.description_placeholder')} />
      </FormField>

      <FormField label={t('template.persona_label')}>
        <Textarea value={persona} onChange={setPersona} rows={5} maxLength={PERSONA_MAX} placeholder={t('template.persona_placeholder')} />
      </FormField>

      <FormField label={t('template.avatar_label')}>
        <div className="tpl-editor__avatar-row">
          <button
            type="button"
            className="tpl-editor__avatar-btn"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label={t('template.avatar_pick')}
          >
            {avatarSrc ? (
              <img src={avatarSrc} alt={avatar ?? ''} draggable={false} />
            ) : (
              <span className="tpl-editor__avatar-placeholder">?</span>
            )}
          </button>
          <span className="tpl-editor__avatar-id">{avatar ?? t('common.unselected')}</span>
        </div>
        {pickerOpen && (
          <div className="tpl-editor__picker">
            <AvatarPicker
              avatars={avatars}
              value={avatar}
              onChange={(id) => {
                setAvatar(id);
                setPickerOpen(false);
              }}
              onRandom={onRandomAvatar}
            />
          </div>
        )}
      </FormField>

      <FormField label={t('template.mcps_label')}>
        <div className="tpl-editor__mcps">
          {mcps.length === 0 && <span className="tpl-editor__empty">{t('template.mcps_empty')}</span>}
          {mcps.map((m) => (
            <Tag key={m} label={m} variant="primary" onRemove={() => toggleMcp(m)} />
          ))}
        </div>
        {mcpOptions.filter((m) => !mcps.includes(m)).length > 0 && (
          <div className="tpl-editor__mcp-picker">
            {mcpOptions
              .filter((m) => !mcps.includes(m))
              .map((m) => (
                <button
                  key={m}
                  type="button"
                  className="tpl-editor__mcp-add"
                  onClick={() => toggleMcp(m)}
                >
                  + {m}
                </button>
              ))}
          </div>
        )}
      </FormField>

      <div className="tpl-editor__actions">
        <Button variant="primary" size="sm" disabled={!canSave} onClick={handleSave}>
          {t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
