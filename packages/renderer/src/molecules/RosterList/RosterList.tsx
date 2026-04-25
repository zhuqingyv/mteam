import { useState } from 'react';
import './RosterList.css';

export interface RosterListEntry {
  id: string;
  name: string;
  alias?: string;
  scope: string;
}

interface RosterListProps {
  entries: RosterListEntry[];
  onEditAlias?: (id: string, alias: string) => void;
}

export default function RosterList({ entries, onEditAlias }: RosterListProps) {
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (entries.length === 0) return <div className="roster-list roster-list--empty">Empty roster</div>;

  const commit = (id: string) => {
    if (draft.trim()) onEditAlias?.(id, draft.trim());
    setEditId(null);
  };

  return (
    <ul className="roster-list">
      {entries.map((e) => {
        const editing = editId === e.id;
        return (
          <li key={e.id} className="roster-list__item">
            <span className="roster-list__name">{e.name}</span>
            {editing ? (
              <input
                className="roster-list__alias-input"
                autoFocus
                value={draft}
                onChange={(ev) => setDraft(ev.target.value)}
                onBlur={() => commit(e.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') commit(e.id); if (ev.key === 'Escape') setEditId(null); }}
              />
            ) : (
              <button
                type="button"
                className={`roster-list__alias${e.alias ? '' : ' roster-list__alias--empty'}`}
                onClick={() => { setEditId(e.id); setDraft(e.alias ?? ''); }}
              >
                {e.alias || 'set alias'}
              </button>
            )}
            <span className="roster-list__scope">{e.scope}</span>
          </li>
        );
      })}
    </ul>
  );
}
