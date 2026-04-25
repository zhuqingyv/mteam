import type { ReactNode } from 'react';
import './Button.css';

interface ButtonProps {
  variant?: 'primary' | 'ghost' | 'icon' | 'dots';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}

export default function Button({ variant = 'primary', size = 'md', onClick, disabled, children }: ButtonProps) {
  if (variant === 'dots') {
    return (
      <button type="button" className="btn btn--dots" onClick={onClick} disabled={disabled} aria-label="menu">
        <span className="btn__dot" />
        <span className="btn__dot" />
        <span className="btn__dot" />
        <span className="btn__dot" />
        <span className="btn__dot" />
        <span className="btn__dot" />
      </button>
    );
  }
  return (
    <button type="button" className={`btn btn--${variant} btn--${size}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
