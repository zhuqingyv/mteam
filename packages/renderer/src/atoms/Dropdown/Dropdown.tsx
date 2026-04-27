import { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from '../Icon';
import './Dropdown.css';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export default function Dropdown({ options, value, onChange, className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleSelect = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const rootClassName = ['dropdown', open ? 'dropdown--open' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div ref={rootRef} className={rootClassName}>
      <button
        type="button"
        className="dropdown__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.icon ? <span className="dropdown__icon">{current.icon}</span> : null}
        <span className="dropdown__label">{current?.label ?? ''}</span>
        <span className={`dropdown__caret ${open ? 'dropdown__caret--open' : ''}`} aria-hidden="true">
          <Icon name="chevron-down" size={10} />
        </span>
      </button>
      {open ? (
        <ul className="dropdown__panel" role="listbox">
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={`dropdown__option ${opt.value === value ? 'dropdown__option--active' : ''}`}
              onClick={() => handleSelect(opt.value)}
            >
              {opt.icon ? <span className="dropdown__icon">{opt.icon}</span> : null}
              <span className="dropdown__label">{opt.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
