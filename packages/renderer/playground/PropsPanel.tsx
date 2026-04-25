import type { PropDef } from './registry';

interface PropsPanelProps {
  defs: PropDef[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

export default function PropsPanel({ defs, values, onChange }: PropsPanelProps) {
  if (defs.length === 0) {
    return <div className="props-panel props-panel--empty">无可调 props</div>;
  }
  return (
    <div className="props-panel">
      {defs.map((def) => (
        <label key={def.name} className="props-panel__row">
          <span className="props-panel__label">{def.name}</span>
          <PropInput def={def} value={values[def.name]} onChange={(v) => onChange(def.name, v)} />
        </label>
      ))}
    </div>
  );
}

function PropInput({
  def,
  value,
  onChange,
}: {
  def: PropDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (def.type === 'enum') {
    return (
      <select
        className="props-panel__control"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {def.options?.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className="props-panel__checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (def.type === 'number') {
    return (
      <input
        type="number"
        className="props-panel__control"
        value={Number(value ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  }
  return (
    <input
      type="text"
      className="props-panel__control"
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
