import { useState } from 'react';
import Button from '../../atoms/Button';
import './TemplateEditor.css';

export interface TemplateDraft {
  name: string;
  role: string;
  persona: string;
  availableMcps: string[];
}

interface TemplateEditorProps {
  template?: Partial<TemplateDraft>;
  mcpOptions?: string[];
  onSave?: (tpl: TemplateDraft) => void;
  onCancel?: () => void;
}

export default function TemplateEditor({ template, mcpOptions = [], onSave, onCancel }: TemplateEditorProps) {
  const [name, setName] = useState(template?.name ?? '');
  const [role, setRole] = useState(template?.role ?? '');
  const [persona, setPersona] = useState(template?.persona ?? '');
  const [mcps, setMcps] = useState<string[]>(template?.availableMcps ?? []);

  const toggle = (m: string) =>
    setMcps((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  return (
    <form className="tpl-editor" onSubmit={(e) => { e.preventDefault(); onSave?.({ name, role, persona, availableMcps: mcps }); }}>
      <label className="tpl-editor__row"><span>Name</span>
        <input className="tpl-editor__input" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="tpl-editor__row"><span>Role</span>
        <input className="tpl-editor__input" value={role} onChange={(e) => setRole(e.target.value)} required />
      </label>
      <label className="tpl-editor__row tpl-editor__row--stack"><span>Persona</span>
        <textarea className="tpl-editor__textarea" value={persona} onChange={(e) => setPersona(e.target.value)} rows={5} />
      </label>
      <div className="tpl-editor__row tpl-editor__row--stack"><span>Available MCPs</span>
        <div className="tpl-editor__mcps">
          {mcpOptions.length === 0 && <span className="tpl-editor__empty">No MCPs available</span>}
          {mcpOptions.map((m) => (
            <label key={m} className={`tpl-editor__chip${mcps.includes(m) ? ' tpl-editor__chip--on' : ''}`}>
              <input type="checkbox" checked={mcps.includes(m)} onChange={() => toggle(m)} />
              {m}
            </label>
          ))}
        </div>
      </div>
      <div className="tpl-editor__actions">
        <Button variant="primary" size="sm">Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
