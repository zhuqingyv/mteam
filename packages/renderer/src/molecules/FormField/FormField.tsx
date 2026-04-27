import type { ReactNode } from 'react';
import './FormField.css';

interface FormFieldProps {
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

export default function FormField({ label, error, required, children }: FormFieldProps) {
  const hasError = typeof error === 'string' && error.length > 0;
  const rootClassName = ['form-field', hasError ? 'form-field--error' : ''].filter(Boolean).join(' ');

  return (
    <div className={rootClassName}>
      <div className="form-field__label">
        <span className="form-field__label-text">{label}</span>
        {required ? (
          <span className="form-field__required" aria-label="required">
            *
          </span>
        ) : null}
      </div>
      <div className="form-field__control">{children}</div>
      {hasError ? (
        <div className="form-field__error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
