import type { ChangeEvent } from 'react';
import './Input.css';

interface InputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  type?: 'text' | 'password' | 'email';
  className?: string;
}

export default function Input({
  value = '',
  onChange,
  placeholder,
  disabled = false,
  error = false,
  type = 'text',
  className,
}: InputProps) {
  const rootClassName = [
    'input',
    error ? 'input--error' : '',
    disabled ? 'input--disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName}>
      <input
        className="input__field"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value)}
      />
    </div>
  );
}
