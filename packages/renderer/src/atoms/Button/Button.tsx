import type { ReactNode } from 'react';
import './Button.css';

interface ButtonProps {
  variant?: 'primary' | 'ghost' | 'icon' | 'dots';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  onDoubleClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
  className?: string;
  children?: ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  onClick,
  onDoubleClick,
  disabled,
  ariaLabel,
  title,
  className,
  children,
}: ButtonProps) {
  if (variant === 'dots') {
    return (
      <button
        type="button"
        className={`btn btn--dots${className ? ` ${className}` : ''}`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        disabled={disabled}
        aria-label={ariaLabel ?? 'menu'}
        title={title}
      >
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
    <button
      type="button"
      className={`btn btn--${variant} btn--${size}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
}
