import type { ChangeEvent } from 'react';
import './Textarea.css';

interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
}

export default function Textarea({
  value,
  onChange,
  placeholder,
  disabled = false,
  rows = 4,
  maxLength,
  className,
}: TextareaProps) {
  const showCounter = typeof maxLength === 'number';
  const rootClassName = [
    'textarea',
    disabled ? 'textarea--disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  return (
    <div className={rootClassName}>
      <textarea
        className="textarea__field"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
      />
      {showCounter ? (
        <span className="textarea__counter" aria-hidden="true">
          {value.length}/{maxLength}
        </span>
      ) : null}
    </div>
  );
}
