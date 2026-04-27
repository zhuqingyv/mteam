import { useCallback, useMemo, useRef, useState } from 'react';
import type { ComponentEntry } from './registry';
import PropsPanel from './PropsPanel';

interface ComponentCardProps {
  entry: ComponentEntry;
}

interface LogEntry {
  id: number;
  time: string;
  label: string;
  detail?: string;
}

// Props that should be updated from their matching callback so the component
// behaves like a real controlled input in the Playground (textarea accepts
// typing, tab switcher highlights the clicked chip, etc.).
const CONTROLLED_PROP_BY_CALLBACK: Record<string, string> = {
  onChange: 'value',
  onSelect: 'activeId',
};

const CALLBACK_NAMES = [
  'onClick',
  'onChange',
  'onSend',
  'onSelect',
  'onAdd',
  'onDismiss',
  'onRandom',
  'onModelChange',
  'onTeamPanel',
  'onSettings',
];

function formatArg(arg: unknown): string {
  if (arg === undefined) return '';
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function nowLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default function ComponentCard({ entry }: ComponentCardProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...entry.defaults }));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logSeqRef = useRef(0);

  const appendLog = useCallback((label: string, detail?: string) => {
    logSeqRef.current += 1;
    const id = logSeqRef.current;
    setLogs((prev) => [{ id, time: nowLabel(), label, detail }, ...prev].slice(0, 5));
  }, []);

  const handleChange = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const customHandlers = useMemo(
    () => entry.handlers?.(setValues) ?? {},
    [entry],
  );

  const injected = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const cb of CALLBACK_NAMES) {
      const controlled = CONTROLLED_PROP_BY_CALLBACK[cb];
      const custom = customHandlers[cb];
      out[cb] = (...args: unknown[]) => {
        const detail = args.map(formatArg).filter(Boolean).join(', ');
        appendLog(cb, detail || undefined);
        if (controlled && args.length > 0) {
          setValues((prev) => ({ ...prev, [controlled]: args[0] }));
        }
        if (custom) custom(...args);
      };
    }
    return out;
  }, [appendLog, customHandlers]);

  const Component = entry.component;
  const children = useMemo(() => entry.renderChildren?.(values), [entry, values]);
  const mergedProps = { ...injected, ...values };

  return (
    <section className="comp-card">
      <header className="comp-card__head">
        <h3 className="comp-card__name">{entry.name}</h3>
        <span className={`comp-card__layer comp-card__layer--${entry.layer}`}>{entry.layer}</span>
      </header>
      <div className="comp-card__stage">
        <div className="comp-card__stage-inner">
          <Component {...mergedProps}>{children}</Component>
        </div>
      </div>
      {entry.note && <div className="comp-card__note">{entry.note}</div>}
      <div className="comp-card__grid">
        <div className="comp-card__col">
          <div className="comp-card__col-title">Props</div>
          <PropsPanel defs={entry.props} values={values} onChange={handleChange} />
        </div>
        <div className="comp-card__col">
          <div className="comp-card__col-title">API</div>
          <ApiTable entry={entry} />
        </div>
      </div>
      <EventLog logs={logs} />
    </section>
  );
}

function EventLog({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="comp-card__events">
      <div className="comp-card__events-title">Events</div>
      {logs.length === 0 ? (
        <div className="comp-card__events-empty">尚未触发 — 点击 / 输入组件试试</div>
      ) : (
        <ul className="comp-card__events-list">
          {logs.map((l) => (
            <li key={l.id} className="comp-card__events-row">
              <span className="comp-card__events-time">{l.time}</span>
              <span className="comp-card__events-label">{l.label}</span>
              {l.detail && <span className="comp-card__events-detail">{l.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApiTable({ entry }: { entry: ComponentEntry }) {
  if (entry.props.length === 0) {
    return <div className="api-table api-table--empty">无 props</div>;
  }
  return (
    <div className="api-table">
      <div className="api-table__row api-table__row--head">
        <span>name</span>
        <span>type</span>
        <span>default</span>
        <span>desc</span>
      </div>
      {entry.props.map((p) => (
        <div key={p.name} className="api-table__row">
          <span className="api-table__name">{p.name}</span>
          <span className="api-table__type">
            {p.type === 'enum' ? p.options?.join(' | ') : p.type}
          </span>
          <span className="api-table__default">{String(p.default)}</span>
          <span className="api-table__desc">{p.description}</span>
        </div>
      ))}
    </div>
  );
}
