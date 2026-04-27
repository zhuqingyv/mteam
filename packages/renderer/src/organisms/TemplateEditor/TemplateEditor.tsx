import { useMemo, useState } from 'react';
import Button from '../../atoms/Button';
import Input from '../../atoms/Input';
import Textarea from '../../atoms/Textarea';
import Tag from '../../atoms/Tag';
import FormField from '../../molecules/FormField';
import AvatarPicker, { type AvatarRow } from '../../molecules/AvatarPicker';
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
  const [name, setName] = useState(template?.name ?? '');
  const [role, setRole] = useState(template?.role ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [persona, setPersona] = useState(template?.persona ?? '');
  const [avatar, setAvatar] = useState<string | null>(template?.avatar ?? null);
  const [mcps, setMcps] = useState<string[]>(template?.availableMcps ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const nameError = useMemo(() => {
    if (!touched && !name) return '';
    if (!name.trim()) return '请输入模板名称';
    if (name.length > NAME_MAX) return `不超过 ${NAME_MAX} 字符`;
    if (!NAME_RE.test(name)) return '仅支持英文数字下划线/横杠';
    if (!isEdit && existingNames.includes(name)) return '模板名已存在';
    return '';
  }, [name, existingNames, isEdit, touched]);

  const roleError = useMemo(() => {
    if (!touched && !role) return '';
    if (!role.trim()) return '请输入角色';
    if (role.length > ROLE_MAX) return `不超过 ${ROLE_MAX} 字符`;
    return '';
  }, [role, touched]);

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
      <FormField label="模板名称" required error={nameError}>
        <Input
          value={name}
          onChange={setName}
          placeholder="frontend-engineer"
          disabled={isEdit}
          error={!!nameError}
        />
      </FormField>

      <FormField label="角色" required error={roleError}>
        <Input value={role} onChange={setRole} placeholder="engineer" error={!!roleError} />
      </FormField>

      <FormField label="描述">
        <Input value={description} onChange={setDescription} placeholder="用一句话描述角色职责" />
      </FormField>

      <FormField label="系统提示词">
        <Textarea value={persona} onChange={setPersona} rows={5} maxLength={PERSONA_MAX} placeholder="You are..." />
      </FormField>

      <FormField label="头像">
        <div className="tpl-editor__avatar-row">
          <button
            type="button"
            className="tpl-editor__avatar-btn"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="选择头像"
          >
            {avatarSrc ? (
              <img src={avatarSrc} alt={avatar ?? ''} draggable={false} />
            ) : (
              <span className="tpl-editor__avatar-placeholder">?</span>
            )}
          </button>
          <span className="tpl-editor__avatar-id">{avatar ?? '未选择'}</span>
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

      <FormField label="可用 MCP 工具">
        <div className="tpl-editor__mcps">
          {mcps.length === 0 && <span className="tpl-editor__empty">未选择 MCP</span>}
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
          保存
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
